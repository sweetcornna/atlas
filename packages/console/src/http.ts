// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

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
 * | GET | `/v0/servers` | view | `{ servers }`, or 501 without a mapping |
 * | PUT | `/v0/servers/<enc server>/note` | admin | the stored `ServerNote` |
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
 * | GET, POST | `/invite` | public | accounts only — see `accountsHttp.ts` |
 * | * | `/v0/accounts/…` | admin | accounts only — see `accountsHttp.ts` |
 *
 * The last two rows exist only on a console handed an `AccountBook`; without
 * one they are the plain 404 they always were.
 *
 * ## Where the handlers live
 *
 * Each area of the console owns its handlers in `routes/` — its page, the
 * `/v0/<head>` heads and the `/fragments/<head>` heads it answers (the contract
 * is `routes/types.ts`, the table `routes/index.ts`). This file keeps what is
 * not an area: the credential plumbing, the login and invitation doors, the
 * account API, `/v0/health`, the two assets and the last-resort 500. The
 * guards every handler calls are in `routes/shared.ts`.
 *
 * ## With personal accounts
 *
 * A console started with {@link ConsoleServerOptions.accounts} reads every
 * request through `access.ts` instead of `credentialOf`, and the table above
 * changes in exactly these places (`tenancy-m1.md` §3.2–§3.4):
 *
 * - `ops` is read as admin and `viewer` / `member` as view, so every row keeps
 *   its role column; a session cookie is read as a cookie, so the three
 *   protection classes below apply to it unchanged.
 * - The chat rows admit a `member` as well as admin, **scoped to the sessions
 *   that member opened**: lists are filtered, and another person's session
 *   answers the same 404 as one that does not exist, before the port is asked.
 *   `viewer` and the view token still cannot see that a conversation exists.
 *   The stream carries only the caller's sessions and ends when the account
 *   is revoked or reset, its session expires, or the book closes.
 * - `/login` also takes a personal credential and answers with a server
 *   session; `/logout` also ends that session on the server.
 * - A personal credential in `?token=` is refused with a 400 on every route;
 *   in break-glass mode the admin token works only as a Bearer, every page it
 *   opens carries a lit notice, and every response to it the
 *   `x-qianmo-break-glass` header.
 * - The page scripts are the variants that never keep a personal credential
 *   in `localStorage` (`assets/client.ts`).
 *
 * Without accounts none of this runs, and `test/legacyParity.test.ts` pins
 * that the answers are byte for byte what they were.
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
 * ## A server id is chosen from the startup list, never supplied
 *
 * `PUT /v0/servers/<id>/note` looks the id up in `deps.nodeServers` before it
 * reads the body, and answers 403 when it is not there. This is the same rule
 * `handleWake` applies to a wake target and it is there for the same reason: the
 * set of things this console will act on is fixed when it starts, so a caller
 * holding the admin token cannot grow it by typing into the page. Without the
 * check, a note route would be an arbitrary key-value store that anyone with
 * that token could fill up.
 *
 * A console started without any `--node-server` answers 501 on both routes
 * rather than 200 with an empty list: "this console was not told where anything
 * runs" and "nothing runs anywhere" are different facts.
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

import {
  adminFingerprint,
  resolveAccess,
  subjectOf,
  type Access,
  type AccessRefusal,
  type ConsoleAccounts,
} from './access.js'
import { assertTokensUnlikeAccountSecrets } from './accounts.js'
import {
  accountLogin,
  accountLogout,
  handleAccountsApi,
  handleInvite,
  pageViewer,
} from './accountsHttp.js'
import {
  CONSOLE_CLIENT_JS,
  CONSOLE_CLIENT_JS_ACCOUNTS,
} from './assets/client.js'
import { CONSOLE_CSS } from './assets/css.js'
import {
  LOGIN_PATH,
  SESSION_MAX_AGE_SECONDS,
  TOKEN_QUERY_PARAM,
  clearedSessionCookieHeader,
  isCrossOriginRequest,
  isSecureRequest,
  presentedCredentialOf,
  roleOfToken,
  safeRedirect,
  sessionCookieHeader,
  type ConsoleCredential,
  type ConsoleTokens,
} from './auth.js'
import type { ActionOutcome, ConsoleAction, ConsoleDeps } from './deps.js'
import {
  asset,
  compressed,
  documentHeaders,
  fail,
  html,
  json,
  methodNotAllowed,
  notFound,
  readForm,
  seeOther,
} from './respond.js'
import { CHAT_STREAM_HEARTBEAT_MS } from './routes/chat.js'
import {
  ROUTES,
  areaDocument,
  errorDocument,
  headIndex,
  pageOf,
  type PageMatch,
} from './routes/index.js'
import { DEFAULT_LABEL, guard, guardChat, loginHref } from './routes/shared.js'
import type { ConsoleActionName, RouteContext } from './routes/types.js'
import type { PageViewer } from './view/bits.js'
import { renderLoginPage } from './view/login.js'
import { renderStandalone } from './view/shell.js'
import { LoginThrottle } from './throttle.js'

/** Prefix of every JSON route in this API version. */
export const API_PREFIX = '/v0'

export { MAX_AUDIT_LIMIT, parseAuditFilter } from './routes/audit.js'
export { CHAT_STREAM_HEARTBEAT_MS } from './routes/chat.js'

/**
 * The same fact for the login card, in the page's own register.
 *
 * Deliberately not the string above: everything the console renders keeps to
 * one clause and no full stop (`view/page.ts`, and the copy gates in
 * `test/view.test.ts`), while an error *body* is read by a developer and may
 * spend a sentence saying what to do.
 */
const ADMIN_REQUIRED_LINE = '该页面需要管理令牌'

/** What a failed login is told. Never which half of the pair was close. */
const LOGIN_REFUSED = '令牌无效'

/** The same, on the login card. */
const CHAT_MEMBER_REQUIRED_LINE = '该页面需要成员或运维账号'

// --- the login door ------------------------------------------------------

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
  return seeOther(loginHref(url))
}

/** The login document, at whatever status the reason calls for. */
function loginPage(
  deps: ConsoleDeps,
  options: {
    readonly redirect: string
    readonly status?: number
    readonly error?: string
    readonly headers?: Record<string, string>
    /** A console with accounts: the field takes a personal credential too. */
    readonly accounts?: boolean
  },
): Response {
  const body = renderLoginPage({
    label: deps.label ?? DEFAULT_LABEL,
    redirect: options.redirect,
    ...(options.error === undefined ? {} : { error: options.error }),
    ...(options.accounts === true ? { accounts: true } : {}),
  })
  return new Response(body, {
    status: options.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...documentHeaders(body),
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
  access?: Access,
): Response {
  if (!wantsHtml(request)) return denied
  if (denied.status === 401) return loginRedirect(url)
  if (denied.status === 403) {
    const back = new URL(url.toString())
    back.searchParams.delete(TOKEN_QUERY_PARAM)
    const person = access?.principal?.kind === 'user'
    return loginPage(deps, {
      redirect: safeRedirect(`${back.pathname}${back.search}`),
      status: 403,
      error: person ? CHAT_MEMBER_REQUIRED_LINE : ADMIN_REQUIRED_LINE,
      ...(access === undefined ? {} : { accounts: true }),
    })
  }
  return denied
}

/**
 * A request the account rules refused before any route saw it
 * (`access.ts`): the JSON a script can act on, or the login card with the
 * reason for a browser.
 */
function accessRefused(
  request: Request,
  refusal: AccessRefusal,
  deps: ConsoleDeps,
  url: URL,
): Response {
  if (!wantsHtml(request)) {
    return fail(refusal.status, refusal.code, refusal.message)
  }
  const back = new URL(url.toString())
  back.searchParams.delete(TOKEN_QUERY_PARAM)
  return loginPage(deps, {
    redirect: safeRedirect(`${back.pathname}${back.search}`),
    status: refusal.status,
    error: refusal.line,
    accounts: true,
  })
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
  accounts: ConsoleAccounts | undefined,
): Promise<Response> {
  const asked = safeRedirect(url.searchParams.get('redirect'))
  const accountsOn = accounts !== undefined

  if (request.method === 'GET') {
    // Already carrying a credential: there is nothing to fill in. The console
    // itself is the honest answer, not a form that would refuse to appear.
    if (credential.role !== 'none') return seeOther(asked)
    return loginPage(deps, {
      redirect: asked,
      ...(accountsOn ? { accounts: true } : {}),
    })
  }
  if (request.method !== 'POST') return methodNotAllowed(['GET', 'POST'])

  if (isCrossOriginRequest(request)) {
    return fail(403, 'forbidden', '登录只接受来自本控制台自己页面的提交。')
  }

  const form = await readForm(request)
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
      ...(accountsOn ? { accounts: true } : {}),
    })
  }

  const presented = (form.get('token') ?? '').trim()
  if (accounts !== undefined) {
    return accountLogin(request, presented, target, {
      accounts,
      tokens,
      throttle,
      clientKey,
      now,
      card: (status, error) =>
        loginPage(deps, { redirect: target, status, error, accounts: true }),
    })
  }
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
function handleLogout(
  request: Request,
  accounts: ConsoleAccounts | undefined,
): Response {
  if (request.method !== 'POST') return methodNotAllowed(['POST'])
  if (isCrossOriginRequest(request)) {
    return fail(403, 'forbidden', '退出只接受来自本控制台自己页面的提交。')
  }
  if (accounts !== undefined) return accountLogout(request, accounts)
  return seeOther(LOGIN_PATH, {
    'set-cookie': clearedSessionCookieHeader({
      secure: isSecureRequest(request),
    }),
  })
}

// --- pages ---------------------------------------------------------------

/**
 * One area page: the guard its module names, then whether the page exists on
 * this console, then the method, then the render — the order `/` and `/chat`
 * have always kept (`test/legacyParity.test.ts`). The module returns its own
 * part; the frame around it is `routes/index.ts`'s.
 */
async function servePage(
  ctx: RouteContext,
  match: PageMatch,
  denial: Access | undefined,
): Promise<Response> {
  const { request, deps, url, access } = ctx
  const denied =
    match.page.guard === 'chat'
      ? guardChat(access, 'document')
      : guard(access.credential, 'view', 'document')
  if (denied !== null) {
    return documentDenial(request, denied, deps, url, denial)
  }
  if (match.page.available?.(ctx) === false) {
    return notFound(`unknown path: ${url.pathname}`)
  }
  if (request.method !== 'GET') return methodNotAllowed(['GET'])
  const rendered = await match.page.render(ctx, match.rest)
  if (rendered instanceof Response) return rendered
  return html(
    await areaDocument(ctx, match.module, rendered),
    rendered.status ?? 200,
  )
}

/**
 * A token that arrived in the address bar becomes a session, once (H5).
 *
 * The banner's link carries `?token=` because a URL is the one thing a
 * terminal can hand a browser. Answering it with the page left the token in
 * the address bar until the runtime scrubbed it, and on every in-console link
 * the runtime then signed with it — so in every proxy log and history entry
 * after it. Instead the navigation is answered the way `POST /login` answers:
 * a 303 to the same address without the token, setting the session cookie.
 * Every navigation after it rides the cookie; `?token=` keeps its two other
 * jobs, a JSON route for a script and this first step.
 *
 * Only a token that is one of the pair is exchanged — never on the strength
 * of a cookie beside a stale one — and only without accounts: there a
 * personal credential in a link is refused outright, and the login door is
 * the way in (`accountsHttp.ts`).
 */
function tokenInAddressBar(
  request: Request,
  url: URL,
  tokens: ConsoleTokens,
): Response | null {
  if (request.method !== 'GET' || !wantsHtml(request)) return null
  const presented = presentedCredentialOf(request)
  if (presented.source !== 'query') return null
  if (roleOfToken(presented.token, tokens) === 'none') return null
  const rest = new URLSearchParams(url.searchParams)
  rest.delete(TOKEN_QUERY_PARAM)
  const query = rest.toString()
  return seeOther(
    safeRedirect(url.pathname + (query === '' ? '' : `?${query}`)),
    {
      'set-cookie': sessionCookieHeader(presented.token, {
        secure: isSecureRequest(request),
        maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
      }),
    },
  )
}

/**
 * The context one request hands its route module. The roster is read at most
 * once, however many of the page's parts ask for it.
 */
function routeContext(
  request: Request,
  url: URL,
  deps: ConsoleDeps,
  access: Access,
  accounts: ConsoleAccounts | undefined,
  now: number,
  viewer: PageViewer | undefined,
  ledger: RequestLedger,
): RouteContext {
  let roster: ReturnType<RouteContext['roster']> | undefined
  return {
    request,
    url,
    deps,
    access,
    accounts,
    now,
    viewer,
    roster: () => {
      roster ??= deps.registry.list()
      return roster
    },
    requestId: ledger.requestId,
    admit: ledger.admit,
    record: ledger.record,
  }
}

// --- the action ledger ---------------------------------------------------

/** One request's two hooks into the action ledger (`deps.ts`, P15.9). */
interface RequestLedger {
  readonly requestId: string
  readonly admit: RouteContext['admit']
  readonly record: RouteContext['record']
}

/** What a write is told when the ledger cannot take its entry. */
const LEDGER_CLOSED =
  '操作记录暂时写不进去，写操作已暂停；恢复动作账本之后再试。'

/** A finished response as a ledger outcome, for routes that only have a status. */
function outcomeOfStatus(status: number): readonly [ActionOutcome, string?] {
  if (status < 400) return ['ok']
  return status >= 500
    ? ['failed', `http_${status}`]
    : ['refused', `http_${status}`]
}

/**
 * The ledger hooks for one request. Every entry it writes carries the same
 * request id, the subject the credential resolved to and the break-glass
 * mark; a console without `deps.actions` gets hooks that do nothing.
 */
function requestLedger(
  deps: ConsoleDeps,
  access: Access,
  now: () => number,
): RequestLedger {
  const port = deps.actions
  const requestId = crypto.randomUUID()
  return {
    requestId,
    async admit() {
      if (port?.admit === undefined) return null
      try {
        const verdict = await port.admit()
        if (verdict.ok) return null
      } catch {
        // A ledger that throws is a ledger that cannot write: same answer.
      }
      return fail(503, 'unavailable', LEDGER_CLOSED)
    },
    async record(
      action: ConsoleActionName,
      target: string,
      outcome: ActionOutcome,
      code?: string,
    ) {
      if (port === undefined) return true
      const entry: ConsoleAction = {
        at: now(),
        requestId,
        subject: subjectOf(access),
        ...(access.breakGlass ? { breakGlass: true as const } : {}),
        action,
        target,
        outcome,
        ...(code === undefined ? {} : { code }),
      }
      try {
        return (await port.record(entry)).ok
      } catch {
        // Never fails the request: the action already happened (see
        // `RouteContext.record`), and `admit` is where a write is stopped.
        return false
      }
    },
  }
}

/** The account API's writes, by method, as ledger verbs. */
const ACCOUNT_WRITES: Readonly<Record<string, ConsoleActionName>> = {
  POST: 'accounts.post',
  PUT: 'accounts.put',
  PATCH: 'accounts.patch',
  DELETE: 'accounts.delete',
}

// --- HTML error pages (C3) ------------------------------------------------

/** First segments whose answers are data for a script, never a page. */
const DATA_HEADS: readonly string[] = ['v0', 'fragments', 'assets']

interface ErrorCopy {
  readonly title: string
  readonly line: string
}

/** The errors a navigating browser is shown as a page, and what it says. */
const ERROR_PAGES: Readonly<Record<number, ErrorCopy>> = {
  404: {
    title: '页面不存在',
    line: '这个地址在这台控制台上没有页面 · 从导航进入',
  },
  405: { title: '不支持这个请求', line: '这个地址只接受页面读取' },
  500: {
    title: '控制台内部错误',
    line: '这次请求没有完成 · 刷新重试 · 反复出现请查看控制台日志',
  },
  501: { title: '此功能未接入', line: '这台控制台启动时没有配置这项功能' },
  503: { title: '暂时不可用', line: '这次请求没有完成 · 稍后刷新重试' },
}

/**
 * True when `response` is a JSON error that a person navigating — not a
 * script calling — would otherwise be handed raw (C3).
 *
 * The judgement is the one `documentDenial` already makes (`wantsHtml`), on
 * the paths that are pages: `/v0`, `/fragments` and `/assets` answer scripts
 * and keep their JSON whatever the `Accept`, because a poller that gets a
 * page instead of the error it can parse has been lied to.
 */
function pageWorthy(
  request: Request,
  segments: readonly string[],
  response: Response,
): boolean {
  if (!wantsHtml(request)) return false
  const head = segments[0]
  if (head !== undefined && DATA_HEADS.includes(head)) return false
  if (ERROR_PAGES[response.status] === undefined) return false
  return (response.headers.get('content-type') ?? '').startsWith(
    'application/json',
  )
}

/**
 * The page for a JSON error a browser navigated into, at the same status.
 *
 * Drawn in the shell for a signed-in caller, so the way on is the same
 * sidebar as everywhere else; on the login panel for anybody else, so the
 * sidebar is never drawn for a caller who has not shown a credential.
 */
async function errorPage(
  response: Response,
  deps: ConsoleDeps,
  access: Access,
  context: () => RouteContext,
): Promise<Response> {
  const copy = ERROR_PAGES[response.status] ?? ERROR_PAGES[404]
  const title = copy?.title ?? ''
  const line = copy?.line ?? ''
  const signedIn = access.refusal === null && access.credential.role !== 'none'
  const page = html(
    signedIn
      ? await errorDocument(context(), title, line)
      : renderStandalone({
          label: deps.label ?? DEFAULT_LABEL,
          title,
          line,
          link: { href: LOGIN_PATH, label: '去登录' },
        }),
    response.status,
  )
  const allow = response.headers.get('allow')
  if (allow !== null) page.headers.set('allow', allow)
  return page
}

// --- dispatch ------------------------------------------------------------

/** `/v0/<head>` heads, one module each; built once, refused if claimed twice. */
const API_HEADS = headIndex(ROUTES, module => module.api, [
  'accounts',
  'health',
])

/** `/fragments/<head>` heads, one module each. */
const FRAGMENT_HEADS = headIndex(ROUTES, module => module.fragments)

async function dispatchApi(
  ctx: RouteContext,
  segments: readonly string[],
): Promise<Response> {
  const { request, access, accounts, url } = ctx
  const head = segments[1]
  const credential = access.credential

  // Only when accounts are on: without a book this path is the plain 404 it
  // has always been (`test/legacyParity.test.ts`). `ops` reads as admin, so
  // the guard is the one every admin route uses; the ledger names the person,
  // or `legacy:admin` for the token.
  if (head === 'accounts' && accounts !== undefined) {
    const denied = guard(credential, 'admin', 'guarded')
    if (denied !== null) return denied
    const principal = access.principal
    const write = ACCOUNT_WRITES[request.method]
    if (write !== undefined) {
      const blocked = await ctx.admit()
      if (blocked !== null) return blocked
    }
    const response = await handleAccountsApi(
      request,
      accounts.book,
      principal?.kind === 'user' ? principal.subject : 'legacy:admin',
      segments,
      url,
    )
    if (write !== undefined) {
      await ctx.record(
        write,
        url.pathname.slice('/v0/accounts'.length) || '/',
        ...outcomeOfStatus(response.status),
      )
    }
    return response
  }

  if (head === 'health' && segments.length === 2) {
    // Public: a liveness probe that needs a credential is a probe nobody wires.
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return json({ status: 'ok' })
  }

  const owner = head === undefined ? undefined : API_HEADS.get(head)
  if (owner !== undefined && head !== undefined) {
    return await owner.handle(ctx, head, segments.slice(2))
  }
  return notFound(`unknown path: ${url.pathname}`)
}

async function dispatchFragment(
  ctx: RouteContext,
  segments: readonly string[],
): Promise<Response> {
  const name = segments[1] ?? ''
  const owner = FRAGMENT_HEADS.get(name)
  if (owner !== undefined) {
    return await owner.handle(ctx, name, segments.slice(2))
  }
  return notFound(`unknown path: ${ctx.url.pathname}`)
}

/**
 * Set on every response to a request made with the admin token in
 * break-glass (§3.4 ②), so a script's own logs show it too, not only the page.
 */
const BREAK_GLASS_HEADER = 'x-qianmo-break-glass'

async function route(
  request: Request,
  deps: ConsoleDeps,
  tokens: ConsoleTokens,
  throttle: LoginThrottle,
  clientKey: string,
  now: () => number,
  accounts: ConsoleAccounts | undefined,
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
      ? asset(request, CONSOLE_CSS, 'text/css; charset=utf-8')
      : asset(
          request,
          accounts === undefined
            ? CONSOLE_CLIENT_JS
            : CONSOLE_CLIENT_JS_ACCOUNTS,
          'text/javascript; charset=utf-8',
        )
  }

  // Without accounts this is `credentialOf` and nothing else (`access.ts`).
  const access = resolveAccess(request, tokens, accounts)
  const ledger = requestLedger(deps, access, now)
  const breakGlass = access.breakGlass && accounts !== undefined
  if (breakGlass) {
    // Recorded before the route runs, so a request that fails still counts
    // as a use; never refused for failing to record
    // (`AccountBook.recordBreakGlass`).
    accounts.book.recordBreakGlass(
      adminFingerprint(tokens),
      request.method,
      url.pathname,
    )
  }
  const answered = await routeAs(
    request,
    deps,
    tokens,
    throttle,
    clientKey,
    now,
    accounts,
    access,
    url,
    segments,
    ledger,
  )
  const response = pageWorthy(request, segments, answered)
    ? await errorPage(answered, deps, access, () =>
        routeContext(
          request,
          url,
          deps,
          access,
          accounts,
          now(),
          accounts === undefined
            ? undefined
            : pageViewer(access, accounts, tokens),
          ledger,
        ),
      )
    : answered
  if (!breakGlass) return response
  // Every request, reads included, one entry each (P15.9): the account
  // book's own record above keeps reads to one per ten minutes, the action
  // ledger does not.
  await ledger.record(
    'breakglass.request',
    `${request.method} ${url.pathname}`,
    ...outcomeOfStatus(response.status),
  )
  response.headers.set(BREAK_GLASS_HEADER, '1')
  return response
}

async function routeAs(
  request: Request,
  deps: ConsoleDeps,
  tokens: ConsoleTokens,
  throttle: LoginThrottle,
  clientKey: string,
  now: () => number,
  accounts: ConsoleAccounts | undefined,
  access: Access,
  url: URL,
  segments: readonly string[],
  ledger: RequestLedger,
): Promise<Response> {
  const credential = access.credential

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
      accounts,
    )
  }

  if (segments[0] === 'logout' && segments.length === 1) {
    return handleLogout(request, accounts)
  }

  // The invitation door. Public like `/login` — an invitee has no credential
  // yet, that is the point — and absent entirely without accounts.
  if (
    accounts !== undefined &&
    segments[0] === 'invite' &&
    segments.length === 1
  ) {
    return await handleInvite(request, {
      book: accounts.book,
      label: deps.label ?? DEFAULT_LABEL,
      throttle,
      clientKey,
      now: now(),
    })
  }

  // Everything below needs a credential, and a request the account rules
  // refused (a personal credential in a link, the admin token outside a
  // Bearer header in break-glass, a closed account book) goes no further.
  if (access.refusal !== null) {
    return accessRefused(request, access.refusal, deps, url)
  }
  const denial = accounts === undefined ? undefined : access
  const viewer =
    accounts === undefined ? undefined : pageViewer(access, accounts, tokens)

  // Every area page: `/`, `/nodes`, `/chat`, the placeholders. Reserved first
  // segments (`v0`, `fragments`, the doors above) never reach a page.
  const page = pageOf(ROUTES, segments)
  if (page !== undefined) {
    const exchanged =
      accounts === undefined ? tokenInAddressBar(request, url, tokens) : null
    if (exchanged !== null) return exchanged
    return await servePage(
      routeContext(request, url, deps, access, accounts, now(), viewer, ledger),
      page,
      denial,
    )
  }

  if (segments[0] === 'v0') {
    return await dispatchApi(
      routeContext(request, url, deps, access, accounts, now(), viewer, ledger),
      segments,
    )
  }

  if (segments[0] === 'fragments' && segments.length >= 2) {
    return await dispatchFragment(
      routeContext(request, url, deps, access, accounts, now(), viewer, ledger),
      segments,
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
/**
 * HSTS for a console reached over TLS (H2): directly, or through a proxy
 * that says so in `X-Forwarded-Proto` — the same test the session cookie's
 * `Secure` flag uses. A year, and not `includeSubDomains`: the console may
 * share a host name with services it has no business pinning. A browser
 * ignores the header over plain HTTP, so a forged forwarding header buys
 * nothing.
 */
const HSTS = 'max-age=31536000'

/** Every answer on its way out: HSTS when on TLS, then compression (G1). */
async function finished(
  request: Request,
  response: Response,
): Promise<Response> {
  if (!isSecureRequest(request)) return compressed(request, response)
  const headers = new Headers(response.headers)
  headers.set('strict-transport-security', HSTS)
  return compressed(
    request,
    new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  )
}

export function createConsoleHandler(
  deps: ConsoleDeps,
  tokens: ConsoleTokens,
  accounts?: ConsoleAccounts,
): (request: Request, source?: ClientAddressSource) => Promise<Response> {
  if (accounts !== undefined) {
    assertTokensUnlikeAccountSecrets(tokens)
    // Once, at start: if the admin token last used as break-glass is not the
    // one in force now, the rotation happened and is written down (§3.4 ④).
    accounts.book.breakGlassStatus(adminFingerprint(tokens))
  }
  const now = deps.now ?? Date.now
  const throttle = new LoginThrottle()
  return async (
    request: Request,
    source?: ClientAddressSource,
  ): Promise<Response> => {
    try {
      return await finished(
        request,
        await route(
          request,
          deps,
          tokens,
          throttle,
          clientKeyOf(request, source),
          now,
          accounts,
        ),
      )
    } catch (error) {
      // Only reachable when a port breaks its contract and throws. The message
      // is included because the ports are ours and a silent 500 on a
      // loopback tool costs an hour; ports must therefore keep credentials out
      // of their error messages.
      const message = error instanceof Error ? error.message : String(error)
      const failed = fail(500, 'internal', `控制台内部错误：${message}`)
      const segments = new URL(request.url).pathname
        .split('/')
        .filter(s => s.length > 0)
      if (!pageWorthy(request, segments, failed)) return failed
      // Never the shell: drawing it reads the registry, which is a second
      // chance for whatever just threw to throw again.
      const copy = ERROR_PAGES[500]
      return html(
        renderStandalone({
          label: deps.label ?? DEFAULT_LABEL,
          title: copy?.title ?? '',
          line: copy?.line ?? '',
          detail: message,
          link: { href: '/', label: '回到总览' },
        }),
        500,
      )
    }
  }
}

export interface ConsoleServerOptions {
  /** Bind address. Loopback by default — see `auth.ts` on what else costs. */
  readonly hostname?: string
  /** The pair from `resolveTokens`. Required: there is no anonymous console. */
  readonly tokens: ConsoleTokens
  /** Personal accounts. Absent is today's console, byte for byte. */
  readonly accounts?: ConsoleAccounts
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
    fetch: createConsoleHandler(deps, options.tokens, options.accounts),
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
