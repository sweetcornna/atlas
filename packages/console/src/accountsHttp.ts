// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The HTTP face of personal accounts: the invitation door and the account
 * administration routes.
 *
 * | Method | Path | Who | Returns |
 * | --- | --- | --- | --- |
 * | GET | `/invite` | public | `text/html`, the confirmation card; never mints |
 * | POST | `/invite` | public, same-origin | the credential page, once |
 * | GET | `/v0/accounts` | admin | `{ accounts, invites }`, no secret, no hash |
 * | POST | `/v0/accounts/invites` | admin | `{ inviteId, role, expiresAt, link }` |
 * | DELETE | `/v0/accounts/invites/<id>` | admin | 204 |
 *
 * None of these exist on a console started without accounts: `http.ts` only
 * routes here when it was handed an {@link AccountBook}, and otherwise the
 * paths fall through to the same 404 they always answered.
 *
 * Role checks for the `/v0/accounts` routes happen in `http.ts`, through the
 * same `guard` every other route uses, before anything here runs — so the
 * protection classes (the console header for a cookie, 401 before 405) are the
 * ones already written down in one place rather than restated here.
 */

import type {
  AccountBook,
  AccountOutcome,
  AccountRefusal,
  AccountRole,
} from './accounts.js'
import { isCrossOriginRequest } from './auth.js'
import {
  fail,
  html,
  json,
  methodNotAllowed,
  notFound,
  readForm,
  readJsonObject,
} from './respond.js'
import type { LoginThrottle } from './throttle.js'
import { renderCredentialPage, renderInvitePage } from './view/invite.js'

/** Everything the invitation door needs from the request that reached it. */
interface InviteDoor {
  readonly book: AccountBook
  readonly label: string
  readonly throttle: LoginThrottle
  readonly clientKey: string
  readonly now: number
}

/** HTTP status for a refusal from the book. */
function statusOf(refusal: AccountRefusal): number {
  switch (refusal.code) {
    case 'unavailable':
      return 503
    case 'refused':
      return 403
    case 'invalid':
      return 400
    case 'not_found':
      return 404
    case 'limit':
      return 429
  }
}

function refusalResponse(refusal: AccountRefusal): Response {
  return fail(statusOf(refusal), refusal.code, refusal.message)
}

/**
 * `GET /invite` and `POST /invite`.
 *
 * The order of the `POST` checks is the point: origin first, so a foreign page
 * cannot spend somebody's invitation; the throttle second, before the book is
 * consulted, so a blocked guesser learns nothing about the token they sent;
 * only then the book, which is the one step that can consume anything.
 */
export async function handleInvite(
  request: Request,
  door: InviteDoor,
): Promise<Response> {
  if (request.method === 'GET') {
    return html(renderInvitePage({ label: door.label }))
  }
  if (request.method !== 'POST') return methodNotAllowed(['GET', 'POST'])

  if (isCrossOriginRequest(request)) {
    return fail(403, 'forbidden', '开通只接受来自本控制台自己页面的提交。')
  }
  const form = await readForm(request)
  if (form === null) return fail(400, 'invalid', '请求体必须是开通表单')

  const wait = door.throttle.retryAfterSeconds(door.clientKey, door.now)
  if (wait > 0) {
    const page = html(
      renderInvitePage({
        label: door.label,
        error: `尝试过多 · 请等 ${wait} 秒`,
      }),
      429,
    )
    page.headers.set('retry-after', String(wait))
    return page
  }

  const accepted = door.book.acceptInvite((form.get('invite') ?? '').trim())
  if (!accepted.ok) {
    if (accepted.refusal.code === 'refused') {
      door.throttle.recordFailure(door.clientKey, door.now)
    }
    return html(
      renderInvitePage({ label: door.label, error: accepted.refusal.message }),
      statusOf(accepted.refusal),
    )
  }
  door.throttle.clear(door.clientKey)
  return html(
    renderCredentialPage({
      label: door.label,
      role: accepted.value.role,
      credential: accepted.value.credential,
      signedIn: false,
    }),
  )
}

/** Longest invitation an issuer may ask for, in the unit the API takes. */
const MAX_TTL_HOURS = 72

function parseInviteRequest(body: Record<string, unknown>):
  | {
      readonly ok: true
      readonly role: AccountRole
      readonly ttlMs?: number
      readonly label?: string
    }
  | { readonly ok: false; readonly message: string } {
  const role = body['role']
  if (role !== 'viewer' && role !== 'member' && role !== 'ops') {
    return { ok: false, message: '字段 role 必须是 viewer、member 或 ops' }
  }
  const ttl = body['ttlHours']
  let ttlMs: number | undefined
  if (ttl !== undefined && ttl !== null) {
    if (
      typeof ttl !== 'number' ||
      !Number.isFinite(ttl) ||
      ttl <= 0 ||
      ttl > MAX_TTL_HOURS
    ) {
      return {
        ok: false,
        message: `字段 ttlHours 必须是 0 到 ${MAX_TTL_HOURS} 之间的小时数`,
      }
    }
    ttlMs = Math.round(ttl * 60 * 60 * 1000)
  }
  const rawLabel = body['label']
  let label: string | undefined
  if (rawLabel !== undefined && rawLabel !== null) {
    if (typeof rawLabel !== 'string') {
      return { ok: false, message: '字段 label 必须是字符串' }
    }
    const trimmed = rawLabel.trim()
    if (trimmed !== '') label = trimmed
  }
  return {
    ok: true,
    role,
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(label === undefined ? {} : { label }),
  }
}

function answer<T>(
  outcome: AccountOutcome<T>,
  shape: (value: T) => Response,
): Response {
  return outcome.ok ? shape(outcome.value) : refusalResponse(outcome.refusal)
}

/**
 * `/v0/accounts/…`, after `http.ts` has established the caller may administer
 * accounts. `actor` is who the ledger will name: a subject, or `legacy:admin`.
 */
export async function handleAccountsApi(
  request: Request,
  book: AccountBook,
  actor: string,
  segments: readonly string[],
  url: URL,
): Promise<Response> {
  if (segments.length === 2) {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return answer(book.list(), value => json(value))
  }
  if (segments[2] !== 'invites') {
    return notFound(`unknown path: ${url.pathname}`)
  }
  if (segments.length === 3) {
    if (request.method !== 'POST') return methodNotAllowed(['POST'])
    const body = await readJsonObject(request)
    if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
    const parsed = parseInviteRequest(body)
    if (!parsed.ok) return fail(400, 'invalid', parsed.message)
    return answer(
      book.issueInvite({
        role: parsed.role,
        issuedBy: actor,
        ...(parsed.ttlMs === undefined ? {} : { ttlMs: parsed.ttlMs }),
        ...(parsed.label === undefined ? {} : { label: parsed.label }),
      }),
      invite =>
        json({
          inviteId: invite.inviteId,
          role: invite.role,
          expiresAt: invite.expiresAt,
          // Relative on purpose: behind a reverse proxy this process does not
          // know the origin the invitee will type, and guessing one is how a
          // link to `http://127.0.0.1:38613` ends up in somebody's chat app.
          // The token is after `#`, so it never reaches a server or a log.
          link: `/invite#${invite.token}`,
        }),
    )
  }
  if (segments.length === 4) {
    if (request.method !== 'DELETE') return methodNotAllowed(['DELETE'])
    return answer(
      book.withdrawInvite(decodeURIComponent(segments[3] ?? ''), actor),
      () => new Response(null, { status: 204 }),
    )
  }
  return notFound(`unknown path: ${url.pathname}`)
}
