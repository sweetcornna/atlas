// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ConnectorDraft } from '../directionPorts.js'
import { fail, methodNotAllowed, notFound } from '../respond.js'
import {
  actorOf,
  answer,
  bodyOf,
  guardOpsWrite,
  guardRead,
  segment,
  unwired,
  write,
} from './directionShared.js'
import type { HeadRoute, RouteContext } from './types.js'

/** Credential writes follow providerWriter: personal ops, outside break-glass. */
function writer(ctx: RouteContext): boolean {
  return (
    ctx.access.principal?.kind === 'user' &&
    ctx.access.principal.role === 'ops' &&
    !ctx.access.breakGlass
  )
}
/** Only generated connection ids may enter the action ledger, never request text. */
function auditTarget(raw: string): string {
  return /^c-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    raw,
  )
    ? raw
    : '-'
}

export const connectorsApi: HeadRoute = {
  heads: ['connectors'],
  async handle(ctx, _head, rest) {
    const read = ctx.request.method === 'GET' && rest.length === 0
    const denied = read ? guardRead(ctx) : guardOpsWrite(ctx)
    if (denied) return denied
    if (!read && !writer(ctx))
      return fail(
        403,
        'forbidden',
        '应用连接需要运维个人账号；共用令牌与 break-glass 只能查看',
      )
    const allowed =
      rest.length === 0
        ? ['GET', 'POST']
        : rest.length === 1
          ? ['DELETE']
          : rest.length === 2 && rest[1] === 'probe'
            ? ['POST']
            : null
    if (!allowed) return notFound('应用连接路径不存在')
    if (!allowed.includes(ctx.request.method)) return methodNotAllowed(allowed)
    const port = ctx.deps.connectors
    if (!port) return unwired('应用连接')
    if (read) return answer(await port.snapshot())
    if (rest.length === 0) {
      const body = await bodyOf(ctx)
      if (body instanceof Response) return body
      return write(
        ctx,
        'connector.save',
        typeof body['id'] === 'string' ? auditTarget(body['id']) : 'new',
        () => port.save(body as unknown as ConnectorDraft, actorOf(ctx)),
      )
    }
    const id = segment(rest[0])
    if (id === null) return fail(400, 'invalid', '连接标识无效')
    if (ctx.request.method === 'DELETE') {
      const response = await write(
        ctx,
        'connector.remove',
        auditTarget(id),
        () => port.remove(id, actorOf(ctx)),
      )
      return response.ok ? new Response(null, { status: 204 }) : response
    }
    return write(ctx, 'connector.probe', auditTarget(id), () =>
      port.probe(id, actorOf(ctx)),
    )
  },
}
