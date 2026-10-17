// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The billing database: orders, subscriptions, redeem codes, conflicts (paid
 * orders that extended nothing because another plan was active), and an
 * append-only `events` table that every state change writes to in the same
 * transaction.
 *
 * ## The chain
 *
 * Each event row stores the SHA-256 of its canonical form
 * `[seq, at, kind, sorted data pairs, prev]`, `prev` being the previous row's
 * hash (the first one 64 zeros) — the construction of the console's account
 * ledger (`@qianmo/console` `ledger.ts`) and `@qianmo/audit`. Triggers refuse
 * UPDATE and DELETE on `events`. {@link BillingStore.verifyChain} walks the
 * chain, then folds the events and compares the result with the state tables.
 *
 * What that finds: an edited, deleted or reordered event whose hashes were
 * not recomputed, and a direct edit of `orders`, `subscriptions`,
 * `redeem_codes` or `conflicts` that skips the events.
 *
 * What it does not: the hash has no key. Whoever can write the file (the
 * hub's user, root, anyone who can swap in a copy) can drop the triggers,
 * recompute the chain from any row on, or append a well-formed event together
 * with the matching table row, and `verifyChain` passes (`store.test.ts` pins
 * this). Truncation at the tail and swapping the whole file for an older copy
 * are not detected either (same limits as the console ledger). So the chain
 * is a consistency check and a record of how the state came to be, not a
 * defence against the file's owner; that would need the head hash kept
 * somewhere the owner of this file cannot rewrite, which is not done.
 *
 * Writes are serialised by `BEGIN IMMEDIATE`, so the `prev` a writer reads is
 * the last row even with a second process on the same file. Event data holds
 * identifiers, amounts and times only — never secrets, QR text or codes.
 */

import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'

const GENESIS = '0'.repeat(64)
const SCHEMA = '1'

export type OrderStatus = 'created' | 'paid' | 'closed' | 'expired' | 'refunded'
export type GatewayState = 'pending' | 'enabled' | 'disabled'

export interface OrderRow {
  readonly id: string
  readonly subject: string
  readonly planId: string
  readonly amountCents: number
  /** The plan's period at purchase; what a refund takes back. */
  readonly periodDays: number
  readonly channel: string
  readonly status: OrderStatus
  readonly outTradeNo: string
  readonly providerTxnId: string | null
  readonly qrText: string | null
  readonly createdAt: number
  readonly expiresAt: number
  readonly paidAt: number | null
}

export interface SubscriptionRow {
  readonly subject: string
  readonly planId: string
  readonly startsAt: number
  readonly endsAt: number
  readonly updatedAt: number
  /** Bumped on every change of plan or dates; provisioning results check it. */
  readonly revision: number
  readonly gateway: GatewayState
  readonly binding: string | null
  readonly attempts: number
}

/**
 * A paid order that extended nothing: when it settled, another plan was
 * active. It is owed a refund until the order is marked refunded.
 */
export interface ConflictRow {
  readonly orderId: string
  readonly subject: string
  readonly planId: string
  /** The plan that was active when the order settled. */
  readonly activePlanId: string
  readonly at: number
}

/** A conflict whose order is still paid, with what the refund is about. */
export interface RefundDueRow extends ConflictRow {
  readonly amountCents: number
  readonly channel: string
  readonly outTradeNo: string
  readonly paidAt: number | null
}

export interface RedeemCodeRow {
  readonly hash: string
  readonly id: string
  readonly planId: string
  readonly periods: number
  readonly createdBy: string
  readonly createdAt: number
  readonly expiresAt: number | null
  readonly usedBy: string | null
  readonly usedAt: number | null
}

type EventValue = string | number | boolean | null
type EventData = Readonly<Record<string, EventValue>>

export interface BillingEvent {
  readonly seq: number
  readonly at: number
  readonly kind: string
  readonly data: EventData
  readonly prev: string
  readonly hash: string
}

export type ChainReport =
  | { readonly ok: true; readonly events: number }
  | { readonly ok: false; readonly seq: number; readonly reason: string }

export interface SubscriptionChange {
  readonly cause: 'order' | 'redeem' | 'grant' | 'refund'
  /** Order id, redeem code id, or empty for a grant. */
  readonly ref: string
  readonly by?: string
  readonly reason?: string
}

const DATA_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/

function canonical(
  seq: number,
  at: number,
  kind: string,
  data: EventData,
  prev: string,
): string {
  const pairs = Object.keys(data)
    .sort()
    .map(key => [key, data[key]])
  return JSON.stringify([seq, at, kind, pairs, prev])
}

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function validData(value: unknown): value is EventData {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  return Object.entries(value).every(
    ([key, item]) =>
      DATA_KEY.test(key) &&
      (item === null ||
        typeof item === 'string' ||
        typeof item === 'boolean' ||
        (typeof item === 'number' && Number.isFinite(item))),
  )
}

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  planId TEXT NOT NULL,
  amountCents INTEGER NOT NULL CHECK (amountCents > 0),
  periodDays INTEGER NOT NULL CHECK (periodDays > 0),
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created','paid','closed','expired','refunded')),
  outTradeNo TEXT NOT NULL UNIQUE,
  providerTxnId TEXT,
  qrText TEXT,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  paidAt INTEGER
);
CREATE INDEX IF NOT EXISTS orders_open ON orders (status, expiresAt);
CREATE INDEX IF NOT EXISTS orders_reuse ON orders (subject, planId, channel, status);
CREATE TABLE IF NOT EXISTS subscriptions (
  subject TEXT PRIMARY KEY,
  planId TEXT NOT NULL,
  startsAt INTEGER NOT NULL,
  endsAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  gateway TEXT NOT NULL CHECK (gateway IN ('pending','enabled','disabled')),
  binding TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS redeem_codes (
  hash TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  planId TEXT NOT NULL,
  periods INTEGER NOT NULL CHECK (periods > 0),
  createdBy TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER,
  usedBy TEXT,
  usedAt INTEGER
);
CREATE TABLE IF NOT EXISTS conflicts (
  orderId TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  planId TEXT NOT NULL,
  activePlanId TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  prev TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'billing events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'billing events are append-only'); END;
`

/** Folded view of the events, compared with the tables by verifyChain. */
interface Folded {
  orders: Map<
    string,
    {
      status: string
      amountCents: number
      outTradeNo: string
      subject: string
      planId: string
    }
  >
  subscriptions: Map<
    string,
    { planId: string; startsAt: number; endsAt: number }
  >
  codes: Map<string, { planId: string; periods: number; usedBy: string | null }>
  conflicts: Map<
    string,
    { subject: string; planId: string; activePlanId: string }
  >
}

/**
 * One store per hub. `path` is caller-supplied (the hub passes
 * `billingStorePath()`); `:memory:` works for tests.
 */
export class BillingStore {
  readonly #db: Database

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      closeSync(openSync(path, 'a', 0o600))
      chmodSync(path, 0o600)
    }
    this.#db = new Database(path, { create: true, strict: true })
    // SQLite creates -wal / -shm with the database file's permissions.
    this.#db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;',
    )
    this.#db.exec(DDL)
    const schema = this.#db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema'")
      .get()
    if (schema === null)
      this.#db
        .query("INSERT INTO meta (key, value) VALUES ('schema', ?)")
        .run(SCHEMA)
    else if (schema.value !== SCHEMA)
      throw new Error(`billing store schema ${schema.value} is not supported`)
  }

  /** Run `fn` in one `BEGIN IMMEDIATE` transaction (a savepoint when nested). */
  transaction<T>(fn: () => T): T {
    if (this.#db.inTransaction) return this.#db.transaction(fn)()
    return this.#db.transaction(fn).immediate()
  }

  close(): void {
    this.#db.close()
  }

  // ───────────────────────────── events ─────────────────────────────

  #append(kind: string, data: EventData, at: number): void {
    if (!validData(data)) throw new Error(`invalid event data for ${kind}`)
    this.transaction(() => {
      const last = this.#db
        .query<{ seq: number; hash: string }, []>(
          'SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1',
        )
        .get()
      const seq = (last?.seq ?? 0) + 1
      const prev = last?.hash ?? GENESIS
      const hash = digest(canonical(seq, at, kind, data, prev))
      this.#db
        .query(
          'INSERT INTO events (seq, at, kind, data, prev, hash) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(seq, at, kind, JSON.stringify(data), prev, hash)
    })
  }

  /** Events after `afterSeq`, oldest first. */
  events(afterSeq = 0, limit = 1000): BillingEvent[] {
    return this.#db
      .query<
        {
          seq: number
          at: number
          kind: string
          data: string
          prev: string
          hash: string
        },
        [number, number]
      >(
        'SELECT seq, at, kind, data, prev, hash FROM events WHERE seq > ? ORDER BY seq LIMIT ?',
      )
      .all(afterSeq, limit)
      .map(row => ({ ...row, data: JSON.parse(row.data) as EventData }))
  }

  /** Record a verified provider message that did not match its order. */
  recordMismatch(
    data: {
      channel: string
      outTradeNo: string
      orderId: string | null
      field: string
      source: 'notify' | 'query'
    },
    at: number,
  ): void {
    this.#append('notify.mismatch', { ...data }, at)
  }

  // ───────────────────────────── orders ─────────────────────────────

  order(id: string): OrderRow | null {
    return this.#db
      .query<OrderRow, [string]>('SELECT * FROM orders WHERE id = ?')
      .get(id)
  }

  orderByOutTradeNo(outTradeNo: string): OrderRow | null {
    return this.#db
      .query<OrderRow, [string]>('SELECT * FROM orders WHERE outTradeNo = ?')
      .get(outTradeNo)
  }

  /** The newest `created` order for this triple that is still open after `after`. */
  openOrder(
    subject: string,
    planId: string,
    channel: string,
    after: number,
  ): OrderRow | null {
    return this.#db
      .query<OrderRow, [string, string, string, number]>(
        "SELECT * FROM orders WHERE subject = ? AND planId = ? AND channel = ? AND status = 'created' AND expiresAt > ? ORDER BY createdAt DESC LIMIT 1",
      )
      .get(subject, planId, channel, after)
  }

  /** `created` orders whose time is up. */
  ordersDue(now: number, limit: number): OrderRow[] {
    return this.#db
      .query<OrderRow, [number, number]>(
        "SELECT * FROM orders WHERE status = 'created' AND expiresAt <= ? ORDER BY expiresAt LIMIT ?",
      )
      .all(now, limit)
  }

  /** One subject's orders, newest first. */
  ordersOf(subject: string, limit: number): OrderRow[] {
    return this.#db
      .query<OrderRow, [string, number]>(
        'SELECT * FROM orders WHERE subject = ? ORDER BY createdAt DESC, id LIMIT ?',
      )
      .all(subject, limit)
  }

  recentOrders(limit: number): OrderRow[] {
    return this.#db
      .query<OrderRow, [number]>(
        'SELECT * FROM orders ORDER BY createdAt DESC, id LIMIT ?',
      )
      .all(limit)
  }

  insertOrder(row: OrderRow, at: number): void {
    this.transaction(() => {
      this.#db
        .query(
          'INSERT INTO orders (id, subject, planId, amountCents, periodDays, channel, status, outTradeNo, providerTxnId, qrText, createdAt, expiresAt, paidAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          row.id,
          row.subject,
          row.planId,
          row.amountCents,
          row.periodDays,
          row.channel,
          row.status,
          row.outTradeNo,
          row.providerTxnId,
          row.qrText,
          row.createdAt,
          row.expiresAt,
          row.paidAt,
        )
      this.#append(
        'order.created',
        {
          orderId: row.id,
          subject: row.subject,
          planId: row.planId,
          channel: row.channel,
          amountCents: row.amountCents,
          periodDays: row.periodDays,
          outTradeNo: row.outTradeNo,
          expiresAt: row.expiresAt,
        },
        at,
      )
    })
  }

  setOrderQr(id: string, qrText: string, at: number): void {
    this.transaction(() => {
      const changed = this.#db
        .query(
          "UPDATE orders SET qrText = ? WHERE id = ? AND status = 'created'",
        )
        .run(qrText, id).changes
      if (changed === 1) this.#append('order.qr', { orderId: id }, at)
    })
  }

  /** created / closed / expired → paid. False when already paid or refunded. */
  markOrderPaid(
    id: string,
    paid: {
      providerTxnId: string | null
      source: 'notify' | 'query'
      late: boolean
    },
    at: number,
  ): boolean {
    return this.transaction(() => {
      const changed = this.#db
        .query(
          "UPDATE orders SET status = 'paid', providerTxnId = ?, paidAt = ? WHERE id = ? AND status IN ('created','closed','expired')",
        )
        .run(paid.providerTxnId, at, id).changes
      if (changed !== 1) return false
      this.#append(
        'order.paid',
        {
          orderId: id,
          providerTxnId: paid.providerTxnId,
          source: paid.source,
          late: paid.late,
        },
        at,
      )
      return true
    })
  }

  /** created → closed / expired. False when the order already moved on. */
  closeOrder(
    id: string,
    status: 'closed' | 'expired',
    reason: string,
    at: number,
  ): boolean {
    return this.transaction(() => {
      const changed = this.#db
        .query(
          "UPDATE orders SET status = ? WHERE id = ? AND status = 'created'",
        )
        .run(status, id).changes
      if (changed !== 1) return false
      this.#append(`order.${status}`, { orderId: id, reason }, at)
      return true
    })
  }

  /** paid → refunded. False unless the order was paid. */
  markOrderRefunded(id: string, by: string, reason: string, at: number) {
    return this.transaction(() => {
      const changed = this.#db
        .query(
          "UPDATE orders SET status = 'refunded' WHERE id = ? AND status = 'paid'",
        )
        .run(id).changes
      if (changed !== 1) return false
      this.#append('order.refunded', { orderId: id, by, reason }, at)
      return true
    })
  }

  // ────────────────────────── subscriptions ──────────────────────────

  subscription(subject: string): SubscriptionRow | null {
    return this.#db
      .query<SubscriptionRow, [string]>(
        'SELECT * FROM subscriptions WHERE subject = ?',
      )
      .get(subject)
  }

  subscriptions(limit: number): SubscriptionRow[] {
    return this.#db
      .query<SubscriptionRow, [number]>(
        'SELECT * FROM subscriptions ORDER BY endsAt DESC, subject LIMIT ?',
      )
      .all(limit)
  }

  /** Ended, but the gateway has not been switched off yet. */
  subscriptionsToDisable(now: number, limit: number): SubscriptionRow[] {
    return this.#db
      .query<SubscriptionRow, [number, number]>(
        "SELECT * FROM subscriptions WHERE endsAt <= ? AND gateway != 'disabled' ORDER BY endsAt LIMIT ?",
      )
      .all(now, limit)
  }

  /** Active, with provisioning still owed. */
  subscriptionsToProvision(now: number, limit: number): SubscriptionRow[] {
    return this.#db
      .query<SubscriptionRow, [number, number]>(
        "SELECT * FROM subscriptions WHERE endsAt > ? AND gateway = 'pending' ORDER BY updatedAt LIMIT ?",
      )
      .all(now, limit)
  }

  /** New plan or dates; the gateway is owed a provisioning pass. */
  saveSubscription(
    next: { subject: string; planId: string; startsAt: number; endsAt: number },
    change: SubscriptionChange,
    at: number,
  ): SubscriptionRow {
    return this.transaction(() => {
      const prior = this.subscription(next.subject)
      const revision = (prior?.revision ?? 0) + 1
      this.#db
        .query(
          "INSERT INTO subscriptions (subject, planId, startsAt, endsAt, updatedAt, revision, gateway, binding, attempts) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0) ON CONFLICT(subject) DO UPDATE SET planId = excluded.planId, startsAt = excluded.startsAt, endsAt = excluded.endsAt, updatedAt = excluded.updatedAt, revision = excluded.revision, gateway = 'pending', attempts = 0",
        )
        .run(
          next.subject,
          next.planId,
          next.startsAt,
          next.endsAt,
          at,
          revision,
          prior?.binding ?? null,
        )
      this.#append(
        'subscription.changed',
        {
          subject: next.subject,
          planId: next.planId,
          startsAt: next.startsAt,
          endsAt: next.endsAt,
          fromPlanId: prior?.planId ?? null,
          fromEndsAt: prior?.endsAt ?? null,
          cause: change.cause,
          ref: change.ref,
          by: change.by ?? null,
          reason: change.reason ?? null,
        },
        at,
      )
      return this.subscription(next.subject)!
    })
  }

  /** Provisioning for `revision` succeeded. False if the row changed meanwhile. */
  gatewayEnabled(
    subject: string,
    revision: number,
    binding: string,
    at: number,
  ): boolean {
    return this.transaction(() => {
      const changed = this.#db
        .query(
          "UPDATE subscriptions SET gateway = 'enabled', binding = ?, attempts = 0 WHERE subject = ? AND revision = ? AND gateway = 'pending'",
        )
        .run(binding, subject, revision).changes
      if (changed !== 1) return false
      this.#append('gateway.enabled', { subject, revision, binding }, at)
      return true
    })
  }

  /** The gateway is switched off for an ended subscription. */
  gatewayDisabled(subject: string, revision: number, at: number): boolean {
    return this.transaction(() => {
      const row = this.subscription(subject)
      if (row === null || row.revision !== revision || row.endsAt > at)
        return false
      const changed = this.#db
        .query(
          "UPDATE subscriptions SET gateway = 'disabled', attempts = 0 WHERE subject = ? AND revision = ? AND gateway != 'disabled'",
        )
        .run(subject, revision).changes
      if (changed !== 1) return false
      this.#append(
        'subscription.expired',
        { subject, revision, endsAt: row.endsAt },
        at,
      )
      return true
    })
  }

  /**
   * A provisioning attempt failed. Only the first failure of an episode is
   * an event; later ones bump the counter (a long gateway outage must not
   * flood the chain). Returns the new attempt count.
   */
  gatewayFailed(
    subject: string,
    revision: number,
    error: string,
    at: number,
  ): number {
    return this.transaction(() => {
      const row = this.subscription(subject)
      if (row === null || row.revision !== revision) return 0
      const attempts = row.attempts + 1
      this.#db
        .query('UPDATE subscriptions SET attempts = ? WHERE subject = ?')
        .run(attempts, subject)
      if (attempts === 1)
        this.#append('gateway.failed', { subject, revision, error }, at)
      return attempts
    })
  }

  // ──────────────────────────── conflicts ────────────────────────────

  /**
   * A paid order is not credited because another plan is active; call it in
   * the transaction that marks the order paid.
   */
  recordConflict(row: Omit<ConflictRow, 'at'>, at: number): void {
    this.transaction(() => {
      this.#db
        .query(
          'INSERT INTO conflicts (orderId, subject, planId, activePlanId, at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(row.orderId, row.subject, row.planId, row.activePlanId, at)
      this.#append(
        'order.conflict',
        {
          orderId: row.orderId,
          subject: row.subject,
          planId: row.planId,
          activePlanId: row.activePlanId,
        },
        at,
      )
    })
  }

  conflict(orderId: string): ConflictRow | null {
    return this.#db
      .query<ConflictRow, [string]>('SELECT * FROM conflicts WHERE orderId = ?')
      .get(orderId)
  }

  /** Conflicts whose order is still paid (not marked refunded), oldest first. */
  refundsDue(limit: number): RefundDueRow[] {
    return this.#db
      .query<RefundDueRow, [number]>(
        "SELECT c.orderId, c.subject, c.planId, c.activePlanId, c.at, o.amountCents, o.channel, o.outTradeNo, o.paidAt FROM conflicts c JOIN orders o ON o.id = c.orderId WHERE o.status = 'paid' ORDER BY c.at, c.orderId LIMIT ?",
      )
      .all(limit)
  }

  // ─────────────────────────── redeem codes ───────────────────────────

  redeemCode(hash: string): RedeemCodeRow | null {
    return this.#db
      .query<RedeemCodeRow, [string]>(
        'SELECT * FROM redeem_codes WHERE hash = ?',
      )
      .get(hash)
  }

  redeemCodes(limit: number): RedeemCodeRow[] {
    return this.#db
      .query<RedeemCodeRow, [number]>(
        'SELECT * FROM redeem_codes ORDER BY createdAt DESC, id LIMIT ?',
      )
      .all(limit)
  }

  insertRedeemCode(row: RedeemCodeRow, at: number): void {
    this.transaction(() => {
      this.#db
        .query(
          'INSERT INTO redeem_codes (hash, id, planId, periods, createdBy, createdAt, expiresAt, usedBy, usedAt) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)',
        )
        .run(
          row.hash,
          row.id,
          row.planId,
          row.periods,
          row.createdBy,
          row.createdAt,
          row.expiresAt,
        )
      this.#append(
        'redeem.issued',
        {
          codeId: row.id,
          planId: row.planId,
          periods: row.periods,
          by: row.createdBy,
          expiresAt: row.expiresAt,
        },
        at,
      )
    })
  }

  /** Single use: false when the code was already used. */
  markRedeemCodeUsed(hash: string, subject: string, at: number): boolean {
    return this.transaction(() => {
      const row = this.redeemCode(hash)
      if (row === null) return false
      const changed = this.#db
        .query(
          'UPDATE redeem_codes SET usedBy = ?, usedAt = ? WHERE hash = ? AND usedAt IS NULL',
        )
        .run(subject, at, hash).changes
      if (changed !== 1) return false
      this.#append('redeem.used', { codeId: row.id, subject }, at)
      return true
    })
  }

  // ───────────────────────────── audit ─────────────────────────────

  /**
   * Walk the chain (contiguous seq, linked prev, recomputed hash), then fold
   * the events and compare with the state tables. The first problem wins.
   */
  verifyChain(): ChainReport {
    const folded: Folded = {
      orders: new Map(),
      subscriptions: new Map(),
      codes: new Map(),
      conflicts: new Map(),
    }
    let previous = GENESIS
    let count = 0
    let after = 0
    for (;;) {
      const page = this.#db
        .query<
          {
            seq: number
            at: number
            kind: string
            data: string
            prev: string
            hash: string
          },
          [number]
        >(
          'SELECT seq, at, kind, data, prev, hash FROM events WHERE seq > ? ORDER BY seq LIMIT 1000',
        )
        .all(after)
      if (page.length === 0) break
      for (const row of page) {
        count++
        if (row.seq !== count)
          return { ok: false, seq: row.seq, reason: 'seq 不连续' }
        if (row.prev !== previous)
          return { ok: false, seq: row.seq, reason: '哈希链断开' }
        let data: unknown
        try {
          data = JSON.parse(row.data)
        } catch {
          return { ok: false, seq: row.seq, reason: 'data 不是 JSON' }
        }
        if (!validData(data))
          return { ok: false, seq: row.seq, reason: 'data 形状不对' }
        if (
          digest(canonical(row.seq, row.at, row.kind, data, row.prev)) !==
          row.hash
        )
          return { ok: false, seq: row.seq, reason: '哈希不符' }
        previous = row.hash
        const problem = fold(folded, row.kind, data)
        if (problem !== null)
          return { ok: false, seq: row.seq, reason: problem }
      }
      after = page.at(-1)!.seq
    }
    const mismatch = this.#compare(folded)
    if (mismatch !== null) return { ok: false, seq: 0, reason: mismatch }
    return { ok: true, events: count }
  }

  #compare(folded: Folded): string | null {
    const orders = this.#db.query<OrderRow, []>('SELECT * FROM orders').all()
    if (orders.length !== folded.orders.size) return '订单表与事件不符：行数'
    for (const row of orders) {
      const want = folded.orders.get(row.id)
      if (
        want === undefined ||
        want.status !== row.status ||
        want.amountCents !== row.amountCents ||
        want.outTradeNo !== row.outTradeNo ||
        want.subject !== row.subject ||
        want.planId !== row.planId
      )
        return `订单表与事件不符：${row.id}`
    }
    const subs = this.#db
      .query<SubscriptionRow, []>('SELECT * FROM subscriptions')
      .all()
    if (subs.length !== folded.subscriptions.size)
      return '订阅表与事件不符：行数'
    for (const row of subs) {
      const want = folded.subscriptions.get(row.subject)
      if (
        want === undefined ||
        want.planId !== row.planId ||
        want.startsAt !== row.startsAt ||
        want.endsAt !== row.endsAt
      )
        return `订阅表与事件不符：${row.subject}`
    }
    const codes = this.#db
      .query<RedeemCodeRow, []>('SELECT * FROM redeem_codes')
      .all()
    if (codes.length !== folded.codes.size) return '兑换码表与事件不符：行数'
    for (const row of codes) {
      const want = folded.codes.get(row.id)
      if (
        want === undefined ||
        want.planId !== row.planId ||
        want.periods !== row.periods ||
        want.usedBy !== row.usedBy
      )
        return `兑换码表与事件不符：${row.id}`
    }
    const conflicts = this.#db
      .query<ConflictRow, []>('SELECT * FROM conflicts')
      .all()
    if (conflicts.length !== folded.conflicts.size)
      return '冲突表与事件不符：行数'
    for (const row of conflicts) {
      const want = folded.conflicts.get(row.orderId)
      if (
        want === undefined ||
        want.subject !== row.subject ||
        want.planId !== row.planId ||
        want.activePlanId !== row.activePlanId
      )
        return `冲突表与事件不符：${row.orderId}`
    }
    return null
  }
}

function str(data: EventData, key: string): string | null {
  const value = data[key]
  return typeof value === 'string' ? value : null
}

function num(data: EventData, key: string): number | null {
  const value = data[key]
  return typeof value === 'number' ? value : null
}

/** Apply one event to the folded state; a reason when it cannot apply. */
function fold(state: Folded, kind: string, data: EventData): string | null {
  switch (kind) {
    case 'order.created': {
      const id = str(data, 'orderId')
      const amountCents = num(data, 'amountCents')
      const outTradeNo = str(data, 'outTradeNo')
      const subject = str(data, 'subject')
      const planId = str(data, 'planId')
      if (!id || amountCents === null || !outTradeNo || !subject || !planId)
        return 'order.created 字段不全'
      state.orders.set(id, {
        status: 'created',
        amountCents,
        outTradeNo,
        subject,
        planId,
      })
      return null
    }
    case 'order.paid':
    case 'order.closed':
    case 'order.expired':
    case 'order.refunded': {
      const order = state.orders.get(str(data, 'orderId') ?? '')
      if (order === undefined) return `${kind} 指向不存在的订单`
      order.status = kind.slice('order.'.length)
      return null
    }
    case 'subscription.changed': {
      const subject = str(data, 'subject')
      const planId = str(data, 'planId')
      const startsAt = num(data, 'startsAt')
      const endsAt = num(data, 'endsAt')
      if (!subject || !planId || startsAt === null || endsAt === null)
        return 'subscription.changed 字段不全'
      state.subscriptions.set(subject, { planId, startsAt, endsAt })
      return null
    }
    case 'redeem.issued': {
      const id = str(data, 'codeId')
      const planId = str(data, 'planId')
      const periods = num(data, 'periods')
      if (!id || !planId || periods === null) return 'redeem.issued 字段不全'
      state.codes.set(id, { planId, periods, usedBy: null })
      return null
    }
    case 'redeem.used': {
      const code = state.codes.get(str(data, 'codeId') ?? '')
      const subject = str(data, 'subject')
      if (code === undefined || !subject)
        return 'redeem.used 指向不存在的兑换码'
      code.usedBy = subject
      return null
    }
    case 'order.conflict': {
      const id = str(data, 'orderId')
      const subject = str(data, 'subject')
      const planId = str(data, 'planId')
      const activePlanId = str(data, 'activePlanId')
      if (!id || !subject || !planId || !activePlanId)
        return 'order.conflict 字段不全'
      if (!state.orders.has(id)) return 'order.conflict 指向不存在的订单'
      state.conflicts.set(id, { subject, planId, activePlanId })
      return null
    }
    case 'order.qr':
    case 'notify.mismatch':
    case 'gateway.enabled':
    case 'gateway.failed':
    case 'subscription.expired':
      return null
    default:
      return `未知事件 ${kind}`
  }
}
