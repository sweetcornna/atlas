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
    const actor = actorOf(ctx)
    const authenticated = guard(access.credential, 'view', 'guarded')
    if (authenticated) return authenticated
    const verb = rest[1]
    const allowed =
      rest.length === 0
        ? head === 'schedules'
          ? ['GET', 'POST']
          : ['POST']
        : rest.length === 1
          ? head === 'schedules'
            ? ['GET', 'DELETE']
            : ['DELETE']
          : rest.length === 2 &&
              (head === 'schedules'
                ? ['enable', 'disable', 'run', 'runs'].includes(verb!)
                : verb === 'test')
            ? head === 'schedules' && verb === 'runs'
              ? ['GET']
              : ['POST']
            : head === 'schedules' && verb === 'runs' && rest.length === 3
              ? ['GET']
              : head === 'schedules' &&
                  verb === 'runs' &&
                  rest.length === 4 &&
                  rest[3] === 'resolve'
                ? ['POST']
                : null
    if (!allowed) return notFound(`unknown path: ${ctx.url.pathname}`)
    if (!allowed.includes(request.method)) return methodNotAllowed(allowed)
    // Ownership comes from the book's in-memory index, before admission or
    // business port calls. Viewers get the same hidden-resource response.
    if (head === 'schedules' && rest.length > 0 && access.principal) {
      const id = safeDecode(rest[0]!)
      if (id === null) return fail(400, 'invalid', '标识编码无效')
      if (deps.schedules && !deps.schedules.visible(id, actor))
        return fail(404, 'not_found', '定时任务不存在')
    }
    const read = head === 'schedules' && request.method === 'GET'
    if (
      head === 'schedules' &&
      rest.length === 0 &&
      request.method === 'POST' &&
      access.principal
    ) {
      let body: unknown
      try {
        body = await request.clone().json()
      } catch {}
      if (
        body &&
        typeof body === 'object' &&
        'id' in body &&
        typeof body.id === 'string' &&
        deps.schedules &&
        !deps.schedules.visible(body.id, actor)
      )
        return fail(404, 'not_found', '定时任务不存在')
    }
    const denied = read
      ? guard(access.credential, 'view', 'guarded')
      : head === 'channels'
        ? guard(access.credential, 'admin', 'guarded')
        : guardChat(access, 'guarded')
    if (denied) return denied
    const port = deps.schedules
    if (!port) return fail(501, 'unsupported', '定时任务与通知渠道未接入')
    if (read) {
      const result = await port.snapshot(actor)
      if (!result.ok) return failureResponse(result.failure)
      if (rest.length === 0) return json(result.value)
      const id = safeDecode(rest[0]!)
      const schedule = result.value.schedules.find(row => row.id === id)
      if (!schedule) return fail(404, 'not_found', '定时任务不存在')
      if (rest.length === 1) return json(schedule)
      const runs = result.value.runs.filter(row => row.scheduleId === id)
      if (rest.length === 2) return json({ runs })
      const runId = safeDecode(rest[2]!)
      const run = runs.find(row => row.runId === runId)
      return run ? json(run) : fail(404, 'not_found', '运行记录不存在')
    }
    if (rest.length === 0) {
      const body = await readJsonObject(request)
      if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
      if (
        head === 'schedules' &&
        typeof body.id === 'string' &&
        !port.visible(body.id, actor)
      )
        return fail(404, 'not_found', '定时任务不存在')
      const admitted = await ctx.admit()
      if (admitted) return admitted
      // The host validates all fields; these casts assert no validity at the boundary.
      const result =
        head === 'schedules'
          ? await port.save(body as unknown as ScheduleDraft, actor)
          : await port.saveChannel(body as unknown as NotifyChannelDraft, actor)
      return result.ok ? json(result.value) : failureResponse(result.failure)
    }
    const id = safeDecode(rest[0]!)
    if (id === null) return fail(400, 'invalid', '标识编码无效')
    const admitted = await ctx.admit()
    if (admitted) return admitted
    if (rest.length === 4) {
      const runId = safeDecode(rest[2]!)
      if (runId === null) return fail(400, 'invalid', '标识编码无效')
      const body = await readJsonObject(request)
      if (!body || (body.outcome !== 'ok' && body.outcome !== 'failed'))
        return fail(400, 'invalid', '结果必须是 ok 或 failed')
      const result = await port.resolve(id, runId, body.outcome, actor)
      return result.ok ? json(result.value) : failureResponse(result.failure)
    }
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
