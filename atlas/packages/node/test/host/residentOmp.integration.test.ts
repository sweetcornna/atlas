// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TransportClient } from '@qianmo/transport'
import {
  createMessage,
  MessageType,
  type QianmoMessage,
} from '@qianmo/protocol'
import { qianmoConfigPath } from '@qianmo/paths'
import { OmpResidentTurnPort } from '@qianmo/resident'
import { ResidentOmpPool } from '../../src/host/residentOmp.js'
import { QianmoResident } from '../../src/host/resident.js'
import { ResidentOmpHarness } from '../../../../tests/integration/fixtures/resident-omp-harness.js'

let root: string | undefined
let previous = process.env.QIANMO_CONFIG_DIR
let harness: ResidentOmpHarness | undefined
let resident: QianmoResident | undefined
let running: Promise<void> | undefined
let client: TransportClient | undefined
afterEach(async () => {
  resident?.stop()
  await running
  await client?.close()
  await harness?.stop()
  if (previous === undefined) delete process.env.QIANMO_CONFIG_DIR
  else process.env.QIANMO_CONFIG_DIR = previous
  if (root) rmSync(root, { recursive: true, force: true })
  resident = undefined
  running = undefined
  client = undefined
  harness = undefined
  root = undefined
})
function setup() {
  root = mkdtempSync(join(tmpdir(), 'ResidentRuntime-real-'))
  previous = process.env.QIANMO_CONFIG_DIR
  process.env.QIANMO_CONFIG_DIR = join(root, 'config')
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  harness = new ResidentOmpHarness()
  return { root, workspace, harness }
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 1500; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('resident real omp timed out')
}
test('real omp RPC: mailbox delivery reaches read ACK, task.result and durable input identity', async () => {
  const { root, workspace } = setup()
  const received: QianmoMessage[] = []
  const errors: unknown[] = []
  const unix = join(root, 'resident.sock')
  resident = new QianmoResident({
    node: 'node-b',
    team: 'nest',
    agents: [{ agent: 'reviewer', cwd: workspace }],
    psk: 'test-resident-no-secret-key',
    listen: { unix },
    pollIntervalMs: 20,
    onError: e => errors.push(e),
  })
  running = resident.run()
  await until(() => existsSync(unix))
  client = new TransportClient({
    endpoint: { unix },
    node: 'hub',
    psk: 'test-resident-no-secret-key',
    onMessage: message => {
      received.push(message)
    },
  })
  await client.connect()
  const message = createMessage({
    type: MessageType.TaskRequest,
    from: 'qianmo://hub/operator',
    to: 'qianmo://node-b/reviewer',
    payload: { taskId: 'real-task', prompt: 'say pong' },
  })
  await client.send(message)
  await until(() => received.some(item => item.type === MessageType.TaskResult))
  expect(received.some(item => item.type === MessageType.Ack)).toBe(true)
  expect(
    received.find(item => item.type === MessageType.TaskResult)?.payload,
  ).toMatchObject({ outcome: 'completed', content: 'pong' })
  const sessions = qianmoConfigPath('resident', 'sessions', 'reviewer')
  const transcript = readdirSync(sessions)
    .flatMap(id =>
      readdirSync(join(sessions, id))
        .filter(name => name.endsWith('.jsonl'))
        .map(name => readFileSync(join(sessions, id, name), 'utf8')),
    )
    .join('\n')
  expect(transcript).toContain('qianmo.resident.input-identity')
  expect(errors).toEqual([])
}, 30_000)
test('real extension blocks project allow rules, shell, outside writes and subagent calls', async () => {
  const { root, workspace, harness } = setup()
  mkdirSync(join(workspace, '.omp'))
  writeFileSync(
    join(workspace, '.omp/config.yml'),
    'tools:\n  approvalMode: yolo\n  approval:\n    bash: allow\n    task: allow\n    write: allow\n',
  )
  const outside = join(root, 'outside.txt')
  const result = await harness.run(
    workspace,
    [
      { name: 'write', input: { path: outside, content: 'forbidden' } },
      { name: 'bash', input: { command: `touch ${outside}` } },
      { name: 'task', input: { agent: 'worker', task: `write ${outside}` } },
      { name: 'write', input: { path: 'ok.txt', content: 'allowed' } },
    ],
    true,
  )
  expect(result.accepted).toBe(true)
  expect(result.result).toEqual({ outcome: 'completed', content: 'pong' })
  expect(existsSync(outside)).toBe(false)
  expect(readFileSync(join(workspace, 'ok.txt'), 'utf8')).toBe('allowed')
  expect(result.toolResults.join('\n')).toMatch(
    /outside|resident|not found|not available/i,
  )
  expect(harness.offeredTools.has('bash')).toBe(false)
  expect(harness.offeredTools.has('task')).toBe(false)
}, 30_000)

test('real extension refuses symlink reads and writes into a protected memory root inside the workspace', async () => {
  const { workspace, harness } = setup()
  const memoryRoot = join(workspace, 'private-memory')
  mkdirSync(memoryRoot)
  writeFileSync(join(memoryRoot, 'secret.txt'), 'protected-memory-canary')
  symlinkSync(memoryRoot, join(workspace, 'alias'))
  const result = await harness.run(
    workspace,
    [
      { name: 'read', input: { path: 'alias/secret.txt' } },
      { name: 'grep', input: { pattern: 'protected-memory-canary' } },
      {
        name: 'grep',
        input: { pattern: 'protected-memory-canary', path: '.' },
      },
      { name: 'write', input: { path: 'alias/new.txt', content: 'forbidden' } },
      { name: 'write', input: { path: 'ordinary.txt', content: 'allowed' } },
    ],
    true,
    memoryRoot,
  )
  expect(result.result).toEqual({ outcome: 'completed', content: 'pong' })
  expect(result.toolResults.join('\n')).not.toContain('protected-memory-canary')
  expect(result.toolResults.slice(0, 4)).toEqual(
    Array.from({ length: 4 }, () =>
      expect.stringMatching(/memory|protected|config root/i),
    ),
  )
  expect(existsSync(join(memoryRoot, 'new.txt'))).toBe(false)
  expect(readFileSync(join(workspace, 'ordinary.txt'), 'utf8')).toBe('allowed')
}, 30_000)

test('AC-1: a new process reopens the transcript with its explicit model and recovers acceptance', async () => {
  const { workspace, harness } = setup()
  const first = await harness.run(workspace, [])
  expect(await first.pool.isAccepted(first.sessionId, first.messageId)).toBe(
    true,
  )
  await first.pool.stop()
  const { ResidentOmpPool } = await import('../../src/host/residentOmp.js')
  const resumed = new ResidentOmpPool({
    agents: [{ agent: 'reviewer', cwd: workspace }],
    memoryRoot: join(workspace, '..', 'memory'),
    announce: async () => ({ status: 'queued' }),
  })
  harness.pools.push(resumed)
  expect(await resumed.isAccepted(first.sessionId, first.messageId)).toBe(true)
  expect(await resumed.isAccepted(first.sessionId, 'not-delivered')).toBe(false)
  const channel = await resumed.channelFor(first.sessionId)
  const state = (await channel.request('get_state')).data as {
    model: { provider: string; id: string }
  }
  expect(state.model).toMatchObject({ provider: 'fake', id: 'fake-model' })
  const { OmpResidentTurnPort } = await import('@qianmo/resident')
  const port = new OmpResidentTurnPort(resumed)
  const result = await port.execute(
    {
      sessionId: first.sessionId,
      messageId: 'after-restart',
      prompt: 'Continue.',
    },
    async () => {},
  )
  expect(result).toEqual({ outcome: 'completed', content: 'pong' })
  expect(await resumed.isAccepted(first.sessionId, 'after-restart')).toBe(true)
}, 30_000)

test('RPC local commands complete locally and report unsupported autocompact honestly', async () => {
  const { workspace, harness } = setup()
  const first = await harness.run(workspace, [])
  const channel = await first.pool.channelFor(first.sessionId)
  expect(
    await channel.prompt({ messageId: 'command-1', text: '/model' }),
  ).toMatchObject({ agentInvoked: false })
  expect(
    await channel.prompt({ messageId: 'command-2', text: '/thinking low' }),
  ).toMatchObject({ agentInvoked: false })
  const unsupported = await channel.prompt({
    messageId: 'command-3',
    text: '/autocompact 150k',
  })
  expect(unsupported.agentInvoked).toBe(false)
  expect(unsupported.output).toContain('unsupported')
}, 30_000)

test('read admission is durable while the model is paused, and survives SIGKILL', async () => {
  const { workspace, harness } = setup()
  const release = harness.pauseResponses()
  const options = {
    agents: [{ agent: 'reviewer', cwd: workspace }],
    memoryRoot: join(workspace, '..', 'memory'),
    announce: async () => ({ status: 'queued' }),
  }
  const pool = new ResidentOmpPool(options)
  harness.pools.push(pool)
  const sessionId = await pool.newSession(options.agents[0]!)
  const channel = await pool.channelFor(sessionId)
  const turn = new OmpResidentTurnPort(pool)
  const messageId = 'paused-input'
  let accepted = false
  let completed = false
  const result = turn
    .execute(
      { sessionId, messageId, prompt: 'Wait for a response' },
      async () => {
        // Inspect the actual JSONL while execution is still paused upstream.
        expect(await pool.isAccepted(sessionId, messageId)).toBe(true)
        accepted = true
      },
    )
    .then(
      value => {
        completed = true
        return value
      },
      error => {
        completed = true
        return error
      },
    )
  await until(() => accepted)
  expect(completed).toBe(false)
  channel.child.kill('SIGKILL')
  expect(await result).toBeInstanceOf(Error)
  release()
  await pool.stop()
  const restored = new ResidentOmpPool(options)
  harness.pools.push(restored)
  // Recovery can decide not to resubmit without starting a new model turn.
  expect(await restored.isAccepted(sessionId, messageId)).toBe(true)
  const dir = qianmoConfigPath('resident', 'sessions', 'reviewer', sessionId)
  writeFileSync(
    join(dir, 'orphan.jsonl'),
    JSON.stringify({
      type: 'custom',
      customType: 'qianmo.resident.input-identity',
      data: { messageId: 'orphan', userEntryId: 'never-persisted' },
    }) + '\n',
  )
  expect(await restored.isAccepted(sessionId, 'orphan')).toBe(false)
}, 30_000)
