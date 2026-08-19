// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CapabilityLevel,
  LIMITS,
  MessageType,
  ProtocolErrorCode,
  createMessage,
  isAckPayload,
  isTaskResultPayload,
  newId,
  type QianmoMessage,
} from '@qianmo/protocol'
import {
  NodeCapabilities,
  SIGNED_TASK_POLICY,
  StaticPublicKeyDirectory,
  generateNodeKeyPair,
  issueCapability,
} from '@qianmo/capability'
import { ReceiptStatus, TransportClient } from '@qianmo/transport'
import { readMailbox } from '../../../utils/agents/teammateMailbox.js'
import type { ResidentTimingEvent } from '@qianmo/resident'
import { QianmoResident } from '../resident.js'

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
