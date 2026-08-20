// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CapabilityLevel,
  LIMITS,
  MESSAGE_TYPES,
  MessageType,
  ProtocolErrorCode,
  createMessage,
  isAckPayload,
  isNotifyPayload,
  isTaskResultPayload,
  newId,
  type NotifyPayload,
  type QianmoMessage,
} from '@qianmo/protocol'
import { AuditSource, readTrail } from '@qianmo/audit'
import {
  NodeCapabilities,
  SIGNED_TASK_POLICY,
  StaticPublicKeyDirectory,
  generateNodeKeyPair,
  issueCapability,
} from '@qianmo/capability'
import { ReceiptStatus, TransportClient } from '@qianmo/transport'
import type { AuditWitnessScheduler } from '@qianmo/witness'
import { readMailbox } from '../../../utils/agents/teammateMailbox.js'
import { executeResidentWake } from '../../../cli/handlers/residentWake.js'
import type { ResidentTimingEvent } from '@qianmo/resident'
import { QianmoResident } from '../resident.js'
import { openAuditTrail, residentNotifyTrailSink } from '../auditTrail.js'

const PSK = 'resident-integration-not-a-real-secret'
const TEAM = 'nest'
const AGENT = 'reviewer'
/** Same budget `resident.ts` gives one receipt — and the sender's default. */
const RECEIPT_BUDGET_MS = 5_000
const ACP_FIXTURE = join(
  import.meta.dir,
  'fixtures',
  'resident-acp-agent.runner.ts',
)

const children: ChildProcess[] = []
const clients: TransportClient[] = []
let root: string | undefined
let previousConfigDir: string | undefined
let activeResident: QianmoResident | undefined
let activeRun: Promise<void> | undefined

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

function spawnFixture(env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const child = spawn(process.execPath, [ACP_FIXTURE], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env,
  })
  children.push(child)
  return child
}

async function unreadCount(): Promise<number> {
  const mailbox = await readMailbox(AGENT, TEAM)
  return mailbox.filter(message => !message.read).length
}

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
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  }
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('resident product integration', () => {
  test('transport delivery survives ACP restart and resumes the same session', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-integration-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const workspace = join(root, 'workspace')
    const ready: string[] = []
    const errors: unknown[] = []
    const timings: ResidentTimingEvent[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: workspace }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: spawnFixture,
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: error => errors.push(error),
      onTiming: event => timings.push(event),
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running

    await waitUntil(() => ready.length === 1)
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

    const firstMessage = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { round: 1 },
    })
    client.send(firstMessage)
    await client.waitForDrain()
    await waitUntil(async () => (await unreadCount()) === 0)
    const sessionPath = join(root, 'config', 'resident', 'sessions.json')
    const firstSession = readFileSync(sessionPath, 'utf8')

    children[0]?.kill('SIGKILL')
    await waitUntil(() => !client.isReady())
    const secondMessage = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { round: 2 },
    })
    client.send(secondMessage)
    expect(client.pending).toBe(1)

    await waitUntil(() => ready.length === 2)
    await client.waitForDrain()
    await waitUntil(async () => (await unreadCount()) === 0)
    expect(readFileSync(sessionPath, 'utf8')).toBe(firstSession)
    const mailbox = await readMailbox(AGENT, TEAM)
    expect(mailbox).toHaveLength(2)
    expect(mailbox.every(message => message.read)).toBe(true)
    await waitUntil(
      () =>
        timings.filter(event => event.stage === 'turn_completed').length === 2,
    )
    for (const message of [firstMessage, secondMessage]) {
      const events = timings.filter(
        event => event.networkMsgId === message.msgId,
      )
      expect(new Set(events.map(event => event.stage))).toEqual(
        new Set([
          'detected',
          'queued',
          'admitted',
          'read',
          'first_content',
          'turn_completed',
        ]),
      )
      const at = (stage: ResidentTimingEvent['stage']): number =>
        events.find(event => event.stage === stage)?.at ?? -1
      expect(at('detected')).toBeLessThanOrEqual(at('queued'))
      expect(at('queued')).toBeLessThanOrEqual(at('admitted'))
      // Depth is observation, not a decision: one agent submits one turn at a
      // time, so the only honest number here is "this one".
      expect(events.find(event => event.stage === 'queued')?.queueDepth).toBe(1)
      expect(at('detected')).toBeLessThanOrEqual(at('admitted'))
      expect(at('admitted')).toBeLessThanOrEqual(at('first_content'))
      expect(at('first_content')).toBeLessThanOrEqual(at('turn_completed'))
      expect(at('detected')).toBeLessThanOrEqual(at('read'))
      expect(at('read')).toBeLessThanOrEqual(at('turn_completed'))
      expect(new Set(events.map(event => event.inputMessageId)).size).toBe(1)
    }

    // Both rounds are answered on the sender's own channel, across the
    // restart that happened between them.
    await waitUntil(
      () => replies.filter(item => item.type === MessageType.Ack).length === 2,
    )
    expect(new Set(replies.map(item => item.taskId))).toEqual(
      new Set([firstMessage.taskId, secondMessage.taskId]),
    )

    resident.stop()
    await running
    // Exactly one error, and it is the SIGKILL this test asked for.
    //
    // The list is asserted whole on purpose, and it only holds still because
    // teardown drains reply receipts first. Both rounds settle by writing a
    // `task.result` and awaiting the sender's receipt, and both settles are in
    // flight at a teardown: round 1's when the killed ACP child brings the
    // generation down, round 2's when `stop()` below runs — `turn_completed` is
    // recorded before `onTurnResult` even starts, so waiting on that timing
    // above does not wait for the receipt. Tearing the transport down under
    // either of them would reject the wait with `transport server closed before
    // receipt` and add a second entry here. See `#drainReplyReceipts` in
    // `resident.ts` for why that wait is now honoured instead.
    expect(errors.map(String)).toEqual([
      'Error: resident ACP child exited code=null signal=SIGKILL',
    ])
  }, 15_000)

  test('a never-settling witness tick does not block mailbox admission', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-witness-poll-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const errors: unknown[] = []
    let ticks = 0
    let failuresRemaining = 0
    const witness = {
      tick: (): Promise<void> => {
        ticks += 1
        if (failuresRemaining > 0) {
          failuresRemaining -= 1
          return Promise.reject(new Error('witness tick rejected'))
        }
        return new Promise(() => {})
      },
    } as unknown as AuditWitnessScheduler
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: spawnFixture,
      witness,
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: error => errors.push(error),
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)
    await waitUntil(() => ticks > 0)

    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      backoff: { baseDelayMs: 20, maxDelayMs: 100, jitterRatio: 0 },
      keepAliveIntervalMs: 0,
    })
    clients.push(client)
    await client.connect()
    client.send(
      createMessage({
        from: 'qianmo://node-a/planner',
        to: 'qianmo://node-b/reviewer',
        type: MessageType.TaskRequest,
        payload: { round: 'witness-pending' },
      }),
    )
    await client.waitForDrain()
    await waitUntil(async () => (await unreadCount()) === 0)
    failuresRemaining = 1
    await waitUntil(() =>
      errors.some(error => String(error).includes('rejected')),
    )
  }, 10_000)

  test('acks at the read flip and returns task.result over the same channel', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-task-result-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const errors: unknown[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: spawnFixture,
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: error => errors.push(error),
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running

    await waitUntil(() => ready.length === 1)
    // The dialling side of the hop: it never listens, so anything that arrives
    // here arrived over the very connection the request went out on.
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

    const request = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { ask: 'summarise' },
    })
    client.send(request)
    await client.waitForDrain()
    await waitUntil(() => replies.length >= 2)

    const [ack, result] = replies
    expect(ack?.type).toBe(MessageType.Ack)
    expect(ack?.taskId).toBe(request.taskId)
    expect(ack?.from).toBe('qianmo://node-b/reviewer')
    expect(ack?.to).toBe('qianmo://node-a/planner')
    expect(isAckPayload(ack?.payload)).toBe(true)
    expect(Object.keys(ack?.payload as object).sort()).toEqual([
      'ackAt',
      'handler',
    ])
    // Rule K-1: the ack asserts the read flip and nothing else.
    expect((await readMailbox(AGENT, TEAM)).every(item => item.read)).toBe(true)

    expect(result?.type).toBe(MessageType.TaskResult)
    expect(result?.taskId).toBe(request.taskId)
    expect(isTaskResultPayload(result?.payload)).toBe(true)
    expect(result?.payload).toMatchObject({
      outcome: 'completed',
      content: 'fixture response',
    })
    expect(replies).toHaveLength(2)
    expect(errors).toEqual([])
  }, 15_000)

  test('a second request is receipted inside the budget while a turn holds the gate', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-receipt-decoupling-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      // The first turn is admitted and then never ends, so the node turn gate
      // is held for the rest of the test.
      spawnAcp: () =>
        spawnFixture({ ...process.env, QIANMO_FIXTURE_HOLD_BUSY: '1' }),
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: () => {},
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running

    await waitUntil(() => ready.length === 1)
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

    const first = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { round: 'holds the gate' },
    })
    await client.sendAndWait(first, RECEIPT_BUDGET_MS)
    await waitUntil(() => replies.some(item => item.type === MessageType.Ack))

    // The whole of H-3: queueing behind a running turn must not be paid for
    // out of the sender's transport receipt budget.
    const second = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { round: 'queued behind it' },
    })
    const startedAt = Date.now()
    await expect(client.sendAndWait(second, RECEIPT_BUDGET_MS)).resolves.toBe(
      ReceiptStatus.Accepted,
    )
    expect(Date.now() - startedAt).toBeLessThan(RECEIPT_BUDGET_MS)

    // And the receipt says exactly what it is allowed to say: the envelope is
    // durable. It is not an ack — that one still waits for the read flip, which
    // cannot happen while the first turn holds the gate.
    expect(await readMailbox(AGENT, TEAM)).toHaveLength(2)
    expect(
      replies.filter(
        item => item.type === MessageType.Ack && item.taskId === second.taskId,
      ),
    ).toHaveLength(0)
  }, 20_000)

  test('an ACP crash while busy comes back as a failed task.result', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-task-failed-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: () =>
        spawnFixture({ ...process.env, QIANMO_FIXTURE_HOLD_BUSY: '1' }),
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: () => {},
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running

    await waitUntil(() => ready.length === 1)
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

    const request = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { ask: 'never finishes' },
    })
    // The receipt says "kept", and that is all it ever says now. Everything
    // that goes wrong after this point has to reach the sender through the
    // task channel instead — which is the assertion at the end of this test.
    await expect(client.sendAndWait(request, RECEIPT_BUDGET_MS)).resolves.toBe(
      ReceiptStatus.Accepted,
    )
    // The turn is admitted and read — the sender has its ack — but the ACP
    // child hangs before the turn ever terminates.
    await waitUntil(() => replies.some(item => item.type === MessageType.Ack))

    children[0]?.kill('SIGKILL')

    await waitUntil(() =>
      replies.some(item => item.type === MessageType.TaskResult),
    )
    const result = replies.find(item => item.type === MessageType.TaskResult)
    expect(result?.taskId).toBe(request.taskId)
    expect(isTaskResultPayload(result?.payload)).toBe(true)
    expect(result?.payload).toMatchObject({
      outcome: 'failed',
      code: ProtocolErrorCode.E_TASK_FAILED,
    })
    // Two paths race to report the same thing — the ACP SDK rejecting the
    // in-flight prompt, and the supervisor sweeping active tasks before it
    // tears the transport down. Both are E_TASK_FAILED; telling the two
    // apart is cause-level diagnosis, which belongs to P5.1.
    expect(
      (result?.payload as { reason: string }).reason.length,
    ).toBeGreaterThan(0)
  }, 15_000)

  test('a full turn queue refuses before the mailbox write, downgrading for old peers', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-queue-full-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      // Slow, because the admission loop's own polls are refused too once the
      // queue is full and there is nothing to learn from that noise.
      pollIntervalMs: 10_000,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: spawnFixture,
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: () => {},
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)

    // Filled from the inside: one agent submits one turn at a time, so no
    // amount of inbound traffic will ever fill a 32-deep queue by itself.
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const occupied = Array.from({ length: LIMITS.maxQueuedTurns + 1 }, () =>
      resident.gate.run(async () => await held),
    )
    expect(resident.gate.saturated).toBe(true)

    // A peer that declared a post-legacy type gets the precise code…
    const modern: QianmoMessage[] = []
    const modernClient = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      supportedTypes: [MessageType.Notify],
      onMessage: message => {
        modern.push(message)
      },
    })
    clients.push(modernClient)
    await modernClient.connect()
    await expect(
      modernClient.sendAndWait(
        createMessage({
          from: 'qianmo://node-a/planner',
          to: 'qianmo://node-b/reviewer',
          type: MessageType.TaskRequest,
          payload: { ask: 'while full' },
        }),
        RECEIPT_BUDGET_MS,
      ),
    ).rejects.toThrow()
    expect(modern.at(-1)?.type).toBe(MessageType.Error)
    expect((modern.at(-1)?.payload as { code: string }).code).toBe(
      ProtocolErrorCode.E_BUSY,
    )

    // …and one that declared nothing gets the nearest legacy stand-in, because
    // a code it cannot parse would make it refuse the whole reply (rule N-1).
    const legacy: QianmoMessage[] = []
    const legacyClient = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-c',
      psk: PSK,
      keepAliveIntervalMs: 0,
      onMessage: message => {
        legacy.push(message)
      },
    })
    clients.push(legacyClient)
    await legacyClient.connect()
    await expect(
      legacyClient.sendAndWait(
        createMessage({
          from: 'qianmo://node-c/planner',
          to: 'qianmo://node-b/reviewer',
          type: MessageType.TaskRequest,
          payload: { ask: 'while full, older peer' },
        }),
        RECEIPT_BUDGET_MS,
      ),
    ).rejects.toThrow()
    expect((legacy.at(-1)?.payload as { code: string }).code).toBe(
      ProtocolErrorCode.E_RATE_LIMITED,
    )

    // Rule L-1, the whole reason the check sits where it does: a refusal does
    // not spend the recipient's inbox quota.
    expect(await readMailbox(AGENT, TEAM)).toHaveLength(0)

    release()
    await Promise.all(occupied)
  }, 20_000)

  test('reports idle before restarting an ACP generation that crashes while busy', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-activity-crash-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const activity: boolean[] = []
    const ready: string[] = []
    let generation = 0
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: () => {
        generation++
        return spawnFixture(
          generation === 1
            ? { ...process.env, QIANMO_FIXTURE_HOLD_BUSY: '1' }
            : process.env,
        )
      },
      onActivity: active => {
        activity.push(active)
      },
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running

    await waitUntil(() => ready.length === 1)
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      backoff: { baseDelayMs: 20, maxDelayMs: 100, jitterRatio: 0 },
      keepAliveIntervalMs: 0,
    })
    clients.push(client)
    await client.connect()
    await client.sendAndWait(
      createMessage({
        from: 'qianmo://node-a/planner',
        to: 'qianmo://node-b/reviewer',
        type: MessageType.TaskRequest,
        payload: { crash: 'while-busy' },
      }),
    )
    await waitUntil(() => activity.includes(true))

    children[0]?.kill('SIGKILL')

    await waitUntil(() => activity.at(-1) === false)
    expect(activity).toEqual([true, false])
    await waitUntil(() => ready.length === 2)
  }, 15_000)
})

describe('authorization at the terminal node (P4.3)', () => {
  test('an unsigned task is refused before the mailbox, a signed one carries its issuer', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-capability-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const errors: unknown[] = []

    const peer = generateNodeKeyPair()
    const own = generateNodeKeyPair()
    const directory = new StaticPublicKeyDirectory([
      ['node-a', peer.publicKey],
      ['node-b', own.publicKey],
    ])
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: spawnFixture,
      capability: new NodeCapabilities({
        node: 'node-b',
        directory,
        keys: own,
        policy: SIGNED_TASK_POLICY,
      }),
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: error => errors.push(error),
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)

    const replies: QianmoMessage[] = []
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(client)
    await client.connect()

    // 1. Unsigned work under a signing policy: refused ahead of the write, so
    //    the recipient's inbox is untouched (rule L-1 + S-2).
    const unsigned = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { round: 'unsigned' },
    })
    await expect(client.sendAndWait(unsigned, 5_000)).rejects.toThrow()
    expect(await readMailbox(AGENT, TEAM)).toHaveLength(0)
    const refusal = replies.at(-1)
    expect(refusal?.type).toBe(MessageType.Error)
    expect((refusal?.payload as { code: string }).code).toBe(
      ProtocolErrorCode.E_CAP_INSUFFICIENT,
    )

    // 2. The same work, authorized by the peer's own key. The task id is
    //    minted first because the token is bound to it: there are no
    //    general-purpose capabilities.
    const taskId = newId()
    const bound = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { round: 'signed' },
      taskId,
      cap: issueCapability('node-a', peer, {
        sub: 'qianmo://node-b/reviewer',
        aud: 'node-b',
        act: CapabilityLevel.WriteLimited,
        taskId,
        nbf: Date.now() - 1_000,
        exp: Date.now() + 60_000,
      }),
    })
    client.send(bound)
    await client.waitForDrain()
    await waitUntil(async () => (await readMailbox(AGENT, TEAM)).length === 1)

    // The provenance the receiver wrote names who signed for it — and it is
    // the receiver's own finding, not a field copied off the envelope.
    const entry = (await readMailbox(AGENT, TEAM))[0]
    const wrapper = JSON.parse(entry?.text ?? '{}') as {
      envelope?: { origin?: { capIss?: string; node?: string } }
    }
    expect(wrapper.envelope?.origin?.capIss).toBe('node-a')
    expect(wrapper.envelope?.origin?.node).toBe('node-a')

    resident.stop()
    await running
  }, 20_000)
})

describe('the reliability kit (P13.5)', () => {
  /** Kinds of every record in the delivery ledger, oldest first. */
  function deliveryRecords(): { kind: string; taskId?: string }[] {
    const path = join(root ?? '', 'config', 'resident', 'deliveries.ndjson')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(line => line !== '')
      .map(line => JSON.parse(line) as { kind: string; taskId?: string })
  }

  test('an unreceipted task.result is redelivered after a restart, marked as a repeat', async () => {
    // The traceless loss, end to end. Before this batch, a reply whose receipt
    // never came back reached `onError` and then existed nowhere: the peer
    // waited forever for something no part of this node remembered owing it.
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-redelivery-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')

    // ---- first life --------------------------------------------------
    const firstReady: string[] = []
    const firstErrors: unknown[] = []
    const first = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      // The turn is admitted — so the peer gets its ack — and then never ends.
      // That is what makes the loss deterministic: the reply is not produced
      // until teardown, by which time the peer is already gone.
      spawnAcp: () =>
        spawnFixture({ ...process.env, QIANMO_FIXTURE_HOLD_BUSY: '1' }),
      onReady: address => {
        if (address.unix !== undefined) firstReady.push(address.unix)
      },
      onError: error => firstErrors.push(error),
    })
    const firstRun = first.run()
    activeResident = first
    activeRun = firstRun
    await waitUntil(() => firstReady.length === 1)

    const seen: QianmoMessage[] = []
    const doomed = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      supportedTypes: [MessageType.Notify],
      onMessage: message => {
        seen.push(message)
      },
    })
    await doomed.connect()
    const request = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { ask: 'answer me, then lose the receipt' },
    })
    doomed.send(request)
    await waitUntil(() =>
      seen.some(
        item => item.type === MessageType.Ack && item.taskId === request.taskId,
      ),
    )
    // The peer vanishes while its turn is still running.
    await doomed.close()

    // Teardown fails the in-flight task, which is where the reply is produced
    // — written to the ledger first, then sent to a peer that is not there.
    first.stop()
    await firstRun
    activeResident = undefined
    activeRun = undefined

    const owed = deliveryRecords()
    // The obligation is written down *before* the reply goes on the wire, so
    // it exists even for a crash between the two.
    expect(owed.some(item => item.kind === 'pending')).toBe(true)
    expect(owed.some(item => item.kind === 'attempting')).toBe(true)
    // Not retired: that is the whole point.
    expect(owed.some(item => item.kind === 'delivered')).toBe(false)
    expect(firstErrors.length).toBeGreaterThan(0)

    // ---- second life -------------------------------------------------
    const secondReady: string[] = []
    const second = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: spawnFixture,
      onReady: address => {
        if (address.unix !== undefined) secondReady.push(address.unix)
      },
      onError: () => {},
    })
    const secondRun = second.run()
    activeResident = second
    activeRun = secondRun
    await waitUntil(() => secondReady.length === 1)

    const replies: QianmoMessage[] = []
    const returning = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      supportedTypes: [MessageType.Notify],
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(returning)
    await returning.connect()
    // Contact from the peer is the trigger, and it has to be: rule H-2 says a
    // node never dials, so the moment this peer's channel exists is the only
    // moment an owed reply can leave.
    returning.send(
      createMessage({
        from: 'qianmo://node-a/planner',
        to: 'qianmo://node-b/reviewer',
        type: MessageType.TaskRequest,
        payload: { ask: 'the new one' },
      }),
    )

    await waitUntil(() =>
      replies.some(
        item =>
          item.type === MessageType.TaskResult &&
          item.taskId === request.taskId,
      ),
    )
    const redelivered = replies.find(
      item =>
        item.type === MessageType.TaskResult && item.taskId === request.taskId,
    )
    // A **new envelope** carrying the same correlation key, never a
    // retransmission: the original's `deliverTtlMs` expired long before the
    // restart finished, so re-sending it verbatim would earn an
    // `E_TTL_EXPIRED` and nothing else (protocol.md §14.4③).
    expect(redelivered?.msgId).not.toBe(request.msgId)
    expect(isTaskResultPayload(redelivered?.payload)).toBe(true)
    // The marker the peer deduplicates by. Honest at-least-once: a repeat is
    // visible, never silent.
    expect(redelivered?.payload).toMatchObject({
      outcome: 'failed',
      redelivered: true,
    })

    // And it retires once it is finally receipted, so a third life is quiet.
    await waitUntil(() =>
      deliveryRecords().some(item => item.kind === 'delivered'),
    )
  }, 45_000)

  test('a peer too old for the marker still gets its answer, without the field', async () => {
    // Rule N-1's discipline applied to a field rather than to a code. A peer
    // that predates `redelivered` validates `task.result` by an exact key set,
    // so sending it the flag would not degrade to "an unfamiliar marker" — it
    // would degrade to the whole reply being refused as malformed, which is
    // the one outcome a redelivery must not produce.
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-redelivery-legacy-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')

    const firstReady: string[] = []
    const firstErrors: unknown[] = []
    const first = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      // The turn is admitted — so the peer gets its ack — and then never ends.
      // That is what makes the loss deterministic: the reply is not produced
      // until teardown, by which time the peer is already gone.
      spawnAcp: () =>
        spawnFixture({ ...process.env, QIANMO_FIXTURE_HOLD_BUSY: '1' }),
      onReady: address => {
        if (address.unix !== undefined) firstReady.push(address.unix)
      },
      onError: error => firstErrors.push(error),
    })
    const firstRun = first.run()
    activeResident = first
    activeRun = firstRun
    await waitUntil(() => firstReady.length === 1)

    // Declares nothing, which reads as the legacy floor.
    const seen: QianmoMessage[] = []
    const doomed = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      onMessage: message => {
        seen.push(message)
      },
    })
    await doomed.connect()
    const request = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { ask: 'older peer' },
    })
    doomed.send(request)
    await waitUntil(() =>
      seen.some(
        item => item.type === MessageType.Ack && item.taskId === request.taskId,
      ),
    )
    await doomed.close()
    first.stop()
    await firstRun
    expect(deliveryRecords().some(item => item.kind === 'delivered')).toBe(
      false,
    )
    expect(firstErrors.length).toBeGreaterThan(0)

    const secondReady: string[] = []
    const second = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: spawnFixture,
      onReady: address => {
        if (address.unix !== undefined) secondReady.push(address.unix)
      },
      onError: () => {},
    })
    const secondRun = second.run()
    activeResident = second
    activeRun = secondRun
    await waitUntil(() => secondReady.length === 1)

    const replies: QianmoMessage[] = []
    const returning = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(returning)
    await returning.connect()
    returning.send(
      createMessage({
        from: 'qianmo://node-a/planner',
        to: 'qianmo://node-b/reviewer',
        type: MessageType.TaskRequest,
        payload: { ask: 'the new one' },
      }),
    )

    await waitUntil(() =>
      replies.some(
        item =>
          item.type === MessageType.TaskResult &&
          item.taskId === request.taskId,
      ),
    )
    const redelivered = replies.find(
      item =>
        item.type === MessageType.TaskResult && item.taskId === request.taskId,
    )
    // The answer still arrives, and it still validates on an older build…
    expect(isTaskResultPayload(redelivered?.payload)).toBe(true)
    // …because the marker was withheld. The peer still has `taskId` to notice
    // the duplicate by, which is the correlation key it already had (C-1).
    expect(redelivered?.payload).not.toHaveProperty('redelivered')
  }, 45_000)

  test('ESTOP refuses new work with E_BUSY, never touches a running turn, and an empty file counts', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-estop-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      // The first turn is admitted and then never ends, so there is a real
      // in-flight turn for the brake to fail to kill.
      spawnAcp: () =>
        spawnFixture({ ...process.env, QIANMO_FIXTURE_HOLD_BUSY: '1' }),
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: () => {},
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)

    const replies: QianmoMessage[] = []
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      supportedTypes: [MessageType.Notify],
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(client)
    await client.connect()

    const inFlight = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { ask: 'runs across the stop' },
    })
    client.send(inFlight)
    await waitUntil(() => replies.some(item => item.type === MessageType.Ack))

    // `touch ESTOP` — the most obvious way a human pulls the brake, and the
    // one an implementation that parsed contents would read as "carry on".
    const sentinel = join(root, 'config', 'resident', 'ESTOP')
    writeFileSync(sentinel, '')

    const refused = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { ask: 'arrives after the stop' },
    })
    await expect(
      client.sendAndWait(refused, RECEIPT_BUDGET_MS),
    ).rejects.toThrow()
    const refusal = replies.at(-1)
    expect(refusal?.type).toBe(MessageType.Error)
    expect((refusal?.payload as { code: string }).code).toBe(
      ProtocolErrorCode.E_BUSY,
    )

    // Rule L-1: the refusal is ahead of the mailbox write, so it does not
    // spend the recipient's inbox quota. Only the first request is on disk.
    expect(await readMailbox(AGENT, TEAM)).toHaveLength(1)

    // Pause-new-work, not abort-running-work. The turn admitted before the
    // brake is still alive — nothing failed it, and its ack still stands.
    expect(
      replies.filter(
        item =>
          item.type === MessageType.TaskResult &&
          item.taskId === inFlight.taskId,
      ),
    ).toHaveLength(0)
    expect(
      replies.some(
        item =>
          item.type === MessageType.Ack && item.taskId === inFlight.taskId,
      ),
    ).toBe(true)
  }, 25_000)

  test('a turn whose ACP side goes silent fails early, and says it was inactivity', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-inactivity-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      // Admits the turn, sends one chunk, then never speaks again.
      spawnAcp: () =>
        spawnFixture({ ...process.env, QIANMO_FIXTURE_HOLD_BUSY: '1' }),
      inactivityMs: 400,
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: () => {},
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)

    const replies: QianmoMessage[] = []
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(client)
    await client.connect()

    const request = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      // Five minutes of task budget: without the watchdog this sender waits
      // all of it and then learns nothing.
      payload: { ask: 'goes quiet' },
    })
    client.send(request)

    await waitUntil(() =>
      replies.some(
        item =>
          item.type === MessageType.TaskResult &&
          item.taskId === request.taskId,
      ),
    )
    const result = replies.find(item => item.type === MessageType.TaskResult)
    expect(result?.payload).toMatchObject({
      outcome: 'failed',
      code: ProtocolErrorCode.E_TASK_FAILED,
    })
    const reason = (result?.payload as { reason: string }).reason
    // Not a bare timeout: the sender has to be able to tell inactivity apart
    // from a refusal or a crash, and to know that the retry which would help
    // is one carrying a longer `taskTtlMs` — a decision only it may make.
    expect(reason).toContain('inactivity')
    expect(reason).toContain('taskTtlMs')
  }, 25_000)
})

/**
 * T11 blind spot ③, and the determination it was opened to make.
 *
 * `protocol.md` §3.4 says `wake` **needs an ack**; the resident produces none,
 * because `#registerTask` fires only for `task.request`. P13.5 was handed the
 * job of deciding which half is wrong. These tests are the evidence, and the
 * answer is that the **document** is: see the assertions below and the note
 * rewritten in `protocol.md` §3.4 / §14.8.
 */
describe('wake, end to end on the resident side (T11 blind spot ③)', () => {
  test('the production sender is answered by a transport receipt, and the wake still opens a turn', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-wake-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const ready: { url?: string }[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      // TCP rather than a unix socket: `executeResidentWake` takes a ws URL,
      // and running the real sender is the point of this test.
      listen: { port: 0, hostname: '127.0.0.1' },
      spawnAcp: spawnFixture,
      onReady: address => ready.push(address),
      onError: () => {},
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)
    const url = ready[0]?.url
    expect(url).toBeDefined()

    const result = await executeResidentWake(
      {
        url: url as string,
        from: 'qianmo://node-a/planner',
        to: 'qianmo://node-b/reviewer',
        prompt: 'wake up and look at the queue',
        afterMs: 0,
        timeoutMs: 10_000,
        deliverTtlMs: 90_000,
      },
      PSK,
    )

    // What the only production wake sender actually waits for — and it closes
    // its client the moment this lands, so an ack sent afterwards would have
    // nowhere to arrive. It also passes no `onMessage` sink, so it could not
    // read one if it did.
    expect(result.receipt).toBe(ReceiptStatus.Accepted)
    expect(result.taskId.length).toBeGreaterThan(0)

    // The wake does everything §14.8 says it does: it lands in the mailbox and
    // opens a turn, which is what "wake the node" means here.
    await waitUntil(async () => (await readMailbox(AGENT, TEAM)).length === 1)
    await waitUntil(async () =>
      (await readMailbox(AGENT, TEAM)).every(item => item.read),
    )
  }, 25_000)

  test('a wake produces no protocol ack, while a task.request on the same channel does', async () => {
    // The determination, stated as a comparison so it cannot be read as "the
    // ack machinery was broken that day": the same node, the same channel, the
    // same connected listener — one type is acked and the other is not.
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-wake-ack-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: spawnFixture,
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: () => {},
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)

    // Unlike the production sender, this peer stays connected and listens —
    // so "no ack arrived" is a fact about the node rather than about a socket
    // that had already gone away.
    const replies: QianmoMessage[] = []
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(client)
    await client.connect()

    const wake = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.Wake,
      payload: { trigger: 'manual', prompt: 'wake up' },
    })
    await expect(client.sendAndWait(wake, RECEIPT_BUDGET_MS)).resolves.toBe(
      ReceiptStatus.Accepted,
    )
    // The wake's own turn runs to completion — the read flip happens, which is
    // exactly the event an A-class ack would assert.
    await waitUntil(async () => {
      const mailbox = await readMailbox(AGENT, TEAM)
      return mailbox.length === 1 && mailbox.every(item => item.read)
    })

    // The control: a `task.request` behind it, on this same channel.
    const task = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { ask: 'and now some work' },
    })
    client.send(task)
    await waitUntil(() =>
      replies.some(
        item => item.type === MessageType.Ack && item.taskId === task.taskId,
      ),
    )
    await waitUntil(() =>
      replies.some(
        item =>
          item.type === MessageType.TaskResult && item.taskId === task.taskId,
      ),
    )

    // Nothing at all came back for the wake — no ack, and no `task.result`
    // either, because no task was ever registered for it.
    expect(replies.filter(item => item.taskId === wake.taskId)).toEqual([])
  }, 25_000)

  test('an agent notification reaches the hub on the inbound channel and lands on the audit chain', async () => {
    // The end-to-end DoD: agent tool → resident host → hub → audit trail. The
    // fixture stands in for `qianmo_notify` (it makes the same
    // `qianmo/notify` ext request the real tool makes); everything after that
    // is production code.
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-notify-e2e-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const trailPath = join(root, 'trail.ndjson')
    const trail = openAuditTrail(trailPath)
    const ready: string[] = []
    const errors: unknown[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      notifyAudit: residentNotifyTrailSink(trail, 'node-b'),
      spawnAcp: () =>
        spawnFixture({
          ...process.env,
          QIANMO_FIXTURE_NOTIFY: 'disk on node-b is at 91%',
        }),
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: error => errors.push(error),
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)

    const replies: QianmoMessage[] = []
    const hub = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      // The hub says it speaks `notify`. Without the declaration the node is
      // required to stay silent (§2.7), which is the next test.
      supportedTypes: [...MESSAGE_TYPES],
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(hub)
    await hub.connect()

    // `contextId` is the watch job's id (design §4.1③). The notification has
    // to come back under it without the agent ever being told what it is.
    const request = createMessage({
      from: 'qianmo://node-a/console',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      contextId: 'job-disk-watch',
      payload: { ask: 'check the disks' },
    })
    hub.send(request)
    await waitUntil(() =>
      replies.some(item => item.type === MessageType.Notify),
    )

    const notify = replies.find(item => item.type === MessageType.Notify)
    expect(notify?.from).toBe('qianmo://node-b/reviewer')
    expect(notify?.to).toBe('qianmo://node-a/console')
    expect(notify?.contextId).toBe('job-disk-watch')
    // §2.4②: a fresh taskId, never the causing task's — reusing it is what
    // gets the *second* notification of a job cut as `E_LOOP`.
    expect(notify?.taskId).not.toBe(request.taskId)
    expect(notify?.hops).toEqual(['node-b'])
    expect(isNotifyPayload(notify?.payload)).toBe(true)
    const payload = notify?.payload as NotifyPayload
    expect(payload.summary).toBe('disk on node-b is at 91%')
    expect(payload.kind).toBe('watch')
    expect(payload.severity).toBe('warn')
    // Correlation, not a correlation key (rule C-1).
    expect(payload.causeTaskId).toBe(request.taskId)
    expect(payload.redelivered).toBeUndefined()

    // The verdict travelled back into the turn: the agent knows it landed.
    await waitUntil(() =>
      replies.some(
        item =>
          item.type === MessageType.TaskResult &&
          item.taskId === request.taskId,
      ),
    )
    const result = replies.find(
      item =>
        item.type === MessageType.TaskResult && item.taskId === request.taskId,
    )
    expect(String((result?.payload as { content?: string }).content)).toContain(
      'notify=sent',
    )

    // And the trail carries it, chain intact.
    await waitUntil(
      () =>
        readTrail(trailPath).records.some(
          record => record.kind === 'notify_delivered',
        ),
      10_000,
    )
    const read = readTrail(trailPath)
    expect(read.intact).toBe(true)
    const sent = read.records.find(record => record.kind === 'notify_sent')
    const delivered = read.records.find(
      record => record.kind === 'notify_delivered',
    )
    expect(sent?.source).toBe(AuditSource.Resident)
    expect(sent?.outcome).toBe('ok')
    expect(sent?.node).toBe('node-b')
    expect(sent?.taskId).toBe(notify?.taskId)
    expect(delivered?.taskId).toBe(notify?.taskId)
    // hermes B9: a line without a version stamp cannot be told apart, three
    // days later, from a line that was edited.
    expect(sent?.detail?.schemaVersion).toBe(1)
    expect(errors).toEqual([])
  }, 25_000)

  test('a hub that never declared notify is told nothing at all (§2.7)', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-notify-legacy-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const errors: unknown[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: () =>
        spawnFixture({
          ...process.env,
          QIANMO_FIXTURE_NOTIFY: 'nobody will hear this',
        }),
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: error => errors.push(error),
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)

    const replies: QianmoMessage[] = []
    // Declares nothing, which reads as the legacy floor.
    const hub = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(hub)
    await hub.connect()

    const request = createMessage({
      from: 'qianmo://node-a/console',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { ask: 'check the disks' },
    })
    hub.send(request)
    await waitUntil(() =>
      replies.some(
        item =>
          item.type === MessageType.TaskResult &&
          item.taskId === request.taskId,
      ),
    )

    // Not downgraded into a `task.request`, not sent and refused — simply not
    // sent. Rewriting an unsupported type into one the peer does understand
    // would open a turn it never asked for (§2.8, hermes F3).
    expect(replies.some(item => item.type === MessageType.Notify)).toBe(false)
    const result = replies.find(item => item.type === MessageType.TaskResult)
    // The agent is told, so it can put the finding in its answer instead.
    expect(String((result?.payload as { content?: string }).content)).toContain(
      'notify=unsupported',
    )
    expect(errors).toEqual([])
  }, 25_000)
})
