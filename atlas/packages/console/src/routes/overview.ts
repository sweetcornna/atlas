// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 总览 — the landing page: health cards, then one line per node.
 *
 * Owns `/` and nothing else. Every number here also exists on the page it
 * summarises, and the cards read it off the same view output that page
 * renders (`view/page.ts`), so the overview cannot disagree with the roster,
 * the trail or the limits about a count.
 */

import { renderNodeSummary, renderRoster } from '../view/agents.js'
import { renderAudit, renderAuditSources } from '../view/audit.js'
import {
  RECENT_WINDOW_MS,
  recentOutcomes,
  renderOverview,
} from '../view/page.js'
import { MAX_AUDIT_LIMIT } from './audit.js'
import { consoleEvents } from './events.js'
import { notFound } from '../respond.js'
import {
  failureOf,
  readAuditSources,
  singleLegacyAudit,
  valueOf,
} from './shared.js'
import type { RouteModule } from './types.js'

/** The node lines are this page's alone, so their rules ride with it (§6.1). */
const OVERVIEW_CSS = `
.node-lines { list-style: none; margin: 0; padding: var(--space-1) var(--space-4); display: flex; flex-direction: column; }
.node-line {
  display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;
  padding: var(--space-3) 0; border-bottom: 1px solid var(--color-divider);
}
.node-line:last-child { border-bottom: 0; }
.node-link { font-weight: 600; color: var(--color-text); text-decoration: none; }
.node-link:hover { color: var(--color-accent-700); }
.node-line .tag { margin-left: auto; }
`

export const overviewRoute: RouteModule = {
  api: {
    heads: ['events'],
    async handle(ctx, _head, rest) {
      if (rest.length !== 0)
        return notFound(`unknown path: ${ctx.url.pathname}`)
      return consoleEvents(ctx)
    },
  },
  area: {
    id: 'overview',
    label: '总览',
    group: 'run',
    href: '/',
    icon: 'layout-dashboard',
  },
  page: {
    match: segments => (segments.length === 0 ? [] : null),
    guard: 'view',
    async render(ctx) {
      const { deps, now } = ctx
      const ttl = deps.limits.registryTtlMs
      // One read per trail serves two cards: its header numbers (the total,
      // the integrity and the witness are facts about the whole file, not
      // about the filter) and the last hour's refusals and drops (A2).
      const [listed, trails, certificates, sessions] = await Promise.all([
        ctx.roster(),
        readAuditSources(deps, {
          from: now - RECENT_WINDOW_MS,
          limit: MAX_AUDIT_LIMIT,
        }),
        deps.certificates?.read(),
        deps.certificates === undefined ? deps.chat?.sessions() : undefined,
      ])
      const agents = valueOf(listed)
      const failure = failureOf(listed)
      const audit = singleLegacyAudit(deps)
        ? renderAudit(trails[0]?.page ?? null, trails[0]?.failure ?? null, {})
        : renderAuditSources(trails, {})
      return {
        title: '总览',
        body: renderOverview({
          roster: renderRoster(agents, failure, now, ttl),
          audit,
          recent: recentOutcomes(
            trails.map(trail => trail.page),
            MAX_AUDIT_LIMIT,
          ),
          ...(certificates === undefined
            ? {}
            : {
                certificates: {
                  snapshot: valueOf(certificates),
                  failure: failureOf(certificates),
                },
              }),
          ...(sessions === undefined ? {} : { sessions: valueOf(sessions) }),
          now,
          nodes: renderNodeSummary(agents, failure, now, ttl),
        }),
      }
    },
    css: OVERVIEW_CSS,
  },
}
