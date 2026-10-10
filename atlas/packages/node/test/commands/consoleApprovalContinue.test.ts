// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AccountBook,
  FileUsageStore,
  type ConsoleAgent,
  type RegistryPort,
} from '@qianmo/console'
import {
  generateNodeKeyPair,
  signAuthzRequest,
  StaticPublicKeyDirectory,
  type AuthzRequest,
} from '@qianmo/capability'
import {
  createMessage,
  createTaskResult,
  MessageType,
  ProtocolErrorCode,
  type QianmoMessage,
} from '@qianmo/protocol'
import { startTransportServer, type TransportChannel } from '@qianmo/transport'
import {
  FileGrantStore,
  ResidentHardline,
  ResidentEstop,
} from '@qianmo/resident'
import { ConsoleApprovals } from '../../src/commands/consoleApprovals.js'
import { FileLedger } from '../../src/commands/consoleAccountsStore.js'
import { wireConsoleChat } from '../../src/commands/console.js'
import { parseConsoleArgs } from '../../src/commands/consoleArgs.js'
import { createConsoleChatPort } from '../../src/commands/consoleChat.js'
import { loadOrCreateNodeKeys } from '../../src/host/nodeIdentity.js'

async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 4000
  while (!(await check())) {
    if (Date.now() > end) throw Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

for (const terminal of [
  'remote',
  'local',
  'lost-receipt',
  'reset-redeem',
] as const)
  test(`production chat signing and ${terminal} terminal: quota and crash-safe one-send intent`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'qm-continue-'))
    const nodeKeys = generateNodeKeyPair(),
      commander = loadOrCreateNodeKeys('continue-hub'),
      approver = generateNodeKeyPair()
    const book = new AccountBook({
      accounts: new FileLedger(join(root, 'accounts.ndjson')),
      sessions: new FileLedger(join(root, 'sessions.ndjson')),
    })
    const user = book.registerMember(5)
    if (!user.ok) throw Error('account')
    const principal = book.bearerPrincipal(user.value.credential)
    if (!principal.ok) throw Error('principal')
    const grants = new FileGrantStore({
      path: join(root, 'protected', 'grants.ndjson'),
      node: 'worker',
      approvers: new Map([['continue-hub', approver.publicKey]]),
      commanderKeys: () => [commander.publicKey],
      hardline: new ResidentHardline({ stateRoots: [join(root, 'protected')] }),
      estop: new ResidentEstop({ path: join(root, 'ESTOP') }),
    })
    const usage = new FileUsageStore({
      path: join(root, 'usage.ndjson'),
      policy: {
        mode: 'enforce',
        person: { messages: 1, inFlight: 1 },
        job: {},
        global: {},
      },
    })
    let subscription: TransportChannel | undefined,
      original: QianmoMessage | undefined,
      taskChannel: TransportChannel | undefined
    let request: AuthzRequest | undefined
    let sends = 0,
      decisions = 0
    const call = {
      agent: 'main',
      contextId: '',
      toolName: 'write',
      input: { path: join(root, 'outside.txt'), content: 'approved' },
    }
    const psk = 'test-only-continue-psk-0000000000'
    const server = startTransportServer({
      hostname: '127.0.0.1',
      port: 0,
      psk,
      signing: {
        node: 'worker',
        keys: nodeKeys,
        directory: new StaticPublicKeyDirectory([
          ['continue-hub', commander.publicKey],
        ]),
        required: true,
      },
      supportedTypes: Object.values(MessageType),
      onMessage(message, context) {
        if (message.type === MessageType.AuthzRequest) {
          subscription = context.channel
          return
        }
        if (message.type === MessageType.AuthzDecision) {
          expect(
            grants.applyDecision(
              (message.payload as { decision: string }).decision,
            ).ok,
          ).toBe(true)
          decisions++
          return
        }
        if (message.type === MessageType.AuthzRevoke) {
          grants.applyRevoke((message.payload as { revoke: string }).revoke)
          return
        }
        if (message.type !== MessageType.TaskRequest) return
        sends++
        expect(message.cap).toBeDefined()
        if (sends === 1) {
          original = message
          taskChannel = context.channel
          call.contextId = message.contextId!
          const pending = grants.ask({
            ...call,
            origin: {
              from: message.from,
              taskId: message.taskId,
              traceId: message.traceId,
              trust: 'verified-capability',
            },
          })
          if (pending.kind !== 'pending') throw Error('ask')
          request = pending.request
          subscription!.send(
            createMessage({
              from: 'qianmo://worker/main',
              to: 'qianmo://continue-hub/console',
              type: MessageType.AuthzRequest,
              payload: { request: signAuthzRequest(nodeKeys, request) },
              hops: ['worker'],
            }),
          )
        } else {
          expect(grants.use(call).kind).toBe('hit')
          // Keep the continuation in flight until the test sends its terminal result.
          original = message
          taskChannel = context.channel
          if (terminal === 'lost-receipt')
            throw Error('receipt lost after applying task')
        }
      },
    })
    const agent: ConsoleAgent = {
      address: 'qianmo://worker/main',
      endpoint: server.url!,
      capabilities: [],
      status: 'online',
      registeredAt: 1,
      lastHeartbeatAt: 1,
      expiresAt: 9999999999999,
    }
    const unused = async () => ({
      ok: false as const,
      failure: { code: 'unsupported' as const, message: 'unused' },
    })
    const registry: RegistryPort = {
      async list() {
        return { ok: true as const, value: [agent] }
      },
      register: unused,
      heartbeat: unused,
      deregister: unused,
    }
    const config = parseConsoleArgs([
      '--accounts',
      '--approvals',
      '--chat-sign',
      '--chat-from',
      'qianmo://continue-hub/console',
      '--chat-url',
      `worker=${server.url!}`,
      '--trust',
      `worker=${nodeKeys.publicKey}`,
      '--chat-store',
      join(root, 'chat.ndjson'),
    ])
    const wired = wireConsoleChat(config, registry, {
      pskFromEnv: () => psk,
      createChatPort: options =>
        createConsoleChatPort({
          ...options,
          usage,
          ...(terminal === 'local' ? { taskTtlMs: 40 } : {}),
        }),
    })
    if (!wired.hub) throw Error(wired.status)
    const chat = wired.hub
    let resetOnRead = false
    const options = {
      from: config.chatFrom,
      accounts: book,
      commandKeys: commander,
      approvalKeys: approver,
      targets: [
        {
          node: 'worker',
          url: server.url!,
          psk,
          publicKey: nodeKeys.publicKey,
        },
      ],
      ledger: new FileLedger(join(root, 'approvals.ndjson')),
      chat: {
        ...chat,
        async transcript(id: string) {
          const result = await chat.transcript(id)
          if (resetOnRead) {
            const reset = book.reset(user.value.subject, 'legacy:admin')
            if (!reset.ok || !book.acceptInvite(reset.value.token).ok)
              throw Error('reset fixture')
          }
          return result
        },
      },
      usage,
    }
    let approvals = new ConsoleApprovals(options)
    try {
      approvals.start()
      await until(() => subscription !== undefined)
      const opened = await chat.open(agent.address)
      if (!opened.ok) throw Error('open')
      expect(book.recordOwner(opened.value.id, user.value.subject).ok).toBe(
        true,
      )
      const initial = await chat.send({
        sessionId: opened.value.id,
        text: 'do the approved operation',
      })
      expect(initial.ok).toBe(true)
      await until(async () => {
        const list = await approvals.list(principal.value)
        return list.ok && list.value.length === 1
      })
      const input = { requestId: request!.requestId, digest: request!.digest }
      expect((await approvals.continue(principal.value, input)).ok).toBe(false)
      expect(decisions).toBe(0)
      expect(sends).toBe(1)
      if (terminal === 'local') {
        await until(async () => {
          const result = await chat.transcript(opened.value.id)
          return (
            result.ok &&
            result.value.turns.some(
              row => row.author === 'agent' && row.state === 'failed',
            )
          )
        })
        expect((await approvals.continue(principal.value, input)).ok).toBe(
          false,
        )
        expect(decisions).toBe(0)
        expect(sends).toBe(1)
        expect(
          (await usage.read(user.value.subject)).rows.every(
            row => row.messages === 0,
          ),
        ).toBe(true)
        return
      }
      taskChannel!.send({
        ...createTaskResult(original!, agent.address, {
          outcome: 'failed',
          code: ProtocolErrorCode.E_TASK_TIMEOUT,
          reason: 'approval wait expired',
        }),
        hops: ['worker'],
      })
      await until(async () => {
        const result = await chat.transcript(opened.value.id)
        return (
          result.ok &&
          result.value.turns.some(
            row => row.author === 'agent' && row.state === 'failed',
          )
        )
      })
      if (terminal === 'reset-redeem') {
        resetOnRead = true
        expect((await approvals.continue(principal.value, input)).ok).toBe(
          false,
        )
        expect(decisions).toBe(0)
        expect(sends).toBe(1)
        expect(
          (await usage.read(user.value.subject)).rows.every(
            row => row.messages === 0,
          ),
        ).toBe(true)
        return
      }
      // Quota failure cannot issue a grant or burn the one-send intent.
      const occupied = usage.reserve(
        { subject: user.value.subject, kind: 'person' },
        { operation: 'session' },
      )
      if (!occupied.ok) throw Error('reserve')
      const denied = await approvals.continue(principal.value, input)
      expect(!denied.ok && 'quota' in denied && denied.quota.reason).toBe(
        'quota',
      )
      expect(decisions).toBe(0)
      expect(sends).toBe(1)
      usage.finish(occupied.reservationId)
      const [continued, duplicate] = await Promise.all([
        approvals.continue(principal.value, input),
        approvals.continue(principal.value, input),
      ])
      expect(continued.ok).toBe(terminal !== 'lost-receipt')
      expect(duplicate.ok).toBe(false)
      expect(sends).toBe(2)
      expect(decisions).toBe(1)
      expect(
        (await usage.read(user.value.subject)).rows.some(
          row => row.messages === 1 && row.inFlight === 1,
        ),
      ).toBe(true)
      await approvals.close()
      approvals = new ConsoleApprovals({
        ...options,
        ledger: new FileLedger(join(root, 'approvals.ndjson')),
      })
      expect((await approvals.continue(principal.value, input)).ok).toBe(false)
      expect(sends).toBe(2)
      taskChannel!.send({
        ...createTaskResult(original!, agent.address, {
          outcome: 'completed',
          content: 'done',
        }),
        hops: ['worker'],
      })
      await until(async () =>
        (await usage.read(user.value.subject)).rows.every(
          row => row.inFlight === 0,
        ),
      )
      expect(
        (await usage.read(user.value.subject)).rows.some(
          row => row.messages === 1,
        ),
      ).toBe(true)
    } finally {
      await approvals.close()
      await chat.close()
      await server.stop()
    }
  }, 15000)

for (const change of ['identity', 'exit'] as const)
  test(`continuation checks ${change} again after the socket connect await`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'qm-connect-revoke-'))
    const target = 'qianmo://worker/main'
    const agent: ConsoleAgent = {
      address: target,
      endpoint: 'ws://127.0.0.1:39999',
      capabilities: [],
      status: 'online',
      registeredAt: 1,
      lastHeartbeatAt: 1,
      expiresAt: 9999999999999,
    }
    const unused = async () => ({
      ok: false as const,
      failure: { code: 'unsupported' as const, message: 'unused' },
    })
    const registry: RegistryPort = {
      async list() {
        return { ok: true, value: [agent] }
      },
      register: unused,
      heartbeat: unused,
      deregister: unused,
    }
    const usage = new FileUsageStore({
      path: join(root, 'usage.ndjson'),
      policy: { mode: 'enforce', person: { inFlight: 1 }, job: {}, global: {} },
    })
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let dials = 0,
      connected = false,
      closed = false,
      sent = 0,
      authorized = true
    let first: QianmoMessage | undefined,
      reply: ((message: QianmoMessage) => void) | undefined
    const chat = createConsoleChatPort({
      from: 'qianmo://hub/console',
      endpoints: [
        {
          node: 'worker',
          url: agent.endpoint,
          psk: 'local-test-only-psk-0000000',
        },
      ],
      storePath: join(root, 'chat.ndjson'),
      registry,
      usage,
      exitGate: () =>
        change === 'exit' && !authorized
          ? { code: 'refused', message: 'revoked' }
          : null,
      dial(input) {
        dials++
        const second = dials === 2
        reply = input.onReply
        return {
          async connect() {
            if (second) {
              connected = true
              await gate
            }
          },
          async sendAndWait(message) {
            sent++
            first = message
            return 'accepted'
          },
          isClosed: () => !second && closed,
          async close() {},
        }
      },
    })
    try {
      const opened = await chat.open(target)
      if (!opened.ok) throw Error('open')
      expect(
        (await chat.send({ sessionId: opened.value.id, text: 'original' })).ok,
      ).toBe(true)
      reply!({
        ...createTaskResult(first!, target, {
          outcome: 'completed',
          content: 'done',
        }),
        hops: ['worker'],
      })
      closed = true
      const reservation = usage.reserve(
        { subject: 'u:0000000000000000', kind: 'person' },
        { operation: 'message' },
      )
      if (!reservation.ok) throw Error('reserve')
      const pending = chat.send({
        sessionId: opened.value.id,
        text: 'continuation',
        usageReservation: reservation.reservationId,
        continuation: {
          afterTaskId: first!.taskId,
          authorized: () => (change === 'identity' ? authorized : true),
        },
      })
      await until(() => connected)
      authorized = false
      release()
      expect((await pending).ok).toBe(false)
      expect(sent).toBe(1)
      expect((await usage.read()).rows.every(row => row.inFlight === 0)).toBe(
        true,
      )
    } finally {
      release()
      await chat.close()
      usage.close()
    }
  })

test('ordinary metered chat retains quota after an ambiguous receipt and releases on the actual terminal result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-chat-unknown-'))
  const usage = new FileUsageStore({
    path: join(root, 'usage.ndjson'),
    policy: { mode: 'enforce', person: { inFlight: 1 }, job: {}, global: {} },
  })
  const scope = { kind: 'person' as const, subject: 'u:0000000000000001' }
  const psk = 'local-only-unknown-receipt-fixture-000'
  let received: QianmoMessage | undefined
  let channel: TransportChannel | undefined
  const server = startTransportServer({
    hostname: '127.0.0.1',
    port: 0,
    psk,
    supportedTypes: Object.values(MessageType),
    onMessage(message, context) {
      if (message.type === MessageType.TaskRequest) {
        received = message
        channel = context.channel
        throw Error('receiver started work but its receipt was lost')
      }
    },
  })
  const agent: ConsoleAgent = {
    address: 'qianmo://worker/main',
    endpoint: server.url!,
    capabilities: [],
    status: 'online',
    registeredAt: 1,
    lastHeartbeatAt: 1,
    expiresAt: 9999999999999,
  }
  const unsupported = async () => ({
    ok: false as const,
    failure: { code: 'unsupported' as const, message: 'unused' },
  })
  const registry: RegistryPort = {
    list: async () => ({ ok: true, value: [agent] }),
    register: unsupported,
    deregister: unsupported,
    heartbeat: unsupported,
  }
  const hub = createConsoleChatPort({
    from: 'qianmo://console/operator',
    endpoints: [{ url: server.url!, psk }],
    registry,
    storePath: join(root, 'chat.ndjson'),
    usage,
  })
  try {
    const opened = await hub.open(agent.address)
    if (!opened.ok) throw Error('open failed')
    const reservation = usage.reserve(scope)
    if (!reservation.ok) throw Error('positive admission failed')
    const sent = await hub.send({
      sessionId: opened.value.id,
      text: 'ordinary request',
      usageReservation: reservation.reservationId,
    })
    expect(sent).toMatchObject({
      ok: false,
      failure: { deliveryUnknown: true },
    })
    expect(received?.type).toBe(MessageType.TaskRequest)
    expect(usage.reserve(scope).ok).toBe(false)
    const transcript = await hub.transcript(opened.value.id)
    expect(transcript.ok && transcript.value.turns[0]?.deliveryUnknown).toBe(
      true,
    )
    channel!.send({
      ...createTaskResult(received!, agent.address, {
        outcome: 'completed',
        content: 'finished',
      }),
      hops: ['worker'],
    })
    await until(
      async () => (await usage.read(scope.subject)).rows[0]?.inFlight === 0,
    )
    expect(usage.reserve(scope).ok).toBe(true)
  } finally {
    await hub.close()
    await server.stop()
    usage.close()
  }
})
