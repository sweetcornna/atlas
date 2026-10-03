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
import {
  CHAT_LOCAL_COMMANDS,
  type ActionLedgerPort,
  type ChatLocalCommand,
  type ChatPort,
  type ChatTarget,
  type ChatUpdate,
  type ConsoleFailure,
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
  chatPreview,
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
  canWrite,
  failureOf,
  failureResponse,
  guardChat,
  requiredString,
  outcomeOf,
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
 * What stands where a conversation would have opened while the action ledger
 * cannot take the reading (P15.9). `rejected` because it is this side that
 * will not let the transcript out — the far node was never asked. The
 * remedy named is the one a refused write is told (`http.ts`,
 * `LEDGER_CLOSED`).
 */
const LEDGER_CLOSED_FAILURE: ConsoleFailure = {
  code: 'rejected',
  message: '动作账本停用，暂时不能打开对话；恢复动作账本之后再试。',
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

async function chatSessionsFragment(
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

// --- readings (P15.9, D6) ----------------------------------------------------

/**
 * How long one recorded reading covers the same person re-reading the same
 * conversation without a word from the page that it is an opening — the
 * poller, a stream event, a script that leaves `?open=1` off.
 */
const READ_WINDOW_MS = 30 * 60 * 1000

/** Pairs the window remembers before it forgets the least recently used. */
const MAX_READ_WINDOW_ENTRIES = 4096

/**
 * When each (person, conversation) last had a reading written down.
 *
 * In memory and bounded: a restart, or a pair pushed out by four thousand
 * others, costs one more line on the next poll — never a read without one.
 * Insertion order is the recency order; a lookup moves the pair to the end
 * without changing when it was recorded, so the window is "since the last
 * line", not "since the last poll", and an open page writes a line every half
 * hour rather than once for ever.
 */
class ReadWindow {
  readonly #recordedAt = new Map<string, number>()

  covers(key: string, now: number): boolean {
    const at = this.#recordedAt.get(key)
    if (at === undefined) return false
    this.#recordedAt.delete(key)
    this.#recordedAt.set(key, at)
    return now - at < READ_WINDOW_MS
  }

  note(key: string, now: number): void {
    this.#recordedAt.delete(key)
    this.#recordedAt.set(key, now)
    for (const oldest of this.#recordedAt.keys()) {
      if (this.#recordedAt.size <= MAX_READ_WINDOW_ENTRIES) break
      this.#recordedAt.delete(oldest)
    }
  }
}

/**
 * One window per ledger, so two consoles in one process — every test suite —
 * never answer for each other. A console with no ledger has nothing to cover.
 */
const READ_WINDOWS = new WeakMap<ActionLedgerPort, ReadWindow>()

function readWindowOf(ledger: ActionLedgerPort | undefined): ReadWindow | null {
  if (ledger === undefined) return null
  let window = READ_WINDOWS.get(ledger)
  if (window === undefined) {
    window = new ReadWindow()
    READ_WINDOWS.set(ledger, window)
  }
  return window
}

/** A reading the ledger let through; `done` once the transcript was fetched. */
interface TranscriptReading {
  done(loaded: boolean): Promise<void>
}

/**
 * The one gate in front of every path that hands out a transcript (D6).
 *
 * - `explicitOpen` (the JSON read, the page with `?session=`, the fragment with
 *   `?open=1`): `admit` first, and one line once the transcript loaded.
 * - Otherwise (the poll): if this person had a reading of this conversation
 *   written down in the last {@link READ_WINDOW_MS}, it is covered and goes
 *   ahead unrecorded; if not, it is an opening like any other. Leaving
 *   `?open=1` off therefore never makes a read invisible — it only spares the
 *   ledger a line per refresh — and "one opening and a hundred polls" is still
 *   one line, because the opening starts the window. Only a line the ledger
 *   took starts it: a failed write leaves the next poll to ask again.
 *
 * Refused, the answer is the 503 the ledger's `admit` produced; the caller
 * decides how a refusal looks on its own surface. Only for a conversation the
 * caller may see: a hidden one is answered without a read and never gets here.
 */
async function noteTranscriptRead(
  ctx: RouteContext,
  sessionId: string,
  explicitOpen: boolean,
): Promise<TranscriptReading | Response> {
  const window = readWindowOf(ctx.deps.actions)
  const key = `${ctx.access.principal?.subject ?? 'anonymous'}|${sessionId}`
  if (!explicitOpen && window?.covers(key, ctx.now) === true) {
    return { done: () => Promise.resolve() }
  }
  const blocked = await ctx.admit()
  if (blocked !== null) return blocked
  return {
    async done(loaded) {
      if (!loaded) return
      // Only a line that is in the ledger covers the polls after it: a write
      // that failed has closed the ledger, and the next poll must ask again.
      if (await ctx.record('chat.transcript.open', sessionId, 'ok')) {
        window?.note(key, ctx.now)
      }
    },
  }
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
 * this conversation's own session, so whoever may talk in it may run them.
 */
const COMMAND_NEEDS_WRITE: Readonly<Record<ChatLocalCommand, boolean>> = {
  autocompact: true,
  compact: false,
  context: false,
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
  accounts: ConsoleAccounts | undefined,
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
    const result = await chat.open(target.value)
    await ctx.record('chat.session.open', target.value, ...outcomeOf(result))
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
      return await handleChatSessions(ctx, chat, scope, accounts)
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
      const result = await chat.send({
        sessionId,
        text: text.value,
        ...(command === null ? {} : { command }),
      })
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
  if (rest[0] === 'sessions' && rest.length === 1) {
    const active = textParam(url.searchParams, 'active') ?? null
    return html(await chatSessionsFragment(chat, active, now, scope))
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
    const thread = await chatThreadFragment(chat, sessionId, now, scope)
    await reading?.done(thread.open)
    return html(thread.html)
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
      // A page that opens with a conversation in it is one reading, and the
      // ledger is asked before the transcript is read. Refused, the page is
      // still the page — the list, the way to every other conversation — with
      // the reason where the thread would be, and a 503 under it.
      let reading: TranscriptReading | undefined
      let closed = false
      if (sessionId !== null && scope.visible(sessionId)) {
        const noted = await noteTranscriptRead(ctx, sessionId, true)
        if (noted instanceof Response) closed = true
        else reading = noted
      }
      const [sessions, thread] = await Promise.all([
        chatSessionsFragment(chat, sessionId, now, scope),
        closed
          ? ledgerClosedThread(now)
          : chatThreadFragment(chat, sessionId, now, scope),
      ])
      await reading?.done(thread.open)
      return {
        title: '对话',
        body: chatPageBody({
          sessions,
          thread: thread.html,
          composerEnabled: thread.open,
        }),
        ...(closed ? { status: 503 } : {}),
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
