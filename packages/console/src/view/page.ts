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
 * print. Rather than give the overview a second, raw shape of the same
 * numbers, the header markup carries them out as `data-*` attributes (see the
 * `stats` option on `sectionHead`) and {@link renderOverview} reads those back
 * off the already-rendered fragment strings. One source of truth for each
 * number, even though it crosses a module boundary as a string rather than as
 * a value.
 *
 * ## Every card is something that changes (A2)
 *
 * Two of the four cards used to be protocol constants - the registry lease
 * and the rate budget - the same on every visit. They live on 设置与关于,
 * where constants belong; the overview now spends its four places on the
 * network's health: who answers, whether the chain holds, what was refused
 * or dropped in the last hour, and the certificates (or, on a console
 * without a certificate source, the conversations).
 */

import type {
  AuditPage,
  CertificateSnapshot,
  ChatSession,
  ConsoleFailure,
} from '../deps.js'
import { icon, sectionHead, tag } from './bits.js'
import { certificateTally } from './certificates.js'
import { attr, escapeHtml } from './escape.js'
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
  /** Refusals and drops in the last hour; `null` when no trail could be read. */
  readonly recent: RecentOutcomes | null
  /** The certificate directory; absent on a console without one. */
  readonly certificates?: {
    readonly snapshot: CertificateSnapshot | null
    readonly failure: ConsoleFailure | null
  }
  /**
   * The conversations, for a console with chat and no certificate source;
   * `null` when the list could not be read, absent when not asked for.
   */
  readonly sessions?: readonly ChatSession[] | null
  readonly now: number
  /** Output of `renderNodeSummary`: one line per node, linking to it. */
  readonly nodes: string
}

/** How far back the overview's refusal card looks. */
export const RECENT_WINDOW_MS = 3_600_000

/** Refusals and drops in the window, over every trail read. */
export interface RecentOutcomes {
  readonly refused: number
  readonly dropped: number
  /** A trail held more in the window than one read returns: the counts are a floor. */
  readonly more: boolean
}

/**
 * Count the window's refusals and drops off one windowed read per trail.
 * `limit` is what was asked for, for a port that does not say whether there
 * is more (no `earlier`): a full page is taken to mean there may be.
 */
export function recentOutcomes(
  pages: readonly (AuditPage | null)[],
  limit: number,
): RecentOutcomes | null {
  let read = 0
  let refused = 0
  let dropped = 0
  let more = false
  for (const page of pages) {
    if (page === null) continue
    read += 1
    for (const record of page.records) {
      if (record.outcome === 'refused') refused += 1
      else if (record.outcome === 'dropped') dropped += 1
    }
    if (
      page.earlier === undefined
        ? page.records.length >= limit
        : page.earlier !== null
    ) {
      more = true
    }
  }
  return read === 0 ? null : { refused, dropped, more }
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

/** 在线, and 滞后 and 过期 only when there are any: a standing 0 is noise. */
function agentsHint(roster: string): string {
  const online = fragmentStat(roster, 'online')
  if (online === null) return '—'
  const parts = [`<span class="tone-ok">在线 ${escapeHtml(online)}</span>`]
  const stale = Number(fragmentStat(roster, 'stale') ?? 0)
  const expired = Number(fragmentStat(roster, 'expired') ?? 0)
  if (stale > 0) parts.push(`<span class="tone-warn">滞后 ${stale}</span>`)
  if (expired > 0) parts.push(`<span class="tone-bad">过期 ${expired}</span>`)
  return parts.join('<span class="sep">·</span>')
}

/** What was refused and dropped in the last hour, and the way to the records. */
function recentCard(recent: RecentOutcomes | null): string {
  const floor = recent?.more === true ? '+' : ''
  const look =
    `<a class="jump" href="${attr('/audit?window=1h&outcome=refused')}" ` +
    `data-nav>查看</a>`
  return statCard({
    kicker: '近 1 小时拒绝',
    value: recent === null ? '—' : `${recent.refused}${floor}`,
    hint:
      recent === null
        ? '读不到审计链'
        : `<span class="${recent.dropped > 0 ? 'tone-warn' : 'tone-muted'}">` +
          `丢弃 ${recent.dropped}${floor}</span>` +
          `<span class="sep">·</span>${look}`,
    glyph: 'alert-triangle',
    blob: 'blob-n',
  })
}

/** How many certificates, how many need a look, and the revocation list. */
function certificateCard(
  read: NonNullable<OverviewModel['certificates']>,
  now: number,
): string {
  const snapshot = read.snapshot
  if (snapshot === null) {
    return statCard({
      kicker: '证书',
      value: '—',
      hint: read.failure === null ? '—' : tag('读不到证书目录', 'bad'),
      glyph: 'shield',
    })
  }
  const parts: string[] = []
  const tally = certificateTally(snapshot.certificates)
  if (tally !== '') parts.push(tally)
  const list = snapshot.revocationList
  if (list === null) parts.push(tag('吊销清单未发布', 'warn'))
  else if (list.nextUpdate <= now) parts.push(tag('吊销清单已过期', 'bad'))
  else parts.push(tag(`已吊销 ${list.revokedCount}`, 'muted'))
  return statCard({
    kicker: '证书',
    value: String(snapshot.certificates.length),
    hint: parts.join(' '),
    glyph: 'shield',
  })
}

/** Conversations touched in the last hour, out of all of them. */
function sessionsCard(
  sessions: readonly ChatSession[] | null,
  now: number,
): string {
  if (sessions === null) {
    return statCard({
      kicker: '近 1 小时会话',
      value: '—',
      hint: tag('读不到会话', 'bad'),
      glyph: 'messages-square',
    })
  }
  const active = sessions.filter(
    one => now - one.updatedAt <= RECENT_WINDOW_MS,
  ).length
  return statCard({
    kicker: '近 1 小时会话',
    value: String(active),
    hint: `共 ${sessions.length} 条 <span class="sep">·</span><a class="jump" href="/chat" data-nav>打开</a>`,
    glyph: 'messages-square',
  })
}

/**
 * The overview page body: four cards, then one line per node.
 *
 * Every number here also exists on the page it summarises — this is a
 * summary, not a second source, which is why it reads its numbers off the
 * rendered fragments rather than being handed raw data.
 */
export function renderOverview(model: OverviewModel): string {
  const trailTotal = fragmentStat(model.audit, 'total')

  const cards = [
    statCard({
      kicker: '智能体',
      value: fragmentStat(model.roster, 'total') ?? '—',
      hint: agentsHint(model.roster),
      glyph: 'server',
    }),
    statCard({
      kicker: '消息链',
      value: trailTotal ?? '—',
      hint: trailTag(model.audit),
      glyph: 'activity',
      blob: 'blob-2',
    }),
    recentCard(model.recent),
  ]
  if (model.certificates !== undefined) {
    cards.push(certificateCard(model.certificates, model.now))
  } else if (model.sessions !== undefined) {
    cards.push(sessionsCard(model.sessions, model.now))
  }

  return (
    `<section class="sec" id="overview" aria-labelledby="${OVERVIEW_HEADING_ID}">` +
    sectionHead('Overview', '运行概况', { headingId: OVERVIEW_HEADING_ID }) +
    `<div class="cards g${cards.length}">${cards.join('')}</div></section>\n` +
    `<section class="sec" id="overview-nodes">${model.nodes}</section>`
  )
}
