// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * Who may read the console, who may act through it, and where the two tokens
 * come from.
 *
 * ## Two tokens, not one with a flag
 *
 * The same reasoning as the backup service (`packages/backup/src/service.ts`):
 * the console's read face shows a roster and an audit trail, while its write
 * face registers agents, drops them and wakes nodes. A single token with a
 * scope field would put "a viewer cannot wake a node" one boolean away from
 * being wrong. So there are two strings, compared separately, and the admin
 * token is a strict superset of the view token's rights — never the other way
 * around.
 *
 * Comparison is length-independent for the same reason the transport handshake
 * is: a timing side channel on a bearer token is cheap to avoid and expensive
 * to discover.
 *
 * ## Where the token rides
 *
 * Two places, both checked by {@link presentedTokenOf}:
 *
 * - `Authorization: Bearer <token>` — what the page's `fetch()` calls and any
 *   `curl` use.
 * - `?token=<token>` on the query string — what a **browser navigation** uses,
 *   because a URL typed or clicked into an address bar cannot carry a header.
 *   That is the whole reason the CLI prints a URL with the token in it.
 *
 * Deliberately **not** a cookie. A cookie would be attached by the browser to
 * cross-origin `POST`s from any page the operator happens to have open, which
 * turns every admin route into a CSRF target on a loopback port that any local
 * page can reach. Requiring a token that a foreign origin cannot read *is* the
 * CSRF defence here, and it only works while the credential is not ambient.
 *
 * A token in a URL is a real (smaller) exposure — shell history, the address
 * bar, a `Referer` header. The HTTP layer answers the last one with
 * `referrer-policy: no-referrer`; the first two are accepted, because the
 * alternative is a console nobody can open.
 */

import { timingSafeEqual } from 'node:crypto'

/**
 * Shortest token this package will accept, generated or supplied.
 *
 * Same floor as the backup service. It is not an entropy estimate — it is the
 * line under which a token is obviously not a token.
 */
export const MIN_TOKEN_LENGTH = 16

/** Query parameter a browser navigation may carry the token in. */
export const TOKEN_QUERY_PARAM = 'token'

/** What the presented credential entitles the caller to. */
export type ConsoleRole = 'view' | 'admin' | 'none'

/** The two credentials one console instance is started with. */
export interface ConsoleTokens {
  /** Reads the roster, the trail and the limits. Changes nothing. */
  readonly view: string
  /** Everything the view token can do, plus register/deregister/wake. */
  readonly admin: string
}

/** Constant-time bearer comparison. Empty never matches. */
function tokenMatches(presented: string, expected: string): boolean {
  // An empty `presented` against an empty `expected` is `timingSafeEqual` over
  // two empty buffers, which is `true`. `resolveTokens` makes that unreachable
  // in production, but `roleOf` is a public function and this is the one input
  // that must never be allowed to grant a role.
  if (presented.length === 0 || expected.length === 0) return false
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.byteLength !== b.byteLength) return false
  return timingSafeEqual(a, b)
}

/** The `Authorization: Bearer` value, or `''` when there is no bearer. */
export function bearerOf(request: Request): string {
  const header = request.headers.get('authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
}

/**
 * The token this request presents, from the header first and the query string
 * second. See the module note for why both are accepted.
 */
export function presentedTokenOf(request: Request): string {
  const bearer = bearerOf(request)
  if (bearer.length > 0) return bearer
  try {
    return new URL(request.url).searchParams.get(TOKEN_QUERY_PARAM) ?? ''
  } catch {
    // A request whose URL will not parse has no query string to read.
    return ''
  }
}

/**
 * Resolve the caller's role.
 *
 * Both comparisons always run — no short-circuit — so the answer costs the
 * same whichever token was presented. The admin token also satisfies every
 * view-only route: one operator with one credential is the common case, and
 * making them hold two would guarantee they hold one.
 */
export function roleOf(request: Request, tokens: ConsoleTokens): ConsoleRole {
  const presented = presentedTokenOf(request)
  const isAdmin = tokenMatches(presented, tokens.admin)
  const isView = tokenMatches(presented, tokens.view)
  if (isAdmin) return 'admin'
  if (isView) return 'view'
  return 'none'
}

/** True for the addresses only this machine can reach. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (host === 'localhost') return true
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  // The whole 127/8 block, not just 127.0.0.1.
  return /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host)
}

/** Everything {@link resolveTokens} needs to decide. */
export interface ResolveTokensInput {
  /** Operator-supplied view token, if any. */
  readonly view?: string
  /** Operator-supplied admin token, if any. */
  readonly admin?: string
  /** The address the server will bind to — the whole basis of the policy. */
  readonly hostname: string
  /** Source of a fresh token. Injected so tests are deterministic. */
  readonly generate: () => string
}

/** An empty string is "not supplied", not "supplied as empty". */
function supplied(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

function requireExplicit(
  value: string | undefined,
  which: 'view' | 'admin',
  hostname: string,
): string {
  const given = supplied(value)
  if (given !== undefined) return given
  throw new Error(
    `控制台绑定在非环回地址 ${hostname}，必须显式提供 ${which} token；` +
      `请设置 --${which}-token（或对应环境变量），或改绑 127.0.0.1 让控制台自动生成。`,
  )
}

/**
 * Decide the pair of tokens a console instance runs with.
 *
 * Pure on purpose: the policy lives here and the CLI only calls it, so "when
 * is a console allowed to run without a password" has exactly one answer that
 * can be read in one place and tested without binding a port.
 *
 * Three rules:
 *
 * 1. **Loopback with nothing supplied** — generate. The console is reachable
 *    only from this machine, and the CLI prints the URL with the token in it,
 *    so the operator pays nothing for a credential that still stops another
 *    local process from stumbling in.
 * 2. **Anything but loopback** — both tokens must be supplied, or this throws.
 *    Fail closed: `--host 0.0.0.0` is how a console ends up on a VPS's public
 *    interface, and a generated token that is only printed to a stdout nobody
 *    is reading would leave the roster, the trail and the wake button open to
 *    whoever scans the port first. Refusing to start is the only outcome that
 *    cannot be missed.
 * 3. **Always** — each token is at least {@link MIN_TOKEN_LENGTH} characters
 *    and the two differ. Applied to generated tokens as well, so a `generate`
 *    that returns `''` or the same string twice is a startup failure and not a
 *    console where the view token is the admin token.
 */
export function resolveTokens(input: ResolveTokensInput): ConsoleTokens {
  const loopback = isLoopbackHostname(input.hostname)

  const view = loopback
    ? (supplied(input.view) ?? input.generate())
    : requireExplicit(input.view, 'view', input.hostname)
  const admin = loopback
    ? (supplied(input.admin) ?? input.generate())
    : requireExplicit(input.admin, 'admin', input.hostname)

  if (view.length < MIN_TOKEN_LENGTH || admin.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `控制台 token 至少需要 ${MIN_TOKEN_LENGTH} 个字符；` +
        '请换一个更长的随机串（例如 `openssl rand -hex 16`）。',
    )
  }
  if (view === admin) {
    // One string for both faces would make the two-credential design a comment.
    throw new Error(
      '控制台的 view token 与 admin token 必须不同；' +
        '相同就等于只读用户也能注册、注销和唤醒节点。',
    )
  }

  return { view, admin }
}
