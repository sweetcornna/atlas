// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What every area's handlers share: the guards, the port-result helpers and
 * the small parsers.
 *
 * Moved out of `http.ts` unchanged when the routes split into areas
 * (`routes/types.ts`): a module that wrote its own guard would be a second
 * place for "role before position before method" to drift, and that order is
 * the one thing about this console a reviewer cannot re-derive from a single
 * file. `test/legacyParity.test.ts` pins that the move changed no byte.
 */

import { CONSOLE_HEADER, type ConsoleCredential } from '../auth.js'
import type { Access } from '../access.js'
import type {
  AuditFilter,
  ConsoleAuditSource,
  ConsoleDeps,
  ConsoleFailure,
  ConsoleResult,
} from '../deps.js'
import { fail } from '../respond.js'

/** Header shown when the operator did not name this console. */
export const DEFAULT_LABEL = '阡陌控制台'

/**
 * The CLI name §10.2's copyable `ca issue` line is written under, when the
 * host did not say.
 *
 * A fallback rather than a source: the name has exactly one spelling
 * (`src/constants/identity.ts`), the host reads it from there, and this
 * package is a leaf that cannot. Reached only by a caller that wired a
 * certificate port and no name, which is a wiring mistake rather than a
 * configuration — so the fallback is the right string rather than a blank.
 */
export const DEFAULT_BIN_NAME = 'qm'

const DEFAULT_AUDIT_SOURCE_NODE = 'default'

/**
 * What an ambient (cookie) credential is allowed to do on a route. The module
 * note in `http.ts` defines the three; `auth.ts` argues for them.
 */
export type Protection = 'document' | 'stream' | 'guarded'

/** What a JSON caller is told when a view token reached an admin route. */
const ADMIN_REQUIRED = '该操作需要 admin token，当前凭据只有只读权限。'

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
export function guard(
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

/** What a `viewer` account is told on a chat route. */
const CHAT_MEMBER_REQUIRED = '对话需要成员或运维账号；只读账号看不到会话。'

/**
 * The chat face's guard. Without accounts, and for the two legacy tokens, it
 * is today's rule: admin, all of it (`http.ts` module note). A person needs a
 * `member` or `ops` account; `ops` reads as admin already, so only `member` is
 * the new case, and `viewer` is refused with the reason.
 */
export function guardChat(
  access: Access,
  protection: Protection,
): Response | null {
  const principal = access.principal
  if (principal?.kind !== 'user') {
    return guard(access.credential, 'admin', protection)
  }
  const denied = guard(access.credential, 'view', protection)
  if (denied !== null) return denied
  return principal.role === 'viewer'
    ? fail(403, 'forbidden', CHAT_MEMBER_REQUIRED)
    : null
}

/** True when this caller gets the chat face at all. */
export function mayChat(access: Access): boolean {
  const principal = access.principal
  return principal?.kind === 'user'
    ? principal.role !== 'viewer'
    : access.credential.role === 'admin'
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
    // 403, and emphatically not 503: the far node was reached, read the
    // request and declined it. A 503 tells a caller — and every retry loop
    // written against one — that the service is momentarily away and the same
    // bytes will work later, which for a policy refusal is false in both
    // halves (issue #29).
    case 'refused':
      return 403
    // `rejected` (a rule on this side would not let it leave) and `invalid`
    // (the input itself) both land on 400: the ports cannot tell a conflict
    // from a malformed address, and inventing a 409 here would be a guess the
    // client would act on.
    case 'rejected':
    case 'invalid':
      return 400
  }
}

export function failureResponse(failure: ConsoleFailure): Response {
  return fail(statusFor(failure.code), failure.code, failure.message)
}

export function valueOf<T>(result: ConsoleResult<T>): T | null {
  return result.ok ? result.value : null
}

export function failureOf<T>(result: ConsoleResult<T>): ConsoleFailure | null {
  return result.ok ? null : result.failure
}

export function textParam(
  params: URLSearchParams,
  name: string,
): string | undefined {
  const raw = params.get(name)
  if (raw === null) return undefined
  const trimmed = raw.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

// --- body parsing --------------------------------------------------------

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

export function requiredString(
  body: Record<string, unknown>,
  key: string,
): Parsed<string> {
  const value = body[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, message: `字段 ${key} 必须是非空字符串` }
  }
  return { ok: true, value }
}

export function optionalString(
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

// --- audit sources -------------------------------------------------------

export function auditSources(deps: ConsoleDeps): readonly ConsoleAuditSource[] {
  return (
    deps.audits ?? [
      {
        node: DEFAULT_AUDIT_SOURCE_NODE,
        audit: deps.audit,
        kind: 'authoritative',
      },
    ]
  )
}

export function auditSourceOf(
  deps: ConsoleDeps,
  node: string | undefined,
): ConsoleAuditSource | undefined {
  const sources = auditSources(deps)
  if (node === undefined || node === '') {
    return sources.length === 1 ? sources[0] : undefined
  }
  return sources.find(source => source.node === node)
}

export async function readAuditSources(deps: ConsoleDeps, filter: AuditFilter) {
  return await Promise.all(
    auditSources(deps).map(async source => {
      const result = await source.audit.read(filter)
      return {
        node: source.node,
        kind: source.kind,
        ...(source.maxLagMinutes === undefined
          ? {}
          : { maxLagMinutes: source.maxLagMinutes }),
        page: valueOf(result),
        failure: failureOf(result),
      }
    }),
  )
}

/** True when the console reads one source the legacy way (`deps.audit` only). */
export function singleLegacyAudit(deps: ConsoleDeps): boolean {
  return auditSources(deps).length === 1 && deps.audits === undefined
}

// --- page paths ----------------------------------------------------------

/**
 * The usual {@link PageRoute.match}: the area's own top segment, and at most
 * `depth` segments under it. `/nodes` is `underPath('nodes', 1)` because
 * `/nodes/<node>` is a page too; a stub is `underPath('alerts')`, so
 * `/alerts/anything` is the console's ordinary 404 rather than the stub.
 */
export function underPath(
  head: string,
  depth = 0,
): (segments: readonly string[]) => readonly string[] | null {
  return segments =>
    segments[0] === head && segments.length - 1 <= depth
      ? segments.slice(1)
      : null
}

/**
 * One path segment, percent-decoded, or `null` when it is not valid
 * percent-encoding. A page answers a malformed name with its 404 rather than
 * letting `URIError` become the last-resort 500.
 */
export function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}
