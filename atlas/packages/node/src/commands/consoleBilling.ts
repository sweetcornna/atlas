// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 公开版的计费端口（P35，`--billing`）：`@qianmo/console` 的 `BillingPort` 的
 * 生产实现。订单、订阅与账本是 `@qianmo/billing` 的 `BillingService`；这里把它
 * 接到中枢的租户配置、平台网关 magpie 与模型服务上。
 *
 * ## 开通（`GatewayProvisioner`）
 *
 * 付款、兑换或运维开通之后 `ensure(subject, plan)`：
 *
 * 1. 这个人还没有租户就建一个 `t-<主体前 8 位>`，并把他映射进去——经租户配置的
 *    `replace`（读与写之间没有 `await`），记一条 `billing.tenant`，主体是
 *    `system:billing`。已经映射过的照旧用原来的租户。
 * 2. magpie 给这个租户一把订阅密钥（`ConsoleMagpie.ensureTenant`）：停用、白名单
 *    只有 `NO_MODEL_PATTERN`、套餐的合理使用上限；档案 `magpie-tenant-<租户>`。
 * 3. `setEnabled(true)` 记下「已付费」；密钥要等订阅者接了自己的上游才真正启用。
 *    到期、退款后 `setEnabled(false)` 立刻停用；从没开通过的人是空操作。
 *
 * 平台运维把节点分给租户（租户配置里的 `nodes`）之后，本端口把档案指派给这个
 * 租户的节点并下发：租户配置一变就做一次，另外每 60 秒随到期扫描再做一次；最多
 * 指派套餐含的节点数（`allowance`），多出来的节点不下发。
 *
 * ## 账本与错误
 *
 * `BillingError` 的原文带全角逗号，不进页面：这里换成一句干净的话。中枢自己的
 * 写（建租户、存档案、指派、下发）都记进动作账本，主体 `system:billing`。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  type BillingConfig,
  BillingError,
  BillingService,
  type BillingStore,
  createPaymentChannels,
  type GatewayProvisioner,
  type OrderView,
  type PaymentChannel,
  type PaymentChannelId,
  type PlanLimit,
  type PlanProvision,
  parseBillingConfig,
} from '@qianmo/billing'
import type {
  BillingAdminView,
  BillingChainView,
  BillingChannel,
  BillingCheckoutView,
  BillingMeView,
  BillingNotifyReply,
  BillingNotifyRequest,
  BillingOrderStatus,
  BillingOrderView,
  BillingPort,
  BillingPresetView,
  BillingSiteView,
  BillingStanding,
  BillingUpstreamView,
  ConsoleFailure,
  ConsoleResult,
  DirectionActor,
  ProviderCaller,
  ProviderPort,
  TenantConfig,
  TenantPort,
} from '@qianmo/console'
import type { MagpieLimit } from '@qianmo/magpie'
import type { ConsoleMagpie } from './consoleMagpie.js'

const SWEEP_EVERY_MS = 60_000

/**
 * Read and check the billing config, secrets and all; throws a line that
 * names the file and what is wrong with it (never a secret).
 */
export function loadBillingConfig(path: string): BillingConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as { code?: unknown }).code
    throw new Error(
      `billing config ${path} cannot be read (${typeof code === 'string' ? code : 'error'})`,
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`billing config ${path} is not JSON`)
  }
  try {
    return parseBillingConfig(raw)
  } catch (error) {
    throw new Error(
      `billing config ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** One ledger line written as `system:billing`. */
export type SystemRecord = (
  action: string,
  target: string,
  outcome: 'ok' | 'refused' | 'failed',
  code?: string,
) => Promise<boolean>

/** The tenant store as this port needs it: read, replace, hear changes. */
export interface BillingTenantStore extends TenantPort {
  replace(input: unknown): TenantConfig
}

export interface ConsoleBillingOptions {
  readonly config: BillingConfig
  readonly store: BillingStore
  /** Default: the channels the config enables (`createPaymentChannels`). */
  readonly channels?: Partial<Record<PaymentChannelId, PaymentChannel>>
  readonly tenancy: BillingTenantStore
  readonly magpie: ConsoleMagpie
  /** The model service with the public edition's rules (`consolePublicProviders.ts`). */
  readonly providers: ProviderPort
  /** The hub's own caller (`ConsoleProviders.systemCaller`). */
  readonly caller: ProviderCaller
  /** Writes one of the hub's own lines to the ledger ({@link systemRecorder}). */
  readonly record: SystemRecord
  /** Clock for the service and the sweep; tests move it. */
  readonly now?: () => number
  readonly sweepEveryMs?: number
  readonly notifyBudgetMs?: number
  readonly onError?: (line: string) => void
}

type Result<T> = ConsoleResult<T>

function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

function failed<T>(code: ConsoleFailure['code'], message: string): Result<T> {
  return { ok: false, failure: { code, message } }
}

/** What a provisioning failure is recorded as: a name, never a message. */
class ProvisionError extends Error {
  constructor(code: string) {
    super(code)
    this.name = `provision_${code}`
  }
}

/** A refusal of the billing service as a clean line for the page. */
function fromBilling<T>(error: unknown): Result<T> {
  if (!(error instanceof BillingError)) {
    const name = error instanceof Error ? error.name : 'Error'
    return failed('unreachable', `计费出错 · ${name}`)
  }
  switch (error.code) {
    case 'unknown_plan':
      return failed('not_found', '套餐不存在')
    case 'unknown_order':
      return failed('not_found', '订单不存在')
    case 'channel_unavailable':
      return failed('invalid', '这个付款方式没有开通')
    case 'plan_conflict':
      return failed('rejected', '已有别的套餐在有效期内 · 到期后再换')
    case 'provider_error':
      return failed('unreachable', '支付平台暂时不可用 · 稍后再试')
    case 'invalid_code':
      return failed('invalid', '兑换码无效或已用过')
    case 'not_paid':
      return failed('invalid', '只有已支付的订单才能登记退款')
    default:
      return failed('invalid', '请求无效')
  }
}

function limitOf(limit: PlanLimit): MagpieLimit {
  return {
    period: limit.period,
    ...(limit.days === undefined ? {} : { days: limit.days }),
    ...(limit.hours === undefined ? {} : { hours: limit.hours }),
    ...(limit.tokens === undefined ? {} : { tokens: limit.tokens }),
    ...(limit.costUsd === undefined ? {} : { cost: limit.costUsd }),
    ...(limit.cacheReads === true ? { cacheReads: true } : {}),
  }
}

function orderView(order: OrderView): BillingOrderView {
  return {
    orderId: order.orderId,
    planId: order.planId,
    channel: order.channel,
    amountCents: order.amountCents,
    status: order.status as BillingOrderStatus,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    paidAt: order.paidAt,
  }
}

function isChannel(value: string): value is BillingChannel {
  return value === 'wechatpay' || value === 'alipay'
}

export class ConsoleBilling implements BillingPort, GatewayProvisioner {
  readonly service: BillingService
  readonly #options: ConsoleBillingOptions
  readonly #channels: Partial<Record<PaymentChannelId, PaymentChannel>>
  readonly #dirty = new Set<string>()
  #nodes: Promise<void> = Promise.resolve()
  #timer: ReturnType<typeof setInterval> | null = null
  #unsubscribe: (() => void) | null = null

  constructor(options: ConsoleBillingOptions) {
    this.#options = options
    this.#channels = options.channels ?? createPaymentChannels(options.config)
    this.service = new BillingService({
      config: options.config,
      store: options.store,
      channels: this.#channels,
      provisioner: this,
      ...(options.now === undefined ? {} : { clock: options.now }),
      ...(options.notifyBudgetMs === undefined
        ? {}
        : { notifyBudgetMs: options.notifyBudgetMs }),
      log: line => options.onError?.(line),
    })
  }

  /** The 60-second sweep and the tenancy watch, after the console is up. */
  start(): void {
    if (this.#timer !== null) return
    this.#timer = setInterval(() => {
      void this.tick()
    }, this.#options.sweepEveryMs ?? SWEEP_EVERY_MS)
    this.#timer.unref?.()
    this.#unsubscribe = this.#options.tenancy.subscribe(() => {
      void this.syncNodes()
    })
  }

  close(): void {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
    this.#unsubscribe?.()
    this.#unsubscribe = null
  }

  /** One sweep: ended subscriptions off, owed provisioning retried, nodes in step. */
  async tick(): Promise<void> {
    try {
      await this.service.sweep()
    } catch (error) {
      this.#options.onError?.(`billing: 扫描失败 · ${String(error)}`)
    }
    await this.syncNodes()
  }

  /** A tenant's profile changed (`ConsoleMagpie` `onProfile`): its nodes get it. */
  profileChanged(tenant: string): void {
    this.#dirty.add(tenant)
    void this.syncNodes()
  }

  // --- tenants -------------------------------------------------------------

  #tenantOf(subject: string): string | null {
    return (
      this.#options.tenancy
        .read()
        .config.subjects.find(row => row.subject === subject)?.tenant ?? null
    )
  }

  /** The subscriber's tenant, made and mapped when there is none (module note). */
  async #ensureTenant(subject: string): Promise<string> {
    const config = this.#options.tenancy.read().config
    const mapped = config.subjects.find(row => row.subject === subject)
    if (mapped !== undefined) return mapped.tenant
    const taken = new Set(config.tenants.map(row => row.id))
    const short = `t-${subject.slice(2, 10)}`
    const tenant = taken.has(short) ? `t-${subject.slice(2)}` : short
    if (taken.has(tenant)) throw new ProvisionError('tenant_taken')
    // Read and replace with nothing awaited between them.
    this.#options.tenancy.replace({
      ...config,
      tenants: [...config.tenants, { id: tenant }],
      subjects: [...config.subjects, { subject, tenant }],
    })
    await this.#options.record('billing.tenant', tenant, 'ok')
    return tenant
  }

  /** Nodes a tenant's plan includes: its subscribers' active plan, else 0. */
  allowance(tenant: string): number {
    let config: TenantConfig
    try {
      config = this.#options.tenancy.read().config
    } catch {
      return 0
    }
    let best = 0
    for (const row of config.subjects) {
      if (row.tenant !== tenant) continue
      const entitlement = this.service.entitlement(row.subject)
      if (!entitlement.active) continue
      const plan = this.#options.config.plans.find(
        one => one.id === entitlement.planId,
      )
      best = Math.max(best, plan?.nodes ?? 0)
    }
    return best
  }

  // --- GatewayProvisioner --------------------------------------------------

  async ensure(
    subject: string,
    plan: PlanProvision,
  ): Promise<{ binding: string }> {
    const tenant = await this.#ensureTenant(subject)
    const ensured = await this.#options.magpie.ensureTenant(
      tenant,
      plan.gatewayLimits.map(limitOf),
    )
    if (!ensured.ok) throw new ProvisionError(ensured.failure.code)
    return ensured.value
  }

  async setEnabled(subject: string, enabled: boolean): Promise<void> {
    const mapped = this.#tenantOf(subject)
    // Off also reaches a tenant whose mapping was edited away.
    const tenants =
      mapped !== null
        ? [mapped]
        : enabled
          ? []
          : [`t-${subject.slice(2, 10)}`, `t-${subject.slice(2)}`]
    for (const tenant of tenants) {
      const result = await this.#options.magpie.setTenantEntitled(
        tenant,
        enabled,
      )
      if (!result.ok) throw new ProvisionError(result.failure.code)
    }
    if (enabled && mapped !== null) {
      this.#dirty.add(mapped)
      void this.syncNodes()
    }
  }

  // --- nodes -----------------------------------------------------------------

  /** Give each paid tenant's nodes its profile, up to the plan, and deliver. */
  syncNodes(): Promise<void> {
    const next = this.#nodes.then(() => this.#syncNodes())
    this.#nodes = next.catch(error => {
      this.#options.onError?.(`billing: 节点指派失败 · ${String(error)}`)
    })
    return this.#nodes
  }

  async #syncNodes(): Promise<void> {
    const { providers, caller, magpie } = this.#options
    const config = this.#options.tenancy.read().config
    const overview = await providers.overview()
    if (!overview.ok) return
    const reachable = new Map(
      overview.value.nodes.map(row => [row.node, row.assignment] as const),
    )
    for (const { id: tenant } of config.tenants) {
      const profileId = magpie.tenantProfileId(tenant)
      if (profileId === null) continue
      const allowed = this.allowance(tenant)
      const nodes = config.nodes
        .filter(row => row.tenant === tenant)
        .map(row => row.nodeId)
        .filter(node => reachable.has(node))
      const onIt = nodes.filter(node => {
        const assignment = reachable.get(node)
        return (
          assignment?.mode === 'profile' && assignment.profileId === profileId
        )
      })
      const deliver = this.#dirty.has(tenant) ? [...onIt] : []
      this.#dirty.delete(tenant)
      let room = allowed - onIt.length
      for (const node of nodes) {
        if (room <= 0) break
        if (onIt.includes(node)) continue
        const assigned = await providers.assign(
          { node, assignment: { mode: 'profile', profileId } },
          caller,
        )
        if (!assigned.ok) {
          this.#options.onError?.(
            `billing: ${node} 没能指派 ${profileId} · ${assigned.failure.message}`,
          )
          continue
        }
        deliver.push(node)
        room -= 1
      }
      if (deliver.length === 0) continue
      const applied = await providers.apply({ nodes: deliver }, caller)
      if (!applied.ok)
        this.#options.onError?.(
          `billing: 下发到 ${deliver.join(' ')} 失败 · ${applied.failure.message}`,
        )
    }
  }

  // --- BillingPort: public facts -------------------------------------------

  site(): BillingSiteView {
    const config = this.#options.config
    return {
      sourceUrl: config.sourceUrl,
      termsUrl: config.termsUrl,
      plans: this.service.plans(),
      channels: {
        wechatpay: this.#channels.wechatpay !== undefined,
        alipay: this.#channels.alipay !== undefined,
        redeem: config.channels.redeem.enabled,
      },
    }
  }

  async standing(subject: string): Promise<BillingStanding> {
    const entitlement = this.service.entitlement(subject)
    const plan = this.#options.config.plans.find(
      one => one.id === entitlement.planId,
    )
    let tenant: string | null = null
    let nodesMapped = 0
    try {
      const config = this.#options.tenancy.read().config
      tenant =
        config.subjects.find(row => row.subject === subject)?.tenant ?? null
      nodesMapped =
        tenant === null
          ? 0
          : config.nodes.filter(row => row.tenant === tenant).length
    } catch {
      tenant = null
    }
    return {
      active: entitlement.active,
      planId: entitlement.planId,
      endsAt: entitlement.endsAt,
      nodes: entitlement.active ? (plan?.nodes ?? 0) : 0,
      tenant,
      nodesMapped,
    }
  }

  async me(subject: string): Promise<Result<BillingMeView>> {
    const standing = await this.standing(subject)
    const gateway =
      standing.tenant === null
        ? ok({
            gateway: 'none' as const,
            mainModel: null,
            upstreams: [],
            usage: null,
          })
        : await this.#options.magpie.tenantView(standing.tenant)
    if (!gateway.ok) return gateway
    return ok({
      standing,
      orders: this.service.orders(subject).map(orderView),
      upstreams: gateway.value.upstreams,
      gateway: gateway.value.gateway,
      mainModel: gateway.value.mainModel,
      usage: gateway.value.usage,
    })
  }

  // --- BillingPort: a member's own -----------------------------------------

  async checkout(
    subject: string,
    planId: string,
    channel: BillingChannel,
  ): Promise<Result<BillingCheckoutView>> {
    try {
      const created = await this.service.createOrder(subject, planId, channel)
      return ok({
        orderId: created.orderId,
        planId,
        channel,
        amountCents: created.amountCents,
        expiresAt: created.expiresAt,
        qrText: created.qrText,
      })
    } catch (error) {
      return fromBilling(error)
    }
  }

  async order(
    subject: string,
    orderId: string,
  ): Promise<Result<BillingOrderView & { readonly qrText: string | null }>> {
    const row = this.#options.store.order(orderId)
    if (row === null || row.subject !== subject)
      return failed('not_found', '订单不存在')
    try {
      const view = await this.service.pollOrder(orderId)
      const qrText =
        view.status === 'created'
          ? (this.#options.store.order(orderId)?.qrText ?? null)
          : null
      return ok({ ...orderView(view), qrText })
    } catch (error) {
      return fromBilling(error)
    }
  }

  async redeem(
    subject: string,
    code: string,
  ): Promise<Result<BillingStanding>> {
    try {
      await this.service.redeem(subject, code)
      return ok(await this.standing(subject))
    } catch (error) {
      return fromBilling(error)
    }
  }

  async notify(
    channel: string,
    request: BillingNotifyRequest,
  ): Promise<BillingNotifyReply> {
    if (!isChannel(channel)) return { httpStatus: 404, body: '', headers: {} }
    return this.service.handleNotify(channel, {
      headers: request.headers,
      rawBody: request.rawBody,
      ...(request.contentType === undefined
        ? {}
        : { contentType: request.contentType }),
    })
  }

  presets(): Promise<Result<readonly BillingPresetView[]>> {
    return this.#options.magpie.tenantPresets()
  }

  async addUpstream(
    subject: string,
    draft: { readonly preset: string; readonly key: string },
  ): Promise<Result<BillingUpstreamView>> {
    if (!this.service.entitlement(subject).active)
      return failed('rejected', '需要有效订阅')
    let tenant: string | null
    try {
      tenant = this.#tenantOf(subject)
    } catch {
      return failed('unreachable', '租户配置不可用')
    }
    if (tenant === null) return failed('invalid', '订阅还在开通 · 稍后再试')
    return this.#options.magpie.addTenantUpstream(tenant, draft)
  }

  async removeUpstream(subject: string, id: string): Promise<Result<void>> {
    let tenant: string | null
    try {
      tenant = this.#tenantOf(subject)
    } catch {
      return failed('unreachable', '租户配置不可用')
    }
    if (tenant === null) return failed('not_found', '没有这个上游')
    return this.#options.magpie.removeTenantUpstream(tenant, id)
  }

  // --- BillingPort: platform ops -------------------------------------------

  async admin(): Promise<Result<BillingAdminView>> {
    const snapshot = this.service.adminSnapshot()
    let subjects: TenantConfig['subjects'] = []
    try {
      subjects = this.#options.tenancy.read().config.subjects
    } catch {
      subjects = []
    }
    return ok({
      plans: snapshot.plans,
      channels: snapshot.channels,
      orders: snapshot.orders.map(order => ({
        ...orderView(order),
        subject: order.subject,
        outTradeNo: order.outTradeNo,
        providerTxnId: order.providerTxnId,
      })),
      subscriptions: snapshot.subscriptions.map(row => ({
        subject: row.subject,
        planId: row.planId,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        active: row.active,
        gateway: row.gateway,
        attempts: row.attempts,
        tenant:
          subjects.find(one => one.subject === row.subject)?.tenant ?? null,
      })),
      codes: snapshot.codes,
      chain: snapshot.chain,
    })
  }

  async grant(
    actor: DirectionActor,
    input: {
      readonly subject: string
      readonly planId: string
      readonly periods: number
      readonly reason: string
    },
  ): Promise<Result<BillingStanding>> {
    try {
      await this.service.grant(
        actor.subject,
        input.subject,
        input.planId,
        input.periods,
        input.reason,
      )
      return ok(await this.standing(input.subject))
    } catch (error) {
      return fromBilling(error)
    }
  }

  async refund(
    actor: DirectionActor,
    input: { readonly orderId: string; readonly reason: string },
  ): Promise<Result<BillingStanding>> {
    try {
      await this.service.markRefunded(
        actor.subject,
        input.orderId,
        input.reason,
      )
      const subject = this.#options.store.order(input.orderId)?.subject
      if (subject === undefined) return failed('not_found', '订单不存在')
      return ok(await this.standing(subject))
    } catch (error) {
      return fromBilling(error)
    }
  }

  async codes(
    actor: DirectionActor,
    input: {
      readonly planId: string
      readonly periods: number
      readonly count: number
      readonly expiresAt?: number
    },
  ): Promise<Result<{ readonly codes: readonly string[] }>> {
    try {
      return ok({
        codes: this.service.issueRedeemCodes(
          actor.subject,
          input.planId,
          input.periods,
          input.count,
          input.expiresAt,
        ),
      })
    } catch (error) {
      return fromBilling(error)
    }
  }

  async verify(): Promise<Result<BillingChainView>> {
    return ok(this.#options.store.verifyChain())
  }
}

/** A ledger writer for the hub's own lines (`system:billing`). */
export function systemRecorder(
  record: (entry: {
    readonly at: number
    readonly requestId: string
    readonly subject: string
    readonly action: string
    readonly target: string
    readonly outcome: 'ok' | 'refused' | 'failed'
    readonly code?: string
  }) => Promise<{ readonly ok: boolean }>,
  now: () => number = Date.now,
): SystemRecord {
  return async (action, target, outcome, code) => {
    const result = await record({
      at: now(),
      requestId: `billing-${randomUUID()}`,
      subject: 'system:billing',
      action,
      target,
      outcome,
      ...(code === undefined ? {} : { code }),
    })
    return result.ok
  }
}
