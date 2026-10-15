// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/v0/updates` (P31).
 *
 * | Route | Who |
 * |---|---|
 * | `GET /v0/updates` | view and up (notification channels only for ops) |
 * | `POST /v0/updates`, `POST /v0/updates/<run|upgrade|rollback>` | ops personal account |
 */

import type { UpdatesDraft, UpdatesSnapshot } from '../directionPorts.js'
import { fail, methodNotAllowed, notFound } from '../respond.js'
import {
  actorOf,
  answer,
  bodyOf,
  canOps,
  guardOpsWrite,
  guardRead,
  unwired,
  write,
} from './directionShared.js'
import type { HeadRoute, RouteContext } from './types.js'

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** Updates install software on nodes: personal ops, outside break-glass. */
function writer(ctx: RouteContext): boolean {
  return (
    ctx.access.principal?.kind === 'user' &&
    ctx.access.principal.role === 'ops' &&
    !ctx.access.breakGlass
  )
}

/** What a reader below ops level may see: no notification channels. */
export function updatesForReader(
  snapshot: UpdatesSnapshot,
  ops: boolean,
): UpdatesSnapshot {
  return ops ? snapshot : { ...snapshot, channels: [], channelChoices: [] }
}

export const updatesApi: HeadRoute = {
  heads: ['updates'],
  async handle(ctx, _head, rest) {
    const verb =
      rest.length === 1 && ['run', 'upgrade', 'rollback'].includes(rest[0]!)
        ? (rest[0] as 'run' | 'upgrade' | 'rollback')
        : null
    if (rest.length > 0 && verb === null)
      return notFound(`unknown path: ${ctx.url.pathname}`)
    const allowed = verb !== null ? ['POST'] : ['GET', 'POST']
    const read = ctx.request.method === 'GET' && verb === null
    const denied = read ? guardRead(ctx) : guardOpsWrite(ctx)
    if (denied) return denied
    if (!read && !writer(ctx))
      return fail(
        403,
        'forbidden',
        '更新设定需要运维个人账号；共用令牌与 break-glass 只能查看',
      )
    if (!allowed.includes(ctx.request.method)) return methodNotAllowed(allowed)
    const port = ctx.deps.updates
    if (!port) return unwired('更新检查')
    if (read) {
      const snapshot = await port.snapshot()
      return answer(
        snapshot.ok
          ? { ok: true, value: updatesForReader(snapshot.value, canOps(ctx)) }
          : snapshot,
      )
    }
    if (verb === 'run')
      return write(ctx, 'updates.run', 'updates', () => port.run(actorOf(ctx)))
    const body = await bodyOf(ctx)
    if (body instanceof Response) return body
    if (verb !== null) {
      const version = body['version']
      if (
        version !== undefined &&
        (typeof version !== 'string' || !VERSION.test(version))
      )
        return fail(400, 'invalid', '版本号写成 x.y.z')
      const input = typeof version === 'string' ? { version } : {}
      return verb === 'upgrade'
        ? write(ctx, 'updates.upgrade', 'updates', () =>
            port.upgrade(input, actorOf(ctx)),
          )
        : write(ctx, 'updates.rollback', 'updates', () =>
            port.rollback(input, actorOf(ctx)),
          )
    }
    return write(ctx, 'updates.save', 'updates', () =>
      port.save(body as unknown as UpdatesDraft, actorOf(ctx)),
    )
  },
}
