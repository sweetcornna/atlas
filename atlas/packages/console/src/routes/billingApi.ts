// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/v0/billing` (P35): the public edition's subscriptions.
 *
 * | Route | Who |
 * |---|---|
 * | `GET /v0/billing/me`, `POST /v0/billing/checkout`, `GET /v0/billing/orders/<id>`, `POST /v0/billing/redeem` | the signed-in person, for themselves |
 * | `POST /v0/billing/models`, `DELETE /v0/billing/models/<id>` | the signed-in person, with an active subscription (the 402 gate in `http.ts` stands before them) |
 * | `GET /v0/billing/admin`, `GET /v0/billing/admin/verify` | a platform reader ({@link billingReader}) |
 * | `POST /v0/billing/admin/{grant,refund,codes}` | platform ops on a personal account ({@link billingWriter}) |
 *
 * The two payment notifications (`/v0/billing/notify/<channel>`) never reach
 * this module: `http.ts` answers them before any credential is read
 * (`billingDoors.ts`). Whose subscription a member route reads is the
 * session's subject, never a field of the request.
 */

import type { ConsoleResult } from '../contracts.js'
import { BILLING_CHANNELS, type BillingChannel } from '../directionPorts.js'
import { fail, json, methodNotAllowed, notFound } from '../respond.js'
import {
  actorOf,
  answer,
  bodyOf,
  guardOpsWrite,
  guardRead,
  segment,
  stringField,
  unwired,
} from './directionShared.js'
import { magpieWriter } from './magpieApi.js'
import { guard } from './shared.js'
import type { HeadRoute, RouteContext } from './types.js'

const DAY_MS = 86_400_000
const PLAN_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
const ORDER_ID = /^ord_[A-Za-z0-9]{22}$/
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const SUBJECT = /^u:[0-9a-f]{16}$/

/** The person a member route acts for: a personal account, or nobody. */
export function billingSubject(ctx: RouteContext): string | null {
  const principal = ctx.access.principal
  return principal?.kind === 'user' ? principal.subject : null
}

/**
 * May this caller read 订阅: every reader without tenancy; with tenancy only
 * the platform (a platform subject, or break-glass), because the page lists
 * every subscriber.
 */
export function billingReader(ctx: RouteContext): boolean {
  if (guard(ctx.access.credential, 'view', 'document') !== null) return false
  const tenancy = ctx.deps.tenancy
  if (tenancy === undefined) return true
  if (ctx.access.breakGlass) return true
  const principal = ctx.access.principal
  if (principal?.kind !== 'user') return false
  try {
    return tenancy.read().config.platformSubjects.includes(principal.subject)
  } catch {
    return false
  }
}

/** May this caller grant, refund and mint codes: the gateway writer's rule. */
export function billingWriter(ctx: RouteContext): boolean {
  return magpieWriter(ctx)
}

function isChannel(value: string | undefined): value is BillingChannel {
  return (BILLING_CHANNELS as readonly string[]).includes(value ?? '')
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

/** A member route's guard: a personal account on a guarded request. */
function guardPerson(ctx: RouteContext): Response | null {
  const denied = guard(ctx.access.credential, 'view', 'guarded')
  if (denied !== null) return denied
  return billingSubject(ctx) === null
    ? fail(403, 'forbidden', '订阅需要个人账号')
    : null
}

type Name =
  | 'me'
  | 'checkout'
  | 'order'
  | 'redeem'
  | 'models'
  | 'model'
  | 'admin'
  | 'verify'
  | 'grant'
  | 'refund'
  | 'codes'

function routeOf(
  rest: readonly string[],
): { readonly name: Name; readonly allowed: readonly string[] } | null {
  const [head, tail] = rest
  if (rest.length === 1) {
    if (head === 'me') return { name: 'me', allowed: ['GET'] }
    if (head === 'checkout') return { name: 'checkout', allowed: ['POST'] }
    if (head === 'redeem') return { name: 'redeem', allowed: ['POST'] }
    if (head === 'models') return { name: 'models', allowed: ['POST'] }
    if (head === 'admin') return { name: 'admin', allowed: ['GET'] }
    return null
  }
  if (rest.length === 2 && tail !== undefined) {
    if (head === 'orders') return { name: 'order', allowed: ['GET'] }
    if (head === 'models') return { name: 'model', allowed: ['DELETE'] }
    if (head === 'admin') {
      if (tail === 'verify') return { name: 'verify', allowed: ['GET'] }
      if (tail === 'grant') return { name: 'grant', allowed: ['POST'] }
      if (tail === 'refund') return { name: 'refund', allowed: ['POST'] }
      if (tail === 'codes') return { name: 'codes', allowed: ['POST'] }
    }
  }
  return null
}

function invalid(message: string): Response {
  return fail(400, 'invalid', message)
}

/** Ask the ledger, run, write the line with the target the run produced. */
async function written<T>(
  ctx: RouteContext,
  action: Parameters<RouteContext['record']>[0],
  run: () => Promise<ConsoleResult<T>>,
  target: (value: T | null) => string,
): Promise<Response | { readonly value: T }> {
  const busy = await ctx.admit()
  if (busy !== null) return busy
  const result = await run()
  await ctx.record(
    action,
    target(result.ok ? result.value : null),
    result.ok ? 'ok' : 'failed',
    result.ok ? undefined : result.failure.code,
  )
  return result.ok ? { value: result.value } : answer(result)
}

async function memberRoute(
  ctx: RouteContext,
  name: Name,
  rest: readonly string[],
): Promise<Response> {
  const billing = ctx.deps.billing
  if (billing === undefined) return unwired('订阅')
  const subject = billingSubject(ctx) ?? ''
  if (name === 'me') return answer(await billing.me(subject))
  if (name === 'order') {
    const id = segment(rest[1])
    if (id === null || !ORDER_ID.test(id)) return notFound('订单不存在')
    const result = await billing.order(subject, id)
    if (!result.ok) return answer(result)
    const { qrText: _qr, ...view } = result.value
    return json(view)
  }
  if (name === 'model') {
    const id = segment(rest[1])
    if (id === null || !PROVIDER_ID.test(id)) return invalid('上游 id 无效')
    const done = await written(
      ctx,
      'billing.model.remove',
      () => billing.removeUpstream(subject, id),
      () => id,
    )
    return done instanceof Response ? done : new Response(null, { status: 204 })
  }
  const body = await bodyOf(ctx)
  if (body instanceof Response) return body
  if (name === 'checkout') {
    const planId = stringField(body, 'planId') ?? ''
    const channel = stringField(body, 'channel')
    if (!PLAN_ID.test(planId)) return invalid('套餐无效')
    if (!isChannel(channel)) return invalid('付款方式只能是微信支付或支付宝')
    const done = await written(
      ctx,
      'billing.checkout',
      () => billing.checkout(subject, planId, channel),
      value => value?.orderId ?? planId,
    )
    return done instanceof Response ? done : json(done.value)
  }
  if (name === 'redeem') {
    const code = stringField(body, 'code') ?? ''
    if (code === '' || code.length > 64) return invalid('兑换码无效')
    const done = await written(
      ctx,
      'billing.redeem',
      () => billing.redeem(subject, code),
      () => 'redeem',
    )
    return done instanceof Response ? done : json(done.value)
  }
  // models: connect one of the subscriber's own upstreams.
  const preset = stringField(body, 'preset') ?? ''
  const key = stringField(body, 'key') ?? ''
  if (!PROVIDER_ID.test(preset)) return invalid('预设无效')
  if (key === '' || key.length > 4096) return invalid('上游密钥必填')
  const done = await written(
    ctx,
    'billing.model.add',
    () => billing.addUpstream(subject, { preset, key }),
    value => value?.id ?? preset,
  )
  return done instanceof Response ? done : json(done.value)
}

async function adminRoute(ctx: RouteContext, name: Name): Promise<Response> {
  const billing = ctx.deps.billing
  if (billing === undefined) return unwired('订阅')
  if (name === 'admin') return answer(await billing.admin())
  if (name === 'verify') return answer(await billing.verify())
  const body = await bodyOf(ctx)
  if (body instanceof Response) return body
  const actor = actorOf(ctx)
  if (name === 'grant') {
    const subject = stringField(body, 'subject') ?? ''
    const planId = stringField(body, 'planId') ?? ''
    const periods = integer(body['periods'])
    const reason = stringField(body, 'reason') ?? ''
    if (!SUBJECT.test(subject)) return invalid('账号要是 u: 开头的个人主体')
    if (!PLAN_ID.test(planId)) return invalid('套餐无效')
    if (periods === null || periods < 1 || periods > 120)
      return invalid('周期数要是 1 到 120 的整数')
    if (reason === '' || reason.length > 500) return invalid('原因必填')
    const done = await written(
      ctx,
      'billing.grant',
      () => billing.grant(actor, { subject, planId, periods, reason }),
      () => subject,
    )
    return done instanceof Response ? done : json(done.value)
  }
  if (name === 'refund') {
    const orderId = stringField(body, 'orderId') ?? ''
    const reason = stringField(body, 'reason') ?? ''
    if (!ORDER_ID.test(orderId)) return invalid('订单无效')
    if (reason === '' || reason.length > 500) return invalid('原因必填')
    const done = await written(
      ctx,
      'billing.refund',
      () => billing.refund(actor, { orderId, reason }),
      () => orderId,
    )
    return done instanceof Response ? done : json(done.value)
  }
  // codes
  const planId = stringField(body, 'planId') ?? ''
  const periods = integer(body['periods'])
  const count = integer(body['count'])
  const days = body['expiresInDays']
  if (!PLAN_ID.test(planId)) return invalid('套餐无效')
  if (periods === null || periods < 1 || periods > 120)
    return invalid('周期数要是 1 到 120 的整数')
  if (count === null || count < 1 || count > 1000)
    return invalid('数量要是 1 到 1000 的整数')
  let expiresAt: number | undefined
  if (days !== undefined && days !== null) {
    const span = integer(days)
    if (span === null || span < 1 || span > 3660)
      return invalid('失效天数要是 1 到 3660 的整数')
    expiresAt = ctx.now + span * DAY_MS
  }
  const done = await written(
    ctx,
    'billing.codes',
    () =>
      billing.codes(actor, {
        planId,
        periods,
        count,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      }),
    () => planId,
  )
  return done instanceof Response ? done : json(done.value)
}

const ADMIN_NAMES: ReadonlySet<Name> = new Set([
  'admin',
  'verify',
  'grant',
  'refund',
  'codes',
])

export const billingApi: HeadRoute = {
  heads: ['billing'],
  async handle(ctx, _head, rest) {
    const route = routeOf(rest)
    if (route === null) return notFound(`unknown path: ${ctx.url.pathname}`)
    const read = ctx.request.method === 'GET' && route.allowed.includes('GET')
    if (ADMIN_NAMES.has(route.name)) {
      const denied = read ? guardRead(ctx) : guardOpsWrite(ctx)
      if (denied !== null) return denied
      if (read ? !billingReader(ctx) : !billingWriter(ctx))
        return fail(
          403,
          'forbidden',
          '订阅管理需要平台运维的个人账号 · 共用令牌与 break-glass 只能查看',
        )
      if (!route.allowed.includes(ctx.request.method))
        return methodNotAllowed([...route.allowed])
      return adminRoute(ctx, route.name)
    }
    const denied = guardPerson(ctx)
    if (denied !== null) return denied
    if (!route.allowed.includes(ctx.request.method))
      return methodNotAllowed([...route.allowed])
    return memberRoute(ctx, route.name, rest)
  },
}
