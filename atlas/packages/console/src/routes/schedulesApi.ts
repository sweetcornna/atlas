// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/v0/schedules` and `/v0/channels` — the JSON half of 主动执行 (P24).
 *
 * | Route | Who |
 * |---|---|
 * | `GET /v0/schedules` | view and up |
 * | `POST /v0/schedules` (create or update) | member and up |
 * | `POST /v0/schedules/<id>/enable\|disable\|run` | member and up |
 * | `DELETE /v0/schedules/<id>` | member and up |
 * | `POST /v0/channels`, `DELETE /v0/channels/<id>`, `POST /v0/channels/<id>/test` | ops |
 *
 * The body is validated by the port: this layer parses JSON, checks the
 * role, asks the ledger, calls the port and records the line.
 */

import type { NotifyChannelDraft, ScheduleDraft } from '../directionPorts.js'
import { methodNotAllowed, notFound } from '../respond.js'
import {
  actorOf,
  answer,
  bodyOf,
  guardMemberWrite,
  guardOpsWrite,
  guardRead,
  segment,
  unwired,
  write,
} from './directionShared.js'
import type { HeadRoute, RouteContext } from './types.js'

const UNWIRED = '定时任务'

async function schedules(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  const port = ctx.deps.schedules
  const method = ctx.request.method
  if (rest.length === 0) {
    if (method === 'GET') {
      const denied = guardRead(ctx)
      if (denied !== null) return denied
      if (port === undefined) return unwired(UNWIRED)
      return answer(await port.snapshot())
    }
    if (method !== 'POST') return methodNotAllowed(['GET', 'POST'])
    const denied = guardMemberWrite(ctx)
    if (denied !== null) return denied
    if (port === undefined) return unwired(UNWIRED)
    const body = await bodyOf(ctx)
    if (body instanceof Response) return body
    const draft = body as unknown as ScheduleDraft
    const target = typeof body.id === 'string' ? body.id : 'new'
    return await write(ctx, 'schedule.save', target, () =>
      port.save(draft, actorOf(ctx)),
    )
  }
  const id = segment(rest[0])
  if (id === null || rest.length > 2) {
    return notFound(`unknown path: ${ctx.url.pathname}`)
  }
  const verb = rest[1]
  if (verb === undefined) {
    if (method !== 'DELETE') return methodNotAllowed(['DELETE'])
    const denied = guardMemberWrite(ctx)
    if (denied !== null) return denied
    if (port === undefined) return unwired(UNWIRED)
    return await write(ctx, 'schedule.remove', id, () =>
      port.remove(id, actorOf(ctx)),
    )
  }
  if (verb !== 'enable' && verb !== 'disable' && verb !== 'run') {
    return notFound(`unknown path: ${ctx.url.pathname}`)
  }
  if (method !== 'POST') return methodNotAllowed(['POST'])
  const denied = guardMemberWrite(ctx)
  if (denied !== null) return denied
  if (port === undefined) return unwired(UNWIRED)
  if (verb === 'run') {
    return await write(ctx, 'schedule.run', id, () =>
      port.runNow(id, actorOf(ctx)),
    )
  }
  return await write(
    ctx,
    verb === 'enable' ? 'schedule.enable' : 'schedule.disable',
    id,
    () => port.setEnabled(id, verb === 'enable', actorOf(ctx)),
  )
}

async function channels(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  const port = ctx.deps.schedules
  const method = ctx.request.method
  if (rest.length === 0) {
    if (method !== 'POST') return methodNotAllowed(['POST'])
    const denied = guardOpsWrite(ctx)
    if (denied !== null) return denied
    if (port === undefined) return unwired(UNWIRED)
    const body = await bodyOf(ctx)
    if (body instanceof Response) return body
    const draft = body as unknown as NotifyChannelDraft
    const target = typeof body.id === 'string' ? body.id : 'new'
    return await write(ctx, 'channel.save', target, () =>
      port.saveChannel(draft, actorOf(ctx)),
    )
  }
  const id = segment(rest[0])
  if (id === null || rest.length > 2) {
    return notFound(`unknown path: ${ctx.url.pathname}`)
  }
  const verb = rest[1]
  if (verb === undefined) {
    if (method !== 'DELETE') return methodNotAllowed(['DELETE'])
    const denied = guardOpsWrite(ctx)
    if (denied !== null) return denied
    if (port === undefined) return unwired(UNWIRED)
    return await write(ctx, 'channel.remove', id, () =>
      port.removeChannel(id, actorOf(ctx)),
    )
  }
  if (verb !== 'test') return notFound(`unknown path: ${ctx.url.pathname}`)
  if (method !== 'POST') return methodNotAllowed(['POST'])
  const denied = guardOpsWrite(ctx)
  if (denied !== null) return denied
  if (port === undefined) return unwired(UNWIRED)
  return await write(ctx, 'channel.test', id, () =>
    port.testChannel(id, actorOf(ctx)),
  )
}

export const schedulesApi: HeadRoute = {
  heads: ['schedules', 'channels'],
  async handle(ctx, head, rest) {
    return head === 'schedules'
      ? await schedules(ctx, rest)
      : await channels(ctx, rest)
  },
}
