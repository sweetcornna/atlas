// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Provider hot switch on a resident (design `providers-console-m1.md` §2.7,
 * P18.3), against real ACP child *processes* — the stub agent in
 * `fixtures/resident-acp-agent.runner.ts` — and the real P18.2 write path
 * (`providers/node.ts`) on a temporary config root.
 *
 * What the stub agent cannot say is which model a resumed session is pinned
 * to; that half runs the real `--acp` child, in
 * `residentProviderSwitch.integration.test.ts`.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MessageType,
  createMessage,
  isTaskResultPayload,
  type QianmoMessage,
} from '@qianmo/protocol'
import type { ResidentTimingEvent } from '@qianmo/resident'
import { TransportClient } from '@qianmo/transport'
import { resetSettingsCache } from '../../../utils/settings/settingsCache.js'
import * as providerNode from '../providers/node.js'
import { applyRequest } from '../providers/__tests__/helpers.js'
import {
  QianmoResident,
  type ResidentProviderSwitchEvent,
} from '../resident.js'
import { residentAcpEnvironment } from '../residentAcpEnv.js'

const PSK = 'resident-provider-switch-not-a-real-secret'
const TEAM = 'nest'
const AGENT = 'reviewer'
const ACP_FIXTURE = join(
  import.meta.dir,
  'fixtures',
  'resident-acp-agent.runner.ts',
)
const TEST_TIMEOUT_MS = 30_000

class ManualClock {
  #now = 1_000_000
  readonly now = (): number => this.#now
  advance(ms: number): void {
    this.#now += ms
  }
}

let root: string | undefined
let previousConfigDir: string | undefined
const children: ChildProcess[] = []
const clients: TransportClient[] = []
let activeResident: QianmoResident | undefined
let activeRun: Promise<void> | undefined

afterEach(async () => {
  activeResident?.stop()
  await activeRun
  activeResident = undefined
  activeRun = undefined
  for (const client of clients.splice(0)) await client.close()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
  }
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  resetSettingsCache()
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

function isAlive(child: ChildProcess | undefined): boolean {
  return (
    child !== undefined &&
    !child.killed &&
    child.exitCode === null &&
    child.signalCode === null
  )
}

/** A node config root the way the write path insists on it: 0700. */
function setUpNode(name: string): { config: string; socket: string } {
  root = mkdtempSync(join(tmpdir(), `qm-ps-${name}-`))
  const config = join(root, 'config')
  mkdirSync(config, { mode: 0o700 })
  chmodSync(config, 0o700)
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  resetSettingsCache()
  return { config, socket: join(root, 'r.sock') }
}

/** Stage an apply the way `qm provider serve-stdin` will (P18.7). */
function stage(overrides: Parameters<typeof applyRequest>[0] = {}): string {
  const managed = providerNode.readProviderState().managed
  const result = providerNode.stageProviderApply(
    applyRequest({
      expect: {
        ownedHash: managed ? providerNode.currentManagedHash() : null,
      },
      ...overrides,
    }),
  )
  if (!result.ok) throw new Error(JSON.stringify(result))
  expect(result.pending).toBe(true)
  return result.requestId
}

interface Harness {
  readonly resident: QianmoResident
  readonly spawned: ChildProcess[]
  readonly spawnEnvs: string[]
  readonly ready: () => number
  readonly alerts: string[]
  readonly errors: unknown[]
  readonly switches: ResidentProviderSwitchEvent[]
  readonly timings: ResidentTimingEvent[]
}

function startResident(
  socket: string,
  options: {
    readonly holdBusy?: boolean
    readonly clock?: ManualClock
    readonly pollIntervalMs?: number
    readonly maxRapidFailures?: number
    /** Mailbox poll interval. Default 20 ms. */
    readonly mailboxPollMs?: number
  } = {},
): Harness {
  const spawned: ChildProcess[] = []
  const spawnEnvs: string[] = []
  const alerts: string[] = []
  const errors: unknown[] = []
  const switches: ResidentProviderSwitchEvent[] = []
  const timings: ResidentTimingEvent[] = []
  const memoryRoot = join(root as string, 'memory')
  const resident = new QianmoResident({
    node: 'node-b',
    team: TEAM,
    agents: [{ agent: AGENT, cwd: join(root as string, 'workspace') }],
    pollIntervalMs: options.mailboxPollMs ?? 20,
    psk: PSK,
    listen: { unix: socket },
    memoryRoot,
    inactivityMs: 0,
    acpRestart: {
      initialBackoffMs: 10,
      ...(options.maxRapidFailures === undefined
        ? {}
        : { maxRapidFailures: options.maxRapidFailures }),
    },
    spawnAcp: () => {
      // The environment the production spawn (`defaultSpawnAcp`) would hand
      // this child, captured at the moment it would hand it.
      spawnEnvs.push(
        JSON.stringify(residentAcpEnvironment(process.env, { memoryRoot })),
      )
      const child = spawn(process.execPath, [ACP_FIXTURE], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env:
          options.holdBusy === true
            ? { ...process.env, QIANMO_FIXTURE_HOLD_BUSY: '1' }
            : process.env,
      })
      children.push(child)
      spawned.push(child)
      return child
    },
    providerNode,
    providerSwitch: {
      pollIntervalMs: options.pollIntervalMs ?? 0,
      ...(options.clock === undefined ? {} : { now: options.clock.now }),
    },
    onProviderAlert: message => alerts.push(message),
    onProviderSwitched: event => switches.push(event),
    onError: error => errors.push(error),
    onTiming: event => timings.push(event),
  })
  activeResident = resident
  activeRun = resident.run()
  return {
    resident,
    spawned,
    spawnEnvs,
    ready: () => timings.filter(event => event.stage === 'acp_ready').length,
    alerts,
    errors,
    switches,
    timings,
  }
}

/**
 * A mailbox poll interval that leaves each generation exactly one poll: the
 * one scheduled when it is ready. Once that poll has finished, the node is
 * idle until the test itself sends work.
 */
const ONE_POLL_PER_GENERATION_MS = 60 * 60_000

/**
 * Check for a pending configuration until `done()` holds.
 *
 * A check that lands while a mailbox poll is running is deferred, by design:
 * `#inFlightWork` counts polls, because one may admit a turn. With the
 * provider poll off nothing checks again, so a single check can be lost; at
 * the default 20 ms a poll is nearly always running on a loaded machine (CI
 * run 37137331132 recorded `polls: 1` and nothing else). Start the node with
 * {@link ONE_POLL_PER_GENERATION_MS} and the first check that finds it idle is
 * the one that makes `done()` true.
 */
async function checkUntil(node: Harness, done: () => boolean): Promise<void> {
  await waitUntil(() => {
    node.resident.checkProviderConfig()
    return done()
  })
}

async function connect(
  socket: string,
): Promise<{ client: TransportClient; replies: QianmoMessage[] }> {
  const replies: QianmoMessage[] = []
  const client = new TransportClient({
    endpoint: { unix: socket },
    node: 'node-a',
    psk: PSK,
    backoff: { baseDelayMs: 20, maxDelayMs: 100, jitterRatio: 0 },
    keepAliveIntervalMs: 0,
    onMessage: message => {
      replies.push(message)
    },
  })
  clients.push(client)
  await client.connect()
  return { client, replies }
}

function task(round: string): QianmoMessage {
  return createMessage({
    from: 'qianmo://node-a/planner',
    to: 'qianmo://node-b/reviewer',
    type: MessageType.TaskRequest,
    payload: { round },
  })
}

function resultFor(
  replies: readonly QianmoMessage[],
  request: QianmoMessage,
): QianmoMessage | undefined {
  return replies.find(
    reply =>
      reply.type === MessageType.TaskResult && reply.taskId === request.taskId,
  )
}

function sessionsFile(config: string): string {
  return join(config, 'resident', 'sessions.json')
}

function defaultSessionId(config: string): string {
  const stored = JSON.parse(
    readFileSync(sessionsFile(config), 'utf8'),
  ) as Record<string, { sessionId: string }>
  const entries = Object.values(stored)
  expect(entries).toHaveLength(1)
  return (entries[0] as { sessionId: string }).sessionId
}

describe('resident provider hot switch (P18.3)', () => {
  test(
    'with no pending intent: no recycle, no env change, settings and sessions untouched',
    async () => {
      // The three fleet nodes have no pending file. This locks what they see
      // after this change: one ACP child for the whole life, the same
      // environment handed to it, no write to settings.json or sessions.json,
      // and exactly one new file — generation.json.
      const { config, socket } = setUpNode('no-pending')
      const settingsBytes = `${JSON.stringify(
        { env: { MY_TOOL_FLAG: 'on' }, permissions: { allow: [] } },
        null,
        2,
      )}\n`
      writeFileSync(join(config, 'settings.json'), settingsBytes, {
        mode: 0o600,
      })
      const envBefore = JSON.stringify(process.env)
      const node = startResident(socket, { pollIntervalMs: 5 })
      await waitUntil(() => node.ready() === 1)
      const { client, replies } = await connect(socket)

      const first = task('ordinary work')
      await client.sendAndWait(first)
      await waitUntil(() => resultFor(replies, first) !== undefined)
      const sessionsBytes = readFileSync(sessionsFile(config), 'utf8')

      // Dozens of 5 ms polls, plus what a SIGHUP would do.
      await new Promise(resolve => setTimeout(resolve, 300))
      for (let i = 0; i < 5; i++) node.resident.checkProviderConfig()
      const second = task('more ordinary work')
      await client.sendAndWait(second)
      await waitUntil(() => resultFor(replies, second) !== undefined)
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(node.spawned).toHaveLength(1)
      expect(isAlive(node.spawned[0])).toBe(true)
      expect(node.ready()).toBe(1)
      expect(JSON.stringify(process.env)).toBe(envBefore)
      expect(node.spawnEnvs).toHaveLength(1)
      expect(
        JSON.stringify(
          residentAcpEnvironment(process.env, {
            memoryRoot: join(root as string, 'memory'),
          }),
        ),
      ).toBe(node.spawnEnvs[0] as string)
      expect(readFileSync(join(config, 'settings.json'), 'utf8')).toBe(
        settingsBytes,
      )
      expect(readFileSync(sessionsFile(config), 'utf8')).toBe(sessionsBytes)
      expect(readdirSync(join(config, 'qianmo', 'provider'))).toEqual([
        'generation.json',
      ])
      expect(existsSync(join(config, 'resident', 'provider-switch.json'))).toBe(
        false,
      )
      const generation = JSON.parse(
        readFileSync(
          join(config, 'qianmo', 'provider', 'generation.json'),
          'utf8',
        ),
      ) as { generation: number; loadedHash: string }
      expect(generation.generation).toBe(1)
      expect(generation.loadedHash).toBe(providerNode.currentManagedHash())
      expect(node.alerts).toEqual([])
      expect(node.switches).toEqual([])
      expect(node.errors).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'two recycles in a row do not park the agent; reset opens a new session, keep resumes it',
    async () => {
      const { config, socket } = setUpNode('two-recycles')
      // Two rapid *failures* would park this node. Two recycles must not.
      const node = startResident(socket, { maxRapidFailures: 2 })
      await waitUntil(() => node.ready() === 1)
      const firstSession = defaultSessionId(config)
      const firstChild = node.spawned[0]

      const reset = stage({ recycle: { sessions: 'reset' } })
      node.resident.checkProviderConfig()
      await waitUntil(() => node.ready() === 2)
      expect(node.switches).toEqual([
        {
          requestId: reset,
          sessions: 'reset',
          recovered: false,
          via: 'switch',
        },
      ])
      await waitUntil(() => !isAlive(firstChild))
      expect(firstChild?.signalCode).toBe('SIGTERM')
      const secondSession = defaultSessionId(config)
      expect(secondSession).not.toBe(firstSession)

      const keep = stage({
        recycle: { sessions: 'keep' },
        profile: { revision: 4 },
      })
      node.resident.checkProviderConfig()
      await waitUntil(() => node.ready() === 3)
      expect(node.switches.at(-1)).toEqual({
        requestId: keep,
        sessions: 'keep',
        recovered: false,
        via: 'switch',
      })
      expect(defaultSessionId(config)).toBe(secondSession)

      expect(node.spawned).toHaveLength(3)
      expect(isAlive(node.spawned[2])).toBe(true)
      // Not parked: work is still taken, on the third generation.
      const { client, replies } = await connect(socket)
      const after = task('after two recycles')
      await client.sendAndWait(after)
      await waitUntil(() => resultFor(replies, after) !== undefined)
      const payload = resultFor(replies, after)?.payload
      expect(isTaskResultPayload(payload) ? payload.outcome : undefined).toBe(
        'completed',
      )
      // Neither the planned SIGTERM exits nor a park were reported as faults.
      expect(node.errors).toEqual([])
      expect(node.alerts).toEqual([])
      // Each generation recorded what it loaded.
      const state = providerNode.readProviderState()
      expect(state.loadedHash).toBe(state.appliedHash)
      expect(state.applied?.requestId).toBe(keep)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'a turn that outlasts the 30 min limit is reported once and never killed',
    async () => {
      const { config, socket } = setUpNode('thirty-minutes')
      const clock = new ManualClock()
      const node = startResident(socket, { holdBusy: true, clock })
      await waitUntil(() => node.ready() === 1)
      const { client, replies } = await connect(socket)
      const held = task('a watch job that will not end')
      await client.sendAndWait(held)
      await waitUntil(() => node.resident.gate.active)
      const settingsBefore = providerNode.currentManagedHash()

      stage()
      node.resident.checkProviderConfig()
      const status = () =>
        JSON.parse(
          readFileSync(
            join(config, 'resident', 'provider-switch.json'),
            'utf8',
          ),
        ) as {
          waiting: {
            inFlight: { turns: number; tasks: number }
            alertedAt: string | null
          } | null
        }
      expect(status().waiting?.inFlight.turns).toBe(1)
      expect(status().waiting?.inFlight.tasks).toBe(1)

      clock.advance(30 * 60_000 - 1)
      node.resident.checkProviderConfig()
      expect(node.alerts).toEqual([])

      clock.advance(1)
      node.resident.checkProviderConfig()
      expect(node.alerts).toHaveLength(1)
      expect(node.alerts[0]).toContain('30 min')
      expect(node.alerts[0]).toContain('not forced')
      expect(status().waiting?.alertedAt).not.toBeNull()

      clock.advance(60 * 60_000)
      node.resident.checkProviderConfig()
      node.resident.checkProviderConfig()
      expect(node.alerts).toHaveLength(1)

      // Nothing was forced: same child, still running its turn; nothing was
      // committed; the task has not been answered.
      expect(node.spawned).toHaveLength(1)
      expect(isAlive(node.spawned[0])).toBe(true)
      expect(node.resident.gate.active).toBe(true)
      expect(providerNode.hasPendingProviderConfig()).toBe(true)
      expect(providerNode.currentManagedHash()).toBe(settingsBefore)
      expect(resultFor(replies, held)).toBeUndefined()
      expect(node.switches).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'an intent left by a crash is committed before the first child starts',
    async () => {
      const { config, socket } = setUpNode('roll-forward')
      const requestId = stage()
      const hashAtSpawn: string[] = []
      const node = startResident(socket)
      // Read back what the first child would have found on disk.
      await waitUntil(() => node.ready() === 1)
      hashAtSpawn.push(
        JSON.parse(
          readFileSync(
            join(config, 'qianmo', 'provider', 'generation.json'),
            'utf8',
          ),
        ).loadedHash as string,
      )
      const state = providerNode.readProviderState()
      expect(state.pending).toBeNull()
      expect(state.applied?.requestId).toBe(requestId)
      expect(hashAtSpawn).toEqual([state.appliedHash as string])
      expect(node.spawned).toHaveLength(1)
      expect(node.switches).toEqual([
        { requestId, sessions: 'reset', recovered: false, via: 'startup' },
      ])
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'a commit made while no resident ran resets the sessions once, at the next start',
    async () => {
      const { config, socket } = setUpNode('reconcile')
      const first = startResident(socket)
      await waitUntil(() => first.ready() === 1)
      const before = defaultSessionId(config)
      first.resident.stop()
      await activeRun

      // `qm provider` with no resident running commits on its own (§2.6 step
      // 4); the session policy that came with it never reaches the resident.
      const requestId = stage({ recycle: { sessions: 'keep' } })
      expect(providerNode.commitPendingProviderConfig().status).toBe(
        'committed',
      )

      const second = startResident(`${socket}2`)
      await waitUntil(() => second.ready() === 1)
      expect(second.switches).toEqual([
        { requestId, sessions: 'reset', recovered: true, via: 'reconcile' },
      ])
      const after = defaultSessionId(config)
      expect(after).not.toBe(before)
      second.resident.stop()
      await activeRun

      // Reconciled once: the next start keeps the sessions.
      const third = startResident(`${socket}3`)
      await waitUntil(() => third.ready() === 1)
      expect(third.switches).toEqual([])
      expect(defaultSessionId(config)).toBe(after)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'a refused commit is reported once and leaves the child and the intent alone',
    async () => {
      const { config, socket } = setUpNode('refused')
      const node = startResident(socket, {
        mailboxPollMs: ONE_POLL_PER_GENERATION_MS,
      })
      await waitUntil(() => node.ready() === 1)
      stage()
      chmodSync(config, 0o755)
      // The first check that finds the node idle is the refusal.
      await checkUntil(node, () => node.alerts.length > 0)
      // Idle from here on, so these are refused too, and reported never.
      for (let i = 0; i < 3; i++) node.resident.checkProviderConfig()

      expect(node.alerts).toHaveLength(1)
      expect(node.alerts[0]).toContain('0700')
      expect(providerNode.hasPendingProviderConfig()).toBe(true)
      expect(node.spawned).toHaveLength(1)
      expect(isAlive(node.spawned[0])).toBe(true)

      // Fixed by the operator: the next check commits and recycles.
      chmodSync(config, 0o700)
      node.resident.checkProviderConfig()
      await waitUntil(() => node.ready() === 2)
      expect(providerNode.hasPendingProviderConfig()).toBe(false)
    },
    TEST_TIMEOUT_MS,
  )
})
