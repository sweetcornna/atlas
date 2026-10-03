// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 总览 — the console's landing page, and the package's historic page exports.
 *
 * Until the shell (`view/shell.ts`) this file rendered the one long page that
 * held everything: overview, roster, servers, wake, trail, register, limits.
 * Each of those now has its own address (`routes/`), and what is left here is
 * the overview itself plus the names the package entry has always exported —
 * `renderPage`, `PageModel`, `BRAND`, `CSP`, `documentHead` — now pointing at
 * the shell they moved into.
 *
 * ## The overview cards read the fragments, not a second copy of the data
 *
 * `renderRoster` and `renderAudit` already compute the counts their headers
 * print; `renderLimits` already computes the rate and the lease TTL. Rather
 * than give the overview a second, raw shape of the same numbers, the header
 * markup carries them out as `data-*` attributes (see the `stats` option on
 * `sectionHead`) and {@link renderOverview} reads those back off the
 * already-rendered fragment strings. One source of truth for each number, even
 * though it crosses a module boundary as a string rather than as a value.
 */

import { icon, sectionHead } from './bits.js'
import { escapeHtml } from './escape.js'
import { formatDuration } from './format.js'
import { renderShell, type ShellModel } from './shell.js'

export { CSP } from '../respond.js'
export { BRAND, documentHead } from './shell.js'

/** A whole console page, as the shell draws it. */
export type PageModel = ShellModel

/**
 * A whole console document. Kept under its historic name because the package
 * entry exports it; every page — this one included — is drawn by the shell.
 */
export function renderPage(model: PageModel): string {
  return renderShell(model)
}

export interface OverviewModel {
  /** Output of `renderRoster`; only its header numbers are read. */
  readonly roster: string
  /** Output of `renderAudit` / `renderAuditSources`; header numbers only. */
  readonly audit: string
  /** Output of `renderLimits`; `data-ttl-ms` and `data-rate` only. */
  readonly limits: string
  /** Output of `renderNodeSummary`: one line per node, linking to it. */
  readonly nodes: string
}

function statCard(card: {
  readonly kicker: string
  readonly value: string
  readonly unit?: string
  readonly hint: string
  readonly glyph: string
  readonly blob?: string
}): string {
  const blob = card.blob === undefined ? 'blob' : `blob ${card.blob}`
  const unit =
    card.unit === undefined
      ? ''
      : `<span class="u">${escapeHtml(card.unit)}</span>`
  return (
    `<div class="card elev-sm stat">` +
    `<div class="stat-top">` +
    `<div class="card-kicker">${escapeHtml(card.kicker)}</div>` +
    `<span class="${blob}">${icon(card.glyph)}</span>` +
    `</div>` +
    `<div class="stat-num">${escapeHtml(card.value)}${unit}</div>` +
    `<div class="card-meta">${card.hint}</div>` +
    `</div>`
  )
}

/**
 * Read one `data-*` number back off a fragment this module did not render.
 *
 * The key is always one of our own literals (see the `stats` note on
 * `sectionHead`), so this is not parsing hostile input — it is one module
 * reading a value another module already computed and escaped.
 */
function fragmentStat(html: string, key: string): string | null {
  const match = html.match(new RegExp(`data-${key}="([^"]*)"`))
  return match === null ? null : match[1]
}

/** The 消息链 card's tag: the trail's own verdict, in the trail's words. */
function trailTag(audit: string): string {
  const trailIssues = fragmentStat(audit, 'issues')
  const trailIntact = fragmentStat(audit, 'intact')
  const witness = fragmentStat(audit, 'witness')
  const auditState = fragmentStat(audit, 'audit-state')
  const issues = trailIssues === null ? 0 : Number(trailIssues)
  if (auditState === 'unavailable') {
    return `<span class="tag tag-neutral">部分未读取</span>`
  }
  // Ahead of every integrity verdict: a chain that is not there has none, and
  // this card's whole job is to stop reading that as 完整.
  if (auditState === 'absent') {
    return `<span class="tag tag-accent">未建立</span>`
  }
  if (auditState === 'tampered') {
    return `<span class="tag tag-critical">锚点不符</span>`
  }
  if (auditState === 'stale' || auditState === 'unwitnessed') {
    return `<span class="tag tag-neutral">未见证</span>`
  }
  if (auditState === 'uncovered') {
    return `<span class="tag tag-neutral">未覆盖</span>`
  }
  const broken = `<span class="tag tag-accent">断裂 ${escapeHtml(String(issues))}</span>`
  if (auditState === 'broken') return broken
  if (auditState === 'verified') {
    return `<span class="tag tag-accent-2">链完整</span>`
  }
  if (trailIntact === 'false' || issues > 0) return broken
  if (witness === 'tampered') {
    return `<span class="tag tag-critical">锚点不符</span>`
  }
  if (witness === 'verified') {
    return `<span class="tag tag-accent-2">链完整</span>`
  }
  return `<span class="tag tag-neutral">未见证</span>`
}

const OVERVIEW_HEADING_ID = 'h-overview'

/**
 * The overview page body: four cards, then one line per node.
 *
 * Every number here also exists on the page it summarises — this is a
 * summary, not a second source, which is why it reads its numbers off the
 * rendered fragments rather than being handed raw data.
 */
export function renderOverview(model: OverviewModel): string {
  const agentsTotal = fragmentStat(model.roster, 'total')
  const agentsOnline = fragmentStat(model.roster, 'online')
  const trailTotal = fragmentStat(model.audit, 'total')
  const ttlMs = fragmentStat(model.limits, 'ttl-ms')
  const rate = fragmentStat(model.limits, 'rate')

  const cards = [
    statCard({
      kicker: '智能体',
      value: agentsTotal ?? '—',
      hint:
        agentsOnline === null
          ? '—'
          : `<span class="tone-ok">在线 ${escapeHtml(agentsOnline)}</span>`,
      glyph: 'server',
    }),
    statCard({
      kicker: '消息链',
      value: trailTotal ?? '—',
      hint: trailTag(model.audit),
      glyph: 'activity',
      blob: 'blob-2',
    }),
    statCard({
      kicker: '注册租约',
      value: ttlMs === null ? '—' : formatDuration(Number(ttlMs)),
      hint: 'TTL · 到期即摘牌',
      glyph: 'clock',
      blob: 'blob-n',
    }),
    statCard({
      kicker: '速率预算',
      value: rate ?? '—',
      unit: '/ 分',
      hint: '节点 × 节点',
      glyph: 'zap',
    }),
  ].join('')

  return (
    `<section class="sec" id="overview" aria-labelledby="${OVERVIEW_HEADING_ID}">` +
    sectionHead('Overview', '运行概况', { headingId: OVERVIEW_HEADING_ID }) +
    `<div class="cards g4">${cards}</div></section>\n` +
    `<section class="sec" id="overview-nodes">${model.nodes}</section>`
  )
}
