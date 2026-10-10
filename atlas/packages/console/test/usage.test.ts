// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileUsageStore, usageDelta } from '../src/usage.js'
import type { UsagePolicy } from '../src/governance.js'

const stores: FileUsageStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
const policy: UsagePolicy = {
  mode: 'enforce',
  person: { tokens: 100, inFlight: 1, sessions: 1 },
  job: { tokens: 10, inFlight: 1 },
  global: { tokens: 150 },
  tenants: { a: { tokens: 120 } },
}
function setup(options: Partial<Parameters<typeof create>[0]> = {}) {
  return create(options)
}
function create(
  options: {
    policy?: UsagePolicy
    now?: () => number
    monotonic?: () => number
    path?: string
  } = {},
) {
  const path =
    options.path ??
    join(mkdtempSync(join(tmpdir(), 'qm-usage-')), 'usage.ndjson')
  const store = new FileUsageStore({ path, policy, ...options })
  stores.push(store)
  return { store, path }
}
const alice = { kind: 'person', subject: 'u:alice', tenant: 'a' } as const
const bob = { kind: 'person', subject: 'u:bob', tenant: 'a' } as const
const tokens = { input: 70, output: 10, cacheWrite: 20, cacheRead: 900_000 }

describe('durable hub usage admission', () => {
  test('four columns persist, cache reads excluded, duplicate observations do not charge twice', async () => {
    const { store, path } = setup()
    store.record('node/turn-1', alice, tokens)
    store.record('node/turn-1', alice, tokens)
    store.close()
    const { store: reopened } = setup({ path })
    const row = (await reopened.read(alice.subject)).rows[0]!
    expect(row).toMatchObject({ ...tokens, charged: 100 })
    expect(reopened.reserve(alice)).toMatchObject({
      ok: false,
      reason: 'quota',
    })
    expect(reopened.reserve(bob).ok).toBe(true)
  })
  test('inflight and sessions use atomic multi-bucket admission, rejection consumes nothing', async () => {
    const { store } = setup()
    const first = store.reserve(alice, { sessionId: 'one', newSession: true })
    expect(first.ok).toBe(true)
    expect(store.reserve(alice).ok).toBe(false)
    expect(store.reserve(bob).ok).toBe(true)
    if (!first.ok) throw new Error('positive control failed')
    store.finish(first.reservationId)
    expect(
      store.reserve(alice, { sessionId: 'two', newSession: true }).ok,
    ).toBe(false)
    store.closeSession(alice, 'one')
    expect(
      store.reserve(alice, { sessionId: 'two', newSession: true }).ok,
    ).toBe(true)
    expect((await store.read(alice.subject)).rows).toHaveLength(1)
  })
  test('tenant cap cannot be evaded with another person; job bucket cannot crowd out humans', () => {
    const { store } = setup()
    store.record('1', alice, { ...tokens, input: 90 })
    expect(store.reserve(bob).ok).toBe(false)
    expect(
      store.reserve({ kind: 'person', subject: 'u:other', tenant: 'b' }).ok,
    ).toBe(true)
    store.record(
      'job/1',
      { kind: 'job', subject: 'night' },
      { input: 1000, output: 0, cacheWrite: 0, cacheRead: 0 },
    )
    expect(store.reserve({ kind: 'job', subject: 'night' }).ok).toBe(false)
    expect(store.reserve({ kind: 'person', subject: 'u:other2' }).ok).toBe(true)
  })
  test('shadow records would-refuse but read corruption fails closed even in shadow', () => {
    const { store, path } = setup({ policy: { ...policy, mode: 'shadow' } })
    store.record('1', alice, tokens)
    const admitted = store.reserve(alice)
    expect(admitted).toMatchObject({
      ok: true,
      shadowExceeded: ['person:u:alice'],
    })
    store.close()
    writeFileSync(path, '{bad json}\n')
    const { store: broken } = setup({
      path,
      policy: { ...policy, mode: 'shadow' },
    })
    expect(broken.reserve(alice)).toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
  })
  test('UTC+8 midnight rolls naturally, forward/backward wall jump cannot reset limits', async () => {
    let now = Date.parse('2026-10-08T15:59:59Z')
    let mono = 0
    const { store } = setup({ now: () => now, monotonic: () => mono })
    store.record('1', alice, tokens)
    expect((await store.read()).day).toBe('2026-10-08')
    now += 2000
    mono += 2000
    expect((await store.read()).day).toBe('2026-10-09')
    store.record('2', alice, tokens)
    now += 86_400_000
    expect(store.reserve(alice)).toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
    expect((await store.read()).day).toBe('2026-10-09')
  })
  test('finish persists once; restart preserves in-flight admission', async () => {
    const { store, path } = setup()
    const r = store.reserve(alice)
    if (!r.ok) throw new Error('positive control')
    store.close()
    const { store: restarted } = setup({ path })
    expect(restarted.reserve(alice).ok).toBe(false)
    restarted.finish(r.reservationId, tokens)
    restarted.finish(r.reservationId, tokens)
    expect((await restarted.read(alice.subject)).rows[0]?.charged).toBe(100)
  })
  test('cumulative usage detects reset as new epoch and never includes totalTokens', () => {
    expect(
      usageDelta(tokens, { input: 3, output: 2, cacheWrite: 0, cacheRead: 4 }),
    ).toEqual({ input: 3, output: 2, cacheWrite: 0, cacheRead: 4 })
    expect(usageDelta(tokens, { ...tokens, output: 15 })).toEqual({
      input: 0,
      output: 5,
      cacheWrite: 0,
      cacheRead: 0,
    })
  })
})

test('exclusive writer prevents concurrent quota snapshots; closing releases the OS lock', () => {
  const { store, path } = setup()
  const { store: second } = setup({ path })
  expect(second.reserve(alice)).toMatchObject({
    ok: false,
    reason: 'unavailable',
  })
  store.close()
  const { store: next } = setup({ path })
  expect(next.reserve(alice).ok).toBe(true)
})

test('usage and terminal arriving before task binding survive restart and charge once', async () => {
  const { store, path } = setup()
  const reservation = store.reserve(alice, { operation: 'wake' })
  if (!reservation.ok) throw new Error('positive control')
  store.recordTask('node/early', 'task-early', tokens)
  store.finishTask('task-early')
  store.close()
  const { store: next } = setup({ path })
  next.bindTask(reservation.reservationId, 'task-early')
  next.recordTask('node/early', 'task-early', tokens)
  next.finishTask('task-early')
  expect((await next.read(alice.subject)).rows[0]).toMatchObject({
    charged: 100,
    inFlight: 0,
    wakes: 1,
    messages: 0,
  })
})

test('temporary sessions are adopted; message and wake ceilings are independent', async () => {
  const { store } = setup({
    policy: { ...policy, person: { sessions: 1, messages: 1, wakes: 1 } },
  })
  const r = store.reserve(alice, {
    sessionId: 'pending:request',
    newSession: true,
  })
  if (!r.ok) throw new Error('positive control')
  store.adoptSession(r.reservationId, 'real-session')
  store.finish(r.reservationId)
  store.closeSession(alice, 'real-session')
  expect((await store.read(alice.subject)).rows[0]?.sessions).toBe(0)
  expect(store.reserve(alice, { operation: 'message' }).ok).toBe(true)
  expect(store.reserve(alice, { operation: 'message' }).ok).toBe(false)
  expect(store.reserve(alice, { operation: 'wake' }).ok).toBe(true)
  expect(store.reserve(alice, { operation: 'wake' }).ok).toBe(false)
})

test('late audit collection attributes tokens to the execution day, not the collection day', async () => {
  const now = Date.parse('2026-10-09T01:00:00+08:00')
  const yesterday = Date.parse('2026-10-08T23:00:00+08:00')
  const { store, path } = setup({ now: () => now })
  const reservation = store.reserve(alice, { operation: 'message' })
  if (!reservation.ok) throw new Error('positive control')
  store.bindTask(reservation.reservationId, 'late')
  store.recordTask('node/late', 'late', tokens, yesterday)
  store.finishTask('late')
  expect((await store.read(alice.subject)).rows[0]).toMatchObject({
    charged: 0,
    messages: 1,
    inFlight: 0,
  })
  store.close()
  const { store: replay } = setup({ path, now: () => now })
  expect((await replay.read(alice.subject)).rows[0]).toMatchObject({
    charged: 0,
    messages: 1,
  })
})

test('audit task attribution is bound to its node before and after restart, including receipt races', async () => {
  const { store, path } = setup()
  const first = store.reserve(alice)
  if (!first.ok) throw new Error('positive control failed')
  store.recordTask('evil-before', 'task', tokens, undefined, 'wrong')
  store.finishTask('task', 'wrong')
  store.recordTask(
    'good-before',
    'task',
    { ...tokens, input: 1, output: 0, cacheWrite: 0 },
    undefined,
    'right',
  )
  store.bindTask(first.reservationId, 'task', 'right')
  expect((await store.read(alice.subject)).rows[0]).toMatchObject({
    charged: 1,
    inFlight: 1,
  })
  store.close()
  const { store: reopened } = setup({ path })
  reopened.recordTask('evil-after', 'task', tokens, undefined, 'wrong')
  reopened.finishTask('task', 'wrong')
  expect((await reopened.read(alice.subject)).rows[0]).toMatchObject({
    charged: 1,
    inFlight: 1,
  })
  reopened.recordTask(
    'good-after',
    'task',
    { ...tokens, input: 2, output: 0, cacheWrite: 0 },
    undefined,
    'right',
  )
  reopened.finishTask('task', 'right')
  expect((await reopened.read(alice.subject)).rows[0]).toMatchObject({
    charged: 3,
    inFlight: 0,
  })
})
