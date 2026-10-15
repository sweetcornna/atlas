// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 扩展 (P32): MCP connectors, skills and plugins for agents.
 *
 * | Route | Who |
 * |---|---|
 * | `GET /admin/extensions`, `GET /fragments/extensions` | view and up |
 * | `GET /fragments/extensions/form?kind=&id=` | ops level |
 *
 * The JSON behind the buttons is `/v0/extensions` (`routes/extensionsApi.ts`).
 */

import { EXTENSION_KINDS, type ExtensionKind } from '../directionPorts.js'
import { fail, html, methodNotAllowed, notFound } from '../respond.js'
import {
  EXTENSIONS_PAGE_CSS,
  extensionDialogs,
  type ExtensionsModel,
  renderExtensionForm,
  renderExtensions,
} from '../view/extensions.js'
import { EXTENSIONS_PAGE_JS } from '../view/extensionsScript.js'
import { KIT_CSS } from '../view/kit.js'
import { canOps, guardRead } from './directionShared.js'
import { extensionsApi, extensionsForReader } from './extensionsApi.js'
import { failureResponse } from './shared.js'
import type { RouteContext, RouteModule } from './types.js'

async function modelOf(ctx: RouteContext): Promise<ExtensionsModel> {
  const port = ctx.deps.extensions
  const ops = canOps(ctx)
  if (port === undefined) return { side: { kind: 'unwired' }, ops }
  const snapshot = await port.snapshot()
  return {
    side: snapshot.ok
      ? { kind: 'ok', value: extensionsForReader(snapshot.value, ops) }
      : { kind: 'failed', failure: snapshot.failure },
    ops,
  }
}

async function formFragment(ctx: RouteContext): Promise<Response> {
  if (!canOps(ctx)) return fail(403, 'forbidden', '添加和修改扩展需要管理权限')
  const port = ctx.deps.extensions
  if (port === undefined)
    return fail(501, 'unsupported', '该控制台没有开启扩展')
  const snapshot = await port.snapshot()
  if (!snapshot.ok) return failureResponse(snapshot.failure)
  const id = ctx.url.searchParams.get('id')
  const extension =
    id === null
      ? null
      : (snapshot.value.extensions.find(one => one.id === id) ?? null)
  if (id !== null && extension === null) return notFound('没有这个扩展')
  const asked = extension?.kind ?? ctx.url.searchParams.get('kind') ?? 'mcp'
  if (!(EXTENSION_KINDS as readonly string[]).includes(asked))
    return fail(400, 'invalid', '扩展种类无效')
  return html(
    renderExtensionForm({
      kind: asked as ExtensionKind,
      extension,
      agentChoices: snapshot.value.agentChoices,
    }),
  )
}

async function extensionsFragment(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const denied = guardRead(ctx)
  if (denied !== null) return denied
  if (rest.length === 0) return html(renderExtensions(await modelOf(ctx)))
  if (rest.length === 1 && rest[0] === 'form') return formFragment(ctx)
  return notFound(`unknown path: ${ctx.url.pathname}`)
}

export const extensionsRoute: RouteModule = {
  area: {
    id: 'extensions',
    label: '扩展',
    group: 'main',
    href: '/admin/extensions',
    icon: 'puzzle',
  },
  page: {
    match: segments =>
      segments.length === 1 && segments[0] === 'extensions' ? [] : null,
    guard: 'view',
    available: ctx => ctx.deps.extensions !== undefined,
    async render(ctx) {
      if (ctx.deps.extensions === undefined)
        return notFound(`unknown path: ${ctx.url.pathname}`)
      const model = await modelOf(ctx)
      return {
        title: '扩展',
        body:
          `<div class="kit-pane" id="extensions" data-poll="/fragments/extensions">${renderExtensions(model)}</div>` +
          (model.ops ? extensionDialogs() : ''),
      }
    },
    css: KIT_CSS + EXTENSIONS_PAGE_CSS,
    script: EXTENSIONS_PAGE_JS,
  },
  api: extensionsApi,
  fragments: {
    heads: ['extensions'],
    handle: (ctx, _head, rest) => extensionsFragment(ctx, rest),
  },
}
