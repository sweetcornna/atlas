// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 权限模式 (P39): the page and `/fragments/elevation`.
 *
 * | Route | Who |
 * |---|---|
 * | `GET /admin/elevation`, `GET /fragments/elevation` | view and up |
 *
 * The controls write through `/v0/elevation` (`routes/elevationApi.ts`): ops
 * level, and opening a mode further needs a personal ops credential verified
 * in the last 30 minutes. Without an elevation port the area is not offered.
 */

import { html, methodNotAllowed, notFound } from '../respond.js'
import {
  ELEVATION_PAGE_CSS,
  elevationDialogs,
  renderElevation,
  renderElevationFailure,
  type ElevationModel,
} from '../view/elevation.js'
import { ELEVATION_PAGE_JS } from '../view/elevationScript.js'
import { KIT_CSS } from '../view/kit.js'
import { elevationApi } from './elevationApi.js'
import { canOps, guardRead } from './directionShared.js'
import type { RouteContext, RouteModule } from './types.js'

const RECENT = 30

async function body(ctx: RouteContext): Promise<string> {
  const port = ctx.deps.elevation
  if (port === undefined) return ''
  const [agents, actions] = await Promise.all([
    port.list(),
    port.actions(null, RECENT),
  ])
  if (!agents.ok) return renderElevationFailure(agents.failure)
  const model: ElevationModel = {
    agents: agents.value,
    actions: actions.ok ? actions.value : null,
    now: ctx.now,
    ops: canOps(ctx),
  }
  return renderElevation(model)
}

export const elevationRoute: RouteModule = {
  area: {
    id: 'elevation',
    label: '权限模式',
    group: 'manage',
    href: '/admin/elevation',
    icon: 'shield',
  },
  page: {
    match: segments =>
      segments.length === 1 && segments[0] === 'elevation' ? [] : null,
    guard: 'view',
    available: ctx => ctx.deps.elevation !== undefined,
    async render(ctx) {
      if (ctx.deps.elevation === undefined)
        return notFound(`unknown path: ${ctx.url.pathname}`)
      return {
        title: '权限模式',
        body:
          `<div class="kit-pane" id="elevation" data-poll="/fragments/elevation">` +
          (await body(ctx)) +
          `</div>` +
          (canOps(ctx) ? elevationDialogs() : ''),
      }
    },
    css: KIT_CSS + ELEVATION_PAGE_CSS,
    script: ELEVATION_PAGE_JS,
  },
  api: elevationApi,
  fragments: {
    heads: ['elevation'],
    async handle(ctx, _head, rest) {
      if (rest.length !== 0)
        return notFound(`unknown path: ${ctx.url.pathname}`)
      if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
      const denied = guardRead(ctx)
      if (denied !== null) return denied
      return html(await body(ctx))
    },
  },
}
