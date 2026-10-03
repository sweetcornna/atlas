// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 账号与访问 — placeholder (H3 账号与访问 · H4 操作记录), and the action
 * ledger's read API (P15.9).
 *
 * The page package that builds this area replaces the `stubRoute(...)` call
 * below with a module of its own (`routes/types.ts`) and changes no other
 * route file. Until then `/access` is the one-line placeholder of `stub.ts`.
 *
 * ## `/v0/actions` — the 操作记录 tab's data, before its page
 *
 * The ledger's backend is P15.9's and its page is P18.10's
 * (`providers-console-m1.md` §6.2 H4). The page will live in this area, so
 * the API is claimed here, by this module, the way every area claims its own
 * heads; the page package keeps it when it replaces the placeholder.
 *
 * - `GET /v0/actions` — what was done. `ops` and the admin token see every
 *   entry and may filter by `subject`, `action` (a prefix), `target`
 *   (repeatable), `before` (a sequence number, for the next page) and `limit`.
 *   A `member` or `viewer` sees only what they did themselves: their filters
 *   are intersected with their own subject, so somebody else's entries are
 *   simply not in the list (`tenancy-m1.md` §5.1, 列表).
 * - `GET /v0/actions/reads` — "my transcript, read by whom and when" (D6):
 *   every opening of a conversation the caller owns, newest first, whoever
 *   opened it. `?session=<id>` narrows it to one conversation the caller may
 *   see; one they may not see answers exactly as one that does not exist — an
 *   empty page.
 *
 * The shared view token is refused both (403): it is not a person, many
 * people hold it, and "what did `legacy:view` do" is not anybody's answer.
 * Nothing on either route is recorded — reading the ledger is a read — except
 * that a break-glass request is, as every break-glass request is (`http.ts`).
 * A closed ledger answers 503 rather than the lines that still parse.
 */

import { chatScopeOf } from '../accountsHttp.js'
import type { ActionQuery } from '../deps.js'
import { fail, json, methodNotAllowed, notFound } from '../respond.js'
import { failureResponse, guard } from './shared.js'
import { stubRoute } from './stub.js'
import type { RouteContext, RouteModule } from './types.js'

/** The verb a transcript opening is recorded under (`deps.ts`). */
const TRANSCRIPT_OPEN = 'chat.transcript.open'

const MAX_FILTER_LENGTH = 512
const MAX_TARGETS = 200

const PERSON_REQUIRED =
  '操作记录需要个人账号或 admin 令牌；共用的只读令牌看不到操作记录。'
const LEDGER_UNWIRED =
  '这台控制台没有接动作账本：开个人账号（--accounts）才有。'
const LEDGER_UNREADABLE =
  '操作记录暂时读不出来：动作账本校验没有通过，已告警运维。'

/** The filters both routes share, and those only `/v0/actions` takes. */
interface ActionFilters {
  readonly subject?: string
  readonly action?: string
  readonly targets?: readonly string[]
  readonly beforeSeq?: number
  readonly limit?: number
  readonly session?: string
}

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

function positiveInteger(
  raw: string | null,
  name: string,
): Parsed<number | undefined> {
  if (raw === null) return { ok: true, value: undefined }
  const value = /^\d{1,15}$/.test(raw) ? Number(raw) : Number.NaN
  return Number.isSafeInteger(value) && value >= 1
    ? { ok: true, value }
    : { ok: false, message: `${name} 必须是正整数` }
}

function boundedText(
  raw: string | null,
  name: string,
): Parsed<string | undefined> {
  if (raw === null) return { ok: true, value: undefined }
  return raw.length >= 1 && raw.length <= MAX_FILTER_LENGTH
    ? { ok: true, value: raw }
    : {
        ok: false,
        message: `${name} 长度必须在 1 到 ${MAX_FILTER_LENGTH} 之间`,
      }
}

function parseFilters(params: URLSearchParams): Parsed<ActionFilters> {
  const before = positiveInteger(params.get('before'), 'before')
  if (!before.ok) return before
  const limit = positiveInteger(params.get('limit'), 'limit')
  if (!limit.ok) return limit
  const subject = boundedText(params.get('subject'), 'subject')
  if (!subject.ok) return subject
  const action = boundedText(params.get('action'), 'action')
  if (!action.ok) return action
  const session = boundedText(params.get('session'), 'session')
  if (!session.ok) return session
  const targets = params.getAll('target')
  if (targets.length > MAX_TARGETS) {
    return { ok: false, message: `target 最多 ${MAX_TARGETS} 个` }
  }
  for (const target of targets) {
    const checked = boundedText(target, 'target')
    if (!checked.ok) return checked
  }
  return {
    ok: true,
    value: {
      ...(subject.value === undefined ? {} : { subject: subject.value }),
      ...(action.value === undefined ? {} : { action: action.value }),
      ...(targets.length === 0 ? {} : { targets }),
      ...(before.value === undefined ? {} : { beforeSeq: before.value }),
      ...(limit.value === undefined ? {} : { limit: limit.value }),
      ...(session.value === undefined ? {} : { session: session.value }),
    },
  }
}

/** Paging only: what both routes pass through untouched. */
function paging(
  filters: ActionFilters,
): Pick<ActionQuery, 'beforeSeq' | 'limit'> {
  return {
    ...(filters.beforeSeq === undefined
      ? {}
      : { beforeSeq: filters.beforeSeq }),
    ...(filters.limit === undefined ? {} : { limit: filters.limit }),
  }
}

/** `GET /v0/actions`, as a ledger query; `null` for "nothing can match". */
function everyQuery(
  ctx: RouteContext,
  filters: ActionFilters,
): ActionQuery | null {
  const principal = ctx.access.principal
  const seesAll =
    principal?.kind === 'legacy' ||
    (principal?.kind === 'user' && principal.role === 'ops')
  let subject = filters.subject
  if (!seesAll) {
    const self = principal?.subject
    if (self === undefined || (subject !== undefined && subject !== self)) {
      return null
    }
    subject = self
  }
  return {
    ...(subject === undefined ? {} : { subject }),
    ...(filters.action === undefined ? {} : { actionPrefix: filters.action }),
    ...(filters.targets === undefined ? {} : { targets: filters.targets }),
    ...paging(filters),
  }
}

/**
 * `GET /v0/actions/reads`, as a ledger query: the transcript openings of the
 * caller's own conversations, or of the one named, if the caller may see it.
 */
async function readsQuery(
  ctx: RouteContext,
  filters: ActionFilters,
): Promise<ActionQuery | Response> {
  const { access, accounts, deps } = ctx
  let targets: readonly string[] = []
  if (filters.session !== undefined) {
    // The chat face's own rule for "may this caller see that conversation".
    if (chatScopeOf(access, accounts).visible(filters.session)) {
      targets = [filters.session]
    }
  } else {
    const principal = access.principal
    // Only a person owns a conversation; a legacy token owns none.
    if (
      principal?.kind === 'user' &&
      accounts !== undefined &&
      deps.chat !== undefined
    ) {
      const sessions = await deps.chat.sessions()
      if (!sessions.ok) return failureResponse(sessions.failure)
      targets = sessions.value
        .map(session => session.id)
        .filter(id => accounts.book.ownerOf(id) === principal.subject)
    }
  }
  return { targets, actionPrefix: TRANSCRIPT_OPEN, ...paging(filters) }
}

async function handleActionsApi(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  const { request, access, deps, url } = ctx
  // Role before path before method before existence, as everywhere here.
  const denied = guard(access.credential, 'view', 'guarded')
  if (denied !== null) return denied
  const principal = access.principal
  if (principal === null || principal.subject === 'legacy:view') {
    return fail(403, 'forbidden', PERSON_REQUIRED)
  }
  const reads = rest.length === 1 && rest[0] === 'reads'
  if (rest.length > 0 && !reads)
    return notFound(`unknown path: ${url.pathname}`)
  if (request.method !== 'GET') return methodNotAllowed(['GET'])
  const ledger = deps.actions
  if (ledger === undefined) return fail(501, 'unsupported', LEDGER_UNWIRED)

  const filters = parseFilters(url.searchParams)
  if (!filters.ok) return fail(400, 'invalid', filters.message)
  const query = reads
    ? await readsQuery(ctx, filters.value)
    : everyQuery(ctx, filters.value)
  if (query instanceof Response) return query
  // Somebody else's subject asked for by a member: the list is filtered, and
  // filtered to nothing — but the ledger is still read, so a closed one says
  // so here too.
  const page = await ledger.list(query ?? { targets: [] })
  if (!page.ok) return fail(503, 'unavailable', LEDGER_UNREADABLE)
  return json(page.value)
}

export const accessRoute: RouteModule = {
  ...stubRoute(
    { id: 'access', label: '账号与访问', group: 'admin', icon: 'users' },
    '成员 · 邀请 · 会话 · 操作记录',
  ),
  api: {
    heads: ['actions'],
    handle: (ctx, _head, rest) => handleActionsApi(ctx, rest),
  },
}
