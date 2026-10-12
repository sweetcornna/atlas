// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { ResidentSupervisor, type OmpRpcFrame } from '@qianmo/resident'
import { ResidentOmpPool } from '../../src/host/residentOmp.js'
import { isolatedRoot } from '../providers/fake.js'

let root: { root: string; dispose(): void } | undefined
const pools: ResidentOmpPool[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.stop()
  expect(
    children.every(
      child => child.exitCode !== null || child.signalCode !== null,
    ),
  ).toBe(true)
  children.length = 0
  root?.dispose()
  root = undefined
})
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('settlement condition timed out')
    await Bun.sleep(5)
  }
}
async function setup(env: Record<string, string> = {}) {
  root ??= isolatedRoot()
  const agent = { agent: 'reviewer', cwd: root.root }
  const pool = new ResidentOmpPool({
    agents: [agent],
    memoryRoot: join(root.root, 'memory'),
    announce: async () => ({ status: 'queued' }),
    spawn: input => {
      const child = spawn(
        process.execPath,
        [join(import.meta.dir, 'fixtures/resident-omp-settlement.runner.ts')],
        {
          cwd: input.cwd,
          env: { ...input.env, ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
      children.push(child)
      return child
    },
  })
  pools.push(pool)
  const id = await pool.newSession(agent)
  const channel = await pool.channelFor(id)
  const frames: OmpRpcFrame[] = []
  const healthAtActivity: boolean[] = []
  channel.onFrame(frame => {
    frames.push(frame)
    if (activity([frame]).length > 0)
      healthAtActivity.push(pool.isStable(10_000))
  })
  await channel.prompt({
    messageId: 'settlement-test',
    text: 'start background work',
  })
  await until(() => frames.some(frame => frame.type === 'prompt_result'))
  expect(frames.filter(frame => frame.type === 'prompt_result')).toEqual([
    expect.objectContaining({ status: 'completed', sessionSettled: false }),
  ])
  expect(frames.some(frame => frame.type === 'session_settled')).toBe(false)
  expect(pool.isStable(10_000)).toBe(false)
  return { pool, channel, frames, healthAtActivity }
}
async function continueAndSettle(env: Record<string, string> = {}) {
  const runtime = await setup(env)
  await runtime.channel.request('fixture_continue')
  await until(() =>
    runtime.frames.some(frame => frame.type === 'session_settled'),
  )
  return runtime
}
function activity(frames: OmpRpcFrame[]) {
  return frames
    .filter(frame =>
      ['agent_start', 'agent_end', 'prompt_result', 'session_settled'].includes(
        frame.type,
      ),
    )
    .map(frame => frame.type)
}

test('completed(false) survives a ticketless background continuation until production session_settled', async () => {
  const { pool, channel, frames, healthAtActivity } = await continueAndSettle()
  expect(activity(frames)).toEqual([
    'agent_start',
    'agent_end',
    'prompt_result',
    'agent_start',
    'agent_end',
    'session_settled',
  ])
  expect(channel.readyRuntimeMs).toBeLessThan(10_000)
  expect(healthAtActivity).toEqual([false, false, false, false, false, true])
  expect(pool.isStable(10_000)).toBe(true)
})

test('six generations that settle a background continuation then exit rapidly never hit default fifth-generation parking', async () => {
  const health: boolean[] = []
  const errors: unknown[] = []
  const parked: number[] = []
  const supervisor = new ResidentSupervisor({
    initialBackoffMs: 5,
    start: async () => {
      const { pool, channel, frames } = await continueAndSettle()
      expect(activity(frames)).toEqual([
        'agent_start',
        'agent_end',
        'prompt_result',
        'agent_start',
        'agent_end',
        'session_settled',
      ])
      expect(channel.readyRuntimeMs).toBeLessThan(10_000)
      health.push(pool.isStable(10_000))
      setImmediate(() => channel.send({ type: 'fixture_exit' }))
      return pool
    },
    onError: error => errors.push(error),
    onParked: failures => parked.push(failures),
    wait: async delay => {
      if (health.length >= 6) supervisor.stop()
      else await Bun.sleep(delay)
    },
  })
  try {
    await supervisor.run()
    expect(health).toEqual([true, true, true, true, true, true])
    expect(errors).toHaveLength(6)
    expect(parked).toEqual([])
    expect(supervisor.parked).toBe(false)
    expect(children.map(child => child.exitCode)).toEqual([7, 7, 7, 7, 7, 7])
  } finally {
    supervisor.stop()
  }
})

test.each([
  ['error', '0'],
  ['aborted', '0'],
  ['error', '1'],
  ['aborted', '1'],
])('a background %s (agent_end only=%s) invalidates completed(false) without another prompt result', async (outcome, endOnly) => {
  const { pool, frames } = await continueAndSettle({
    QIANMO_SETTLEMENT_OUTCOME: outcome!,
    QIANMO_SETTLEMENT_END_ONLY: endOnly!,
  })
  expect(frames.filter(frame => frame.type === 'prompt_result')).toHaveLength(1)
  expect(pool.isStable(10_000)).toBe(false)
})

test.each([
  'error',
  'aborted',
])('a new prompt ending in %s invalidates the preceding pending success', async outcome => {
  const { pool, frames } = await continueAndSettle({
    QIANMO_SETTLEMENT_OUTCOME: outcome,
    QIANMO_SETTLEMENT_NEW_PROMPT: '1',
  })
  expect(frames.filter(frame => frame.type === 'prompt_result')).toEqual([
    expect.objectContaining({ status: 'completed', sessionSettled: false }),
    expect.objectContaining({ status: outcome, sessionSettled: true }),
  ])
  expect(pool.isStable(10_000)).toBe(false)
})

test.each([
  '0',
  '1',
])('host abort (ack only=%s) after completed(false) cannot grant health at subsequent settlement', async ackOnly => {
  const { pool, channel, frames } = await setup({
    QIANMO_SETTLEMENT_ABORT_ACK_ONLY: ackOnly,
  })
  await channel.abort()
  await until(() => frames.some(frame => frame.type === 'session_settled'))
  expect(frames.filter(frame => frame.type === 'prompt_result')).toHaveLength(1)
  expect(pool.isStable(10_000)).toBe(false)
})

test.each([
  'fixture_exit',
  'fixture_protocol_error',
])('pending success is not health when %s prevents settlement', async command => {
  const { pool, channel } = await setup()
  channel.send({ type: command })
  await channel.closed.catch(() => {})
  expect(pool.isStable(10_000)).toBe(false)
})

test('an explicit RPC frame failure invalidates pending success before later settlement', async () => {
  const { pool } = await continueAndSettle({
    QIANMO_SETTLEMENT_FRAME_ERROR: '1',
  })
  expect(pool.isStable(10_000)).toBe(false)
})
