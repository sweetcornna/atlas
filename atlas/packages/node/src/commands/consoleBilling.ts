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
 * 指派套餐含的节点数（`allowance`，没有有效订阅是 0），多出来的节点（映射多于
 * 套餐、降级、到期）换成「无模型」档案并下发，收回节点上原有的密钥。
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
  ProviderNodeView,
  ProviderPort,
  TenantConfig,
  TenantPort,
} from '@qianmo/console'
import type { MagpieLimit } from '@qianmo/magpie'
import {
  type ConsoleMagpie,
  isTenantProfile,
  mayRunTenantProfile,
  NO_MODEL_PROFILE,
} from './consoleMagpie.js'

const SWEEP_EVERY_MS = 60_000
/**
 * A delivery that failed twice running is tried again after this long, then
 * after twice as long each time it fails again, never more than
 * {@link RETRY_AT_MOST_MS} apart. Every try is an apply in the model
 * service's book and a row in the action ledger, and a node that answers
 * but refuses (a full disk) would otherwise be asked every few minutes for
 * as long as it lasts.
 */
const RETRY_FIRST_MS = 5 * 60_000
const RETRY_AT_MOST_MS = 60 * 60_000

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
    case 'not_live':
      return failed('rejected', '未开通正式收款 · 暂不接受扫码付款')
    case 'plan_conflict':
      return failed('rejected', '已有别的套餐在有效期内 · 到期后再换')
    case 'order_open':
      return failed(
        'rejected',
        '另一个套餐还有待支付的订单 · 付款或等它过期后再下单',
      )
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

/**
 * Whether a node is not running what it is expected to and nothing is on
 * its way: its last delivery did not land, or it runs another profile or
 * revision (or none) with no switch pending.
 */
function behind(row: ProviderNodeView): boolean {
  if (row.expected === null) return false
  const last = row.recent.find(one => one.kind === 'apply')
  if (last !== undefined && last.outcome !== 'ok') return true
  const kinds = new Set(row.drift.map(one => one.kind))
  if (kinds.has('pending')) return false
  return kinds.has('out-of-sync') || kinds.has('unmanaged')
}

export class ConsoleBilling implements BillingPort, GatewayProvisioner {
  readonly service: BillingService
  readonly #options: ConsoleBillingOptions
  readonly #channels: Partial<Record<PaymentChannelId, PaymentChannel>>
  readonly #dirty = new Set<string>()
  /**
   * Nodes whose last delivery failed: when the sweep may try again (at the
   * next sweep after a first failure, then backing off up to an hour) and
   * how many failed in a row. A delivery on an event (a changed profile, a
   * tenant node to (re)assign) does not wait for it.
   */
  readonly #retry = new Map<string, { at: number; failures: number }>()
  #nodes: Promise<void> = Promise.resolve()
  /** Said once that nodes wait for 「无模型」, until it can be made again. */
  #noModelWarned = false
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

  /**
   * The 60-second sweep and the tenancy watch, after the console is up. The
   * nodes are put in step at once, as a sweep does (retries included): a
   * restart forgets which deliveries are owed, and a node handed back while
   * the hub was down still holds its key.
   */
  start(): void {
    if (this.#timer !== null) return
    this.#timer = setInterval(() => {
      void this.tick()
    }, this.#options.sweepEveryMs ?? SWEEP_EVERY_MS)
    this.#timer.unref?.()
    this.#unsubscribe = this.#options.tenancy.subscribe(() => {
      void this.syncNodes()
    })
    void this.#queueSync(true)
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
    await this.#queueSync(true)
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
    return this.#allowanceIn(config, tenant)
  }

  /** Whether a subject of `tenant` other than `except` has an active plan. */
  #paidUpIn(tenant: string, except: string): boolean {
    return this.#options.tenancy
      .read()
      .config.subjects.some(
        row =>
          row.tenant === tenant &&
          row.subject !== except &&
          this.service.entitlement(row.subject).active,
      )
  }

  #allowanceIn(config: TenantConfig, tenant: string): number {
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
    // Off also reaches a tenant whose mapping was edited away: the one the
    // ledger recorded when this subscription was provisioned. Never a tenant
    // id guessed from the subject — that can be another subscriber's.
    const recorded = /^tenant:(.+)$/.exec(
      this.#options.store.subscription(subject)?.binding ?? '',
    )?.[1]
    const tenants = enabled
      ? mapped === null
        ? []
        : [mapped]
      : [
          ...new Set(
            [mapped, recorded].filter(
              (one): one is string => one !== null && one !== undefined,
            ),
          ),
        ]
    for (const tenant of tenants) {
      // Somebody else in the tenant still paid up keeps it on.
      if (!enabled && this.#paidUpIn(tenant, subject)) continue
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
    return this.#queueSync(false)
  }

  /** `sweep`: the 60-second pass, which also retries deliveries that did not land. */
  #queueSync(sweep: boolean): Promise<void> {
    const next = this.#nodes.then(() => this.#syncNodes(sweep))
    this.#nodes = next.catch(error => {
      this.#options.onError?.(`billing: 节点指派失败 · ${String(error)}`)
    })
    return this.#nodes
  }

  async #syncNodes(sweep: boolean): Promise<void> {
    const { providers, caller, magpie } = this.#options
    const config = this.#options.tenancy.read().config
    const overview = await providers.overview()
    if (!overview.ok) return
    const rows = new Map(overview.value.nodes.map(row => [row.node, row]))
    const now = (this.#options.now ?? Date.now)()
    // Where a node beyond the plan goes: an apply of it replaces every key
    // the node held; "not managed" would leave the last delivery in place.
    const none = await magpie.noModelProfile()
    // A node no longer mapped to any tenant (handed back to the platform, or
    // its tenant moved to another) keeps a subscriber's key until something
    // else is delivered. Still assigned their profile, or meant to send
    // nothing (not managed, a default of nothing) while it may still run
    // one, it goes on no model; meant to run something else, the sweep
    // delivers that again while it may still run one. This runs with no
    // tenant node left at all.
    const mapped = new Set(config.nodes.map(row => row.nodeId))
    const reclaim: string[] = []
    // Nodes that should go on no model while it cannot be made (no gateway
    // connected): left as they are, and said.
    const waiting: string[] = []
    for (const row of overview.value.nodes) {
      if (mapped.has(row.node)) continue
      const current =
        row.assignment.mode === 'profile' ? row.assignment.profileId : null
      const runs = mayRunTenantProfile(row)
      if (
        (current !== null && isTenantProfile(current)) ||
        (row.expected === null && runs)
      ) {
        if (none === null) {
          waiting.push(row.node)
          continue
        }
        const assigned = await providers.assign(
          { node: row.node, assignment: { mode: 'profile', profileId: none } },
          caller,
        )
        if (!assigned.ok) {
          this.#options.onError?.(
            `billing: ${row.node} 没能指派 ${none} · ${assigned.failure.message}`,
          )
          continue
        }
        reclaim.push(row.node)
      } else if (
        sweep &&
        runs &&
        row.expected !== null &&
        behind(row) &&
        (this.#retry.get(row.node)?.at ?? 0) <= now
      )
        reclaim.push(row.node)
    }
    await this.#deliver(reclaim, now)
    for (const { id: tenant } of config.tenants) {
      const dirty = this.#dirty.delete(tenant)
      const nodes = config.nodes
        .filter(row => row.tenant === tenant)
        .map(row => row.nodeId)
        .filter(node => rows.has(node))
      if (nodes.length === 0) continue
      const profileId = magpie.tenantProfileId(tenant)
      const allowed = profileId === null ? 0 : this.#allowanceIn(config, tenant)
      const current = (node: string): string | null => {
        const assignment = rows.get(node)?.assignment
        return assignment?.mode === 'profile' ? assignment.profileId : null
      }
      // Nodes already on the tenant's profile keep it first, in the order
      // ops listed them; the plan's remaining room goes to the next ones;
      // every other node (a downgrade, an expiry, more mapped than paid
      // for) is put on no model.
      const keep = new Set(
        nodes.filter(node => current(node) === profileId).slice(0, allowed),
      )
      let room = allowed - keep.size
      const deliver: string[] = []
      for (const node of nodes) {
        let target: string | null = none
        if (keep.has(node)) target = profileId
        else if (room > 0 && profileId !== null) {
          target = profileId
          room -= 1
        }
        if (target === null) {
          if (current(node) !== NO_MODEL_PROFILE) waiting.push(node)
          continue
        }
        if (current(node) === target) {
          const row = rows.get(node)
          if (dirty && target === profileId) deliver.push(node)
          else if (sweep && row !== undefined && behind(row)) {
            // A delivery that did not land (the node was busy, unreachable,
            // or refused) is tried again by the sweep: at the next one, then
            // less often while the retries keep failing, at least hourly.
            if ((this.#retry.get(node)?.at ?? 0) > now) continue
            deliver.push(node)
          } else if (row !== undefined && !behind(row))
            // In step after all (ops delivered it): the next failure starts
            // the back-off afresh.
            this.#retry.delete(node)
          continue
        }
        const assigned = await providers.assign(
          { node, assignment: { mode: 'profile', profileId: target } },
          caller,
        )
        if (!assigned.ok) {
          this.#options.onError?.(
            `billing: ${node} 没能指派 ${target} · ${assigned.failure.message}`,
          )
          continue
        }
        deliver.push(node)
      }
      await this.#deliver(deliver, now)
    }
    if (none !== null) this.#noModelWarned = false
    else if (waiting.length > 0 && !this.#noModelWarned) {
      this.#noModelWarned = true
      this.#options.onError?.(
        `billing: 无模型档案不可用 · 网关未连接或档案未存入 · ${waiting.join(' ')} 暂未收回`,
      )
    }
  }

  /** Deliver to `nodes`, noting what did not land for the sweep to try again. */
  async #deliver(nodes: readonly string[], now: number): Promise<void> {
    if (nodes.length === 0) return
    const { providers, caller } = this.#options
    const applied = await providers.apply({ nodes: [...nodes] }, caller)
    if (!applied.ok) {
      this.#options.onError?.(
        `billing: 下发到 ${nodes.join(' ')} 失败 · ${applied.failure.message}`,
      )
      for (const node of nodes) this.#failed(node, now)
      return
    }
    for (const result of applied.value) {
      if (result.outcome === 'ok') {
        this.#retry.delete(result.node)
        continue
      }
      this.#failed(result.node, now)
      this.#options.onError?.(
        `billing: 下发到 ${result.node} 未完成 · ${result.code ?? result.outcome} · ${result.message ?? ''}`,
      )
    }
  }

  /** Note a delivery that did not land, and when the sweep may try again. */
  #failed(node: string, now: number): void {
    const failures = (this.#retry.get(node)?.failures ?? 0) + 1
    this.#retry.set(node, {
      at:
        failures === 1
          ? now
          : now +
            Math.min(RETRY_FIRST_MS * 2 ** (failures - 2), RETRY_AT_MOST_MS),
      failures,
    })
  }

  // --- BillingPort: public facts -------------------------------------------

  site(): BillingSiteView {
    const config = this.#options.config
    // Without 正式收款 the QR channels stay wired for orders already out,
    // but none takes a new one.
    return {
      sourceUrl: config.sourceUrl,
      termsUrl: config.termsUrl,
      live: config.live,
      plans: this.service.plans(),
      channels: {
        wechatpay: config.live && this.#channels.wechatpay !== undefined,
        alipay: config.live && this.#channels.alipay !== undefined,
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
      live: snapshot.live,
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
      refundsDue: snapshot.refundsDue.map(row => ({
        orderId: row.orderId,
        subject: row.subject,
        planId: row.planId,
        activePlanId: row.activePlanId,
        amountCents: row.amountCents,
        channel: row.channel,
        outTradeNo: row.outTradeNo,
        paidAt: row.paidAt,
      })),
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

/** A ledger writer for the hub's own lines (`system:billing`, or `subject`). */
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
  subject = 'system:billing',
): SystemRecord {
  const prefix = subject.slice('system:'.length)
  return async (action, target, outcome, code) => {
    const result = await record({
      at: now(),
      requestId: `${prefix}-${randomUUID()}`,
      subject,
      action,
      target,
      outcome,
      ...(code === undefined ? {} : { code }),
    })
    return result.ok
  }
}
