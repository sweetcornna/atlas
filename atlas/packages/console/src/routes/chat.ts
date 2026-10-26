// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ChatDispatch } from '../chatDispatch.js'
import type { TenantPort } from '../tenancy.js'

/**
 * 对话 — the conversation face.
 *
 * Owns `/v0/chat/…` and `/fragments/chat/…`. The conversation itself is drawn
 * by the front at `/` (`routes/front.ts`), whose fragments live under
 * `/fragments/chat/front/…`; the older `sessions`, `thread` and `greet`
 * fragments stay for scripts that read them.
 *
 * ## Chat is admin-only, all of it
 *
 * Every chat route needs the admin token, **including the read-only ones**.
 * Two reasons, and either alone would be enough: sending spends the far node's
 * model budget, and a transcript is the one thing on this console that contains
 * free-form content rather than ids and counts — `console.md` §7.2 says the
 * rest of the console never touches a payload, and this face is the exception.
 * A view token therefore does not merely fail to send; it cannot see that the
 * conversation exists. With personal accounts a `member` is admitted too,
 * scoped to the sessions that member opened (`shared.ts`, `guardChat`).
 *
 * When `deps.chat` is absent, `/` sends whoever may sign in to `/admin`, while
 * `/v0/chat/*` answers **501** (the route exists in this version; this console
 * has no channel behind it). Both are still behind the role check, so an
 * anonymous caller cannot probe which consoles have chat wired.
 */

import { avatarFragmentRoute, avatarsApiRoute } from './avatars.js'
import { codeApiRoute } from './codeApi.js'
import {
  chatScopeOf,
  streamScopeOf,
  type ChatScope,
  type StreamScope,
} from '../accountsHttp.js'
import {
  CHAT_LOCAL_COMMANDS,
  type ChatLocalCommand,
  type ChatPort,
  type ChatUpdate,
} from '../deps.js'
import {
  fail,
  html,
  json,
  methodNotAllowed,
  notFound,
  readJsonObject,
} from '../respond.js'
import { signedSenderRefusal } from './shared.js'
import { agentAvatarKey } from '../avatar.js'
import {
  chatPreview,
  MAX_CHAT_TEXT_LENGTH,
  renderChatSessions,
  renderChatThread,
} from '../view/chat.js'
import {
  chatFaces,
  chatTargets,
  type FaceLookup,
  HIDDEN_SESSION,
  LEDGER_CLOSED_FAILURE,
  lookFaces,
  noteTranscriptRead,
  type TranscriptReading,
} from './chatReads.js'
import { dispatchFrontFragment } from './front.js'
import {
  canWrite,
  failureOf,
  failureResponse,
  guardChat,
  requiredString,
  outcomeOf,
  textParam,
  valueOf,
  type Parsed,
  type Protection,
} from './shared.js'
import type { RouteContext, RouteModule } from './types.js'

/**
 * How often the stream writes a comment line when nothing has happened.
 *
 * Not decoration. An `EventSource` over an idle connection is indistinguishable
 * from a dead one until something is written, and every layer between the
 * browser and this process — a reverse proxy, a laptop's NAT table, an SSH
 * tunnel — will eventually reclaim a socket that has said nothing. 15 s is well
 * inside the shortest of those, and a comment line costs 14 bytes.
 */
export const CHAT_STREAM_HEARTBEAT_MS = 15_000

/** What the browser is told to wait before redialling a dropped stream. */
const CHAT_STREAM_RETRY_MS = 3_000

const EVENT_STREAM_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  connection: 'keep-alive',
  // Turns off response buffering in the proxies that honour it. Without it a
  // buffering proxy holds every event until the stream closes, which looks
  // exactly like a console that never answers.
  'x-accel-buffering': 'no',
  'x-content-type-options': 'nosniff',
} as const

function chatUnsupported(): Response {
  return fail(
    501,
    'unsupported',
    '该控制台没有配置聊天通道 · 启动 qm console 时给 --chat-url 与传输层 PSK',
  )
}

async function chatSessionsFragment(
  chat: ChatPort,
  activeId: string | null,
  now: number,
  scope: ChatScope,
  look: FaceLookup,
): Promise<string> {
  const [sessions, targets] = await Promise.all([
    chat.sessions(),
    chatTargets(chat),
  ])
  const faces = await look(
    sessions.ok
      ? [...new Set(sessions.value.map(one => one.target))].map(agentAvatarKey)
      : [],
  )
  return renderChatSessions({
    faces: chatFaces(faces),
    // Fetched whole and filtered here: the port has no notion of an owner,
    // and the ownership record lives beside it in the account book.
    sessions: sessions.ok
      ? sessions.value.filter(session => scope.visible(session.id))
      : [],
    targets: targets ?? [],
    failure: failureOf(sessions),
    activeId: activeId !== null && scope.visible(activeId) ? activeId : null,
    now,
  })
}

/** The thread fragment plus the one bit the page around it needs. */
interface ChatThreadRender {
  readonly html: string
  /** True when a session really opened — what enables the composer. */
  readonly open: boolean
  /**
   * Nothing is open but there is an agent to talk to: the composer is on,
   * and the first message opens the conversation (`assets/frontClient.ts`).
   */
  readonly startable?: boolean
}

/**
 * The thread in place of a conversation the ledger could not record the
 * opening of. No transcript was read to draw it, and the composer stays off.
 */
function ledgerClosedThread(now: number): ChatThreadRender {
  return {
    html: renderChatThread({
      transcript: null,
      failure: LEDGER_CLOSED_FAILURE,
      target: null,
      now,
    }),
    open: false,
  }
}

async function chatThreadFragment(
  chat: ChatPort,
  sessionId: string | null,
  now: number,
  scope: ChatScope,
  look: FaceLookup,
  greet?: string,
): Promise<ChatThreadRender> {
  if (sessionId === null || sessionId === '') {
    // Nothing open: the agent picked (`greet`), or the first the picker
    // offers, says hello.
    const targets = await chatTargets(chat)
    const first =
      targets?.find(target => target.address === greet) ??
      targets?.find(target => target.dialable) ??
      targets?.[0]
    const faces = await look(
      first === undefined ? [] : [agentAvatarKey(first.address)],
    )
    return {
      html: renderChatThread({
        transcript: null,
        failure: null,
        target: null,
        now,
        faces: chatFaces(faces),
        ...(first === undefined
          ? {}
          : {
              greeter: {
                agent: first.agent,
                address: first.address,
                dialable: first.dialable,
              },
            }),
      }),
      open: false,
      startable: first?.dialable === true,
    }
  }
  if (!scope.visible(sessionId)) {
    return {
      html: renderChatThread({
        transcript: null,
        failure: HIDDEN_SESSION,
        target: null,
        now,
      }),
      open: false,
    }
  }
  const [transcript, targets] = await Promise.all([
    chat.transcript(sessionId),
    chatTargets(chat),
  ])
  const address = transcript.ok ? transcript.value.session.target : ''
  const faces = await look(address === '' ? [] : [agentAvatarKey(address)])
  return {
    html: renderChatThread({
      faces: chatFaces(faces),
      transcript: valueOf(transcript),
      failure: failureOf(transcript),
      target: targets?.find(target => target.address === address) ?? null,
      registryDown: targets === null,
      now,
    }),
    // The composer is enabled by a transcript that actually loaded, not by the
    // query string naming one: a stale `?session=` out of a bookmark must not
    // put a live send button under a failure strip.
    open: transcript.ok,
  }
}

/**
 * The live stream, as Server-Sent Events.
 *
 * Every event is a bare `{sessionId, revision}` and the page answers it by
 * refetching a server-rendered fragment. Pushing the message *content* down
 * this pipe would be one line shorter and would open a second path by which a
 * remote agent's output reaches the DOM — the whole point of `view/chat.ts`
 * escaping on the way out is that there is only one such path.
 *
 * Teardown is the part worth reading: `subscribe` returns an unsubscribe
 * function, the heartbeat is an interval, and both have to be released whether
 * the browser navigated away (`cancel`) or the enqueue threw because the
 * controller is already closed. A leaked subscription on a long-lived console
 * is a listener list that only grows.
 */
function chatStream(
  chat: ChatPort,
  scope?: StreamScope,
  tenancy?: TenantPort,
): Response {
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let detach: (() => void) | null = null
  let detachTenant: (() => void) | null = null
  let closed = false

  const release = (): void => {
    closed = true
    unsubscribe?.()
    unsubscribe = null
    if (heartbeat !== null) clearInterval(heartbeat)
    heartbeat = null
    detach?.()
    detach = null
    detachTenant?.()
    detachTenant = null
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (text: string): void => {
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          // The peer is gone and the controller is closed. Nothing to report
          // and nothing to retry — just stop paying for it.
          release()
        }
      }
      // Ended from this side: the account behind it was revoked or reset, its
      // session ran out, or the book closed (`accountsHttp.ts`, `StreamScope`).
      const end = (): void => {
        release()
        try {
          controller.close()
        } catch {
          // Already closed by the peer; the release above is what mattered.
        }
      }
      // A comment first: it completes the response headers immediately, so the
      // browser fires `open` rather than sitting in `CONNECTING` until the
      // first real event, which may be minutes away.
      push(`retry: ${CHAT_STREAM_RETRY_MS}\n: open\n\n`)
      unsubscribe = chat.subscribe((update: ChatUpdate) => {
        // A person hears about their own sessions only. The event carries no
        // content, but a session id and its cadence are still somebody else's.
        if (scope !== undefined && !scope.visible(update.sessionId)) return
        push(`event: chat\ndata: ${JSON.stringify(update)}\n\n`)
      })
      heartbeat = setInterval(() => {
        if (scope !== undefined && !scope.alive()) {
          end()
          return
        }
        push(': keep-alive\n\n')
      }, CHAT_STREAM_HEARTBEAT_MS)
      heartbeat.unref?.()
      if (scope !== undefined) detach = scope.attach(end)
      if (closed) {
        detach?.()
        return
      }
      if (tenancy !== undefined) detachTenant = tenancy.subscribe(end)
      if (closed) detachTenant?.()
    },
    cancel() {
      release()
    },
  })

  return new Response(body, { status: 200, headers: EVENT_STREAM_HEADERS })
}

function parseChatText(body: Record<string, unknown>): Parsed<string> {
  const text = requiredString(body, 'text')
  if (!text.ok) return text
  if (text.value.length > MAX_CHAT_TEXT_LENGTH) {
    return {
      ok: false,
      message: `消息最长 ${MAX_CHAT_TEXT_LENGTH} 个字符，这条有 ${text.value.length} 个`,
    }
  }
  // A private key never goes to a model, whatever page sent it. The front
  // takes one out before sending (添加服务器); this is the line behind it.
  if (PRIVATE_KEY_BLOCK.test(text.value)) {
    return {
      ok: false,
      message: '消息里有私钥 · 没有发出 · 部署新服务器用「添加服务器」',
    }
  }
  return text
}

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/

// --- local commands (P18.20, D-9) -------------------------------------------

/**
 * The head a local command is recognised by — the whole recognition, so a
 * sentence that merely mentions `/compact` further along is a sentence.
 */
const CHAT_COMMAND_HEAD = new RegExp(
  `^/(${CHAT_LOCAL_COMMANDS.join('|')})(?:\\s|$)`,
)

/**
 * Which commands need the write role. `/autocompact` changes a setting of the
 * whole node, every session on it included; `/compact` and `/context` act on
 * this conversation's own session. Model and thinking commands also stay in that session, so whoever may talk in it may run them.
 */
const COMMAND_NEEDS_WRITE: Readonly<Record<ChatLocalCommand, boolean>> = {
  autocompact: true,
  compact: false,
  context: false,
  model: false,
  thinking: false,
  effort: false,
}

/** What a member is told instead, the page's status line included. */
const COMMAND_NEEDS_OPS =
  '/autocompact 改的是整台节点的设置 · 需要运维账号或管理令牌 · /compact 与 /context 照常可用'

/** The local command `text` is, as the port will send it (trimmed), or `null`. */
function chatCommandOf(text: string): ChatLocalCommand | null {
  const head = CHAT_COMMAND_HEAD.exec(text.trim())?.[1]
  return CHAT_LOCAL_COMMANDS.find(name => name === head) ?? null
}

async function handleChatSessions(
  ctx: RouteContext,
  chat: ChatPort,
  scope: ChatScope,
): Promise<Response> {
  const { request } = ctx
  if (request.method === 'GET') {
    const result = await chat.sessions()
    // The list is a summary, as on the rail: each last turn cut to the same
    // length, so it is not a way round the recorded transcript read.
    return result.ok
      ? json({
          sessions: result.value
            .filter(session => scope.visible(session.id))
            .map(session => ({
              ...session,
              preview: chatPreview(session.preview),
              // The first line is cut like the last: the list stays a
              // summary, and the transcript stays behind its own route.
              ...(session.title === undefined
                ? {}
                : { title: chatPreview(session.title) }),
            })),
        })
      : failureResponse(result.failure)
  }
  if (request.method === 'POST') {
    const body = await readJsonObject(request)
    if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
    const target = requiredString(body, 'target')
    if (!target.ok) return fail(400, 'invalid', target.message)
    const blocked = await ctx.admit()
    if (blocked !== null) return blocked
    const result = await new ChatDispatch(ctx).open(
      target.value,
      async result => {
        await ctx.record(
          'chat.session.open',
          target.value,
          ...outcomeOf(result),
        )
      },
    )
    if (result instanceof Response) return result
    if (!result.ok) return failureResponse(result.failure)
    return json(result.value)
  }
  return methodNotAllowed(['GET', 'POST'])
}

async function dispatchChatApi(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  const { request, deps, access, accounts, url } = ctx
  // `/v0/chat` itself is not a route, and never consulted the credential.
  if (rest.length === 0) return notFound(`unknown path: ${url.pathname}`)
  const name = rest[0]
  // The stream is the one route here an `EventSource` opens, and an
  // `EventSource` cannot send the console header any more than a navigation
  // can — so it is classed `stream` rather than `guarded` and leans on
  // `Sec-Fetch-Site` instead. See the `http.ts` module note.
  const protection: Protection =
    name === 'stream' && rest.length === 1 ? 'stream' : 'guarded'
  // Admin before existence: an anonymous caller must not learn which consoles
  // have a chat channel wired by comparing 401 against 501.
  const denied = guardChat(access, protection)
  if (denied !== null) return denied
  const chat = deps.chat
  if (chat === undefined) return chatUnsupported()
  const scope = chatScopeOf(access, accounts)

  if (name === 'targets' && rest.length === 1) {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    const result = await chat.targets()
    return result.ok
      ? json({ targets: result.value })
      : failureResponse(result.failure)
  }

  if (name === 'stream' && rest.length === 1) {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return chatStream(chat, streamScopeOf(access, accounts), deps.tenancy)
  }

  if (name === 'sessions') {
    if (rest.length === 1) {
      return await handleChatSessions(ctx, chat, scope)
    }
    const sessionId = decodeURIComponent(rest[1] ?? '')
    if (rest.length === 2) {
      if (request.method !== 'GET') return methodNotAllowed(['GET'])
      if (!scope.visible(sessionId)) return failureResponse(HIDDEN_SESSION)
      // A script reading a transcript is somebody reading it, and a reading
      // the ledger cannot take is a reading that does not happen (D6).
      const reading = await noteTranscriptRead(ctx, sessionId, true)
      if (reading instanceof Response) return reading
      const result = await chat.transcript(sessionId)
      await reading.done(result.ok)
      return result.ok ? json(result.value) : failureResponse(result.failure)
    }
    if (rest.length === 3 && rest[2] === 'messages') {
      if (request.method !== 'POST') return methodNotAllowed(['POST'])
      if (!scope.visible(sessionId)) return failureResponse(HIDDEN_SESSION)
      const body = await readJsonObject(request)
      if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
      if (Object.hasOwn(body, 'from')) {
        const senderDenied = signedSenderRefusal(deps, body['from'])
        if (senderDenied !== null) return senderDenied
      }
      const text = parseChatText(body)
      if (!text.ok) return fail(400, 'invalid', text.message)
      // A role refusal is not sent and not recorded, like every other guard:
      // nothing was done. Everything past it is admitted, then written down
      // under the command's own verb in place of `chat.message.send`.
      const command = chatCommandOf(text.value)
      if (
        command !== null &&
        COMMAND_NEEDS_WRITE[command] &&
        !canWrite(access)
      ) {
        return fail(403, 'forbidden', COMMAND_NEEDS_OPS)
      }
      const blocked = await ctx.admit()
      if (blocked !== null) return blocked
      const result = await new ChatDispatch(ctx).send({
        sessionId,
        text: text.value,
        ...(command === null ? {} : { command }),
      })
      if (result instanceof Response) return result
      await ctx.record(
        command === null ? 'chat.message.send' : `chat.command.${command}`,
        sessionId,
        ...outcomeOf(result),
      )
      return result.ok ? json(result.value) : failureResponse(result.failure)
    }
  }

  return notFound(`unknown path: ${url.pathname}`)
}

async function dispatchChatFragment(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  const { request, deps, access, accounts, url, now } = ctx
  // The two chat fragments take the chat guard in full — see the module note
  // on why the chat face has no read-only tier.
  const deniedAdmin = guardChat(access, 'guarded')
  if (deniedAdmin !== null) return deniedAdmin
  const chat = deps.chat
  if (chat === undefined) return chatUnsupported()
  if (request.method !== 'GET') return methodNotAllowed(['GET'])
  const scope = chatScopeOf(access, accounts)
  if (rest[0] === 'front') {
    return await dispatchFrontFragment(ctx, chat, scope, rest.slice(1))
  }
  if (rest[0] === 'sessions' && rest.length === 1) {
    const active = textParam(url.searchParams, 'active') ?? null
    return html(
      await chatSessionsFragment(chat, active, now, scope, lookFaces(ctx)),
    )
  }
  // The empty page's greeting, for the agent just picked.
  if (rest[0] === 'greet' && rest.length === 1) {
    const target = textParam(url.searchParams, 'target') ?? undefined
    const thread = await chatThreadFragment(
      chat,
      null,
      now,
      scope,
      lookFaces(ctx),
      target,
    )
    return html(thread.html)
  }
  if (rest[0] === 'thread' && rest.length === 2) {
    const sessionId = decodeURIComponent(rest[1] ?? '')
    // `?open=1` is the page switching to this conversation; without it the
    // fetch is the poller or a stream event refreshing what is already open,
    // and a hundred refreshes are not a hundred readings — but a refresh with
    // no reading before it is one (`noteTranscriptRead`). A conversation this
    // caller may not see is answered without a read either way.
    let reading: TranscriptReading | undefined
    if (sessionId !== '' && scope.visible(sessionId)) {
      const noted = await noteTranscriptRead(
        ctx,
        sessionId,
        url.searchParams.get('open') === '1',
      )
      if (noted instanceof Response) {
        return html(ledgerClosedThread(now).html, 503)
      }
      reading = noted
    }
    const thread = await chatThreadFragment(
      chat,
      sessionId,
      now,
      scope,
      lookFaces(ctx),
    )
    await reading?.done(thread.open)
    return html(thread.html)
  }
  return notFound(`unknown path: ${url.pathname}`)
}

export const chatRoute: RouteModule = {
  area: {
    id: 'chat',
    label: '对话',
    group: 'main',
    href: '/',
    icon: 'messages-square',
    front: true,
  },
  // 形象 lives with 对话, the page that draws and edits figures
  // (`routes/avatars.ts`), and so do the Remote copies of Code sessions
  // (`routes/codeApi.ts`, P37.15); their heads guard themselves.
  api: {
    heads: ['chat', ...avatarsApiRoute.heads, ...codeApiRoute.heads],
    handle: (ctx, head, rest) =>
      head === 'chat'
        ? dispatchChatApi(ctx, rest)
        : head === 'code'
          ? codeApiRoute.handle(ctx, head, rest)
          : avatarsApiRoute.handle(ctx, head, rest),
  },
  fragments: {
    heads: ['chat', ...avatarFragmentRoute.heads],
    handle: (ctx, head, rest) =>
      head === 'chat'
        ? dispatchChatFragment(ctx, rest)
        : avatarFragmentRoute.handle(ctx, head, rest),
  },
}
