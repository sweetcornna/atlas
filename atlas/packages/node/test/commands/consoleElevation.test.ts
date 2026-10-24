// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { generateNodeKeyPair } from '@qianmo/capability'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import type {
  ActionLedgerPort,
  AgentRef,
  ConsoleAction,
  ElevationActor,
  ElevationNodeView,
  ElevationPort,
  ElevationTierName,
} from '@qianmo/console'
import type { ControlOutcome } from '@qianmo/protocol'
import {
  ConsoleElevation,
  ElevationDefaults,
  SYSTEM_ELEVATION_SUBJECT,
} from '../../src/commands/consoleElevation.js'
import { parseConsoleArgs } from '../../src/commands/consoleArgs.js'

const view: ElevationNodeView = {
  node: 'worker',
  agent: 'main',
  reachable: true,
  tier: 'auto',
  epoch: 2,
  expiresAt: 10,
  maxCalls: 200,
  usedCalls: 0,
  sandbox: false,
  sandboxReason: 'no sandbox',
  enabledAt: 1,
  enabledBy: 'u:ops',
  actions24h: 0,
}

function harness(answer: (op: string) => ControlOutcome) {
  const calls: { op: string; args: Record<string, unknown>; actor: string }[] =
    []
  const entries: ConsoleAction[] = []
  let allowed = true
  const ledger: ActionLedgerPort = {
    async record(entry) {
      entries.push(entry)
      return { ok: true, value: undefined }
    },
    async list() {
      return { ok: true, value: { entries: [], nextBeforeSeq: null } }
    },
  }
  const port = new ConsoleElevation(
    {
      status: () => [
        {
          node: 'worker',
          connected: true,
          lastConnectedAt: 1,
          lastError: null,
        },
      ],
      async request(_node, op, args, actor, options) {
        try {
          options?.beforeDispatch?.()
        } catch {
          return { ok: false, code: 'refused', message: 'revoked' }
        }
        calls.push({ op, args, actor })
        return answer(op)
      },
    },
    ledger,
  )
  const actor = {
    subject: 'u:ops',
    role: 'ops' as const,
    requestId: '0b8c0f8e-1111-4222-8333-944455556666',
    beforeDispatch: () => {
      if (!allowed) throw new Error('E_AUTH_REVOKED')
    },
  }
  return {
    port,
    calls,
    entries,
    actor,
    revoke: () => {
      allowed = false
    },
  }
}

test('set translates tiers to node operations, carries the request id and records the ledger', async () => {
  const h = harness(op =>
    op === 'elevation.disable'
      ? { ok: true, value: { ...view, tier: 'off' } }
      : { ok: true, value: view },
  )
  const ref = { node: 'worker', agent: 'main' }
  const on = await h.port.set(ref, { tier: 'auto', ttlMs: 600_000 }, h.actor)
  expect(on.ok).toBe(true)
  expect(h.calls[0]).toEqual({
    op: 'elevation.enable',
    args: {
      tier: 'auto',
      ttlMs: 600_000,
      agent: 'main',
      operationId: h.actor.requestId,
    },
    actor: 'u:ops',
  })
  const off = await h.port.set(ref, { tier: 'off' }, h.actor)
  expect(off.ok && off.value.tier).toBe('off')
  expect(h.calls[1]?.op).toBe('elevation.disable')
  await h.port.revoke(ref, h.actor)
  expect(h.calls[2]?.op).toBe('elevation.revoke')
  expect(h.entries.map(e => [e.action, e.target, e.outcome])).toEqual([
    ['elevation.enable', 'qianmo://worker/main', 'ok'],
    ['elevation.disable', 'qianmo://worker/main', 'ok'],
    ['elevation.revoke', 'qianmo://worker/main', 'ok'],
  ])
})

test('a revoked permission refuses before dispatch; a node refusal is recorded with its code', async () => {
  const h = harness(() => ({
    ok: false,
    code: 'rejected',
    message: '该智能体运行在外部底层 dsh 上',
  }))
  const ref = { node: 'worker', agent: 'main' }
  const refused = await h.port.set(ref, { tier: 'auto' }, h.actor)
  expect(refused.ok).toBe(false)
  expect(refused.ok ? '' : refused.failure.message).toContain('dsh')
  expect(h.entries[0]).toMatchObject({ outcome: 'failed', code: 'rejected' })
  h.revoke()
  const blocked = await h.port.set(ref, { tier: 'auto' }, h.actor)
  expect(blocked.ok).toBe(false)
  expect(h.calls.length).toBe(1)
})

test('a node answer for another agent is not trusted', async () => {
  const h = harness(() => ({ ok: true, value: { ...view, agent: 'other' } }))
  const r = await h.port.set(
    { node: 'worker', agent: 'main' },
    { tier: 'auto' },
    h.actor,
  )
  expect(r.ok).toBe(false)
})

test('list and actions read status over the control link', async () => {
  const h = harness(op =>
    op === 'elevation.status'
      ? { ok: true, value: [view] }
      : {
          ok: true,
          value: [
            {
              at: 5,
              node: 'worker',
              agent: 'main',
              tool: 'web_search',
              cls: 'read-out',
              op: null,
              host: null,
              approved: false,
              outcome: 'allowed',
              epoch: 2,
            },
          ],
        },
  )
  const list = await h.port.list()
  expect(list.ok && list.value[0]?.tier).toBe('auto')
  const actions = await h.port.actions({ node: 'worker', agent: 'main' }, 10)
  expect(actions.ok && actions.value.length).toBe(1)
})

test('--elevation needs --approvals and --control', () => {
  const key = generateNodeKeyPair().publicKey
  expect(parseConsoleArgs([]).elevation).toBeUndefined()
  expect(() => parseConsoleArgs(['--elevation'])).toThrow(
    '--elevation needs --approvals and --control',
  )
  const config = parseConsoleArgs([
    '--elevation',
    '--approvals',
    '--accounts',
    '--chat-sign',
    '--chat-url',
    'worker=ws://127.0.0.1:39999',
    '--control',
    'worker=ws://127.0.0.1:1234',
    '--trust',
    `worker=${key}`,
  ])
  expect(config.elevation).toBe(true)
})

test('--elevation opens agents at auto unless --elevation-default says otherwise', () => {
  const key = generateNodeKeyPair().publicKey
  const base = [
    '--approvals',
    '--accounts',
    '--chat-sign',
    '--chat-url',
    'worker=ws://127.0.0.1:39999',
    '--control',
    'worker=ws://127.0.0.1:1234',
    '--trust',
    `worker=${key}`,
  ]
  expect(parseConsoleArgs(['--elevation', ...base]).elevationDefault).toBe(
    'auto',
  )
  expect(
    parseConsoleArgs([
      '--elevation',
      '--elevation-default=accept-edits',
      ...base,
    ]).elevationDefault,
  ).toBe('accept-edits')
  expect(
    parseConsoleArgs(['--elevation', '--elevation-default', 'off', ...base])
      .elevationDefault,
  ).toBe('off')
  expect(parseConsoleArgs(base).elevationDefault).toBeUndefined()
  expect(() =>
    parseConsoleArgs(['--elevation', '--elevation-default', 'yolo', ...base]),
  ).toThrow(
    '--elevation-default must be off, accept-edits, auto or full-access',
  )
  expect(() =>
    parseConsoleArgs(['--elevation-default', 'auto', ...base]),
  ).toThrow('--elevation-default needs --elevation')
})

/** A fake hub-side port: rows per agent, every write recorded. */
function fakeElevation(rows: ElevationNodeView[]) {
  const writes: {
    op: 'set' | 'revoke'
    ref: AgentRef
    tier?: ElevationTierName
    ttlMs?: number
    maxCalls?: number
    actor: ElevationActor
  }[] = []
  let refuse: string | undefined
  const find = (ref: AgentRef) =>
    rows.findIndex(r => r.node === ref.node && r.agent === ref.agent)
  const port: ElevationPort = {
    async list() {
      return { ok: true, value: rows.map(r => ({ ...r })) }
    },
    async set(ref, change, actor) {
      writes.push({ op: 'set', ref, ...change, actor })
      if (refuse)
        return { ok: false, failure: { code: 'refused', message: refuse } }
      const i = find(ref)
      rows[i] = { ...rows[i]!, tier: change.tier, enabledBy: actor.subject }
      return { ok: true, value: rows[i]! }
    },
    async revoke(ref, actor) {
      writes.push({ op: 'revoke', ref, actor })
      const i = find(ref)
      rows[i] = { ...rows[i]!, tier: 'off', enabledBy: null }
      return { ok: true, value: rows[i]! }
    },
    async actions() {
      return { ok: true, value: [] }
    },
  }
  return {
    port,
    rows,
    writes,
    refuseWith: (message: string | undefined) => {
      refuse = message
    },
  }
}

const offRow = (agent: string, extra: Partial<ElevationNodeView> = {}) => ({
  ...view,
  agent,
  tier: 'off' as const,
  expiresAt: null,
  enabledAt: null,
  enabledBy: null,
  ...extra,
})

const person: ElevationActor = {
  subject: 'u:0123456789abcdef',
  role: 'ops',
  requestId: '0b8c0f8e-1111-4222-8333-944455556666',
}

test('the default opens every reachable agent found at off, as system:elevation, at the longest grant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elev-default-'))
  try {
    const f = fakeElevation([
      offRow('main'),
      offRow('live', { tier: 'accept-edits' }),
      offRow('away', { reachable: false }),
      offRow('dsh', { unsupportedReason: '外部底层' }),
    ])
    const d = new ElevationDefaults(f.port, {
      tier: 'auto',
      statePath: join(dir, 'elevation-default.json'),
    })
    await d.sweep()
    expect(f.writes).toHaveLength(1)
    expect(f.writes[0]).toMatchObject({
      op: 'set',
      ref: { node: 'worker', agent: 'main' },
      tier: 'auto',
      ttlMs: 24 * 60 * 60_000,
      maxCalls: 2000,
      actor: { subject: SYSTEM_ELEVATION_SUBJECT, role: null },
    })
    expect(f.writes[0]!.actor.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    // Already open: a second pass changes nothing.
    await d.sweep()
    expect(f.writes).toHaveLength(1)
    const list = await d.list()
    expect(list.ok && list.value.map(r => [r.agent, r.defaultTier])).toEqual([
      ['main', 'auto'],
      ['live', 'auto'],
      ['away', 'auto'],
      ['dsh', 'auto'],
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a person turning an agent off or revoking it holds it off across restarts, until a person opens a tier', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elev-default-'))
  const statePath = join(dir, 'elevation-default.json')
  try {
    const f = fakeElevation([offRow('main'), offRow('other')])
    let now = 1000
    const d = new ElevationDefaults(f.port, {
      tier: 'auto',
      statePath,
      now: () => now,
    })
    await d.set({ node: 'worker', agent: 'main' }, { tier: 'off' }, person)
    await d.revoke({ node: 'worker', agent: 'other' }, person)
    now += 1
    await d.sweep()
    expect(
      f.writes.filter(w => w.actor.subject === SYSTEM_ELEVATION_SUBJECT),
    ).toHaveLength(0)
    const list = await d.list()
    expect(list.ok && list.value.every(r => r.defaultHeld === true)).toBe(true)
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
      held: ['worker/main', 'worker/other'],
    })

    // A restarted hub reads the holds back.
    d.close()
    const again = new ElevationDefaults(f.port, {
      tier: 'auto',
      statePath,
      now: () => now,
    })
    await again.sweep()
    expect(
      f.writes.filter(w => w.actor.subject === SYSTEM_ELEVATION_SUBJECT),
    ).toHaveLength(0)

    // A person opening a tier lifts the hold; when it lapses, the default returns.
    await again.set(
      { node: 'worker', agent: 'main' },
      { tier: 'accept-edits' },
      person,
    )
    f.rows[0] = { ...f.rows[0]!, tier: 'off', enabledBy: null }
    now += 1
    await again.sweep()
    const opened = f.writes.filter(
      w => w.actor.subject === SYSTEM_ELEVATION_SUBJECT,
    )
    expect(opened.map(w => w.ref.agent)).toEqual(['main'])
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
      held: ['worker/other'],
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A node that applies a write when it arrives and answers when released. */
function slowElevation(rows: ElevationNodeView[]) {
  const gates: (() => void)[] = []
  const writes: string[] = []
  const at = (ref: AgentRef) =>
    rows.findIndex(r => r.node === ref.node && r.agent === ref.agent)
  const port: ElevationPort = {
    async list() {
      return { ok: true, value: rows.map(r => ({ ...r })) }
    },
    set(ref, change, actor) {
      writes.push(`${ref.agent} ${change.tier} ${actor.subject}`)
      const i = at(ref)
      rows[i] = { ...rows[i]!, tier: change.tier, enabledBy: actor.subject }
      const value = { ...rows[i]! }
      return new Promise(resolve =>
        gates.push(() => resolve({ ok: true, value })),
      )
    },
    revoke(ref, actor) {
      writes.push(`${ref.agent} revoke ${actor.subject}`)
      const i = at(ref)
      rows[i] = { ...rows[i]!, tier: 'off', enabledBy: null }
      const value = { ...rows[i]! }
      return new Promise(resolve =>
        gates.push(() => resolve({ ok: true, value })),
      )
    },
    async actions() {
      return { ok: true, value: [] }
    },
  }
  return { port, gates, writes, rows }
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
}

test('a person picking a tier while the sweep is busy with another agent is not overwritten', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elev-default-'))
  try {
    const n = slowElevation([offRow('a'), offRow('b')])
    let now = 1000
    const d = new ElevationDefaults(n.port, {
      tier: 'auto',
      statePath: join(dir, 'elevation-default.json'),
      now: () => now,
    })
    const sweep = d.sweep() // reads a=off b=off, opens a, waits for the node
    await settle()
    now += 5
    const mine = d.set(
      { node: 'worker', agent: 'b' },
      { tier: 'full-access', ttlMs: 3_600_000 },
      person,
    )
    await settle()
    // The node answers a; the sweep reaches b while the person's pick is out.
    while (n.gates.length > 0 || n.writes.length < 2) {
      n.gates.shift()?.()
      await settle()
    }
    await Promise.all([sweep, mine])
    expect(n.writes).toEqual([
      `a auto ${SYSTEM_ELEVATION_SUBJECT}`,
      `b full-access ${person.subject}`,
    ])
    expect(n.rows[1]?.tier).toBe('full-access')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('holding an agent already at off is the whole change: no node call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elev-default-'))
  try {
    const f = fakeElevation([offRow('main')])
    const d = new ElevationDefaults(f.port, {
      tier: 'auto',
      statePath: join(dir, 'elevation-default.json'),
    })
    const r = await d.set(
      { node: 'worker', agent: 'main' },
      { tier: 'off' },
      person,
    )
    expect(r.ok && r.value.defaultHeld).toBe(true)
    expect(f.writes).toHaveLength(0)
    await d.sweep()
    expect(f.writes).toHaveLength(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a hold that cannot be written still reaches the node and still holds in this process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elev-default-'))
  try {
    // The state's directory cannot be made under a read-only parent.
    const config = join(dir, 'console')
    mkdirSync(config)
    chmodSync(config, 0o500)
    const f = fakeElevation([
      offRow('a', { tier: 'auto' }),
      offRow('b', { tier: 'auto' }),
    ])
    const errors: string[] = []
    const d = new ElevationDefaults(f.port, {
      tier: 'auto',
      statePath: join(config, 'not-yet', 'elevation-default.json'),
      onError: message => errors.push(message),
    })
    d.start()
    d.close()
    expect(errors[0]).toContain('建不出来')
    const revoked = await d.revoke({ node: 'worker', agent: 'a' }, person)
    const off = await d.set(
      { node: 'worker', agent: 'b' },
      { tier: 'off' },
      person,
    )
    expect(revoked.ok && off.ok).toBe(true)
    expect(f.writes.map(w => `${w.op} ${w.ref.agent}`)).toEqual([
      'revoke a',
      'set b',
    ])
    expect(errors.some(e => e.includes('写不进'))).toBe(true)
    f.rows[0] = { ...f.rows[0]!, tier: 'off' }
    f.rows[1] = { ...f.rows[1]!, tier: 'off' }
    await d.sweep()
    expect(f.writes).toHaveLength(2)
  } finally {
    chmodSync(join(dir, 'console'), 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a hold file that cannot be read at all pauses the default and the hub still starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elev-default-'))
  try {
    const statePath = join(dir, 'elevation-default.json')
    mkdirSync(statePath)
    const f = fakeElevation([offRow('main')])
    const errors: string[] = []
    const d = new ElevationDefaults(f.port, {
      tier: 'auto',
      statePath,
      onError: message => errors.push(message),
    })
    d.start()
    d.close()
    await d.sweep()
    expect(f.writes).toHaveLength(0)
    expect(errors[0]).toContain('默认档暂停')
    // Paused, the rows promise nothing about a default.
    const list = await d.list()
    expect(list.ok && list.value[0]?.defaultTier).toBeUndefined()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a second hub process on the same state file opens nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elev-default-'))
  try {
    const statePath = join(dir, 'elevation-default.json')
    const f = fakeElevation([offRow('main')])
    const first = new ElevationDefaults(f.port, { tier: 'auto', statePath })
    const errors: string[] = []
    const second = new ElevationDefaults(f.port, {
      tier: 'auto',
      statePath,
      onError: message => errors.push(message),
    })
    second.start()
    second.close()
    await second.sweep()
    expect(f.writes).toHaveLength(0)
    expect(errors[0]).toContain('另一个中枢进程')
    await first.sweep()
    expect(f.writes).toHaveLength(1)
    first.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a refused default (ESTOP, external runtime) waits ten minutes before the next try', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elev-default-'))
  try {
    const f = fakeElevation([offRow('main')])
    const errors: string[] = []
    let now = 0
    const d = new ElevationDefaults(f.port, {
      tier: 'auto',
      statePath: join(dir, 'elevation-default.json'),
      now: () => now,
      onError: message => errors.push(message),
    })
    f.refuseWith('放权已停止或被急停拦下')
    await d.sweep()
    now += 9 * 60_000
    await d.sweep()
    expect(f.writes).toHaveLength(1)
    expect(errors[0]).toContain('qianmo://worker/main')
    expect(errors[0]).toContain('急停')
    f.refuseWith(undefined)
    now += 2 * 60_000
    await d.sweep()
    expect(f.writes).toHaveLength(2)
    expect(f.rows[0]?.tier).toBe('auto')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('default grants reach the node and the ledger as system:elevation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elev-default-'))
  try {
    const h = harness(op =>
      op === 'elevation.status'
        ? { ok: true, value: [offRow('main')] }
        : { ok: true, value: { ...view, enabledBy: SYSTEM_ELEVATION_SUBJECT } },
    )
    const d = new ElevationDefaults(h.port, {
      tier: 'auto',
      statePath: join(dir, 'elevation-default.json'),
    })
    await d.sweep()
    const enable = h.calls.find(c => c.op === 'elevation.enable')
    expect(enable).toMatchObject({
      actor: SYSTEM_ELEVATION_SUBJECT,
      args: { tier: 'auto', ttlMs: 86_400_000, maxCalls: 2000, agent: 'main' },
    })
    expect(h.entries.map(e => [e.action, e.subject, e.outcome])).toEqual([
      ['elevation.enable', SYSTEM_ELEVATION_SUBJECT, 'ok'],
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('holds that cannot be read pause the default instead of reopening agents a person turned off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elev-default-'))
  const statePath = join(dir, 'elevation-default.json')
  try {
    writeFileSync(statePath, '{"held": [')
    const f = fakeElevation([offRow('main')])
    const errors: string[] = []
    const d = new ElevationDefaults(f.port, {
      tier: 'auto',
      statePath,
      onError: message => errors.push(message),
    })
    d.start()
    d.close()
    await d.sweep()
    expect(f.writes).toHaveLength(0)
    expect(errors[0]).toContain('默认档暂停')
    // A person's own change still goes through, and the broken file is left as it is.
    await d.set({ node: 'worker', agent: 'main' }, { tier: 'off' }, person)
    expect(f.writes.map(w => w.actor.subject)).toEqual([person.subject])
    expect(readFileSync(statePath, 'utf8')).toBe('{"held": [')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
