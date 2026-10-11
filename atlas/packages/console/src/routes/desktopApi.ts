// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DesktopConfirm } from '../directionPorts.js'
import { fail, methodNotAllowed, notFound } from '../respond.js'
import {
  actorOf,
  agentRefOf,
  answer,
  bodyOf,
  guardOpsWrite,
  guardRead,
  segment,
  unwired,
} from './directionShared.js'
import type { HeadRoute } from './types.js'

/** API only. The port owns the action ledger, once per outbound operation. */
export const desktopApi: HeadRoute = {
  heads: ['desktop'],
  async handle(ctx, _head, rest) {
    const root = rest.length === 0
    const actions = rest.length === 1 && rest[0] === 'actions'
    const recycle = rest.length === 3 && rest[2] === 'recycle'
    if (!root && !actions && rest.length !== 2 && !recycle)
      return notFound(`unknown path: ${ctx.url.pathname}`)
    const read = root || actions
    const denied = read ? guardRead(ctx) : guardOpsWrite(ctx)
    if (denied) return denied
    const methods = read ? ['GET'] : recycle ? ['POST'] : ['PUT']
    if (!methods.includes(ctx.request.method)) return methodNotAllowed(methods)
    const port = ctx.deps.desktop
    if (!port) return unwired('云端电脑')
    if (root) return answer(await port.list())
    if (actions) {
      const raw = ctx.url.searchParams.get('agent')
      const ref = raw === null ? null : agentRefOf(raw)
      const limitText = ctx.url.searchParams.get('limit') ?? '50'
      const limit = Number(limitText)
      if (
        (raw !== null && ref === null) ||
        !/^\d+$/.test(limitText) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 200
      )
        return fail(400, 'invalid', 'agent 或 limit 无效（1–200）')
      return answer(await port.actions(ref, limit))
    }
    const node = segment(rest[0]),
      agent = segment(rest[1])
    const ref = agentRefOf(`qianmo://${node}/${agent}`)
    if (!ref) return fail(400, 'invalid', '节点或智能体无效')
    let change: {
      browser?: boolean
      computer?: boolean
      confirm?: DesktopConfirm
    } = {}
    if (!recycle) {
      const body = await bodyOf(ctx)
      if (body instanceof Response) return body
      if (
        Object.keys(body).length === 0 ||
        Object.keys(body).some(
          k => !['browser', 'computer', 'confirm'].includes(k),
        ) ||
        ['browser', 'computer'].some(
          k => body[k] !== undefined && typeof body[k] !== 'boolean',
        ) ||
        (body.confirm !== undefined &&
          body.confirm !== 'sensitive' &&
          body.confirm !== 'always')
      )
        return fail(
          400,
          'invalid',
          '只认 browser、computer 布尔值和 confirm（sensitive/always）',
        )
      change = body as typeof change
    }
    const busy = await ctx.admit()
    if (busy) return busy
    return answer(
      recycle
        ? await port.recycle(ref, actorOf(ctx))
        : await port.set(ref, change, actorOf(ctx)),
    )
  },
}
