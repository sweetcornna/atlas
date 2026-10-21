// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 云端电脑 (P21): the page and `/fragments/desktop`.
 *
 * | Route | Who |
 * |---|---|
 * | `GET /admin/desktop`, `GET /fragments/desktop` | view and up |
 *
 * The switches write through `/v0/desktop` (`routes/desktopApi.ts`, ops
 * level: a desktop changes what a node runs and holds logins). Without a
 * desktop port the area is not offered. The screenshots are read by the page
 * script from `GET /v0/desktop/<node>/<agent>/screen`, not drawn into the
 * polled fragment: a fragment that carried megabytes of image every few
 * seconds would be most of the page's traffic.
 */

import { html, methodNotAllowed, notFound } from '../respond.js'
import { SETTING_ROW_CSS } from '../view/settingRow.js'
import {
  DESKTOP_PAGE_CSS,
  type DesktopModel,
  desktopConfirms,
  desktopViewer,
  renderDesktop,
  renderDesktopFailure,
} from '../view/desktop.js'
import { DESKTOP_PAGE_JS } from '../view/desktopScript.js'
import { KIT_CSS } from '../view/kit.js'
import { desktopApi } from './desktopApi.js'
import { canOps, guardRead } from './directionShared.js'
import type { RouteContext, RouteModule } from './types.js'

const RECENT = 30

async function body(ctx: RouteContext): Promise<string> {
  const port = ctx.deps.desktop
  if (port === undefined) return ''
  const [units, actions] = await Promise.all([
    port.list(),
    port.actions(null, RECENT),
  ])
  if (!units.ok) return renderDesktopFailure(units.failure)
  const model: DesktopModel = {
    units: units.value,
    actions: actions.ok ? actions.value : null,
    now: ctx.now,
    ops: canOps(ctx),
  }
  return renderDesktop(model)
}

async function desktopFragment(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  if (rest.length !== 0) return notFound(`unknown path: ${ctx.url.pathname}`)
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const denied = guardRead(ctx)
  if (denied !== null) return denied
  return html(await body(ctx))
}

export const desktopRoute: RouteModule = {
  area: {
    id: 'desktop',
    label: '云端电脑',
    group: 'main',
    href: '/admin/desktop',
    icon: 'monitor',
  },
  page: {
    match: segments =>
      segments.length === 1 && segments[0] === 'desktop' ? [] : null,
    guard: 'view',
    available: ctx => ctx.deps.desktop !== undefined,
    async render(ctx) {
      if (ctx.deps.desktop === undefined) {
        return notFound(`unknown path: ${ctx.url.pathname}`)
      }
      return {
        title: '云端电脑',
        body:
          `<div class="kit-pane" id="desktop" data-poll="/fragments/desktop">` +
          (await body(ctx)) +
          `</div>` +
          desktopViewer() +
          (canOps(ctx) ? desktopConfirms() : ''),
      }
    },
    // The card's rows are laid out as setting rows (view/settingRow.ts).
    css: KIT_CSS + SETTING_ROW_CSS + DESKTOP_PAGE_CSS,
    script: DESKTOP_PAGE_JS,
  },
  api: desktopApi,
  fragments: {
    heads: ['desktop'],
    handle: (ctx, _head, rest) => desktopFragment(ctx, rest),
  },
}
