// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ElevationTierName } from '../directionPorts.js'
import { fail, json, methodNotAllowed, notFound } from '../respond.js'
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
import type { HeadRoute, RouteContext } from './types.js'

const TIERS: readonly ElevationTierName[] = [
  'off',
  'accept-edits',
  'auto',
  'full-access',
]
/** P39 §4: 5 minutes to 24 hours; 1 to 2000 calls. The node checks again. */
const MIN_TTL_MS = 5 * 60_000
const MAX_TTL_MS = 24 * 60 * 60_000
const MAX_CALLS = 2000
/** P39 §5: opening or changing a tier needs a personal ops credential this fresh. */
const FRESH_MS = 30 * 60_000

interface ElevationChange {
  readonly tier: ElevationTierName
  readonly ttlMs?: number
  readonly maxCalls?: number
}

/** The body of a change, or the line naming the wrong field. */
function elevationChangeOf(
  body: Record<string, unknown>,
):
  | { readonly ok: true; readonly value: ElevationChange }
  | { readonly ok: false; readonly message: string } {
  if (Object.keys(body).some(k => !['tier', 'ttlMs', 'maxCalls'].includes(k)))
    return { ok: false, message: '只认 tier ttlMs maxCalls' }
  if (
    typeof body.tier !== 'string' ||
    !TIERS.includes(body.tier as ElevationTierName)
  )
    return { ok: false, message: 'tier 只认 off accept-edits auto full-access' }
  const tier = body.tier as ElevationTierName
  if (
    tier === 'off' &&
    (body.ttlMs !== undefined || body.maxCalls !== undefined)
  )
    return { ok: false, message: '关闭时不带 ttlMs 与 maxCalls' }
  if (
    body.ttlMs !== undefined &&
    (typeof body.ttlMs !== 'number' ||
      !Number.isSafeInteger(body.ttlMs) ||
      body.ttlMs < MIN_TTL_MS ||
      body.ttlMs > MAX_TTL_MS)
  )
    return { ok: false, message: 'ttlMs 须为 5 分钟到 24 小时（毫秒）' }
  if (
    body.maxCalls !== undefined &&
    (typeof body.maxCalls !== 'number' ||
      !Number.isSafeInteger(body.maxCalls) ||
      body.maxCalls < 1 ||
      body.maxCalls > MAX_CALLS)
  )
    return { ok: false, message: `maxCalls 须为 1 到 ${MAX_CALLS}` }
  return {
    ok: true,
    value: {
      tier,
      ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs as number }),
      ...(body.maxCalls === undefined
        ? {}
        : { maxCalls: body.maxCalls as number }),
    },
  }
}

/**
 * Who may open or change a tier (P39 §5): a personal `ops` account whose
 * credential was verified in the last 30 minutes. The legacy admin token and
 * break-glass never open one; switching off and revoking stay open to every
 * ops writer, break-glass included.
 */
function mayGrantElevation(ctx: RouteContext): string | null {
  const principal = ctx.access.principal
  if (ctx.access.breakGlass) return '应急身份不能开启高权限模式，只能关闭或收回'
  if (principal?.kind !== 'user' || principal.role !== 'ops')
    return '开启高权限模式需要个人运维账号；旧式管理令牌只能关闭或收回'
  const age = ctx.now - principal.authenticatedAt
  if (age < 0 || age >= FRESH_MS)
    return '开启高权限模式需要 30 分钟内验证过的个人凭据 · 重新登录后再开'
  return null
}

/** API only. The port owns the action ledger, once per outbound operation. */
export const elevationApi: HeadRoute = {
  heads: ['elevation'],
  async handle(ctx, _head, rest) {
    const root = rest.length === 0
    const actions = rest.length === 1 && rest[0] === 'actions'
    const revokeAll = rest.length === 1 && rest[0] === 'revoke-all'
    const revoke = rest.length === 3 && rest[2] === 'revoke'
    if (!root && !actions && !revokeAll && rest.length !== 2 && !revoke)
      return notFound(`unknown path: ${ctx.url.pathname}`)
    const read = root || actions
    const denied = read ? guardRead(ctx) : guardOpsWrite(ctx)
    if (denied) return denied
    const methods = read ? ['GET'] : revoke || revokeAll ? ['POST'] : ['PUT']
    if (!methods.includes(ctx.request.method)) return methodNotAllowed(methods)
    const port = ctx.deps.elevation
    if (!port) return unwired('高权限模式')
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
    if (revokeAll) {
      const busy = await ctx.admit()
      if (busy) return busy
      const list = await port.list()
      if (!list.ok) return answer(list)
      // Under a hub default (P39 §8.1) an agent at 人工确认 would be opened
      // again on the next pass: it is held there too, without a node call.
      const chosen = list.value.filter(
        v =>
          v.tier !== 'off' ||
          (v.defaultTier !== undefined && v.defaultHeld !== true),
      )
      const results = []
      for (const one of chosen) {
        const ref = { node: one.node, agent: one.agent }
        // Every revoke is its own operation with its own id on the node.
        const actor = { ...actorOf(ctx), requestId: crypto.randomUUID() }
        const r =
          one.tier === 'off'
            ? await port.set(ref, { tier: 'off' }, actor)
            : await port.revoke(ref, actor)
        results.push({
          address: `qianmo://${one.node}/${one.agent}`,
          ok: r.ok,
          ...(r.ok ? {} : { message: r.failure.message }),
        })
      }
      return json({ revoked: results })
    }
    const node = segment(rest[0]),
      agent = segment(rest[1])
    const ref = agentRefOf(`qianmo://${node}/${agent}`)
    if (!ref) return fail(400, 'invalid', '节点或智能体无效')
    if (revoke) {
      const busy = await ctx.admit()
      if (busy) return busy
      return answer(await port.revoke(ref, actorOf(ctx)))
    }
    const body = await bodyOf(ctx)
    if (body instanceof Response) return body
    const parsed = elevationChangeOf(body)
    if (!parsed.ok) return fail(400, 'invalid', parsed.message)
    if (parsed.value.tier !== 'off') {
      const refused = mayGrantElevation(ctx)
      if (refused !== null) return fail(403, 'forbidden', refused)
    }
    const busy = await ctx.admit()
    if (busy) return busy
    return answer(await port.set(ref, parsed.value, actorOf(ctx)))
  },
}
