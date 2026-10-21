// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The billing port (P35), in memory: two per-node plans, both channels and
 * redeem codes open, standings a test sets directly, orders whose payment
 * arrives through {@link FakeBilling.notify} signed over the raw body.
 * `calls` lists every port call with its subject.
 */

import { createHmac } from 'node:crypto'
import { AccountBook, type AccountRole } from '../src/accounts.js'
import type { ConsoleResult } from '../src/contracts.js'
import type { ConsoleDeps } from '../src/deps.js'
import type {
  BillingAdminView,
  BillingChainView,
  BillingChannel,
  BillingCheckoutView,
  BillingMeView,
  BillingNotifyReply,
  BillingNotifyRequest,
  BillingOrderView,
  BillingPort,
  BillingPresetView,
  BillingRefundDueView,
  BillingSiteView,
  BillingStanding,
  BillingUpstreamView,
  DirectionActor,
  HandoffDevicesPort,
} from '../src/directionPorts.js'
import { createConsoleHandler } from '../src/http.js'
import type { TenantConfig, TenantPort } from '../src/tenancy.js'
import {
  CountingChat,
  LIMITS,
  MemoryLedger,
  TOKENS,
} from './accountsHarness.js'
import { MemoryActionLedger } from './memoryActions.js'
import { PageAudit, PageRegistry } from './pageHarness.js'

export const NOTIFY_SECRET = 'fake-notify-secret'
const DAY_MS = 86_400_000
const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** The signature {@link FakeBilling.notify} checks: HMAC over the exact bytes. */
export function signNotify(rawBody: string): string {
  return createHmac('sha256', NOTIFY_SECRET).update(rawBody).digest('hex')
}

const NONE: BillingStanding = {
  active: false,
  planId: null,
  endsAt: null,
  nodes: 0,
  tenant: null,
  nodesMapped: 0,
}

const ok = <T>(value: T): ConsoleResult<T> => ({ ok: true, value })
const failed = <T>(
  code: 'not_found' | 'invalid' | 'rejected',
  message: string,
): ConsoleResult<T> => ({ ok: false, failure: { code, message } })

interface Order {
  readonly subject: string
  view: BillingOrderView
  readonly qrText: string
}

export class FakeBilling implements BillingPort {
  readonly calls: string[] = []
  /** Every notification as it arrived. */
  readonly notified: { channel: string; request: BillingNotifyRequest }[] = []
  siteView: BillingSiteView = {
    sourceUrl: 'https://github.com/sweetcornna/atlas',
    termsUrl: 'https://qianmo.example/terms',
    live: true,
    plans: [
      {
        id: 'month',
        name: '月付',
        priceCents: 9900,
        periodDays: 30,
        nodes: 1,
        note: '一个托管节点',
      },
      {
        id: 'pro',
        name: '团队',
        priceCents: 29900,
        periodDays: 30,
        nodes: 3,
        note: null,
      },
    ],
    channels: { wechatpay: true, alipay: true, redeem: true },
  }
  readonly standings = new Map<string, BillingStanding>()
  readonly orders = new Map<string, Order>()
  readonly upstreams = new Map<string, BillingUpstreamView[]>()
  readonly codesIssued: string[] = []
  /** What `admin()` lists as owed a refund; a test sets it. */
  refundsDue: readonly BillingRefundDueView[] = []
  presetList: readonly BillingPresetView[] = [
    { id: 'anthropic', name: 'Anthropic' },
    { id: 'openai', name: 'OpenAI' },
  ]
  #serial = 0

  constructor(
    private readonly now: () => number = () => 1_700_000_000_000,
    /** Every subject counts as subscribed (a console the gate never stops). */
    private readonly everyoneActive = false,
  ) {}

  /** Set a subject's standing; the defaults are an active one-node plan with a node. */
  activate(
    subject: string,
    standing: Partial<BillingStanding> = {},
  ): BillingStanding {
    const next: BillingStanding = {
      active: true,
      planId: 'month',
      endsAt: this.now() + 30 * DAY_MS,
      nodes: 1,
      tenant: `t-${subject.slice(2, 10)}`,
      nodesMapped: 1,
      ...standing,
    }
    this.standings.set(subject, next)
    return next
  }

  #standing(subject: string): BillingStanding {
    const known = this.standings.get(subject)
    if (known !== undefined) return known
    return this.everyoneActive
      ? { ...NONE, active: true, planId: 'month', nodes: 1, nodesMapped: 1 }
      : NONE
  }

  #id(): string {
    this.#serial += 1
    let tail = ''
    let n = this.#serial
    for (let i = 0; i < 22; i += 1) {
      tail = ALPHABET[n % ALPHABET.length] + tail
      n = Math.floor(n / ALPHABET.length)
    }
    return `ord_${tail}`
  }

  site(): BillingSiteView {
    return this.siteView
  }

  async standing(subject: string): Promise<BillingStanding> {
    this.calls.push(`standing ${subject}`)
    return this.#standing(subject)
  }

  async me(subject: string): Promise<ConsoleResult<BillingMeView>> {
    this.calls.push(`me ${subject}`)
    const standing = this.#standing(subject)
    const upstreams = this.upstreams.get(subject) ?? []
    return ok({
      standing,
      orders: [...this.orders.values()]
        .filter(order => order.subject === subject)
        .map(order => order.view),
      upstreams,
      gateway:
        standing.tenant === null
          ? 'none'
          : standing.active && upstreams.length > 0
            ? 'on'
            : 'off',
      mainModel: upstreams.length > 0 ? 'anthropic/claude-sonnet' : null,
      usage: {
        period: '30d',
        calls: 12,
        input: 3400,
        output: 1200,
        cacheRead: 800,
        cost: 0.42,
      },
    })
  }

  async checkout(
    subject: string,
    planId: string,
    channel: BillingChannel,
  ): Promise<ConsoleResult<BillingCheckoutView>> {
    this.calls.push(`checkout ${subject} ${planId} ${channel}`)
    const plan = this.siteView.plans.find(one => one.id === planId)
    if (plan === undefined) return failed('not_found', '套餐不存在')
    if (!this.siteView.channels[channel])
      return failed('invalid', '这个付款方式没有开通')
    for (const order of this.orders.values()) {
      if (
        order.subject === subject &&
        order.view.planId === planId &&
        order.view.channel === channel &&
        order.view.status === 'created'
      )
        return ok(this.#checkoutView(order))
    }
    const orderId = this.#id()
    const order: Order = {
      subject,
      view: {
        orderId,
        planId,
        channel,
        amountCents: plan.priceCents,
        status: 'created',
        createdAt: this.now(),
        expiresAt: this.now() + 15 * 60_000,
        paidAt: null,
      },
      qrText: `weixin://wxpay/bizpayurl?pr=${orderId.slice(4, 12)}`,
    }
    this.orders.set(orderId, order)
    return ok(this.#checkoutView(order))
  }

  #checkoutView(order: Order): BillingCheckoutView {
    return {
      orderId: order.view.orderId,
      planId: order.view.planId,
      channel: order.view.channel as BillingChannel,
      amountCents: order.view.amountCents,
      expiresAt: order.view.expiresAt,
      qrText: order.qrText,
    }
  }

  async order(
    subject: string,
    orderId: string,
  ): Promise<
    ConsoleResult<BillingOrderView & { readonly qrText: string | null }>
  > {
    this.calls.push(`order ${subject} ${orderId}`)
    const order = this.orders.get(orderId)
    if (order === undefined || order.subject !== subject)
      return failed('not_found', '订单不存在')
    return ok({
      ...order.view,
      qrText: order.view.status === 'created' ? order.qrText : null,
    })
  }

  /** Mark an order paid and open its plan, the way a verified notify does. */
  pay(orderId: string): void {
    const order = this.orders.get(orderId)
    if (order === undefined) throw new Error(`no order ${orderId}`)
    order.view = { ...order.view, status: 'paid', paidAt: this.now() }
    const plan = this.siteView.plans.find(one => one.id === order.view.planId)
    this.activate(order.subject, {
      planId: order.view.planId,
      nodes: plan?.nodes ?? 1,
      nodesMapped: 0,
    })
  }

  async redeem(
    subject: string,
    code: string,
  ): Promise<ConsoleResult<BillingStanding>> {
    this.calls.push(`redeem ${subject}`)
    const index = this.codesIssued.indexOf(code)
    if (index === -1) return failed('invalid', '兑换码无效或已用过')
    this.codesIssued.splice(index, 1)
    return ok(this.activate(subject, { nodesMapped: 0 }))
  }

  async notify(
    channel: string,
    request: BillingNotifyRequest,
  ): Promise<BillingNotifyReply> {
    this.calls.push(`notify ${channel}`)
    this.notified.push({ channel, request })
    if (request.headers.get('x-fake-signature') !== signNotify(request.rawBody))
      return { httpStatus: 401, body: 'FAIL', headers: {} }
    const orderId = /"orderId":"([^"]+)"/.exec(request.rawBody)?.[1]
    if (orderId !== undefined && this.orders.has(orderId)) this.pay(orderId)
    return channel === 'alipay'
      ? {
          httpStatus: 200,
          body: 'success',
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }
      : { httpStatus: 204, body: '', headers: {} }
  }

  async presets(): Promise<ConsoleResult<readonly BillingPresetView[]>> {
    return ok(this.presetList)
  }

  async addUpstream(
    subject: string,
    draft: { readonly preset: string; readonly key: string },
  ): Promise<ConsoleResult<BillingUpstreamView>> {
    this.calls.push(`addUpstream ${subject} ${draft.preset}`)
    if (!this.#standing(subject).active)
      return failed('rejected', '需要有效订阅')
    if (!this.presetList.some(one => one.id === draft.preset))
      return failed('invalid', '预设无效')
    const own = this.upstreams.get(subject) ?? []
    const view: BillingUpstreamView = {
      id: `${draft.preset}-${own.length + 1}`,
      name: `${subject.slice(2, 10)}-${draft.preset}`,
      preset: draft.preset,
      models: 3,
      ready: true,
      present: true,
    }
    this.upstreams.set(subject, [...own, view])
    return ok(view)
  }

  async removeUpstream(
    subject: string,
    id: string,
  ): Promise<ConsoleResult<void>> {
    this.calls.push(`removeUpstream ${subject} ${id}`)
    const own = this.upstreams.get(subject) ?? []
    if (!own.some(one => one.id === id))
      return failed('not_found', '上游不存在')
    this.upstreams.set(
      subject,
      own.filter(one => one.id !== id),
    )
    return ok(undefined)
  }

  async admin(): Promise<ConsoleResult<BillingAdminView>> {
    this.calls.push('admin')
    return ok({
      plans: this.siteView.plans,
      live: this.siteView.live,
      channels: this.siteView.channels,
      orders: [...this.orders.values()].map(order => ({
        ...order.view,
        subject: order.subject,
        outTradeNo: `qm${order.view.orderId.slice(4)}`,
        providerTxnId: order.view.status === 'paid' ? 'txn-1' : null,
      })),
      subscriptions: [...this.standings.entries()].map(
        ([subject, standing]) => ({
          subject,
          planId: standing.planId ?? 'month',
          startsAt: this.now(),
          endsAt: standing.endsAt ?? this.now(),
          active: standing.active,
          gateway: standing.active ? 'enabled' : 'disabled',
          attempts: 0,
          tenant: standing.tenant,
        }),
      ),
      codes: this.codesIssued.map((code, index) => ({
        id: `code-${index + 1}`,
        planId: 'month',
        periods: 1,
        createdBy: 'u:0000000000000000',
        createdAt: this.now(),
        expiresAt: null,
        usedBy: null,
        usedAt: null,
      })),
      refundsDue: this.refundsDue,
      chain: { ok: true, events: this.orders.size },
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
  ): Promise<ConsoleResult<BillingStanding>> {
    this.calls.push(`grant ${actor.subject} ${input.subject} ${input.planId}`)
    const plan = this.siteView.plans.find(one => one.id === input.planId)
    if (plan === undefined) return failed('not_found', '套餐不存在')
    return ok(
      this.activate(input.subject, {
        planId: plan.id,
        nodes: plan.nodes,
        endsAt: this.now() + input.periods * plan.periodDays * DAY_MS,
      }),
    )
  }

  async refund(
    actor: DirectionActor,
    input: { readonly orderId: string; readonly reason: string },
  ): Promise<ConsoleResult<BillingStanding>> {
    this.calls.push(`refund ${actor.subject} ${input.orderId}`)
    const order = this.orders.get(input.orderId)
    if (order === undefined) return failed('not_found', '订单不存在')
    if (order.view.status !== 'paid') return failed('rejected', '订单没有付款')
    order.view = { ...order.view, status: 'refunded' }
    const standing = { ...this.#standing(order.subject), active: false }
    this.standings.set(order.subject, standing)
    return ok(standing)
  }

  async codes(
    actor: DirectionActor,
    input: {
      readonly planId: string
      readonly periods: number
      readonly count: number
      readonly expiresAt?: number
    },
  ): Promise<ConsoleResult<{ readonly codes: readonly string[] }>> {
    this.calls.push(`codes ${actor.subject} ${input.planId} ${input.count}`)
    if (!this.siteView.plans.some(one => one.id === input.planId))
      return failed('not_found', '套餐不存在')
    const codes: string[] = []
    for (let i = 0; i < input.count; i += 1) {
      this.#serial += 1
      codes.push(`QM-${String(this.#serial).padStart(4, '0')}-CODE`)
    }
    this.codesIssued.push(...codes)
    return ok({ codes })
  }

  async verify(): Promise<ConsoleResult<BillingChainView>> {
    this.calls.push('verify')
    return ok({ ok: true, events: this.orders.size })
  }
}

/** One person of the public console, with the bearer they sign in with. */
export interface PublicPerson {
  readonly subject: string
  readonly credential: string
}

/**
 * A public-edition console: accounts with open registration, a tenancy whose
 * one tenant `t-paid` owns `tokyo-1`, the billing fake and an action ledger.
 *
 * | Person | Standing |
 * | --- | --- |
 * | `unpaid` | never subscribed |
 * | `expired` | subscribed once, ended |
 * | `waiting` | active, its tenant has no node yet |
 * | `paid` | active, `t-paid` with `tokyo-1` |
 * | `platform` | ops and a platform subject |
 * | `ops` | ops, not a platform subject |
 *
 * With `devices`, each person also has a paired handoff device
 * ({@link deviceOf}) that acts for them.
 */
export function publicConsole(
  options: {
    readonly tenancy?: boolean
    readonly breakGlass?: boolean
    readonly devices?: boolean
  } = {},
) {
  const now = 1_700_000_000_000
  const billing = new FakeBilling(() => now)
  const book = new AccountBook({
    accounts: new MemoryLedger(),
    sessions: new MemoryLedger('memory://sessions.ndjson'),
  })
  const person = (role: AccountRole): PublicPerson => {
    const issued = book.issueInvite({ role, issuedBy: 'legacy:admin' })
    if (!issued.ok) throw new Error('issue')
    const accepted = book.acceptInvite(issued.value.token)
    if (!accepted.ok) throw new Error('accept')
    return accepted.value
  }
  const unpaid = person('member')
  const expired = person('member')
  const waiting = person('member')
  const paid = person('member')
  const platform = person('ops')
  const ops = person('ops')
  billing.standings.set(expired.subject, {
    active: false,
    planId: 'month',
    endsAt: now - 1,
    nodes: 0,
    tenant: 't-expired',
    nodesMapped: 0,
  })
  billing.activate(waiting.subject, { tenant: 't-waiting', nodesMapped: 0 })
  billing.activate(paid.subject, { tenant: 't-paid', nodesMapped: 1 })
  let config: TenantConfig = {
    version: 1,
    hubServer: 'hub',
    tenants: [{ id: 't-paid' }, { id: 't-waiting' }],
    subjects: [
      { subject: paid.subject, tenant: 't-paid' },
      { subject: waiting.subject, tenant: 't-waiting' },
    ],
    nodes: [
      {
        nodeId: 'tokyo-1',
        tenant: 't-paid',
        server: 'sa',
        memoryRoot: '/data/t-paid',
      },
    ],
    jobs: [],
    platformSubjects: [platform.subject],
  }
  let revision = 1
  const tenancy: TenantPort = {
    read: () => ({ config, revision: String(revision) }),
    subscribe: () => () => {},
  }
  const deviceOf = (who: PublicPerson): string => `qmd_${who.subject.slice(2)}`
  const owners = new Map(
    [unpaid, expired, waiting, paid, platform, ops].map(
      who => [deviceOf(who), who.subject] as const,
    ),
  )
  const handoffDevices: HandoffDevicesPort = {
    authenticate: token => {
      const owner = owners.get(token)
      return owner === undefined
        ? null
        : { deviceId: `d-${owner.slice(2, 14)}`, owner, kind: 'handoff' }
    },
    listDevices: async () => ({ ok: true, value: [] }),
    issuePairing: async () => ({
      ok: false,
      failure: { code: 'rejected', message: '测试里不配对' },
    }),
    revokeDevice: async () => ({
      ok: false,
      failure: { code: 'not_found', message: '没有这个设备' },
    }),
  }
  const actions = new MemoryActionLedger()
  const chat = new CountingChat()
  const deps: ConsoleDeps = {
    registry: new PageRegistry(),
    audit: new PageAudit(),
    limits: LIMITS,
    now: () => now,
    label: 'public-test',
    chat,
    actions,
    billing,
    ...(options.tenancy === false ? {} : { tenancy }),
    ...(options.devices === true ? { handoffDevices } : {}),
  }
  const handle = createConsoleHandler(deps, TOKENS, {
    book,
    signup: { maxAccounts: 50, attemptsPerHour: 5 },
    ...(options.breakGlass === true ? { breakGlass: true } : {}),
  })
  return {
    now,
    billing,
    book,
    actions,
    chat,
    handle,
    unpaid,
    expired,
    waiting,
    paid,
    platform,
    ops,
    /** The bearer of the handoff device paired to `who` (with `devices`). */
    deviceOf,
    /** A new tenant revision, the way a provisioner's write makes one. */
    bump(): void {
      config = { ...config }
      revision += 1
    },
  }
}
