// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Subscription rules on top of the store and the channels.
 *
 * - Real payments only when the config says so: with `live` off (the
 *   default) a QR order is refused (`not_live`) before any row is written or
 *   any provider is asked. The channels are still built, so orders placed
 *   while it was on are queried, closed and settled. Redeem codes and grants
 *   are not payments and work either way.
 * - Prepaid periods: every purchase, code or grant adds
 *   `periods × periodDays` to `max(now, endsAt)`. No recurring debit.
 * - One plan at a time: buying or redeeming a different plan while one is
 *   active is refused; an operator grant may switch plans. A payment that
 *   settles while another plan is active (an order paid after it expired,
 *   say) is recorded as paid and extends nothing: crediting it would switch
 *   the plan and carry the old period over. It is listed as owed a refund
 *   (`AdminSnapshot.refundsDue`) until the operator marks it refunded.
 * - One payable plan per person: while an order for one plan can still be
 *   paid, an order for another plan is refused (`order_open`), and order
 *   creation is serialised per person. Refused rather than closing the old
 *   order: an Alipay precreate QR nobody has scanned yet answers the close
 *   with "no such trade" and can still be paid until its own timeout, so a
 *   close would not make the old QR unpayable.
 * - A verified payment is never dropped. It is committed (order paid +
 *   subscription extended + gateway marked pending) in one transaction
 *   before the gateway is touched; a provisioning failure leaves the
 *   subscription `pending` for {@link BillingService.sweep} to retry.
 * - The notification reply waits for provisioning at most
 *   `notifyBudgetMs` (WeChat Pay wants an answer within 5 s).
 * - Provisioning for one subject is serialised in this process, and its
 *   result is recorded only if the subscription did not change meanwhile.
 */

import { randomBytes } from 'node:crypto'
import { AlipayChannel } from './channels/alipay.js'
import {
  generateRedeemCode,
  hashRedeemCode,
  normalizeRedeemCode,
} from './channels/redeem.js'
import {
  ChannelError,
  type NotifyReply,
  type NotifyRequest,
  type NotifyVerdict,
  type PaymentChannel,
  type PaymentChannelId,
  type TradeStatus,
} from './channels/types.js'
import { WechatPayChannel } from './channels/wechatpay.js'
import type { FetchLike } from './channels/wire.js'
import type { BillingConfig, Plan, PlanProvision } from './config.js'
import type {
  BillingStore,
  ChainReport,
  GatewayState,
  OrderRow,
  OrderStatus,
  SubscriptionChange,
  SubscriptionRow,
} from './store.js'

const DAY_MS = 86_400_000
/** An open order is reused only if the payer still has this long to pay. */
const REUSE_MARGIN_MS = 60_000
/** The checkout page may poll often; the provider is asked at most this often. */
const QUERY_INTERVAL_MS = 5_000
/** Give up closing at the provider after this; its own expiry has long hit. */
const CLOSE_GRACE_MS = DAY_MS
const MAX_REDEEM_BATCH = 1000
const MAX_PERIODS = 120
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/**
 * The hub implements this with its tenancy and the gateway (magpie).
 * Contract: `ensure` is idempotent (give the subscriber a tenant, the plan's
 * node allowance and the fair-use limits on the tenant's gateway key) and
 * returns an opaque binding (not a secret); `setEnabled(subject, false)` for
 * a subject never ensured must resolve as a no-op. Errors may be thrown
 * freely; only their `name` is recorded.
 */
export interface GatewayProvisioner {
  ensure(subject: string, plan: PlanProvision): Promise<{ binding: string }>
  setEnabled(subject: string, enabled: boolean): Promise<void>
}

export type BillingErrorCode =
  | 'invalid_argument'
  | 'unknown_plan'
  | 'channel_unavailable'
  | 'not_live'
  | 'plan_conflict'
  | 'order_open'
  | 'provider_error'
  | 'unknown_order'
  | 'invalid_code'
  | 'not_paid'

/** A refusal the hub can show; messages never carry secrets. */
export class BillingError extends Error {
  override readonly name = 'BillingError'
  constructor(
    readonly code: BillingErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface Entitlement {
  readonly active: boolean
  readonly planId: string | null
  readonly endsAt: number | null
}

export interface OrderView {
  readonly orderId: string
  readonly subject: string
  readonly planId: string
  readonly channel: string
  readonly amountCents: number
  readonly status: OrderStatus
  readonly outTradeNo: string
  readonly providerTxnId: string | null
  readonly createdAt: number
  readonly expiresAt: number
  readonly paidAt: number | null
}

export interface CreatedOrder {
  readonly orderId: string
  readonly outTradeNo: string
  readonly qrText: string
  readonly expiresAt: number
  readonly amountCents: number
}

export interface PublicPlan {
  readonly id: string
  readonly name: string
  readonly priceCents: number
  readonly periodDays: number
  readonly note: string | null
  readonly nodes: number
}

export interface AdminSnapshot {
  readonly plans: readonly PublicPlan[]
  /** `billing.json` `live`: may QR orders be placed with the providers. */
  readonly live: boolean
  readonly channels: Readonly<Record<PaymentChannelId | 'redeem', boolean>>
  readonly orders: readonly OrderView[]
  readonly subscriptions: readonly {
    readonly subject: string
    readonly planId: string
    readonly startsAt: number
    readonly endsAt: number
    readonly updatedAt: number
    readonly active: boolean
    readonly gateway: GatewayState
    readonly attempts: number
  }[]
  readonly codes: readonly {
    readonly id: string
    readonly planId: string
    readonly periods: number
    readonly createdBy: string
    readonly createdAt: number
    readonly expiresAt: number | null
    readonly usedBy: string | null
    readonly usedAt: number | null
  }[]
  /** Paid orders that extended nothing (another plan was active), not yet refunded. */
  readonly refundsDue: readonly {
    readonly orderId: string
    readonly subject: string
    readonly planId: string
    /** The plan that was active when the order settled. */
    readonly activePlanId: string
    readonly amountCents: number
    readonly channel: string
    readonly outTradeNo: string
    readonly paidAt: number | null
    /** When the conflict was recorded. */
    readonly at: number
  }[]
  readonly chain: ChainReport
}

export interface SweepReport {
  readonly disabled: number
  readonly provisioned: number
  readonly closed: number
}

export interface BillingServiceOptions {
  readonly config: BillingConfig
  readonly store: BillingStore
  readonly channels: Partial<Record<PaymentChannelId, PaymentChannel>>
  readonly provisioner: GatewayProvisioner
  readonly clock?: () => number
  /** `n` uniform random bytes. */
  readonly random?: (bytes: number) => Uint8Array
  /** Operational lines (no secrets, no message bodies). */
  readonly log?: (line: string) => void
  /** How long a notification reply waits for provisioning (default 3000). */
  readonly notifyBudgetMs?: number
}

/** The payment channels the config enables, wired to `fetch`. */
export function createPaymentChannels(
  config: BillingConfig,
  options: { fetch?: FetchLike; now?: () => number } = {},
): Partial<Record<PaymentChannelId, PaymentChannel>> {
  const channels: Partial<Record<PaymentChannelId, PaymentChannel>> = {}
  if (config.channels.wechatpay)
    channels.wechatpay = new WechatPayChannel({
      config: config.channels.wechatpay,
      ...options,
    })
  if (config.channels.alipay)
    channels.alipay = new AlipayChannel({
      config: config.channels.alipay,
      ...options,
    })
  return channels
}

function validText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !/\p{Cc}/u.test(value)
  )
}

function viewOf(row: OrderRow): OrderView {
  return {
    orderId: row.id,
    subject: row.subject,
    planId: row.planId,
    channel: row.channel,
    amountCents: row.amountCents,
    status: row.status,
    outTradeNo: row.outTradeNo,
    providerTxnId: row.providerTxnId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    paidAt: row.paidAt,
  }
}

function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(name) ? name : 'Error'
}

type Settlement =
  | { readonly kind: 'settled'; readonly subject: string }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'mismatch'; readonly field: string }

export class BillingService {
  readonly #config: BillingConfig
  readonly #store: BillingStore
  readonly #channels: Partial<Record<PaymentChannelId, PaymentChannel>>
  readonly #provisioner: GatewayProvisioner
  readonly #clock: () => number
  readonly #random: (bytes: number) => Uint8Array
  readonly #log: (line: string) => void
  readonly #notifyBudgetMs: number
  readonly #queue = new Map<string, Promise<unknown>>()
  readonly #queried = new Map<string, number>()

  constructor(options: BillingServiceOptions) {
    this.#config = options.config
    this.#store = options.store
    this.#channels = options.channels
    this.#provisioner = options.provisioner
    this.#clock = options.clock ?? Date.now
    this.#random = options.random ?? (bytes => randomBytes(bytes))
    this.#log = options.log ?? (() => {})
    this.#notifyBudgetMs = options.notifyBudgetMs ?? 3000
  }

  // ───────────────────────────── reads ─────────────────────────────

  plans(): PublicPlan[] {
    return this.#config.plans.map(plan => ({
      id: plan.id,
      name: plan.name,
      priceCents: plan.priceCents,
      periodDays: plan.periodDays,
      note: plan.note,
      nodes: plan.nodes,
    }))
  }

  /** One subscriber's own orders, newest first. */
  orders(subject: string, limit = 20): OrderView[] {
    return this.#store.ordersOf(subject, limit).map(viewOf)
  }

  entitlement(subject: string, now = this.#clock()): Entitlement {
    const row = this.#store.subscription(subject)
    if (row === null) return { active: false, planId: null, endsAt: null }
    return { active: row.endsAt > now, planId: row.planId, endsAt: row.endsAt }
  }

  adminSnapshot(limit = 200): AdminSnapshot {
    const now = this.#clock()
    return {
      plans: this.plans(),
      live: this.#config.live,
      channels: {
        wechatpay: this.#channels.wechatpay !== undefined,
        alipay: this.#channels.alipay !== undefined,
        redeem: this.#config.channels.redeem.enabled,
      },
      orders: this.#store.recentOrders(limit).map(viewOf),
      subscriptions: this.#store.subscriptions(limit).map(row => ({
        subject: row.subject,
        planId: row.planId,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        updatedAt: row.updatedAt,
        active: row.endsAt > now,
        gateway: row.gateway,
        attempts: row.attempts,
      })),
      codes: this.#store.redeemCodes(limit).map(row => ({
        id: row.id,
        planId: row.planId,
        periods: row.periods,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        usedBy: row.usedBy,
        usedAt: row.usedAt,
      })),
      refundsDue: this.#store.refundsDue(limit).map(row => ({
        orderId: row.orderId,
        subject: row.subject,
        planId: row.planId,
        activePlanId: row.activePlanId,
        amountCents: row.amountCents,
        channel: row.channel,
        outTradeNo: row.outTradeNo,
        paidAt: row.paidAt,
        at: row.at,
      })),
      chain: this.#store.verifyChain(),
    }
  }

  // ───────────────────────────── orders ─────────────────────────────

  async createOrder(
    subject: string,
    planId: string,
    channelId: PaymentChannelId,
  ): Promise<CreatedOrder> {
    this.#assertSubject(subject)
    const plan = this.#plan(planId)
    const channel = this.#channel(channelId)
    if (!this.#config.live)
      throw new BillingError('not_live', '未开通正式收款，暂不接受扫码付款')
    return this.#serial(`order:${subject}`, async () => {
      const now = this.#clock()
      this.#assertPlanCompatible(subject, plan.id, now)
      if (this.#store.openOrderOfOtherPlan(subject, plan.id, now) !== null)
        throw new BillingError(
          'order_open',
          '另一个套餐还有待支付的订单，付款或等它过期后再下单',
        )
      const open = this.#store.openOrder(
        subject,
        plan.id,
        channelId,
        now + REUSE_MARGIN_MS,
      )
      if (
        open !== null &&
        open.qrText !== null &&
        open.amountCents === plan.priceCents
      )
        return {
          orderId: open.id,
          outTradeNo: open.outTradeNo,
          qrText: open.qrText,
          expiresAt: open.expiresAt,
          amountCents: open.amountCents,
        }
      const order: OrderRow = {
        id: `ord_${this.#token(22)}`,
        subject,
        planId: plan.id,
        amountCents: plan.priceCents,
        periodDays: plan.periodDays,
        channel: channelId,
        status: 'created',
        outTradeNo: this.#token(32),
        providerTxnId: null,
        qrText: null,
        createdAt: now,
        expiresAt: now + this.#config.orderTtlMinutes * 60_000,
        paidAt: null,
      }
      // Durable before the provider hears of it: a crash in between leaves a
      // row that closeExpired() will query and close.
      this.#store.insertOrder(order, now)
      let qrText: string
      try {
        ;({ qrText } = await channel.createQr({
          outTradeNo: order.outTradeNo,
          amountCents: order.amountCents,
          title: plan.name,
          expiresAt: order.expiresAt,
        }))
      } catch (error) {
        this.#store.closeOrder(
          order.id,
          'closed',
          'create_failed',
          this.#clock(),
        )
        const detail =
          error instanceof ChannelError ? error.code : errorName(error)
        this.#log(`billing: ${channelId} 下单失败 ${order.id}: ${detail}`)
        throw new BillingError('provider_error', '下单失败，请稍后重试')
      }
      this.#store.setOrderQr(order.id, qrText, this.#clock())
      return {
        orderId: order.id,
        outTradeNo: order.outTradeNo,
        qrText,
        expiresAt: order.expiresAt,
        amountCents: order.amountCents,
      }
    })
  }

  /**
   * The checkout page's poll. Order ids are 128-bit random capabilities; the
   * hub still must check `subject` against the caller.
   */
  async pollOrder(orderId: string): Promise<OrderView> {
    const order = this.#store.order(orderId)
    if (order === null) throw new BillingError('unknown_order', '订单不存在')
    const channel = this.#channels[order.channel as PaymentChannelId]
    const now = this.#clock()
    if (order.status === 'created' && channel !== undefined) {
      const last = this.#queried.get(orderId)
      if (last === undefined || now - last >= QUERY_INTERVAL_MS) {
        this.#remember(orderId, now)
        try {
          const trade = await channel.query(order.outTradeNo)
          if (trade.state === 'paid')
            await this.#accept(order.channel, trade, 'query')
        } catch (error) {
          this.#log(`billing: 查单失败 ${orderId}: ${errorName(error)}`)
        }
      }
    }
    return viewOf(this.#store.order(orderId)!)
  }

  /**
   * Orders past their TTL: ask the provider first (a late payment is
   * accepted), then close there and expire here. Returns how many expired.
   */
  async closeExpired(now = this.#clock()): Promise<number> {
    let expired = 0
    for (const order of this.#store.ordersDue(now, 100)) {
      const channel = this.#channels[order.channel as PaymentChannelId]
      try {
        if (channel === undefined) throw new Error('channel not configured')
        const trade = await channel.query(order.outTradeNo)
        if (trade.state === 'paid') {
          await this.#accept(order.channel, trade, 'query')
          continue
        }
        if (trade.state === 'pending') await channel.close(order.outTradeNo)
        if (this.#store.closeOrder(order.id, 'expired', 'ttl', now)) expired++
      } catch (error) {
        this.#log(`billing: 关单失败 ${order.id}: ${errorName(error)}`)
        if (
          now > order.expiresAt + CLOSE_GRACE_MS &&
          this.#store.closeOrder(order.id, 'expired', 'ttl_unconfirmed', now)
        )
          expired++
      }
      this.#queried.delete(order.id)
    }
    return expired
  }

  // ─────────────────────────── notifications ───────────────────────────

  async handleNotify(
    channelId: PaymentChannelId,
    request: NotifyRequest,
  ): Promise<NotifyReply> {
    const channel = this.#channels[channelId]
    if (channel === undefined) return { httpStatus: 404, body: '', headers: {} }
    let verdict: NotifyVerdict
    try {
      verdict = channel.verifyNotify(request, this.#clock())
    } catch {
      verdict = { ok: false, reason: '无法解析' }
    }
    if (!verdict.ok) {
      // Not an event: unauthenticated input must not grow the ledger.
      this.#log(`billing: ${channelId} 通知被拒：${verdict.reason}`)
      return channel.reply('rejected', '验签失败')
    }
    if (verdict.trade.state !== 'paid') return channel.reply('ok', '')
    let outcome: Settlement
    try {
      outcome = await this.#accept(channelId, verdict.trade, 'notify')
    } catch (error) {
      this.#log(`billing: ${channelId} 通知处理失败：${errorName(error)}`)
      return channel.reply('retry', '处理失败')
    }
    if (outcome.kind === 'mismatch')
      return channel.reply('rejected', '订单信息不符')
    return channel.reply('ok', '')
  }

  /** Settle a verified paid trade, then provision within the notify budget. */
  async #accept(
    channelId: string,
    trade: TradeStatus,
    source: 'notify' | 'query',
  ): Promise<Settlement> {
    const outcome = this.#settle(channelId, trade, source)
    if (outcome.kind === 'settled')
      await this.#withinBudget(this.#provision(outcome.subject))
    return outcome
  }

  #settle(
    channelId: string,
    trade: TradeStatus,
    source: 'notify' | 'query',
  ): Settlement {
    const now = this.#clock()
    return this.#store.transaction((): Settlement => {
      const order = this.#store.orderByOutTradeNo(trade.outTradeNo)
      const field =
        order === null
          ? 'outTradeNo'
          : order.channel !== channelId
            ? 'channel'
            : !trade.merchantMatches
              ? 'merchant'
              : trade.amountCents !== order.amountCents
                ? 'amount'
                : trade.currency !== 'CNY'
                  ? 'currency'
                  : null
      if (field !== null) {
        this.#store.recordMismatch(
          {
            channel: channelId,
            outTradeNo: trade.outTradeNo,
            orderId: order?.id ?? null,
            field,
            source,
          },
          now,
        )
        this.#log(`billing: ${channelId} 支付结果与订单不符（${field}）`)
        // Our own query keeps asking every poll and sweep; stop it here. A
        // genuine notification later can still settle the closed order.
        if (source === 'query' && order !== null)
          this.#store.closeOrder(order.id, 'closed', `mismatch_${field}`, now)
        return { kind: 'mismatch', field }
      }
      const paid = order!
      if (paid.status === 'paid' || paid.status === 'refunded') {
        if (
          trade.providerTxnId !== null &&
          trade.providerTxnId !== paid.providerTxnId
        )
          this.#log(`billing: ${paid.id} 重复支付通知的交易号不同`)
        return { kind: 'duplicate' }
      }
      const current = this.#store.subscription(paid.subject)
      this.#store.markOrderPaid(
        paid.id,
        {
          providerTxnId: trade.providerTxnId,
          source,
          late: paid.status !== 'created',
        },
        now,
      )
      if (
        current !== null &&
        current.endsAt > now &&
        current.planId !== paid.planId
      ) {
        // The money is in; crediting it would switch the plan and keep the
        // other plan's days. Recorded, not credited, owed a refund.
        this.#store.recordConflict(
          {
            orderId: paid.id,
            subject: paid.subject,
            planId: paid.planId,
            activePlanId: current.planId,
          },
          now,
        )
        this.#log(
          `billing: ${paid.id} 付款时已有别的套餐在有效期内 · 记已付不延长 · 待退款`,
        )
        return { kind: 'conflict' }
      }
      this.#extend(
        paid.subject,
        paid.planId,
        paid.periodDays,
        { cause: 'order', ref: paid.id },
        now,
      )
      return { kind: 'settled', subject: paid.subject }
    })
  }

  // ───────────────────────── codes, grants, refunds ─────────────────────────

  /** Plaintext codes, returned once; only their hashes are stored. */
  issueRedeemCodes(
    by: string,
    planId: string,
    periods: number,
    count: number,
    expiresAt?: number,
  ): string[] {
    this.#assertActor(by)
    const plan = this.#plan(planId)
    this.#assertPeriods(periods)
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_REDEEM_BATCH)
      throw new BillingError(
        'invalid_argument',
        `数量必须是 1–${MAX_REDEEM_BATCH} 的整数`,
      )
    const now = this.#clock()
    if (
      expiresAt !== undefined &&
      (!Number.isSafeInteger(expiresAt) || expiresAt <= now)
    )
      throw new BillingError('invalid_argument', '过期时间必须晚于现在')
    const codes: string[] = []
    this.#store.transaction(() => {
      while (codes.length < count) {
        const code = generateRedeemCode(this.#random)
        const hash = hashRedeemCode(normalizeRedeemCode(code)!)
        if (this.#store.redeemCode(hash) !== null) continue
        this.#store.insertRedeemCode(
          {
            hash,
            id: `rc_${this.#token(12)}`,
            planId: plan.id,
            periods,
            createdBy: by,
            createdAt: now,
            expiresAt: expiresAt ?? null,
            usedBy: null,
            usedAt: null,
          },
          now,
        )
        codes.push(code)
      }
    })
    return codes
  }

  async redeem(subject: string, code: string): Promise<Entitlement> {
    if (!this.#config.channels.redeem.enabled)
      throw new BillingError('channel_unavailable', '兑换码未开放')
    this.#assertSubject(subject)
    const normalized = normalizeRedeemCode(code)
    const invalid = new BillingError('invalid_code', '兑换码无效或已使用')
    if (normalized === null) throw invalid
    const hash = hashRedeemCode(normalized)
    const now = this.#clock()
    this.#store.transaction(() => {
      const row = this.#store.redeemCode(hash)
      if (
        row === null ||
        row.usedAt !== null ||
        (row.expiresAt !== null && row.expiresAt <= now)
      )
        throw invalid
      const plan = this.#plan(row.planId)
      this.#assertPlanCompatible(subject, plan.id, now)
      if (!this.#store.markRedeemCodeUsed(hash, subject, now)) throw invalid
      this.#extend(
        subject,
        plan.id,
        row.periods * plan.periodDays,
        { cause: 'redeem', ref: row.id },
        now,
      )
    })
    await this.#withinBudget(this.#provision(subject))
    return this.entitlement(subject)
  }

  /** Operator grant; may switch an active subscriber to another plan. */
  async grant(
    by: string,
    subject: string,
    planId: string,
    periods: number,
    reason: string,
  ): Promise<Entitlement> {
    this.#assertActor(by)
    this.#assertSubject(subject)
    this.#assertReason(reason)
    this.#assertPeriods(periods)
    const plan = this.#plan(planId)
    const now = this.#clock()
    this.#store.transaction(() =>
      this.#extend(
        subject,
        plan.id,
        periods * plan.periodDays,
        { cause: 'grant', ref: '', by, reason },
        now,
      ),
    )
    await this.#withinBudget(this.#provision(subject))
    return this.entitlement(subject)
  }

  /**
   * Record a refund made in the merchant console and take back what the
   * order put into the current run: its days, if it was paid since the run
   * began and was credited, and never past the run's start. An order from an
   * earlier, lapsed period, or one that extended nothing (a conflict), leaves
   * the subscription as it is.
   */
  async markRefunded(
    by: string,
    orderId: string,
    reason: string,
  ): Promise<Entitlement> {
    this.#assertActor(by)
    this.#assertReason(reason)
    const now = this.#clock()
    const subject = this.#store.transaction(() => {
      const order = this.#store.order(orderId)
      if (order === null) throw new BillingError('unknown_order', '订单不存在')
      if (!this.#store.markOrderRefunded(orderId, by, reason, now))
        throw new BillingError('not_paid', '只有已支付的订单才能记退款')
      const row = this.#store.subscription(order.subject)
      const credited =
        row !== null &&
        row.endsAt > now &&
        order.paidAt !== null &&
        order.paidAt >= row.startsAt &&
        this.#store.conflict(orderId) === null
      if (credited)
        this.#store.saveSubscription(
          {
            subject: row.subject,
            planId: row.planId,
            startsAt: row.startsAt,
            endsAt: Math.max(
              row.startsAt,
              row.endsAt - order.periodDays * DAY_MS,
            ),
          },
          { cause: 'refund', ref: orderId, by, reason },
          now,
        )
      return order.subject
    })
    await this.#withinBudget(this.#provision(subject))
    return this.entitlement(subject)
  }

  // ───────────────────────────── sweep ─────────────────────────────

  /**
   * Periodic and idempotent: switch off ended subscriptions, retry owed
   * provisioning, close orders past their TTL.
   */
  async sweep(now = this.#clock()): Promise<SweepReport> {
    let disabled = 0
    for (const row of this.#store.subscriptionsToDisable(now, 500)) {
      await this.#provision(row.subject, now)
      if (this.#store.subscription(row.subject)?.gateway === 'disabled')
        disabled++
    }
    let provisioned = 0
    for (const row of this.#store.subscriptionsToProvision(now, 500)) {
      await this.#provision(row.subject, now)
      if (this.#store.subscription(row.subject)?.gateway === 'enabled')
        provisioned++
    }
    const closed = await this.closeExpired(now)
    return { disabled, provisioned, closed }
  }

  // ─────────────────────────── internals ───────────────────────────

  /** Extend inside the caller's transaction. */
  #extend(
    subject: string,
    planId: string,
    days: number,
    change: SubscriptionChange,
    now: number,
  ): SubscriptionRow {
    const prior = this.#store.subscription(subject)
    const active = prior !== null && prior.endsAt > now
    return this.#store.saveSubscription(
      {
        subject,
        planId,
        startsAt: active ? prior.startsAt : now,
        endsAt: (active ? prior.endsAt : now) + days * DAY_MS,
      },
      change,
      now,
    )
  }

  #provision(subject: string, at?: number): Promise<void> {
    return this.#serial(`gateway:${subject}`, () =>
      this.#provisionNow(subject, at),
    ).catch(error => {
      this.#log(`billing: 开通流程异常 ${subject}: ${errorName(error)}`)
    })
  }

  /** Bring the gateway in line with the subscription row, once. */
  async #provisionNow(subject: string, at?: number): Promise<void> {
    for (let round = 0; round < 3; round++) {
      const now = at ?? this.#clock()
      const row = this.#store.subscription(subject)
      if (row === null) return
      if (row.endsAt <= now) {
        if (row.gateway === 'disabled') return
        try {
          await this.#provisioner.setEnabled(subject, false)
        } catch (error) {
          this.#log(`billing: 停用网关失败 ${subject}: ${errorName(error)}`)
          return
        }
        if (this.#store.gatewayDisabled(subject, row.revision, now)) return
        continue
      }
      if (row.gateway !== 'pending') return
      const plan = this.#config.plans.find(item => item.id === row.planId)
      if (plan === undefined) {
        this.#store.gatewayFailed(subject, row.revision, 'plan_removed', now)
        this.#log(`billing: ${subject} 的套餐 ${row.planId} 已不在配置里`)
        return
      }
      try {
        const result = await this.#provisioner.ensure(subject, {
          id: plan.id,
          nodes: plan.nodes,
          gatewayLimits: plan.gatewayLimits,
        })
        if (!validText(result?.binding, 512))
          throw new TypeError('provisioner returned an invalid binding')
        await this.#provisioner.setEnabled(subject, true)
        if (
          this.#store.gatewayEnabled(
            subject,
            row.revision,
            result.binding,
            this.#clock(),
          )
        )
          return
      } catch (error) {
        const attempts = this.#store.gatewayFailed(
          subject,
          row.revision,
          errorName(error),
          this.#clock(),
        )
        this.#log(
          `billing: 开通网关失败 ${subject}（第 ${attempts} 次）: ${errorName(error)}`,
        )
        return
      }
    }
  }

  /** Wait for `work` at most the notify budget; it carries on regardless. */
  async #withinBudget(work: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const budget = new Promise<void>(resolve => {
      timer = setTimeout(resolve, this.#notifyBudgetMs)
    })
    try {
      await Promise.race([work, budget])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Run `task` after every earlier task with the same key. */
  #serial<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.#queue.get(key) ?? Promise.resolve()
    const next = prior.then(task, task)
    const settled = next.then(
      () => {},
      () => {},
    )
    this.#queue.set(key, settled)
    void settled.then(() => {
      if (this.#queue.get(key) === settled) this.#queue.delete(key)
    })
    return next
  }

  #remember(orderId: string, now: number): void {
    if (this.#queried.size > 10_000) this.#queried.clear()
    this.#queried.set(orderId, now)
  }

  /** `length` uniform base62 symbols (rejection sampling). */
  #token(length: number): string {
    let out = ''
    while (out.length < length) {
      for (const byte of this.#random(length * 2)) {
        if (byte >= 248) continue
        out += BASE62[byte % 62]
        if (out.length === length) break
      }
    }
    return out
  }

  #plan(planId: string): Plan {
    const plan = this.#config.plans.find(item => item.id === planId)
    if (plan === undefined) throw new BillingError('unknown_plan', '套餐不存在')
    return plan
  }

  #channel(channelId: PaymentChannelId): PaymentChannel {
    const channel = this.#channels[channelId]
    if (channel === undefined)
      throw new BillingError('channel_unavailable', '该支付方式未开通')
    return channel
  }

  #assertPlanCompatible(subject: string, planId: string, now: number): void {
    const row = this.#store.subscription(subject)
    if (row !== null && row.endsAt > now && row.planId !== planId)
      throw new BillingError('plan_conflict', '当前订阅未到期，只能续同一套餐')
  }

  #assertSubject(subject: string): void {
    if (!validText(subject, 256))
      throw new BillingError('invalid_argument', '用户标识不对')
  }

  #assertActor(by: string): void {
    if (!validText(by, 128))
      throw new BillingError('invalid_argument', '操作人不对')
  }

  #assertReason(reason: string): void {
    if (!validText(reason, 500))
      throw new BillingError('invalid_argument', '原因必填，且不超过 500 字')
  }

  #assertPeriods(periods: number): void {
    if (!Number.isSafeInteger(periods) || periods < 1 || periods > MAX_PERIODS)
      throw new BillingError(
        'invalid_argument',
        `周期数必须是 1–${MAX_PERIODS} 的整数`,
      )
  }
}
