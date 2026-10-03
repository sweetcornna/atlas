// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 总览 — the landing page: four cards, then one line per node.
 *
 * Owns `/` and nothing else. Every number here also exists on the page it
 * summarises, and the cards read it off the same view output that page
 * renders (`view/page.ts`), so the overview cannot disagree with the roster,
 * the trail or the limits about a count.
 */

import { renderNodeSummary, renderRoster } from '../view/agents.js'
import { renderAudit, renderAuditSources } from '../view/audit.js'
import { renderLimits } from '../view/limits.js'
import { renderOverview } from '../view/page.js'
import { pageLimits } from './settings.js'
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
      // The overview's trail card counts the unfiltered tail: a filter is a
      // property of the trail page, not of the console.
      const [listed, trails] = await Promise.all([
        ctx.roster(),
        readAuditSources(deps, {}),
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
          limits: renderLimits(pageLimits(deps, agents)),
          nodes: renderNodeSummary(agents, failure, now, ttl),
        }),
      }
    },
    css: OVERVIEW_CSS,
  },
}
