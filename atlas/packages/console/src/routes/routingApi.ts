// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 任务分工 (P22): `/v0/routing`, mounted on the 模型 area.
 *
 * | Route | Who |
 * |---|---|
 * | `GET /v0/routing` | view and up |
 * | `PUT /v0/routing` | a personal ops account |
 * | `DELETE /v0/routing/nodes/<node>` | a personal ops account |
 *
 * A route makes the hub ship another service's credentials to the nodes, so
 * a write follows the 模型服务 rule ({@link routingWriter}): a personal `ops`
 * account, not a shared token and not break-glass. The routing book records its
 * own `routing.save` / `routing.clear` line in the action ledger; this route
 * therefore never calls `ctx.record`.
 */

import {
  MODEL_DIRECTIONS,
  TIER_EFFORTS,
  type ModelRouteView,
  type TierEffort,
} from '../directionPorts.js'
import { fail, methodNotAllowed, notFound } from '../respond.js'
import {
  actorOf,
  answer,
  bodyOf,
  guardOpsWrite,
  guardRead,
  segment,
  unwired,
} from './directionShared.js'
import type { HeadRoute, RouteContext } from './types.js'

const NODE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const FIELDS = ['node', 'auto', 'routes', 'revision']
const ROUTE_FIELDS = ['direction', 'profileId', 'modelId', 'effort']

/** May this caller change the split? The same test as the 模型服务 writes. */
export function routingWriter(ctx: RouteContext): boolean {
  const principal = ctx.access.principal
  return (
    principal?.kind === 'user' &&
    principal.role === 'ops' &&
    !ctx.access.breakGlass
  )
}

interface RoutingInput {
  readonly node: string | null
  readonly auto: boolean
  readonly routes: readonly ModelRouteView[]
  readonly revision: number
}

function routeOf(entry: unknown): ModelRouteView | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return null
  }
  const raw = entry as Record<string, unknown>
  if (Object.keys(raw).some(key => !ROUTE_FIELDS.includes(key))) return null
  if (!(MODEL_DIRECTIONS as readonly unknown[]).includes(raw.direction)) {
    return null
  }
  const follows = raw.profileId === null && raw.modelId === null
  const picked =
    typeof raw.profileId === 'string' &&
    raw.profileId !== '' &&
    typeof raw.modelId === 'string' &&
    raw.modelId !== ''
  if (!follows && !picked) return null
  // P38: absent is the model's default effort; following the main model
  // takes none (which model it is depends on the node).
  const effort = raw.effort ?? null
  if (
    effort !== null &&
    (follows || !(TIER_EFFORTS as readonly unknown[]).includes(effort))
  ) {
    return null
  }
  return {
    direction: raw.direction as ModelRouteView['direction'],
    profileId: raw.profileId as string | null,
    modelId: raw.modelId as string | null,
    effort: effort as TierEffort | null,
  }
}

function inputOf(raw: Record<string, unknown>): RoutingInput | Response {
  if (Object.keys(raw).some(key => !FIELDS.includes(key))) {
    return fail(400, 'invalid', '路由输入只认 node auto routes revision')
  }
  if (
    !(
      raw.node === null ||
      (typeof raw.node === 'string' && NODE.test(raw.node))
    )
  ) {
    return fail(400, 'invalid', 'node 是 null 或节点名')
  }
  if (typeof raw.auto !== 'boolean' || !Number.isSafeInteger(raw.revision)) {
    return fail(400, 'invalid', 'auto 是布尔值 · revision 是整数')
  }
  if (
    !Array.isArray(raw.routes) ||
    raw.routes.length > MODEL_DIRECTIONS.length
  ) {
    return fail(400, 'invalid', 'routes 是方向与模型引用的列表')
  }
  const routes: ModelRouteView[] = []
  for (const entry of raw.routes) {
    const route = routeOf(entry)
    if (route === null) {
      return fail(400, 'invalid', '方向、模型引用或推理强度不合法')
    }
    routes.push(route)
  }
  return {
    node: raw.node,
    auto: raw.auto,
    routes,
    revision: raw.revision as number,
  }
}

async function routingHandle(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  const root = rest.length === 0
  const node =
    rest.length === 2 && rest[0] === 'nodes' ? segment(rest[1]) : undefined
  if (!root && node === undefined) {
    return notFound(`unknown path: ${ctx.url.pathname}`)
  }
  if (node === null || (node !== undefined && !NODE.test(node))) {
    return fail(400, 'invalid', '节点名不合法')
  }
  const method = ctx.request.method
  const allowed = root ? ['GET', 'PUT'] : ['DELETE']
  if (!allowed.includes(method)) return methodNotAllowed(allowed)
  const port = ctx.deps.routing
  if (method === 'GET') {
    const denied = guardRead(ctx)
    if (denied !== null) return denied
    if (port === undefined) return unwired('任务分工')
    return answer(await port.snapshot())
  }
  const denied = guardOpsWrite(ctx)
  if (denied !== null) return denied
  if (!routingWriter(ctx)) {
    return fail(
      403,
      'forbidden',
      '任务分工的写操作需要运维角色的个人账号 · 共用令牌与 break-glass 只能查看',
    )
  }
  if (port === undefined) return unwired('任务分工')
  let input: RoutingInput | null = null
  if (method === 'PUT') {
    const body = await bodyOf(ctx)
    if (body instanceof Response) return body
    const parsed = inputOf(body)
    if (parsed instanceof Response) return parsed
    input = parsed
  }
  const busy = await ctx.admit()
  if (busy !== null) return busy
  const actor = actorOf(ctx)
  return answer(
    input === null
      ? await port.clearNode(node ?? '', actor)
      : await port.save(input, actor),
  )
}

/** API only; the 模型 area claims this head beside its own. */
export const routingApi: HeadRoute = {
  heads: ['routing'],
  handle: (ctx, _head, rest) => routingHandle(ctx, rest),
}
