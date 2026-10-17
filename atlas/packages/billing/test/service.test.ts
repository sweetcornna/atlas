// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BillingError,
  BillingService,
  BillingStore,
  createPaymentChannels,
  type GatewayProvisioner,
  parseBillingConfig,
} from '../src/index.js'
import {
  alipayNotify,
  configJson,
  fakeProvisioner,
  makeKeys,
  startAlipayFake,
  startWechatFake,
  tempDir,
  wechatNotify,
  writeSecrets,
} from './fixtures.js'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 9, 16, 4, 0, 0)
const keys = makeKeys()
let now = T0
const clock = () => now
const wx = startWechatFake(keys, clock)
const ali = startAlipayFake(keys)
afterAll(() => {
  wx.stop()
  ali.stop()
})

function setup(
  options: {
    redeem?: boolean
    provisioner?: GatewayProvisioner
    notifyBudgetMs?: number
  } = {},
) {
  now = T0
  const dir = tempDir()
  const json = configJson(writeSecrets(dir, keys), {
    wechat: wx.origin,
    alipay: ali.endpoint,
  })
  if (options.redeem === false)
    (json['channels'] as Record<string, unknown>)['redeem'] = { enabled: false }
  const config = parseBillingConfig(json)
  const path = join(dir, 'billing.sqlite')
  const store = new BillingStore(path)
  const prov = fakeProvisioner()
  const logs: string[] = []
  const service = new BillingService({
    config,
    store,
    channels: createPaymentChannels(config, { now: clock }),
    provisioner: options.provisioner ?? prov,
    clock,
    log: line => logs.push(line),
    ...(options.notifyBudgetMs === undefined
      ? {}
      : { notifyBudgetMs: options.notifyBudgetMs }),
  })
  return { service, store, prov, logs, path }
}

function kinds(store: BillingStore): string[] {
  return store.events().map(event => event.kind)
}

async function caught(promise: Promise<unknown>): Promise<BillingError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(BillingError)
  return error as BillingError
}

describe('orders and notifications', () => {
  test('WeChat Pay lifecycle: create, reuse, notify, provision', async () => {
    const { service, store, prov } = setup()
    const order = await service.createOrder('alice', 'month', 'wechatpay')
    expect(order.outTradeNo).toMatch(/^[A-Za-z0-9]{32}$/)
    expect(order.orderId).toMatch(/^ord_[A-Za-z0-9]{22}$/)
    expect(order.qrText).toStartWith('weixin://')
    expect(order.amountCents).toBe(9900)
    expect(order.expiresAt).toBe(T0 + 15 * 60_000)
    now += 60_000
    // Same subject + plan + channel while open → the same order.
    expect(await service.createOrder('alice', 'month', 'wechatpay')).toEqual(
      order,
    )
    expect(
      (await service.createOrder('alice', 'month', 'alipay')).orderId,
    ).not.toBe(order.orderId)
    expect(service.entitlement('alice')).toEqual({
      active: false,
      planId: null,
      endsAt: null,
    })

    wx.pay(order.outTradeNo)
    const reply = await service.handleNotify(
      'wechatpay',
      wechatNotify(keys, now, { outTradeNo: order.outTradeNo, total: 9900 }),
    )
    expect(reply).toEqual({ httpStatus: 204, body: '', headers: {} })
    expect(service.entitlement('alice')).toEqual({
      active: true,
      planId: 'month',
      endsAt: now + 30 * DAY,
    })
    expect(prov.calls).toEqual(['ensure alice', 'enable alice'])
    expect(prov.state.get('alice')).toEqual({
      enabled: true,
      plan: 'month',
      nodes: 1,
      limits: 1,
    })
    expect(store.subscription('alice')?.gateway).toBe('enabled')
    const view = await service.pollOrder(order.orderId)
    expect(view.status).toBe('paid')
    expect(view.providerTxnId).toBe('4200000001202610160000000001')
    expect(store.verifyChain().ok).toBe(true)
  })

  test('a second notification is a no-op success', async () => {
    const { service, store, prov } = setup()
    const order = await service.createOrder('alice', 'month', 'wechatpay')
    const notify = () =>
      service.handleNotify(
        'wechatpay',
        wechatNotify(keys, now, { outTradeNo: order.outTradeNo, total: 9900 }),
      )
    expect((await notify()).httpStatus).toBe(204)
    const endsAt = service.entitlement('alice').endsAt
    const events = store.events().length
    now += 30_000
    expect((await notify()).httpStatus).toBe(204)
    expect(service.entitlement('alice').endsAt).toBe(endsAt)
    expect(store.events().length).toBe(events)
    expect(prov.calls).toEqual(['ensure alice', 'enable alice'])
  })

  test('amount, merchant, currency and unknown-order mismatches are logged and rejected', async () => {
    const { service, store } = setup()
    const order = await service.createOrder('alice', 'month', 'wechatpay')
    const send = (patch: Record<string, unknown>) =>
      service.handleNotify(
        'wechatpay',
        wechatNotify(keys, now, {
          outTradeNo: order.outTradeNo,
          total: 9900,
          ...patch,
        }),
      )
    expect((await send({ total: 1 })).httpStatus).toBe(400)
    expect((await send({ appid: 'wx0000000000000000' })).httpStatus).toBe(400)
    expect((await send({ mchid: '1900000000' })).httpStatus).toBe(400)
    expect((await send({ currency: 'USD' })).httpStatus).toBe(400)
    expect((await send({ outTradeNo: 'Z'.repeat(32) })).httpStatus).toBe(400)
    const mismatches = store
      .events()
      .filter(event => event.kind === 'notify.mismatch')
      .map(event => event.data['field'])
    expect(mismatches).toEqual([
      'amount',
      'merchant',
      'merchant',
      'currency',
      'outTradeNo',
    ])
    expect(store.order(order.orderId)?.status).toBe('created')
    expect(service.entitlement('alice').active).toBe(false)
    // The genuine notification still settles afterwards.
    expect((await send({})).httpStatus).toBe(204)
    expect(service.entitlement('alice').active).toBe(true)
    expect(store.verifyChain().ok).toBe(true)
  })

  test('an Alipay notification for a WeChat order is a channel mismatch', async () => {
    const { service, store } = setup()
    const order = await service.createOrder('alice', 'month', 'wechatpay')
    const reply = await service.handleNotify('alipay', {
      headers: {},
      ...alipayNotify(keys, {
        outTradeNo: order.outTradeNo,
        totalAmount: '99.00',
      }),
    })
    expect(reply).toMatchObject({ httpStatus: 400, body: 'fail' })
    expect(store.events().at(-1)?.data['field']).toBe('channel')
  })

  test('unauthenticated garbage is rejected without touching the ledger', async () => {
    const { service, store, logs } = setup()
    const order = await service.createOrder('alice', 'month', 'wechatpay')
    const events = store.events().length
    const stale = wechatNotify(keys, now - 6 * 60_000, {
      outTradeNo: order.outTradeNo,
      total: 9900,
    })
    expect((await service.handleNotify('wechatpay', stale)).httpStatus).toBe(
      400,
    )
    const replayed = wechatNotify(keys, now, {
      outTradeNo: order.outTradeNo,
      total: 9900,
    })
    now += 10 * 60_000
    expect((await service.handleNotify('wechatpay', replayed)).httpStatus).toBe(
      400,
    )
    expect(
      (
        await service.handleNotify('wechatpay', {
          headers: {},
          rawBody: '{"not":"signed"}',
        })
      ).httpStatus,
    ).toBe(400)
    expect(
      (
        await service.handleNotify('alipay', {
          headers: {},
          rawBody: 'out_trade_no=x&trade_status=TRADE_SUCCESS',
          contentType: 'application/x-www-form-urlencoded',
        })
      ).body,
    ).toBe('fail')
    expect(store.events().length).toBe(events)
    expect(logs.some(line => line.includes('时间戳超出 5 分钟'))).toBe(true)
    expect(service.entitlement('alice').active).toBe(false)
  })

  test('a notification for an unconfigured channel is 404', async () => {
    const { store } = setup()
    const config = parseBillingConfig({
      ...configJson(writeSecrets(tempDir(), keys)),
      channels: { redeem: { enabled: true } },
    })
    const service = new BillingService({
      config,
      store,
      channels: {},
      provisioner: fakeProvisioner(),
      clock,
    })
    expect(
      (await service.handleNotify('wechatpay', { headers: {}, rawBody: '' }))
        .httpStatus,
    ).toBe(404)
    expect(
      (await caught(service.createOrder('alice', 'month', 'alipay'))).code,
    ).toBe('channel_unavailable')
  })

  test('Alipay lifecycle with checkout polling and a rate-limited query', async () => {
    const { service, store } = setup()
    const order = await service.createOrder('bob', 'pro', 'alipay')
    expect(order.qrText).toStartWith('https://qr.alipay.com/')
    const queries = () =>
      ali.requests.filter(r => r.method === 'alipay.trade.query').length
    const before = queries()
    expect((await service.pollOrder(order.orderId)).status).toBe('created')
    expect(queries()).toBe(before + 1)
    ali.scan(order.outTradeNo, 'TRADE_SUCCESS')
    now += 2_000
    // Within 5 s of the last query the provider is not asked again.
    expect((await service.pollOrder(order.orderId)).status).toBe('created')
    expect(queries()).toBe(before + 1)
    now += 5_000
    const view = await service.pollOrder(order.orderId)
    expect(view.status).toBe('paid')
    expect(
      store.events().find(e => e.kind === 'order.paid')?.data['source'],
    ).toBe('query')
    // The notification that follows is a duplicate.
    const reply = await service.handleNotify('alipay', {
      headers: {},
      ...alipayNotify(keys, {
        outTradeNo: order.outTradeNo,
        totalAmount: '299.00',
      }),
    })
    expect(reply).toMatchObject({ httpStatus: 200, body: 'success' })
    expect(service.entitlement('bob')).toEqual({
      active: true,
      planId: 'pro',
      endsAt: now + 30 * DAY,
    })
  })

  test('a provider failure at create closes the order and says nothing secret', async () => {
    const { service, store, logs } = setup()
    wx.control.failCreate = true
    try {
      const error = await caught(
        service.createOrder('alice', 'month', 'wechatpay'),
      )
      expect(error.code).toBe('provider_error')
    } finally {
      wx.control.failCreate = false
    }
    const [row] = store.recentOrders(1)
    expect(row?.status).toBe('closed')
    expect(logs.at(-1)).toContain('wechatpay:SYSTEM_ERROR')
    // The next attempt makes a fresh order.
    const order = await service.createOrder('alice', 'month', 'wechatpay')
    expect(order.orderId).not.toBe(row?.id)
  })

  test('input validation', async () => {
    const { service } = setup()
    expect(
      (await caught(service.createOrder('', 'month', 'wechatpay'))).code,
    ).toBe('invalid_argument')
    expect(
      (await caught(service.createOrder('a\nb', 'month', 'wechatpay'))).code,
    ).toBe('invalid_argument')
    expect(
      (await caught(service.createOrder('alice', 'nope', 'wechatpay'))).code,
    ).toBe('unknown_plan')
    expect((await caught(service.pollOrder('ord_missing'))).code).toBe(
      'unknown_order',
    )
  })
})

describe('per-node plans', () => {
  test('plans carry their node count; the provisioner gets nodes and limits, never a price', async () => {
    const seen: unknown[] = []
    const prov = fakeProvisioner()
    const { service } = setup({
      provisioner: {
        async ensure(subject, plan) {
          seen.push(plan)
          return prov.ensure(subject, plan)
        },
        setEnabled: (subject, enabled) => prov.setEnabled(subject, enabled),
      },
    })
    expect(service.plans().map(plan => [plan.id, plan.nodes])).toEqual([
      ['month', 1],
      ['pro', 3],
    ])
    await service.grant('u:ops', 'alice', 'pro', 1, '内测')
    expect(seen).toEqual([
      {
        id: 'pro',
        nodes: 3,
        gatewayLimits: [
          { period: 'days', days: 7, tokens: 50_000_000, cacheReads: true },
          { period: 'hours', hours: 5, costUsd: 10 },
        ],
      },
    ])
  })

  test("a subscriber's orders, newest first, and nobody else's", async () => {
    const { service } = setup()
    const first = await service.createOrder('alice', 'month', 'wechatpay')
    now += 1000
    const second = await service.createOrder('alice', 'month', 'alipay')
    await service.createOrder('bob', 'month', 'wechatpay')
    expect(service.orders('alice').map(order => order.orderId)).toEqual([
      second.orderId,
      first.orderId,
    ])
    expect(service.orders('carol')).toEqual([])
  })
})

describe('subscription periods', () => {
  test('renewals extend from max(now, endsAt)', async () => {
    const { service, store } = setup()
    await service.grant('ops', 'alice', 'month', 1, '首月')
    expect(service.entitlement('alice').endsAt).toBe(T0 + 30 * DAY)
    // Renew with 10 days left: the new period starts at the old end.
    now = T0 + 20 * DAY
    const order = await service.createOrder('alice', 'month', 'wechatpay')
    await service.handleNotify(
      'wechatpay',
      wechatNotify(keys, now, { outTradeNo: order.outTradeNo, total: 9900 }),
    )
    expect(service.entitlement('alice').endsAt).toBe(T0 + 60 * DAY)
    expect(store.subscription('alice')?.startsAt).toBe(T0)
    // Lapse, then renew: the new period starts now.
    now = T0 + 70 * DAY
    expect(service.entitlement('alice').active).toBe(false)
    await service.grant('ops', 'alice', 'month', 2, '回归')
    expect(service.entitlement('alice').endsAt).toBe(now + 60 * DAY)
    expect(store.subscription('alice')?.startsAt).toBe(now)
  })

  test('one plan at a time; an operator grant may switch', async () => {
    const { service } = setup()
    await service.grant('ops', 'alice', 'month', 1, '试用')
    expect(
      (await caught(service.createOrder('alice', 'pro', 'wechatpay'))).code,
    ).toBe('plan_conflict')
    const [code] = service.issueRedeemCodes('ops', 'pro', 1, 1)
    expect((await caught(service.redeem('alice', code!))).code).toBe(
      'plan_conflict',
    )
    const switched = await service.grant('ops', 'alice', 'pro', 1, '升级')
    expect(switched).toEqual({
      active: true,
      planId: 'pro',
      endsAt: T0 + 60 * DAY,
    })
  })

  test('a refund takes the order period back and switches the gateway off', async () => {
    const { service, store, prov } = setup()
    const order = await service.createOrder('alice', 'month', 'wechatpay')
    await service.handleNotify(
      'wechatpay',
      wechatNotify(keys, now, { outTradeNo: order.outTradeNo, total: 9900 }),
    )
    now += DAY
    const after = await service.markRefunded(
      'ops',
      order.orderId,
      '用户申请退款',
    )
    expect(after).toEqual({ active: false, planId: 'month', endsAt: T0 })
    expect(store.order(order.orderId)?.status).toBe('refunded')
    expect(prov.calls.at(-1)).toBe('disable alice')
    expect(store.subscription('alice')?.gateway).toBe('disabled')
    expect(
      (await caught(service.markRefunded('ops', order.orderId, '再退一次')))
        .code,
    ).toBe('not_paid')
    expect(
      (await caught(service.markRefunded('ops', order.orderId, ''))).code,
    ).toBe('invalid_argument')
    // A late duplicate notification for a refunded order changes nothing.
    const reply = await service.handleNotify(
      'wechatpay',
      wechatNotify(keys, now, { outTradeNo: order.outTradeNo, total: 9900 }),
    )
    expect(reply.httpStatus).toBe(204)
    expect(service.entitlement('alice').active).toBe(false)
    expect(store.verifyChain().ok).toBe(true)
  })
})

describe('provisioning and sweep', () => {
  test('a provisioning failure never loses the payment; sweep retries', async () => {
    const { service, store, prov, logs } = setup()
    prov.control.failEnsure = true
    const order = await service.createOrder('alice', 'month', 'wechatpay')
    const reply = await service.handleNotify(
      'wechatpay',
      wechatNotify(keys, now, { outTradeNo: order.outTradeNo, total: 9900 }),
    )
    expect(reply.httpStatus).toBe(204)
    expect(store.order(order.orderId)?.status).toBe('paid')
    expect(service.entitlement('alice').active).toBe(true)
    expect(store.subscription('alice')).toMatchObject({
      gateway: 'pending',
      attempts: 1,
    })
    await service.sweep()
    expect(store.subscription('alice')?.attempts).toBe(2)
    expect(kinds(store).filter(k => k === 'gateway.failed')).toHaveLength(1)
    expect(logs.join('\n')).not.toContain('sk-live')
    prov.control.failEnsure = false
    expect(await service.sweep()).toEqual({
      disabled: 0,
      provisioned: 1,
      closed: 0,
    })
    expect(store.subscription('alice')).toMatchObject({
      gateway: 'enabled',
      binding: 'key-alice',
      attempts: 0,
    })
    // Idempotent: nothing left to do.
    const calls = prov.calls.length
    expect(await service.sweep()).toEqual({
      disabled: 0,
      provisioned: 0,
      closed: 0,
    })
    expect(prov.calls.length).toBe(calls)
  })

  test('the notify reply does not wait past its budget', async () => {
    let release = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const prov = fakeProvisioner()
    const slow: GatewayProvisioner = {
      async ensure(subject, plan) {
        await gate
        return prov.ensure(subject, plan)
      },
      setEnabled: (subject, enabled) => prov.setEnabled(subject, enabled),
    }
    const { service, store } = setup({ provisioner: slow, notifyBudgetMs: 20 })
    const order = await service.createOrder('alice', 'month', 'wechatpay')
    const reply = await service.handleNotify(
      'wechatpay',
      wechatNotify(keys, now, { outTradeNo: order.outTradeNo, total: 9900 }),
    )
    expect(reply.httpStatus).toBe(204)
    expect(store.subscription('alice')?.gateway).toBe('pending')
    release()
    await Bun.sleep(10)
    expect(store.subscription('alice')?.gateway).toBe('enabled')
  })

  test('sweep switches off ended subscriptions once, retrying failures', async () => {
    const { service, store, prov } = setup()
    await service.grant('ops', 'alice', 'month', 1, '试用')
    now = T0 + 30 * DAY
    prov.control.failDisable = true
    expect((await service.sweep()).disabled).toBe(0)
    expect(store.subscription('alice')?.gateway).toBe('enabled')
    prov.control.failDisable = false
    expect((await service.sweep()).disabled).toBe(1)
    expect(prov.state.get('alice')?.enabled).toBe(false)
    expect(kinds(store).filter(k => k === 'subscription.expired')).toHaveLength(
      1,
    )
    const calls = prov.calls.length
    expect((await service.sweep()).disabled).toBe(0)
    expect(prov.calls.length).toBe(calls)
    // Coming back re-enables.
    await service.grant('ops', 'alice', 'month', 1, '回归')
    expect(prov.state.get('alice')?.enabled).toBe(true)
  })

  test('expired orders are queried, closed and expired; a late payment still counts', async () => {
    const { service, store } = setup()
    const unpaid = await service.createOrder('alice', 'month', 'wechatpay')
    const paidSilently = await service.createOrder('bob', 'month', 'wechatpay')
    const scanned = await service.createOrder('carol', 'month', 'alipay')
    wx.pay(paidSilently.outTradeNo)
    now = T0 + 16 * 60_000
    const report = await service.sweep()
    expect(report.closed).toBe(2)
    expect(store.order(unpaid.orderId)?.status).toBe('expired')
    expect(wx.trades.get(unpaid.outTradeNo)?.state).toBe('CLOSED')
    // Paid at the provider but the notification never came: settled, not closed.
    expect(store.order(paidSilently.orderId)?.status).toBe('paid')
    expect(service.entitlement('bob').active).toBe(true)
    // A never-scanned Alipay QR has nothing to close there.
    expect(store.order(scanned.orderId)?.status).toBe('expired')
    // Idempotent.
    expect((await service.sweep()).closed).toBe(0)

    // The user paid in the last second; the notification arrives after expiry.
    const reply = await service.handleNotify(
      'wechatpay',
      wechatNotify(keys, now, { outTradeNo: unpaid.outTradeNo, total: 9900 }),
    )
    expect(reply.httpStatus).toBe(204)
    expect(store.order(unpaid.orderId)?.status).toBe('paid')
    const paid = store.events().filter(e => e.kind === 'order.paid')
    expect(paid.at(-1)?.data['late']).toBe(true)
    expect(service.entitlement('alice').active).toBe(true)
    expect(store.verifyChain().ok).toBe(true)
  })
})

test('a query that contradicts the order is recorded once and closes it', async () => {
  const { service, store } = setup()
  const order = await service.createOrder('alice', 'month', 'wechatpay')
  wx.pay(order.outTradeNo)
  wx.trades.get(order.outTradeNo)!.total = 1
  now = T0 + 16 * 60_000
  await service.sweep()
  expect(store.order(order.orderId)?.status).toBe('closed')
  const mismatch = store.events().filter(e => e.kind === 'notify.mismatch')
  expect(mismatch.map(e => [e.data['field'], e.data['source']])).toEqual([
    ['amount', 'query'],
  ])
  const queries = wx.requests.length
  await service.sweep()
  await service.pollOrder(order.orderId)
  expect(wx.requests.length).toBe(queries)
  expect(store.events().filter(e => e.kind === 'notify.mismatch')).toHaveLength(
    1,
  )
  expect(service.entitlement('alice').active).toBe(false)
})

describe('redeem codes', () => {
  test('single use, hash-only storage, shown once', async () => {
    const { service, store, path } = setup()
    const codes = service.issueRedeemCodes('ops', 'month', 2, 3, T0 + 90 * DAY)
    expect(codes).toHaveLength(3)
    for (const code of codes)
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/)
    expect(new Set(codes).size).toBe(3)

    const entitlement = await service.redeem('alice', codes[0]!)
    expect(entitlement).toEqual({
      active: true,
      planId: 'month',
      endsAt: T0 + 60 * DAY,
    })
    expect((await caught(service.redeem('bob', codes[0]!))).code).toBe(
      'invalid_code',
    )
    // Lower case, no hyphens, O for 0 and l for 1 all normalise.
    const loose = codes[1]!
      .replaceAll('-', '')
      .toLowerCase()
      .replaceAll('0', 'o')
      .replaceAll('1', 'l')
    expect((await service.redeem('bob', loose)).active).toBe(true)
    expect((await caught(service.redeem('carol', 'not-a-code'))).code).toBe(
      'invalid_code',
    )
    now = T0 + 91 * DAY
    expect((await caught(service.redeem('carol', codes[2]!))).code).toBe(
      'invalid_code',
    )

    const snapshot = JSON.stringify(service.adminSnapshot())
    store.close()
    const bytes = [path, `${path}-wal`]
      .filter(file => existsSync(file))
      .map(file => readFileSync(file).toString('latin1'))
      .join('')
    for (const code of codes) {
      const plain = code.replaceAll('-', '')
      expect(bytes).not.toContain(plain)
      expect(bytes).not.toContain(code)
      expect(snapshot).not.toContain(plain)
    }
    expect(snapshot).not.toMatch(/"hash"/)
    expect(snapshot).toContain('"usedBy":"alice"')
  })

  test('issuing validates its arguments; a disabled channel refuses', async () => {
    const { service } = setup({ redeem: false })
    expect(() => service.issueRedeemCodes('ops', 'month', 0, 1)).toThrow(
      BillingError,
    )
    expect(() => service.issueRedeemCodes('ops', 'month', 1, 1001)).toThrow(
      /数量/,
    )
    expect(() => service.issueRedeemCodes('ops', 'month', 1, 1, T0)).toThrow(
      /过期时间/,
    )
    expect(() => service.issueRedeemCodes('', 'month', 1, 1)).toThrow(/操作人/)
    const [code] = service.issueRedeemCodes('ops', 'month', 1, 1)
    expect((await caught(service.redeem('alice', code!))).code).toBe(
      'channel_unavailable',
    )
  })
})

test('secrets never reach errors, logs, events or snapshots', async () => {
  const { service, store, prov, logs, path } = setup()
  const errors: string[] = []
  const keep = async (work: Promise<unknown>) => {
    try {
      await work
    } catch (error) {
      errors.push(String(error), JSON.stringify(error))
    }
  }
  prov.control.failEnsure = true
  wx.control.failCreate = true
  await keep(service.createOrder('alice', 'month', 'wechatpay'))
  wx.control.failCreate = false
  wx.control.badResponseSignature = true
  await keep(service.createOrder('alice', 'month', 'wechatpay'))
  wx.control.badResponseSignature = false
  const order = await service.createOrder('alice', 'month', 'wechatpay')
  await service.handleNotify(
    'wechatpay',
    wechatNotify(keys, now, { outTradeNo: order.outTradeNo, total: 1 }),
  )
  await service.handleNotify(
    'wechatpay',
    wechatNotify(keys, now, { outTradeNo: order.outTradeNo, total: 9900 }),
  )
  await keep(service.redeem('alice', 'AAAAA-AAAAA'))
  await keep(service.markRefunded('ops', 'ord_x', 'r'))
  service.issueRedeemCodes('ops', 'month', 1, 2)
  await service.sweep()

  const haystack = [
    ...errors,
    ...logs,
    JSON.stringify(store.events()),
    JSON.stringify(service.adminSnapshot()),
    [path, `${path}-wal`]
      .filter(file => existsSync(file))
      .map(file => readFileSync(file).toString('latin1'))
      .join(''),
  ].join('\n')
  const secretBits = [
    keys.apiV3Key,
    'PRIVATE KEY',
    'sk-live-SHOULD-NOT-LEAK',
    ...[keys.merchant, keys.app].flatMap(pair =>
      pair.privatePem
        .split('\n')
        .filter(line => line.length === 64)
        .slice(2, 6),
    ),
    keys.app.privateKey
      .export({ type: 'pkcs1', format: 'der' })
      .toString('base64')
      .slice(100, 160),
  ]
  for (const bit of secretBits) expect(haystack).not.toContain(bit)
  expect(errors.length).toBeGreaterThan(0)
  expect(logs.length).toBeGreaterThan(0)
})
