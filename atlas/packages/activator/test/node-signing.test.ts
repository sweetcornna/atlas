// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import {
  generateNodeKeyPair,
  StaticPublicKeyDirectory,
} from '@qianmo/capability'
import {
  createAck,
  createMessage,
  createTaskResult,
  MessageType,
  type QianmoMessage,
} from '@qianmo/protocol'
import { TransportClient, startTransportServer } from '@qianmo/transport'
import {
  AuditLog,
  HttpSandboxDaemon,
  MemoryRequestJournal,
  StaticTargetDirectory,
  startActivatorNode,
} from '../src/index.js'
import { makeSocketDir, waitUntil } from './helpers.js'
import { startStubDaemon, STUB_TOKEN } from './stub-daemon.js'

const psk = 'activator-signing-fixture-not-production'
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(
  options: {
    missingTarget?: boolean
    wrongTarget?: boolean
    unsignedTarget?: boolean
  } = {},
) {
  const caller = generateNodeKeyPair(),
    host = generateNodeKeyPair(),
    target = generateNodeKeyPair()
  const sockets = makeSocketDir()
  cleanups.push(sockets.cleanup)
  const daemon = startStubDaemon({
    sandboxes: ['sandbox'],
    initialState: 'frozen',
  })
  cleanups.push(() => daemon.stop())
  const targetReceived: QianmoMessage[] = [],
    peers: (string | null | undefined)[] = []
  const targetServer = startTransportServer({
    unix: sockets.socket('target'),
    psk,
    ...(options.unsignedTarget
      ? {}
      : {
          signing: {
            node: 'target',
            keys: target,
            directory: new StaticPublicKeyDirectory([['host', host.publicKey]]),
            required: true,
          },
        }),
    onMessage(message, context) {
      peers.push(context.channel.authenticatedPeerNode)
      targetReceived.push(message)
      // Two forged terminal replies must not remove the real return route.
      const valid = createTaskResult(message, message.to, {
        outcome: 'completed',
        content: 'OK',
      })
      context.channel.send({
        ...valid,
        msgId: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
      })
      context.channel.send({
        ...valid,
        msgId: crypto.randomUUID(),
        contextId: crypto.randomUUID(),
      })
      context.channel.send(createAck(message, message.to))
      context.channel.send(valid)
    },
  })
  cleanups.push(() => targetServer.stop())
  const audit = new AuditLog()
  const node = await startActivatorNode({
    node: 'host',
    psk,
    listen: { unix: sockets.socket('host') },
    signing: {
      node: 'host',
      keys: host,
      directory: new StaticPublicKeyDirectory([['caller', caller.publicKey]]),
      required: true,
    },
    linkSigning: {
      keys: host,
      directory: new StaticPublicKeyDirectory(
        options.missingTarget
          ? []
          : [
              [
                'target',
                options.wrongTarget
                  ? generateNodeKeyPair().publicKey
                  : target.publicKey,
              ],
            ],
      ),
      required: true,
    },
    daemon: new HttpSandboxDaemon({
      baseUrl: daemon.url,
      token: () => STUB_TOKEN,
      audit,
    }),
    directory: new StaticTargetDirectory([
      {
        node: 'target',
        sandboxName: 'sandbox',
        endpoint: { unix: sockets.socket('target') },
      },
    ]),
    journal: new MemoryRequestJournal(),
    audit,
    readyTimeoutMs: 250,
    readyPollIntervalMs: 20,
    connectTimeoutMs: 80,
    forwardTimeoutMs: 300,
  })
  cleanups.push(() => node.stop())
  const replies: QianmoMessage[] = []
  function client(mode: 'signed' | 'unsigned' | 'wrong' = 'signed') {
    const client = new TransportClient({
      node: 'caller',
      peerNode: 'host',
      psk,
      endpoint: { unix: sockets.socket('host') },
      ...(mode === 'unsigned'
        ? {}
        : {
            signing: {
              keys: mode === 'wrong' ? generateNodeKeyPair() : caller,
              directory: new StaticPublicKeyDirectory([
                ['host', host.publicKey],
              ]),
              required: true,
            },
          }),
      keepAliveIntervalMs: 0,
      onMessage(message, context) {
        expect(context.channel.authenticatedPeerNode).toBe('host')
        replies.push(message)
      },
    })
    cleanups.push(() => client.close())
    return client
  }
  return { daemon, targetReceived, peers, node, replies, client }
}
function request(from = 'qianmo://caller/operator') {
  return createMessage({
    from,
    to: 'qianmo://target/dev',
    type: MessageType.TaskRequest,
    payload: { prompt: 'OK' },
    taskTtlMs: 3000,
    deliverTtlMs: 3000,
  })
}

test('strict activator authenticates both legs and returns only correlated ack/result on original channel', async () => {
  const fixture = await setup(),
    client = fixture.client()
  await client.connect(500)
  await client.sendAndWait(request(), 2000)
  await waitUntil(() => fixture.replies.length === 2)
  expect(fixture.replies.map(message => message.type)).toEqual([
    MessageType.Ack,
    MessageType.TaskResult,
  ])
  expect(fixture.targetReceived.length).toBe(1)
  expect(fixture.peers).toEqual(['host'])
  expect(fixture.daemon.hits.acquireSandbox).toBe(1)
  expect(fixture.node.routes.size).toBe(0)
})
for (const mode of ['unsigned', 'wrong'] as const)
  test(`${mode} caller with the PSK cannot wake or dispatch`, async () => {
    const fixture = await setup(),
      client = fixture.client(mode)
    await expect(client.connect(100)).rejects.toThrow()
    expect(fixture.daemon.hits.acquireSandbox).toBe(0)
    expect(fixture.targetReceived.length).toBe(0)
  })
test('signed caller cannot forge envelope source or spend wake capacity without a target key', async () => {
  const fixture = await setup(),
    client = fixture.client()
  await client.connect(500)
  await expect(
    client.sendAndWait(request('qianmo://other/operator'), 500),
  ).rejects.toThrow()
  expect(fixture.daemon.hits.acquireSandbox).toBe(0)
  const missing = await setup({ missingTarget: true }),
    another = missing.client()
  await another.connect(500)
  await expect(another.sendAndWait(request(), 500)).rejects.toThrow()
  expect(missing.daemon.hits.acquireSandbox).toBe(0)
  expect(missing.targetReceived.length).toBe(0)
})
for (const mode of ['wrongTarget', 'unsignedTarget'] as const)
  test(`${mode} never receives a forwarded task after authorized wake`, async () => {
    const fixture = await setup({ [mode]: true }),
      client = fixture.client()
    await client.connect(500)
    await expect(client.sendAndWait(request(), 1500)).rejects.toThrow()
    expect(fixture.daemon.hits.acquireSandbox).toBe(1)
    expect(fixture.targetReceived.length).toBe(0)
  })
test('strict listener cannot start with unsigned target links', async () => {
  const keys = generateNodeKeyPair(),
    audit = new AuditLog(),
    daemon = startStubDaemon()
  cleanups.push(() => daemon.stop())
  await expect(
    startActivatorNode({
      node: 'host',
      psk,
      listen: { port: 0, hostname: '127.0.0.1' },
      signing: {
        node: 'host',
        keys,
        directory: new StaticPublicKeyDirectory([]),
        required: true,
      },
      daemon: new HttpSandboxDaemon({
        baseUrl: daemon.url,
        token: () => STUB_TOKEN,
        audit,
      }),
      directory: new StaticTargetDirectory([]),
      journal: new MemoryRequestJournal(),
    }),
  ).rejects.toThrow('mandatory signed target links')
  expect(daemon.hits.acquireSandbox).toBe(0)
})
