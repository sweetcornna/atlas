// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 对话 — the conversation face.
 *
 * Owns `/chat`, `/v0/chat/…` and `/fragments/chat/…`.
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
 * When `deps.chat` is absent, `/chat` answers **404** (there is no such page on
 * this instance) while `/v0/chat/*` answers **501** (the route exists in this
 * version; this console has no channel behind it). A browser gets the honest
 * answer and a script gets the diagnosable one. Both are still behind the role
 * check, so an anonymous caller cannot probe which consoles have chat wired.
 */

import type { ConsoleAccounts } from '../access.js'
import {
  chatScopeOf,
  streamScopeOf,
  type ChatScope,
  type StreamScope,
} from '../accountsHttp.js'
import type {
  ChatPort,
  ChatTarget,
  ChatUpdate,
  ConsoleFailure,
} from '../deps.js'
import {
  fail,
  html,
  json,
  methodNotAllowed,
  notFound,
  readJsonObject,
} from '../respond.js'
import {
  MAX_CHAT_TEXT_LENGTH,
  renderChatSessions,
  renderChatThread,
} from '../view/chat.js'
import {
  CHAT_PAGE_CSS,
  CHAT_PAGE_SCRIPT,
  chatPageBody,
} from '../view/chatPage.js'
import {
  failureOf,
  failureResponse,
  guardChat,
  requiredString,
  textParam,
  underPath,
  valueOf,
  type Parsed,
  type Protection,
} from './shared.js'
import type { RouteContext, RouteModule } from './types.js'

/**
 * The one answer to a session a member may not see, whether it belongs to
 * somebody else or does not exist at all — the host's own wording for the
 * second case, so the two cannot be told apart (`tenancy-m1.md` §3.2).
 */
const CHAT_SESSION_NOT_FOUND = '这条会话不在本控制台的记录里'

/**
 * The failure a member gets for a session it may not see, in place of any
 * port call: the same `not_found` the port gives for one that does not exist.
 */
const HIDDEN_SESSION: ConsoleFailure = {
  code: 'not_found',
  message: CHAT_SESSION_NOT_FOUND,
}

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
    '该控制台没有配置聊天通道；请在启动 occ console 时给 --chat-url 与传输层 PSK 后重试。',
  )
}

/**
 * The roster the chat views annotate themselves with.
 *
 * A failed lookup is `null`, not an empty list: "the registry says this agent
 * is gone" and "nobody could ask the registry" are different facts and the view
 * renders them differently (`view/chat.ts`, `targetState`).
 */
async function chatTargets(
  chat: ChatPort,
): Promise<readonly ChatTarget[] | null> {
  const result = await chat.targets()
  return result.ok ? result.value : null
}

export async function chatSessionsFragment(
  chat: ChatPort,
  activeId: string | null,
  now: number,
  scope: ChatScope,
): Promise<string> {
  const [sessions, targets] = await Promise.all([
    chat.sessions(),
    chatTargets(chat),
  ])
  return renderChatSessions({
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
}

export async function chatThreadFragment(
  chat: ChatPort,
  sessionId: string | null,
  now: number,
  scope: ChatScope,
): Promise<ChatThreadRender> {
  if (sessionId === null || sessionId === '') {
    return {
      html: renderChatThread({
        transcript: null,
        failure: null,
        target: null,
        now,
      }),
      open: false,
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
  return {
    html: renderChatThread({
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
function chatStream(chat: ChatPort, scope?: StreamScope): Response {
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let detach: (() => void) | null = null

  const release = (): void => {
    unsubscribe?.()
    unsubscribe = null
    if (heartbeat !== null) clearInterval(heartbeat)
    heartbeat = null
    detach?.()
    detach = null
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
  return text
}

async function handleChatSessions(
  request: Request,
  chat: ChatPort,
  scope: ChatScope,
  accounts: ConsoleAccounts | undefined,
): Promise<Response> {
  if (request.method === 'GET') {
    const result = await chat.sessions()
    return result.ok
      ? json({
          sessions: result.value.filter(session => scope.visible(session.id)),
        })
      : failureResponse(result.failure)
  }
  if (request.method === 'POST') {
    const body = await readJsonObject(request)
    if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
    const target = requiredString(body, 'target')
    if (!target.ok) return fail(400, 'invalid', target.message)
    const result = await chat.open(target.value)
    if (!result.ok) return failureResponse(result.failure)
    if (scope.opener !== null && accounts !== undefined) {
      // The owner is written before the session is handed back: a session a
      // person opened must never be seen without one. If the book cannot take
      // it, the book is closed now and the caller's next request is a 503
      // anyway; the session stays in the store, owned by nobody, which only
      // ops and the admin token can see.
      const owned = accounts.book.recordOwner(result.value.id, scope.opener)
      if (!owned.ok) {
        return fail(503, 'unavailable', owned.refusal.message)
      }
    }
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
    return chatStream(chat, streamScopeOf(access, accounts))
  }

  if (name === 'sessions') {
    if (rest.length === 1) {
      return await handleChatSessions(request, chat, scope, accounts)
    }
    const sessionId = decodeURIComponent(rest[1] ?? '')
    if (rest.length === 2) {
      if (request.method !== 'GET') return methodNotAllowed(['GET'])
      if (!scope.visible(sessionId)) return failureResponse(HIDDEN_SESSION)
      const result = await chat.transcript(sessionId)
      return result.ok ? json(result.value) : failureResponse(result.failure)
    }
    if (rest.length === 3 && rest[2] === 'messages') {
      if (request.method !== 'POST') return methodNotAllowed(['POST'])
      if (!scope.visible(sessionId)) return failureResponse(HIDDEN_SESSION)
      const body = await readJsonObject(request)
      if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
      const text = parseChatText(body)
      if (!text.ok) return fail(400, 'invalid', text.message)
      const result = await chat.send({ sessionId, text: text.value })
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
  if (rest[0] === 'sessions' && rest.length === 1) {
    const active = textParam(url.searchParams, 'active') ?? null
    return html(await chatSessionsFragment(chat, active, now, scope))
  }
  if (rest[0] === 'thread' && rest.length === 2) {
    const sessionId = decodeURIComponent(rest[1] ?? '')
    return html((await chatThreadFragment(chat, sessionId, now, scope)).html)
  }
  return notFound(`unknown path: ${url.pathname}`)
}

export const chatRoute: RouteModule = {
  area: {
    id: 'chat',
    label: '对话',
    group: 'run',
    href: '/chat',
    icon: 'messages-square',
  },
  page: {
    match: underPath('chat'),
    guard: 'chat',
    // 404 rather than 501: this is a page, and on this instance there is no
    // such page. A script asking `/v0/chat/*` gets the 501 instead.
    available: ctx => ctx.deps.chat !== undefined,
    async render(ctx) {
      const { deps, url, now } = ctx
      const chat = deps.chat
      if (chat === undefined) return notFound(`unknown path: ${url.pathname}`)
      const scope = chatScopeOf(ctx.access, ctx.accounts)
      const sessionId = textParam(url.searchParams, 'session') ?? null
      const [sessions, thread] = await Promise.all([
        chatSessionsFragment(chat, sessionId, now, scope),
        chatThreadFragment(chat, sessionId, now, scope),
      ])
      return {
        title: '对话',
        body: chatPageBody({
          sessions,
          thread: thread.html,
          composerEnabled: thread.open,
        }),
      }
    },
    css: CHAT_PAGE_CSS,
    script: CHAT_PAGE_SCRIPT,
  },
  api: {
    heads: ['chat'],
    handle: (ctx, _head, rest) => dispatchChatApi(ctx, rest),
  },
  fragments: {
    heads: ['chat'],
    handle: (ctx, _head, rest) => dispatchChatFragment(ctx, rest),
  },
}
