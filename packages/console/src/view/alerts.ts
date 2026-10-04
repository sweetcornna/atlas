// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 告警 — the inbox (J5): what came in, what the console can see is wrong, and
 * which of it somebody has already looked at.
 *
 * ## Two kinds of entry, one list
 *
 * - **Notices** arrive. An agent on a watch job decided a person should hear
 *   about something and called `qianmo_notify`; `qm watch` received it and
 *   wrote it into the hub's trail (`console.md` §10.1.3). They are history:
 *   each one stays in the inbox until it scrolls out of the window.
 * - **Conditions** are read off what this console already watches: a node
 *   whose every lease has lapsed, a certificate about to expire, a trail that
 *   does not verify, a registration ledger that cannot be read or saved. They
 *   are the present: one disappears when the thing it describes stops being
 *   true.
 *
 * Both are sorted by one rule (level first, then the newest) and filtered by
 * one ruler — the three levels of the protocol's `notify.severity`. An inbox
 * with two lists teaches its reader to look at one of them.
 *
 * ## Unread is "not acknowledged"
 *
 * There is no per-person read state: an alert is something one operator takes
 * and the rest can stop worrying about, so acknowledging it is the one act that
 * changes it, and the count of the ones nobody has acknowledged is the badge.
 * A condition's id names its *episode* — the node and the heartbeat it went
 * quiet after, the certificate and the instant it expires — so a node that
 * comes back and goes quiet again is a new, unread alert rather than one
 * somebody acknowledged last week.
 *
 * ## Every source states whether it is there
 *
 * A source that is not wired and a source with nothing to say both produce no
 * rows. The strip under the inbox names every source and which of the two it
 * is — including 链路, which this console has no data for at all and says so
 * rather than leaving it out.
 */

import type {
  AlertAck,
  AlertLevel,
  AuditPage,
  CertificateSnapshot,
  CertificateStatus,
  ConsoleAgent,
  ConsoleCaRoot,
  ConsoleFailure,
  ConsoleResult,
  LifecycleSnapshot,
  NoticeFeed,
} from '../deps.js'
import { bareNode } from './agents.js'
import {
  failureBar,
  hint,
  railSep,
  rawDetail,
  reasonOf,
  sectionHead,
  splitAddress,
  state,
  toned,
  type Tone,
  timeTag,
} from './bits.js'
import { STATUS_WORD as CERTIFICATE_STATUS_WORD } from './certificates.js'
import { attr, escapeHtml } from './escape.js'
import { ledgerClosed } from './node.js'
import {
  agentHealth,
  formatDateTime,
  formatRelative,
  formatShortDuration,
  zoneLabel,
} from './format.js'

/** Most recent notices one page reads. The total beyond it is still stated. */
export const NOTICE_LIMIT = 200

/** Strongest first: the order of the filter and of the list. */
const ALERT_LEVELS: readonly AlertLevel[] = ['error', 'warn', 'info']

const LEVEL_WORD: Readonly<Record<AlertLevel, string>> = {
  error: '严重',
  warn: '警告',
  info: '提示',
}

const LEVEL_TONE: Readonly<Record<AlertLevel, Tone>> = {
  error: 'critical',
  warn: 'warn',
  info: 'muted',
}

const LEVEL_RANK: Readonly<Record<AlertLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
}

/** Where an entry came from. Also the label the row carries. */
export type AlertOrigin =
  | 'notice'
  | 'node'
  | 'certificate'
  | 'audit'
  | 'registrations'

const ORIGIN_WORD: Readonly<Record<AlertOrigin, string>> = {
  notice: '通知',
  node: '注册中心',
  certificate: '证书',
  audit: '审计链',
  registrations: '登记簿',
}

/** One entry of the inbox, as the page and `/v0/alerts` show it. */
export interface ConsoleAlert {
  readonly id: string
  readonly level: AlertLevel
  readonly origin: AlertOrigin
  /** What, and where: one line. */
  readonly title: string
  /** One more line of fact, when there is one. */
  readonly detail?: string
  /**
   * The original words behind `detail`, when a port's own text was turned
   * into a short line (`view/errors.ts`, C5): folded under 详情.
   */
  readonly raw?: string
  /**
   * When it happened, when that is known: a notice's arrival, a lease's lapse,
   * an expiry. Absent for a condition with no instant of its own.
   */
  readonly at?: number
  /** When it was acknowledged. Absent means unread. */
  readonly ackedAt?: number
}

/** One trail as `routes/shared.ts` `readAuditSources` hands it over. */
interface AlertAuditRead {
  readonly node: string
  readonly page: AuditPage | null
  readonly failure: ConsoleFailure | null
}

/** Everything the inbox is computed from. Absent ports are absent fields. */
interface AlertInputs {
  readonly now: number
  /** The registry's default lease, for records that carry none. */
  readonly ttlMs: number
  readonly roster: ConsoleResult<readonly ConsoleAgent[]>
  /** Absent when this console has no certificate column (no `--trust-ca`). */
  readonly certificates?: {
    readonly snapshot: ConsoleResult<CertificateSnapshot>
    readonly roots: readonly ConsoleCaRoot[]
  }
  readonly audits: readonly AlertAuditRead[]
  /** The registration ledger; absent when `deps.lifecycle` is not wired. */
  readonly registrations?: LifecycleSnapshot
  /** Absent when `deps.notify` is not wired. */
  readonly notices?: ConsoleResult<NoticeFeed>
  /** Absent when `deps.notify` is not wired. */
  readonly acks?: ConsoleResult<readonly AlertAck[]>
}

/** How one source of alerts stands, for the strip under the inbox. */
export interface AlertSource {
  readonly label: string
  readonly tone: Tone
  readonly text: string
}

/** The whole inbox, before any filter. */
export interface AlertBoard {
  /** Every alert, sorted: strongest level first, then the newest. */
  readonly alerts: readonly ConsoleAlert[]
  readonly unread: number
  /** True when an acknowledgement can be recorded and read back. */
  readonly ackable: boolean
  readonly sources: readonly AlertSource[]
  /** Lines that qualify the whole list: a trail that did not verify, acks unread. */
  readonly warnings: readonly string[]
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

function usable(at: number | undefined): at is number {
  return at !== undefined && Number.isFinite(at) && at > 0
}

/**
 * 节点失联: every agent a node registered has an expired lease.
 *
 * Per node, not per agent — three agents on one dead machine are one problem,
 * and the roster already shows the partial cases (one agent of three gone
 * quiet) row by row. The episode is the latest heartbeat any of them gave.
 */
function nodeAlerts(
  agents: readonly ConsoleAgent[],
  now: number,
  ttlMs: number,
): ConsoleAlert[] {
  const byNode = new Map<string, ConsoleAgent[]>()
  for (const agent of agents) {
    const node = bareNode(splitAddress(agent.address).node)
    const bucket = byNode.get(node)
    if (bucket === undefined) byNode.set(node, [agent])
    else bucket.push(agent)
  }
  const out: ConsoleAlert[] = []
  for (const [node, list] of byNode) {
    if (!list.every(one => agentHealth(one, now, ttlMs) === 'expired')) continue
    const beats = list.map(one => one.lastHeartbeatAt).filter(usable)
    const lapses = list.map(one => one.expiresAt).filter(usable)
    const lastBeat = beats.length === 0 ? undefined : Math.max(...beats)
    const lapsed = lapses.length === 0 ? undefined : Math.max(...lapses)
    out.push({
      id: `node-lost:${node}:${lastBeat ?? 0}`,
      level: 'error',
      origin: 'node',
      title: `节点失联 · ${node}`,
      detail:
        lastBeat === undefined
          ? '从未心跳'
          : `最后心跳 ${formatRelative(lastBeat, now)}`,
      ...(lapsed === undefined ? {} : { at: lapsed }),
    })
  }
  return out
}

/** How loud each certificate state is. `valid` raises nothing. */
const CERTIFICATE_LEVEL: Readonly<
  Record<Exclude<CertificateStatus, 'valid'>, AlertLevel>
> = {
  expiring: 'warn',
  'expiring-urgent': 'error',
  expired: 'error',
  revoked: 'warn',
  'bad-signature': 'error',
  absent: 'info',
}

const CERTIFICATE_DETAIL: Readonly<Partial<Record<CertificateStatus, string>>> =
  {
    revoked: '这把钥匙已被主动作废',
    'bad-signature': '注册中心里的证书不是本 CA 签发',
    absent: '节点还没有发布证书',
  }

function expiryDetail(notAfter: number | undefined, now: number): string {
  if (!usable(notAfter)) return ''
  return notAfter > now
    ? `剩余 ${formatShortDuration(notAfter - now)}`
    : `到期于 ${zoned(notAfter)}`
}

/**
 * An instant inside a detail line. The line is also `/v0/alerts` data and is
 * not redrawn in the reader's zone, so it names its own (时区).
 */
function zoned(at: number): string {
  return `${formatDateTime(at)} ${zoneLabel(at)}`
}

function certificateAlerts(
  snapshot: CertificateSnapshot,
  now: number,
): ConsoleAlert[] {
  const out: ConsoleAlert[] = []
  for (const one of snapshot.certificates) {
    if (one.status === 'valid') continue
    const detail =
      CERTIFICATE_DETAIL[one.status] ?? expiryDetail(one.notAfter, now)
    out.push({
      id: `cert:${one.node}:${one.status}:${one.notAfter ?? one.fingerprint256 ?? '-'}`,
      level: CERTIFICATE_LEVEL[one.status],
      origin: 'certificate',
      title: `证书${CERTIFICATE_STATUS_WORD[one.status]} · ${one.node}`,
      ...(detail === '' ? {} : { detail }),
      ...(one.status === 'expired' && usable(one.notAfter)
        ? { at: one.notAfter }
        : {}),
    })
  }
  const list = snapshot.revocationList
  if (list === null) {
    out.push({
      id: 'rl:absent',
      level: 'warn',
      origin: 'certificate',
      title: '吊销清单未发布',
      detail: '全网按 --trust 收敛',
    })
  } else if (now >= list.nextUpdate) {
    out.push({
      id: `rl:stale:${list.nextUpdate}`,
      level: 'error',
      origin: 'certificate',
      title: '吊销清单已过期',
      detail: `应于 ${zoned(list.nextUpdate)} 更新`,
      at: list.nextUpdate,
    })
  }
  return out
}

function rootAlerts(
  roots: readonly ConsoleCaRoot[],
  now: number,
): ConsoleAlert[] {
  return roots
    .filter(root => root.status !== 'valid')
    .map(root => {
      const detail =
        root.status === 'expired'
          ? '所签证书一并失效'
          : expiryDetail(root.notAfter, now)
      return {
        id: `ca-root:${root.subject}:${root.status}:${root.notAfter}`,
        level: root.status === 'expiring' ? 'warn' : 'error',
        origin: 'certificate',
        title: `CA 根${CERTIFICATE_STATUS_WORD[root.status]} · ${root.subject}`,
        ...(detail === '' ? {} : { detail }),
        ...(root.status === 'expired' ? { at: root.notAfter } : {}),
      }
    })
}

/**
 * Which occurrence of an anchor mismatch this is: the first anchor seq that
 * disagrees and what the chain holds there now. A chain repaired and rewritten
 * again differs in one or the other, so it is a new alert rather than one the
 * earlier acknowledgement already covers. `-` when the port did not say.
 */
function episodeOf(
  first: { readonly seq: number; readonly actual: string | null } | undefined,
): string {
  if (first === undefined) return '-'
  return `${first.seq}:${first.actual === null ? 'missing' : first.actual.slice(0, 16)}`
}

/**
 * 审计链: a chain that does not verify, an anchor that disagrees, a trail that
 * never arrived. A witness that is merely behind is the trail page's business,
 * not an alarm — an idle node is behind by design.
 */
function auditAlerts(audits: readonly AlertAuditRead[]): ConsoleAlert[] {
  const out: ConsoleAlert[] = []
  for (const source of audits) {
    const page = source.page
    if (page === null) continue
    if (page.chain === 'broken') {
      out.push({
        id: `audit-broken:${source.node}:${page.issueCount}`,
        level: 'error',
        origin: 'audit',
        title: `审计链断裂 · ${source.node}`,
        detail: `${page.issueCount} 处校验不过`,
      })
    } else if (page.chain === 'absent') {
      out.push({
        id: `audit-absent:${source.node}`,
        level: 'warn',
        origin: 'audit',
        title: `审计链未建立 · ${source.node}`,
        detail: '没有链文件 · 节点从未写过或副本从未到达',
      })
    }
    if (page.witness?.tampered === true) {
      const first = page.witness.firstMismatch
      out.push({
        id: `witness-tampered:${source.node}:${episodeOf(first)}`,
        level: 'error',
        origin: 'audit',
        title: `锚点不符 · ${source.node}`,
        detail:
          first === undefined
            ? '链上内容与见证锚点对不上'
            : `链上内容与见证锚点对不上 · 自第 ${first.seq} 条起`,
      })
    }
  }
  return out
}

/** Most of a ledger problem an alert id carries; ids stay well under 256. */
const PROBLEM_IN_ID = 160

/**
 * 登记簿: a registration ledger with a problem (`console.md` §7.3.2). One
 * alert, `error` either way: unreadable means no exit dials anybody;
 * unwritable means the pauses and retirements made since will not survive a
 * restart. The id is the kind and the reason, so a ledger repaired and broken
 * again in another way is a new alert.
 */
function registrationAlerts(snapshot: LifecycleSnapshot): ConsoleAlert[] {
  const problem = snapshot.problem
  if (problem === null) return []
  const closed = ledgerClosed(snapshot)
  return [
    {
      id: `registrations:${closed ? 'unreadable' : 'unwritable'}:${problem.slice(
        0,
        PROBLEM_IN_ID,
      )}`,
      level: 'error',
      origin: 'registrations',
      title: closed ? '登记簿读不出来' : '登记簿写不进去',
      // The ledger's problem is the file system's own words: the short line
      // here, the original folded under it (`view/errors.ts`, C5).
      detail: closed
        ? `${reasonOf(problem).text} · 修好并重启之前出口一律不拨`
        : `${reasonOf(problem).text} · 发布与恢复已停止 · 这期间的暂停与退役重启后会丢`,
      ...(reasonOf(problem).detail === ''
        ? {}
        : { raw: reasonOf(problem).detail }),
    },
  ]
}

function noticeAlerts(feed: NoticeFeed): ConsoleAlert[] {
  return feed.notices.map(notice => {
    const parts: string[] = []
    if (notice.from !== undefined) parts.push(`来自 ${notice.from}`)
    if (notice.job !== undefined) parts.push(`作业 ${notice.job}`)
    if (notice.redelivered === true) parts.push('重发')
    return {
      id: notice.id,
      level: notice.level,
      origin: 'notice' as const,
      title: notice.summary,
      ...(parts.length === 0 ? {} : { detail: parts.join(' · ') }),
      at: notice.at,
    }
  })
}

function byUrgency(left: ConsoleAlert, right: ConsoleAlert): number {
  const rank = LEVEL_RANK[left.level] - LEVEL_RANK[right.level]
  if (rank !== 0) return rank
  // A condition with no instant of its own is happening now.
  const at = (alert: ConsoleAlert) => alert.at ?? Number.POSITIVE_INFINITY
  if (at(left) !== at(right)) return at(right) > at(left) ? 1 : -1
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

const LINK_SOURCE: AlertSource = {
  label: '链路',
  tone: 'muted',
  text: '未接入 · 控制台没有节点连通探测的数据',
}

function noticeSource(notices: AlertInputs['notices']): AlertSource {
  if (notices === undefined) {
    return {
      label: '通知',
      tone: 'warn',
      text: '未接入 · 控制台没有读取值守进程的通知',
    }
  }
  if (!notices.ok) return { label: '通知', tone: 'bad', text: '读取失败' }
  const feed = notices.value
  if (!feed.present) {
    return {
      label: '通知',
      tone: 'warn',
      text: '已接入 · 中枢审计链尚未建立 · 值守进程没有在这个配置根上运行过',
    }
  }
  return {
    label: '通知',
    tone: 'ok',
    text:
      feed.total > feed.notices.length
        ? `已接入 · 最近 ${feed.notices.length} 条 · 共 ${feed.total} 条`
        : `已接入 · ${feed.total} 条`,
  }
}

function auditSource(audits: readonly AlertAuditRead[]): AlertSource {
  const failed = audits.filter(source => source.failure !== null).length
  if (audits.length === 0) {
    return { label: '审计链', tone: 'muted', text: '未配置' }
  }
  return failed === 0
    ? { label: '审计链', tone: 'ok', text: `已接入 · ${audits.length} 条` }
    : {
        label: '审计链',
        tone: 'bad',
        text: `${audits.length} 条 · ${failed} 条读取失败`,
      }
}

function registrationSource(
  snapshot: LifecycleSnapshot | undefined,
): AlertSource {
  if (snapshot === undefined) {
    return { label: '登记簿', tone: 'muted', text: '未接入' }
  }
  if (snapshot.problem !== null) {
    return {
      label: '登记簿',
      tone: 'bad',
      text: ledgerClosed(snapshot) ? '不可用 · 读不出来' : '不可用 · 写不进去',
    }
  }
  const count = (state: 'paused' | 'retired') =>
    snapshot.registrations.filter(record => record.state === state).length
  return {
    label: '登记簿',
    tone: 'ok',
    text: `已接入 · 暂停 ${count('paused')} · 退役 ${count('retired')}`,
  }
}

/** The inbox, composed from every source this console has, unfiltered. */
export function alertBoard(inputs: AlertInputs): AlertBoard {
  const { now } = inputs
  const alerts: ConsoleAlert[] = []
  const warnings: string[] = []

  if (inputs.notices?.ok === true) {
    alerts.push(...noticeAlerts(inputs.notices.value))
    if (!inputs.notices.value.intact) {
      warnings.push('通知所在的中枢审计链校验不过 · 列出的通知可能不完整')
    }
  }
  if (inputs.roster.ok) {
    alerts.push(...nodeAlerts(inputs.roster.value, now, inputs.ttlMs))
  }
  if (inputs.certificates !== undefined) {
    if (inputs.certificates.snapshot.ok) {
      alerts.push(...certificateAlerts(inputs.certificates.snapshot.value, now))
    }
    alerts.push(...rootAlerts(inputs.certificates.roots, now))
  }
  alerts.push(...auditAlerts(inputs.audits))
  if (inputs.registrations !== undefined) {
    alerts.push(...registrationAlerts(inputs.registrations))
  }

  // Two sources can describe one episode in the same words (a redelivered
  // notice is the same message id); the first one wins.
  const seen = new Set<string>()
  const unique = alerts.filter(alert => {
    if (seen.has(alert.id)) return false
    seen.add(alert.id)
    return true
  })

  const acked = new Map<string, number>()
  if (inputs.acks?.ok === true) {
    for (const ack of inputs.acks.value) {
      if (!acked.has(ack.id)) acked.set(ack.id, ack.at)
    }
  } else if (inputs.acks !== undefined) {
    warnings.push('确认记录读不出来 · 全部按未确认显示')
  }
  const marked = unique
    .map(alert => {
      const at = acked.get(alert.id)
      return at === undefined ? alert : { ...alert, ackedAt: at }
    })
    .sort(byUrgency)

  const certificates = inputs.certificates
  const sources: AlertSource[] = [
    noticeSource(inputs.notices),
    inputs.roster.ok
      ? { label: '注册中心', tone: 'ok', text: '已接入' }
      : { label: '注册中心', tone: 'bad', text: '不可达' },
    registrationSource(inputs.registrations),
    certificates === undefined
      ? { label: '证书', tone: 'muted', text: '未配置' }
      : certificates.snapshot.ok
        ? { label: '证书', tone: 'ok', text: '已接入' }
        : { label: '证书', tone: 'bad', text: '读取失败' },
    auditSource(inputs.audits),
    LINK_SOURCE,
    inputs.acks === undefined
      ? { label: '确认', tone: 'warn', text: '未接入 · 确认无处记录' }
      : inputs.acks.ok
        ? { label: '确认', tone: 'ok', text: '已接入' }
        : { label: '确认', tone: 'bad', text: '读取失败' },
  ]

  return {
    alerts: marked,
    unread: marked.filter(alert => alert.ackedAt === undefined).length,
    ackable: inputs.acks?.ok === true,
    sources,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------

/** Which entries the inbox shows by acknowledgement. */
type AlertState = 'unread' | 'acked' | 'all'

interface AlertFilter {
  /** Absent shows every level. */
  readonly level?: AlertLevel
  readonly state: AlertState
}

const STATES: readonly AlertState[] = ['unread', 'acked', 'all']

/**
 * The filter out of a query string. Anything unrecognised falls back to the
 * default rather than failing: this is a link somebody bookmarked, and a stale
 * value in it should land on the inbox, not on an error.
 */
export function parseAlertFilter(params: URLSearchParams): AlertFilter {
  const level = params.get('level') ?? ''
  const wanted = params.get('state') ?? ''
  return {
    ...((ALERT_LEVELS as readonly string[]).includes(level)
      ? { level: level as AlertLevel }
      : {}),
    state: (STATES as readonly string[]).includes(wanted)
      ? (wanted as AlertState)
      : 'unread',
  }
}

/** The query that reproduces a filter: the poller replays it. */
export function alertQuery(filter: AlertFilter): string {
  const params = new URLSearchParams()
  if (filter.level !== undefined) params.set('level', filter.level)
  if (filter.state !== 'unread') params.set('state', filter.state)
  return params.toString()
}

export function filterAlerts(
  alerts: readonly ConsoleAlert[],
  filter: AlertFilter,
): readonly ConsoleAlert[] {
  return alerts.filter(alert => {
    if (filter.level !== undefined && alert.level !== filter.level) {
      return false
    }
    if (filter.state === 'unread') return alert.ackedAt === undefined
    if (filter.state === 'acked') return alert.ackedAt !== undefined
    return true
  })
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

/**
 * The filter bar: a plain `GET` form, so it works with script off and the URL
 * it produces is the one to paste into a ticket.
 */
export function renderAlertFilter(filter: AlertFilter): string {
  const levels: readonly (readonly [string, string])[] = [
    ['', '全部'],
    ...ALERT_LEVELS.map(level => [level, LEVEL_WORD[level]] as const),
  ]
  const states: readonly (readonly [string, string])[] = [
    ['unread', '未确认'],
    ['acked', '已确认'],
    ['all', '全部'],
  ]
  return (
    `<form id="alerts-filter" method="get">` +
    `<div class="rowx" style="gap:var(--space-6);align-items:flex-end">` +
    `<div class="field"><span>级别</span>` +
    segment('level', levels, filter.level ?? '') +
    `</div>` +
    `<div class="field"><span>状态</span>` +
    segment('state', states, filter.state) +
    `</div>` +
    `<button type="submit" class="btn btn-primary">筛选</button>` +
    `</div></form>`
  )
}

// ---------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------

/** The unread count, as the badge the inbox header carries. */
function unreadBadge(unread: number): string {
  return (
    `<span class="unread" id="alerts-unread" data-unread="${attr(
      String(unread),
    )}"${unread === 0 ? ' data-zero' : ''}>` +
    `未确认 ${escapeHtml(String(unread))}</span>`
  )
}

function whenCell(at: number | undefined, now: number): string {
  if (at === undefined) return `<span class="alert-when note">进行中</span>`
  return (
    `<span class="alert-when">${timeTag(at, 'datetime')}` +
    `<span class="note">${escapeHtml(formatRelative(at, now))}</span></span>`
  )
}

function ackCell(alert: ConsoleAlert, canAck: boolean): string {
  if (alert.ackedAt !== undefined) {
    return (
      `<span class="alert-ack note">已确认 ` +
      `${timeTag(alert.ackedAt, 'datetime')}</span>`
    )
  }
  if (!canAck) return `<span class="alert-ack"></span>`
  return (
    `<span class="alert-ack"><button type="button" ` +
    `class="btn btn-secondary btn-small" data-write data-action="alert-ack" ` +
    `data-alert="${attr(alert.id)}">确认</button></span>`
  )
}

function alertRow(alert: ConsoleAlert, now: number, canAck: boolean): string {
  const meta = [ORIGIN_WORD[alert.origin]]
  if (alert.detail !== undefined) meta.push(alert.detail)
  return (
    `<li class="alert-row" data-key="${attr(alert.id)}" ` +
    `data-level="${attr(alert.level)}" ` +
    `data-acked="${alert.ackedAt === undefined ? '0' : '1'}">` +
    `<span class="alert-level">${state(
      LEVEL_TONE[alert.level],
      LEVEL_WORD[alert.level],
    )}</span>` +
    `<div class="alert-main"><p class="alert-title">${escapeHtml(
      alert.title,
    )}</p><p class="alert-meta note">${escapeHtml(meta.join(' · '))}</p>` +
    rawDetail(alert.raw ?? '') +
    `</div>` +
    whenCell(alert.at, now) +
    ackCell(alert, canAck) +
    `</li>`
  )
}

/** What the inbox says when the filter leaves nothing, per filter. */
function emptyLine(filter: AlertFilter, total: number): string {
  if (total === 0) return '没有告警'
  const level =
    filter.level === undefined ? '' : `${LEVEL_WORD[filter.level]}级`
  if (filter.state === 'unread') return `没有未确认的${level}告警`
  if (filter.state === 'acked') return `没有已确认的${level}告警`
  return `没有${level}告警`
}

interface InboxModel {
  readonly board: AlertBoard
  readonly filter: AlertFilter
  readonly now: number
  /** Draw the acknowledge buttons: a writer, on a console that can record it. */
  readonly canAck: boolean
  /** A registry that could not be read: the node source is missing, say so. */
  readonly rosterFailure: ConsoleFailure | null
}

/**
 * The polled fragment: the header with the unread badge, and the list.
 *
 * The two ids (`alerts-head`, `alerts-list`) are what the poller swaps, so the
 * filter form above them is never replaced under somebody's cursor.
 */
export function renderAlertInbox(model: InboxModel): string {
  const { board, filter, now } = model
  const shown = filterAlerts(board.alerts, filter)
  const tail =
    `<div class="rowx note">` +
    unreadBadge(board.unread) +
    railSep() +
    `<span>当前 ${escapeHtml(String(shown.length))} 条</span>` +
    railSep() +
    `<span>共 ${escapeHtml(String(board.alerts.length))} 条</span>` +
    `</div>`
  const head = sectionHead('Inbox', '收件箱', {
    id: 'alerts-head',
    headingId: 'h-alerts',
    tail,
    stats: { unread: board.unread, total: board.alerts.length },
  })
  const bars =
    (model.rosterFailure === null
      ? ''
      : failureBar(model.rosterFailure, '注册中心')) +
    board.warnings
      .map(line => `<p class="bar bar-warn">${escapeHtml(line)}</p>`)
      .join('')
  const list =
    shown.length === 0
      ? `<div id="alerts-list">${hint(emptyLine(filter, board.alerts.length))}</div>`
      : `<ul class="alert-list card elev-sm" id="alerts-list">` +
        shown.map(alert => alertRow(alert, now, model.canAck)).join('') +
        `</ul>`
  return head + `<div class="pane" id="alerts-body">${bars}${list}</div>`
}

/** The strip naming every source and whether it is there. */
export function renderAlertSources(sources: readonly AlertSource[]): string {
  return (
    `<section class="sec" aria-labelledby="h-alert-sources">` +
    sectionHead('Sources', '来源', {
      headingId: 'h-alert-sources',
      sub: true,
    }) +
    `<ul class="alert-sources">` +
    sources
      .map(
        source =>
          `<li><span class="k">${escapeHtml(source.label)}</span>` +
          `${toned(source.tone, source.text)}</li>`,
      )
      .join('') +
    `</ul></section>`
  )
}

/** The page's own rules (`routes/types.ts`, `PageRoute.css`). */
export const ALERTS_PAGE_CSS = `
.alert-list { list-style: none; margin: 0; padding: var(--space-1) var(--space-4); }
.alert-row {
  display: grid; grid-template-columns: 5.5rem minmax(0, 1fr) auto 7.5rem;
  gap: var(--space-3); align-items: center;
  padding: var(--space-3) 0; border-bottom: 1px solid var(--color-divider);
}
.alert-row:last-child { border-bottom: 0; }
.alert-row[data-acked="1"] .alert-title { font-weight: 400; color: var(--color-muted); }
.alert-title { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.alert-meta { margin: 0; overflow-wrap: anywhere; }
.alert-when { display: flex; flex-direction: column; align-items: flex-end; white-space: nowrap; font-family: var(--font-mono); font-size: 12px; }
.alert-ack { display: flex; justify-content: flex-end; }
.unread {
  display: inline-flex; align-items: center; padding: 2px 10px; border-radius: 999px;
  font-size: 12px; font-weight: 700;
  background: color-mix(in srgb, var(--color-critical) 14%, var(--color-bg)); color: var(--color-critical);
}
.unread[data-zero] { background: var(--color-neutral-100); color: var(--color-neutral-700); font-weight: 600; }
.alert-sources { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-6); font-size: 13px; }
.alert-sources .k { color: var(--color-muted); margin-right: var(--space-2); }
@media (max-width: 720px) {
  .alert-row { grid-template-columns: minmax(0, 1fr); }
  .alert-when { align-items: flex-start; }
  .alert-ack { justify-content: flex-start; }
}
`
