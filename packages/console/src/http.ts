// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The console's HTTP face: one page, a handful of JSON routes and three HTML
 * fragments, over `Bun.serve`.
 *
 * Shaped like `packages/registry/src/http.ts` — hand-written routing, no
 * framework, {@link createConsoleHandler} exposed separately from
 * {@link startConsoleServer} so every route can be exercised with a plain
 * `Request` and a fake port, without binding anything.
 *
 * ## Route table
 *
 * | Method | Path | Role | Returns |
 * | --- | --- | --- | --- |
 * | GET | `/` | view | `text/html`, the whole page |
 * | GET | `/login` | public | `text/html`, the token field |
 * | POST | `/login` | public | 303 + `Set-Cookie`, or the field again |
 * | POST | `/logout` | public | 303 + a cleared cookie |
 * | GET | `/assets/app.css` | public | `text/css` |
 * | GET | `/assets/app.js` | public | `text/javascript` |
 * | GET | `/v0/health` | public | `{ status: 'ok' }` |
 * | GET | `/v0/agents` | view | `{ agents }` |
 * | POST | `/v0/agents` | admin | the registered `ConsoleAgent` |
 * | DELETE | `/v0/agents/<enc address>` | admin | 204 |
 * | POST | `/v0/agents/<enc address>/heartbeat` | admin | `ConsoleAgent` |
 * | GET | `/v0/audit?…` | view | `AuditPage` |
 * | GET | `/v0/audit/chain/<enc traceId>` | view | `{ chain }`, may be null |
 * | GET | `/v0/limits` | view | `LimitsSnapshot` |
 * | POST | `/v0/wake` | admin | `WakeOutcome`, or 501 without a wake port |
 * | GET | `/fragments/{roster,audit,limits}` | view | `text/html` fragment |
 * | GET | `/fragments/chain/<enc traceId>` | view | `text/html` fragment |
 * | GET | `/chat?session=<id>` | **admin** | `text/html`, the chat page |
 * | GET | `/v0/chat/targets` | **admin** | `{ targets }` |
 * | GET | `/v0/chat/sessions` | **admin** | `{ sessions }` |
 * | POST | `/v0/chat/sessions` | **admin** | the opened `ChatSession` |
 * | GET | `/v0/chat/sessions/<enc id>` | **admin** | `ChatTranscript` |
 * | POST | `/v0/chat/sessions/<enc id>/messages` | **admin** | the operator `ChatTurn` |
 * | GET | `/v0/chat/stream` | **admin** | `text/event-stream` |
 * | GET | `/fragments/chat/sessions?active=<id>` | **admin** | `text/html` fragment |
 * | GET | `/fragments/chat/thread/<enc id>` | **admin** | `text/html` fragment |
 *
 * ## Chat is admin-only, all of it
 *
 * Every row above with `chat` in it needs the admin token, **including the
 * read-only ones**. Two reasons, and either alone would be enough: sending
 * spends the far node's model budget, and a transcript is the one thing on this
 * console that contains free-form content rather than ids and counts — §7.2
 * says the rest of the page never touches a payload, and this page is the
 * exception. A view token therefore does not merely fail to send; it cannot see
 * that the conversation exists. The ledger page hides the nav link for the same
 * reason it hides it when there is no chat channel at all.
 *
 * When `deps.chat` is absent, `/chat` answers **404** (there is no such page on
 * this instance) while `/v0/chat/*` answers **501** (the route exists in this
 * version; this console has no channel behind it). A browser gets the honest
 * answer and a script gets the diagnosable one. Both are still behind the admin
 * check, so an anonymous caller cannot probe which consoles have chat wired.
 *
 * The last row is an addition to the agreed table, not a redesign of it: the
 * view layer exports `renderChain` and the trace cells it renders carry
 * `data-action="chain"`, so the client needs somewhere to fetch that panel
 * from as **markup**. The JSON `/v0/audit/chain/…` route stays exactly as
 * specified, for callers that want the data.
 *
 * The two asset routes are public because a browser does not attach the
 * console's credential to a `<link>` or `<script>` it discovers inside a page
 * (see `auth.ts` on where the token rides). They are compiled-in constants
 * containing no instance data, so serving them to an anonymous local caller
 * gives nothing away; gating them would only produce an unstyled page.
 *
 * The whole address rides in **one** percent-encoded path segment, the same
 * convention the registry uses (`qianmo%3A%2F%2Fnode-b%2Freviewer`): `URL`
 * leaves the escapes alone, so the split still yields the expected segment
 * count and one `decodeURIComponent` hands the address back.
 *
 * ## A port that is down is not a 500
 *
 * Every `ConsoleDeps` port answers with a typed failure instead of throwing,
 * and this layer keeps that promise visible: a failure becomes the status that
 * describes it (503 when the registry is unreachable, 404 when the address is
 * gone, …) carrying `failure.message`, never a 500.
 *
 * The HTML routes go further and do not fail at all. **The page must open when
 * the registry is down** — that is when someone is looking at it. So `/` and
 * the fragments hand `(value | null, failure | null)` to the view layer and
 * answer 200 with a page that renders the failure in place of the panel it
 * belongs to. A console that 503s as a whole because one of three panels could
 * not load is a console that tells you nothing at the moment you need it.
 *
 * ## 401 before 405
 *
 * Role is checked before the method on every non-public route: an anonymous
 * caller should not learn which verbs a route accepts. Unknown paths answer
 * 404 without consulting the credential at all — there is no role that would
 * make them exist. Neither 401 nor 403 ever echoes the token it received.
 *
 * ## Three protection classes, because a cookie is ambient
 *
 * Since `POST /login` may hand the browser a cookie, every route has to say
 * what an ambient credential is allowed to do on it. `auth.ts` holds the
 * argument; this file holds the assignment, and there are exactly three values:
 *
 * - **`document`** — `GET /` and `GET /chat`. A cookie alone is enough: a
 *   top-level navigation cannot carry a custom header, and a foreign page that
 *   forces one still cannot read the response or change anything by causing it.
 * - **`stream`** — `GET /v0/chat/stream`, which is an `EventSource` and equally
 *   header-less. A cookie alone is enough *unless* `Sec-Fetch-Site` says the
 *   caller is another origin, which is the one case `SameSite` misses because
 *   it ignores the port.
 * - **`guarded`** — everything else that needs a credential: every write, every
 *   JSON read, every HTML fragment. A cookie must be accompanied by the
 *   {@link CONSOLE_HEADER} header, which a cross-origin caller cannot set
 *   without a preflight this server never answers.
 *
 * The `Bearer` and `?token=` positions are unaffected in all three: they are
 * not ambient, so they are not a CSRF vector.
 *
 * ## Unauthenticated: a redirect for a browser, a 401 for everything else
 *
 * A `GET` whose `Accept` asks for `text/html` is a person in a browser, and
 * sending them a JSON 401 they cannot act on is how a console gets a reputation
 * for being broken — they get a 303 to `/login` with a validated `redirect`
 * back. Everything else keeps the 401 JSON exactly as before, because a `curl`
 * or a poller that gets HTML and a 200 instead of a 401 has been lied to. The
 * one refinement is 403: an operator holding a view token who navigates to an
 * admin page is shown the login card **in place**, with the reason, rather than
 * being bounced to `/login` — they are already authenticated, so a page that
 * redirected them would redirect them straight back.
 */

import { CONSOLE_CLIENT_JS } from './assets/client.js'
import { CONSOLE_CSS } from './assets/css.js'
import {
  CONSOLE_HEADER,
  LOGIN_PATH,
  SESSION_MAX_AGE_SECONDS,
  TOKEN_QUERY_PARAM,
  clearedSessionCookieHeader,
  credentialOf,
  isCrossOriginRequest,
  isSecureRequest,
  roleOfToken,
  safeRedirect,
  sessionCookieHeader,
  type ConsoleCredential,
  type ConsoleTokens,
} from './auth.js'
import type {
  AuditFilter,
  ChatPort,
  ChatTarget,
  ChatUpdate,
  ConsoleDeps,
  ConsoleFailure,
  ConsoleResult,
  RegisterAgentInput,
  WakeInput,
} from './deps.js'
import { renderRoster } from './view/agents.js'
import { renderAudit, renderChain } from './view/audit.js'
import { failureBar } from './view/bits.js'
import {
  MAX_CHAT_TEXT_LENGTH,
  renderChatSessions,
  renderChatThread,
} from './view/chat.js'
import { renderChatPage } from './view/chatPage.js'
import { renderLimits } from './view/limits.js'
import { renderLoginPage } from './view/login.js'
import { renderPage } from './view/page.js'
import { LoginThrottle } from './throttle.js'

/** Prefix of every JSON route in this API version. */
export const API_PREFIX = '/v0'

/**
 * Hard ceiling on the audit tail, whatever the query string asks for.
 *
 * The trail is an append-only file that grows for as long as the network runs.
 * A page that renders all of it is a page that stops rendering.
 */
export const MAX_AUDIT_LIMIT = 500

/** Header shown when the operator did not name this console. */
const DEFAULT_LABEL = '阡陌控制台'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

/**
 * Headers for anything a browser renders.
 *
 * `no-referrer` matters here rather than being boilerplate: the page URL can
 * carry the token (`?token=…`), and a default `Referer` would hand it to
 * whatever the operator clicks next.
 */
const DOCUMENT_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const

/** Error vocabulary of this surface. `code` is for clients, not for users. */
type ConsoleErrorCode =
  | ConsoleFailure['code']
  | 'unauthorized'
  | 'forbidden'
  | 'method_not_allowed'
  | 'internal'

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  })
}

function fail(
  status: number,
  code: ConsoleErrorCode,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json({ error: { code, message } }, status, headers)
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...DOCUMENT_HEADERS,
    },
  })
}

function asset(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

function notFound(message: string): Response {
  return fail(404, 'not_found', message)
}

function methodNotAllowed(allowed: readonly string[]): Response {
  return fail(405, 'method_not_allowed', `允许的方法：${allowed.join(', ')}`, {
    allow: allowed.join(', '),
  })
}

/** HTTP status for a port failure. Never 500 — the port answered. */
function statusFor(code: ConsoleFailure['code']): number {
  switch (code) {
    case 'unreachable':
      return 503
    case 'not_found':
      return 404
    case 'unsupported':
      return 501
    // `rejected` (the far side refused) and `invalid` (we refused) both land on
    // 400: the ports cannot tell a conflict from a malformed address, and
    // inventing a 409 here would be a guess the client would act on.
    case 'rejected':
    case 'invalid':
      return 400
  }
}

function failureResponse(failure: ConsoleFailure): Response {
  return fail(statusFor(failure.code), failure.code, failure.message)
}

function valueOf<T>(result: ConsoleResult<T>): T | null {
  return result.ok ? result.value : null
}

function failureOf<T>(result: ConsoleResult<T>): ConsoleFailure | null {
  return result.ok ? null : result.failure
}

/**
 * What an ambient (cookie) credential is allowed to do on a route. The module
 * note above defines the three; `auth.ts` argues for them.
 */
type Protection = 'document' | 'stream' | 'guarded'

/** What a JSON caller is told when a view token reached an admin route. */
const ADMIN_REQUIRED = '该操作需要 admin token，当前凭据只有只读权限。'

/**
 * The same fact for the login card, in the page's own register.
 *
 * Deliberately not the string above: everything the console renders keeps to
 * one clause and no full stop (`view/page.ts`, and the copy gates in
 * `test/view.test.ts`), while an error *body* is read by a developer and may
 * spend a sentence saying what to do.
 */
const ADMIN_REQUIRED_LINE = '该页面需要 admin 令牌'

/** What a failed login is told. Never which half of the pair was close. */
const LOGIN_REFUSED = '令牌无效'

/**
 * Enforce the role a route needs, and what the credential's *position* is
 * allowed to reach.
 *
 * 401 when nothing valid was presented, 403 when a view token reached an admin
 * route or when a cookie reached a route it may not carry alone. Neither body
 * repeats the token — a credential that shows up in a response ends up in a
 * log, a screenshot or a bug report.
 *
 * Role comes first and position second on purpose: a caller with no valid
 * credential must get the same 401 whether or not it also happened to send the
 * console header, or the header becomes a probe for "is this a real cookie".
 */
function guard(
  credential: ConsoleCredential,
  need: 'view' | 'admin',
  protection: Protection,
): Response | null {
  if (credential.role === 'none') {
    return fail(
      401,
      'unauthorized',
      '需要控制台 token：带 `Authorization: Bearer <token>` 头，或在 URL 上加 `?token=<token>`，或在登录页填一次。',
    )
  }
  if (credential.source === 'cookie') {
    if (protection === 'guarded' && !credential.header) {
      return fail(
        403,
        'forbidden',
        `cookie 凭据的请求必须同时带 ${CONSOLE_HEADER} 请求头；` +
          '这条规则挡的是跨源页面借浏览器自动附带的 cookie 发出的请求。',
      )
    }
    if (protection === 'stream' && credential.crossOrigin) {
      return fail(
        403,
        'forbidden',
        'cookie 凭据只能从本控制台自己的页面打开这条流。',
      )
    }
  }
  if (need === 'admin' && credential.role !== 'admin') {
    return fail(403, 'forbidden', ADMIN_REQUIRED)
  }
  return null
}

// --- the login door ------------------------------------------------------

/**
 * Biggest login body this will read.
 *
 * The form has two short fields. Anything larger is not a login attempt, and
 * refusing it by `Content-Length` costs nothing while reading it costs whatever
 * the sender decided.
 */
const MAX_LOGIN_BODY_BYTES = 4096

/** A redirect that carries no body. `303` so a POST becomes a GET. */
function seeOther(
  location: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      ...headers,
    },
  })
}

/**
 * True when this request is a person navigating rather than a script calling.
 *
 * `Accept` is the whole judgement, and it is only consulted for a `GET`: a
 * `POST` that happens to accept HTML is still a caller that asked for an
 * action, and answering it with a redirect to a login form would turn a refused
 * write into a 303 the caller reports as success.
 */
function wantsHtml(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  return (request.headers.get('accept') ?? '').includes('text/html')
}

/**
 * Where to send a browser that has no credential, with the way back.
 *
 * The `token` parameter is stripped out of the return path before it is
 * encoded. It is there because a stale bookmark carried it, it did not work,
 * and preserving it would put a dead credential into the `Location` header, the
 * browser's history and every access log between here and there.
 */
function loginRedirect(url: URL): Response {
  const back = new URL(url.toString())
  back.searchParams.delete(TOKEN_QUERY_PARAM)
  const target = `${back.pathname}${back.search}`
  const query = target === '/' ? '' : `?redirect=${encodeURIComponent(target)}`
  return seeOther(`${LOGIN_PATH}${query}`)
}

/** The login document, at whatever status the reason calls for. */
function loginPage(
  deps: ConsoleDeps,
  options: {
    readonly redirect: string
    readonly status?: number
    readonly error?: string
    readonly headers?: Record<string, string>
  },
): Response {
  const body = renderLoginPage({
    label: deps.label ?? DEFAULT_LABEL,
    redirect: options.redirect,
    ...(options.error === undefined ? {} : { error: options.error }),
  })
  return new Response(body, {
    status: options.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...DOCUMENT_HEADERS,
      ...(options.headers ?? {}),
    },
  })
}

/**
 * Turn a refusal into the form the caller can act on.
 *
 * A script keeps the JSON it would have got before this page existed. A browser
 * gets the door: `/login` when it has nothing, and the card in place when it
 * has a view token and asked for an admin page — bouncing *that* caller to
 * `/login` would only bounce them back, because they are already logged in.
 */
function documentDenial(
  request: Request,
  denied: Response,
  deps: ConsoleDeps,
  url: URL,
): Response {
  if (!wantsHtml(request)) return denied
  if (denied.status === 401) return loginRedirect(url)
  if (denied.status === 403) {
    const back = new URL(url.toString())
    back.searchParams.delete(TOKEN_QUERY_PARAM)
    return loginPage(deps, {
      redirect: safeRedirect(`${back.pathname}${back.search}`),
      status: 403,
      error: ADMIN_REQUIRED_LINE,
    })
  }
  return denied
}

/** The login form's body, or `null` when this is not one. */
async function readLoginForm(
  request: Request,
): Promise<URLSearchParams | null> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_LOGIN_BODY_BYTES) return null
  const type = request.headers.get('content-type') ?? ''
  if (!type.includes('application/x-www-form-urlencoded')) return null
  try {
    const text = await request.text()
    if (text.length > MAX_LOGIN_BODY_BYTES) return null
    return new URLSearchParams(text)
  } catch {
    return null
  }
}

/**
 * `GET /login` renders the field; `POST /login` checks it and sets the cookie.
 *
 * Public, because a door that needs a key is not a door. Three things are worth
 * reading:
 *
 * **The throttle runs before the comparison**, so a blocked caller learns
 * nothing about the token they just sent — including whether it was right.
 *
 * **`Sec-Fetch-Site` refuses a cross-origin POST.** Login CSRF is not the worst
 * bug in the world here (an attacker who can force a login already knows a
 * token, and knowing one is the whole game), but the check is free and it also
 * removes this endpoint as a guessing oracle that a foreign page could drive
 * through a victim's browser.
 *
 * **Success answers 303, never 200 with a page.** The cookie is brand new and
 * the browser has to make a fresh request for the destination to be rendered
 * with it; answering the POST with the console itself would render the page for
 * a caller that, from the server's point of view, was not carrying the cookie
 * yet.
 */
async function handleLogin(
  request: Request,
  deps: ConsoleDeps,
  tokens: ConsoleTokens,
  credential: ConsoleCredential,
  throttle: LoginThrottle,
  url: URL,
  clientKey: string,
  now: number,
): Promise<Response> {
  const asked = safeRedirect(url.searchParams.get('redirect'))

  if (request.method === 'GET') {
    // Already carrying a credential: there is nothing to fill in. The console
    // itself is the honest answer, not a form that would refuse to appear.
    if (credential.role !== 'none') return seeOther(asked)
    return loginPage(deps, { redirect: asked })
  }
  if (request.method !== 'POST') return methodNotAllowed(['GET', 'POST'])

  if (isCrossOriginRequest(request)) {
    return fail(403, 'forbidden', '登录只接受来自本控制台自己页面的提交。')
  }

  const form = await readLoginForm(request)
  if (form === null) {
    return fail(400, 'invalid', '请求体必须是登录表单')
  }
  const target = safeRedirect(form.get('redirect'))

  const wait = throttle.retryAfterSeconds(clientKey, now)
  if (wait > 0) {
    return loginPage(deps, {
      redirect: target,
      status: 429,
      error: `尝试过多 · 请等 ${wait} 秒`,
      headers: { 'retry-after': String(wait) },
    })
  }

  const presented = (form.get('token') ?? '').trim()
  const role = roleOfToken(presented, tokens)
  if (role === 'none') {
    throttle.recordFailure(clientKey, now)
    // The status is honest and the wording is not specific: "no such token" and
    // "wrong token" are the same answer, and neither repeats what was typed.
    return loginPage(deps, {
      redirect: target,
      status: 401,
      error: LOGIN_REFUSED,
    })
  }

  throttle.clear(clientKey)
  return seeOther(target, {
    'set-cookie': sessionCookieHeader(presented, {
      secure: isSecureRequest(request),
      maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
    }),
  })
}

/**
 * `POST /logout` — drop the cookie and go back to the door.
 *
 * Needs no credential: the only thing it changes is the caller's own browser
 * state, and demanding a valid token to *stop* using one would strand anybody
 * whose token was rotated while they had a tab open. The `Sec-Fetch-Site` check
 * is here anyway, because the nuisance version of this (a same-site page on
 * another port logging an operator out on a loop) costs three lines to remove.
 */
function handleLogout(request: Request): Response {
  if (request.method !== 'POST') return methodNotAllowed(['POST'])
  if (isCrossOriginRequest(request)) {
    return fail(403, 'forbidden', '退出只接受来自本控制台自己页面的提交。')
  }
  return seeOther(LOGIN_PATH, {
    'set-cookie': clearedSessionCookieHeader({
      secure: isSecureRequest(request),
    }),
  })
}

// --- query parsing -------------------------------------------------------

function textParam(params: URLSearchParams, name: string): string | undefined {
  const raw = params.get(name)
  if (raw === null) return undefined
  const trimmed = raw.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Epoch milliseconds or an ISO string, whichever the caller typed.
 *
 * An unparseable value reads as "not given" rather than as an error: these
 * come from a text box on a page that reloads itself, and a filter that 400s
 * on a half-typed date is a filter nobody finishes typing. All-digit input is
 * always epoch ms — `2026` means 1970, not the year.
 */
function parseTimestamp(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  if (/^-?\d+$/.test(trimmed)) {
    const epoch = Number(trimmed)
    return Number.isSafeInteger(epoch) ? epoch : undefined
  }
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * Tail size, clamped rather than rejected.
 *
 * Anything present but not a positive integer — `0`, `-3`, `abc`, `12.5` — and
 * anything above {@link MAX_AUDIT_LIMIT} becomes the ceiling. An absent (or
 * empty) parameter stays absent so the port applies its own default.
 */
function parseLimit(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value <= 0) return MAX_AUDIT_LIMIT
  return Math.min(value, MAX_AUDIT_LIMIT)
}

/**
 * Read the audit filter out of a query string.
 *
 * Exported and pure so the clamping rules can be tested without a request:
 * they are the part of this file most likely to be quietly wrong.
 */
export function parseAuditFilter(url: URL): AuditFilter {
  const params = url.searchParams
  const filter: {
    source?: string
    outcome?: string
    traceId?: string
    taskId?: string
    agent?: string
    from?: number
    to?: number
    limit?: number
  } = {}

  const source = textParam(params, 'source')
  if (source !== undefined) filter.source = source
  const outcome = textParam(params, 'outcome')
  if (outcome !== undefined) filter.outcome = outcome
  const traceId = textParam(params, 'traceId')
  if (traceId !== undefined) filter.traceId = traceId
  const taskId = textParam(params, 'taskId')
  if (taskId !== undefined) filter.taskId = taskId
  const agent = textParam(params, 'agent')
  if (agent !== undefined) filter.agent = agent

  const from = parseTimestamp(params.get('from'))
  if (from !== undefined) filter.from = from
  const to = parseTimestamp(params.get('to'))
  if (to !== undefined) filter.to = to

  const limit = parseLimit(params.get('limit'))
  if (limit !== undefined) filter.limit = limit

  return filter
}

// --- body parsing --------------------------------------------------------

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json()
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function requiredString(
  body: Record<string, unknown>,
  key: string,
): Parsed<string> {
  const value = body[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, message: `字段 ${key} 必须是非空字符串` }
  }
  return { ok: true, value }
}

function optionalString(
  body: Record<string, unknown>,
  key: string,
): Parsed<string | undefined> {
  const value = body[key]
  if (value === undefined || value === null)
    return { ok: true, value: undefined }
  if (typeof value !== 'string') {
    return { ok: false, message: `字段 ${key} 必须是字符串` }
  }
  return { ok: true, value }
}

function parseRegisterInput(
  body: Record<string, unknown>,
): Parsed<RegisterAgentInput> {
  const address = requiredString(body, 'address')
  if (!address.ok) return address
  const endpoint = requiredString(body, 'endpoint')
  if (!endpoint.ok) return endpoint
  const publicKey = optionalString(body, 'publicKey')
  if (!publicKey.ok) return publicKey
  const status = optionalString(body, 'status')
  if (!status.ok) return status

  const rawCapabilities = body['capabilities']
  let capabilities: readonly string[] | undefined
  if (rawCapabilities !== undefined && rawCapabilities !== null) {
    if (
      !Array.isArray(rawCapabilities) ||
      rawCapabilities.some(item => typeof item !== 'string')
    ) {
      return { ok: false, message: '字段 capabilities 必须是字符串数组' }
    }
    capabilities = rawCapabilities as readonly string[]
  }

  return {
    ok: true,
    value: {
      address: address.value,
      endpoint: endpoint.value,
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(publicKey.value === undefined ? {} : { publicKey: publicKey.value }),
      ...(status.value === undefined ? {} : { status: status.value }),
    },
  }
}

function parseWakeInput(body: Record<string, unknown>): Parsed<WakeInput> {
  const from = requiredString(body, 'from')
  if (!from.ok) return from
  const to = requiredString(body, 'to')
  if (!to.ok) return to
  const prompt = requiredString(body, 'prompt')
  if (!prompt.ok) return prompt
  const url = requiredString(body, 'url')
  if (!url.ok) return url

  const rawAfter = body['afterMs']
  let afterMs: number | undefined
  if (rawAfter !== undefined && rawAfter !== null) {
    if (
      typeof rawAfter !== 'number' ||
      !Number.isFinite(rawAfter) ||
      rawAfter < 0
    ) {
      return { ok: false, message: '字段 afterMs 必须是非负数（毫秒）' }
    }
    afterMs = rawAfter
  }

  return {
    ok: true,
    value: {
      from: from.value,
      to: to.value,
      prompt: prompt.value,
      url: url.value,
      ...(afterMs === undefined ? {} : { afterMs }),
    },
  }
}

// --- HTML routes ---------------------------------------------------------

async function rosterFragment(deps: ConsoleDeps, now: number): Promise<string> {
  const result = await deps.registry.list()
  return renderRoster(
    valueOf(result),
    failureOf(result),
    now,
    deps.limits.registryTtlMs,
  )
}

async function auditFragment(
  deps: ConsoleDeps,
  filter: AuditFilter,
): Promise<string> {
  const result = await deps.audit.read(filter)
  return renderAudit(valueOf(result), failureOf(result), filter)
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
): Promise<string> {
  const [sessions, targets] = await Promise.all([
    chat.sessions(),
    chatTargets(chat),
  ])
  return renderChatSessions({
    sessions: sessions.ok ? sessions.value : [],
    targets: targets ?? [],
    failure: failureOf(sessions),
    activeId,
    now,
  })
}

/** The thread fragment plus the one bit the page around it needs. */
interface ChatThreadRender {
  readonly html: string
  /** True when a session really opened — what enables the composer. */
  readonly open: boolean
}

async function chatThreadFragment(
  chat: ChatPort,
  sessionId: string | null,
  now: number,
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

async function handleChatPage(
  deps: ConsoleDeps,
  chat: ChatPort,
  credential: ConsoleCredential,
  url: URL,
  now: number,
): Promise<Response> {
  const sessionId = textParam(url.searchParams, 'session') ?? null
  const [sessions, thread] = await Promise.all([
    chatSessionsFragment(chat, sessionId, now),
    chatThreadFragment(chat, sessionId, now),
  ])
  return html(
    renderChatPage({
      label: deps.label ?? DEFAULT_LABEL,
      now,
      sessions,
      thread: thread.html,
      composerEnabled: thread.open,
      role: credential.role,
    }),
  )
}

async function handleIndex(
  deps: ConsoleDeps,
  credential: ConsoleCredential,
  url: URL,
  now: number,
): Promise<Response> {
  const filter = parseAuditFilter(url)
  // Both panels are independent reads; a slow registry should not serialise
  // in front of the trail.
  const [roster, audit] = await Promise.all([
    rosterFragment(deps, now),
    auditFragment(deps, filter),
  ])
  return html(
    renderPage({
      label: deps.label ?? DEFAULT_LABEL,
      now,
      roster,
      audit,
      limits: renderLimits(deps.limits),
      // The form is rendered disabled with a reason rather than hidden: an
      // operator who cannot find the wake button assumes the console is broken.
      wakeEnabled: deps.wake !== undefined,
      // Gated on role, not merely on whether a channel is wired: the module
      // note above ("Chat is admin-only, all of it") says a view token must
      // not even learn that a conversation exists. A link that is present but
      // 403s on click leaks exactly that, so the nav item is hidden from
      // anyone who is not admin, channel or no channel.
      chatEnabled: deps.chat !== undefined && credential.role === 'admin',
      auditFilter: filter,
      // The sidebar states which of the two credentials this is, and offers the
      // way out of a cookie the page cannot read (`bits.ts`).
      role: credential.role,
    }),
  )
}

// --- JSON routes ---------------------------------------------------------

async function handleAgentsCollection(
  request: Request,
  deps: ConsoleDeps,
  credential: ConsoleCredential,
): Promise<Response> {
  if (request.method === 'GET') {
    const denied = guard(credential, 'view', 'guarded')
    if (denied !== null) return denied
    const result = await deps.registry.list()
    return result.ok
      ? json({ agents: result.value })
      : failureResponse(result.failure)
  }
  if (request.method === 'POST') {
    const denied = guard(credential, 'admin', 'guarded')
    if (denied !== null) return denied
    const body = await readJsonObject(request)
    if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
    const input = parseRegisterInput(body)
    if (!input.ok) return fail(400, 'invalid', input.message)
    const result = await deps.registry.register(input.value)
    // 200, not 201: the port answers with the record either way and cannot say
    // whether this address was new, so claiming "created" would be a guess.
    return result.ok ? json(result.value) : failureResponse(result.failure)
  }
  const denied = guard(credential, 'view', 'guarded')
  if (denied !== null) return denied
  return methodNotAllowed(['GET', 'POST'])
}

async function handleAgentItem(
  request: Request,
  deps: ConsoleDeps,
  credential: ConsoleCredential,
  address: string,
): Promise<Response> {
  const denied = guard(credential, 'admin', 'guarded')
  if (denied !== null) return denied
  if (request.method !== 'DELETE') return methodNotAllowed(['DELETE'])
  const result = await deps.registry.deregister(address)
  return result.ok
    ? new Response(null, { status: 204 })
    : failureResponse(result.failure)
}

async function handleHeartbeat(
  request: Request,
  deps: ConsoleDeps,
  credential: ConsoleCredential,
  address: string,
): Promise<Response> {
  const denied = guard(credential, 'admin', 'guarded')
  if (denied !== null) return denied
  if (request.method !== 'POST') return methodNotAllowed(['POST'])
  const result = await deps.registry.heartbeat(address)
  return result.ok ? json(result.value) : failureResponse(result.failure)
}

async function handleWake(
  request: Request,
  deps: ConsoleDeps,
  credential: ConsoleCredential,
): Promise<Response> {
  const denied = guard(credential, 'admin', 'guarded')
  if (denied !== null) return denied
  if (request.method !== 'POST') return methodNotAllowed(['POST'])
  const wake = deps.wake
  if (wake === undefined) {
    return fail(
      501,
      'unsupported',
      '该控制台没有配置唤醒通道（缺少传输层 PSK），因此不能发起唤醒；' +
        '请在启动 occ console 时提供 PSK 后重试。',
    )
  }
  const body = await readJsonObject(request)
  if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
  const input = parseWakeInput(body)
  if (!input.ok) return fail(400, 'invalid', input.message)
  const result = await wake.send(input.value)
  return result.ok ? json(result.value) : failureResponse(result.failure)
}

async function handleAudit(
  request: Request,
  deps: ConsoleDeps,
  credential: ConsoleCredential,
  url: URL,
): Promise<Response> {
  const denied = guard(credential, 'view', 'guarded')
  if (denied !== null) return denied
  if (request.method !== 'GET') return methodNotAllowed(['GET'])
  const result = await deps.audit.read(parseAuditFilter(url))
  return result.ok ? json(result.value) : failureResponse(result.failure)
}

async function handleChain(
  request: Request,
  deps: ConsoleDeps,
  credential: ConsoleCredential,
  traceId: string,
): Promise<Response> {
  const denied = guard(credential, 'view', 'guarded')
  if (denied !== null) return denied
  if (request.method !== 'GET') return methodNotAllowed(['GET'])
  const result = await deps.audit.chain(traceId)
  // A trace with no records is `{ chain: null }` and a 200: "that trace is not
  // in this trail" is an answer, not a failure of the lookup.
  return result.ok
    ? json({ chain: result.value })
    : failureResponse(result.failure)
}

// --- chat ----------------------------------------------------------------

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
function chatStream(chat: ChatPort): Response {
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null

  const release = (): void => {
    unsubscribe?.()
    unsubscribe = null
    if (heartbeat !== null) clearInterval(heartbeat)
    heartbeat = null
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
      // A comment first: it completes the response headers immediately, so the
      // browser fires `open` rather than sitting in `CONNECTING` until the
      // first real event, which may be minutes away.
      push(`retry: ${CHAT_STREAM_RETRY_MS}\n: open\n\n`)
      unsubscribe = chat.subscribe((update: ChatUpdate) => {
        push(`event: chat\ndata: ${JSON.stringify(update)}\n\n`)
      })
      heartbeat = setInterval(
        () => push(': keep-alive\n\n'),
        CHAT_STREAM_HEARTBEAT_MS,
      )
      heartbeat.unref?.()
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
): Promise<Response> {
  if (request.method === 'GET') {
    const result = await chat.sessions()
    return result.ok
      ? json({ sessions: result.value })
      : failureResponse(result.failure)
  }
  if (request.method === 'POST') {
    const body = await readJsonObject(request)
    if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
    const target = requiredString(body, 'target')
    if (!target.ok) return fail(400, 'invalid', target.message)
    const result = await chat.open(target.value)
    return result.ok ? json(result.value) : failureResponse(result.failure)
  }
  return methodNotAllowed(['GET', 'POST'])
}

async function dispatchChatApi(
  request: Request,
  deps: ConsoleDeps,
  credential: ConsoleCredential,
  url: URL,
  segments: readonly string[],
): Promise<Response> {
  const name = segments[2]
  // The stream is the one route here an `EventSource` opens, and an
  // `EventSource` cannot send the console header any more than a navigation
  // can — so it is classed `stream` rather than `guarded` and leans on
  // `Sec-Fetch-Site` instead. See the module note.
  const protection: Protection =
    name === 'stream' && segments.length === 3 ? 'stream' : 'guarded'
  // Admin before existence: an anonymous caller must not learn which consoles
  // have a chat channel wired by comparing 401 against 501.
  const denied = guard(credential, 'admin', protection)
  if (denied !== null) return denied
  const chat = deps.chat
  if (chat === undefined) return chatUnsupported()

  if (name === 'targets' && segments.length === 3) {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    const result = await chat.targets()
    return result.ok
      ? json({ targets: result.value })
      : failureResponse(result.failure)
  }

  if (name === 'stream' && segments.length === 3) {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return chatStream(chat)
  }

  if (name === 'sessions') {
    if (segments.length === 3) return await handleChatSessions(request, chat)
    const sessionId = decodeURIComponent(segments[3] ?? '')
    if (segments.length === 4) {
      if (request.method !== 'GET') return methodNotAllowed(['GET'])
      const result = await chat.transcript(sessionId)
      return result.ok ? json(result.value) : failureResponse(result.failure)
    }
    if (segments.length === 5 && segments[4] === 'messages') {
      if (request.method !== 'POST') return methodNotAllowed(['POST'])
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

// --- dispatch ------------------------------------------------------------

async function dispatchApi(
  request: Request,
  deps: ConsoleDeps,
  credential: ConsoleCredential,
  url: URL,
  segments: readonly string[],
): Promise<Response> {
  const head = segments[1]

  if (head === 'health' && segments.length === 2) {
    // Public: a liveness probe that needs a credential is a probe nobody wires.
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return json({ status: 'ok' })
  }

  if (head === 'limits' && segments.length === 2) {
    const denied = guard(credential, 'view', 'guarded')
    if (denied !== null) return denied
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return json(deps.limits)
  }

  if (head === 'wake' && segments.length === 2) {
    return await handleWake(request, deps, credential)
  }

  if (head === 'chat' && segments.length >= 3) {
    return await dispatchChatApi(request, deps, credential, url, segments)
  }

  if (head === 'audit') {
    if (segments.length === 2)
      return await handleAudit(request, deps, credential, url)
    if (segments.length === 4 && segments[2] === 'chain') {
      return await handleChain(
        request,
        deps,
        credential,
        decodeURIComponent(segments[3] ?? ''),
      )
    }
    return notFound(`unknown path: ${url.pathname}`)
  }

  if (head === 'agents') {
    if (segments.length === 2) {
      return await handleAgentsCollection(request, deps, credential)
    }
    const address = decodeURIComponent(segments[2] ?? '')
    if (segments.length === 3) {
      return await handleAgentItem(request, deps, credential, address)
    }
    if (segments.length === 4 && segments[3] === 'heartbeat') {
      return await handleHeartbeat(request, deps, credential, address)
    }
    return notFound(`unknown path: ${url.pathname}`)
  }

  return notFound(`unknown path: ${url.pathname}`)
}

async function chainFragment(
  deps: ConsoleDeps,
  traceId: string,
): Promise<string> {
  const result = await deps.audit.chain(traceId)
  // `renderChain` takes no failure argument — a chain either reconstructs or
  // it does not — so an unreadable trail borrows the same red strip the other
  // two fragments show. Answering this route with JSON instead would hand the
  // client something it cannot put in the DOM.
  return result.ok
    ? renderChain(result.value)
    : failureBar(result.failure, '读取消息链失败')
}

async function dispatchFragment(
  request: Request,
  deps: ConsoleDeps,
  credential: ConsoleCredential,
  url: URL,
  segments: readonly string[],
  now: number,
): Promise<Response> {
  const name = segments[1] ?? ''
  const isChain = name === 'chain' && segments.length === 3

  // The two chat fragments take the admin path in full — see the module note
  // on why the chat face has no read-only tier.
  if (name === 'chat') {
    const deniedAdmin = guard(credential, 'admin', 'guarded')
    if (deniedAdmin !== null) return deniedAdmin
    const chat = deps.chat
    if (chat === undefined) return chatUnsupported()
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    if (segments[2] === 'sessions' && segments.length === 3) {
      const active = textParam(url.searchParams, 'active') ?? null
      return html(await chatSessionsFragment(chat, active, now))
    }
    if (segments[2] === 'thread' && segments.length === 4) {
      const sessionId = decodeURIComponent(segments[3] ?? '')
      return html((await chatThreadFragment(chat, sessionId, now)).html)
    }
    return notFound(`unknown path: ${url.pathname}`)
  }

  if (
    !isChain &&
    (segments.length !== 2 ||
      (name !== 'roster' && name !== 'audit' && name !== 'limits'))
  ) {
    return notFound(`unknown path: ${url.pathname}`)
  }
  const denied = guard(credential, 'view', 'guarded')
  if (denied !== null) return denied
  if (request.method !== 'GET') return methodNotAllowed(['GET'])
  if (isChain) {
    return html(
      await chainFragment(deps, decodeURIComponent(segments[2] ?? '')),
    )
  }
  if (name === 'roster') return html(await rosterFragment(deps, now))
  if (name === 'audit') {
    return html(await auditFragment(deps, parseAuditFilter(url)))
  }
  return html(renderLimits(deps.limits))
}

async function route(
  request: Request,
  deps: ConsoleDeps,
  tokens: ConsoleTokens,
  throttle: LoginThrottle,
  clientKey: string,
  now: () => number,
): Promise<Response> {
  const url = new URL(request.url)
  const segments = url.pathname.split('/').filter(s => s.length > 0)

  // Public, and deliberately checked before any credential: see the module
  // note on why the two assets are not gated.
  if (segments[0] === 'assets' && segments.length === 2) {
    if (segments[1] !== 'app.css' && segments[1] !== 'app.js') {
      return notFound(`unknown path: ${url.pathname}`)
    }
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return segments[1] === 'app.css'
      ? asset(CONSOLE_CSS, 'text/css; charset=utf-8')
      : asset(CONSOLE_CLIENT_JS, 'text/javascript; charset=utf-8')
  }

  const credential = credentialOf(request, tokens)

  // The door, and the way back out of it. Both public: a login page that needs
  // a credential is a login page nobody can reach, and a logout that needs one
  // strands whoever's token was rotated while their tab was open.
  if (segments[0] === 'login' && segments.length === 1) {
    return await handleLogin(
      request,
      deps,
      tokens,
      credential,
      throttle,
      url,
      clientKey,
      now(),
    )
  }

  if (segments[0] === 'logout' && segments.length === 1) {
    return handleLogout(request)
  }

  if (segments.length === 0) {
    const denied = guard(credential, 'view', 'document')
    if (denied !== null) return documentDenial(request, denied, deps, url)
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return await handleIndex(deps, credential, url, now())
  }

  if (segments[0] === 'chat' && segments.length === 1) {
    const denied = guard(credential, 'admin', 'document')
    if (denied !== null) return documentDenial(request, denied, deps, url)
    const chat = deps.chat
    // 404 rather than 501: this is a page, and on this instance there is no
    // such page. A script asking `/v0/chat/*` gets the 501 instead.
    if (chat === undefined) return notFound(`unknown path: ${url.pathname}`)
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return await handleChatPage(deps, chat, credential, url, now())
  }

  if (segments[0] === 'v0') {
    return await dispatchApi(request, deps, credential, url, segments)
  }

  if (segments[0] === 'fragments' && segments.length >= 2) {
    return await dispatchFragment(
      request,
      deps,
      credential,
      url,
      segments,
      now(),
    )
  }

  return notFound(`unknown path: ${url.pathname}`)
}

/**
 * Just enough of `Bun.Server` to key the login throttle.
 *
 * Declared here rather than imported so this package keeps compiling — and
 * testing — without a Bun type in the signature: `Bun.serve` hands its `fetch`
 * a server that satisfies this structurally, and a test hands it nothing.
 */
export interface ClientAddressSource {
  requestIP(request: Request): { readonly address: string } | null
}

/**
 * Who the login throttle counts against.
 *
 * The peer address of the socket, and deliberately **not** `X-Forwarded-For`:
 * on a directly-reached console that header is written by the caller, so
 * trusting it would hand every attacker a fresh bucket per attempt. Behind a
 * reverse proxy every caller therefore shares one key — see `throttle.ts` on
 * why that is accepted. An address this layer cannot see falls back to a single
 * shared bucket rather than to no throttling at all.
 */
function clientKeyOf(request: Request, source?: ClientAddressSource): string {
  const address = source?.requestIP(request)?.address ?? ''
  return address === '' ? 'unknown' : address
}

/**
 * Build the console's request handler.
 *
 * Exposed separately from {@link startConsoleServer} so every route can be
 * driven with a plain `Request` — no port, no teardown, no timing. The second
 * parameter is what `Bun.serve` passes its `fetch`; it is optional so a test
 * can keep calling `handle(request)` with one argument.
 *
 * The login throttle is created here, once per console instance rather than
 * once per module: two consoles in one process (which is what the test suite
 * is) must not be able to lock each other out.
 */
export function createConsoleHandler(
  deps: ConsoleDeps,
  tokens: ConsoleTokens,
): (request: Request, source?: ClientAddressSource) => Promise<Response> {
  const now = deps.now ?? Date.now
  const throttle = new LoginThrottle()
  return async (
    request: Request,
    source?: ClientAddressSource,
  ): Promise<Response> => {
    try {
      return await route(
        request,
        deps,
        tokens,
        throttle,
        clientKeyOf(request, source),
        now,
      )
    } catch (error) {
      // Only reachable when a port breaks its contract and throws. The message
      // is included because the ports are ours and a silent 500 on a
      // loopback tool costs an hour; ports must therefore keep credentials out
      // of their error messages.
      const message = error instanceof Error ? error.message : String(error)
      return fail(500, 'internal', `控制台内部错误：${message}`)
    }
  }
}

export interface ConsoleServerOptions {
  /** Bind address. Loopback by default — see `auth.ts` on what else costs. */
  readonly hostname?: string
  /** The pair from `resolveTokens`. Required: there is no anonymous console. */
  readonly tokens: ConsoleTokens
}

/** Live server handle returned by {@link startConsoleServer}. */
export interface ConsoleServerHandle {
  /** Port actually bound — meaningful when starting on port `0`. */
  readonly port: number
  /** Base URL, without a trailing slash and **without** the token. */
  readonly url: string
  stop(): Promise<void>
}

/**
 * Start the console. Pass `0` (the default) to let the OS pick a free port and
 * read the real one back from the handle.
 *
 * `options` is required even though `port` has a default — the tokens have no
 * safe default, so a caller that wants an ephemeral port writes
 * `startConsoleServer(deps, undefined, { tokens })`.
 */
export function startConsoleServer(
  deps: ConsoleDeps,
  port = 0,
  options: ConsoleServerOptions,
): ConsoleServerHandle {
  const hostname = options.hostname ?? '127.0.0.1'
  const server = Bun.serve({
    port,
    hostname,
    // Derived from the heartbeat rather than picked, and that is the whole
    // point: `Bun.serve` defaults to a 10 s idle timeout and closes any
    // connection that has said nothing for that long. A 15 s heartbeat under a
    // 10 s timeout means the chat stream is killed every ten seconds — measured
    // on Bun 1.3.13, the browser reports `ERR_INCOMPLETE_CHUNKED_ENCODING` and
    // redials, so the page keeps working and nothing looks broken except a
    // console full of errors and a reconnect storm. Writing the relationship
    // down as arithmetic is what stops the two numbers drifting apart again.
    idleTimeout: Math.min(
      255,
      Math.ceil((CHAT_STREAM_HEARTBEAT_MS / 1_000) * 2),
    ),
    fetch: createConsoleHandler(deps, options.tokens),
  })

  return {
    // Bun types `Server.port` as `number | undefined` because unix-socket
    // servers have no port. This server always binds TCP, so it is a number.
    port: server.port as number,
    url: `http://${hostname}:${server.port}`,
    stop: async (): Promise<void> => {
      await server.stop(true)
    },
  }
}
