// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The signed handshake over a real socket — P12.3's DoD 2, 3 and 4.
 *
 * A real `Bun.serve` and a real dial, over a unix socket for the reason the
 * rest of this suite uses one (two TCP servers can bind the same port without
 * either erroring). No mocks: what is being tested is which of two proofs a
 * listener takes and what a dialer does with the answer, and both of those are
 * decisions made about bytes that actually crossed a socket.
 *
 * The migration matrix in `interop` is the point of the whole package change:
 * every cell of it has to work, because a fleet is upgraded one node at a time.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  StaticPublicKeyDirectory,
  generateNodeKeyPair,
  type NodeKeyPair,
} from '@qianmo/capability'
import type { QianmoMessage } from '@qianmo/protocol'
import {
  HandshakeRejection,
  ReadyRejection,
  TransportClient,
  TransportEventType,
  startTransportServer,
  type TransportServerHandle,
} from '../src/index.js'
import { TEST_PSK, makeMessage, makeSocketPath, waitUntil } from './helpers.js'

const FAST_BACKOFF = {
  baseDelayMs: 10,
  maxDelayMs: 20,
  giveUpAfterMs: 120,
  jitterRatio: 0,
} as const

const LISTENER = 'node-b'
const DIALER = 'node-a'

const listenerKeys = generateNodeKeyPair()
const dialerKeys = generateNodeKeyPair()
const impostorKeys = generateNodeKeyPair()

/** Every node's published key, as a directory that has finished converging. */
function fullDirectory(): StaticPublicKeyDirectory {
  return new StaticPublicKeyDirectory([
    [LISTENER, listenerKeys.publicKey],
    [DIALER, dialerKeys.publicKey],
  ])
}

const servers: TransportServerHandle[] = []
const clients: TransportClient[] = []
const cleanups: Array<() => void> = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const server of servers.splice(0)) await server.stop()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

interface Hop {
  readonly server: TransportServerHandle
  readonly client: TransportClient
  readonly handled: QianmoMessage[]
}

/** One hop, with each half independently signing or not. */
function hop(options: {
  listenerSigns: boolean
  dialerSigns: boolean
  listenerRequires?: boolean
  dialerRequires?: boolean
  dialerKeys?: NodeKeyPair
  listenerKeys?: NodeKeyPair
  listenerNode?: string
  directory?: StaticPublicKeyDirectory
}): Hop {
  const socket = makeSocketPath()
  cleanups.push(socket.cleanup)
  const handled: QianmoMessage[] = []
  const directory = options.directory ?? fullDirectory()

  const server = startTransportServer({
    unix: socket.path,
    psk: TEST_PSK,
    onMessage: message => {
      handled.push(message)
    },
    ...(options.listenerSigns
      ? {
          signing: {
            node: options.listenerNode ?? LISTENER,
            keys: options.listenerKeys ?? listenerKeys,
            directory,
            ...(options.listenerRequires === undefined
              ? {}
              : { required: options.listenerRequires }),
          },
        }
      : {}),
  })
  servers.push(server)

  const client = new TransportClient({
    endpoint: { unix: socket.path },
    node: DIALER,
    peerNode: LISTENER,
    psk: TEST_PSK,
    keepAliveIntervalMs: 0,
    backoff: FAST_BACKOFF,
    ...(options.dialerSigns
      ? {
          signing: {
            keys: options.dialerKeys ?? dialerKeys,
            directory,
            ...(options.dialerRequires === undefined
              ? {}
              : { required: options.dialerRequires }),
          },
        }
      : {}),
  })
  clients.push(client)
  return { server, client, handled }
}

describe('DoD 3 — the migration matrix, one cell at a time', () => {
  test('both halves signed: an envelope crosses and `node` came from the signature', async () => {
    const { server, client, handled } = hop({
      listenerSigns: true,
      dialerSigns: true,
    })
    await client.connect(5_000)
    client.send(makeMessage({ payload: { signed: true } }))
    await client.waitForDrain()
    expect(handled).toHaveLength(1)

    const accepted = server.events.byType(TransportEventType.AuthAccepted)
    expect(accepted).toHaveLength(1)
    expect(accepted[0]?.detail['node']).toBe(DIALER)
  })

  test('signing dialer, pre-shared-key listener: the MAC carries it', async () => {
    // The listener has no keys at all — an un-upgraded node. The dialer's
    // `sig` rides along unread and the frame is still good.
    const { client, handled } = hop({ listenerSigns: false, dialerSigns: true })
    await client.connect(5_000)
    client.send(makeMessage())
    await client.waitForDrain()
    expect(handled).toHaveLength(1)
  })

  test('pre-shared-key dialer, signing listener: also carries', async () => {
    const { client, handled } = hop({ listenerSigns: true, dialerSigns: false })
    await client.connect(5_000)
    client.send(makeMessage())
    await client.waitForDrain()
    expect(handled).toHaveLength(1)
  })

  test('a signing listener still signs its ready for an unsigned dialer', async () => {
    // Two independent claims: a dialer must not have to prove itself by
    // signature before it is allowed to check who answered.
    const { client, handled } = hop({ listenerSigns: true, dialerSigns: false })
    await client.connect(5_000)
    client.send(makeMessage())
    await client.waitForDrain()
    expect(handled).toHaveLength(1)
  })
})

describe('DoD 2 — the listener takes whichever proof is offered', () => {
  test('a forged signature is refused, and the wire says only "unauthorized"', async () => {
    const { server, client } = hop({
      listenerSigns: true,
      dialerSigns: true,
      dialerKeys: impostorKeys,
    })
    await expect(client.connect(5_000)).rejects.toThrow(/4003/)

    const rejected = server.events.byType(TransportEventType.AuthRejected)
    expect(rejected[0]?.detail['rejection']).toBe(
      HandshakeRejection.BadSignature,
    )
    // The distinction is in our record and nowhere else: the dialer got the
    // same close code and the same reason a bad MAC would have got.
    expect(rejected[0]?.detail['closeCode']).toBe(4003)
    const closed = client.events.byType(TransportEventType.AuthRejected)
    expect(closed[0]?.detail['code']).toBe(4003)
  })

  test('a dialer whose key is not published yet is refused', async () => {
    const { server, client } = hop({
      listenerSigns: true,
      dialerSigns: true,
      directory: new StaticPublicKeyDirectory([
        [LISTENER, listenerKeys.publicKey],
      ]),
    })
    await expect(client.connect(5_000)).rejects.toThrow(/4003/)
    expect(
      server.events.byType(TransportEventType.AuthRejected)[0]?.detail[
        'rejection'
      ],
    ).toBe(HandshakeRejection.UnknownSigner)
  })

  test('`required` retires the pre-shared key on that listener (§8.2 phase ③)', async () => {
    const { server, client } = hop({
      listenerSigns: true,
      dialerSigns: false,
      listenerRequires: true,
    })
    await expect(client.connect(5_000)).rejects.toThrow(/4003/)
    expect(
      server.events.byType(TransportEventType.AuthRejected)[0]?.detail[
        'rejection'
      ],
    ).toBe(HandshakeRejection.SignatureRequired)
  })

  test('`required` still admits a signing dialer', async () => {
    const { client, handled } = hop({
      listenerSigns: true,
      dialerSigns: true,
      listenerRequires: true,
    })
    await client.connect(5_000)
    client.send(makeMessage())
    await client.waitForDrain()
    expect(handled).toHaveLength(1)
  })
})

describe('§7.1.1 — the dialer checks the listener back', () => {
  test('an endpoint answering as another node never becomes ready (T-B′)', async () => {
    // A node inside the network — its own key published, its own certificate
    // valid — answering a dial meant for `node-b`. Nothing about it is forged;
    // it simply is not who was dialled.
    const { client } = hop({
      listenerSigns: true,
      dialerSigns: true,
      listenerNode: 'node-c',
      listenerKeys: impostorKeys,
      directory: new StaticPublicKeyDirectory([
        [LISTENER, listenerKeys.publicKey],
        [DIALER, dialerKeys.publicKey],
        ['node-c', impostorKeys.publicKey],
      ]),
    })
    // Not fatal, by design: the endpoint record may be mid-update. It retries
    // and reports through the reconnect budget instead.
    await expect(client.connect(5_000)).rejects.toThrow(/budget exhausted/)
    expect(client.isReady()).toBe(false)
    const rejected = client.events.byType(TransportEventType.AuthRejected)
    expect(rejected[0]?.detail['rejection']).toBe(ReadyRejection.WrongNode)
    expect(rejected[0]?.detail['face']).toBe('ready')
  })

  test('a listener claiming the right name with the wrong key is refused', async () => {
    const { client } = hop({
      listenerSigns: true,
      dialerSigns: true,
      listenerKeys: impostorKeys,
    })
    await expect(client.connect(5_000)).rejects.toThrow(/budget exhausted/)
    expect(
      client.events.byType(TransportEventType.AuthRejected)[0]?.detail[
        'rejection'
      ],
    ).toBe(ReadyRejection.BadSignature)
  })

  test('a dialer with `required` refuses an unsigned listener', async () => {
    const { client } = hop({
      listenerSigns: false,
      dialerSigns: true,
      dialerRequires: true,
    })
    await expect(client.connect(5_000)).rejects.toThrow(/budget exhausted/)
    expect(
      client.events.byType(TransportEventType.AuthRejected)[0]?.detail[
        'rejection'
      ],
    ).toBe(ReadyRejection.Unsigned)
  })

  test('a rejected ready leaves nothing behind that the retry could reuse', async () => {
    const { server, client } = hop({
      listenerSigns: true,
      dialerSigns: true,
      listenerKeys: impostorKeys,
    })
    await expect(client.connect(5_000)).rejects.toThrow(/budget exhausted/)
    // Each retry issued a fresh challenge and each was refused on its own
    // merits — a remembered nonce pair would have been the replay the
    // challenge exists to prevent.
    await waitUntil(() => server.connections === 0)
    expect(
      client.events.byType(TransportEventType.AuthRejected).length,
    ).toBeGreaterThan(1)
  })

  test('signing without a peer node to check against is refused at construction', () => {
    expect(
      () =>
        new TransportClient({
          endpoint: { unix: '/nonexistent.sock' },
          node: DIALER,
          psk: TEST_PSK,
          signing: { keys: dialerKeys, directory: fullDirectory() },
        }),
    ).toThrow(/signing requires peerNode/)
  })
})
