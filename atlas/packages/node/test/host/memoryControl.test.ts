// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { canonicalJson } from '@qianmo/capability'
import { createHash } from 'node:crypto'
import type {
  MemoryEntryView,
  DirectionActor,
  ConsoleResult,
} from '@qianmo/console'
import { FileMemoryStore } from '@qianmo/memory'
import {
  createMessage,
  LIMITS,
  MessageType,
  type ControlOutcome,
} from '@qianmo/protocol'
import { ResidentMemorySidecar, resolveMemoryPartition } from '@qianmo/resident'
import { MemoryControl } from '../../src/host/memoryControl.js'
import {
  ConsoleMemory,
  type MemoryLinks,
} from '../../src/commands/consoleMemory.js'

const ALICE = 'u:0123456789abcdef',
  BOB = 'u:abcdef0123456789'
const actor: DirectionActor = {
  subject: ALICE,
  role: 'member',
  requestId: 'request-1',
}
const ref = { node: 'worker', agent: 'helper' }
const draft = {
  kind: 'preference' as const,
  title: '简报',
  summary: '简报不超过三百字',
  body: '包含三项重点',
}
let directory: string, control: MemoryControl, at: number, stopped: boolean
let root: string, ledgerPath: string
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-p23-control-'))
  root = path.join(directory, 'memory')
  ledgerPath = path.join(directory, 'operations.sqlite')
  at = Date.now()
  stopped = false
  control = makeControl()
})
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})
function makeControl() {
  return new MemoryControl({
    node: 'worker',
    agents: ['helper'],
    root,
    ledgerPath,
    estop: { engaged: () => stopped },
    now: () => at,
  })
}
function request(
  op: string,
  args: Record<string, unknown> = {},
  subject = ALICE,
) {
  return control.handle(
    op,
    { agent: 'helper', ...args },
    { actor: subject, peer: 'hub', taskId: crypto.randomUUID() },
  )
}
function value<T>(result: ConsoleResult<T>): T {
  if (!result.ok) throw new Error(result.failure.message)
  return result.value
}
function controlEntry(result: ControlOutcome): MemoryEntryView {
  if (!result.ok) throw new Error(result.message)
  return result.value as MemoryEntryView
}
function port() {
  const sent: Record<string, unknown>[] = []
  const links: MemoryLinks = {
    status: () => [
      { node: 'worker', connected: true, lastConnectedAt: at, lastError: null },
    ],
    request: async (_node, op, args, subject) => {
      sent.push(args)
      return control.handle(op, args, {
        actor: subject,
        peer: 'hub',
        taskId: crypto.randomUUID(),
      })
    },
  }
  return { memory: new ConsoleMemory({ links }), sent, links }
}
function block(subject?: string) {
  return new ResidentMemorySidecar({
    store: new FileMemoryStore({ root, readOnly: true }),
    now: () => new Date(at),
  }).render({
    agent: 'helper',
    contextId: 'new-chat',
    ...(subject ? { owner: subject } : {}),
  })
}

test('the real port adds, supersedes, forgets and invalidates; every old record remains auditable and another account sees 404', async () => {
  const { memory, sent } = port()
  expect(value(await memory.agents())).toEqual([{ ...ref, reachable: true }])
  const made = value(await memory.add(ref, draft, actor))
  expect(made).toMatchObject({
    owner: ALICE,
    source: { kind: 'user', id: `user:console:${ALICE}` },
  })
  expect(sent[1]?.operationId).toMatch(/^[0-9a-f-]{36}$/)
  expect(block(ALICE)).toContain(made.id)
  expect(block(BOB)).toBe('')
  expect(block()).toBe('')
  expect(
    await memory.edit(ref, made.id, draft, { ...actor, subject: BOB }),
  ).toMatchObject({ ok: false, failure: { code: 'not_found' } })
  expect(
    await memory.forget(ref, made.id, 'x', { ...actor, subject: BOB }),
  ).toMatchObject({ ok: false, failure: { code: 'not_found' } })
  expect(
    await memory.invalidate(ref, made.id, { ...actor, subject: BOB }),
  ).toMatchObject({ ok: false, failure: { code: 'not_found' } })
  expect(
    value(await memory.list(ref, { ...actor, subject: BOB })).entries,
  ).toEqual([])
  at++
  const edited = value(
    await memory.edit(ref, made.id, { ...draft, summary: '五百字' }, actor),
  )
  expect(edited.supersedes).toBe(made.id)
  expect(block(ALICE)).toContain(edited.id)
  expect(block(ALICE)).not.toContain(`entry_id: ${made.id}`)
  expect(
    value(await memory.list(ref, actor)).entries.map(one => one.id),
  ).toEqual([edited.id])
  const audit = value(
    await memory.list({ ...ref, includeRetired: true }, actor),
  )
  expect(audit.entries.find(one => one.id === made.id)).toMatchObject({
    supersededBy: edited.id,
    invalidAt: at,
  })
  const forgot = value(await memory.forget(ref, edited.id, '已经完成', actor))
  expect(forgot.retired).toEqual({
    kind: 'revoked',
    reason: '已经完成',
    by: ALICE,
  })
  expect(block(ALICE)).toBe('')
  const expires = value(
    await memory.add(ref, { ...draft, kind: 'plan' }, actor),
  )
  at++
  expect(value(await memory.invalidate(ref, expires.id, actor)).invalidAt).toBe(
    at,
  )
  expect(value(await memory.list(ref, actor)).entries).toEqual([])
  expect(
    value(await memory.list({ ...ref, includeRetired: true }, actor)).entries,
  ).toHaveLength(3)
  expect(
    new FileMemoryStore({ root, readOnly: true }).query({
      includeRetired: true,
    }),
  ).toHaveLength(3)
})

test('operation replay survives restart, rejects changed parameters or actor, and ESTOP permits only retirement and reads', async () => {
  const operationId = crypto.randomUUID(),
    args = { draft, operationId }
  const original = await request('memory.add', args)
  expect(original.ok).toBe(true)
  control = makeControl()
  at++
  expect(await request('memory.add', args)).toEqual(original)
  expect(
    await request('memory.add', {
      ...args,
      draft: { ...draft, body: 'different' },
    }),
  ).toMatchObject({ ok: false, code: 'rejected' })
  expect(await request('memory.add', args, BOB)).toMatchObject({
    ok: false,
    code: 'rejected',
  })
  const made = controlEntry(original)
  stopped = true
  expect(
    await request('memory.add', { draft, operationId: crypto.randomUUID() }),
  ).toMatchObject({ ok: false, code: 'refused' })
  expect(
    await request('memory.edit', {
      id: made.id,
      draft,
      operationId: crypto.randomUUID(),
    }),
  ).toMatchObject({ ok: false, code: 'refused' })
  expect((await request('memory.list')).ok).toBe(true)
  const forgetArgs = {
    id: made.id,
    reason: 'stop',
    operationId: crypto.randomUUID(),
  }
  const forgotten = await request('memory.forget', forgetArgs)
  expect(forgotten.ok).toBe(true)
  control = makeControl()
  expect(await request('memory.forget', forgetArgs)).toEqual(forgotten)
  expect(
    (
      await request('memory.invalidate', {
        id: made.id,
        operationId: crypto.randomUUID(),
      })
    ).ok,
  ).toBe(true)
  expect(
    new FileMemoryStore({ root, readOnly: true }).query({
      includeRetired: true,
    }),
  ).toHaveLength(1)
  expect(await request('memory.add', { draft })).toMatchObject({
    ok: false,
    code: 'invalid',
  })
  expect(await request('memory.list', { owner: BOB })).toMatchObject({
    ok: false,
    code: 'not_found',
  })
})

test('interrupted add and replacement intents recover without a second entry or a stale predecessor', async () => {
  const old = controlEntry(
    await request('memory.add', { draft, operationId: crypto.randomUUID() }),
  )
  at++
  const operationId = crypto.randomUUID(),
    args = { agent: 'helper', id: old.id, draft, operationId }
  const replacement = controlEntry(await request('memory.edit', args))
  // Crash window: the Markdown intent reached disk but the result transaction did not.
  const db = new Database(ledgerPath)
  db.query('UPDATE operations SET result = NULL WHERE id = ?').run(operationId)
  db.close()
  const store = new FileMemoryStore({ root, readOnly: true })
  const scope = resolveMemoryPartition({
    scope: 'long',
    agent: 'helper',
    owner: ALICE,
  })
  const oldFile = path.join(
    root,
    'working',
    scope.projectKey,
    scope.taskId,
    `${old.id}.md`,
  )
  const before = fs.readFileSync(oldFile, 'utf8')
  fs.writeFileSync(
    oldFile,
    before
      .replace(/invalidAt: .+/, 'invalidAt: null')
      .replace(/^supersededBy: .+\n/m, ''),
  )
  control = makeControl()
  expect(await request('memory.edit', args)).toEqual({
    ok: true,
    value: replacement,
  })
  expect(store.getEntry(old.id)?.supersededBy).toBe(replacement.id)
  expect(block(ALICE)).not.toContain(`entry_id: ${old.id}`)
  expect(store.query({ includeRetired: true })).toHaveLength(2)
  // An intent persisted before the effect is also resumed with its original id/time.
  const pendingId = crypto.randomUUID(),
    pendingArgs = { agent: 'helper', draft, operationId: pendingId }
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        op: 'memory.add',
        args: pendingArgs,
        actor: ALICE,
        peer: 'hub',
      }),
    )
    .digest('hex')
  const pendingDb = new Database(ledgerPath)
  pendingDb
    .query('INSERT INTO operations VALUES (?, ?, ?, NULL)')
    .run(pendingId, digest, at)
  pendingDb.close()
  const pending = await request('memory.add', pendingArgs)
  expect(pending.ok).toBe(true)
  control = makeControl()
  expect(await request('memory.add', pendingArgs)).toEqual(pending)
  expect(store.query({ includeRetired: true })).toHaveLength(3)
})

test('filtered pagination counts all live kinds and measures multibyte/escaped content in the final reply envelope', async () => {
  const { memory } = port()
  for (let index = 0; index < 32; index++) {
    at++
    value(
      await memory.add(
        ref,
        {
          ...draft,
          kind: index % 2 ? 'plan' : 'preference',
          body: '中"\\'.repeat(1200),
        },
        actor,
      ),
    )
  }
  const response = createMessage({
    from: 'qianmo://worker/console',
    to: 'qianmo://hub/console',
    type: MessageType.NodeControlResult,
    payload: {},
    hops: ['worker'],
  })
  const fits = (outcome: ControlOutcome) =>
    Buffer.byteLength(
      JSON.stringify({ ...response, payload: outcome }),
      'utf8',
    ) <= LIMITS.maxMessageBytes
  const first = await control.handle(
    'memory.list',
    { agent: 'helper', limit: 200 },
    { actor: ALICE, peer: 'hub', taskId: 'x', resultFits: fits },
  )
  expect(first.ok).toBe(true)
  expect(fits(first)).toBe(true)
  const page = first.ok
    ? (first.value as {
        entries: MemoryEntryView[]
        nextOffset: number
        total: number
      })
    : undefined
  expect(page!.entries.length).toBeLessThan(32)
  expect(page!.nextOffset).toBe(page!.entries.length)
  expect(page!.total).toBe(32)
  const next = value(
    await memory.list({ ...ref, offset: page!.nextOffset, limit: 200 }, actor),
  )
  expect(
    new Set([...page!.entries, ...next.entries].map(one => one.id)).size,
  ).toBe(32)
  const filtered = value(
    await memory.list({ ...ref, kind: 'plan', text: '简报' }, actor),
  )
  expect(filtered.total).toBe(16)
  expect(filtered.counts).toEqual({
    preference: 16,
    plan: 16,
    project: 0,
    daily: 0,
  })
  expect(await memory.list({ ...ref, limit: 0 }, actor)).toMatchObject({
    ok: false,
    failure: { code: 'invalid' },
  })
})

test('the hub treats a lost/late control response as unknown and rejects a foreign owner response', async () => {
  const { memory, links } = port()
  links.request = async () => ({
    ok: false,
    code: 'timeout',
    message: 'timeout',
  })
  expect(await memory.add(ref, draft, actor)).toMatchObject({
    ok: false,
    failure: {
      code: 'unreachable',
      message: expect.stringContaining('结果未知'),
    },
  })
  expect(
    await memory.add({ ...ref, node: 'outside' }, draft, actor),
  ).toMatchObject({ ok: false, failure: { code: 'not_found' } })
  links.request = async () => ({ ok: true, value: { owner: BOB } })
  expect(await memory.list(ref, actor)).toMatchObject({
    ok: false,
    failure: { code: 'unreachable' },
  })
})

test('a multi-predecessor replacement displays the newest link while preserving all links and protecting user provenance', async () => {
  const store = new FileMemoryStore({ root, now: () => new Date(at) })
  const scope = resolveMemoryPartition({
    scope: 'long',
    agent: 'helper',
    owner: ALICE,
  })
  const input = {
    scope,
    title: '旧记录',
    summary: '旧记录',
    body: '',
    source: { kind: 'user' as const, id: `user:console:${ALICE}` },
    tags: ['kind:preference'],
  }
  const first = store.write(input, 'operator')
  at++
  const second = store.write(input, 'operator')
  expect(() =>
    store.write(
      {
        ...input,
        source: { kind: 'agent', id: 'approved-tool' },
        supersedes: [second.id],
      },
      'peer',
    ),
  ).toThrow('higher-trust')
  at++
  const replaced = store.write(
    { ...input, supersedes: [first.id, second.id] },
    'operator',
  )
  const { memory } = port()
  const listed = value(await memory.list(ref, actor))
  expect(listed.entries).toHaveLength(1)
  expect(listed.entries[0]?.supersedes).toBe(second.id)
  expect(store.getEntry(replaced.id)?.supersedes).toEqual(
    [first.id, second.id].sort(),
  )
  expect(store.getEntry(second.id)?.supersededBy).toBe(replaced.id)
})

test('a disconnected control node retains its last roster with unreachable status and a single oversized entry returns an error', async () => {
  const { memory, links } = port()
  expect(value(await memory.agents())).toEqual([{ ...ref, reachable: true }])
  links.status = () => [
    {
      node: 'worker',
      connected: false,
      lastConnectedAt: at,
      lastError: 'lost',
    },
  ]
  links.request = async () => {
    throw new Error('must not dial while disconnected')
  }
  expect(value(await memory.agents())).toEqual([{ ...ref, reachable: false }])
  controlEntry(
    await request('memory.add', { draft, operationId: crypto.randomUUID() }),
  )
  expect(
    await control.handle(
      'memory.list',
      { agent: 'helper' },
      { actor: ALICE, peer: 'hub', taskId: 'budget', resultFits: () => false },
    ),
  ).toMatchObject({ ok: false, code: 'invalid' })
})
