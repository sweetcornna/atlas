// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 后台任务 (P29) over HTTP: `GET /v0/tasks` lists the tasks the caller may
 * see — their own, or every one for ops — and `POST /v0/tasks/<id>/cancel`
 * cancels one the way the conversation does. The 主动执行 area attaches the
 * head and draws the list (`routes/jobs.ts`, `view/tasks.ts`).
 *
 * Who may cancel is decided before admission from the port's in-memory book:
 * a task the caller cannot see answers the same 404 as one that is not
 * there, so the route says nothing about other people's tasks.
 */

import type { BackgroundTaskReader, DirectionActor } from '../directionPorts.js'
import { fail, json, methodNotAllowed, notFound } from '../respond.js'
import {
  failureResponse,
  guard,
  guardChat,
  outcomeOf,
  safeDecode,
} from './shared.js'
import type { RouteContext } from './types.js'

const TASKS_UNSUPPORTED = '后台任务未接入'
const TASK_GONE = '后台任务不存在'

/** Who is asking, as the port's ownership rule reads it. */
export function taskActorOf(ctx: RouteContext): DirectionActor {
  const principal = ctx.access.principal
  return {
    subject:
      principal?.subject ??
      (ctx.access.credential.role === 'admin' ? 'legacy:admin' : 'legacy:view'),
    role: principal?.kind === 'user' ? principal.role : null,
    requestId: ctx.requestId,
  }
}

export async function handleTasks(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  const list = rest.length === 0
  const cancel = rest.length === 2 && rest[1] === 'cancel'
  if (!list && !cancel) return notFound(`unknown path: ${ctx.url.pathname}`)
  const allowed = list ? ['GET'] : ['POST']
  if (!allowed.includes(ctx.request.method)) return methodNotAllowed(allowed)
  const authenticated = guard(ctx.access.credential, 'view', 'guarded')
  if (authenticated) return authenticated
  const actor = taskActorOf(ctx)
  const port = ctx.deps.tasks
  if (list) {
    if (port === undefined) return fail(501, 'unsupported', TASKS_UNSUPPORTED)
    const reader: BackgroundTaskReader = actor
    return json({ tasks: port.list(reader) })
  }
  const id = safeDecode(rest[0]!)
  if (id === null) return fail(400, 'invalid', '标识编码无效')
  const denied = guardChat(ctx.access, 'guarded')
  if (denied) return denied
  if (port === undefined) return fail(501, 'unsupported', TASKS_UNSUPPORTED)
  if (!port.visible(id, actor)) return fail(404, 'not_found', TASK_GONE)
  const admitted = await ctx.admit()
  if (admitted) return admitted
  const result = await port.cancel(id, actor)
  await ctx.record('task.cancel', id, ...outcomeOf(result))
  return result.ok ? json(result.value) : failureResponse(result.failure)
}
