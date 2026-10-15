// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 更新 (P31): scheduled checks for new versions.
 *
 * | Route | Who |
 * |---|---|
 * | `GET /admin/updates`, `GET /fragments/updates` | view and up |
 * | `GET /fragments/updates/form`, `GET /fragments/updates/rollback` | ops level |
 *
 * The JSON behind the buttons is `/v0/updates` (`routes/updatesApi.ts`).
 */

import { fail, html, methodNotAllowed, notFound } from '../respond.js'
import { KIT_CSS } from '../view/kit.js'
import {
  renderRollbackChoices,
  renderUpdates,
  renderUpdatesForm,
  UPDATES_PAGE_CSS,
  updatesDialog,
  type UpdatesModel,
} from '../view/updates.js'
import { UPDATES_PAGE_JS } from '../view/updatesScript.js'
import { canOps, guardRead } from './directionShared.js'
import { failureResponse } from './shared.js'
import type { RouteContext, RouteModule } from './types.js'
import { updatesApi, updatesForReader } from './updatesApi.js'

async function modelOf(ctx: RouteContext): Promise<UpdatesModel> {
  const port = ctx.deps.updates
  const ops = canOps(ctx)
  if (port === undefined) return { side: { kind: 'unwired' }, ops }
  const snapshot = await port.snapshot()
  return {
    side: snapshot.ok
      ? { kind: 'ok', value: updatesForReader(snapshot.value, ops) }
      : { kind: 'failed', failure: snapshot.failure },
    ops,
  }
}

async function updatesFragment(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const denied = guardRead(ctx)
  if (denied !== null) return denied
  if (rest.length === 0) return html(renderUpdates(await modelOf(ctx)))
  if (rest.length === 1 && (rest[0] === 'form' || rest[0] === 'rollback')) {
    if (!canOps(ctx)) return fail(403, 'forbidden', '更新设定需要管理权限')
    const port = ctx.deps.updates
    if (port === undefined)
      return fail(501, 'unsupported', '该控制台没有开启更新检查')
    const snapshot = await port.snapshot()
    if (!snapshot.ok) return failureResponse(snapshot.failure)
    return html(
      rest[0] === 'form'
        ? renderUpdatesForm(snapshot.value)
        : renderRollbackChoices(snapshot.value),
    )
  }
  return notFound(`unknown path: ${ctx.url.pathname}`)
}

export const updatesRoute: RouteModule = {
  area: {
    id: 'updates',
    label: '更新',
    group: 'manage',
    href: '/admin/updates',
    icon: 'refresh-cw',
  },
  page: {
    match: segments =>
      segments.length === 1 && segments[0] === 'updates' ? [] : null,
    guard: 'view',
    available: ctx => ctx.deps.updates !== undefined,
    async render(ctx) {
      if (ctx.deps.updates === undefined)
        return notFound(`unknown path: ${ctx.url.pathname}`)
      const model = await modelOf(ctx)
      return {
        title: '更新',
        body:
          `<div class="kit-pane" id="updates" data-poll="/fragments/updates">${renderUpdates(model)}</div>` +
          (model.ops ? updatesDialog() : ''),
      }
    },
    css: KIT_CSS + UPDATES_PAGE_CSS,
    script: UPDATES_PAGE_JS,
  },
  api: updatesApi,
  fragments: {
    heads: ['updates'],
    handle: (ctx, _head, rest) => updatesFragment(ctx, rest),
  },
}
