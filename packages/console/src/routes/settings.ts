// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 设置与关于 — what this console is, and the ceilings it runs under.
 *
 * Owns `/v0/limits` and `/fragments/limits`.
 */

import type { ConsoleAgent, ConsoleDeps, LimitsSnapshot } from '../deps.js'
import { html, json, methodNotAllowed, notFound } from '../respond.js'
import { sectionHead } from '../view/bits.js'
import { escapeHtml } from '../view/escape.js'
import { rosterLease } from '../view/format.js'
import { renderLimits } from '../view/limits.js'
import {
  DEFAULT_BIN_NAME,
  DEFAULT_LABEL,
  guard,
  underPath,
  valueOf,
} from './shared.js'
import type { RouteContext, RouteModule } from './types.js'

/**
 * The limits snapshot as the page states it.
 *
 * Only `registryTtlMs` differs from `deps.limits`: on the page it is the lease
 * the registry actually grants ({@link rosterLease}), read off the same roster
 * the header and every row are judged from, so the three places that print a
 * lease cannot disagree with each other or with the registry. `deps.limits`
 * carries the package default and stays what `/v0/limits` reports; it is the
 * number shown only when the roster offers nothing to read a lease from.
 */
export function pageLimits(
  deps: ConsoleDeps,
  agents: readonly ConsoleAgent[] | null,
): LimitsSnapshot {
  return {
    ...deps.limits,
    registryTtlMs: rosterLease(agents ?? [], deps.limits.registryTtlMs),
  }
}

/**
 * The instance's own facts, as a definition list: the things an operator
 * reads off this page before reporting a problem with it.
 */
function instanceFacts(ctx: RouteContext): string {
  const { deps } = ctx
  const rows: (readonly [string, string])[] = [
    ['实例', deps.label ?? DEFAULT_LABEL],
    ['控制台身份', deps.identity ?? '未设置'],
    ['命令名', deps.binName ?? DEFAULT_BIN_NAME],
  ]
  return (
    `<dl class="dl">` +
    rows
      .map(
        ([key, value]) =>
          `<div class="lim-row"><dt>${escapeHtml(key)}</dt>` +
          `<dd class="mono">${escapeHtml(value)}</dd></div>`,
      )
      .join('') +
    `</dl>`
  )
}

export const settingsRoute: RouteModule = {
  area: {
    id: 'settings',
    label: '设置与关于',
    group: 'admin',
    href: '/settings',
    icon: 'settings',
  },
  page: {
    match: underPath('settings'),
    guard: 'view',
    async render(ctx) {
      const listed = await ctx.roster()
      return {
        title: '设置与关于',
        body:
          `<section class="sec" id="instance-section">` +
          sectionHead('Instance', '实例', { headingId: 'h-instance' }) +
          `<div class="card elev-sm">${instanceFacts(ctx)}</div></section>` +
          `<section class="sec" id="limits-section">` +
          sectionHead('Limits', '限额', {
            headingId: 'h-limits',
            tail: `<span class="note">只读 · 数值真源在 @qianmo/protocol 的 LIMITS</span>`,
          }) +
          `<div class="card elev-sm" id="limits">${renderLimits(
            pageLimits(ctx.deps, valueOf(listed)),
          )}</div></section>`,
      }
    },
  },
  api: {
    heads: ['limits'],
    async handle(ctx, _head, rest) {
      if (rest.length !== 0) {
        return notFound(`unknown path: ${ctx.url.pathname}`)
      }
      const denied = guard(ctx.access.credential, 'view', 'guarded')
      if (denied !== null) return denied
      if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
      return json(ctx.deps.limits)
    },
  },
  fragments: {
    heads: ['limits'],
    async handle(ctx, _head, rest) {
      if (rest.length !== 0) {
        return notFound(`unknown path: ${ctx.url.pathname}`)
      }
      const denied = guard(ctx.access.credential, 'view', 'guarded')
      if (denied !== null) return denied
      if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
      // The same section the page renders, so the same registry read behind
      // it: a fragment that printed the package default here would put the
      // page's 注册租约 back to 1 分 30 秒 on its first refresh. A registry
      // that is down costs the observed lease, not the fragment.
      const listed = await ctx.roster()
      return html(renderLimits(pageLimits(ctx.deps, valueOf(listed))))
    },
  },
}
