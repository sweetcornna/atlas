// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  MODEL_DIRECTIONS,
  type ModelRouteView,
  type DirectionActor,
} from '../directionPorts.js'
import { fail, json } from '../respond.js'
import { failureResponse, guard } from './shared.js'
import type { HeadRoute, RouteContext } from './types.js'

function actor(ctx: RouteContext): DirectionActor {
  const p = ctx.access.principal
  return {
    subject: p?.subject ?? 'anonymous',
    role: p?.kind === 'user' ? p.role : null,
    requestId: ctx.requestId,
  }
}
/** API only. The providers area can add this head without a second page module. */
export const routingApi: HeadRoute = {
  heads: ['routing'],
  async handle(ctx, _head, rest) {
    const denied = guard(ctx.access.credential, 'view', 'guarded')
    if (denied) return denied
    const root = rest.length === 0
    const node = rest.length === 2 && rest[0] === 'nodes' ? rest[1] : undefined
    if (!root && node === undefined)
      return fail(404, 'not_found', '没有这个路由')
    const method = ctx.request.method
    if (
      (root && method !== 'GET' && method !== 'PUT') ||
      (node !== undefined && method !== 'DELETE')
    )
      return fail(405, 'method_not_allowed', '方法不允许')
    if (method !== 'GET') {
      const denied = guard(ctx.access.credential, 'admin', 'guarded')
      if (denied) return denied
      const who = actor(ctx)
      if (who.role !== 'ops' && who.subject !== 'legacy:admin')
        return fail(403, 'forbidden', '需要 ops 或管理令牌')
    }
    const port = ctx.deps.routing
    if (!port) return fail(501, 'unsupported', '任务分工未接入')
    if (method === 'GET') {
      const result = await port.snapshot()
      return result.ok ? json(result.value) : failureResponse(result.failure)
    }
    let input:
      | {
          node: string | null
          auto: boolean
          routes: ModelRouteView[]
          revision: number
        }
      | undefined
    if (method === 'PUT') {
      let body: unknown
      try {
        body = await ctx.request.json()
      } catch {
        return fail(400, 'invalid', '必须是 JSON 对象')
      }
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return fail(400, 'invalid', '必须是 JSON 对象')
      const raw = body as Record<string, unknown>
      if (
        Object.keys(raw).some(
          k => !['node', 'auto', 'routes', 'revision'].includes(k),
        ) ||
        !(
          raw.node === null ||
          (typeof raw.node === 'string' && /^[a-z0-9-]{1,32}$/.test(raw.node))
        ) ||
        typeof raw.auto !== 'boolean' ||
        !Number.isSafeInteger(raw.revision) ||
        !Array.isArray(raw.routes)
      )
        return fail(400, 'invalid', '路由输入不合法')
      const routes: ModelRouteView[] = []
      for (const entry of raw.routes) {
        if (
          !entry ||
          typeof entry !== 'object' ||
          Array.isArray(entry) ||
          Object.keys(entry).some(
            k => !['direction', 'profileId', 'modelId'].includes(k),
          ) ||
          !MODEL_DIRECTIONS.includes(entry.direction) ||
          !(
            (entry.profileId === null && entry.modelId === null) ||
            (typeof entry.profileId === 'string' &&
              typeof entry.modelId === 'string')
          )
        )
          return fail(400, 'invalid', '方向或模型引用不合法')
        routes.push(entry as ModelRouteView)
      }
      input = {
        node: raw.node,
        auto: raw.auto,
        routes,
        revision: raw.revision as number,
      }
    }
    const closed = await ctx.admit()
    if (closed) return closed
    const result = input
      ? await port.save(input, actor(ctx))
      : await port.clearNode(node!, actor(ctx))
    return result.ok ? json(result.value) : failureResponse(result.failure)
  },
}
