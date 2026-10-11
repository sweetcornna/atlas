// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  DirectionActor,
  NotifyChannelDraft,
  ScheduleDraft,
} from '../directionPorts.js'
import {
  fail,
  json,
  methodNotAllowed,
  notFound,
  readJsonObject,
} from '../respond.js'
import { failureResponse, guard, guardChat, safeDecode } from './shared.js'
import type { HeadRoute, RouteContext } from './types.js'

function actorOf(ctx: RouteContext): DirectionActor {
  const principal = ctx.access.principal
  return {
    subject:
      principal?.subject ??
      (ctx.access.credential.role === 'admin' ? 'legacy:admin' : 'legacy:view'),
    role: principal?.kind === 'user' ? principal.role : null,
    requestId: ctx.requestId,
  }
}

/** API only. The 主动执行 area owns attaching this head route to its module. */
export const schedulesApi: HeadRoute = {
  heads: ['schedules', 'channels'],
  async handle(ctx, head, rest) {
    const { request, deps, access } = ctx
    const read =
      head === 'schedules' && rest.length === 0 && request.method === 'GET'
    const denied = read
      ? guard(access.credential, 'view', 'guarded')
      : head === 'channels'
        ? guard(access.credential, 'admin', 'guarded')
        : guardChat(access, 'guarded')
    if (denied) return denied
    const verb = rest[1]
    const allowed =
      rest.length === 0
        ? head === 'schedules'
          ? ['GET', 'POST']
          : ['POST']
        : rest.length === 1
          ? ['DELETE']
          : rest.length === 2 &&
              (head === 'schedules'
                ? ['enable', 'disable', 'run'].includes(verb!)
                : verb === 'test')
            ? ['POST']
            : null
    if (!allowed) return notFound(`unknown path: ${ctx.url.pathname}`)
    if (!allowed.includes(request.method)) return methodNotAllowed(allowed)
    const port = deps.schedules
    if (!port) return fail(501, 'unsupported', '定时任务与通知渠道未接入')
    if (read) {
      const result = await port.snapshot()
      return result.ok ? json(result.value) : failureResponse(result.failure)
    }
    const admitted = await ctx.admit()
    if (admitted) return admitted
    const actor = actorOf(ctx)
    if (rest.length === 0) {
      const body = await readJsonObject(request)
      if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
      // The host validates all fields; these casts assert no validity at the boundary.
      const result =
        head === 'schedules'
          ? await port.save(body as unknown as ScheduleDraft, actor)
          : await port.saveChannel(body as unknown as NotifyChannelDraft, actor)
      return result.ok ? json(result.value) : failureResponse(result.failure)
    }
    const id = safeDecode(rest[0]!)
    if (id === null) return fail(400, 'invalid', '标识编码无效')
    if (request.method === 'DELETE') {
      const result =
        head === 'schedules'
          ? await port.remove(id, actor)
          : await port.removeChannel(id, actor)
      return result.ok
        ? new Response(null, { status: 204 })
        : failureResponse(result.failure)
    }
    const result =
      head === 'channels'
        ? await port.testChannel(id, actor)
        : verb === 'run'
          ? await port.runNow(id, actor)
          : await port.setEnabled(id, verb === 'enable', actor)
    return result.ok ? json(result.value) : failureResponse(result.failure)
  },
}
