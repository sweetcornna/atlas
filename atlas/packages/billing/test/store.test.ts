// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { BillingStore, type OrderRow } from '../src/index.js'
import { tempDir } from './fixtures.js'

const T0 = Date.UTC(2026, 9, 16, 4, 0, 0)
const DAY = 86_400_000

function order(id: string, patch: Partial<OrderRow> = {}): OrderRow {
  return {
    id,
    subject: 'alice',
    planId: 'month',
    amountCents: 9900,
    periodDays: 30,
    channel: 'wechatpay',
    status: 'created',
    outTradeNo: `${id.padEnd(32, 'x')}`.slice(0, 32),
    providerTxnId: null,
    qrText: null,
    createdAt: T0,
    expiresAt: T0 + 15 * 60_000,
    paidAt: null,
    ...patch,
  }
}

/** A store with a little of everything in it. */
function populated() {
  const path = join(tempDir(), 'state', 'billing.sqlite')
  const store = new BillingStore(path)
  store.insertOrder(order('o1'), T0)
  store.setOrderQr('o1', 'weixin://wxpay/bizpayurl/up?pr=abc', T0)
  store.markOrderPaid(
    'o1',
    { providerTxnId: 'tx1', source: 'notify', late: false },
    T0 + 1000,
  )
  store.saveSubscription(
    { subject: 'alice', planId: 'month', startsAt: T0, endsAt: T0 + 30 * DAY },
    { cause: 'order', ref: 'o1' },
    T0 + 1000,
  )
  store.gatewayEnabled('alice', 1, 'key-alice', T0 + 2000)
  store.insertRedeemCode(
    {
      hash: 'a'.repeat(64),
      id: 'rc_1',
      planId: 'month',
      periods: 2,
      createdBy: 'ops',
      createdAt: T0,
      expiresAt: null,
      usedBy: null,
      usedAt: null,
    },
    T0,
  )
  store.markRedeemCodeUsed('a'.repeat(64), 'bob', T0 + 3000)
  store.insertOrder(order('o2', { subject: 'bob' }), T0)
  store.closeOrder('o2', 'expired', 'ttl', T0 + 16 * 60_000)
  return { path, store }
}

describe('BillingStore', () => {
  test('creates a private WAL database and a parent directory', () => {
    const { path, store } = populated()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
    // SQLite gives the WAL side files the database file's mode.
    expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600)
    expect(statSync(`${path}-shm`).mode & 0o777).toBe(0o600)
    const raw = new Database(path, { readonly: true })
    expect(
      raw.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()
        ?.journal_mode,
    ).toBe('wal')
    raw.close()
    store.close()
  })

  test('every state change is one chained event', () => {
    const { store } = populated()
    expect(store.events().map(event => event.kind)).toEqual([
      'order.created',
      'order.qr',
      'order.paid',
      'subscription.changed',
      'gateway.enabled',
      'redeem.issued',
      'redeem.used',
      'order.created',
      'order.expired',
    ])
    const events = store.events()
    expect(events[0]!.prev).toBe('0'.repeat(64))
    for (let i = 1; i < events.length; i++)
      expect(events[i]!.prev).toBe(events[i - 1]!.hash)
    expect(store.verifyChain()).toEqual({ ok: true, events: 9 })
    store.close()
  })

  test('transitions are guarded: paid twice, close after paid, reuse a code', () => {
    const { store } = populated()
    expect(
      store.markOrderPaid(
        'o1',
        { providerTxnId: 'tx1', source: 'notify', late: false },
        T0,
      ),
    ).toBe(false)
    expect(store.closeOrder('o1', 'closed', 'manual', T0)).toBe(false)
    expect(store.markRedeemCodeUsed('a'.repeat(64), 'carol', T0)).toBe(false)
    expect(store.markOrderRefunded('o2', 'ops', 'x', T0)).toBe(false)
    expect(store.markOrderRefunded('o1', 'ops', '客户申请', T0)).toBe(true)
    expect(store.order('o1')?.status).toBe('refunded')
    expect(store.verifyChain().ok).toBe(true)
    store.close()
  })

  test('outTradeNo is unique', () => {
    const { store } = populated()
    expect(() =>
      store.insertOrder(
        order('o3', { outTradeNo: store.order('o1')!.outTradeNo }),
        T0,
      ),
    ).toThrow()
    // The failed insert left no event behind.
    expect(store.verifyChain()).toEqual({ ok: true, events: 9 })
    store.close()
  })

  test('triggers refuse UPDATE and DELETE on events', () => {
    const { path, store } = populated()
    store.close()
    const raw = new Database(path)
    expect(() =>
      raw.exec("UPDATE events SET kind = 'x' WHERE seq = 1"),
    ).toThrow(/append-only/)
    expect(() => raw.exec('DELETE FROM events WHERE seq = 1')).toThrow(
      /append-only/,
    )
    raw.close()
  })

  describe('tamper detection', () => {
    function tamper(sql: string) {
      const { path, store } = populated()
      store.close()
      const raw = new Database(path)
      raw.exec('DROP TRIGGER events_no_update; DROP TRIGGER events_no_delete;')
      raw.exec(sql)
      raw.close()
      const reopened = new BillingStore(path)
      const report = reopened.verifyChain()
      reopened.close()
      return report
    }

    test('an edited event payload breaks the hash', () => {
      expect(
        tamper(
          `UPDATE events SET data = replace(data, '9900', '1') WHERE seq = 1`,
        ),
      ).toEqual({ ok: false, seq: 1, reason: '哈希不符' })
    })

    test('a deleted event breaks the sequence', () => {
      expect(tamper('DELETE FROM events WHERE seq = 3')).toEqual({
        ok: false,
        seq: 4,
        reason: 'seq 不连续',
      })
    })

    test('a re-hashed edit still breaks the link to the next event', () => {
      const report = tamper(
        `UPDATE events SET hash = '${'f'.repeat(64)}' WHERE seq = 2`,
      )
      expect(report.ok).toBe(false)
      if (!report.ok) expect(report.seq).toBe(2)
    })

    test('a direct edit of the subscription table is caught by the fold', () => {
      expect(
        tamper(
          `UPDATE subscriptions SET endsAt = endsAt + ${365 * DAY} WHERE subject = 'alice'`,
        ),
      ).toEqual({ ok: false, seq: 0, reason: '订阅表与事件不符：alice' })
    })

    test('a direct edit of an order status or amount is caught', () => {
      expect(
        tamper(`UPDATE orders SET status = 'paid' WHERE id = 'o2'`),
      ).toEqual({ ok: false, seq: 0, reason: '订单表与事件不符：o2' })
      expect(
        tamper(`UPDATE orders SET amountCents = 1 WHERE id = 'o1'`),
      ).toEqual({ ok: false, seq: 0, reason: '订单表与事件不符：o1' })
    })

    test('an inserted row without events and a reset code are caught', () => {
      expect(
        tamper(
          `INSERT INTO subscriptions (subject, planId, startsAt, endsAt, updatedAt, revision, gateway) VALUES ('mallory', 'month', 0, ${T0 + 999 * DAY}, 0, 1, 'enabled')`,
        ),
      ).toEqual({ ok: false, seq: 0, reason: '订阅表与事件不符：行数' })
      expect(
        tamper(`UPDATE redeem_codes SET usedBy = NULL, usedAt = NULL`),
      ).toEqual({ ok: false, seq: 0, reason: '兑换码表与事件不符：rc_1' })
    })
  })

  test('gateway bookkeeping honours the revision', () => {
    const { store } = populated()
    store.saveSubscription(
      {
        subject: 'alice',
        planId: 'month',
        startsAt: T0,
        endsAt: T0 + 60 * DAY,
      },
      { cause: 'grant', ref: '', by: 'ops', reason: '补偿' },
      T0 + 5000,
    )
    const row = store.subscription('alice')!
    expect(row.revision).toBe(2)
    expect(row.gateway).toBe('pending')
    expect(row.binding).toBe('key-alice')
    // A provisioning result for the old revision is not recorded.
    expect(store.gatewayEnabled('alice', 1, 'key-alice', T0 + 6000)).toBe(false)
    expect(store.gatewayFailed('alice', 2, 'Error', T0 + 6000)).toBe(1)
    expect(store.gatewayFailed('alice', 2, 'Error', T0 + 7000)).toBe(2)
    expect(
      store.events().filter(event => event.kind === 'gateway.failed'),
    ).toHaveLength(1)
    expect(store.gatewayDisabled('alice', 2, T0 + 7000)).toBe(false)
    expect(store.gatewayDisabled('alice', 2, T0 + 61 * DAY)).toBe(true)
    expect(store.subscription('alice')?.gateway).toBe('disabled')
    expect(store.verifyChain().ok).toBe(true)
    store.close()
  })
})
