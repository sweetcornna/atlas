// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FileResidentSessionStore,
  ResidentSessionManager,
  OmpResidentTurnPort,
} from '@qianmo/resident'
import {
  ResidentOmpPool,
  type ResidentOmpSpawn,
} from '../../src/host/residentOmp.js'
import { isolatedRoot } from '../providers/fake.js'
import { parseResidentArgs } from '../../src/commands/resident.js'

const fixture = join(import.meta.dir, 'fixtures/resident-omp-agent.runner.ts')
let root: ReturnType<typeof isolatedRoot> | undefined
const pools: ResidentOmpPool[] = []
const children: ChildProcess[] = []
const launches: ResidentOmpSpawn[] = []
const reaped = new WeakSet<ChildProcess>()
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.stop()
  expect(
    children.every(
      child => child.exitCode !== null || child.signalCode !== null,
    ),
  ).toBe(true)
  children.length = 0
  launches.length = 0
  root?.dispose()
  root = undefined
})
function setup(
  options: {
    idleChildMs?: number
    maxChildren?: number
    queueLimit?: number
    queueTimeoutMs?: number
    maxStartFailures?: number
    readyTimeoutMs?: number
    spawn?: (input: ResidentOmpSpawn) => ChildProcess
    env?: Record<string, string>
  } = {},
) {
  root ??= isolatedRoot()
  const agent = { agent: 'reviewer', cwd: root.root }
  const pool = new ResidentOmpPool({
    ...options,
    agents: [agent],
    memoryRoot: join(root.root, 'memory'),
    announce: async () => ({ status: 'queued' }),
    spawn: input => {
      if (options.maxChildren !== undefined)
        expect(
          children.filter(child => !reaped.has(child)).length,
        ).toBeLessThan(options.maxChildren)
      launches.push(input)
      const child =
        options.spawn?.(input) ??
        spawn(process.execPath, [fixture], {
          cwd: input.cwd,
          env: { ...input.env, ...options.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      child.once('close', () => reaped.add(child))
      children.push(child)
      return child
    },
  })
  pools.push(pool)
  return { pool, agent, root: root.root }
}
async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('lazy child condition timed out')
    await Bun.sleep(5)
  }
}
async function turn(
  pool: ResidentOmpPool,
  sessionId: string,
  messageId: string,
) {
  return new OmpResidentTurnPort(pool).execute(
    { sessionId, messageId, prompt: 'hello' },
    async () => {},
  )
}
function exited(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null
}

test('a generation registers durable owners without children; first delivery starts one and the next reuses it', async () => {
  const { pool, agent, root } = setup()
  const store = new FileResidentSessionStore(
    join(root, 'resident/sessions.json'),
  )
  const sessions = new ResidentSessionManager({
    connection: pool,
    store,
    agents: [agent],
  })
  await sessions.start()
  const id = sessions.sessionOf(agent.agent)
  expect(children).toHaveLength(0)
  expect(await pool.isAccepted(id, 'not-sent')).toBe(false)
  expect((await turn(pool, id, 'one')).outcome).toBe('completed')
  expect((await turn(pool, id, 'two')).outcome).toBe('completed')
  expect(children).toHaveLength(1)
  expect(await pool.isAccepted(id, 'one')).toBe(true)
  expect(await pool.isAccepted(id, 'two')).toBe(true)
  await pool.stop()
  const resumed = setup().pool
  const restored = new ResidentSessionManager({
    connection: resumed,
    store,
    agents: [agent],
  })
  await restored.start()
  expect(restored.sessionOf(agent.agent)).toBe(id)
  expect(children).toHaveLength(1)
  expect(await resumed.isAccepted(id, 'one')).toBe(true)
})

test('a small parsed idle budget reaps only the process and resumes the same transcript on the next delivery', async () => {
  root = isolatedRoot()
  const args = parseResidentArgs([
    '--node=n',
    '--team=t',
    `--agent=reviewer=${root.root}`,
    '--port=0',
    '--hostname=127.0.0.1',
    '--omp-idle-ms=25',
  ])
  const { pool, agent } = setup({ idleChildMs: args.ompIdleMs })
  const session = await pool.newSession(agent)
  expect((await turn(pool, session, 'before-idle')).outcome).toBe('completed')
  await until(() => exited(children[0]!))
  expect(await pool.isAccepted(session, 'before-idle')).toBe(true)
  expect((await turn(pool, session, 'after-idle')).outcome).toBe('completed')
  expect(launches.map(input => input.sessionId)).toEqual([session, session])
  expect(launches[1]!.sessionDir).toBe(launches[0]!.sessionDir)
  expect(await pool.isAccepted(session, 'before-idle')).toBe(true)
  expect(await pool.isAccepted(session, 'after-idle')).toBe(true)
})

test('capacity evicts the least recently used idle process and never overlaps its replacement', async () => {
  root = isolatedRoot()
  const args = parseResidentArgs([
    '--node=n',
    '--team=t',
    `--agent=reviewer=${root.root}`,
    '--port=0',
    '--hostname=127.0.0.1',
    '--omp-max-children',
    '2',
  ])
  const { pool, agent } = setup({ maxChildren: args.ompMaxChildren })
  const a = await pool.newSession(agent),
    b = await pool.newSession(agent),
    c = await pool.newSession(agent)
  await turn(pool, a, 'a')
  await turn(pool, b, 'b')
  await turn(pool, a, 'a-recent')
  await turn(pool, c, 'c')
  expect(children.map(exited)).toEqual([false, true, false])
  expect(await pool.isAccepted(b, 'b')).toBe(true)
  expect(launches.map(input => input.sessionId)).toEqual([a, b, c])
  expect(children.filter(child => !exited(child))).toHaveLength(2)
})

test('all busy children queue a bounded new request, then hand over capacity after the turn settles', async () => {
  const { pool, agent } = setup({
    maxChildren: 1,
    queueLimit: 1,
    queueTimeoutMs: 2_000,
    env: { QIANMO_FIXTURE_HOLD_BUSY: '1' },
  })
  const a = await pool.newSession(agent),
    b = await pool.newSession(agent),
    c = await pool.newSession(agent)
  const channel = await pool.channelFor(a)
  await channel.prompt({ messageId: 'held', text: 'hello' })
  let resolved = false
  const waiting = pool.channelFor(b).then(child => {
    resolved = true
    return child
  })
  await Bun.sleep(30)
  expect(resolved).toBe(false)
  expect(children).toHaveLength(1)
  expect(exited(children[0]!)).toBe(false)
  await expect(pool.channelFor(c)).rejects.toThrow('capacity queue is full')
  await channel.abort()
  const next = await waiting
  expect(next.alive).toBe(true)
  expect(children.map(exited)).toEqual([true, false])
  expect(pool.parkedReason).toBeUndefined()
})

test('a full busy capacity times out clearly without killing the busy child or parking the pool', async () => {
  const { pool, agent } = setup({
    maxChildren: 1,
    queueTimeoutMs: 25,
    maxStartFailures: 1,
    env: { QIANMO_FIXTURE_HOLD_BUSY: '1' },
  })
  const a = await pool.newSession(agent),
    b = await pool.newSession(agent)
  const channel = await pool.channelFor(a)
  await channel.prompt({ messageId: 'busy', text: 'hello' })
  const began = Date.now()
  await expect(pool.channelFor(b)).rejects.toThrow(
    'capacity wait timed out after 25 ms',
  )
  expect(Date.now() - began).toBeGreaterThanOrEqual(20)
  expect(exited(children[0]!)).toBe(false)
  expect(children).toHaveLength(1)
  expect(pool.parkedReason).toBeUndefined()
})

test('a child acquired for routing is protected before agent_start and releases capacity on turn end', async () => {
  const { pool, agent } = setup({
    maxChildren: 1,
    idleChildMs: 10,
    queueTimeoutMs: 1_000,
  })
  const a = await pool.newSession(agent),
    b = await pool.newSession(agent)
  const controller = new AbortController()
  await pool.channelFor(a, controller.signal)
  const waiting = pool.channelFor(b)
  await Bun.sleep(30)
  expect(children).toHaveLength(1)
  expect(exited(children[0]!)).toBe(false)
  controller.abort()
  expect((await waiting).alive).toBe(true)
  expect(children.map(exited)).toEqual([true, false])
})

test('model startup errors fail the actual turn with a reason and consecutive failures park all future sessions', async () => {
  const { pool, agent } = setup({
    maxStartFailures: 2,
    env: { QIANMO_FIXTURE_OPEN_ERROR: 'no model credential in models.yml' },
  })
  const a = await pool.newSession(agent),
    b = await pool.newSession(agent)
  for (const [id, message] of [
    [a, 'first'],
    [b, 'second'],
  ] as const) {
    await expect(turn(pool, id, message)).rejects.toThrow(
      'no model credential in models.yml',
    )
    expect(children.every(exited)).toBe(true)
  }
  expect(pool.parkedReason).toContain(
    'parked after 2 consecutive startup failures',
  )
  await expect(pool.channelFor(a)).rejects.toThrow('parked')
  await expect(pool.newSession(agent)).rejects.toThrow('parked')
  expect(children).toHaveLength(2)
})

test('watchdog abort during a lazy handshake reaps the child and does not count as a startup fault', async () => {
  const { pool, agent } = setup({
    maxStartFailures: 1,
    spawn: input =>
      spawn(
        process.execPath,
        ['-e', 'process.stdin.resume(); setInterval(()=>{},1000)'],
        { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'] },
      ),
  })
  const sessionId = await pool.newSession(agent)
  const port = new OmpResidentTurnPort(pool, { inactivity: { timeoutMs: 40 } })
  await expect(
    port.execute(
      { sessionId, messageId: 'abort-start', prompt: 'hello' },
      async () => {},
    ),
  ).rejects.toThrow('inactivity')
  await until(() => children.every(exited))
  expect(children).toHaveLength(1)
  expect(children[0]!.signalCode).toBe('SIGTERM')
  expect(pool.parkedReason).toBeUndefined()
})

test('invalidating a cold owner starts nothing; invalidating a live child reopens the same session', async () => {
  root = isolatedRoot()
  const log = join(root.root, 'opens.jsonl')
  const { pool, agent } = setup({ env: { QIANMO_FIXTURE_OPEN_LOG: log } })
  const sessionId = await pool.newSession(agent)
  await pool.invalidateAgent(agent.agent)
  expect(children).toHaveLength(0)
  await turn(pool, sessionId, 'initial')
  await pool.invalidateAgent(agent.agent)
  expect(children.every(exited)).toBe(true)
  await turn(pool, sessionId, 'resumed')
  const opens = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { sessionDir: string })
  expect(opens.map(open => open.sessionDir)).toEqual([
    launches[0]!.sessionDir,
    launches[0]!.sessionDir,
  ])
  expect(await pool.isAccepted(sessionId, 'initial')).toBe(true)
})

test('cancelling a queued start neither spawns it later nor consumes the startup failure budget', async () => {
  const { pool, agent } = setup({
    maxChildren: 1,
    maxStartFailures: 1,
    env: { QIANMO_FIXTURE_HOLD_BUSY: '1' },
  })
  const a = await pool.newSession(agent),
    b = await pool.newSession(agent)
  const channel = await pool.channelFor(a)
  await channel.prompt({ messageId: 'held-for-cancel', text: 'hello' })
  const controller = new AbortController()
  const waiting = pool.channelFor(b, controller.signal)
  void waiting.catch(() => {})
  await Bun.sleep(20)
  controller.abort(new Error('request cancelled'))
  await expect(waiting).rejects.toThrow('request cancelled')
  await channel.abort()
  await Bun.sleep(30)
  expect(children).toHaveLength(1)
  expect(pool.parkedReason).toBeUndefined()
  expect((await pool.channelFor(b)).alive).toBe(true)
  expect(children).toHaveLength(2)
})

test('a successful cold start resets consecutive failures, including a synchronous spawn failure', async () => {
  let calls = 0
  const { pool, agent } = setup({
    maxStartFailures: 2,
    spawn: input => {
      calls++
      if (calls === 1) throw new Error('omp binary unavailable')
      return spawn(process.execPath, [fixture], {
        cwd: input.cwd,
        env: {
          ...input.env,
          ...(calls >= 3
            ? { QIANMO_FIXTURE_OPEN_ERROR: 'bad model config' }
            : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    },
  })
  const id = await pool.newSession(agent)
  await expect(turn(pool, id, 'failed-spawn')).rejects.toThrow(
    'omp binary unavailable',
  )
  expect((await turn(pool, id, 'success')).outcome).toBe('completed')
  await pool.invalidateAgent(agent.agent)
  await expect(turn(pool, id, 'fail-after-success')).rejects.toThrow(
    'bad model config',
  )
  expect(pool.parkedReason).toBeUndefined()
  await expect(turn(pool, id, 'second-fail-after-success')).rejects.toThrow(
    'bad model config',
  )
  expect(pool.parkedReason).toContain('parked after 2')
  expect(calls).toBe(4)
})

test('concurrent cold callers share one start; cancelling one leaves the other caller alive', async () => {
  const { pool, agent } = setup({
    maxChildren: 1,
    maxStartFailures: 1,
    env: { QIANMO_FIXTURE_READY_DELAY_MS: '100' },
  })
  const id = await pool.newSession(agent)
  const first = new AbortController(),
    second = new AbortController()
  const opening = pool.channelFor(id, first.signal)
  void opening.catch(() => {})
  const shared = pool.channelFor(id, second.signal)
  await until(() => children.length === 1)
  first.abort(new Error('first caller cancelled'))
  await expect(opening).rejects.toThrow('first caller cancelled')
  const channel = await shared
  expect(channel.alive).toBe(true)
  expect(children).toHaveLength(1)
  expect(pool.parkedReason).toBeUndefined()
  second.abort()
})

test('invalidateAgent cancels an in-progress handshake and joins real exit without parking', async () => {
  const { pool, agent } = setup({
    maxStartFailures: 1,
    spawn: input =>
      spawn(
        process.execPath,
        ['-e', 'process.stdin.resume(); setInterval(()=>{},1000)'],
        { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'] },
      ),
  })
  const id = await pool.newSession(agent)
  const opening = pool.channelFor(id)
  void opening.catch(() => {})
  await until(() => children.length === 1)
  await pool.invalidateAgent(agent.agent)
  await expect(opening).rejects.toThrow('child exited')
  expect(reaped.has(children[0]!)).toBe(true)
  expect(children[0]!.signalCode).toBe('SIGTERM')
  expect(pool.parkedReason).toBeUndefined()
})

test('pool stop cancels queued starts and reaps its busy child without launching queued work', async () => {
  const { pool, agent } = setup({
    maxChildren: 1,
    env: { QIANMO_FIXTURE_HOLD_BUSY: '1' },
  })
  const a = await pool.newSession(agent),
    b = await pool.newSession(agent)
  const channel = await pool.channelFor(a)
  await channel.prompt({ messageId: 'busy-on-stop', text: 'hello' })
  const waiting = pool.channelFor(b)
  void waiting.catch(() => {})
  await Bun.sleep(20)
  await pool.stop()
  await expect(waiting).rejects.toThrow('pool is closed')
  expect(children).toHaveLength(1)
  expect(reaped.has(children[0]!)).toBe(true)
})

test('a signalled child cannot be replaced in the same pool before actual close frees its slot', async () => {
  const { pool, agent } = setup({ maxChildren: 1 })
  const id = await pool.newSession(agent)
  const channel = await pool.channelFor(id)
  channel.child.kill('SIGTERM')
  await expect(pool.channelFor(id)).rejects.toThrow('child closed before reuse')
  expect(children).toHaveLength(1)
  await pool.stop()
  expect(reaped.has(children[0]!)).toBe(true)
})
