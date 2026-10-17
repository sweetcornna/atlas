// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A hub's background sub-agent turn at its deadline (P29): the node stops it
 * the way `/stop` does and answers `E_TASK_TIMEOUT` once it has ended, so the
 * gate is free again and the turn's last report still had somewhere to go.
 * An ordinary turn keeps the old meaning: answered at once, left running.
 * The marker counts only under a verified owner proof.
 */

import { afterEach, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateNodeKeyPair, signTaskOwner } from '@qianmo/capability'
import {
  createMessage,
  MessageType,
  ProtocolErrorCode,
  type QianmoMessage,
} from '@qianmo/protocol'
import { TransportClient } from '@qianmo/transport'
import { QianmoResident } from '../../src/host/resident.js'

const PSK = 'resident-background-not-a-real-secret'
const FIXTURE = join(
  import.meta.dir,
  'fixtures',
  'resident-omp-agent.runner.ts',
)
const HUB = generateNodeKeyPair()

const children: ChildProcess[] = []
let root: string | undefined
let previousConfigDir: string | undefined
let resident: QianmoResident | undefined
let running: Promise<void> | undefined
let client: TransportClient | undefined

afterEach(async () => {
  resident?.stop()
  await running
  await client?.close()
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
  if (previousConfigDir === undefined) delete process.env.QIANMO_CONFIG_DIR
  else process.env.QIANMO_CONFIG_DIR = previousConfigDir
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  resident = running = client = root = undefined
})

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met')
    await Bun.sleep(10)
  }
}

/** A node whose turns never finish on their own, and a hub dialling it. */
async function node(env: Record<string, string> = {}) {
  root = mkdtempSync(join(tmpdir(), 'qianmo-background-deadline-'))
  previousConfigDir = process.env.QIANMO_CONFIG_DIR
  process.env.QIANMO_CONFIG_DIR = join(root, 'config')
  const socket = join(root, 'resident.sock')
  let listening = false
  let ready = false
  resident = new QianmoResident({
    node: 'node-b',
    team: 'nest',
    agents: [{ agent: 'reviewer', cwd: join(root, 'workspace') }],
    pollIntervalMs: 20,
    psk: PSK,
    listen: { unix: socket },
    memoryControllers: new Map([['node-a', HUB.publicKey]]),
    spawnOmp: input => {
      const child = spawn(process.execPath, [FIXTURE], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: { ...input.env, QIANMO_FIXTURE_HOLD_BUSY: '1', ...env },
      })
      children.push(child)
      return child
    },
    onReady: () => {
      listening = true
    },
    onTiming: event => {
      if (event.stage === 'runtime_ready') ready = true
    },
    onError: () => {},
  })
  running = resident.run()
  await until(() => listening && ready)
  const replies: QianmoMessage[] = []
  client = new TransportClient({
    endpoint: { unix: socket },
    node: 'node-a',
    psk: PSK,
    backoff: { baseDelayMs: 20, maxDelayMs: 100, jitterRatio: 0 },
    keepAliveIntervalMs: 0,
    onMessage: message => {
      replies.push(message)
    },
  })
  await client.connect()
  return { resident, client, replies }
}

function request(options: { background?: boolean; signed?: boolean }) {
  const raw = createMessage({
    from: 'qianmo://node-a/console',
    to: 'qianmo://node-b/reviewer',
    type: MessageType.TaskRequest,
    contextId: 'worker-session',
    taskTtlMs: 1_500,
    payload: {
      prompt: 'next phase',
      onBehalfOf: 'legacy:admin',
      ...(options.background ? { background: true } : {}),
    },
  })
  return options.signed === false ? raw : signTaskOwner(raw, HUB)
}

function resultOf(replies: readonly QianmoMessage[], taskId: string) {
  return replies.find(
    reply => reply.type === MessageType.TaskResult && reply.taskId === taskId,
  )?.payload as { outcome: string; code?: string; reason?: string } | undefined
}

test('a signed background turn is stopped at its deadline and answered once it ended; its last tool call still had its task', async () => {
  const log = join(tmpdir(), `qianmo-abort-tool-${crypto.randomUUID()}.ndjson`)
  const { resident, client, replies } = await node({
    QIANMO_FIXTURE_TOOL_ON_ABORT: 'qianmo_task_report',
    QIANMO_FIXTURE_TOOL_LOG: log,
  })
  const turn = request({ background: true })
  client.send(turn)
  await until(() => resident.gate.active)
  await until(() => resultOf(replies, turn.taskId) !== undefined)
  expect(resultOf(replies, turn.taskId)).toMatchObject({
    outcome: 'failed',
    code: ProtocolErrorCode.E_TASK_TIMEOUT,
    reason: expect.stringContaining('was stopped'),
  })
  // The turn ended on its own abort, so the gate is free for the next one.
  await until(() => !resident.gate.active)
  // The report made in the stop window was still this task's: it went on to
  // the hub call (no hub is connected here), instead of being refused for
  // want of a running task.
  await until(() => existsSync(log))
  const tool = JSON.parse(readFileSync(log, 'utf8').trim()) as {
    details?: { code?: string }
  }
  rmSync(log, { force: true })
  expect(tool.details?.code).toBe('hub-unavailable')
}, 30_000)

test('an ordinary turn past its deadline is answered at once and left running', async () => {
  const { resident, client, replies } = await node()
  const turn = request({})
  client.send(turn)
  await until(() => resultOf(replies, turn.taskId) !== undefined)
  expect(resultOf(replies, turn.taskId)).toMatchObject({
    code: ProtocolErrorCode.E_TASK_TIMEOUT,
    reason: 'resident task deadline expired before completion',
  })
  await Bun.sleep(200)
  expect(resident.gate.active).toBe(true)
}, 30_000)

test('a background marker without a verified owner proof is an ordinary turn', async () => {
  const { resident, client, replies } = await node()
  const turn = request({ background: true, signed: false })
  client.send(turn)
  await until(() => resultOf(replies, turn.taskId) !== undefined)
  expect(resultOf(replies, turn.taskId)?.reason).toBe(
    'resident task deadline expired before completion',
  )
  await Bun.sleep(200)
  expect(resident.gate.active).toBe(true)
}, 30_000)
