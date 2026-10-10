// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditSource, AuditTrail } from '@qianmo/audit'
import {
  createMessage,
  MessageType,
  type QianmoMessage,
} from '@qianmo/protocol'
import { assertJob } from '@qianmo/scheduler'
import { WatchBoundary } from '../../src/commands/watchBoundary.js'
import { WatchUsage } from '../../src/commands/watchUsage.js'
import {
  createWatchDispatch,
  parseWatchArgs,
} from '../../src/commands/watch.js'
import { FileTenantStore } from '../../src/commands/consoleTenancy.js'

const previous = process.env.QIANMO_CONFIG_DIR
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
  if (previous === undefined) delete process.env.QIANMO_CONFIG_DIR
  else process.env.QIANMO_CONFIG_DIR = previous
})
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'watch-usage-'))
  process.env.QIANMO_CONFIG_DIR = root
  const job = assertJob({
    id: 'watch-a',
    title: 'Watch',
    target: 'qianmo://worker/main',
    prompt: 'inspect',
    schedule: { everyMs: 600000 },
    taskTtlMs: 60000,
    notifyPolicy: 'agent-initiated',
  })
  const boundary = new WatchBoundary('qianmo://hub/watch', [job])
  const policy = join(root, 'policy.json')
  writeFileSync(
    policy,
    JSON.stringify({
      mode: 'enforce',
      person: {},
      job: { inFlight: 1, wakes: 10 },
      global: {},
    }),
  )
  const open = async (
    audits: readonly (readonly [string, string])[] = [],
    b = boundary,
  ) => {
    const usage = await WatchUsage.open(b, [job], policy, audits)
    cleanups.push(() => usage.close())
    return usage
  }
  const usage = await open()
  const trail = new AuditTrail(join(root, 'hub.ndjson'))
  cleanups.push(() => trail.close())
  const fire = {
    job,
    fireAtMs: Date.now(),
    dedupKey: 'watch-a:one',
    attempt: 1,
  }
  const options = {
    from: boundary.from,
    hubNode: 'hub',
    urls: new Map([[job.id, 'ws://unused']]),
    boundary,
    usage,
    trail,
    warn: () => {},
  }
  const row = async (u = usage) =>
    (await u.store.read()).rows.find(row => row.bucket === 'job:watch-a')!
  return { root, job, boundary, policy, usage, open, fire, options, row }
}
function result(request: QianmoMessage, changes: Partial<QianmoMessage> = {}) {
  return {
    ...createMessage({
      from: request.to,
      to: request.from,
      type: MessageType.TaskResult,
      taskId: request.taskId,
      contextId: request.contextId,
      payload: {
        outcome: 'completed',
        content: 'done',
        completedAt: Date.now(),
      },
    }),
    ...changes,
  }
}

test('unknown send retains durable job quota; only its original terminal releases, not forged task/job/node', async () => {
  const f = await fixture()
  let sent: QianmoMessage | undefined
  let dials = 0
  const dispatch = createWatchDispatch({
    ...f.options,
    linkTo: async () => {
      dials++
      return {
        sendAndWait: async message => {
          sent = message
          throw new Error('receipt unknown')
        },
      }
    },
  })
  await expect(dispatch(f.fire)).rejects.toThrow('receipt unknown')
  expect(await f.row()).toMatchObject({ wakes: 1, inFlight: 1, charged: 0 })
  expect(await dispatch(f.fire)).toBe('skipped')
  expect(dials).toBe(1)
  f.usage.close()
  const reopened = await f.open()
  expect(await f.row(reopened)).toMatchObject({ wakes: 1, inFlight: 1 })
  for (const changes of [
    { from: 'qianmo://foreign/main' },
    { contextId: 'other-job' },
    { taskId: crypto.randomUUID() },
  ])
    reopened.result(result(sent!, changes))
  expect((await f.row(reopened)).inFlight).toBe(1)
  reopened.result(result(sent!))
  reopened.result(result(sent!))
  expect(await f.row(reopened)).toMatchObject({ wakes: 1, inFlight: 0 })
  expect((await reopened.store.read()).lowerBound).toBe(true)
})

test('confirmed pre-send dial failure releases only inFlight and records its admitted wake', async () => {
  const f = await fixture()
  const dispatch = createWatchDispatch({
    ...f.options,
    linkTo: async () => {
      throw new Error('no connection')
    },
  })
  await expect(dispatch(f.fire)).rejects.toThrow('no connection')
  expect(await f.row()).toMatchObject({ wakes: 1, inFlight: 0 })
  await expect(dispatch(f.fire)).rejects.toThrow('no connection')
  expect(await f.row()).toMatchObject({ wakes: 2, inFlight: 0 })
})

test('fresh tenant reassignment during dial cannot spend or finish another tenant job scope', async () => {
  const f = await fixture()
  f.usage.close()
  const mapping = {
    version: 1,
    hubServer: 'hub',
    tenants: [{ id: 'a' }, { id: 'b' }],
    subjects: [],
    platformSubjects: [],
    nodes: [
      {
        nodeId: 'worker',
        tenant: 'a',
        server: 'other',
        memoryRoot: join(f.root, 'memory'),
      },
    ],
    jobs: [{ jobId: f.job.id, nodeId: 'worker', tenant: 'a' }],
  }
  const path = join(f.root, 'tenancy.json')
  writeFileSync(path, JSON.stringify(mapping), { mode: 0o600 })
  const boundary = new WatchBoundary(
    f.boundary.from,
    [f.job],
    new FileTenantStore(path),
  )
  const usage = await f.open([], boundary)
  let sends = 0
  const dispatch = createWatchDispatch({
    ...f.options,
    boundary,
    usage,
    linkTo: async () => {
      mapping.nodes[0]!.tenant = 'b'
      mapping.jobs[0]!.tenant = 'b'
      writeFileSync(path, JSON.stringify(mapping), { mode: 0o600 })
      return {
        sendAndWait: async () => {
          sends++
          throw new Error('must not send')
        },
      }
    },
  })
  await expect(dispatch(f.fire)).rejects.toThrow('tenant changed')
  expect(sends).toBe(0)
  expect(
    (await usage.store.read()).rows.find(row => row.bucket === 'tenant:a'),
  ).toMatchObject({ wakes: 1, inFlight: 0 })
  expect(
    (await usage.store.read()).rows.some(row => row.bucket === 'tenant:b'),
  ).toBe(false)
})

test('trusted node audit supplies four token columns idempotently, foreign node cannot finish the task', async () => {
  const f = await fixture()
  let request: QianmoMessage | undefined
  await expect(
    createWatchDispatch({
      ...f.options,
      linkTo: async () => ({
        sendAndWait: async message => {
          request = message
          throw new Error('unknown')
        },
      }),
    })(f.fire),
  ).rejects.toThrow()
  f.usage.close()
  const trail = new AuditTrail(join(f.root, 'node.ndjson'))
  cleanups.push(() => trail.close())
  for (const node of ['foreign', 'worker'])
    trail.append({
      at: Date.now(),
      node,
      source: AuditSource.Resident,
      kind: 'usage.tokens',
      outcome: 'ok',
      taskId: request!.taskId,
      detail: {
        input: node === 'worker' ? 4 : 1000,
        output: 3,
        cacheWrite: 2,
        cacheRead: 1,
      },
    })
  trail.append({
    at: Date.now(),
    node: 'foreign',
    source: AuditSource.Resident,
    kind: 'usage.turn_end',
    outcome: 'ok',
    taskId: request!.taskId,
  })
  const usage = await f.open([['worker', trail.path]])
  for (
    let attempt = 0;
    attempt < 20 && (await f.row(usage)).charged === 0;
    attempt++
  ) {
    await usage.snapshot()
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  expect(await f.row(usage)).toMatchObject({
    input: 4,
    output: 3,
    cacheWrite: 2,
    cacheRead: 1,
    charged: 9,
    inFlight: 1,
  })
  usage.close()
  const reopened = await f.open([['worker', trail.path]])
  await reopened.snapshot()
  expect((await f.row(reopened)).charged).toBe(9)
  trail.append({
    at: Date.now(),
    node: 'worker',
    source: AuditSource.Resident,
    kind: 'usage.turn_end',
    outcome: 'ok',
    taskId: request!.taskId,
  })
  for (
    let attempt = 0;
    attempt < 20 && (await f.row(reopened)).inFlight;
    attempt++
  ) {
    await reopened.snapshot()
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  expect((await f.row(reopened)).inFlight).toBe(0)
  reopened.close()
  writeFileSync(
    f.policy,
    JSON.stringify({
      mode: 'enforce',
      person: {},
      job: { tokens: 9 },
      global: {},
    }),
  )
  const tokenLimited = await f.open([['worker', trail.path]])
  let dials = 0
  const dispatch = createWatchDispatch({
    ...f.options,
    usage: tokenLimited,
    linkTo: async () => {
      dials++
      throw new Error('must not dial')
    },
  })
  expect(await dispatch(f.fire)).toBe('skipped')
  expect(dials).toBe(0)
})

test('watch exposes usage status and refuses ambiguous policy/audit flags', () => {
  expect(parseWatchArgs(['--usage-status'])).toEqual({ mode: 'usage-status' })
  expect(() => parseWatchArgs(['--usage-audit', 'worker=relative'])).toThrow(
    'absolute',
  )
  expect(() =>
    parseWatchArgs([
      '--print-identity',
      '--from',
      'qianmo://hub/watch',
      '--usage-policy',
      '/tmp/policy',
    ]),
  ).toThrow('takes only')
})
