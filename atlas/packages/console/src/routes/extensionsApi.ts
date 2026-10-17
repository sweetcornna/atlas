// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/v0/extensions` (P32).
 *
 * | Route | Who |
 * |---|---|
 * | `GET /v0/extensions` | view and up (commands, addresses and skill text only for ops) |
 * | `POST /v0/extensions`, `DELETE /v0/extensions/<id>` | ops personal account |
 *
 * Secret values (MCP environment variables and request headers) never leave
 * the hub; the page only learns their names.
 */

import type { ExtensionDraft, ExtensionsSnapshot } from '../directionPorts.js'
import { fail, methodNotAllowed, notFound } from '../respond.js'
import {
  actorOf,
  answer,
  bodyOf,
  canOps,
  guardOpsWrite,
  guardRead,
  segment,
  unwired,
  write,
} from './directionShared.js'
import type { HeadRoute, RouteContext } from './types.js'

/** Extensions run code on nodes: personal ops, outside break-glass. */
function writer(ctx: RouteContext): boolean {
  return (
    ctx.access.principal?.kind === 'user' &&
    ctx.access.principal.role === 'ops' &&
    !ctx.access.breakGlass
  )
}

/** Only generated ids may enter the action ledger, never request text. */
function auditTarget(raw: string): string {
  return /^ext-[0-9a-f-]{36}$/.test(raw) ? raw : '-'
}

/** What a reader below ops level may see: what is installed, not how. */
export function extensionsForReader(
  snapshot: ExtensionsSnapshot,
  ops: boolean,
): ExtensionsSnapshot {
  if (ops) return snapshot
  return {
    ...snapshot,
    extensions: snapshot.extensions.map(extension => ({
      ...extension,
      command: null,
      args: [],
      url: null,
      envKeys: [],
      headerKeys: [],
      body: null,
    })),
  }
}

export const extensionsApi: HeadRoute = {
  heads: ['extensions'],
  async handle(ctx, _head, rest) {
    const allowed =
      rest.length === 0
        ? ['GET', 'POST']
        : rest.length === 1
          ? ['DELETE']
          : null
    if (!allowed) return notFound(`unknown path: ${ctx.url.pathname}`)
    const read = ctx.request.method === 'GET' && rest.length === 0
    const denied = read ? guardRead(ctx) : guardOpsWrite(ctx)
    if (denied) return denied
    if (!read && !writer(ctx))
      return fail(
        403,
        'forbidden',
        '扩展需要运维个人账号；共用令牌与 break-glass 只能查看',
      )
    if (!allowed.includes(ctx.request.method)) return methodNotAllowed(allowed)
    const port = ctx.deps.extensions
    if (!port) return unwired('扩展')
    if (read) {
      const snapshot = await port.snapshot()
      return answer(
        snapshot.ok
          ? {
              ok: true,
              value: extensionsForReader(snapshot.value, canOps(ctx)),
            }
          : snapshot,
      )
    }
    if (rest.length === 0) {
      const body = await bodyOf(ctx)
      if (body instanceof Response) return body
      return write(
        ctx,
        'extension.save',
        typeof body['id'] === 'string' ? auditTarget(body['id']) : 'new',
        () => port.save(body as unknown as ExtensionDraft, actorOf(ctx)),
      )
    }
    const id = segment(rest[0])
    if (id === null) return fail(400, 'invalid', '扩展标识无效')
    const response = await write(ctx, 'extension.remove', auditTarget(id), () =>
      port.remove(id, actorOf(ctx)),
    )
    return response.ok ? new Response(null, { status: 204 }) : response
  },
}
