// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One node's page (A3) and its lifecycle (J2): the tabs, the overview, the
 * lifecycle table and its four confirmations, and the 「模型」 tab's mount.
 *
 * ## Four tabs, each its own URL
 *
 * | Path | Tab |
 * | --- | --- |
 * | `/nodes/<node>` | 概览: agents and their health, server, endpoint, certificate, the lifecycle in numbers, the latest trail lines |
 * | `/nodes/<node>/agents` | 智能体: the roster card, polled, with heartbeat and deregister |
 * | `/nodes/<node>/lifecycle` | 生命周期: every address of the node, its state, whether it can be reached and why not, and the four actions |
 * | `/nodes/<node>/models` | 模型: P18.9's fragment, loaded into the tab; a link to `/providers?node=<node>` without script |
 *
 * Plain links between them, so each reads without script and can be
 * bookmarked. The design's list for this page (`providers-console-m1.md`
 * §6.1) also names 证书, 服务器, 审计, 会话 and 操作历史: the first two are a
 * line each and sit in 概览, the trail is 概览's last section with the way to
 * the whole of it, and the last two are not tabs here — each is an area with
 * its own rules about who may read it (`routes/chat.ts`, `routes/access.ts`),
 * and a tab here would have to restate those rules or break them.
 *
 * ## The lifecycle table says why, not only what
 *
 * A state alone does not answer the question somebody opens this tab with —
 * "will a message to it go out?". So every row carries that answer and its
 * reason, in the order the hub's exits decide it (`console.md` §7.3.2): a
 * ledger that cannot be read stops everything; then retired, then paused;
 * then the registry — not on the roster, or its lease run out. A ledger that
 * only cannot be saved stops nothing: the exits judge the copy in memory,
 * which is what the snapshot shows, so its rows read as usual. A paused seed
 * the registry host keeps renewing is still on the roster, and the row says
 * that too, because "it is on the roster" is the misreading §7.3.3 warns of.
 *
 * ## Only the actions that will succeed
 *
 * The rules are `console.md` §7.3.1's, applied before anything is drawn: no
 * action at all while the ledger cannot be read, no publish or resume while
 * it cannot be saved; publish only for a managed
 * address that is in neither the ledger nor the roster; pause and retire for
 * what the ledger or the managed list knows; resume only for a paused one
 * still on the list. Every button opens its confirmation; nothing here writes
 * on the first click, and nothing here records — the routes do, once each.
 */

import type {
  AuditPage,
  ConsoleAgent,
  ConsoleCertificate,
  ConsoleFailure,
  LifecycleSnapshot,
  RegistrationRecord,
  RegistrationState,
} from '../deps.js'
import { bareNode } from './agents.js'
import {
  absent,
  bar,
  chevron,
  failureBar,
  hint,
  icon,
  railSep,
  rawDetail,
  reasonOf,
  sectionHead,
  splitAddress,
  state,
  tag,
  toned,
  type Tone,
} from './bits.js'
import { certificateLine } from './certificates.js'
import { attr, escapeHtml } from './escape.js'
import { agentHealth, formatDateTime, type AgentHealth } from './format.js'

// ---------------------------------------------------------------------------
// The tabs
// ---------------------------------------------------------------------------

export type NodeTab = 'overview' | 'agents' | 'lifecycle' | 'models'

/** In the order the tab bar draws them. */
const NODE_TABS: readonly NodeTab[] = [
  'overview',
  'agents',
  'lifecycle',
  'models',
]

const TAB_LABEL: Readonly<Record<NodeTab, string>> = {
  overview: '概览',
  agents: '智能体',
  lifecycle: '生命周期',
  models: '模型',
}

/** The node as one path segment, percent-encoded (`console.md` §5). */
function segment(node: string): string {
  return encodeURIComponent(node)
}

/** Where a tab lives. 概览 is the node's own address. */
export function nodeTabPath(node: string, tab: NodeTab): string {
  const base = `/nodes/${segment(node)}`
  return tab === 'overview' ? base : `${base}/${tab}`
}

/**
 * The 「模型」 tab's content: `GET /fragments/providers/node/<node>`, owned by
 * the providers area (P18.9). This page only loads it.
 */
function nodeModelsFragment(node: string): string {
  return `/fragments/providers/node/${segment(node)}`
}

/** Where the 「模型」 tab sends a reader with no script: the node's row in the matrix. */
function nodeModelsLink(node: string): string {
  return `/providers?node=${segment(node)}`
}

export function renderNodeTabs(node: string, current: NodeTab): string {
  return (
    `<nav class="node-tabs" aria-label="节点">` +
    NODE_TABS.map(
      tab =>
        `<a class="node-tab" id="node-tab-${attr(tab)}" href="${attr(
          nodeTabPath(node, tab),
        )}" data-nav${tab === current ? ' aria-current="page"' : ''}>` +
        `${escapeHtml(TAB_LABEL[tab])}</a>`,
    ).join('') +
    `</nav>`
  )
}

/** The tab's label, for the page title and the breadcrumb. */
export function nodeTabLabel(tab: NodeTab): string {
  return TAB_LABEL[tab]
}

// ---------------------------------------------------------------------------
// Which addresses belong to a node, and what can be said about each
// ---------------------------------------------------------------------------

/** The bare node segment of an address: `qianmo://tokyo-1/planner` → `tokyo-1`. */
export function nodeOf(address: string): string {
  return bareNode(splitAddress(address).node)
}

/** Whether a message to the address goes out, and if not, why. */
interface Reachability {
  readonly tone: Tone
  /** `可拨`, `不可拨`, or `未知` when the registry could not be read. */
  readonly word: string
  readonly reason: string
}

/** One address on the lifecycle tab. */
interface LifecycleRow {
  readonly address: string
  /** `none`: neither the ledger nor any page action has written it. */
  readonly state: RegistrationState | 'none'
  /** Absent when the console has no managed list. */
  readonly managed?: boolean
  readonly registration?: RegistrationRecord
  /** The roster's record, when the registry lists it. */
  readonly agent?: ConsoleAgent
  readonly reach: Reachability
}

type LifecycleVerb = 'publish' | 'pause' | 'resume' | 'retire'

/** The four verbs in the order a row draws them. */
const LIFECYCLE_VERBS: readonly LifecycleVerb[] = [
  'publish',
  'pause',
  'resume',
  'retire',
]

const STATE_WORD: Readonly<Record<LifecycleRow['state'], string>> = {
  none: '未登记',
  active: '已发布',
  paused: '已暂停',
  retired: '已退役',
}

const STATE_TONE: Readonly<Record<LifecycleRow['state'], Tone>> = {
  none: 'muted',
  active: 'ok',
  paused: 'warn',
  retired: 'bad',
}

/**
 * Whether the ledger is closed: unreadable, every write refused and no exit
 * dialled. A problem without a kind is read as that — the side that is
 * wrong-but-safe (`deps.ts`, `LifecycleSnapshot.problemKind`).
 */
export function ledgerClosed(snapshot: LifecycleSnapshot | null): boolean {
  return (
    snapshot !== null &&
    snapshot.problem !== null &&
    snapshot.problemKind !== 'unwritable'
  )
}

/**
 * The exits' question, asked the exits' way (`consoleRegistrationLedger.ts`,
 * `exitRefusalOf`), then the registry's: a ledger that cannot be read stops
 * every exit, a paused or retired address is never dialled, and an address
 * the registry does not list, or lists with a lapsed lease, has nowhere to
 * be dialled.
 */
function reachOf(
  snapshot: LifecycleSnapshot | null,
  state: LifecycleRow['state'],
  agent: ConsoleAgent | undefined,
  roster: readonly ConsoleAgent[] | null,
  now: number,
  ttlMs: number,
): Reachability {
  const no = (reason: string): Reachability => ({
    tone: 'bad',
    word: '不可拨',
    reason,
  })
  if (ledgerClosed(snapshot)) {
    return no('登记簿不可用 · 修好之前出口一律不拨')
  }
  if (state === 'retired') return no('已退役 · 不再拨')
  if (state === 'paused') {
    return no(
      agent === undefined
        ? '已暂停 · 恢复之前不拨'
        : '已暂停 · 恢复之前不拨 · 名册上仍在是因为注册中心宿主替种子续租',
    )
  }
  if (roster === null) {
    return { tone: 'muted', word: '未知', reason: '注册中心不可达 · 无法判断' }
  }
  if (agent === undefined) {
    return no(
      state === 'active' ? '不在名册上 · 等待控制台下一轮续租' : '不在名册上',
    )
  }
  const health: AgentHealth = agentHealth(agent, now, ttlMs)
  if (health === 'expired') return no('租约已过期')
  return {
    tone: health === 'stale' ? 'warn' : 'ok',
    word: '可拨',
    reason: health === 'stale' ? '租约过半 · 再无心跳就会被摘牌' : '在名册上',
  }
}

/** What one node's lifecycle tab is drawn from. */
export interface LifecycleModel {
  readonly node: string
  /** `null` when this console has no lifecycle port at all. */
  readonly snapshot: LifecycleSnapshot | null
  /** The registry's agents of this node; `null` when it could not be read. */
  readonly agents: readonly ConsoleAgent[] | null
  readonly rosterFailure: ConsoleFailure | null
  readonly now: number
  readonly ttlMs: number
  /** Draws the actions, and who last changed each address. */
  readonly canWrite: boolean
}

/**
 * Every address of the node: the roster's, the ledger's and the managed
 * list's, once each, sorted by address so a refresh never moves a row.
 */
function lifecycleRows(model: LifecycleModel): readonly LifecycleRow[] {
  const { node, snapshot, agents } = model
  const addresses = new Set<string>()
  for (const agent of agents ?? []) addresses.add(agent.address)
  const held = new Map<string, RegistrationRecord>()
  for (const record of snapshot?.registrations ?? []) {
    if (nodeOf(record.address) !== node) continue
    held.set(record.address, record)
    addresses.add(record.address)
  }
  const managed = snapshot?.managed ?? null
  for (const address of managed ?? []) {
    if (nodeOf(address) === node) addresses.add(address)
  }
  const listed = new Map((agents ?? []).map(agent => [agent.address, agent]))
  return [...addresses].sort().map(address => {
    const registration = held.get(address)
    const state = registration?.state ?? 'none'
    const agent = listed.get(address)
    return {
      address,
      state,
      ...(managed === null ? {} : { managed: managed.includes(address) }),
      ...(registration === undefined ? {} : { registration }),
      ...(agent === undefined ? {} : { agent }),
      reach: reachOf(snapshot, state, agent, agents, model.now, model.ttlMs),
    }
  })
}

/**
 * The verbs that will succeed on a row (`console.md` §7.3.1): none while the
 * ledger cannot be read; only the narrowing two (pause, retire) while it
 * cannot be saved. A button whose answer is a 503 is a button not to draw.
 */
function verbsFor(
  row: LifecycleRow,
  snapshot: LifecycleSnapshot | null,
): readonly LifecycleVerb[] {
  if (snapshot === null || ledgerClosed(snapshot)) return []
  const widening = snapshot.problem === null
  const known = row.state !== 'none' || row.managed === true
  return LIFECYCLE_VERBS.filter(verb => {
    switch (verb) {
      // A seed the registry host already keeps on the roster needs no
      // publishing, and publishing it would fight that host's declaration
      // every twenty seconds (§7.3.3).
      case 'publish':
        return (
          widening &&
          row.state === 'none' &&
          row.managed === true &&
          row.agent === undefined
        )
      case 'pause':
        return known && row.state !== 'paused' && row.state !== 'retired'
      case 'resume':
        return widening && row.state === 'paused' && row.managed !== false
      case 'retire':
        return known && row.state !== 'retired'
    }
  })
}

/** Managed addresses nobody has published and the roster does not hold. */
export function publishable(
  snapshot: LifecycleSnapshot | null,
  agents: readonly ConsoleAgent[] | null,
  node?: string,
): readonly string[] {
  if (snapshot === null || snapshot.problem !== null) return []
  const held = new Set(snapshot.registrations.map(record => record.address))
  const listed = new Set((agents ?? []).map(agent => agent.address))
  return (snapshot.managed ?? []).filter(
    address =>
      !held.has(address) &&
      !listed.has(address) &&
      (node === undefined || nodeOf(address) === node),
  )
}

// ---------------------------------------------------------------------------
// The lifecycle tab
// ---------------------------------------------------------------------------

const VERB_WORD: Readonly<Record<LifecycleVerb, string>> = {
  publish: '发布',
  pause: '暂停',
  resume: '恢复',
  retire: '退役',
}

function verbButton(verb: LifecycleVerb, address: string): string {
  const tone = verb === 'retire' ? 'btn-ghost btn-danger' : 'btn-secondary'
  return (
    `<button type="button" class="btn ${tone} btn-small" ` +
    `data-action="lifecycle" data-verb="${attr(verb)}" ` +
    `data-address="${attr(address)}" data-write>` +
    `${escapeHtml(VERB_WORD[verb])}</button>`
  )
}

function managedCell(row: LifecycleRow): string {
  if (row.managed === undefined) return absent()
  return row.managed ? tag('托管', 'ok') : tag('不在清单', 'muted')
}

/** When the address last changed, and — for a writer — who changed it. */
function changedCell(row: LifecycleRow, showWho: boolean): string {
  const at = row.registration?.at
  const by = row.registration?.by
  if (at === undefined && (by === undefined || !showWho)) return absent()
  const parts: string[] = []
  if (at !== undefined) {
    parts.push(
      `<time class="mono" datetime="${attr(new Date(at).toISOString())}">` +
        `${escapeHtml(formatDateTime(at))}</time>`,
    )
  }
  if (showWho && by !== undefined) {
    parts.push(`<span class="mono who">${escapeHtml(by)}</span>`)
  }
  return parts.join('')
}

function lifecycleRow(
  row: LifecycleRow,
  snapshot: LifecycleSnapshot | null,
  canWrite: boolean,
): string {
  const verbs = canWrite ? verbsFor(row, snapshot) : []
  return (
    `<tr data-key="${attr(row.address)}" data-state="${attr(row.state)}">` +
    `<td class="addr-cell"><span class="addr mono">${escapeHtml(
      row.address,
    )}</span></td>` +
    `<td>${state(STATE_TONE[row.state], STATE_WORD[row.state])}</td>` +
    `<td class="reach">${toned(row.reach.tone, row.reach.word)}` +
    `<span class="note">${escapeHtml(row.reach.reason)}</span></td>` +
    `<td>${managedCell(row)}</td>` +
    `<td class="when">${changedCell(row, canWrite)}</td>` +
    (canWrite
      ? `<td class="acts">${
          verbs.length === 0
            ? absent()
            : verbs.map(verb => verbButton(verb, row.address)).join('')
        }</td>`
      : '') +
    `</tr>`
  )
}

/** The tab's polled region: the head, the ledger's state, the table. */
export function renderLifecycle(model: LifecycleModel): string {
  const { snapshot } = model
  const rows = lifecycleRows(model)
  const counts = { active: 0, paused: 0, retired: 0, blocked: 0 }
  for (const row of rows) {
    if (row.state === 'active') counts.active += 1
    if (row.state === 'paused') counts.paused += 1
    if (row.state === 'retired') counts.retired += 1
    if (row.reach.word === '不可拨') counts.blocked += 1
  }
  const tail =
    `<div class="rowx note"><span class="total">${rows.length}</span>` +
    railSep() +
    `已发布 ${counts.active}` +
    railSep() +
    `已暂停 ${counts.paused}` +
    railSep() +
    `已退役 ${counts.retired}` +
    railSep() +
    (counts.blocked === 0
      ? toned('ok', '全部可拨')
      : toned('bad', `不可拨 ${counts.blocked}`)) +
    `</div>`
  const head = sectionHead('Lifecycle', '生命周期', {
    id: 'lifecycle-head',
    headingId: 'h-lifecycle',
    tail,
    stats: {
      total: rows.length,
      active: counts.active,
      paused: counts.paused,
      retired: counts.retired,
      blocked: counts.blocked,
    },
  })
  const strips: string[] = []
  if (snapshot === null) {
    strips.push(bar('muted', '该控制台没有接入登记簿 · 生命周期不可用'))
  } else if (snapshot.problem !== null) {
    // Closed: nothing is taken and nothing goes out. Unsaved: the narrowing
    // two are still taken and the exits still judge the copy in memory, but
    // a change made now does not survive a restart (§7.3.1, 写失败).
    const consequence = ledgerClosed(snapshot)
      ? '动作一律不收 · 出口一律不拨'
      : '写不进去 · 发布与恢复已停止 · 暂停与退役照收但重启后会丢'
    // The ledger's problem is the file system's own words: the short line on
    // the strip, the original under 详情 (C5).
    const problem = reasonOf(snapshot.problem)
    strips.push(
      `<div class="bar bar-bad" role="alert">` +
        icon('alert-triangle', { small: true }) +
        `<span>登记簿不可用 · ${escapeHtml(problem.text)} · ` +
        `${consequence}</span>${rawDetail(problem.detail)}</div>`,
    )
  } else if (snapshot.managed === null) {
    strips.push(bar('muted', '未给托管清单 · 发布要带端点'))
  }
  if (model.rosterFailure !== null) {
    strips.push(failureBar(model.rosterFailure, '注册中心'))
  }
  if (rows.length === 0) {
    return (
      head +
      `<div class="pane">${strips.join('')}${hint('这台节点还没有地址')}</div>`
    )
  }
  const headers = ['地址', '状态', '能否拨号', '托管', '最近一次改动']
  if (model.canWrite) headers.push('操作')
  const table =
    `<div class="scroll"><table class="trail node-life">` +
    `<caption class="sr-only">生命周期</caption><thead><tr>` +
    headers.map(h => `<th scope="col">${escapeHtml(h)}</th>`).join('') +
    `</tr></thead><tbody>` +
    rows.map(row => lifecycleRow(row, snapshot, model.canWrite)).join('') +
    `</tbody></table></div>`
  return head + `<div class="pane">${strips.join('')}${table}</div>`
}

// ---------------------------------------------------------------------------
// The confirmations, and the publish form for a managed list
// ---------------------------------------------------------------------------

const CONFIRM: Readonly<
  Record<
    LifecycleVerb,
    {
      readonly glyph: string
      readonly title: string
      readonly line: string
      readonly button: string
    }
  >
> = {
  publish: {
    glyph: 'arrow-up',
    title: '发布这个智能体',
    line: '注册中心收下后记入登记簿 · 由本控制台持续续租 · 端点取自托管清单',
    button: 'btn-primary',
  },
  pause: {
    glyph: 'clock',
    title: '暂停这个智能体',
    line:
      '从现在起对话与唤醒都不再拨它 · 值守作业跳过它 · ' +
      '注册中心那条被删除 · 之后可以恢复',
    button: 'btn-primary',
  },
  resume: {
    glyph: 'refresh-cw',
    title: '恢复这个智能体',
    line: '重新注册并由本控制台续租 · 对话与唤醒恢复拨号',
    button: 'btn-primary',
  },
  retire: {
    glyph: 'power',
    title: '退役这个智能体',
    line: '退役不能撤回 · 这个地址此后不再发布也不再恢复 · 注册中心那条被删除',
    button: 'btn-danger',
  },
}

function confirmDialog(verb: LifecycleVerb): string {
  const copy = CONFIRM[verb]
  const id = `confirm-${verb}`
  return (
    `<dialog class="dialog" id="${id}" aria-labelledby="${id}-title">` +
    `<div class="dlg-top"><span class="dlg-icon">` +
    icon(copy.glyph) +
    `</span><div class="dialog-title" id="${id}-title">` +
    `${escapeHtml(copy.title)}</div></div>` +
    `<div class="dialog-body"><div class="recap"><div class="recap-row">` +
    `<span class="k">地址</span><span class="addr mono" id="${id}-addr">` +
    `</span></div></div><p>${escapeHtml(copy.line)}</p></div>` +
    `<div class="dialog-actions">` +
    `<button type="button" class="btn btn-secondary" ` +
    `data-action="confirm-cancel">取消</button>` +
    `<button type="button" class="btn ${copy.button}" ` +
    `data-action="${id}" data-write>${escapeHtml(VERB_WORD[verb])}</button>` +
    `</div></dialog>`
  )
}

/**
 * The four confirmations, rendered once, outside every polled region: a
 * dialog inside one would be replaced out from under whoever is reading it.
 */
export function lifecycleDialogs(): string {
  return LIFECYCLE_VERBS.map(confirmDialog).join('')
}

/**
 * 发布 for a console with a managed list: pick the address, the endpoint is
 * the hub's (`tenancy-m1.md` §3.6, "表单不再收"). Submitting opens the same
 * confirmation the row's 发布 does.
 */
export function publishDialog(addresses: readonly string[]): string {
  const options = addresses
    .map(
      address =>
        `<option value="${attr(address)}">${escapeHtml(address)}</option>`,
    )
    .join('')
  return (
    `<dialog class="dialog dialog-wide" id="publish-dialog" ` +
    `aria-labelledby="publish-title">` +
    `<div class="dlg-top"><span class="dlg-icon dlg-icon-2">` +
    icon('arrow-up') +
    `</span><div class="dialog-title" id="publish-title">发布智能体</div></div>` +
    `<form id="publish-form" class="stack" novalidate>` +
    `<div class="field"><label for="publish-address">地址 · 取自托管清单</label>` +
    `<span class="sel"><select class="input" id="publish-address" name="address">` +
    `${options}</select>${chevron()}</span></div>` +
    `<p class="note">端点由中枢配置决定 · 不用填写</p>` +
    `<div class="dialog-actions">` +
    `<button type="button" class="btn btn-secondary" ` +
    `data-action="confirm-cancel">取消</button>` +
    `<button type="submit" class="btn btn-primary" data-write>` +
    icon('arrow-up', { small: true }) +
    `发布</button></div></form></dialog>`
  )
}

/** What a writer is told where the buttons are, when script is off. */
export const LIFECYCLE_NO_SCRIPT = '生命周期动作需要启用脚本 · 阅读不受影响'

// ---------------------------------------------------------------------------
// The overview
// ---------------------------------------------------------------------------

/** What the overview tab is drawn from. */
export interface NodeOverviewModel {
  readonly node: string
  readonly agents: readonly ConsoleAgent[] | null
  readonly rosterFailure: ConsoleFailure | null
  readonly now: number
  readonly ttlMs: number
  readonly server?: string
  /** Absent when this console has no certificate column. */
  readonly certificate?: ConsoleCertificate
  /** `null` when this console has no lifecycle port. */
  readonly lifecycle: LifecycleModel | null
  /** The latest lines of the trail about this node, when there is one to read. */
  readonly trail?: {
    readonly page: AuditPage | null
    readonly failure: ConsoleFailure | null
    /** The rendered excerpt (`view/audit.ts`). */
    readonly html: string
    /** Where the whole of it is. */
    readonly href: string
  }
}

function fact(key: string, value: string): string {
  return (
    `<div class="kv"><span class="k">${escapeHtml(key)}</span>` +
    `<span class="v">${value}</span></div>`
  )
}

function agentsFact(model: NodeOverviewModel): string {
  if (model.agents === null) return toned('muted', '注册中心不可达')
  if (model.agents.length === 0) return toned('muted', '名册上没有')
  let live = 0
  let stale = 0
  let expired = 0
  for (const agent of model.agents) {
    const health = agentHealth(agent, model.now, model.ttlMs)
    if (health === 'live') live += 1
    else if (health === 'stale') stale += 1
    else expired += 1
  }
  const parts = [
    `${model.agents.length} 个`,
    toned('ok', `在线 ${live}`),
    ...(stale > 0 ? [toned('warn', `滞后 ${stale}`)] : []),
    ...(expired > 0 ? [toned('bad', `过期 ${expired}`)] : []),
  ]
  return (
    parts.join(railSep()) +
    ` <a class="jump" href="${attr(
      nodeTabPath(model.node, 'agents'),
    )}" data-nav>查看</a>`
  )
}

function lifecycleFact(model: NodeOverviewModel): string {
  const lifecycle = model.lifecycle
  if (lifecycle === null) return toned('muted', '未接入')
  if (ledgerClosed(lifecycle.snapshot)) {
    return toned('bad', '登记簿不可用 · 出口一律不拨')
  }
  const unsaved = lifecycle.snapshot?.problem != null
  const rows = lifecycleRows(lifecycle)
  const count = (value: LifecycleRow['state']) =>
    rows.filter(row => row.state === value).length
  const blocked = rows.filter(row => row.reach.word === '不可拨').length
  return (
    [
      ...(unsaved ? [toned('bad', '登记簿写不进去')] : []),
      `已发布 ${count('active')}`,
      `已暂停 ${count('paused')}`,
      `已退役 ${count('retired')}`,
      blocked === 0
        ? toned('ok', '全部可拨')
        : toned('bad', `不可拨 ${blocked}`),
    ].join(railSep()) +
    ` <a class="jump" href="${attr(
      nodeTabPath(model.node, 'lifecycle'),
    )}" data-nav>查看</a>`
  )
}

export function renderNodeOverview(model: NodeOverviewModel): string {
  const facts = [fact('智能体', agentsFact(model))]
  if (model.server !== undefined) {
    facts.push(
      fact('服务器', `<span class="mono">${escapeHtml(model.server)}</span>`),
    )
  }
  const endpoint = model.agents?.[0]?.endpoint
  if (endpoint !== undefined) {
    facts.push(
      fact('端点', `<span class="mono">${escapeHtml(endpoint)}</span>`),
    )
  }
  if (model.certificate !== undefined) {
    facts.push(fact('证书', certificateLine(model.certificate, model.now)))
  }
  facts.push(fact('生命周期', lifecycleFact(model)))
  facts.push(
    fact(
      '模型',
      `<a class="jump" href="${attr(
        nodeTabPath(model.node, 'models'),
      )}" data-nav>查看这台节点生效的模型</a>`,
    ),
  )
  const strips =
    model.rosterFailure === null
      ? ''
      : failureBar(model.rosterFailure, '注册中心')
  const trail =
    model.trail === undefined
      ? ''
      : `<section class="sec" aria-labelledby="h-node-trail">` +
        sectionHead('Trail', '最近的消息链', {
          headingId: 'h-node-trail',
          sub: true,
          tail: `<a class="jump" href="${attr(
            model.trail.href,
          )}" data-nav>在消息链里查看全部</a>`,
        }) +
        `<div class="pane">${model.trail.html}</div></section>`
  return (
    `<section class="sec" aria-labelledby="h-node-facts">` +
    sectionHead('Node', '概览', { headingId: 'h-node-facts' }) +
    `<div class="pane">${strips}` +
    `<div class="card elev-sm node-facts">${facts.join('')}</div></div>` +
    `</section>` +
    trail
  )
}

// ---------------------------------------------------------------------------
// The 「模型」 tab
// ---------------------------------------------------------------------------

/**
 * The tab's mount. Its content is P18.9's: the page script loads the fragment
 * into it and, once that has worked, the shared runtime keeps it fresh like
 * any polled region. A fragment that is not there (404) leaves one calm line
 * and stops the polling, so the page is never in an error state for a
 * fragment this console does not have. The link to the matrix is outside the
 * mount and is the whole tab without script.
 */
export function renderModelsTab(node: string): string {
  const fragment = nodeModelsFragment(node)
  return (
    `<section class="sec" id="node-models-section" aria-labelledby="h-node-models">` +
    sectionHead('Models', '模型', {
      headingId: 'h-node-models',
      tail: `<a class="jump" id="node-models-link" href="${attr(
        nodeModelsLink(node),
      )}" data-nav>在模型服务页查看这台节点</a>`,
    }) +
    `<div class="pane"><div id="node-models" data-fragment="${attr(
      fragment,
    )}" data-poll="${attr(fragment)}" aria-live="polite">` +
    `<noscript><p class="note">这一页签的内容由模型服务页提供 · ` +
    `无脚本时请用上方链接</p></noscript>` +
    `</div></div></section>`
  )
}

// ---------------------------------------------------------------------------
// /nodes: the nodes the roster does not show
// ---------------------------------------------------------------------------

/**
 * Nodes the ledger or the managed list knows and the roster does not list —
 * a node whose every address is paused or retired drops off the roster, and
 * without this line there would be no way to reach the page that resumes it.
 */
export function renderLedgerOnly(
  snapshot: LifecycleSnapshot | null,
  agents: readonly ConsoleAgent[] | null,
): string {
  if (snapshot === null || agents === null) return ''
  const onRoster = new Set(agents.map(agent => nodeOf(agent.address)))
  const counts = new Map<
    string,
    { paused: number; retired: number; other: number }
  >()
  const touch = (node: string) => {
    let entry = counts.get(node)
    if (entry === undefined) {
      entry = { paused: 0, retired: 0, other: 0 }
      counts.set(node, entry)
    }
    return entry
  }
  const seen = new Set<string>()
  for (const record of snapshot.registrations) {
    const node = nodeOf(record.address)
    if (onRoster.has(node)) continue
    seen.add(record.address)
    const entry = touch(node)
    if (record.state === 'paused') entry.paused += 1
    else if (record.state === 'retired') entry.retired += 1
    else entry.other += 1
  }
  for (const address of snapshot.managed ?? []) {
    const node = nodeOf(address)
    if (onRoster.has(node) || seen.has(address)) continue
    touch(node).other += 1
  }
  if (counts.size === 0) return ''
  const lines = [...counts]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([node, entry]) => {
      const parts: string[] = []
      if (entry.paused > 0) parts.push(toned('warn', `已暂停 ${entry.paused}`))
      if (entry.retired > 0) parts.push(toned('bad', `已退役 ${entry.retired}`))
      if (entry.other > 0) parts.push(`其他 ${entry.other}`)
      return (
        `<li class="node-line"><a class="node-link" href="${attr(
          nodeTabPath(node, 'lifecycle'),
        )}" data-nav>${escapeHtml(node)}</a>` +
        `<span class="note">${parts.join(railSep())}</span></li>`
      )
    })
    .join('')
  return (
    `<section class="sec" id="ledger-only" aria-labelledby="h-ledger-only">` +
    sectionHead('Ledger', '名册上没有的节点', {
      headingId: 'h-ledger-only',
      sub: true,
      tail: `<span class="note">登记簿或托管清单里有 · 名册上没有</span>`,
    }) +
    `<ul class="node-lines card elev-sm">${lines}</ul></section>`
  )
}

// ---------------------------------------------------------------------------
// The page's own sheet and script
// ---------------------------------------------------------------------------

/** The node pages' own rules (`routes/types.ts`, `PageRoute.css`). */
export const NODE_PAGE_CSS = `
.node-tabs { display: flex; gap: var(--space-1); flex-wrap: wrap; border-bottom: 1px solid var(--color-divider); }
.node-tab {
  padding: var(--space-2) var(--space-4); color: var(--color-muted); text-decoration: none;
  border-bottom: 2px solid transparent; margin-bottom: -1px; font-weight: 600;
}
.node-tab:hover { color: var(--color-text); }
.node-tab[aria-current="page"] { color: var(--color-text); border-bottom-color: var(--color-accent); }
.node-facts { padding: var(--space-4); display: grid; gap: var(--space-2); }
.node-facts .kv { display: flex; flex-direction: row; gap: var(--space-4); align-items: baseline; flex-wrap: wrap; }
.node-facts .k { color: var(--color-muted); min-width: 5rem; font-size: 12px; }
.node-facts .v { font-size: 14px; }
.node-facts .sep { margin: 0 var(--space-2); }
.node-facts .v .jump:not(:first-child) { margin-left: var(--space-3); }
.node-life td { vertical-align: top; }
.node-life td.reach .note { display: block; }
.node-life td.when time, .node-life td.when .who { display: block; font-size: 12px; }
.node-life td.acts { white-space: nowrap; }
.node-life td.acts .btn + .btn { margin-left: var(--space-2); }
.node-life tr[data-state="retired"] td { color: var(--color-muted); }
#node-models[data-state="missing"] .note, #node-models[data-state="failed"] .note { margin: 0; }
.grp-name a { color: inherit; text-decoration: none; }
.grp-name a:hover { text-decoration: underline; }
`

/**
 * The node pages' script: the four lifecycle actions, the publish form, and
 * the 「模型」 tab's first load. Each action opens its confirmation and sends
 * only from there; the route writes the ledger line. Strings reach the page
 * through `textContent`; the one `innerHTML` is the fragment the server
 * rendered, the runtime's own rule (`assets/client.ts`).
 */
export const NODE_PAGE_JS = `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  if (!qc) return;

  function enc(value) { return encodeURIComponent(value); }

  var VERBS = {
    publish: { word: '发布', path: function () { return '/v0/agents'; },
      body: function (address) { return { address: address }; } },
    pause: { word: '暂停', path: function (a) { return '/v0/agents/' + enc(a) + '/pause'; } },
    resume: { word: '恢复', path: function (a) { return '/v0/agents/' + enc(a) + '/resume'; } },
    retire: { word: '退役', path: function (a) { return '/v0/agents/' + enc(a) + '/retire'; } }
  };

  function refresh() {
    var jobs = [];
    var ids = ['lifecycle', 'roster'];
    for (var i = 0; i < ids.length; i++) {
      var mount = qc.byId(ids[i]);
      if (mount && mount.getAttribute('data-poll')) jobs.push(qc.refreshRegion(mount));
    }
    return Promise.all(jobs);
  }

  function send(verb, address) {
    var spec = VERBS[verb];
    qc.sendJson('POST', spec.path(address), spec.body ? spec.body(address) : undefined)
      .then(function () {
        qc.toast('已' + spec.word + ' ' + address, 'ok');
        return refresh();
      })
      .catch(function (err) {
        qc.toast(qc.failLine(spec.word, err), qc.failTone(err));
      });
  }

  function confirm(verb, address) {
    if (!VERBS[verb] || !address) return;
    qc.setText('confirm-' + verb + '-addr', address);
    qc.openDialog('confirm-' + verb, function () { send(verb, address); });
  }

  qc.onAction('lifecycle', function (el) {
    confirm(el.getAttribute('data-verb') || '', el.getAttribute('data-address') || '');
  });

  qc.onSubmit('publish-form', function (form) {
    var field = form.elements['address'];
    var address = field && typeof field.value === 'string' ? field.value : '';
    if (!address) { qc.toast('没有可发布的地址', 'bad'); return; }
    confirm('publish', address);
  });

  // The 「模型」 tab: load once; keep it polled only if it was there. Not
  // before the runtime has started: it takes a \`?token=\` out of the URL
  // on DOMContentLoaded, and a load sent ahead of that carries no
  // credential, is answered 401, and expires the page.
  function loadModels() {
    var models = qc.byId('node-models');
    if (!models) return;
    var url = models.getAttribute('data-fragment') || '';
    if (!url) return;
    var line = function (text, state) {
      models.removeAttribute('data-poll');
      models.setAttribute('data-state', state);
      models.textContent = '';
      var p = document.createElement('p');
      p.className = 'note';
      p.textContent = text;
      models.appendChild(p);
    };
    qc.loadHtml(url).then(function (html) {
      models.innerHTML = html;
      models.setAttribute('data-state', 'loaded');
    }).catch(function (err) {
      if (qc.isExpired()) return;
      // The status, not the words: the words are the page's line (C5).
      if (err && err.status === 404) line('模型服务暂无这台节点的信息 · 可在模型服务页查看', 'missing');
      else line('模型信息读取失败 · ' + qc.message(err), 'failed');
    });
  }

  if (document.readyState === 'loading') {
    // Registered after the runtime's own listener, so it runs after it.
    document.addEventListener('DOMContentLoaded', loadModels);
  } else {
    loadModels();
  }
})();
`
