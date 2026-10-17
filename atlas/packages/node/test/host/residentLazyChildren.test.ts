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

test('after every caller cancels a handshake, an immediate same-session retry waits for real close and starts afresh', async () => {
  const { pool, agent } = setup({
    maxChildren: 1,
    maxStartFailures: 1,
    env: { QIANMO_FIXTURE_READY_DELAY_MS: '100' },
  })
  const id = await pool.newSession(agent)
  const first = new AbortController(),
    second = new AbortController()
  const one = pool.channelFor(id, first.signal)
  const two = pool.channelFor(id, second.signal)
  void one.catch(() => {})
  void two.catch(() => {})
  await until(() => children.length === 1)
  first.abort(new Error('first cancelled'))
  second.abort(new Error('last cancelled'))
  // No await between the last cancellation and retry: the old child still
  // owns its slot and its opening has not finished unwinding.
  expect(reaped.has(children[0]!)).toBe(false)
  const retry = pool.channelFor(id)
  void retry.catch(() => {})
  await expect(one).rejects.toThrow('first cancelled')
  await expect(two).rejects.toThrow('last cancelled')
  expect((await retry).alive).toBe(true)
  expect(children).toHaveLength(2)
  expect(reaped.has(children[0]!)).toBe(true)
  expect(pool.parkedReason).toBeUndefined()
  expect((await turn(pool, id, 'retry')).outcome).toBe('completed')
  expect(children).toHaveLength(2)
})

test('pre-ready stderr explains startup failure and parking without exposing keys or an unbounded log', async () => {
  const secrets = [
    'sk-short-fake-key',
    'bearer-fake-value',
    'ab'.repeat(40),
    'QWxhZGRpbjpvcGVu'.repeat(6),
  ]
  const log = `old startup line\n${'noise '.repeat(800)}\n${'sk-x '.repeat(300)}\nmissing models.yml: configure a provider\nkey=${secrets[0]}\nBearer ${secrets[1]}\nhex=${secrets[2]}\nbase64=${secrets[3]}\n`
  const { pool, agent } = setup({
    maxStartFailures: 1,
    spawn: input =>
      spawn(
        process.execPath,
        [
          '-e',
          'process.stderr.write(process.env.FAKE_STARTUP_LOG, () => process.exit(1))',
        ],
        {
          cwd: input.cwd,
          env: { ...input.env, FAKE_STARTUP_LOG: log },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      ),
  })
  const id = await pool.newSession(agent)
  const error = await turn(pool, id, 'stderr').catch((error: unknown) => error)
  expect(error).toBeInstanceOf(Error)
  const reason = (error as Error).message
  expect(reason).toContain('missing models.yml: configure a provider')
  expect(reason).toContain('child exited code=1')
  expect(reason).not.toContain('old startup line')
  expect(Buffer.byteLength(reason)).toBeLessThanOrEqual(2300)
  expect(pool.parkedReason).toContain(
    'missing models.yml: configure a provider',
  )
  for (const secret of secrets) {
    expect(reason).not.toContain(secret)
    expect(pool.parkedReason).not.toContain(secret)
  }
  await expect(pool.channelFor(id)).rejects.toThrow('missing models.yml')
})

test('the default five startup failures survive idle, cancelled handshakes, queue full and queue timeout', async () => {
  let calls = 0
  const { pool, agent } = setup({
    maxChildren: 1,
    queueLimit: 1,
    queueTimeoutMs: 80,
    spawn: input => {
      calls++
      return spawn(
        process.execPath,
        calls === 3
          ? ['-e', 'process.stdin.resume(); setInterval(()=>{},1000)']
          : [fixture],
        {
          cwd: input.cwd,
          env: {
            ...input.env,
            QIANMO_FIXTURE_OPEN_ERROR: 'mixed bad model config',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
    },
  })
  const id = await pool.newSession(agent)
  const held = await pool.newSession(agent)
  const queued = await pool.newSession(agent)
  const overflow = await pool.newSession(agent)
  for (let failure = 0; failure < 2; failure++)
    await expect(pool.channelFor(id)).rejects.toThrow('mixed bad model config')
  await Bun.sleep(30)
  const controller = new AbortController()
  const opening = pool.channelFor(held, controller.signal)
  void opening.catch(() => {})
  await until(() => children.length === 3)
  const queuedController = new AbortController()
  const waiting = pool.channelFor(queued, queuedController.signal)
  void waiting.catch(() => {})
  // One microtask starts the queued opening before the overflow request.
  await Promise.resolve()
  await expect(pool.channelFor(overflow)).rejects.toThrow(
    'capacity queue is full',
  )
  queuedController.abort(new Error('queued caller cancelled'))
  await expect(waiting).rejects.toThrow('queued caller cancelled')
  await expect(pool.channelFor(queued)).rejects.toThrow(
    'capacity wait timed out',
  )
  expect(children).toHaveLength(3)
  expect(reaped.has(children[2]!)).toBe(false)
  controller.abort(new Error('handshake caller cancelled'))
  await expect(opening).rejects.toThrow('handshake caller cancelled')
  await until(() => reaped.has(children[2]!))
  for (let failure = 3; failure <= 5; failure++) {
    await expect(pool.channelFor(id)).rejects.toThrow('mixed bad model config')
    if (failure < 5) expect(pool.parkedReason).toBeUndefined()
  }
  expect(pool.parkedReason).toContain(
    'parked after 5 consecutive startup failures',
  )
  await expect(pool.channelFor(overflow)).rejects.toThrow('parked after 5')
  expect(calls).toBe(6) // Five real failures and one cancelled handshake.
})

test('a successful startup resets the default failure budget even before a round completes', async () => {
  let calls = 0
  const { pool, agent } = setup({
    spawn: input => {
      calls++
      return spawn(process.execPath, [fixture], {
        cwd: input.cwd,
        env: {
          ...input.env,
          ...(calls === 5
            ? {}
            : { QIANMO_FIXTURE_OPEN_ERROR: 'reset bad config' }),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    },
  })
  const id = await pool.newSession(agent)
  for (let i = 0; i < 4; i++)
    await expect(pool.channelFor(id)).rejects.toThrow('reset bad config')
  expect((await pool.channelFor(id)).alive).toBe(true)
  await pool.invalidateAgent(agent.agent)
  for (let i = 0; i < 4; i++) {
    await expect(pool.channelFor(id)).rejects.toThrow('reset bad config')
    expect(pool.parkedReason).toBeUndefined()
  }
  await expect(pool.channelFor(id)).rejects.toThrow('reset bad config')
  expect(pool.parkedReason).toContain(
    'parked after 5 consecutive startup failures',
  )
  expect(calls).toBe(10)
})

test('pool health counts actual ready runtime and completed rounds, retaining evidence across idle reaping', async () => {
  const { pool, agent } = setup()
  const id = await pool.newSession(agent)
  await Bun.sleep(30)
  expect(pool.isStable(20)).toBe(false)
  await pool.channelFor(id)
  expect(pool.isStable(10_000)).toBe(false)
  await Bun.sleep(30)
  expect(pool.isStable(20)).toBe(true)
  await pool.invalidateAgent(agent.agent)
  expect(pool.isStable(20)).toBe(true)
  expect(pool.isStable(10_000)).toBe(false)
  expect((await turn(pool, id, 'healthy-round')).outcome).toBe('completed')
  expect(pool.isStable(10_000)).toBe(true)
  await pool.invalidateAgent(agent.agent)
  expect(pool.isStable(10_000)).toBe(true)
})

test('timer idle reaping retains ready-runtime health and completed-round health, while a new generation starts cold', async () => {
  const { pool, agent } = setup({ idleChildMs: 60 })
  const id = await pool.newSession(agent)
  await pool.channelFor(id)
  await until(() => reaped.has(children[0]!))
  expect(pool.isStable(30)).toBe(true)
  expect(pool.isStable(60_000)).toBe(false)
  await turn(pool, id, 'healthy-before-timer')
  await until(() => reaped.has(children[1]!))
  expect(pool.isStable(60_000)).toBe(true)
  await pool.stop()
  const next = setup().pool
  await next.resumeSession({ ...agent, sessionId: id })
  expect(next.isStable(30)).toBe(false)
  expect(next.isStable(60_000)).toBe(false)
})

test('LRU reaping retains ready-runtime and completed-round health without transferring it to a new generation', async () => {
  const { pool, agent } = setup({ maxChildren: 1 })
  const a = await pool.newSession(agent),
    b = await pool.newSession(agent)
  await pool.channelFor(a)
  await Bun.sleep(550)
  const replacement = await pool.channelFor(b)
  expect(reaped.has(children[0]!)).toBe(true)
  // Exclude the replacement's own ready time as a possible health source.
  expect(replacement.readyRuntimeMs).toBeLessThan(500)
  expect(pool.isStable(500)).toBe(true)
  expect(pool.isStable(60_000)).toBe(false)
  await turn(pool, b, 'healthy-before-lru')
  await pool.channelFor(a)
  expect(reaped.has(children[1]!)).toBe(true)
  expect(pool.isStable(60_000)).toBe(true)
  await pool.stop()
  const next = setup({ maxChildren: 1 }).pool
  await next.resumeSession({ ...agent, sessionId: b })
  expect(next.isStable(30)).toBe(false)
  expect(next.isStable(60_000)).toBe(false)
})

test.each([
  'completed',
  'failed',
  'aborted',
])('a %s result with sessionSettled:false grants health only after a successful round truly settles', async status => {
  const { pool, agent } = setup({
    env: {
      QIANMO_FIXTURE_DEFER_SETTLED: '1',
      QIANMO_FIXTURE_RESULT_STATUS: status,
    },
  })
  const id = await pool.newSession(agent)
  const channel = await pool.channelFor(id)
  let result = false
  channel.onFrame(frame => {
    if (frame.type === 'prompt_result') result = true
  })
  await channel.prompt({ messageId: `deferred-${status}`, text: 'hello' })
  await until(() => result)
  expect(pool.isStable(60_000)).toBe(false)
  await channel.request('fixture_settle')
  expect(pool.isStable(60_000)).toBe(status === 'completed')
})

test('invalidateAgent leaves a handshake in progress to serve its turn, then retires the child (P32 audit 4)', async () => {
  const { pool, agent } = setup({
    maxStartFailures: 1,
    env: { QIANMO_FIXTURE_READY_DELAY_MS: '150' },
  })
  const id = await pool.newSession(agent)
  const running = turn(pool, id, 'during-start')
  await until(() => children.length === 1)
  await pool.invalidateAgent(agent.agent)
  expect(exited(children[0]!)).toBe(false)
  expect((await running).outcome).toBe('completed')
  await until(() => exited(children[0]!))
  expect(children[0]!.signalCode).not.toBe('SIGKILL')
  expect(pool.parkedReason).toBeUndefined()
  expect((await turn(pool, id, 'after')).outcome).toBe('completed')
  expect(children).toHaveLength(2)
})

test('invalidateAgent does not interrupt a running turn; the stale child closes when the turn ends (P32 audit 4)', async () => {
  const { pool, agent } = setup({
    env: { QIANMO_FIXTURE_PROGRESS_BATCH: '1' },
  })
  // The fixture holds the turn until it is told to finish.
  const finish = async <T>(child: ChildProcess, running: Promise<T>) => {
    let done = false
    void running.finally(() => {
      done = true
    })
    while (!done) {
      child.stdin!.write(
        `${JSON.stringify({ type: 'fixture_finish_progress' })}\n`,
      )
      await Bun.sleep(20)
    }
    return running
  }
  const id = await pool.newSession(agent)
  const running = turn(pool, id, 'long-turn')
  await until(() => children.length === 1)
  await Bun.sleep(100)
  await pool.invalidateAgent(agent.agent)
  await Bun.sleep(50)
  expect(exited(children[0]!)).toBe(false)
  expect(await finish(children[0]!, running)).toEqual({
    outcome: 'completed',
    content: 'progress batch complete',
  })
  await until(() => exited(children[0]!))
  // An idle child of the same agent closes at once on the next change.
  const next = turn(pool, id, 'next')
  await until(() => children.length === 2)
  expect((await finish(children[1]!, next)).outcome).toBe('completed')
  await pool.invalidateAgent(agent.agent)
  expect(exited(children[1]!)).toBe(true)
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
