// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 文件互通 (P20): the page and `/fragments/files`.
 *
 * | Route | Who |
 * |---|---|
 * | `GET /admin/files`, `GET /fragments/files` | view and up |
 *
 * The buttons write through `/v0/files` (`routes/filesApi.ts`, member
 * level). Without a files port the area is not offered.
 */

import type { ConsoleResult } from '../contracts.js'
import type { FilesSnapshot } from '../directionPorts.js'
import { html, methodNotAllowed, notFound } from '../respond.js'
import {
  FILES_PAGE_CSS,
  filesDialogs,
  renderFiles,
  renderFilesFailure,
} from '../view/files.js'
import { FILES_PAGE_JS } from '../view/filesScript.js'
import { KIT_CSS } from '../view/kit.js'
import { canMember, guardRead } from './directionShared.js'
import { filesApi } from './filesApi.js'
import type { RouteContext, RouteModule } from './types.js'

function body(
  ctx: RouteContext,
  snapshot: ConsoleResult<FilesSnapshot>,
): string {
  if (!snapshot.ok) return renderFilesFailure(snapshot.failure)
  return renderFiles({
    snapshot: snapshot.value,
    now: ctx.now,
    member: canMember(ctx),
  })
}

async function filesFragment(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  if (rest.length !== 0) return notFound(`unknown path: ${ctx.url.pathname}`)
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const denied = guardRead(ctx)
  if (denied !== null) return denied
  const port = ctx.deps.files
  if (port === undefined) return html('')
  return html(body(ctx, await port.snapshot()))
}

export const filesRoute: RouteModule = {
  area: {
    id: 'files',
    label: '文件互通',
    group: 'manage',
    href: '/admin/files',
    icon: 'folders',
  },
  page: {
    match: segments =>
      segments.length === 1 && segments[0] === 'files' ? [] : null,
    guard: 'view',
    available: ctx => ctx.deps.files !== undefined,
    async render(ctx) {
      const port = ctx.deps.files
      if (port === undefined) {
        return notFound(`unknown path: ${ctx.url.pathname}`)
      }
      const snapshot = await port.snapshot()
      const dialogs =
        snapshot.ok && canMember(ctx) ? filesDialogs(snapshot.value) : ''
      return {
        title: '文件互通',
        body:
          `<div class="kit-pane" id="files" data-poll="/fragments/files">` +
          body(ctx, snapshot) +
          `</div>` +
          dialogs,
      }
    },
    css: KIT_CSS + FILES_PAGE_CSS,
    script: FILES_PAGE_JS,
  },
  api: filesApi,
  fragments: {
    heads: ['files'],
    handle: (ctx, _head, rest) => filesFragment(ctx, rest),
  },
}
