// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import {
  generateNodeKeyPair,
  StaticPublicKeyDirectory,
  issueCapability,
} from '@qianmo/capability'
import {
  CapabilityLevel,
  CONTROL_MESSAGE_TYPES,
  LEGACY_MESSAGE_TYPES,
  createMessage,
  type QianmoMessage,
  MessageType,
  ProtocolErrorCode,
} from '@qianmo/protocol'
import {
  startTransportServer,
  type InboundContext,
  type TransportServerHandle,
} from '@qianmo/transport'
import { parseConsoleArgs } from '../../src/commands/consoleArgs.js'
import { ControlLinks } from '../../src/commands/consoleControl.js'
import {
  buildHandshakeSigning,
  createResidentCapabilities,
  parseResidentArgs,
} from '../../src/commands/resident.js'

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('control links condition timed out')
    await Bun.sleep(10)
  }
}

test('CLI control targets require named ws(s) endpoints and explicit pinned node keys', () => {
  const key = generateNodeKeyPair().publicKey
  const config = parseConsoleArgs([
    '--control',
    'worker=ws://127.0.0.1:7321',
    '--control=other=wss://other.example/',
    '--trust',
    `worker=${key}`,
    '--trust',
    `other=${key}`,
  ])
  expect(config.controlTargets?.map(target => target.node)).toEqual([
    'worker',
    'other',
  ])
  for (const value of [
    'ws://127.0.0.1:7321',
    'worker=https://worker.example',
    'worker=ws://user:pass@worker.example',
    'Bad=ws://worker.example',
  ])
    expect(() =>
      parseConsoleArgs(['--control', value, '--trust', `worker=${key}`]),
    ).toThrow()
  expect(() =>
    parseConsoleArgs(['--control', 'worker=ws://worker.example']),
  ).toThrow('explicit --trust')
  expect(() =>
    parseConsoleArgs([
      '--control',
      'worker=ws://worker.example',
      '--control',
      'worker=ws://other.example',
      '--trust',
      `worker=${key}`,
    ]),
  ).toThrow('repeats')
})

test('controller pins enable signed L1 without adding task issuer trust; duplicate/conflicting keys fail', () => {
  const hubKeys = generateNodeKeyPair(),
    workerKeys = generateNodeKeyPair()
  const base = [
    '--node',
    'worker',
    '--team',
    'nest',
    '--agent',
    'main=/workspace',
    '--port',
    '0',
    '--hostname',
    '127.0.0.1',
  ]
  const config = parseResidentArgs([
    ...base,
    '--controller',
    `hub=${hubKeys.publicKey}`,
  ])
  const directory = new StaticPublicKeyDirectory()
  const signing = buildHandshakeSigning(config, workerKeys, directory)
  expect(signing?.required).toBe(true)
  expect(signing?.directory.publicKeyOf('hub')).toBe(hubKeys.publicKey)
  expect(directory.publicKeyOf('hub')).toBeNull()
  const request = createMessage({
    from: 'qianmo://hub/operator',
    to: 'qianmo://worker/main',
    type: MessageType.TaskRequest,
    payload: { text: 'task' },
  })
  const capability = issueCapability('hub', hubKeys, {
    sub: request.to,
    aud: 'worker',
    act: CapabilityLevel.WriteLimited,
    taskId: request.taskId,
    nbf: request.createdAt - 1,
    exp: request.createdAt + 60_000,
  })
  expect(
    createResidentCapabilities(config, directory, workerKeys, () => {}).check(
      { ...request, cap: capability },
      Date.now(),
    ),
  ).toMatchObject({ ok: false, code: ProtocolErrorCode.E_CAP_INVALID })
  expect(() =>
    parseResidentArgs([
      ...base,
      '--controller',
      `hub=${hubKeys.publicKey}`,
      '--controller',
      `hub=${hubKeys.publicKey}`,
    ]),
  ).toThrow('duplicate controller')
  expect(() =>
    parseResidentArgs([
      ...base,
      '--controller',
      `hub=${hubKeys.publicKey}`,
      '--trust',
      `hub=${workerKeys.publicKey}`,
    ]),
  ).toThrow('disagree')
  expect(() =>
    parseResidentArgs([...base, '--controller', 'hub=invalid']),
  ).toThrow()
})

test('ControlLinks reconnects and resubscribes; only correlated replies and authenticated upstream agents resolve calls', async () => {
  const nodeKeys = generateNodeKeyPair(),
    hubKeys = generateNodeKeyPair()
  const directory = new StaticPublicKeyDirectory([
    ['hub', hubKeys.publicKey],
    ['worker', nodeKeys.publicKey],
  ])
  const psk = 'control-links-loopback-psk-00000'
  let subscriptions = 0,
    context: InboundContext | undefined
  const held: string[] = []
  const server = (port: number): TransportServerHandle =>
    startTransportServer({
      psk,
      hostname: '127.0.0.1',
      port,
      supportedTypes: [...LEGACY_MESSAGE_TYPES, ...CONTROL_MESSAGE_TYPES],
      signing: { node: 'worker', keys: nodeKeys, directory, required: true },
      onMessage: (message, ctx) => {
        if (message.type === MessageType.HubSubscribe) {
          subscriptions++
          context = ctx
          return
        }
        if (message.type === MessageType.HubCallResult) {
          held.push(message.taskId)
          return
        }
        if (message.type !== MessageType.NodeControl) return
        // This peer predates operation-id negotiation and still requires the
        // exact legacy request keys.
        expect(
          Object.keys(message.payload as Record<string, unknown>).sort(),
        ).toEqual(['actor', 'args', 'op'])
        if ((message.payload as { op: string }).op === 'test.timeout') return
        const reply = createMessage({
          from: message.to,
          to: message.from,
          taskId: message.taskId,
          type: MessageType.NodeControlResult,
          payload: { ok: true, value: 'right' },
        })
        ctx.channel.send(
          createMessage({
            ...reply,
            msgId: undefined,
            fingerprint: undefined,
            taskId: 'unrelated',
          }),
        )
        ctx.channel.send(
          createMessage({
            ...reply,
            msgId: undefined,
            fingerprint: undefined,
            from: 'qianmo://worker/other',
          }),
        )
        ctx.channel.send(reply)
      },
    })
  let listener = server(0)
  const port = listener.port!
  const hub = new ControlLinks({
    from: 'qianmo://hub/operator',
    commandKeys: hubKeys,
    targets: [
      {
        node: 'worker',
        url: listener.url!,
        publicKey: nodeKeys.publicKey,
        psk,
      },
    ],
  })
  const calls: { node: string; agent?: string }[] = []
  hub.onHubCall('connector', async (_op, _args, ctx) => {
    calls.push(ctx)
    return { ok: true, value: ctx.node }
  })
  expect(() =>
    hub.onHubCall('connector', async () => ({ ok: true, value: null })),
  ).toThrow('duplicate')
  try {
    hub.start()
    await until(() => hub.status()[0]?.connected === true)
    expect(await hub.request('worker', 'test.echo', {}, 'admin')).toEqual({
      ok: true,
      value: 'right',
    })
    expect(
      await hub.request('worker', 'test.timeout', {}, 'admin', {
        timeoutMs: 20,
      }),
    ).toMatchObject({ ok: false, code: 'unknown' })
    const request = createMessage({
      from: 'qianmo://worker/main',
      to: 'qianmo://hub/operator',
      type: MessageType.HubCall,
      payload: {
        callId: crypto.randomUUID(),
        op: 'connector.read',
        args: { node: 'forged' },
      },
    })
    await context!.channel.sendAndWait(request)
    await until(() => held.includes(request.taskId))
    expect(calls).toEqual([{ node: 'worker', agent: 'main' }])
    const forged = createMessage({
      from: 'qianmo://other/main',
      to: request.to,
      type: MessageType.HubCall,
      payload: { callId: crypto.randomUUID(), op: 'connector.read', args: {} },
    })
    await expect(context!.channel.sendAndWait(forged)).rejects.toThrow()
    expect(calls).toHaveLength(1)
    const firstConnected = hub.status()[0]!.lastConnectedAt!
    const pending = hub.request('worker', 'test.timeout', {}, 'admin')
    await listener.stop()
    expect(await pending).toMatchObject({ ok: false, code: 'unknown' })
    expect(hub.status()[0]).toMatchObject({
      connected: false,
      lastConnectedAt: firstConnected,
    })
    listener = server(port)
    await until(() => hub.status()[0]?.connected === true)
    expect(subscriptions).toBe(2)
    expect(hub.status()[0]!.lastConnectedAt!).toBeGreaterThan(firstConnected)
    expect(await hub.request('worker', 'test.echo', {}, 'admin')).toEqual({
      ok: true,
      value: 'right',
    })
  } finally {
    await hub.close()
    await listener.stop()
  }
}, 20_000)

test('a peer advertising only legacy types never receives control traffic', async () => {
  const nodeKeys = generateNodeKeyPair(),
    hubKeys = generateNodeKeyPair()
  const messages: string[] = []
  const listener = startTransportServer({
    psk: 'control-legacy-fixture-psk-0000',
    hostname: '127.0.0.1',
    port: 0,
    signing: {
      node: 'worker',
      keys: nodeKeys,
      directory: new StaticPublicKeyDirectory([['hub', hubKeys.publicKey]]),
      required: true,
    },
    onMessage: message => {
      messages.push(message.type)
    },
  })
  const hub = new ControlLinks({
    from: 'qianmo://hub/operator',
    commandKeys: hubKeys,
    targets: [
      {
        node: 'worker',
        url: listener.url!,
        publicKey: nodeKeys.publicKey,
        psk: 'control-legacy-fixture-psk-0000',
      },
    ],
  })
  try {
    hub.start()
    await until(() => hub.status()[0]?.lastError !== null)
    expect(await hub.request('worker', 'node.ping', {}, 'admin')).toMatchObject(
      { ok: false, code: 'unreachable' },
    )
    expect(messages).toEqual([])
  } finally {
    await hub.close()
    await listener.stop()
  }
})

test('a rejected transport receipt after an effect cannot claim the business operation failed', async () => {
  const nodeKeys = generateNodeKeyPair(),
    hubKeys = generateNodeKeyPair()
  const directory = new StaticPublicKeyDirectory([
    ['hub', hubKeys.publicKey],
    ['worker', nodeKeys.publicKey],
  ])
  const psk = 'fx2-rejected-receipt-psk-000000'
  let effects = 0
  const listener = startTransportServer({
    psk,
    port: 0,
    supportedTypes: [...LEGACY_MESSAGE_TYPES, ...CONTROL_MESSAGE_TYPES],
    signing: { node: 'worker', keys: nodeKeys, directory, required: true },
    onMessage: (message, ctx) => {
      if (message.type !== MessageType.NodeControl) return
      if ((message.payload as { op: string }).op === 'test.write') {
        effects++
        throw new Error('fixture transport handler failed after effect')
      }
      ctx.channel.send(
        createMessage({
          from: message.to,
          to: message.from,
          taskId: message.taskId,
          type: MessageType.NodeControlResult,
          payload: { ok: true, value: effects },
        }),
      )
    },
  })
  const hub = new ControlLinks({
    from: 'qianmo://hub/operator',
    commandKeys: hubKeys,
    targets: [
      {
        node: 'worker',
        url: listener.url!,
        psk,
        publicKey: nodeKeys.publicKey,
      },
    ],
  })
  try {
    hub.start()
    await until(() => hub.status()[0]?.connected === true)
    expect(
      await hub.request('worker', 'test.write', {}, 'admin'),
    ).toMatchObject({ ok: false, code: 'unknown' })
    expect(await hub.request('worker', 'test.read', {}, 'admin')).toEqual({
      ok: true,
      value: 1,
    })
  } finally {
    await hub.close()
    await listener.stop()
  }
})

test('a written but unreceipted control call becomes unknown and is not replayed to a restarted receiver', async () => {
  const nodeKeys = generateNodeKeyPair(),
    hubKeys = generateNodeKeyPair()
  const directory = new StaticPublicKeyDirectory([
    ['hub', hubKeys.publicKey],
    ['worker', nodeKeys.publicKey],
  ])
  const psk = 'fx2-no-replay-loopback-psk-00000'
  const blocked = Promise.withResolvers<void>()
  let writes = 0,
    oldRequest: QianmoMessage | undefined
  const createServer = (port: number) =>
    startTransportServer({
      psk,
      hostname: '127.0.0.1',
      port,
      supportedTypes: [...LEGACY_MESSAGE_TYPES, ...CONTROL_MESSAGE_TYPES],
      signing: { node: 'worker', keys: nodeKeys, directory, required: true },
      onMessage: async (message, ctx) => {
        if (message.type !== MessageType.NodeControl) return
        if ((message.payload as { op: string }).op === 'test.write') {
          writes++
          oldRequest = message
          await blocked.promise
          return
        }
        if (oldRequest)
          ctx.channel.send(
            createMessage({
              from: oldRequest.to,
              to: oldRequest.from,
              taskId: oldRequest.taskId,
              type: MessageType.NodeControlResult,
              payload: { ok: true, value: 'stale' },
            }),
          )
        ctx.channel.send(
          createMessage({
            from: message.to,
            to: message.from,
            taskId: message.taskId,
            type: MessageType.NodeControlResult,
            payload: { ok: true, value: 'new' },
          }),
        )
      },
    })
  let listener = createServer(0)
  const port = listener.port!
  const hub = new ControlLinks({
    from: 'qianmo://hub/operator',
    commandKeys: hubKeys,
    targets: [
      {
        node: 'worker',
        url: listener.url!,
        psk,
        publicKey: nodeKeys.publicKey,
      },
    ],
  })
  try {
    hub.start()
    await until(() => hub.status()[0]?.connected === true)
    const pending = hub.request('worker', 'test.write', {}, 'admin')
    await until(() => writes === 1)
    await listener.stop()
    expect(await pending).toMatchObject({ ok: false, code: 'unknown' })
    listener = createServer(port)
    await until(() => hub.status()[0]?.connected === true)
    expect(await hub.request('worker', 'test.read', {}, 'admin')).toEqual({
      ok: true,
      value: 'new',
    })
    expect(writes).toBe(1)
  } finally {
    blocked.resolve()
    await hub.close()
    await listener.stop()
  }
}, 20_000)
