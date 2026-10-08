// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 账号与访问 (H3) and 操作记录 (H4): the `/access` page and its four tabs,
 * their polled fragments, and the action ledger's read API (P15.9).
 *
 * ## The page
 *
 * | Path | Tab | Who |
 * | --- | --- | --- |
 * | `/access` | 成员 for whoever may administer accounts, else 操作记录 | any credential |
 * | `/access/invites` | 邀请 | administers; anyone else a 403 page saying who may |
 * | `/access/sessions` | 会话 | administers; likewise |
 * | `/access/actions` | 操作记录, and 谁读了我的对话 for a person | any credential |
 * | `/fragments/access/<members\|invites\|sessions>` | the polled regions | administers |
 *
 * "Administers" is {@link canWrite}: the admin token or a personal `ops`
 * account — the same test `http.ts` puts in front of `/v0/accounts`, so the
 * page never offers a tab whose API would refuse the reader. The write
 * controls go further and need the account book usable and the action ledger
 * admitting writes: a button that can only answer 503 is not drawn, and the
 * tab says why instead.
 *
 * Every write on these tabs goes to the account API (`accountsHttp.ts`), and
 * `http.ts` already asks the ledger before each one and writes it down after
 * (`accounts.<method>`, the path as the target). This module writes nothing
 * to the ledger of its own: a second line for the same act would make every
 * count over the ledger wrong by one.
 *
 * ## `/v0/actions` — the 操作记录 tab's data, as an API
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
 *   empty page. Each entry also carries `subjectName`, the reader's display
 *   name from the account book, when there is one: a `u:…` id alone tells
 *   the person nothing about who read their conversation, which is the whole
 *   point of D6. Only here — `/v0/actions` stays ids.
 *
 * The shared view token is refused both (403): it is not a person, many
 * people hold it, and "what did `legacy:view` do" is not anybody's answer.
 * Nothing on either route is recorded — reading the ledger is a read — except
 * that a break-glass request is, as every break-glass request is (`http.ts`).
 * A closed ledger answers 503 rather than the lines that still parse.
 *
 * The page reads the ledger through the same two queries, so the tab and the
 * API cannot disagree about who sees what.
 */

import type { ConsoleAccounts } from '../access.js'
import { MAX_OPEN_INVITES } from '../accounts.js'
import { chatScopeOf } from '../accountsHttp.js'
import type {
  ActionPage,
  ActionQuery,
  ActionRecord,
  ConsoleResult,
} from '../deps.js'
import { fail, html, json, methodNotAllowed, notFound } from '../respond.js'
import {
  ACCESS_PAGE_CSS,
  ACCOUNTS_OFF_LINE,
  ADMIN_ONLY_LINE,
  BOOK_CLOSED_LINE,
  LEDGER_CLOSED_LINE,
  TAB_LABEL,
  accessDialogs,
  inviteLinkPanel,
  namesOf,
  renderAccessTabs,
  renderActionFilter,
  renderActionLog,
  renderForbiddenTab,
  renderInviteForm,
  renderInvites,
  renderMembers,
  renderReads,
  renderSessions,
  type AccessListing,
  type AccessTab,
  type ActionFilterView,
  type LedgerShown,
} from '../view/access.js'
import { bar } from '../view/bits.js'
import {
  canWrite,
  failureResponse,
  guard,
  readOnlyNote,
  underPath,
} from './shared.js'
import type { PageRender, RouteContext, RouteModule } from './types.js'

/** The verb a transcript opening is recorded under (`deps.ts`). */
const TRANSCRIPT_OPEN = 'chat.transcript.open'

const MAX_FILTER_LENGTH = 512
const MAX_TARGETS = 200

const PERSON_REQUIRED =
  '操作记录需要个人账号或管理令牌；共用的只读令牌看不到操作记录。'
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
): Promise<ConsoleResult<ActionQuery>> {
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
      if (!sessions.ok) return { ok: false, failure: sessions.failure }
      targets = sessions.value
        .map(session => session.id)
        .filter(id => accounts.book.ownerOf(id) === principal.subject)
    }
  }
  return {
    ok: true,
    value: { targets, actionPrefix: TRANSCRIPT_OPEN, ...paging(filters) },
  }
}

/** A reading, with the reader's display name when the account book has one. */
interface NamedActionRecord extends ActionRecord {
  readonly subjectName?: string
}

/**
 * Name the readers on a `reads` page. The name is the account's label (the one
 * `ops` gave it at invitation); a subject with none — a legacy token, an
 * account never labelled — and a book that cannot be read leave the entry as
 * it was rather than inventing a name.
 */
function withReaderNames(
  page: ActionPage,
  accounts: ConsoleAccounts | undefined,
): {
  readonly entries: readonly NamedActionRecord[]
  readonly nextBeforeSeq: number | null
} {
  const listed = accounts?.book.list()
  if (listed === undefined || !listed.ok) return page
  const names = new Map<string, string>()
  for (const account of listed.value.accounts) {
    if (account.label !== undefined) names.set(account.subject, account.label)
  }
  return {
    ...page,
    entries: page.entries.map(entry => {
      const name = names.get(entry.subject)
      return name === undefined ? entry : { ...entry, subjectName: name }
    }),
  }
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
  let query: ActionQuery | null
  if (reads) {
    const owned = await readsQuery(ctx, filters.value)
    if (!owned.ok) return failureResponse(owned.failure)
    query = owned.value
  } else {
    query = everyQuery(ctx, filters.value)
  }
  // Somebody else's subject asked for by a member: the list is filtered, and
  // filtered to nothing — but the ledger is still read, so a closed one says
  // so here too.
  const page = await ledger.list(query ?? { targets: [] })
  if (!page.ok) return fail(503, 'unavailable', LEDGER_UNREADABLE)
  return json(reads ? withReaderNames(page.value, ctx.accounts) : page.value)
}

// --- the page --------------------------------------------------------------

/** Most entries one page of 操作记录 lists, in either of its two lists. */
const PAGE_LIMIT = 50

/** The tabs of somebody who administers accounts, in order. */
const ADMIN_TABS = ['members', 'invites', 'sessions'] as const
type AdminTab = (typeof ADMIN_TABS)[number]

const EVERY_TAB: readonly AccessTab[] = [...ADMIN_TABS, 'actions']

/** The tab each `/access/<segment>` names. 成员 is `/access` itself. */
const TAB_OF_SEGMENT: Readonly<Record<string, AccessTab>> = {
  invites: 'invites',
  sessions: 'sessions',
  actions: 'actions',
}

/** The polled regions, by the segment after `/fragments/access/`. */
const FRAGMENT_TABS: Readonly<Record<string, AdminTab>> = {
  members: 'members',
  invites: 'invites',
  sessions: 'sessions',
}

/** What a script is told on a fragment it may not read. */
const ADMIN_ONLY = '成员、邀请与会话需要运维角色的个人账号或管理令牌。'

/** 操作记录, to a credential the ledger has no answer for. */
const PERSON_REQUIRED_LINE =
  '操作记录需要个人账号或管理令牌 · 共用的只读令牌看不到'

/** 操作记录, on a console without a ledger. */
const LEDGER_UNWIRED_LINE =
  '这台控制台没有接动作账本 · 开启个人账号后才有操作记录'

/** Said where the write controls are, to a writer with script off. */
const NO_SCRIPT_LINE =
  '签发 · 作废 · 重置 · 吊销与强制下线需要启用脚本 · 阅读不受影响'

/**
 * May this caller administer accounts. The same test `http.ts` puts in front
 * of `/v0/accounts` (`guard(…, 'admin', …)`), so the page never offers a tab
 * whose API would refuse the reader.
 */
function administers(ctx: RouteContext): boolean {
  return canWrite(ctx.access)
}

/** Where the account book stands, for an administration tab. */
type BookState =
  | { readonly kind: 'off' }
  | { readonly kind: 'closed' }
  | {
      readonly kind: 'open'
      readonly listing: AccessListing
      /** The action ledger refuses writes: every one here would be a 503. */
      readonly ledgerClosed: boolean
      /** The write controls are drawn. */
      readonly writable: boolean
    }

async function bookOf(ctx: RouteContext): Promise<BookState> {
  const accounts = ctx.accounts
  if (accounts === undefined) return { kind: 'off' }
  const listed = accounts.book.list()
  if (!listed.ok) return { kind: 'closed' }
  // Asked now rather than at the click: a button whose only possible answer
  // is 503 is not drawn, and the tab says why instead.
  const ledgerClosed = (await ctx.admit()) !== null
  return {
    kind: 'open',
    listing: listed.value,
    ledgerClosed,
    writable: administers(ctx) && !ledgerClosed,
  }
}

/** One administration tab's polled region. */
function adminFragment(
  ctx: RouteContext,
  tab: AdminTab,
  book: BookState,
): string {
  if (book.kind === 'off') return bar('muted', ACCOUNTS_OFF_LINE)
  if (book.kind === 'closed') return bar('bad', BOOK_CLOSED_LINE)
  const lead = book.ledgerClosed ? bar('bad', LEDGER_CLOSED_LINE) : ''
  const principal = ctx.access.principal
  const model = {
    listing: book.listing,
    now: ctx.now,
    canWrite: book.writable,
    self: principal?.kind === 'user' ? principal.subject : undefined,
  }
  switch (tab) {
    case 'members':
      return lead + renderMembers(model)
    case 'invites':
      return lead + renderInvites({ ...model, cap: MAX_OPEN_INVITES })
    case 'sessions':
      return lead + renderSessions(model)
  }
}

/** An administration tab: its region, and the writer's form, panel and dialogs. */
async function adminBody(
  ctx: RouteContext,
  tab: AdminTab,
): Promise<{ readonly body: string; readonly poll: boolean }> {
  const book = await bookOf(ctx)
  const writable = book.kind === 'open' && book.writable
  // Nothing on a console without accounts changes under the reader.
  const poll = book.kind !== 'off'
  const region =
    `<div id="access-${tab}"` +
    (poll ? ` data-poll="/fragments/access/${tab}"` : '') +
    `>${adminFragment(ctx, tab, book)}</div>`
  const body =
    (writable
      ? `<noscript><p class="note">${NO_SCRIPT_LINE}</p></noscript>` +
        (tab === 'invites' ? renderInviteForm() : '') +
        (tab === 'sessions' ? '' : inviteLinkPanel())
      : '') +
    `<section class="sec" id="access-${tab}-section">${region}</section>` +
    (writable ? accessDialogs() : '')
  return { body, poll }
}

/** Empty fields of the filter form are absent filters, not empty ones. */
function filledParams(params: URLSearchParams): URLSearchParams {
  return new URLSearchParams(
    [...params].filter(([, value]) => value.trim() !== ''),
  )
}

/** One page of the ledger, as the tab shows it. */
function shownOf(
  page: ConsoleResult<ActionPage>,
  name: (page: ActionPage) => readonly NamedActionRecord[] = p => p.entries,
): LedgerShown {
  return page.ok
    ? {
        kind: 'page',
        entries: name(page.value),
        nextBeforeSeq: page.value.nextBeforeSeq,
      }
    : { kind: 'closed' }
}

/** 操作记录: the caller's view of the ledger, and of who read their conversations. */
async function actionsBody(ctx: RouteContext): Promise<string> {
  const principal = ctx.access.principal
  if (principal === null || principal.subject === 'legacy:view') {
    return bar('muted', PERSON_REQUIRED_LINE)
  }
  const ledger = ctx.deps.actions
  if (ledger === undefined) return bar('muted', LEDGER_UNWIRED_LINE)

  const params = filledParams(ctx.url.searchParams)
  const filter: ActionFilterView = {
    ...(params.get('subject') === null
      ? {}
      : { subject: params.get('subject') ?? '' }),
    ...(params.get('action') === null
      ? {}
      : { action: params.get('action') ?? '' }),
    ...(params.get('target') === null
      ? {}
      : { target: params.get('target') ?? '' }),
  }
  const seesAll =
    principal.kind === 'legacy' ||
    (principal.kind === 'user' && principal.role === 'ops')
  const self = principal.kind === 'user' ? principal.subject : undefined
  const listed = ctx.accounts?.book.list()
  const names = namesOf(listed?.ok === true ? listed.value : null)

  const parsed = parseFilters(params)
  let main: LedgerShown
  if (!parsed.ok) {
    main = { kind: 'invalid', message: parsed.message }
  } else {
    const query = everyQuery(ctx, { ...parsed.value, limit: PAGE_LIMIT })
    // Somebody else's subject asked for by a member: nothing can match, and
    // the ledger is still read, so a closed one says so here too.
    main = shownOf(await ledger.list(query ?? { targets: [] }))
  }
  const before = parsed.ok ? parsed.value.beforeSeq : undefined
  const readsCursor = positiveInteger(params.get('readsBefore'), 'readsBefore')
  const readsBefore = readsCursor.ok ? readsCursor.value : undefined

  let reads = ''
  if (principal.kind === 'user') {
    let shown: LedgerShown
    if (!readsCursor.ok) {
      shown = { kind: 'invalid', message: readsCursor.message }
    } else {
      const owned = await readsQuery(ctx, {
        ...(readsBefore === undefined ? {} : { beforeSeq: readsBefore }),
        limit: PAGE_LIMIT,
      })
      shown = owned.ok
        ? shownOf(
            await ledger.list(owned.value),
            page => withReaderNames(page, ctx.accounts).entries,
          )
        : { kind: 'failed', failure: owned.failure }
    }
    reads = renderReads({
      shown,
      filter,
      before,
      readsBefore,
      names,
      self,
      now: ctx.now,
    })
  }

  return (
    `<section class="sec" id="actions-section" aria-labelledby="h-actions">` +
    renderActionFilter(filter, seesAll) +
    renderActionLog({
      shown: main,
      filter,
      before,
      readsBefore,
      seesAll,
      names,
      self,
      now: ctx.now,
    }) +
    `</section>` +
    reads
  )
}

async function accessPage(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<PageRender | Response> {
  const admin = administers(ctx)
  const segment = rest[0]
  const tab: AccessTab | undefined =
    segment === undefined
      ? admin
        ? 'members'
        : 'actions'
      : TAB_OF_SEGMENT[segment]
  if (tab === undefined) return notFound(`unknown path: ${ctx.url.pathname}`)
  const tabs: readonly AccessTab[] = admin ? EVERY_TAB : ['actions']
  const frame = {
    title: '账号与访问',
    ...(segment === undefined ? {} : { crumbs: [{ label: TAB_LABEL[tab] }] }),
    ...(canWrite(ctx.access)
      ? {}
      : { actions: readOnlyNote(ctx.accounts !== undefined) }),
  }
  if (!tabs.includes(tab)) {
    return {
      ...frame,
      status: 403,
      body: renderForbiddenTab(
        ctx.accounts === undefined ? ACCOUNTS_OFF_LINE : ADMIN_ONLY_LINE,
      ),
    }
  }
  const nav = renderAccessTabs(tabs, tab)
  if (tab === 'actions') {
    return { ...frame, body: nav + (await actionsBody(ctx)) }
  }
  const { body, poll } = await adminBody(ctx, tab)
  return { ...frame, body: nav + body, ...(poll ? { poll: true } : {}) }
}

async function handleFragment(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  const denied = guard(ctx.access.credential, 'view', 'guarded')
  if (denied !== null) return denied
  const tab = rest.length === 1 ? FRAGMENT_TABS[rest[0] ?? ''] : undefined
  if (tab === undefined) return notFound(`unknown path: ${ctx.url.pathname}`)
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  if (!administers(ctx)) return fail(403, 'forbidden', ADMIN_ONLY)
  return html(adminFragment(ctx, tab, await bookOf(ctx)))
}

/**
 * 账号与访问: every write goes to the account API, after a confirmation
 * where the act cannot be taken back, and the region it changed is reloaded
 * from the server rather than patched here. A freshly minted link is put into
 * the one field made for it, by `value`, and nowhere else.
 */
const ACCESS_PAGE_JS = `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  if (!qc) return;

  // Subjects come from the server's own markup; anything else is not sent.
  var SUBJECT = /^u:[0-9a-f]{16}$/;
  var INVITE = /^[0-9a-f]{16}$/;

  function refresh(id) {
    var mount = qc.byId(id);
    return mount ? qc.refreshRegion(mount) : null;
  }

  function showLink(link, title) {
    var panel = qc.byId('invite-link');
    var field = qc.byId('invite-link-value');
    if (!panel || !field || typeof link !== 'string' || link.charAt(0) !== '/') return;
    field.value = window.location.origin + link;
    qc.setText('invite-link-title', title);
    panel.hidden = false;
    field.focus();
    field.select();
  }

  qc.onAction('invite-link-copy', function () {
    var field = qc.byId('invite-link-value');
    if (!field || !field.value) return;
    field.select();
    var done = function () { qc.toast('已复制', 'ok'); };
    var manual = function () { qc.toast('复制没有成功 · 链接已选中 · 请手动复制', 'bad'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(field.value).then(done, manual);
    } else {
      manual();
    }
  });

  qc.onAction('invite-link-close', function () {
    var panel = qc.byId('invite-link');
    var field = qc.byId('invite-link-value');
    if (field) field.value = '';
    if (panel) panel.hidden = true;
  });

  qc.onSubmit('invite-form', function (form) {
    var role = form.querySelector('input[name="role"]:checked');
    var ttl = form.querySelector('select[name="ttlHours"]');
    var label = form.querySelector('input[name="label"]');
    var button = form.querySelector('button[type="submit"]');
    var body = {
      role: role ? role.value : 'member',
      ttlHours: ttl ? parseInt(ttl.value, 10) : 72
    };
    var text = label ? label.value.trim() : '';
    if (text) body.label = text;
    if (button) button.disabled = true;
    qc.sendJson('POST', '/v0/accounts/invites', body)
      .then(function (data) {
        showLink(data && data.link, '邀请链接 · 只显示这一次');
        if (label) label.value = '';
        qc.toast('已签发', 'ok');
        return refresh('access-invites');
      })
      .catch(function (err) { qc.toast('签发失败 · ' + qc.message(err), 'bad'); })
      .then(function () { if (button) button.disabled = false; });
  });

  qc.onAction('invite-withdraw', function (el) {
    var id = el.getAttribute('data-invite') || '';
    if (!INVITE.test(id)) return;
    qc.setText('confirm-invite-withdraw-name', id);
    qc.openDialog('confirm-invite-withdraw', function () {
      qc.sendJson('DELETE', '/v0/accounts/invites/' + id)
        .then(function () {
          qc.toast('已作废', 'ok');
          return refresh('access-invites');
        })
        .catch(function (err) { qc.toast('作废失败 · ' + qc.message(err), 'bad'); });
    });
  });

  // One confirmation per act on a person: name them, then do it.
  function onPerson(action, dialog, run) {
    qc.onAction(action, function (el) {
      var subject = el.getAttribute('data-subject') || '';
      if (!SUBJECT.test(subject)) return;
      qc.setText(dialog + '-name', el.getAttribute('data-name') || subject);
      qc.openDialog(dialog, function () { run(subject); });
    });
  }

  onPerson('account-logout', 'confirm-account-logout', function (subject) {
    qc.sendJson('POST', '/v0/accounts/' + subject + '/logout')
      .then(function (data) {
        var ended = data && typeof data.sessions === 'number' ? data.sessions : 0;
        qc.toast('已强制下线 · 结束 ' + ended + ' 个会话', 'ok');
        return refresh('access-sessions');
      })
      .catch(function (err) { qc.toast('强制下线失败 · ' + qc.message(err), 'bad'); });
  });

  onPerson('account-revoke', 'confirm-account-revoke', function (subject) {
    qc.sendJson('POST', '/v0/accounts/' + subject + '/revoke')
      .then(function () {
        qc.toast('已吊销', 'ok');
        return refresh('access-members');
      })
      .catch(function (err) { qc.toast('吊销失败 · ' + qc.message(err), 'bad'); });
  });

  onPerson('account-reset', 'confirm-account-reset', function (subject) {
    qc.sendJson('POST', '/v0/accounts/' + subject + '/reset', {})
      .then(function (data) {
        showLink(data && data.link, '重置链接 · 只显示这一次');
        qc.toast('已重置', 'ok');
        return refresh('access-members');
      })
      .catch(function (err) { qc.toast('重置失败 · ' + qc.message(err), 'bad'); });
  });
})();
`

export const accessRoute: RouteModule = {
  area: {
    id: 'access',
    label: '账号与访问',
    group: 'admin',
    href: '/access',
    icon: 'users',
  },
  page: {
    match: underPath('access', 1),
    guard: 'view',
    render: accessPage,
    css: ACCESS_PAGE_CSS,
    script: ACCESS_PAGE_JS,
  },
  api: {
    heads: ['actions'],
    handle: (ctx, _head, rest) => handleActionsApi(ctx, rest),
  },
  fragments: {
    heads: ['access'],
    handle: (ctx, _head, rest) => handleFragment(ctx, rest),
  },
}
