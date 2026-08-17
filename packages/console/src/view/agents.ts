// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The node table: who is on the network, and which of them is answering.
 *
 * This is the read half of M1's exit test — *内测用户无需接触 CLI 即可完成注册与
 * 查看*. The write half is the register form in `page.ts`; the two are one
 * feature, which is why the empty state here does not just say "none". An
 * empty registry is the state a first-time user is *guaranteed* to be in, and
 * a blank table there fails the exit test at the only moment it is being taken.
 *
 * ## The fragment owns its rail
 *
 * `renderRoster` emits both cells of its row: the rail (`节点`, then
 * `4 · 在线 2 · 滞后 1`) and the pane (the table). The counts have to be
 * computed from the same array the rows come from, and they have to be replaced
 * by the same five-second poll that replaces the rows — a rail rendered by
 * `page.ts` would either go stale or need a second mount point. Every branch
 * below emits the rail, including the failure and empty branches; the page's
 * `aria-labelledby` points at the heading inside it.
 *
 * ## The lease bar
 *
 * The last two time columns used to be `心跳` (a clock, plus how long ago) and
 * `到期` (a countdown). Between them they printed the same fact three times.
 * They are now one 3px bar — heartbeat age over lease TTL — plus the absolute
 * clock, which is the only part a person can put in a ticket. The bar is the
 * one graphic element on the page and it earns that by carrying a *ratio*: no
 * column of numbers lets you see at a glance which node is closest to falling
 * off the roster.
 *
 * ## Every cell is hostile input
 *
 * `address`, `endpoint`, `capabilities` and `status` are whatever the peer that
 * registered chose to send. `status` in particular is typed `string`, not the
 * registry's enum, so a peer can put a tag in it. Nothing is interpolated
 * without `escapeHtml`/`attr` — see `escape.ts` for why there is no exception
 * list.
 *
 * ## Why the table has a colgroup and clips
 *
 * `table-layout: fixed` with declared widths, values clipped to an ellipsis and
 * the full text in `title`. The auto layout hands column widths to the content,
 * and one endpoint from an untrusted peer is enough to reduce a neighbouring
 * column to one character per line — which is both unreadable and a thing any
 * peer can do to this page on purpose.
 */

import {
  absent,
  bar,
  chip,
  failureBar,
  hint,
  rail,
  railSep,
  scroll,
  state,
  toned,
  type Tone,
} from './bits.js'
import { attr, escapeHtml } from './escape.js'
import {
  agentHealth,
  formatClock,
  formatDuration,
  formatRelative,
  formatShortDuration,
  leaseView,
  publicKeyFingerprint,
  type AgentHealth,
} from './format.js'
import type { ConsoleAgent, ConsoleFailure } from '../deps.js'

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

/**
 * One column for two facts.
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
  // it inert but not *short* — an unbounded word here spills across the lease
  // column and hides it. Two characters and a tooltip.
  const raw = agent.status === '' ? '未声明' : agent.status
  const shown = raw.length <= 4 ? raw : `${raw.slice(0, 4)}…`
  return `<span title="${attr(raw)}">${state(HEALTH_TONE[health], shown)}</span>`
}

function capabilityCell(capabilities: readonly string[] | undefined): string {
  const tags = capabilities ?? []
  if (tags.length === 0) return absent()
  return `<span class="tags">${tags.map(tag => chip(tag)).join('')}</span>`
}

/**
 * A fingerprint, never key material.
 *
 * "It is the public half" is true and beside the point: the column exists so
 * two nodes can be told apart at a glance, and eight hex characters do that.
 * Printing the key would make every screenshot of this page a lookup table.
 */
function keyCell(publicKey: string | undefined): string {
  if (publicKey === undefined || publicKey === '') {
    return `<span class="absent">未发布</span>`
  }
  const fingerprint = publicKeyFingerprint(publicKey)
  return `<code class="mono fp">${escapeHtml(fingerprint)}</code>`
}

/**
 * The absolute clock, with the relative gap in the tooltip.
 *
 * One value on screen: the bar next to it already says how long ago that was,
 * and printing "8 秒前" under every clock is the duplication the bar replaced.
 */
function heartbeatCell(at: number, now: number): string {
  if (!Number.isFinite(at) || at <= 0) {
    return `<td class="when">${absent()}</td>`
  }
  return (
    `<td class="when" title="${attr(formatRelative(at, now))}">` +
    `${escapeHtml(formatClock(at))}</td>`
  )
}

/**
 * The signature element: how much of the lease is gone, as 3px of width.
 *
 * Ink under half, `--stale` past the halfway mark, `--dead` and locked to the
 * full width once the lease has lapsed — the same three verdicts the status dot
 * gives, because {@link leaseView} takes the health rather than recomputing it.
 * `title` carries the absolute expiry, which is the column this replaced.
 */
function leaseCell(
  agent: ConsoleAgent,
  now: number,
  ttlMs: number,
  health: AgentHealth,
): string {
  const view = leaseView(agent, now, ttlMs, health)
  if (view === null) return `<td class="lease">${absent()}</td>`

  const width = Math.round(view.ratio * 100)
  const fill = view.tone === 'ink' ? '' : ` lease-${view.tone}`
  const expiry =
    Number.isFinite(agent.expiresAt) && agent.expiresAt > 0
      ? ` title="到期 ${attr(formatClock(agent.expiresAt))}"`
      : ''
  const left = view.tone === 'dead' ? ' gone' : ''
  return (
    `<td class="lease"${expiry}>` +
    `<span class="lease-bar" data-ratio="${attr(String(width))}">` +
    `<span class="lease-fill${fill}" style="width:${width}%"></span></span>` +
    `<span class="lease-left${left}">` +
    `${escapeHtml(formatShortDuration(view.remainingMs))}</span></td>`
  )
}

/** A clipped cell that keeps the whole value reachable through `title`. */
function clipped(cls: string, value: string): string {
  return `<td class="${cls}" title="${attr(value)}">${escapeHtml(value)}</td>`
}

function row(agent: ConsoleAgent, now: number, ttlMs: number): string {
  const health = agentHealth(agent, now, ttlMs)
  const address = attr(agent.address)
  return (
    `<tr data-address="${address}" data-health="${attr(health)}">` +
    clipped('mono clip addr', agent.address) +
    clipped('mono clip', agent.endpoint) +
    `<td class="caps">${capabilityCell(agent.capabilities)}</td>` +
    `<td>${statusCell(agent, health)}</td>` +
    leaseCell(agent, now, ttlMs, health) +
    heartbeatCell(agent.lastHeartbeatAt, now) +
    `<td class="clip">${keyCell(agent.publicKey)}</td>` +
    `<td class="actions">` +
    `<button type="button" class="btn" data-action="heartbeat" ` +
    `data-address="${address}">心跳</button>` +
    `<button type="button" class="btn btn-destructive" data-action="deregister" ` +
    `data-address="${address}">注销</button>` +
    `</td></tr>`
  )
}

/**
 * Header text and the fixed width each column gets. Sums to 100.
 *
 * The budget is set here rather than left to the content because the content
 * belongs to other people: with an auto layout a single long capability tag
 * pushes the action buttons off the right edge, which any peer on the network
 * can arrange on purpose. Widths are chosen so the widest *legitimate* value in
 * each column fits — an eight-hex fingerprint, two buttons, a `4m50s`
 * lease — and everything longer clips to an ellipsis with the full text in
 * `title`.
 */
const COLUMNS: readonly (readonly [string, string])[] = [
  ['地址', '18%'],
  ['端点', '14%'],
  ['能力', '13%'],
  ['状态', '8%'],
  ['租约', '14%'],
  ['心跳', '9%'],
  ['公钥', '9%'],
  ['操作', '15%'],
]

interface HealthTally {
  readonly live: number
  readonly stale: number
  readonly expired: number
}

function tally(
  agents: readonly ConsoleAgent[],
  now: number,
  ttl: number,
): HealthTally {
  let live = 0
  let stale = 0
  let expired = 0
  for (const agent of agents) {
    const health = agentHealth(agent, now, ttl)
    if (health === 'live') live += 1
    else if (health === 'stale') stale += 1
    else expired += 1
  }
  return { live, stale, expired }
}

/**
 * The rail line: the count, then only the states that actually occurred.
 *
 * `滞后 0` and `过期 0` are printed by dashboards that want to look complete;
 * here they would spend the line's whole width saying nothing, and — worse —
 * make an amber or red word a permanent fixture, so that the day one of them is
 * real nothing about the line has changed.
 *
 * Takes the already-computed tally rather than the agent array so the one
 * pass over the roster that {@link renderRoster} makes can also be echoed
 * onto the rail's `data-*` stats for the overview cards in `page.ts`.
 */
function railDigits(total: number, counts: HealthTally, ttlMs: number): string {
  const parts = [
    `<span class="total">${total}</span>`,
    toned('ok', `在线 ${counts.live}`),
  ]
  if (counts.stale > 0) parts.push(toned('warn', `滞后 ${counts.stale}`))
  if (counts.expired > 0) parts.push(toned('bad', `过期 ${counts.expired}`))
  if (Number.isFinite(ttlMs) && ttlMs > 0) {
    parts.push(
      `<span class="ttl">租约 ${escapeHtml(formatDuration(ttlMs))}</span>`,
    )
  }
  return parts.join(railSep())
}

const NODES_HEADING_ID = 'h-nodes'

function nodesRail(
  digits: string,
  stats?: Readonly<Record<string, string | number | boolean>>,
): string {
  return rail('节点', { id: NODES_HEADING_ID, digits, stats })
}

/**
 * Render the node fragment: the rail cell and the pane cell of the node row.
 *
 * `failure` and `agents` are independent: a refresh that fails after a
 * successful first load passes both, and the right answer is to show the strip
 * *and* keep the last known table. A table blanked by a transient registry
 * hiccup reads as "everyone left".
 */
export function renderRoster(
  agents: readonly ConsoleAgent[] | null,
  failure: ConsoleFailure | null,
  now: number,
  ttlMs: number,
): string {
  const pane: string[] = []
  if (failure !== null) {
    pane.push(failureBar(failure, '注册中心'))
    if (agents !== null && agents.length > 0) {
      pane.push(bar('muted', '以下为最后一次成功读取'))
    }
  }

  if (agents === null) {
    if (failure === null) pane.push(hint('未取得注册数据'))
    return nodesRail('') + `<div class="pane">${pane.join('')}</div>`
  }

  if (agents.length === 0) {
    // The empty state is one of the two places on this page allowed a line of
    // its own, and it spends it on the next action rather than on the news.
    pane.push(
      `<p class="hint">还没有节点 · ` +
        `<a class="jump" href="#register">在下面注册第一个</a></p>`,
    )
    return (
      nodesRail(`<span class="total">0</span>`, {
        total: 0,
        online: 0,
        stale: 0,
        expired: 0,
      }) + `<div class="pane">${pane.join('')}</div>`
    )
  }

  const cols = COLUMNS.map(
    ([, width]) => `<col style="width:${attr(width)}">`,
  ).join('')
  const head = COLUMNS.map(
    ([label]) => `<th scope="col">${escapeHtml(label)}</th>`,
  ).join('')
  const body = agents.map(agent => row(agent, now, ttlMs)).join('')

  pane.push(
    scroll(
      `<table class="grid roster"><caption class="sr-only">节点</caption>` +
        `<colgroup>${cols}</colgroup>` +
        `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
    ),
  )

  const counts = tally(agents, now, ttlMs)
  return (
    nodesRail(railDigits(agents.length, counts, ttlMs), {
      total: agents.length,
      online: counts.live,
      stale: counts.stale,
      expired: counts.expired,
    }) + `<div class="pane">${pane.join('')}</div>`
  )
}
