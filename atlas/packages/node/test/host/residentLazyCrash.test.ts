// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import {
  createMessage,
  MessageType,
  ProtocolErrorCode,
  type QianmoMessage,
} from '@qianmo/protocol'
import { TransportClient, TransportReceiptError } from '@qianmo/transport'
import { QianmoResident } from '../../src/host/resident.js'
import { isolatedRoot } from '../providers/fake.js'

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('lazy crash condition timed out')
    await Bun.sleep(5)
  }
}

test('production lazy generations park after five rapid RPC crashes despite long child-free idle periods', async () => {
  const root = isolatedRoot()
  const socket = join(root.root, 'r.sock')
  const children: ChildProcess[] = []
  const errors: string[] = []
  const replies: QianmoMessage[] = []
  const registeredAt: number[] = []
  const psk = 'lazy-crash-production-test-local-psk'
  const resident = new QianmoResident({
    node: 'node-b',
    team: 'nest',
    agents: [{ agent: 'reviewer', cwd: root.root }],
    memoryRoot: join(root.root, 'memory'),
    psk,
    listen: { unix: socket },
    inactivityMs: 0,
    pollIntervalMs: 10,
    // Keep the default five-failure limit. A 2 s stability window instead of
    // the default 10 s: the idle periods below only have to outlast it.
    ompRestart: { initialBackoffMs: 5, stableAfterMs: 2_000 },
    spawnOmp: input => {
      const child = spawn(
        process.execPath,
        [join(import.meta.dir, 'fixtures/resident-omp-agent.runner.ts')],
        {
          cwd: input.cwd,
          env: { ...input.env, QIANMO_FIXTURE_CRASH_ON_PROMPT: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
      children.push(child)
      return child
    },
    onTiming: event => {
      if (event.stage === 'runtime_ready') registeredAt.push(Date.now())
    },
    onError: error => errors.push(String(error)),
  })
  const running = resident.run()
  void running.catch(() => {})
  const client = new TransportClient({
    endpoint: { unix: socket },
    node: 'node-a',
    psk,
    keepAliveIntervalMs: 0,
    onMessage: message => {
      replies.push(message)
    },
  })
  let ended = false
  void running.then(
    () => {
      ended = true
    },
    () => {
      ended = true
    },
  )
  try {
    await until(() => registeredAt.length === 1)
    await client.connect()
    for (let generation = 1; generation <= 5; generation++) {
      await until(() => registeredAt.length === generation)
      expect(children).toHaveLength(generation - 1)
      // Real time beyond the stability window. start() only registers
      // sessions; the transport delivery below is what starts the RPC child.
      await Bun.sleep(
        Math.max(0, registeredAt[generation - 1]! + 2_050 - Date.now()),
      )
      expect(children).toHaveLength(generation - 1)
      const request = createMessage({
        from: 'qianmo://node-a/planner',
        to: 'qianmo://node-b/reviewer',
        type: MessageType.TaskRequest,
        payload: { round: generation },
      })
      await client.sendAndWait(request)
      await until(() =>
        replies.some(
          reply =>
            reply.type === MessageType.TaskResult &&
            reply.taskId === request.taskId,
        ),
      )
      expect(
        replies.find(
          reply =>
            reply.type === MessageType.TaskResult &&
            reply.taskId === request.taskId,
        )?.payload,
      ).toMatchObject({ outcome: 'failed' })
      await until(() => children[generation - 1]?.exitCode === 7)
    }
    await until(
      () =>
        errors.some(error => error.includes('parked after 5 rapid failures')) ||
        registeredAt.length > 5,
    )
    expect(
      errors.some(error => error.includes('parked after 5 rapid failures')),
    ).toBe(true)
    expect(registeredAt).toHaveLength(5)
    expect(children).toHaveLength(5)
    const refused = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { round: 'parked' },
    })
    const rejection = await client
      .sendAndWait(refused)
      .catch((error: unknown) => error)
    expect(rejection).toBeInstanceOf(TransportReceiptError)
    expect((rejection as TransportReceiptError).receiptCode).toBe(
      ProtocolErrorCode.E_UNDELIVERABLE,
    )
    await until(() => replies.some(reply => reply.type === MessageType.Error))
    expect(
      replies.find(reply => reply.type === MessageType.Error)?.payload,
    ).toMatchObject({
      reason: expect.stringContaining('resident agent is unavailable'),
    })
    expect(children).toHaveLength(5)
    expect(client.isReady()).toBe(true)
    expect(ended).toBe(false)
  } finally {
    resident.stop()
    await client.close()
    await running
    expect(
      children.every(
        child => child.exitCode !== null || child.signalCode !== null,
      ),
    ).toBe(true)
    root.dispose()
  }
}, 35_000)
