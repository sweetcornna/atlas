// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, spyOn, test, vi } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import {
  createMessage,
  isNotifyPayload,
  MessageType,
  taskExpiresAt,
  type QianmoMessage,
} from '@qianmo/protocol'
import {
  parseTurnStepDedupKey,
  ResidentNotifier,
  ResidentNotifyEventType,
  turnStepDedupKey,
  type ResidentNotifyEvent,
} from '@qianmo/resident'
import { TransportClient } from '@qianmo/transport'
import { QianmoResident } from '../../src/host/resident.js'
import { isolatedRoot } from '../providers/fake.js'

let root: { root: string; dispose(): void } | undefined
let resident: QianmoResident | undefined
let running: Promise<void> | undefined
let client: TransportClient | undefined
const releases: (() => void)[] = []
const children: ChildProcess[] = []
let diagnostics = () => ''

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  resident?.stop()
  try {
    await running
    expect(
      children.every(
        child => child.exitCode !== null || child.signalCode !== null,
      ),
    ).toBe(true)
  } finally {
    await client?.close()
    vi.restoreAllMocks()
    root?.dispose()
    root = undefined
    resident = undefined
    running = undefined
    client = undefined
    children.length = 0
  }
})

async function until(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('resident progress settlement timed out')
    await Bun.sleep(5)
  }
}

function barrier() {
  const gate = Promise.withResolvers<void>()
  releases.push(gate.resolve)
  return gate
}

async function setup(holdNotifyReceipts = false) {
  root = isolatedRoot()
  const ready = Promise.withResolvers<void>()
  const receipt = barrier()
  const received: QianmoMessage[] = []
  const audit: ResidentNotifyEvent[] = []
  const order: string[] = []
  const errors: string[] = []
  const frames: string[] = []
  diagnostics = () => JSON.stringify({ errors, audit, frames })
  const socket = join(root.root, 'r.sock')
  resident = new QianmoResident({
    node: 'node-b',
    team: 'nest',
    agents: [{ agent: 'reviewer', cwd: root.root }],
    memoryRoot: join(root.root, 'memory'),
    psk: 'progress-settlement-local-test-psk',
    listen: { unix: socket },
    inactivityMs: 0,
    pollIntervalMs: 5,
    spawnOmp: input => {
      const child = spawn(
        process.execPath,
        [join(import.meta.dir, 'fixtures/resident-omp-agent.runner.ts')],
        {
          cwd: input.cwd,
          env: { ...input.env, QIANMO_FIXTURE_PROGRESS_BATCH: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
      children.push(child)
      child.stdout!.on('data', chunk => frames.push(String(chunk)))
      child.stderr!.on('data', chunk => frames.push(`stderr: ${String(chunk)}`))
      return child
    },
    onTiming: event => {
      if (event.stage === 'runtime_ready') ready.resolve()
    },
    notifyAudit: event => {
      audit.push(event)
      if (event.type === ResidentNotifyEventType.Sent)
        order.push(`notify:${event.detail.msgId}`)
    },
    onError: error => errors.push(String(error)),
  })
  running = resident.run()
  void running.catch(() => {})
  await ready.promise
  expect(children).toHaveLength(0)
  client = new TransportClient({
    endpoint: { unix: socket },
    node: 'node-a',
    psk: 'progress-settlement-local-test-psk',
    supportedTypes: Object.values(MessageType),
    keepAliveIntervalMs: 0,
    onMessage: async message => {
      received.push(message)
      if (message.type === MessageType.TaskResult)
        order.push(`result:${message.taskId}`)
      // Each inbound envelope is handled independently; holding notify's
      // receipt does not hold task.result's handler or its receipt.
      if (holdNotifyReceipts && message.type === MessageType.Notify)
        await receipt.promise
    },
  })
  await client.connect()
  return { received, audit, order, errors, receipt }
}

function results(received: readonly QianmoMessage[], task: QianmoMessage) {
  return received.filter(
    message =>
      message.type === MessageType.TaskResult && message.taskId === task.taskId,
  )
}

function steps(received: readonly QianmoMessage[], task: QianmoMessage) {
  return received.filter(
    message =>
      message.type === MessageType.Notify &&
      isNotifyPayload(message.payload) &&
      message.payload.causeTaskId === task.taskId,
  )
}

async function startRound(
  received: readonly QianmoMessage[],
  taskTtlMs = 30_000,
) {
  const task = createMessage({
    from: 'qianmo://node-a/planner',
    to: 'qianmo://node-b/reviewer',
    type: MessageType.TaskRequest,
    contextId: 'progress-session',
    payload: { prompt: 'run three different tools' },
    taskTtlMs,
  })
  await client!.sendAndWait(task)
  try {
    await until(() => steps(received, task).length === 2)
  } catch (error) {
    throw new Error(
      `${String(error)}; received=${JSON.stringify(received)}; ${diagnostics()}`,
    )
  }
  return task
}

function finishRound() {
  children[0]!.stdin!.write(
    `${JSON.stringify({ type: 'fixture_finish_progress' })}\n`,
  )
}

function expectProgressBeforeResult(
  received: readonly QianmoMessage[],
  order: readonly string[],
  task: QianmoMessage,
) {
  const rows = steps(received, task)
  // Exact per-call keys distinguish three tools and reject duplicate sends.
  expect(
    rows.map(message =>
      isNotifyPayload(message.payload) ? message.payload.dedupKey : undefined,
    ),
  ).toEqual(
    ['progress-1', 'progress-2', 'progress-3'].map(id =>
      turnStepDedupKey(task.msgId, id, 'start'),
    ),
  )
  const resultIndex = received.findIndex(
    message =>
      message.type === MessageType.TaskResult && message.taskId === task.taskId,
  )
  const sentResultIndex = order.indexOf(`result:${task.taskId}`)
  for (const row of rows) {
    expect(received.indexOf(row)).toBeLessThan(resultIndex)
    expect(order.indexOf(`notify:${row.msgId}`)).toBeGreaterThanOrEqual(0)
    expect(order.indexOf(`notify:${row.msgId}`)).toBeLessThan(sentResultIndex)
  }
  expect(results(received, task).map(message => message.payload)).toEqual([
    expect.objectContaining({
      outcome: 'completed',
      content: 'progress batch complete',
    }),
  ])
}

test.each([
  'cold',
  'reused',
])('the %s child hands all three steps to notifier before the same-write result', async mode => {
  const state = await setup()
  if (mode === 'reused') {
    const warmup = await startRound(state.received)
    finishRound()
    await until(() => results(state.received, warmup).length > 0)
  }
  const task = await startRound(state.received)
  finishRound()
  await until(() => results(state.received, task).length > 0)
  expectProgressBeforeResult(state.received, state.order, task)
  expect(children).toHaveLength(1)
  resident!.stop()
  await running
  expectProgressBeforeResult(state.received, state.order, task)
  expect(state.errors).toEqual([])
})

test('held notify receipts, including another round, do not delay the result', async () => {
  const state = await setup(true)
  for (let round = 0; round < 2; round++) {
    const task = await startRound(state.received)
    const began = Date.now()
    finishRound()
    await until(() => results(state.received, task).length > 0, 1_000)
    expect(Date.now() - began).toBeLessThan(1_000)
    expectProgressBeforeResult(state.received, state.order, task)
  }
  expect(
    state.audit.filter(event => event.type === ResidentNotifyEventType.Sent),
  ).toHaveLength(6)
  expect(
    state.audit.filter(
      event => event.type === ResidentNotifyEventType.Delivered,
    ),
  ).toHaveLength(0)
  state.receipt.resolve()
  await until(
    () =>
      state.audit.filter(
        event => event.type === ResidentNotifyEventType.Delivered,
      ).length === 6,
  )
  expect(state.errors).toEqual([])
})

for (const competing of ['timeout', 'shutdown'] as const) {
  test(`${competing} during the last notifier handoff cannot send a second terminal result`, async () => {
    const state = await setup()
    const handoff = barrier()
    let blocked = false
    const announce = ResidentNotifier.prototype.announce
    spyOn(ResidentNotifier.prototype, 'announce').mockImplementation(
      async function (this: ResidentNotifier, input) {
        if (
          parseTurnStepDedupKey(input.payload.dedupKey ?? '')?.toolCallId ===
          'progress-3'
        ) {
          blocked = true
          await handoff.promise
        }
        return announce.call(this, input)
      },
    )
    const task = await startRound(
      state.received,
      competing === 'timeout' ? 2_000 : 30_000,
    )
    finishRound()
    // On the old host the result wins and the last handoff never happens.
    await until(() => blocked || results(state.received, task).length > 0)
    expect(blocked).toBe(true)
    expect(results(state.received, task)).toHaveLength(0)
    if (competing === 'timeout') {
      await Bun.sleep(Math.max(0, taskExpiresAt(task) - Date.now() + 50))
    } else {
      let stopped = false
      void running!.then(() => {
        stopped = true
      })
      resident!.stop()
      await Bun.sleep(30)
      expect(stopped).toBe(false)
    }
    expect(results(state.received, task)).toHaveLength(0)
    handoff.resolve()
    await until(() => results(state.received, task).length > 0)
    resident!.stop()
    await running
    expectProgressBeforeResult(state.received, state.order, task)
    expect(state.errors).toEqual([])
  })
}
