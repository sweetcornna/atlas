// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/v0/handoff` — the hub's half of the local-to-cloud handoff (P17.4,
 * `handoff-p17-plan.md` §2 P17.4「中枢」表).
 *
 * Claimed by the 值守作业 area (`routes/jobs.ts`): a handoff task is a task
 * the hub holds for somebody, the same family as a watch job, and that area's
 * page package keeps this head when it replaces the placeholder. There is no
 * page and no sidebar entry for it in this batch.
 *
 * | Method | Path | Who | Answer |
 * | --- | --- | --- | --- |
 * | POST | `/v0/handoff` | member, ops, admin token | 201 `{ task, created: true }`; 200 with `created: false` when the same manifest is already accepted |
 * | GET | `/v0/handoff` | viewer and up | `{ tasks }` |
 * | GET | `/v0/handoff/<taskId>` | viewer and up | `{ task }` |
 * | POST | `/v0/handoff/<taskId>/send` | member, ops, admin token | 202 `{ send }` — kept in the ledger; delivery is P17.5 |
 *
 * "member and up" is the chat face's rule (`guardChat` in `shared.ts`) with
 * this face's own sentence: a person needs a `member` or `ops` account, and
 * of the two legacy tokens only admin. It is restated here rather than
 * borrowed so a viewer is not told about conversations on a handoff route.
 *
 * Order, as everywhere on this console: role, then path, then method, then
 * whether the port exists. Both writes go through the action ledger
 * (`admit` before, `record` after); the manifest itself is never recorded,
 * only the task id or the project name.
 *
 * What a 201 means is the port's contract (`deps.ts`, `HandoffPort`): the
 * shadow commit and the session commit are in the hub's bare repository, the
 * trees match and the ledger line is on disk. `qm handoff now` prints
 * 「已落地，可以关机」 on that answer and on nothing else.
 */

import type { Access } from '../access.js'
import { fail, json, methodNotAllowed, notFound } from '../respond.js'
import { failureResponse, guard, outcomeOf, safeDecode } from './shared.js'
import type { HeadRoute, RouteContext } from './types.js'

const MEMBER_REQUIRED =
  '转交与追加需要成员或运维账号；只读账号只能查看接力任务。'
const HANDOFF_UNWIRED =
  '这台控制台没有接接力台账：启动时给 --handoff-root 才有。'

/**
 * Biggest body read. A manifest is at most 16 KiB and a message 4 KiB
 * (`@qianmo/handoff`); four times the larger leaves room for JSON escaping
 * and refuses anything that is plainly not one of the two.
 */
const MAX_BODY_BYTES = 64 * 1024

/** `@qianmo/handoff`'s task-id shape: no dots, at most 64. */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function guardMember(access: Access): Response | null {
  const principal = access.principal
  if (principal?.kind !== 'user') {
    return guard(access.credential, 'admin', 'guarded')
  }
  const denied = guard(access.credential, 'view', 'guarded')
  if (denied !== null) return denied
  return principal.role === 'viewer'
    ? fail(403, 'forbidden', MEMBER_REQUIRED)
    : null
}

type Body =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }

async function readBody(request: Request): Promise<Body> {
  const tooLarge: Body = {
    ok: false,
    response: fail(413, 'limit', `请求体超过 ${MAX_BODY_BYTES} 字节`),
  }
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge
  let text: string
  try {
    text = await request.text()
  } catch {
    return { ok: false, response: fail(400, 'invalid', '读不出请求体') }
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return tooLarge
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: fail(400, 'invalid', '请求体必须是一个 JSON 对象'),
    }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

async function accept(ctx: RouteContext): Promise<Response> {
  const port = ctx.deps.handoff
  if (port === undefined) return fail(501, 'unsupported', HANDOFF_UNWIRED)
  const blocked = await ctx.admit()
  if (blocked !== null) return blocked
  const body = await readBody(ctx.request)
  if (!body.ok) {
    await ctx.record('handoff.accept', '-', 'refused', 'invalid')
    return body.response
  }
  const project =
    typeof body.value.project === 'string' && body.value.project.length <= 64
      ? body.value.project
      : '-'
  const result = await port.accept(body.value)
  if (!result.ok) {
    await ctx.record('handoff.accept', project, ...outcomeOf(result))
    return failureResponse(result.failure)
  }
  const { task, created } = result.value
  await ctx.record('handoff.accept', task.taskId, 'ok')
  return json({ task, created }, created ? 201 : 200)
}

async function send(ctx: RouteContext, taskId: string): Promise<Response> {
  const port = ctx.deps.handoff
  if (port === undefined) return fail(501, 'unsupported', HANDOFF_UNWIRED)
  const blocked = await ctx.admit()
  if (blocked !== null) return blocked
  const body = await readBody(ctx.request)
  if (!body.ok) {
    await ctx.record('handoff.send', taskId, 'refused', 'invalid')
    return body.response
  }
  const text = body.value.text
  if (typeof text !== 'string' || text.trim() === '') {
    await ctx.record('handoff.send', taskId, 'refused', 'invalid')
    return fail(400, 'invalid', '字段 text 必须是非空字符串')
  }
  const result = await port.send(taskId, text)
  await ctx.record('handoff.send', taskId, ...outcomeOf(result))
  if (!result.ok) return failureResponse(result.failure)
  return json({ send: result.value }, 202)
}

async function handleHandoffApi(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  const { access, deps, request, url } = ctx
  const denied = guard(access.credential, 'view', 'guarded')
  if (denied !== null) return denied

  if (rest.length === 0) {
    if (request.method === 'POST') {
      const refused = guardMember(access)
      if (refused !== null) return refused
      return await accept(ctx)
    }
    if (request.method !== 'GET') return methodNotAllowed(['GET', 'POST'])
    if (deps.handoff === undefined) {
      return fail(501, 'unsupported', HANDOFF_UNWIRED)
    }
    const listed = await deps.handoff.list()
    return listed.ok
      ? json({ tasks: listed.value })
      : failureResponse(listed.failure)
  }

  const taskId = safeDecode(rest[0] ?? '')
  const tail = rest.slice(1)
  if (
    taskId === null ||
    !TASK_ID.test(taskId) ||
    tail.length > 1 ||
    (tail.length === 1 && tail[0] !== 'send')
  ) {
    return notFound(`unknown path: ${url.pathname}`)
  }
  if (tail.length === 1) {
    if (request.method !== 'POST') return methodNotAllowed(['POST'])
    const refused = guardMember(access)
    if (refused !== null) return refused
    return await send(ctx, taskId)
  }
  if (request.method !== 'GET') return methodNotAllowed(['GET'])
  if (deps.handoff === undefined) {
    return fail(501, 'unsupported', HANDOFF_UNWIRED)
  }
  const found = await deps.handoff.get(taskId)
  return found.ok ? json({ task: found.value }) : failureResponse(found.failure)
}

/** The `handoff` head, for the area that owns it to put under `api`. */
export const handoffApi: HeadRoute = {
  heads: ['handoff'],
  handle: (ctx, _head, rest) => handleHandoffApi(ctx, rest),
}
