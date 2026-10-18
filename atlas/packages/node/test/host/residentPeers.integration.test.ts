// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Two agents on one node ask each other (P36.6), end to end: a real resident
 * with fixture omp children, the hub's real chat face and control links, and
 * the hub's question service. The asking turn holds the node's one turn while
 * it waits, so the answer gets through only by nesting along the call chain
 * the hub signs; with nothing signed the same question waits out its timeout.
 */

import { afterEach, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateNodeKeyPair,
  StaticPublicKeyDirectory,
  type NodeKeyPair,
} from '@qianmo/capability'
import type { ConsoleAgent, ConsoleResult, RegistryPort } from '@qianmo/console'
import {
  createConsoleChatPort,
  type ConsoleChatHub,
} from '../../src/commands/consoleChat.js'
import { ControlLinks } from '../../src/commands/consoleControl.js'
import { ConsolePeers } from '../../src/commands/consolePeers.js'
import { QianmoResident } from '../../src/host/resident.js'

const PSK = 'resident-peers-not-a-real-secret-0000'
const FIXTURE = join(
  import.meta.dir,
  'fixtures',
  'resident-omp-agent.runner.ts',
)
const ALPHA = 'qianmo://node-b/alpha'
const BETA = 'qianmo://node-b/beta'
const HUB = 'qianmo://hub/console'

const children: ChildProcess[] = []
const cleanups: (() => Promise<void> | void)[] = []
let root: string | undefined
let previousConfigDir: string | undefined

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
  if (previousConfigDir === undefined) delete process.env.QIANMO_CONFIG_DIR
  else process.env.QIANMO_CONFIG_DIR = previousConfigDir
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

async function until(
  check: () => boolean | Promise<boolean>,
  ms = 20_000,
): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met')
    await Bun.sleep(20)
  }
}

class Registry implements RegistryPort {
  constructor(readonly endpoint: string) {}
  list(): Promise<ConsoleResult<readonly ConsoleAgent[]>> {
    return Promise.resolve({
      ok: true,
      value: [ALPHA, BETA].map(address => ({
        address,
        endpoint: this.endpoint,
        capabilities: [],
        status: 'online',
        registeredAt: 1,
        lastHeartbeatAt: 2,
        expiresAt: Date.now() + 60_000,
      })),
    })
  }
  register(): never {
    throw new Error('not used here')
  }
  deregister(): never {
    throw new Error('not used here')
  }
  heartbeat(): never {
    throw new Error('not used here')
  }
}

/**
 * A node with two agents whose fixture answers `QIANMO-ASK <address>` by
 * asking it, and a hub. `sign` false: the hub's chat face signs nothing.
 * `maxChildren` is the node's `--omp-max-children`; `hold` names an agent
 * whose turns never end on their own (only a stop ends them).
 */
async function network(options: {
  sign: boolean
  askTimeoutSec?: number
  maxChildren?: number
  hold?: string
}) {
  root = mkdtempSync(join(tmpdir(), 'qianmo-peers-'))
  previousConfigDir = process.env.QIANMO_CONFIG_DIR
  process.env.QIANMO_CONFIG_DIR = join(root, 'config')
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const hubKeys: NodeKeyPair = generateNodeKeyPair()
  const nodeKeys: NodeKeyPair = generateNodeKeyPair()
  let url: string | undefined
  let ready = false
  const errors: unknown[] = []
  /** Which agent each fixture child was started for, and the most alive at once. */
  const spawned: string[] = []
  /** Each turn stage the node reports, with the agent it was for. */
  const timings: { stage: string; agent?: string }[] = []
  let alive = 0
  let mostAlive = 0
  const resident = new QianmoResident({
    node: 'node-b',
    team: 'nest',
    agents: [
      { agent: 'alpha', cwd: workspace },
      { agent: 'beta', cwd: workspace },
    ],
    pollIntervalMs: 20,
    psk: PSK,
    listen: { hostname: '127.0.0.1', port: 0 },
    handshakeSigning: {
      node: 'node-b',
      keys: nodeKeys,
      directory: new StaticPublicKeyDirectory([
        ['hub', hubKeys.publicKey],
        ['node-b', nodeKeys.publicKey],
      ]),
      required: false,
    },
    controllers: new Set(['hub']),
    memoryControllers: new Map([['hub', hubKeys.publicKey]]),
    ...(options.maxChildren === undefined
      ? {}
      : { ompMaxChildren: options.maxChildren }),
    spawnOmp: input => {
      const child = spawn(process.execPath, [FIXTURE], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: {
          ...input.env,
          QIANMO_FIXTURE_ASK: '1',
          ...(options.askTimeoutSec === undefined
            ? {}
            : {
                QIANMO_FIXTURE_ASK_TIMEOUT_SEC: String(options.askTimeoutSec),
              }),
          ...(options.hold === input.agent
            ? { QIANMO_FIXTURE_HOLD_BUSY: '1' }
            : {}),
        },
      })
      children.push(child)
      spawned.push(input.agent)
      mostAlive = Math.max(mostAlive, ++alive)
      child.once('exit', () => {
        alive--
      })
      return child
    },
    onReady: address => {
      url = address.url
    },
    onTiming: event => {
      timings.push({ stage: event.stage, agent: event.agent })
      if (event.stage === 'runtime_ready') ready = true
    },
    onError: error => errors.push(error),
  })
  const running = resident.run()
  cleanups.push(async () => {
    resident.stop()
    await running
  })
  await until(() => url !== undefined && ready)
  const control = new ControlLinks({
    from: HUB,
    commandKeys: hubKeys,
    targets: [
      { node: 'node-b', url: url!, publicKey: nodeKeys.publicKey, psk: PSK },
    ],
    onError: error => errors.push(error),
  })
  cleanups.push(() => control.close())
  const chat: ConsoleChatHub = createConsoleChatPort({
    from: HUB,
    endpoints: [{ url: url!, psk: PSK, node: 'node-b' }],
    storePath: join(root, 'hub', 'chat.ndjson'),
    registry: new Registry(url!),
    ...(options.sign ? { ownerSigningKeys: hubKeys } : {}),
  })
  cleanups.push(() => chat.close())
  const stopped: string[] = []
  const peers = new ConsolePeers({
    directory: join(root, 'hub', 'peers'),
    chat,
    control,
    stopTask: async (target, taskId) => {
      stopped.push(taskId)
      const outcome = await control.request(
        'node-b',
        'turn.stop',
        { taskId },
        'peers',
        { timeoutMs: 10_000 },
      )
      return outcome.ok
    },
  })
  cleanups.push(() => peers.close())
  control.onHubCall('peers', peers.handle)
  peers.start()
  control.start()
  await until(() => control.status()[0]?.connected === true)

  /** A person's line to `target`, not waited for: its conversation and task. */
  async function start(target: string, text: string) {
    const opened = await chat.open(target)
    if (!opened.ok) throw new Error(opened.failure.message)
    const sent = await chat.send({
      sessionId: opened.value.id,
      text,
      onBehalfOf: 'legacy:admin',
    })
    if (!sent.ok) throw new Error(sent.failure.message)
    return { sessionId: opened.value.id, taskId: sent.value.taskId! }
  }

  /** A person's line to `target`; resolves with the agent's answer. */
  async function say(target: string, text: string) {
    const opened = await chat.open(target)
    if (!opened.ok) throw new Error(opened.failure.message)
    const sent = await chat.send({
      sessionId: opened.value.id,
      text,
      onBehalfOf: 'legacy:admin',
    })
    if (!sent.ok) throw new Error(sent.failure.message)
    let reply: { text: string; state: string } | undefined
    await until(async () => {
      const transcript = await chat.transcript(opened.value.id)
      reply = transcript.ok
        ? transcript.value.turns.find(
            turn =>
              turn.author === 'agent' &&
              turn.variant !== 'notice' &&
              turn.taskId === sent.value.taskId &&
              (turn.state === 'done' || turn.state === 'failed'),
          )
        : undefined
      return reply !== undefined
    }, 60_000)
    return reply!
  }

  return {
    resident,
    chat,
    control,
    start,
    say,
    stopped,
    errors,
    spawned,
    timings,
    mostAlive: () => mostAlive,
  }
}

function answersIn(reply: string): unknown {
  const json = reply.slice(reply.indexOf('ask=') + 'ask='.length)
  return JSON.parse(json)
}

test('two agents on one node ask each other, each answer nested in the asking turn', async () => {
  const { resident, chat, say, errors } = await network({ sign: true })
  let deepest = 0
  const watch = setInterval(() => {
    deepest = Math.max(deepest, resident.gate.depth)
  }, 2)
  cleanups.push(() => clearInterval(watch))
  const started = Date.now()
  const first = await say(ALPHA, `please QIANMO-ASK ${BETA} now`)
  expect(first.state).toBe('done')
  expect(answersIn(first.text)).toEqual({
    answers: [{ agent: BETA, ok: true, reply: 'fixture response' }],
  })
  // The other way round, one level deep as well.
  const second = await say(BETA, `please QIANMO-ASK ${ALPHA} now`)
  expect(answersIn(second.text)).toEqual({
    answers: [{ agent: ALPHA, ok: true, reply: 'fixture response' }],
  })
  // Answered by nesting, not by waiting out the 60 s question.
  expect(Date.now() - started).toBeLessThan(30_000)
  expect(deepest).toBe(2)
  // The hub has the answer a moment before the node's turn lets go of the
  // gate (it waits for the hub's receipt of that answer).
  await until(() => resident.gate.depth === 0, 5_000)
  // Each asked agent got the question in a conversation of its own, marked
  // with who asked.
  const sessions = await chat.sessions()
  if (!sessions.ok) throw new Error('sessions')
  const titles = sessions.value.map(one => `${one.target} ${one.title ?? ''}`)
  expect(
    titles.some(one => one.startsWith(`${BETA} 来自 ${ALPHA} 的提问`)),
  ).toBe(true)
  expect(
    titles.some(one => one.startsWith(`${ALPHA} 来自 ${BETA} 的提问`)),
  ).toBe(true)
  expect(errors).toEqual([])
}, 60_000)

test('without a signed chain the same question waits behind the asker until it times out', async () => {
  const { say, stopped } = await network({ sign: false, askTimeoutSec: 3 })
  const started = Date.now()
  const reply = await say(ALPHA, `please QIANMO-ASK ${BETA} now`)
  expect(answersIn(reply.text)).toMatchObject({
    answers: [{ agent: BETA, ok: false, code: 'timeout' }],
  })
  expect(Date.now() - started).toBeGreaterThanOrEqual(3_000)
  // The late turn was asked to stop; it had not even started.
  expect(stopped).toHaveLength(1)
}, 60_000)

test('with one process allowed, the nested answer is refused busy at once instead of waiting for a slot', async () => {
  const { resident, say, spawned, mostAlive } = await network({
    sign: true,
    maxChildren: 1,
  })
  const started = Date.now()
  const reply = await say(ALPHA, `please QIANMO-ASK ${BETA} now`)
  expect(reply.state).toBe('done')
  expect(answersIn(reply.text)).toMatchObject({
    answers: [{ agent: BETA, ok: false, code: 'busy' }],
  })
  // Not the pool's 30 s capacity wait.
  expect(Date.now() - started).toBeLessThan(15_000)
  // Nothing was started for the question, then or later: no second process
  // past the limit, and no turn of BETA's left to run once ALPHA is done.
  await Bun.sleep(1_500)
  expect(spawned).toEqual(['alpha'])
  expect(mostAlive()).toBe(1)
  expect(resident.gate.depth).toBe(0)
  expect(resident.gate.queued).toBe(0)
}, 60_000)

test('with two processes allowed the same question nests and is answered', async () => {
  const { resident, say, mostAlive } = await network({
    sign: true,
    maxChildren: 2,
  })
  const reply = await say(ALPHA, `please QIANMO-ASK ${BETA} now`)
  expect(answersIn(reply.text)).toEqual({
    answers: [{ agent: BETA, ok: true, reply: 'fixture response' }],
  })
  expect(mostAlive()).toBe(2)
  await until(() => resident.gate.depth === 0, 5_000)
}, 60_000)

test('an asker stopped while its nested answer runs: the hub stops the answer too, and the gate is free at once', async () => {
  const { resident, control, start, say, stopped, timings } = await network({
    sign: true,
    hold: 'beta',
  })
  const asker = await start(ALPHA, `please QIANMO-ASK ${BETA} now`)
  // BETA's answer is running, nested in ALPHA's turn, and never ends alone.
  await until(
    () =>
      resident.gate.depth === 2 &&
      timings.some(one => one.stage === 'admitted' && one.agent === 'beta'),
  )
  const halted = Date.now()
  const outcome = await control.request(
    'node-b',
    'turn.stop',
    { taskId: asker.taskId },
    'test',
    { timeoutMs: 10_000 },
  )
  expect(outcome).toMatchObject({ ok: true, value: { stopped: true } })
  // Not the question's 60 s: the hub withdrew it and stopped BETA's turn.
  await until(() => resident.gate.depth === 0, 15_000)
  expect(Date.now() - halted).toBeLessThan(15_000)
  expect(stopped).toHaveLength(1)
  // The node takes ordinary turns again straight away.
  const next = await say(ALPHA, 'hello')
  expect(next.state).toBe('done')
  expect(Date.now() - halted).toBeLessThan(20_000)
}, 60_000)
