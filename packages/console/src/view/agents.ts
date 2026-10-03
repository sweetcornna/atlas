// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The roster: who is on the network, and which of them is answering.
 *
 * This is the read half of M1's exit test — *内测用户无需接触 CLI 即可完成注册与
 * 查看*. The write half is the register form in `page.ts`; the two are one
 * feature, which is why the empty state here does not just say "none". An
 * empty registry is the state a first-time user is *guaranteed* to be in, and
 * a blank list there fails the exit test at the only moment it is being taken.
 *
 * ## One card per node, one disclosure row per agent
 *
 * The roster used to be an eight-column table with `table-layout: fixed` and
 * every value clipped to an ellipsis, because the widest legitimate value in
 * some columns is longer than the column that has to hold it. Grouping by node
 * removes the column-budget problem rather than tuning it: the node appears
 * once in a card header instead of once per row, the row keeps four things
 * (address, status, lease, heartbeat), and everything else — capabilities,
 * endpoint, key fingerprint, the exact heartbeat clock and the deregister
 * button — moves into a native `<details>` panel that opens under the row.
 *
 * `<details>`, not a script: the panel opens with JavaScript disabled, and the
 * five-second poller that replaces this whole fragment cannot leave a
 * half-opened row behind because the browser re-parses the markup fresh.
 *
 * ## The address is the signature element
 *
 * `qianmo://node-a/reviewer` renders with its *agent* segment as a terracotta
 * pill. That is the one piece of the string an operator is actually scanning
 * for, and it is the reason the node grouping reads as grouping rather than as
 * repetition. {@link splitAddress} is deliberately forgiving: an address that
 * does not parse is shown whole, in the group named by the whole string, rather
 * than dropped.
 *
 * ## Every value is hostile input
 *
 * `address`, `endpoint`, `capabilities` and `status` are whatever the peer that
 * registered chose to send. `status` in particular is typed `string`, not the
 * registry's enum, so a peer can put a tag in it. Nothing is interpolated
 * without `escapeHtml`/`attr` — see `escape.ts` for why there is no exception
 * list. Long values are contained by CSS (`overflow-wrap`, ellipsis inside a
 * fixed-width `.addr`) rather than by a column budget, so one hostile
 * capability string can no longer squeeze a neighbour to one character a line.
 *
 * ## The endpoint says how to reach it, not where it is
 *
 * On a fleet reached through SSH tunnels every node's endpoint is
 * `ws://127.0.0.1:<some port>` — four machines, four addresses that differ by
 * one number. So a card also states which *server* the node runs on, when the
 * console was started with that mapping (`--node-server`). It is deliberately
 * beside the endpoint rather than anywhere else on the card: the endpoint is
 * the value it exists to correct.
 *
 * Without the mapping the line is absent rather than blank. A blank one would
 * make "this console was not told" and "this node has no machine" look the
 * same.
 *
 * ## The rail is gone; the numbers are not
 *
 * The 140px noun column every row used to open with has been replaced by a
 * stacked section header. The counts it carried (`4 · 在线 2 · 滞后 1`) are now
 * the header's right-hand side, and the same numbers still ride out as `data-*`
 * on the header element so `page.ts` can build the overview cards without a
 * second pass over the roster (see `sectionHead` in `bits.ts`).
 */

import {
  absent,
  address as addressLine,
  bar,
  chevron,
  chip,
  failureBar,
  field,
  icon,
  sectionHead,
  splitAddress,
  state,
  tag,
  toned,
  type Tone,
} from './bits.js'
import {
  certificateIndex,
  certificateLine,
  certificateTally,
  renderRevocationBar,
  renderRootBars,
  reissueCommand,
} from './certificates.js'
import { attr, escapeHtml } from './escape.js'
import {
  agentHealth,
  formatClock,
  formatDuration,
  formatRelative,
  formatShortDuration,
  leaseView,
  publicKeyFingerprint,
  rosterLease,
  type AgentHealth,
} from './format.js'
import type {
  CertificateSnapshot,
  ConsoleAgent,
  ConsoleCaRoot,
  ConsoleCertificate,
  ConsoleFailure,
  NodeServer,
  WakeTarget,
} from '../deps.js'

/**
 * The certificate half of the roster (key-distribution.md §10.1), or absent.
 *
 * Absent removes the column rather than filling it with "unknown" — see
 * `CertificatePort`'s note on why a column of unknowns is worse than no
 * column: it makes "this deployment has no certificates yet" and "every
 * certificate is broken" render identically.
 */
export interface RosterCertificates {
  readonly snapshot: CertificateSnapshot | null
  readonly failure: ConsoleFailure | null
  /** The trust file's roots (`CertificatePort.roots`), one header strip each. */
  readonly roots: readonly ConsoleCaRoot[]
  /**
   * The CLI name §10.2's copyable `ca issue` line is written under. Supplied
   * by the host: this package is a leaf and has no way to learn how it was
   * invoked, and a hard-coded `qm` here would be a second spelling of a name
   * that already has exactly one (`src/constants/identity.ts`).
   */
  readonly binName: string
}

const HEALTH_TONE: Readonly<Record<AgentHealth, Tone>> = {
  live: 'ok',
  stale: 'warn',
  expired: 'bad',
}

/** Two characters, and the dot carries the rest. */
const DECLARED: Readonly<Record<string, string | undefined>> = {
  online: '在线',
  dormant: '休眠',
}

const NODES_HEADING_ID = 'h-nodes'

/** The id the overview cards read their numbers off. */
const ROSTER_HEAD_ID = 'roster-head'

/**
 * One word for two facts.
 *
 * The word is the declared status while the lease holds, and the *health* verb
 * once it stops — because "dormant" and "expired" are answers to different
 * questions and only one of them matters at a time. The dot is always health,
 * so the colour never lies even when the word is the peer's own.
 */
function statusCell(agent: ConsoleAgent, health: AgentHealth): string {
  if (health === 'expired') return state('bad', '过期')
  if (health === 'stale') return state('warn', '滞后')
  const declared = DECLARED[agent.status]
  if (declared !== undefined) return state(HEALTH_TONE[health], declared)
  // The registry declares two statuses; anything else is a string a peer chose,
  // and `status` is typed `string` precisely so it can be one. Escaping makes
  // it inert but not *short* — an unbounded word here spills across the row.
  const raw = agent.status === '' ? '未声明' : agent.status
  const shown = raw.length <= 4 ? raw : `${raw.slice(0, 4)}…`
  return `<span title="${attr(raw)}">${state(HEALTH_TONE[health], shown)}</span>`
}

function capabilityCell(capabilities: readonly string[] | undefined): string {
  const tags = capabilities ?? []
  if (tags.length === 0) return absent()
  return `<span class="tags">${tags.map(value => chip(value)).join('')}</span>`
}

/**
 * A fingerprint, never key material.
 *
 * "It is the public half" is true and beside the point: the field exists so two
 * nodes can be told apart at a glance, and eight hex characters do that.
 * Printing the key would make every screenshot of this page a lookup table.
 */
function keyCell(publicKey: string | undefined): string {
  if (publicKey === undefined || publicKey === '') {
    return `<span class="absent">未发布</span>`
  }
  return `<code class="mono fp">${escapeHtml(
    publicKeyFingerprint(publicKey),
  )}</code>`
}

/** The absolute clock, plus how long ago that was. */
function heartbeatValue(at: number, now: number): string {
  if (!Number.isFinite(at) || at <= 0) return absent()
  return (
    `<span class="mono">${escapeHtml(formatClock(at))}</span> ` +
    `<span class="absent">${escapeHtml(formatRelative(at, now))}</span>`
  )
}

/**
 * The signature graphic: how much of the lease is *left*, as a pill track.
 *
 * Sage while the lease is in its first half, terracotta past the halfway mark,
 * and empty once it has lapsed — the same three verdicts the status dot gives,
 * because {@link leaseView} takes the health rather than recomputing it. The
 * bar carries a *ratio*, which is the one fact no other value on the row
 * expresses: an absolute clock says when a node last spoke, only the ratio says
 * how close that is to being too long ago.
 *
 * **The fill is the remaining share, not the elapsed one.** `leaseView` reports
 * elapsed, which is the natural thing to compute and the wrong thing to draw
 * next to the words `剩余 1m24s`: a nearly-empty bar beside "1m24s left" makes
 * the reader stop and work out which of the two is lying. Draining left to
 * right also means every unhealthy row is the *short* bar, so the roster's
 * problems are the gaps rather than the marks.
 */
function leaseCell(
  agent: ConsoleAgent,
  now: number,
  ttlMs: number,
  health: AgentHealth,
): string {
  const view = leaseView(agent, now, ttlMs, health)
  if (view === null) return `<span class="lease">${absent()}</span>`

  const width = 100 - Math.round(view.ratio * 100)
  const fill = view.tone === 'ink' ? '' : ` lease-${view.tone}`
  const expiry =
    Number.isFinite(agent.expiresAt) && agent.expiresAt > 0
      ? ` title="到期 ${attr(formatClock(agent.expiresAt))}"`
      : ''
  const dead = view.tone === 'dead'
  const left = dead ? ' gone' : ''
  const text = dead
    ? '租约已过期'
    : `剩余 ${formatShortDuration(view.remainingMs)}`
  return (
    `<span class="lease"${expiry}>` +
    `<span class="lease-trk" data-ratio="${attr(String(width))}">` +
    `<span class="lease-fill${fill}" style="width:${width}%"></span></span>` +
    `<span class="lease-left${left}">${escapeHtml(text)}</span></span>`
  )
}

/** The note under an expanded row: what the state means for the next action. */
function rowNote(health: AgentHealth): string {
  if (health === 'expired') {
    return '租约已过期 · 重新注册或续一次心跳才能再被唤醒'
  }
  if (health === 'stale') {
    return '租约过半 · 再无心跳就会被自动摘牌'
  }
  return '注销后该地址立即从名册摘除 · 需要重新注册才能再被唤醒'
}

function agentRow(
  agent: ConsoleAgent,
  now: number,
  ttlMs: number,
  canWrite: boolean,
): string {
  const health = agentHealth(agent, now, ttlMs)
  const address = attr(agent.address)
  const beatable = health !== 'expired'
  const kv = (key: string, value: string) =>
    `<div class="kv"><span class="k">${escapeHtml(key)}</span>` +
    `<span class="v">${value}</span></div>`

  // The two writes on a row are not drawn for a credential that may not make
  // them (C7): a button that can only ever answer 403 teaches the operator
  // that the console is broken, not that they are read-only. The page says
  // "read-only" once, in the top bar, rather than on every row.
  const heartbeat = canWrite
    ? `<button type="button" class="btn btn-secondary btn-small" ` +
      `data-action="heartbeat" data-address="${address}" data-write${
        beatable ? '' : ' disabled'
      }>心跳</button>`
    : ''
  const deregister = canWrite
    ? `<button type="button" class="btn btn-ghost btn-danger" ` +
      `data-action="deregister" data-address="${address}" data-write>` +
      icon('power', { small: true }) +
      `注销</button>`
    : ''

  return (
    // `data-key` is what the runtime reopens this row by after the poller
    // replaces the roster under it (`assets/client.ts`, D1).
    `<details class="row" data-key="${address}" data-address="${address}" ` +
    `data-health="${attr(health)}">` +
    `<summary>` +
    addressLine(agent.address) +
    statusCell(agent, health) +
    leaseCell(agent, now, ttlMs, health) +
    heartbeat +
    chevron() +
    `</summary>` +
    `<div class="row-panel">` +
    kv('能力', capabilityCell(agent.capabilities)) +
    kv('端点', `<span class="mono">${escapeHtml(agent.endpoint)}</span>`) +
    kv('公钥', keyCell(agent.publicKey)) +
    kv('上次心跳', heartbeatValue(agent.lastHeartbeatAt, now)) +
    `<div class="row-acts">` +
    deregister +
    `<span class="note">${escapeHtml(rowNote(health))}</span>` +
    `</div></div></details>`
  )
}

interface HealthTally {
  readonly live: number
  readonly stale: number
  readonly expired: number
}

function tallyOf(
  agents: readonly ConsoleAgent[],
  now: number,
  ttl: number,
): HealthTally {
  let live = 0
  let stale = 0
  let expired = 0
  for (const one of agents) {
    const health = agentHealth(one, now, ttl)
    if (health === 'live') live += 1
    else if (health === 'stale') stale += 1
    else expired += 1
  }
  return { live, stale, expired }
}

/** Agents under one node, in the order the registry listed them. */
interface NodeGroup {
  readonly node: string
  readonly agents: readonly ConsoleAgent[]
}

/**
 * Group by node, preserving first-seen order.
 *
 * Not sorted alphabetically: the registry's order is the order the nodes joined
 * and it is stable between polls, while an alphabetical sort makes a rename
 * jump a card across the page under the cursor.
 */
function groupByNode(agents: readonly ConsoleAgent[]): readonly NodeGroup[] {
  const buckets = new Map<string, ConsoleAgent[]>()
  for (const one of agents) {
    const { node } = splitAddress(one.address)
    const bucket = buckets.get(node)
    if (bucket === undefined) buckets.set(node, [one])
    else bucket.push(one)
  }
  return [...buckets].map(([node, list]) => ({ node, agents: list }))
}

/** The badge on a group header: how many of this node's agents need attention. */
function groupBadge(counts: HealthTally): string {
  if (counts.stale === 0 && counts.expired === 0) {
    return tag(`${counts.live} 个在线`, 'ok')
  }
  if (counts.live === 0) return tag('整节点不可拨', 'muted')
  return tag(`${counts.stale + counts.expired} 个需注意`, 'warn')
}

/**
 * The bare node segment out of a group key.
 *
 * `groupByNode` keys on what `splitAddress` returns, which keeps the scheme
 * (`qianmo://node-a`); the certificate table is keyed on the segment alone
 * (`node-a`), because that is what a certificate's SAN binds. One place strips
 * the scheme, because two places doing it is two regexes that can drift.
 */
export function bareNode(groupKey: string): string {
  return groupKey.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
}

function nodeCard(
  group: NodeGroup,
  now: number,
  ttlMs: number,
  certificate: ConsoleCertificate | undefined,
  binName: string,
  server: string | undefined,
  canWrite: boolean,
): string {
  const counts = tallyOf(group.agents, now, ttlMs)
  const first = group.agents[0]
  const endpoint =
    first === undefined
      ? ''
      : `<span class="note mono">${escapeHtml(first.endpoint)}</span>`
  const name = bareNode(splitAddress(group.node).node)
  // Under the header, not inside `grp-tail`: a certificate is a fact about the
  // *node*, and the tail already carries the endpoint and the health badge —
  // three unrelated things on one line is how this card was before the roster
  // stopped being a table.
  const certificate_ = certificateLine(certificate, now)
  const reissue = reissueCommand(certificate, binName)
  // Before the endpoint, because it is the answer to the question the endpoint
  // provokes on a tunnelled fleet: every one of them reads 127.0.0.1.
  const host =
    server === undefined
      ? ''
      : `<span class="note">服务器 <span class="mono">${escapeHtml(
          server,
        )}</span></span>`
  return (
    `<div class="card elev-sm grp">` +
    `<div class="grp-head">` +
    `<span class="grp-name">${escapeHtml(name === '' ? group.node : name)}</span>` +
    `<span class="addr">${escapeHtml(group.node)}</span>` +
    `<div class="grp-tail">${host}${endpoint}${groupBadge(counts)}</div>` +
    `</div>` +
    (certificate_ === ''
      ? ''
      : `<div class="grp-cert">${certificate_}${reissue}</div>`) +
    group.agents.map(one => agentRow(one, now, ttlMs, canWrite)).join('') +
    `</div>`
  )
}

/**
 * The header line: the count, then only the states that actually occurred.
 *
 * `滞后 0` and `过期 0` are printed by dashboards that want to look complete;
 * here they would spend the line's whole width saying nothing, and — worse —
 * make an amber or red word a permanent fixture, so that the day one of them is
 * real nothing about the line has changed.
 */
function headTail(
  total: number,
  counts: HealthTally,
  leaseMs: number,
  certificates: readonly ConsoleCertificate[] | null,
): string {
  const parts = [
    `<span class="total">${total}</span>`,
    toned('ok', `在线 ${counts.live}`),
  ]
  if (counts.stale > 0) parts.push(toned('warn', `滞后 ${counts.stale}`))
  if (counts.expired > 0) parts.push(toned('bad', `过期 ${counts.expired}`))
  if (Number.isFinite(leaseMs) && leaseMs > 0) {
    parts.push(
      `<span class="ttl">租约 ${escapeHtml(formatDuration(leaseMs))}</span>`,
    )
  }
  const certificateCount = certificateTally(certificates)
  if (certificateCount !== '') parts.push(certificateCount)
  return `<div class="rowx note">${parts.join('<span class="sep">·</span>')}</div>`
}

function rosterHead(
  tail: string,
  stats?: Readonly<Record<string, string | number | boolean>>,
): string {
  return sectionHead('Roster', '名册', {
    id: ROSTER_HEAD_ID,
    headingId: NODES_HEADING_ID,
    tail,
    ...(stats === undefined ? {} : { stats }),
  })
}

/**
 * Render the roster fragment: the section header and the node cards.
 *
 * `failure` and `agents` are independent: a refresh that fails after a
 * successful first load passes both, and the right answer is to show the strip
 * *and* keep the last known list. A roster blanked by a transient registry
 * hiccup reads as "everyone left".
 *
 * `ttlMs` is the scale of last resort. Every row is judged against the lease
 * the registry granted it (`expiresAt − lastHeartbeatAt`, see `leaseOf` in
 * `format.ts`); `ttlMs` only stands in for a record that carries no lease.
 *
 * `options.canWrite` draws the row's 心跳 and 注销 and the empty state's
 * invitation to register. Off unless asked for: a caller that forgets to say
 * gets the read-only roster, never a page of buttons that 403.
 */
export function renderRoster(
  agents: readonly ConsoleAgent[] | null,
  failure: ConsoleFailure | null,
  now: number,
  ttlMs: number,
  certificates?: RosterCertificates,
  nodeServers?: readonly NodeServer[],
  options: { readonly canWrite?: boolean } = {},
): string {
  const canWrite = options.canWrite === true
  const body: string[] = []
  if (failure !== null) {
    body.push(failureBar(failure, '注册中心'))
    if (agents !== null && agents.length > 0) {
      body.push(bar('muted', '以下为最后一次成功读取'))
    }
  }
  // §10.1 calls this the most important row on the page, and §6.4 is why: a
  // stale list fails the whole network closed to `--trust` with nothing else
  // on screen to say so. It goes above the cards, not inside one, because it
  // is a fact about every node at once.
  if (certificates !== undefined) {
    body.push(
      renderRevocationBar(
        certificates.snapshot?.revocationList ?? null,
        certificates.failure,
        now,
      ),
      // The roots come from the console's own trust file, not the registry,
      // so they are drawn even when the read above failed.
      renderRootBars(certificates.roots, now),
    )
  }
  const certificateList = certificates?.snapshot?.certificates ?? null
  const byNode = certificateIndex(certificateList)
  const binName = certificates?.binName ?? ''
  // Keyed on the bare segment for the same reason the certificate index is:
  // `--node-server beta-1=p11` names a node, and the group key still carries
  // the scheme.
  const serverOf = new Map(
    (nodeServers ?? []).map(entry => [entry.node, entry.server]),
  )

  if (agents === null) {
    if (failure === null) body.push(`<p class="hint">未取得注册数据</p>`)
    return rosterHead('') + `<div class="pane">${body.join('')}</div>`
  }

  if (agents.length === 0) {
    // The empty state spends its one line on the next action rather than on
    // the news — for whoever may take it. A read-only credential is told who
    // does instead of being offered a dialog that is not there.
    body.push(
      canWrite
        ? `<p class="hint">还没有节点 · ` +
            `<a class="jump" href="#register-dialog" ` +
            `data-open-dialog="register-dialog" data-write>注册第一个</a></p>`
        : `<p class="hint">还没有节点 · 由运维注册</p>`,
    )
    return (
      rosterHead(`<div class="rowx note"><span class="total">0</span></div>`, {
        total: 0,
        online: 0,
        stale: 0,
        expired: 0,
      }) + `<div class="pane">${body.join('')}</div>`
    )
  }

  body.push(
    `<div class="stack">` +
      groupByNode(agents)
        .map(group =>
          nodeCard(
            group,
            now,
            ttlMs,
            byNode.get(bareNode(group.node)),
            binName,
            serverOf.get(bareNode(group.node)),
            canWrite,
          ),
        )
        .join('') +
      `</div>`,
  )

  const counts = tallyOf(agents, now, ttlMs)
  // The registry's lease, not `ttlMs`: that one is only the scale of last
  // resort, and printing it here is how the header used to say 1 分 30 秒 over
  // a registry running hour-long leases (C-1).
  const leaseMs = rosterLease(agents, ttlMs)
  return (
    rosterHead(headTail(agents.length, counts, leaseMs, certificateList), {
      total: agents.length,
      online: counts.live,
      stale: counts.stale,
      expired: counts.expired,
    }) + `<div class="pane">${body.join('')}</div>`
  )
}

/**
 * Every roster address, as the wake form's target options.
 *
 * The wake form used to be a text box the operator retyped an address into.
 * The addresses are already on the page one section up; a picker built from
 * them cannot be mistyped, and the status suffix means the operator can see
 * they are waking something that is not answering *before* they send.
 */
export function wakeTargetOptions(
  agents: readonly ConsoleAgent[] | null,
  now: number,
  ttlMs: number,
  selected?: string,
): string {
  if (agents === null || agents.length === 0) return ''
  const word: Readonly<Record<AgentHealth, string>> = {
    live: '在线',
    stale: '滞后',
    expired: '过期',
  }
  return agents
    .map(one => {
      const health = agentHealth(one, now, ttlMs)
      const mark = one.address === selected ? ' selected' : ''
      return (
        `<option value="${attr(one.address)}"${mark}>` +
        `${escapeHtml(one.address)} · ${escapeHtml(word[health])}</option>`
      )
    })
    .join('')
}

/**
 * The same addresses, without the state suffix, for the trail's node filter.
 *
 * A filter is asking "show me lines about this address", and whether that agent
 * is answering right now has nothing to do with whether it appears in the
 * trail — a dead node is exactly the one somebody filters for.
 */
export function agentFilterOptions(
  agents: readonly ConsoleAgent[] | null,
  selected?: string,
): string {
  if (agents === null || agents.length === 0) return ''
  return agents
    .map(
      one =>
        `<option value="${attr(one.address)}"${
          one.address === selected ? ' selected' : ''
        }>${escapeHtml(one.address)}</option>`,
    )
    .join('')
}

// ---------------------------------------------------------------------------
// The overview's one line per node
// ---------------------------------------------------------------------------

/**
 * One line per node, for the overview: the name (a link to the node's own
 * page), how many agents it carries, and the same badge its roster card shows.
 *
 * The badge is {@link groupBadge}, not a second judgement: the overview and
 * the roster must not be able to disagree about whether a node needs
 * attention.
 */
export function renderNodeSummary(
  agents: readonly ConsoleAgent[] | null,
  failure: ConsoleFailure | null,
  now: number,
  ttlMs: number,
): string {
  const head = sectionHead('Nodes', '节点', {
    tail: `<a class="jump" href="/nodes" data-nav>查看名册</a>`,
  })
  if (agents === null) {
    return (
      head +
      (failure === null
        ? `<p class="hint">未取得注册数据</p>`
        : failureBar(failure, '注册中心'))
    )
  }
  if (agents.length === 0) return head + `<p class="hint">还没有节点</p>`
  const rows = groupByNode(agents)
    .map(group => {
      const name = bareNode(splitAddress(group.node).node)
      const shown = name === '' ? group.node : name
      return (
        `<li class="node-line">` +
        `<a class="node-link" href="/nodes/${attr(
          encodeURIComponent(shown),
        )}" data-nav>${escapeHtml(shown)}</a>` +
        `<span class="note">${escapeHtml(
          String(group.agents.length),
        )} 个智能体</span>` +
        groupBadge(tallyOf(group.agents, now, ttlMs)) +
        `</li>`
      )
    })
    .join('')
  return (
    head +
    (failure === null ? '' : failureBar(failure, '注册中心')) +
    `<ul class="node-lines card elev-sm">${rows}</ul>`
  )
}

/**
 * How many nodes the agents run on: the number the sidebar prints beside
 * 节点. Grouped the way the roster groups its cards, so the count and the
 * cards under it can never disagree; the agent total is the overview's
 * 智能体 card, a different number with a different name.
 */
export function nodeCount(agents: readonly ConsoleAgent[]): number {
  return groupByNode(agents).length
}

/** The agents registered under one bare node name, in registry order. */
export function agentsOfNode(
  agents: readonly ConsoleAgent[],
  node: string,
): readonly ConsoleAgent[] {
  return agents.filter(one => bareNode(splitAddress(one.address).node) === node)
}

// ---------------------------------------------------------------------------
// The two forms and two confirmations of the nodes page
// ---------------------------------------------------------------------------

/** Wake delay ceiling, matching the one `createWakePort` enforces. */
const MAX_WAKE_AFTER_MS = 60_000

/** The capabilities the register form offers as ticks rather than as prose. */
const CAPABILITY_CHOICES: readonly (readonly [string, boolean])[] = [
  ['task.request', true],
  ['task.result', false],
  ['chat.message', false],
  ['audit.read', false],
]

function capabilityChecks(): string {
  return CAPABILITY_CHOICES.map(
    ([value, on]) =>
      `<label class="chk"><input type="checkbox" name="capabilities" ` +
      `value="${attr(value)}"${on ? ' checked' : ''}><span class="bx">` +
      icon('check', { small: true }) +
      `</span><span class="mono">${escapeHtml(value)}</span></label>`,
  ).join('')
}

/** A dialog's title row: an icon disc and the title. */
function dialogTop(
  id: string,
  glyph: string,
  title: string,
  alt = false,
): string {
  return (
    `<div class="dlg-top"><span class="dlg-icon${alt ? ' dlg-icon-2' : ''}">` +
    icon(glyph) +
    `</span><div class="dialog-title" id="${attr(id)}">` +
    `${escapeHtml(title)}</div></div>`
  )
}

/**
 * The register form, in its own dialog.
 *
 * 地址 and 端点 stay in the open (capabilities are four checkboxes with the
 * common one pre-ticked); status and key fold away behind a native
 * `<details>`. The register action used to be a form at the bottom of a page
 * six screens tall, under the trail; it is now the nodes page's primary action
 * and opens here, over the roster it adds to.
 */
export function registerDialog(): string {
  return (
    `<dialog class="dialog dialog-wide" id="register-dialog" ` +
    `aria-labelledby="register-title">` +
    dialogTop('register-title', 'plus', '注册节点', true) +
    `<form id="register-form" class="stack" novalidate>` +
    `<div class="form-grid">` +
    field('address', '地址', 'qianmo://node-a/reviewer', { required: true }) +
    // The registry's isValidEndpoint takes a schemed URL (ws:// et al.) or a
    // qianmo:// address — a bare host:port is refused with a 400. The
    // placeholder must teach a format that will actually be accepted.
    field('endpoint', '端点', 'ws://主机:端口 · 也接受 qianmo:// 地址', {
      required: true,
    }) +
    `</div>` +
    `<div class="field"><span>能力</span>` +
    `<div class="rowx" style="gap:var(--space-2)">${capabilityChecks()}</div>` +
    `</div>` +
    `<details class="adv"><summary>${chevron()}高级选项 · 状态与公钥</summary>` +
    `<div class="adv-body">` +
    `<div class="field"><label for="f-status">状态 · 默认在线</label>` +
    `<span class="sel"><select class="input" id="f-status" name="status">` +
    `<option value="online" selected>在线</option>` +
    `<option value="dormant">休眠</option>` +
    `</select>${chevron()}</span></div>` +
    `<div class="field field-wide"><label for="f-publicKey">` +
    `公钥 · 可选 · 留空则该地址不参与签名校验</label>` +
    `<textarea class="input" id="f-publicKey" name="publicKey" rows="3" ` +
    `spellcheck="false" placeholder="ed25519 公钥 · base64"></textarea></div>` +
    `</div></details>` +
    `<p class="note">注册即获得一份租约 · 到期前必须续心跳</p>` +
    `<p class="status" id="register-status" role="status"></p>` +
    `<div class="dialog-actions">` +
    `<button type="button" class="btn btn-secondary" ` +
    `data-action="confirm-cancel">取消</button>` +
    `<button type="submit" class="btn btn-primary" data-write>` +
    icon('plus', { small: true }) +
    `注册</button>` +
    `</div></form></dialog>`
  )
}

/** What the nodes page knows about waking, from the startup flags. */
export interface WakeFormModel {
  readonly enabled: boolean
  /** `<option>` markup from {@link wakeTargetOptions}; empty is a text box. */
  readonly targetOptions: string
  readonly wakeUrl?: string
  readonly wakeTargets?: readonly WakeTarget[]
  /** The address this console speaks as, prefilled into 发起方. */
  readonly identity?: string
}

/**
 * The one disabled-state sentence the wake face is allowed.
 *
 * Both halves are load-bearing: what is unavailable, and the exact name of the
 * thing to go and set. "唤醒不可用" on its own sends somebody to the docs.
 */
const WAKE_DISABLED_REASON = '唤醒不可用 · 未设置 QIANMO_TRANSPORT_PSK'

function wakeTargetField(options: string): string {
  if (options === '') {
    return field('to', '目标', 'qianmo://node-b/reviewer', { required: true })
  }
  return (
    `<div class="field"><label for="wake-to">目标</label>` +
    `<span class="sel"><select class="input" id="wake-to" name="to">` +
    `${options}</select>${chevron()}</span></div>`
  )
}

function wakeReceipt(url: string | undefined): string {
  if (url === undefined || url === '') return ''
  return (
    `<div class="hintline" style="margin-top:var(--space-2)">` +
    icon('info', { small: true }) +
    `唤醒回执 · <span class="mono">${escapeHtml(url)}</span></div>`
  )
}

function wakeNodeTargets(targets: readonly WakeTarget[] | undefined): string {
  if (targets === undefined || targets.length === 0) return ''
  const options = targets
    .map(target => {
      const suffix = target.wake === undefined ? ' · PSK 不可用' : ' · 已配置'
      return (
        '<option value="' +
        attr(target.node) +
        '"' +
        (target.wake === undefined ? ' disabled' : '') +
        '>' +
        escapeHtml(target.node + suffix) +
        '</option>'
      )
    })
    .join('')
  return (
    '<div class="field"><label for="wake-node">唤醒节点</label>' +
    '<span class="sel"><select class="input" id="wake-node" name="node">' +
    options +
    '</select>' +
    chevron() +
    '</span></div>'
  )
}

/**
 * The wake form, in its own dialog.
 *
 * With no PSK the fields render inside a disabled `<fieldset>` with the
 * reason, and **no submit button at all**. A greyed-out button still invites a
 * click; a missing one, next to the name of the variable, says what to go and
 * do. The form's 回调 box stays gone: it could only ever hold the one URL the
 * console is pinned to, so it is a line of read-only small print.
 */
export function wakeDialog(model: WakeFormModel): string {
  const identity = model.identity ?? ''
  const fields =
    `<div class="form-grid wake-grid">` +
    `<div>${wakeNodeTargets(model.wakeTargets)}${wakeTargetField(
      model.targetOptions,
    )}${wakeReceipt(model.wakeUrl)}</div>` +
    `<div class="field"><label for="wake-prompt">提示词<i class="req">*</i></label>` +
    `<textarea class="input" id="wake-prompt" name="prompt" rows="4" ` +
    `placeholder="告诉这个智能体要做什么 · 例如 把 packages/console 的 CSS token 按用途分组并回报数量"` +
    `></textarea></div>` +
    `</div>` +
    `<details class="adv"><summary>${chevron()}高级选项 · 发起方与延迟</summary>` +
    `<div class="adv-body">` +
    `<div class="field"><label for="wake-from">发起方 · 已预填当前控制台身份</label>` +
    // readonly, never disabled: a disabled field is not submitted, and the
    // HTTP side still requires `from`.
    `<input class="input" id="wake-from" name="from" value="${attr(
      identity,
    )}"${identity === '' ? '' : ' readonly'}></div>` +
    `<div class="field"><label for="wake-after">延迟（毫秒）· 上限 ${MAX_WAKE_AFTER_MS}</label>` +
    `<input class="input" id="wake-after" name="afterMs" type="number" ` +
    `value="0" min="0" max="${MAX_WAKE_AFTER_MS}"></div>` +
    `</div></details>`

  const cancel =
    `<button type="button" class="btn btn-secondary" ` +
    `data-action="confirm-cancel">取消</button>`
  const body = model.enabled
    ? `<form id="wake-form" class="stack" novalidate>${fields}` +
      `<p class="note">点一下会先弹确认 · 确认后才真的投递</p>` +
      `<p class="status" id="wake-status" role="status"></p>` +
      `<div class="dialog-actions">${cancel}` +
      `<button type="submit" class="btn btn-primary" data-write>` +
      icon('zap', { small: true }) +
      `唤醒</button></div></form>`
    : `<p class="note" id="wake-why">${escapeHtml(WAKE_DISABLED_REASON)}</p>` +
      `<fieldset disabled aria-describedby="wake-why">${fields}</fieldset>` +
      `<div class="dialog-actions">${cancel}</div>`
  return (
    `<dialog class="dialog dialog-wide" id="wake-dialog" ` +
    `aria-labelledby="wake-title">` +
    dialogTop('wake-title', 'zap', '唤醒智能体', true) +
    body +
    `</dialog>`
  )
}

/**
 * The 注销 confirmation.
 *
 * Rendered once, outside the roster, hidden. The address is written in by the
 * page script with `textContent` when a row's 注销 is pressed — a dialog inside
 * the polled roster fragment would be replaced out from under the operator
 * mid-read.
 */
export function deregisterConfirm(): string {
  return (
    `<dialog class="dialog" id="confirm-deregister" ` +
    `aria-labelledby="confirm-deregister-title">` +
    dialogTop('confirm-deregister-title', 'power', '注销这个智能体') +
    `<div class="dialog-body">` +
    `<div class="recap"><div class="recap-row"><span class="k">地址</span>` +
    `<span class="addr mono" id="confirm-deregister-addr"></span></div></div>` +
    `<p>这个地址会立刻从名册摘除 · 在途消息按丢弃处理 · ` +
    `节点重新注册之前不能再被唤醒</p>` +
    `</div>` +
    `<div class="dialog-actions">` +
    `<button type="button" class="btn btn-secondary" ` +
    `data-action="confirm-cancel">取消</button>` +
    `<button type="button" class="btn btn-danger" ` +
    `data-action="confirm-deregister" data-write>` +
    icon('power', { small: true }) +
    `注销</button>` +
    `</div></dialog>`
  )
}

/** The 唤醒 confirmation: the target, who is asking, the delay, the prompt. */
export function wakeConfirm(): string {
  return (
    `<dialog class="dialog" id="confirm-wake" ` +
    `aria-labelledby="confirm-wake-title">` +
    dialogTop('confirm-wake-title', 'zap', '唤醒这个智能体', true) +
    `<div class="dialog-body">` +
    `<div class="recap">` +
    `<div class="recap-row"><span class="k">目标</span>` +
    `<span class="addr mono" id="confirm-wake-to"></span></div>` +
    `<div class="recap-row"><span class="k">发起方</span>` +
    `<span class="addr mono" id="confirm-wake-from"></span></div>` +
    `<div class="recap-row"><span class="k">延迟</span>` +
    `<span class="mono" id="confirm-wake-after"></span></div>` +
    `</div>` +
    `<p class="note">提示词</p>` +
    `<p class="quote" id="confirm-wake-prompt"></p>` +
    `</div>` +
    `<div class="dialog-actions">` +
    `<button type="button" class="btn btn-secondary" ` +
    `data-action="confirm-cancel">返回修改</button>` +
    `<button type="button" class="btn btn-primary" ` +
    `data-action="confirm-wake" data-write>` +
    icon('zap', { small: true }) +
    `唤醒</button>` +
    `</div></dialog>`
  )
}
