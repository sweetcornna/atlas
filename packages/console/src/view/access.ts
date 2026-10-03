// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 账号与访问 — who has an account, who is signed in, which invitations are
 * out (H3), and what was done by whom (H4, 操作记录).
 *
 * ## Four tabs, four addresses
 *
 * 成员 is `/access`, the other three are `/access/<tab>`: each tab is its own
 * server-rendered document, so a tab is a link, the browser's back button
 * works, and a reader with script off reads every one of them. The tab bar
 * is drawn only with more than one tab in it — a person who may not
 * administer accounts has exactly one, 操作记录, and a one-item bar is a
 * control that does nothing.
 *
 * ## Only the three administration tabs poll
 *
 * 成员, 邀请 and 会话 are cheap to recompute (the account book is in memory)
 * and change under the reader — somebody signs in, an invitation is redeemed
 * — so they are polled regions like the roster. 操作记录 is not: the ledger is
 * a file read and verified end to end on every query, and a list that scrolls
 * itself away while somebody is reading row 30 is worse than one that waits.
 * It refreshes when asked (a plain link), pages with `before`, and filters
 * with a `GET` form, so all of it works with script off.
 *
 * ## No secret is ever drawn
 *
 * The account list carries no credential and no hash (`accounts.ts`). An
 * invitation's link exists exactly once, in the answer to the request that
 * minted it; the page script puts it into {@link inviteLinkPanel} with
 * `value =` and nothing else ever holds it.
 */

import type { AccountBook, AccountRole } from '../accounts.js'
import {
  CONSOLE_ACTIONS,
  type ActionRecord,
  type ConsoleFailure,
} from '../deps.js'
import {
  absent,
  bar,
  chevron,
  failureBar,
  hint,
  icon,
  railSep,
  scroll,
  sectionHead,
  state,
  tag,
  type Tone,
} from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatDateTime, formatRelative } from './format.js'

type Listing = Extract<ReturnType<AccountBook['list']>, { ok: true }>['value']

/** The account book's list, as the page reads it. */
export type AccessListing = Listing
type AccountRow = Listing['accounts'][number]
type InviteRow = Listing['invites'][number]

/** A ledger entry, with the reader's display name on a `reads` page. */
interface ActionRow extends ActionRecord {
  readonly subjectName?: string
}

/** Who a subject is, in words: a label from the account book, when it has one. */
type Names = ReadonlyMap<string, string>

// ---------------------------------------------------------------------------
// The tabs
// ---------------------------------------------------------------------------

export type AccessTab = 'members' | 'invites' | 'sessions' | 'actions'

export const TAB_LABEL: Readonly<Record<AccessTab, string>> = {
  members: '成员',
  invites: '邀请',
  sessions: '会话',
  actions: '操作记录',
}

/** Where each tab lives. 成员 is the area's own address. */
const TAB_HREF: Readonly<Record<AccessTab, string>> = {
  members: '/access',
  invites: '/access/invites',
  sessions: '/access/sessions',
  actions: '/access/actions',
}

/** The tab bar: plain links, the current one marked. */
export function renderAccessTabs(
  tabs: readonly AccessTab[],
  current: AccessTab,
): string {
  if (tabs.length < 2) return ''
  return (
    `<nav class="access-tabs" aria-label="账号与访问">` +
    tabs
      .map(
        tab =>
          `<a class="access-tab" id="tab-${attr(tab)}" href="${attr(
            TAB_HREF[tab],
          )}" data-nav${tab === current ? ' aria-current="page"' : ''}>` +
          `${escapeHtml(TAB_LABEL[tab])}</a>`,
      )
      .join('') +
    `</nav>`
  )
}

// ---------------------------------------------------------------------------
// Shared cells
// ---------------------------------------------------------------------------

const ROLE_WORD: Readonly<Record<AccountRole, string>> = {
  viewer: '只读',
  member: '成员',
  ops: '运维',
}

function roleTag(role: AccountRole): string {
  return tag(ROLE_WORD[role], role === 'ops' ? 'warn' : 'muted')
}

/** A subject the page has no label for, in words where there are words. */
const BUILT_IN_NAMES: Readonly<Record<string, string>> = {
  'legacy:admin': '管理令牌',
  'legacy:view': '只读令牌',
  anonymous: '未登录',
}

/** The display name of `subject`: a label, a token's name, or the id itself. */
function nameOf(subject: string, names: Names): string {
  return names.get(subject) ?? BUILT_IN_NAMES[subject] ?? subject
}

/**
 * A person: the name over the id, or the id alone when that is all there is.
 * `self` is the reader, who is 你本人 wherever they turn up; `known` is a name
 * the row already carries (a `reads` entry's `subjectName`).
 */
function whoCell(
  subject: string,
  names: Names,
  self?: string,
  known?: string,
): string {
  const name =
    self !== undefined && subject === self
      ? '你本人'
      : (known ?? nameOf(subject, names))
  if (name === subject) {
    return `<td class="who"><span class="mono">${escapeHtml(subject)}</span></td>`
  }
  return (
    `<td class="who"><span class="who-name">${escapeHtml(name)}</span>` +
    `<span class="note mono">${escapeHtml(subject)}</span></td>`
  )
}

/** An instant, with how long ago underneath. */
function whenCell(at: number | null, now: number, never = '从未'): string {
  if (at === null) return `<td class="when note">${escapeHtml(never)}</td>`
  return (
    `<td class="when"><time datetime="${attr(new Date(at).toISOString())}">` +
    `${escapeHtml(formatDateTime(at))}</time>` +
    `<span class="note">${escapeHtml(formatRelative(at, now))}</span></td>`
  )
}

function table(caption: string, headers: readonly string[], rows: string) {
  const head = headers
    .map(name => `<th scope="col">${escapeHtml(name)}</th>`)
    .join('')
  return scroll(
    `<table class="trail access-table"><caption class="sr-only">${escapeHtml(
      caption,
    )}</caption><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`,
  )
}

/** A write button. Drawn only for a writer; `data-write` is what C7 scans. */
function writeButton(
  action: string,
  label: string,
  data: Readonly<Record<string, string>>,
  danger = false,
): string {
  const attrs = Object.entries(data)
    .map(([key, value]) => ` data-${key}="${attr(value)}"`)
    .join('')
  return (
    `<button type="button" class="btn ${
      danger ? 'btn-danger' : 'btn-secondary'
    } btn-small" data-write data-action="${attr(action)}"${attrs}>` +
    `${escapeHtml(label)}</button>`
  )
}

// ---------------------------------------------------------------------------
// States that replace a tab's content
// ---------------------------------------------------------------------------

/** No `--accounts`: there is no book to show. */
export const ACCOUNTS_OFF_LINE =
  '这台控制台没有开启个人账号 · 启动时加 --accounts 才有成员 · 邀请与会话'

/** The book did not verify. Same words as the lit notice (`accountsHttp.ts`). */
export const BOOK_CLOSED_LINE =
  '账号库校验未通过 · 个人账号暂停服务 · 详见控制台错误输出'

/** The ledger refuses writes: every write here would be a 503. */
export const LEDGER_CLOSED_LINE = '账本停用 · 写操作已暂停 · 恢复动作账本后再试'

/** What a caller who may not administer accounts is told on those tabs. */
export const ADMIN_ONLY_LINE = '需要运维角色的个人账号'

/** The 403 body of an administration tab, with the way to the one they have. */
export function renderForbiddenTab(line: string): string {
  return (
    `<section class="card elev-sm stub" aria-labelledby="page-title">` +
    `<p class="note">${escapeHtml(line)}</p>` +
    `<p><a class="jump" href="${attr(TAB_HREF.actions)}" data-nav>` +
    `查看我的操作记录</a></p></section>`
  )
}

// ---------------------------------------------------------------------------
// 成员
// ---------------------------------------------------------------------------

const ACCOUNT_STATE: Readonly<
  Record<AccountRow['state'], readonly [Tone, string]>
> = {
  active: ['ok', '在用'],
  reset: ['warn', '已重置 · 待重新开通'],
  revoked: ['muted', '已吊销'],
}

/** Labels by subject, from the book: the one place a person has a name. */
export function namesOf(listing: Listing | null): Names {
  const names = new Map<string, string>()
  for (const account of listing?.accounts ?? []) {
    if (account.label !== undefined) names.set(account.subject, account.label)
  }
  return names
}

/**
 * Whether a row gets the write buttons. Never on the reader's own row: the
 * API would let an operator revoke or sign out themselves, and a button for
 * it is a way to lock oneself out by a misplaced click.
 */
function controlsFor(
  account: AccountRow,
  canWrite: boolean,
  self: string | undefined,
): boolean {
  return canWrite && account.state !== 'revoked' && account.subject !== self
}

function memberRow(
  account: AccountRow,
  names: Names,
  now: number,
  canWrite: boolean,
  self: string | undefined,
): string {
  const [tone, word] = ACCOUNT_STATE[account.state]
  const name = nameOf(account.subject, names)
  const controls = controlsFor(account, canWrite, self)
    ? `<div class="rowx row-actions">` +
      writeButton('account-reset', '重置', {
        subject: account.subject,
        name,
      }) +
      writeButton(
        'account-revoke',
        '吊销',
        { subject: account.subject, name },
        true,
      ) +
      `</div>`
    : ''
  return (
    `<tr data-key="${attr(account.subject)}" data-state="${attr(
      account.state,
    )}">` +
    whoCell(account.subject, names, self) +
    `<td>${roleTag(account.role)}</td>` +
    `<td>${state(tone, word)}</td>` +
    whenCell(account.lastLoginAt, now, '从未登录') +
    `<td class="num">${escapeHtml(String(account.sessions))}</td>` +
    `<td>${controls}</td>` +
    `</tr>`
  )
}

/** The 成员 fragment: every account, newest first. */
export function renderMembers(model: {
  readonly listing: Listing
  readonly now: number
  readonly canWrite: boolean
  /** The reader, when the reader is a person. */
  readonly self: string | undefined
}): string {
  const { listing, now } = model
  const names = namesOf(listing)
  const count = (state: AccountRow['state']) =>
    listing.accounts.filter(account => account.state === state).length
  const active = count('active')
  const reset = count('reset')
  const revoked = count('revoked')
  const tail =
    `<div class="rowx note">` +
    `<span>在用 ${escapeHtml(String(active))}</span>` +
    railSep() +
    `<span>已重置 ${escapeHtml(String(reset))}</span>` +
    railSep() +
    `<span>已吊销 ${escapeHtml(String(revoked))}</span>` +
    `</div>`
  const body =
    listing.accounts.length === 0
      ? hint('还没有成员 · 在邀请页签签发第一条邀请')
      : table(
          '成员',
          ['成员', '角色', '状态', '最近登录', '会话', '操作'],
          listing.accounts
            .map(account =>
              memberRow(account, names, now, model.canWrite, model.self),
            )
            .join(''),
        )
  return (
    sectionHead('Members', '成员', {
      headingId: 'h-members',
      tail,
      stats: { active, reset, revoked },
    }) + `<div class="pane">${body}</div>`
  )
}

// ---------------------------------------------------------------------------
// 邀请
// ---------------------------------------------------------------------------

/** Closed invitations listed under the open ones; older ones are counted. */
const CLOSED_INVITES_SHOWN = 50

const INVITE_STATE: Readonly<
  Record<InviteRow['state'], readonly [Tone, string]>
> = {
  open: ['ok', '未用'],
  consumed: ['muted', '已开通'],
  expired: ['muted', '已过期'],
  withdrawn: ['muted', '已作废'],
}

function segment(
  name: string,
  choices: readonly (readonly [string, string])[],
  current: string,
): string {
  return (
    `<div class="seg">` +
    choices
      .map(
        ([value, label]) =>
          `<label class="seg-opt"><input type="radio" name="${attr(name)}" ` +
          `value="${attr(value)}"${value === current ? ' checked' : ''}>` +
          `${escapeHtml(label)}</label>`,
      )
      .join('') +
    `</div>`
  )
}

/** How long an invitation lives, in the hours the API takes (≤ 72). */
const TTL_CHOICES: readonly (readonly [string, string])[] = [
  ['1', '1 小时'],
  ['24', '24 小时'],
  ['72', '72 小时'],
]

/** The issue form. Outside the polled region, so a refresh never eats it. */
export function renderInviteForm(): string {
  const ttl = TTL_CHOICES.map(
    ([value, label]) =>
      `<option value="${attr(value)}"${
        value === '72' ? ' selected' : ''
      }>${escapeHtml(label)}</option>`,
  ).join('')
  return (
    `<form id="invite-form" class="card elev-sm invite-form" data-write novalidate>` +
    `<div class="rowx invite-fields">` +
    `<div class="field"><span>角色</span>` +
    segment(
      'role',
      [
        ['viewer', ROLE_WORD.viewer],
        ['member', ROLE_WORD.member],
        ['ops', ROLE_WORD.ops],
      ],
      'member',
    ) +
    `</div>` +
    `<div class="field"><label for="invite-ttl">有效期</label>` +
    `<span class="sel"><select class="input" id="invite-ttl" name="ttlHours">` +
    `${ttl}</select>${chevron()}</span></div>` +
    `<div class="field invite-label"><label for="invite-label">备注</label>` +
    `<input class="input" type="text" id="invite-label" name="label" ` +
    `maxlength="40" autocomplete="off" spellcheck="false" ` +
    `placeholder="姓名或用途 · 最多 40 字"></div>` +
    `<button type="submit" class="btn btn-primary" data-write>` +
    icon('plus', { small: true }) +
    `签发</button>` +
    `</div>` +
    `<p class="note">邀请只能用一次 · 链接只显示一次 · 交给本人确认开通</p>` +
    `</form>`
  )
}

/**
 * Where a freshly minted link is shown, once: after 签发 and after 重置.
 * Rendered empty and hidden; the page script fills the field with `value`.
 */
export function inviteLinkPanel(): string {
  return (
    `<section class="card elev-sm invite-link" id="invite-link" hidden ` +
    `aria-labelledby="invite-link-title">` +
    `<p class="bar bar-warn" role="status">` +
    icon('shield', { small: true }) +
    `<span id="invite-link-title">邀请链接 · 只显示这一次</span></p>` +
    `<div class="field"><label for="invite-link-value">链接</label>` +
    `<input class="input mono" type="text" id="invite-link-value" readonly ` +
    `autocomplete="off" spellcheck="false"></div>` +
    `<div class="rowx">` +
    `<button type="button" class="btn btn-primary btn-small" ` +
    `data-action="invite-link-copy">复制</button>` +
    `<button type="button" class="btn btn-secondary btn-small" ` +
    `data-action="invite-link-close">关闭</button></div>` +
    `<p class="note">链接里带着邀请码 · 请私下交给本人 · 关闭后不能再看到</p>` +
    `</section>`
  )
}

/** Uses an invitation has left: it is single-use, so one or none. */
function usesLeft(invite: InviteRow): number {
  return invite.state === 'open' ? 1 : 0
}

function inviteNote(invite: InviteRow, names: Names): string {
  if (invite.subject !== undefined) {
    return `重置 · ${nameOf(invite.subject, names)}`
  }
  return invite.label ?? ''
}

function inviteRow(
  invite: InviteRow,
  names: Names,
  now: number,
  canWrite: boolean,
): string {
  const [tone, word] = INVITE_STATE[invite.state]
  const note = inviteNote(invite, names)
  const control =
    canWrite && invite.state === 'open'
      ? writeButton('invite-withdraw', '作废', { invite: invite.inviteId })
      : ''
  return (
    `<tr data-key="${attr(invite.inviteId)}" data-state="${attr(
      invite.state,
    )}">` +
    `<td class="mono">${escapeHtml(invite.inviteId)}</td>` +
    `<td>${roleTag(invite.role)}</td>` +
    `<td>${note === '' ? absent() : escapeHtml(note)}</td>` +
    `<td>${escapeHtml(nameOf(invite.issuedBy, names))}</td>` +
    whenCell(invite.issuedAt, now) +
    whenCell(invite.expiresAt, now) +
    `<td>${state(tone, word)}</td>` +
    `<td class="num">${escapeHtml(String(usesLeft(invite)))}</td>` +
    `<td>${control}</td>` +
    `</tr>`
  )
}

/** The 邀请 fragment: the open ones first, then the most recent closed ones. */
export function renderInvites(model: {
  readonly listing: Listing
  readonly now: number
  readonly canWrite: boolean
  /** The book's cap on open invitations (`MAX_OPEN_INVITES`). */
  readonly cap: number
}): string {
  const { listing, now } = model
  const names = namesOf(listing)
  const open = listing.invites.filter(invite => invite.state === 'open')
  const closed = listing.invites.filter(invite => invite.state !== 'open')
  const shown = [...open, ...closed.slice(0, CLOSED_INVITES_SHOWN)]
  const hidden = closed.length - Math.min(closed.length, CLOSED_INVITES_SHOWN)
  const left = Math.max(0, model.cap - open.length)
  const tail =
    `<div class="rowx note">` +
    `<span>未用 ${escapeHtml(String(open.length))}</span>` +
    railSep() +
    `<span>还可签发 ${escapeHtml(String(left))}</span>` +
    `</div>`
  const body =
    shown.length === 0
      ? hint('还没有签发过邀请')
      : table(
          '邀请',
          [
            '邀请',
            '角色',
            '备注',
            '签发人',
            '签发于',
            '到期',
            '状态',
            '剩余次数',
            '操作',
          ],
          shown
            .map(invite => inviteRow(invite, names, now, model.canWrite))
            .join(''),
        ) +
        (hidden > 0
          ? `<p class="note">另有 ${escapeHtml(String(hidden))} 条更早的邀请未列出</p>`
          : '')
  return (
    sectionHead('Invites', '邀请', {
      headingId: 'h-invites',
      tail,
      stats: { open: open.length, left },
    }) + `<div class="pane">${body}</div>`
  )
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

function sessionRow(
  account: AccountRow,
  names: Names,
  now: number,
  canWrite: boolean,
  self: string | undefined,
): string {
  const name = nameOf(account.subject, names)
  return (
    `<tr data-key="${attr(account.subject)}">` +
    whoCell(account.subject, names, self) +
    `<td>${roleTag(account.role)}</td>` +
    `<td class="num">${escapeHtml(String(account.sessions))}</td>` +
    `<td class="num">${escapeHtml(String(account.streams))}</td>` +
    whenCell(account.lastLoginAt, now, '从未登录') +
    whenCell(account.lastSeenAt, now, '无活动会话') +
    `<td>${
      controlsFor(account, canWrite, self)
        ? writeButton(
            'account-logout',
            '强制下线',
            { subject: account.subject, name },
            true,
          )
        : ''
    }</td>` +
    `</tr>`
  )
}

/** The 会话 fragment: every person signed in or holding a live stream. */
export function renderSessions(model: {
  readonly listing: Listing
  readonly now: number
  readonly canWrite: boolean
  readonly self: string | undefined
}): string {
  const { listing, now } = model
  const names = namesOf(listing)
  const online = listing.accounts.filter(
    account =>
      account.state !== 'revoked' &&
      (account.sessions > 0 || account.streams > 0),
  )
  const sessions = online.reduce((sum, account) => sum + account.sessions, 0)
  const streams = online.reduce((sum, account) => sum + account.streams, 0)
  const tail =
    `<div class="rowx note">` +
    `<span>在线 ${escapeHtml(String(online.length))} 人</span>` +
    railSep() +
    `<span>会话 ${escapeHtml(String(sessions))}</span>` +
    railSep() +
    `<span>实时连接 ${escapeHtml(String(streams))}</span>` +
    `</div>`
  const body =
    online.length === 0
      ? hint('没有在线的成员')
      : table(
          '登录会话',
          ['成员', '角色', '会话', '实时连接', '最近登录', '最近活动', '操作'],
          online
            .map(account =>
              sessionRow(account, names, now, model.canWrite, model.self),
            )
            .join(''),
        )
  return (
    sectionHead('Sessions', '登录会话', {
      headingId: 'h-sessions',
      tail,
      stats: { online: online.length, sessions, streams },
    }) +
    `<div class="pane">${body}` +
    `<p class="note">会话是浏览器登录 · 闲置 2 小时或登录满 12 小时自动结束 · ` +
    `实时连接含用个人凭据直连的脚本</p></div>`
  )
}

// ---------------------------------------------------------------------------
// The confirmations
// ---------------------------------------------------------------------------

function confirmDialog(options: {
  readonly id: string
  readonly glyph: string
  readonly title: string
  readonly recapLabel: string
  readonly line: string
  readonly confirm: string
}): string {
  const { id } = options
  return (
    `<dialog class="dialog" id="${attr(id)}" aria-labelledby="${attr(
      `${id}-title`,
    )}">` +
    `<div class="dlg-top"><span class="dlg-icon">` +
    icon(options.glyph) +
    `</span><div class="dialog-title" id="${attr(`${id}-title`)}">` +
    `${escapeHtml(options.title)}</div></div>` +
    `<div class="dialog-body">` +
    `<div class="recap"><div class="recap-row"><span class="k">` +
    `${escapeHtml(options.recapLabel)}</span>` +
    `<span class="mono" id="${attr(`${id}-name`)}"></span></div></div>` +
    `<p>${escapeHtml(options.line)}</p>` +
    `</div>` +
    `<div class="dialog-actions">` +
    `<button type="button" class="btn btn-secondary" ` +
    `data-action="confirm-cancel">取消</button>` +
    `<button type="button" class="btn btn-danger" ` +
    `data-action="${attr(id)}" data-write>${escapeHtml(options.confirm)}</button>` +
    `</div></dialog>`
  )
}

/** Every confirmation the writer's tabs open. Outside every polled region. */
export function accessDialogs(): string {
  return (
    confirmDialog({
      id: 'confirm-account-logout',
      glyph: 'log-out',
      title: '强制下线',
      recapLabel: '成员',
      line:
        '结束该成员的全部登录会话与实时连接 · 个人凭据仍然有效 · ' +
        '要阻止再次登录请吊销或重置',
      confirm: '强制下线',
    }) +
    confirmDialog({
      id: 'confirm-account-revoke',
      glyph: 'power',
      title: '吊销账号',
      recapLabel: '成员',
      line: '凭据与全部会话立即失效 · 实时连接断开 · 吊销不能撤回',
      confirm: '吊销',
    }) +
    confirmDialog({
      id: 'confirm-account-reset',
      glyph: 'refresh-cw',
      title: '重置凭据',
      recapLabel: '成员',
      line: '旧凭据与全部会话立即失效 · 生成一条新邀请交给本人重新开通 · 角色不变',
      confirm: '重置',
    }) +
    confirmDialog({
      id: 'confirm-invite-withdraw',
      glyph: 'x',
      title: '作废邀请',
      recapLabel: '邀请',
      line: '这条邀请立即失效 · 已开通的账号不受影响',
      confirm: '作废',
    })
  )
}

// ---------------------------------------------------------------------------
// 操作记录
// ---------------------------------------------------------------------------

/** What each verb did, in words. A verb not here is shown as itself. */
const ACTION_WORD: Readonly<Partial<Record<string, string>>> = {
  'agent.register': '注册智能体',
  'agent.deregister': '注销智能体',
  'agent.heartbeat': '心跳',
  'wake.send': '唤醒',
  'server.note.set': '写服务器备注',
  'chat.session.open': '新建对话',
  'chat.message.send': '发送消息',
  'chat.command.autocompact': '设置自动压缩',
  'chat.command.compact': '压缩对话',
  'chat.command.context': '查看上下文',
  'chat.transcript.open': '打开转录',
  'breakglass.request': 'break-glass 请求',
  'alert.ack': '确认告警',
}

/** The account API's writes are one verb per method; the path says which. */
const ACCOUNT_PATHS: readonly (readonly [RegExp, string, string])[] = [
  [/^\/invites$/, 'accounts.post', '签发邀请'],
  [/^\/invites\/[^/]+$/, 'accounts.delete', '作废邀请'],
  [/^\/[^/]+\/revoke$/, 'accounts.post', '吊销账号'],
  [/^\/[^/]+\/reset$/, 'accounts.post', '重置凭据'],
  [/^\/[^/]+\/logout$/, 'accounts.post', '强制下线'],
]

function actionWord(action: string, target: string): string {
  for (const [path, verb, word] of ACCOUNT_PATHS) {
    if (action === verb && path.test(target)) return word
  }
  if (action.startsWith('accounts.')) return '账号管理'
  return ACTION_WORD[action] ?? action
}

/** The filter's choices: one per verb family the ledger knows. */
const FAMILY_WORD: Readonly<Partial<Record<string, string>>> = {
  agent: '智能体',
  wake: '唤醒',
  server: '服务器备注',
  chat: '对话',
  accounts: '账号',
  breakglass: 'break-glass',
  alert: '告警',
}

function families(): readonly (readonly [string, string])[] {
  const seen: string[] = []
  for (const verb of CONSOLE_ACTIONS) {
    const head = verb.slice(0, verb.indexOf('.'))
    if (head !== '' && !seen.includes(head)) seen.push(head)
  }
  return seen.map(head => [`${head}.`, FAMILY_WORD[head] ?? head] as const)
}

const OUTCOME: Readonly<
  Record<ActionRecord['outcome'], readonly [Tone, string]>
> = {
  ok: ['ok', '成功'],
  refused: ['warn', '被拒'],
  failed: ['bad', '失败'],
}

/** The filters the page was asked for, as they go back into links. */
export interface ActionFilterView {
  readonly subject?: string
  readonly action?: string
  readonly target?: string
}

/** The query string for `/access/actions` with these filters and cursors. */
function actionsHref(
  filter: ActionFilterView,
  cursor: { readonly before?: number; readonly readsBefore?: number } = {},
): string {
  const params = new URLSearchParams()
  if (filter.subject !== undefined) params.set('subject', filter.subject)
  if (filter.action !== undefined) params.set('action', filter.action)
  if (filter.target !== undefined) params.set('target', filter.target)
  if (cursor.before !== undefined) params.set('before', String(cursor.before))
  if (cursor.readsBefore !== undefined) {
    params.set('readsBefore', String(cursor.readsBefore))
  }
  const query = params.toString()
  return `${TAB_HREF.actions}${query === '' ? '' : `?${query}`}`
}

/** The filter bar: a plain `GET` form. Only a reader who sees all may name a subject. */
export function renderActionFilter(
  filter: ActionFilterView,
  seesAll: boolean,
): string {
  const options = [['', '全部'] as const, ...families()]
    .map(
      ([value, label]) =>
        `<option value="${attr(value)}"${
          value === (filter.action ?? '') ? ' selected' : ''
        }>${escapeHtml(label)}</option>`,
    )
    .join('')
  // A prefix the select does not offer (a hand-written URL) is kept, not lost.
  const extra =
    filter.action !== undefined &&
    !families().some(([value]) => value === filter.action)
      ? `<option value="${attr(filter.action)}" selected>${escapeHtml(
          filter.action,
        )}</option>`
      : ''
  return (
    `<form id="actions-filter" class="actions-filter" method="get" ` +
    `action="${attr(TAB_HREF.actions)}">` +
    `<div class="rowx" style="gap:var(--space-4);align-items:flex-end">` +
    (seesAll
      ? `<div class="field"><label for="actions-subject">主体</label>` +
        `<input class="input mono" type="text" id="actions-subject" ` +
        `name="subject" value="${attr(filter.subject ?? '')}" ` +
        `autocomplete="off" spellcheck="false" placeholder="u:… 或 legacy:admin"></div>`
      : '') +
    `<div class="field"><label for="actions-action">动作</label>` +
    `<span class="sel"><select class="input" id="actions-action" name="action">` +
    `${options}${extra}</select>${chevron()}</span></div>` +
    `<div class="field"><label for="actions-target">目标</label>` +
    `<input class="input mono" type="text" id="actions-target" name="target" ` +
    `value="${attr(filter.target ?? '')}" autocomplete="off" spellcheck="false" ` +
    `placeholder="会话 id · 地址 · 路径"></div>` +
    `<button type="submit" class="btn btn-primary">筛选</button>` +
    `<a class="btn btn-secondary" href="${attr(
      TAB_HREF.actions,
    )}" data-nav>清除</a>` +
    `</div></form>`
  )
}

function resultCell(entry: ActionRecord): string {
  const [tone, word] = OUTCOME[entry.outcome]
  return (
    `<td class="result">${state(tone, word)}` +
    (entry.code === undefined
      ? ''
      : ` <code class="note">${escapeHtml(entry.code)}</code>`) +
    `</td>`
  )
}

function actionRow(
  entry: ActionRow,
  names: Names,
  now: number,
  self: string | undefined,
): string {
  const word = actionWord(entry.action, entry.target)
  return (
    `<tr data-key="${attr(String(entry.seq))}" data-outcome="${attr(
      entry.outcome,
    )}">` +
    whenCell(entry.at, now) +
    whoCell(entry.subject, names, self, entry.subjectName) +
    `<td class="act"><span>${escapeHtml(word)}</span>` +
    (entry.breakGlass === true ? ` ${tag('break-glass', 'warn')}` : '') +
    (word === entry.action
      ? ''
      : `<span class="note mono">${escapeHtml(entry.action)}</span>`) +
    `</td>` +
    `<td class="target mono">${escapeHtml(entry.target)}</td>` +
    resultCell(entry) +
    `<td class="rid mono">${escapeHtml(entry.requestId)}</td>` +
    `</tr>`
  )
}

/** One page of the ledger, or why there is none. */
export type LedgerShown =
  | {
      readonly kind: 'page'
      readonly entries: readonly ActionRow[]
      readonly nextBeforeSeq: number | null
    }
  | { readonly kind: 'closed' }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'failed'; readonly failure: ConsoleFailure }

/** The state badge a ledger section carries in its header. */
function ledgerBadge(shown: LedgerShown): string {
  return shown.kind === 'closed'
    ? `<span id="ledger-state">${state('bad', '账本停用')}</span>`
    : ''
}

/** The words for a ledger the console verified and refused to read. */
const LEDGER_UNREADABLE_LINE =
  '账本停用 · 动作账本校验没有通过 · 已告警运维 · 写操作已暂停'

function ledgerBody(
  shown: LedgerShown,
  rows: (entries: readonly ActionRow[]) => string,
  empty: string,
  more: (next: number) => string,
): string {
  switch (shown.kind) {
    case 'closed':
      return `<p class="bar bar-bad" role="alert">${escapeHtml(
        LEDGER_UNREADABLE_LINE,
      )}</p>`
    case 'invalid':
      return bar('warn', `筛选条件无效 · ${shown.message}`)
    case 'failed':
      return failureBar(shown.failure, '对话列表')
    case 'page':
      if (shown.entries.length === 0) return hint(empty)
      return (
        rows(shown.entries) +
        (shown.nextBeforeSeq === null ? '' : more(shown.nextBeforeSeq))
      )
  }
}

/** 操作记录: the list, its pager and the way to refresh it. */
export function renderActionLog(model: {
  readonly shown: LedgerShown
  readonly filter: ActionFilterView
  readonly before: number | undefined
  readonly readsBefore: number | undefined
  readonly seesAll: boolean
  readonly names: Names
  readonly self: string | undefined
  readonly now: number
}): string {
  const { shown, filter } = model
  const filtered =
    filter.subject !== undefined ||
    filter.action !== undefined ||
    filter.target !== undefined
  const refresh = actionsHref(
    filter,
    model.readsBefore === undefined ? {} : { readsBefore: model.readsBefore },
  )
  const tail =
    `<div class="rowx note">` +
    ledgerBadge(shown) +
    `<span>${model.seesAll ? '全部主体' : '只列出你本人的操作'}</span>` +
    railSep() +
    `<a href="${attr(refresh)}" data-nav id="actions-refresh">` +
    icon('refresh-cw', { small: true }) +
    `刷新</a>` +
    `</div>`
  const pager = (next: number) =>
    `<div class="rowx pager">` +
    (model.before === undefined
      ? ''
      : `<a class="btn btn-secondary btn-small" href="${attr(refresh)}" data-nav>回到最新</a>`) +
    `<a class="btn btn-secondary btn-small" id="actions-older" href="${attr(
      actionsHref(filter, {
        before: next,
        ...(model.readsBefore === undefined
          ? {}
          : { readsBefore: model.readsBefore }),
      }),
    )}" data-nav>更早</a></div>`
  const body = ledgerBody(
    shown,
    entries =>
      table(
        '操作记录',
        ['时间', '主体', '动作', '目标', '结果', 'requestId'],
        entries
          .map(entry => actionRow(entry, model.names, model.now, model.self))
          .join(''),
      ),
    filtered ? '没有符合条件的记录' : '还没有操作记录',
    pager,
  )
  // Paged back with nothing older left: still offer the way back to the top.
  const back =
    shown.kind === 'page' &&
    shown.nextBeforeSeq === null &&
    model.before !== undefined
      ? `<div class="rowx pager"><a class="btn btn-secondary btn-small" ` +
        `href="${attr(refresh)}" data-nav>回到最新</a></div>`
      : ''
  return (
    sectionHead('Actions', '操作记录', {
      id: 'actions-head',
      headingId: 'h-actions',
      tail,
    }) +
    `<div class="pane" id="actions-body">${body}${back}` +
    `<p class="note">列表不自动刷新 · 点刷新读取最新</p></div>`
  )
}

/** 谁读了我的对话: the openings of the reader's own conversations. */
export function renderReads(model: {
  readonly shown: LedgerShown
  readonly filter: ActionFilterView
  readonly before: number | undefined
  readonly readsBefore: number | undefined
  readonly names: Names
  readonly self: string | undefined
  readonly now: number
}): string {
  const { shown } = model
  const cursor = model.before === undefined ? {} : { before: model.before }
  const more = (next: number) =>
    `<div class="rowx pager">` +
    (model.readsBefore === undefined
      ? ''
      : `<a class="btn btn-secondary btn-small" href="${attr(
          actionsHref(model.filter, cursor),
        )}" data-nav>回到最新</a>`) +
    `<a class="btn btn-secondary btn-small" id="reads-older" href="${attr(
      actionsHref(model.filter, { ...cursor, readsBefore: next }),
    )}" data-nav>更早</a></div>`
  const body = ledgerBody(
    shown,
    entries =>
      table(
        '谁读了我的对话',
        ['时间', '读者', '对话', 'requestId'],
        entries
          .map(
            entry =>
              `<tr data-key="${attr(String(entry.seq))}">` +
              whenCell(entry.at, model.now) +
              whoCell(
                entry.subject,
                model.names,
                model.self,
                entry.subjectName,
              ) +
              `<td class="target mono">${escapeHtml(entry.target)}</td>` +
              `<td class="rid mono">${escapeHtml(entry.requestId)}</td>` +
              `</tr>`,
          )
          .join(''),
      ),
    '还没有人打开过你的对话',
    more,
  )
  return (
    `<section class="sec" id="reads-section" aria-labelledby="h-reads">` +
    sectionHead('Reads', '谁读了我的对话', {
      headingId: 'h-reads',
      sub: true,
      tail:
        `<div class="rowx note">${ledgerBadge(shown)}` +
        `<span>每打开一次转录记一条 · 刷新不重复记</span></div>`,
    }) +
    `<div class="pane" id="reads-body">${body}</div></section>`
  )
}

/** The page's own rules (`routes/types.ts`, `PageRoute.css`). */
export const ACCESS_PAGE_CSS = `
.access-tabs { display: flex; gap: var(--space-1); flex-wrap: wrap; border-bottom: 1px solid var(--color-divider); }
.access-tab {
  padding: var(--space-2) var(--space-4); color: var(--color-muted); text-decoration: none;
  border-bottom: 2px solid transparent; margin-bottom: -1px; font-weight: 600;
}
.access-tab:hover { color: var(--color-text); }
.access-tab[aria-current="page"] { color: var(--color-text); border-bottom-color: var(--color-accent); }
.access-table td { vertical-align: top; }
.access-table td.when { white-space: nowrap; }
.access-table td.when time { display: block; font-family: var(--font-mono); font-size: 12px; }
.access-table td.who { display: table-cell; }
.access-table .who-name { display: block; font-weight: 600; }
.access-table td.num { font-variant-numeric: tabular-nums; }
.access-table td.target, .access-table td.rid { overflow-wrap: anywhere; font-size: 12px; }
.access-table td.act .note { display: block; }
.access-table tr[data-state="revoked"] td { color: var(--color-muted); }
.row-actions { gap: var(--space-2); flex-wrap: nowrap; }
.invite-form { padding: var(--space-4); }
.invite-fields { gap: var(--space-4); align-items: flex-end; }
.invite-label { flex: 1 1 14rem; }
.invite-link { padding: var(--space-4); }
.invite-link[hidden] { display: none; }
.pager { justify-content: flex-end; gap: var(--space-2); padding-top: var(--space-2); }
`
