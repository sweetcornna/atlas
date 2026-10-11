// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProtocolErrorCode } from '@qianmo/protocol'
import { ControlRegistry } from '../../src/host/control.js'
import { ControlLedger } from '../../src/host/controlLedger.js'

test('side effects survive receiver restart, canonical replay and operation-id conflicts', async () => {
  const ledgerPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'fx2-ledger-')),
    'operations.sqlite',
  )
  let runs = 0
  const ctx = {
    peer: 'hub',
    actor: 'alice',
    taskId: 'first',
    operationId: crypto.randomUUID(),
  }
  const create = () => {
    const registry = new ControlRegistry({ ledgerPath })
    registry.register('files', async () => ({ ok: true, value: ++runs }), {
      sideEffects: op => op === 'files.write',
    })
    return registry
  }
  let registry = create()
  expect(await registry.handle('files.write', { a: 1, b: 2 }, ctx)).toEqual({
    ok: true,
    value: 1,
  })
  expect(
    await registry.handle(
      'files.write',
      { b: 2, a: 1 },
      { ...ctx, taskId: 'retry' },
    ),
  ).toEqual({ ok: true, value: 1 })
  await registry.close()
  registry = create()
  try {
    expect(await registry.handle('files.write', { a: 1, b: 2 }, ctx)).toEqual({
      ok: true,
      value: 1,
    })
    expect(
      await registry.handle('files.write', { a: 2, b: 2 }, ctx),
    ).toMatchObject({ ok: false, code: 'invalid' })
    expect(
      await registry.handle(
        'files.write',
        {},
        { peer: 'hub', actor: 'alice', taskId: 'legacy' },
      ),
    ).toMatchObject({ ok: false, code: 'invalid' })
    expect(runs).toBe(1)
    expect(fs.statSync(ledgerPath).mode & 0o777).toBe(0o600)
  } finally {
    await registry.close()
  }
})

test('ESTOP matches full operation names, defaults to deny and checks before the ledger', async () => {
  let estop = true,
    runs = 0
  const registry = new ControlRegistry({ estopEngaged: () => estop })
  registry.register('files', async () => ({ ok: true, value: ++runs }), {
    estopAllowed: ['files.read'],
  })
  registry.register('memory', async () => ({ ok: true, value: ++runs }))
  const ctx = { peer: 'hub', actor: 'alice', taskId: 't' }
  for (const op of ['files.write', 'files.read.more', 'memory.list'])
    expect(await registry.handle(op, {}, ctx)).toMatchObject({
      ok: false,
      code: ProtocolErrorCode.E_BUSY,
    })
  expect(runs).toBe(0)
  expect(await registry.handle('files.read', {}, ctx)).toEqual({
    ok: true,
    value: 1,
  })
  estop = false
  expect(await registry.handle('files.write', {}, ctx)).toEqual({
    ok: true,
    value: 2,
  })
  expect(await registry.handle('memory.list', {}, ctx)).toEqual({
    ok: true,
    value: 3,
  })
  expect(() =>
    registry.register('bad', async () => ({ ok: true, value: null }), {
      estopAllowed: ['files.read'],
    }),
  ).toThrow()
  await registry.close()
})

test('a receiver exiting after its side effect reopens with unknown and never repeats the effect', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx2-crash-'))
  const ledgerPath = path.join(root, 'operations.sqlite'),
    marker = path.join(root, 'effect')
  const operationId = crypto.randomUUID()
  const child = Bun.spawn(
    [
      process.execPath,
      path.resolve(import.meta.dir, '../fixtures/control-ledger-crash.ts'),
      ledgerPath,
      operationId,
      marker,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  expect(await child.exited).toBe(0)
  expect(await Bun.file(marker).text()).toBe('executed')
  let runs = 0
  const registry = new ControlRegistry({ ledgerPath })
  registry.register('files', async () => ({ ok: true, value: ++runs }), {
    sideEffects: () => true,
  })
  try {
    expect(
      await registry.handle(
        'files.write',
        { path: 'a' },
        { peer: 'hub', actor: 'alice', taskId: 'new', operationId },
      ),
    ).toMatchObject({ ok: false, code: 'unknown' })
    expect(runs).toBe(0)
  } finally {
    await registry.close()
  }
})

test('concurrent retries share one execution; unexpired capacity rejects and expired entries free space', async () => {
  let now = 1_000,
    runs = 0
  const ledger = new ControlLedger({
    file: path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'fx2-capacity-')),
      'operations.sqlite',
    ),
    now: () => now,
    maxEntries: 1,
    retentionMs: 100,
  })
  const ctx = {
    peer: 'hub',
    actor: 'alice',
    taskId: 't',
    operationId: crypto.randomUUID(),
  }
  const gate = Promise.withResolvers<void>()
  const invoke = async () => {
    runs++
    await gate.promise
    return { ok: true as const, value: runs }
  }
  try {
    const first = ledger.execute('files.write', {}, ctx, invoke)
    const retry = ledger.execute('files.write', {}, ctx, invoke)
    expect(
      await ledger.execute('files.write', { different: true }, ctx, invoke),
    ).toMatchObject({ ok: false, code: 'invalid' })
    gate.resolve()
    expect(await first).toEqual({ ok: true, value: 1 })
    expect(await retry).toEqual({ ok: true, value: 1 })
    expect(
      await ledger.execute(
        'files.write',
        {},
        { ...ctx, operationId: crypto.randomUUID() },
        invoke,
      ),
    ).toMatchObject({ ok: false, code: ProtocolErrorCode.E_BUSY })
    expect(runs).toBe(1)
    now += 101
    expect(
      await ledger.execute(
        'files.write',
        {},
        { ...ctx, operationId: crypto.randomUUID() },
        invoke,
      ),
    ).toEqual({ ok: true, value: 2 })
  } finally {
    gate.resolve()
    await ledger.close()
  }
})

test('query declarations do not create a ledger; an exception after an effect remains unknown across restart', async () => {
  const ledgerPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'fx2-query-')),
    'operations.sqlite',
  )
  let runs = 0
  const create = () => {
    const registry = new ControlRegistry({ ledgerPath })
    registry.register(
      'files',
      async op => {
        if (op === 'files.read') return { ok: true, value: runs }
        runs++
        throw new Error('fixture failed after effect')
      },
      { sideEffects: op => op === 'files.write' },
    )
    return registry
  }
  let registry = create()
  const ctx = {
    peer: 'hub',
    actor: 'alice',
    taskId: 't',
    operationId: crypto.randomUUID(),
  }
  expect(await registry.handle('files.read', {}, ctx)).toEqual({
    ok: true,
    value: 0,
  })
  expect(fs.existsSync(ledgerPath)).toBe(false)
  expect(await registry.handle('files.write', {}, ctx)).toMatchObject({
    ok: false,
    code: 'unknown',
  })
  await registry.close()
  registry = create()
  try {
    expect(await registry.handle('files.write', {}, ctx)).toMatchObject({
      ok: false,
      code: 'unknown',
    })
    expect(runs).toBe(1)
  } finally {
    await registry.close()
  }
})

test('an unavailable ledger refuses before invoking a side-effect handler', async () => {
  const errors: unknown[] = [],
    ledgerPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fx2-unavailable-'))
  let runs = 0
  const registry = new ControlRegistry({
    ledgerPath,
    onError: error => errors.push(error),
  })
  registry.register('files', async () => ({ ok: true, value: ++runs }), {
    sideEffects: () => true,
  })
  try {
    expect(
      await registry.handle(
        'files.write',
        {},
        {
          peer: 'hub',
          actor: 'alice',
          taskId: 't',
          operationId: crypto.randomUUID(),
        },
      ),
    ).toMatchObject({ ok: false, code: 'internal' })
    expect(runs).toBe(0)
    expect(errors).toHaveLength(1)
  } finally {
    await registry.close()
  }
})

test('oversized results retain an unknown reservation rather than freeing an executed operation for retry', async () => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'fx2-bytes-')),
    'operations.sqlite',
  )
  let runs = 0
  const ctx = { peer: 'hub', actor: 'alice', operationId: crypto.randomUUID() }
  const invoke = async () => ({
    ok: true as const,
    value: 'x'.repeat(1000 + ++runs),
  })
  let ledger = new ControlLedger({ file, maxResultBytes: 256 })
  expect(await ledger.execute('files.write', {}, ctx, invoke)).toMatchObject({
    ok: false,
    code: 'unknown',
  })
  await ledger.close()
  ledger = new ControlLedger({ file, maxResultBytes: 256 })
  try {
    expect(await ledger.execute('files.write', {}, ctx, invoke)).toMatchObject({
      ok: false,
      code: 'unknown',
    })
    expect(runs).toBe(1)
  } finally {
    await ledger.close()
  }
})

test('a late result cannot overwrite a new reservation that reused an expired id', async () => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'fx2-expired-')),
    'operations.sqlite',
  )
  let now = 0
  const first = new ControlLedger({ file, now: () => now, retentionMs: 100 })
  const second = new ControlLedger({ file, now: () => now, retentionMs: 100 })
  const gate = Promise.withResolvers<void>()
  const ctx = { peer: 'hub', actor: 'alice', operationId: crypto.randomUUID() }
  const old = first.execute('files.write', { version: 1 }, ctx, async () => {
    await gate.promise
    return { ok: true, value: 'old' }
  })
  try {
    now = 101
    expect(
      await second.execute('files.write', { version: 1 }, ctx, async () => ({
        ok: true,
        value: 'new',
      })),
    ).toEqual({ ok: true, value: 'new' })
    gate.resolve()
    expect(await old).toMatchObject({ ok: false, code: 'unknown' })
    let repeats = 0
    expect(
      await second.execute('files.write', { version: 1 }, ctx, async () => ({
        ok: true,
        value: ++repeats,
      })),
    ).toEqual({ ok: true, value: 'new' })
    expect(repeats).toBe(0)
  } finally {
    gate.resolve()
    await old
    await first.close()
    await second.close()
  }
})

test('shutdown does not wait for a hung effect and leaves its durable reservation unknown', async () => {
  const ledgerPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'fx2-close-')),
    'operations.sqlite',
  )
  const gate = Promise.withResolvers<void>()
  let runs = 0
  const registry = new ControlRegistry({ ledgerPath })
  registry.register(
    'files',
    async () => {
      runs++
      await gate.promise
      return { ok: true, value: runs }
    },
    { sideEffects: () => true },
  )
  const ctx = {
    peer: 'hub',
    actor: 'alice',
    taskId: 't',
    operationId: crypto.randomUUID(),
  }
  const pending = registry.handle('files.write', {}, ctx)
  const closed = registry.close()
  try {
    expect(
      await Promise.race([
        closed.then(() => 'closed'),
        Bun.sleep(50).then(() => 'blocked'),
      ]),
    ).toBe('closed')
    const restarted = new ControlRegistry({ ledgerPath })
    restarted.register('files', async () => ({ ok: true, value: ++runs }), {
      sideEffects: () => true,
    })
    try {
      expect(await restarted.handle('files.write', {}, ctx)).toMatchObject({
        ok: false,
        code: 'unknown',
      })
      expect(runs).toBe(1)
    } finally {
      await restarted.close()
    }
    gate.resolve()
    expect(await pending).toMatchObject({ ok: false, code: 'unknown' })
  } finally {
    gate.resolve()
    await pending
    await closed
  }
})
