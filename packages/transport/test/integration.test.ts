// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test } from 'bun:test'
import {
  MessageType,
  createMessage,
  type QianmoMessage,
} from '@qianmo/protocol'
import {
  DedupTable,
  TransportClient,
  TransportEventType,
  startTransportServer,
  type TransportServerHandle,
} from '../src/index.js'
import {
  RECIPIENT,
  SENDER,
  TEST_PSK,
  WRONG_PSK,
  makeMessage,
  makeSocketPath,
  sleep,
  waitUntil,
} from './helpers.js'

/**
 * The three P2.2 acceptance criteria, end to end over a real socket.
 *
 * Unix domain socket rather than TCP, by the roadmap's own test rule for this
 * package: two servers can bind the same TCP port without either erroring, and
 * Linux then splits arriving connections between them non-deterministically. A
 * socket path in a private temp directory has no such failure mode. TCP is for
 * the cross-machine run.
 *
 * Reconnect delays are compressed (20 ms base, 60 ms ceiling) so a real outage
 * can be staged inside a test. That makes the run *harsher* than the 30 s case
 * in the acceptance criterion, not gentler: a 600 ms outage at these settings
 * costs about ten reconnect attempts, where 30 s at the shipped defaults costs
 * five. The shipped defaults are checked arithmetically in `backoff.test.ts`.
 */

const FAST_BACKOFF = {
  baseDelayMs: 20,
  maxDelayMs: 60,
  jitterRatio: 0,
} as const

const servers: TransportServerHandle[] = []
const clients: TransportClient[] = []
const cleanups: Array<() => void> = []

function track<T extends TransportServerHandle>(server: T): T {
  servers.push(server)
  return server
}

function trackClient(client: TransportClient): TransportClient {
  clients.push(client)
  return client
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const server of servers.splice(0)) await server.stop()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('DoD 1 — an outage is survived and nothing is lost', () => {
  test('the peer disappears mid-stream, comes back, and every message lands exactly once', async () => {
    const socket = makeSocketPath()
    cleanups.push(socket.cleanup)

    const handled: QianmoMessage[] = []
    // One dedup table across both server lifetimes: the peer process restarts,
    // but the node it belongs to remembers what it has already taken in. That
    // is what makes at-least-once safe across a restart.
    const dedup = new DedupTable()
    const onMessage = (message: QianmoMessage): void => {
      handled.push(message)
    }

    track(
      startTransportServer({
        unix: socket.path,
        psk: TEST_PSK,
        onMessage,
        dedup,
      }),
    )

    const client = trackClient(
      new TransportClient({
        endpoint: { unix: socket.path },
        node: 'node-a',
        psk: TEST_PSK,
        backoff: FAST_BACKOFF,
        keepAliveIntervalMs: 0,
      }),
    )
    await client.connect()

    const before = makeMessage({ payload: { seq: 1 } })
    client.send(before)
    await client.waitForDrain()
    expect(handled).toHaveLength(1)

    // --- the cable is pulled -------------------------------------------------
    await servers.splice(0)[0]?.stop()
    await waitUntil(() => !client.isReady())

    // Work keeps arriving while the link is down. Nothing may be dropped and
    // nothing may throw at the caller: a disconnected transport is the normal
    // case this package exists for.
    const during = [2, 3, 4].map(seq => makeMessage({ payload: { seq } }))
    for (const message of during) client.send(message)
    expect(client.pending).toBe(3)

    // Stay down long enough to exercise repeated backoff attempts.
    await sleep(600)
    expect(handled).toHaveLength(1)
    expect(client.pending).toBe(3)

    // --- the cable is plugged back in ---------------------------------------
    // Nothing clears the socket path by hand: a node that restarts has to be
    // able to take its own address back, which is why `stop()` unlinks it.
    track(
      startTransportServer({
        unix: socket.path,
        psk: TEST_PSK,
        onMessage,
        dedup,
      }),
    )

    await client.waitForDrain(5_000)
    expect(handled.map(message => message.msgId)).toEqual([
      before.msgId,
      ...during.map(message => message.msgId),
    ])

    const reconnects = client.events.byType(
      TransportEventType.ReconnectScheduled,
    )
    expect(reconnects.length).toBeGreaterThan(3)
  })
})

describe('DoD 2 — three deliveries, one handling', () => {
  test('the same envelope sent three times is handled once', async () => {
    const socket = makeSocketPath()
    cleanups.push(socket.cleanup)

    const handled: QianmoMessage[] = []
    const server = track(
      startTransportServer({
        unix: socket.path,
        psk: TEST_PSK,
        onMessage: message => {
          handled.push(message)
        },
      }),
    )

    const client = trackClient(
      new TransportClient({
        endpoint: { unix: socket.path },
        node: 'node-a',
        psk: TEST_PSK,
        backoff: FAST_BACKOFF,
        keepAliveIntervalMs: 0,
      }),
    )
    await client.connect()

    const message = makeMessage({ taskId: 'task-dup', payload: { seq: 42 } })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      client.send(message)
      await client.waitForDrain()
    }

    expect(handled).toHaveLength(1)
    expect(handled[0]?.msgId).toBe(message.msgId)
    expect(
      server.events.byType(TransportEventType.MessageAccepted),
    ).toHaveLength(1)
    expect(
      server.events.byType(TransportEventType.MessageDuplicate),
    ).toHaveLength(2)
  })

  test('a rebuilt envelope for the same work is caught by the fingerprint', async () => {
    const socket = makeSocketPath()
    cleanups.push(socket.cleanup)

    const handled: QianmoMessage[] = []
    const server = track(
      startTransportServer({
        unix: socket.path,
        psk: TEST_PSK,
        onMessage: message => {
          handled.push(message)
        },
      }),
    )

    const client = trackClient(
      new TransportClient({
        endpoint: { unix: socket.path },
        node: 'node-a',
        psk: TEST_PSK,
        backoff: FAST_BACKOFF,
        keepAliveIntervalMs: 0,
      }),
    )
    await client.connect()

    const first = makeMessage({ taskId: 'task-restart', payload: { seq: 7 } })
    client.send(first)
    await client.waitForDrain()

    // What a sender that crashed and restarted emits: fresh msgId and
    // createdAt for the same piece of work.
    const rebuilt = createMessage({
      from: SENDER,
      to: RECIPIENT,
      type: MessageType.TaskRequest,
      payload: { seq: 7 },
      taskId: 'task-restart',
    })
    expect(rebuilt.msgId).not.toBe(first.msgId)
    client.send(rebuilt)
    await client.waitForDrain()

    expect(handled).toHaveLength(1)
    expect(
      server.events.byType(TransportEventType.MessageDuplicate),
    ).toHaveLength(1)
  })
})

describe('DoD 3 — a wrong key is refused and recorded', () => {
  test('the dial fails, nothing is delivered, and the rejection is on record', async () => {
    const socket = makeSocketPath()
    cleanups.push(socket.cleanup)

    const handled: QianmoMessage[] = []
    const server = track(
      startTransportServer({
        unix: socket.path,
        psk: TEST_PSK,
        onMessage: message => {
          handled.push(message)
        },
      }),
    )

    const client = trackClient(
      new TransportClient({
        endpoint: { unix: socket.path },
        node: 'node-a',
        psk: WRONG_PSK,
        backoff: FAST_BACKOFF,
        keepAliveIntervalMs: 0,
      }),
    )

    await expect(client.connect()).rejects.toThrow(/4003/)
    expect(client.isReady()).toBe(false)
    expect(handled).toHaveLength(0)

    const rejections = server.events.byType(TransportEventType.AuthRejected)
    expect(rejections).toHaveLength(1)
    expect(rejections[0]?.detail).toMatchObject({
      rejection: 'bad_mac',
      node: 'node-a',
      closeCode: 4003,
    })

    // A refused key is permanent: no reconnect storm against a door that will
    // not open.
    await sleep(300)
    expect(
      client.events.byType(TransportEventType.ReconnectScheduled),
    ).toHaveLength(0)
    await waitUntil(() => server.connections === 0)
  })

  test('the right key on the same server still works', async () => {
    const socket = makeSocketPath()
    cleanups.push(socket.cleanup)

    const handled: QianmoMessage[] = []
    track(
      startTransportServer({
        unix: socket.path,
        psk: TEST_PSK,
        onMessage: message => {
          handled.push(message)
        },
      }),
    )

    const good = trackClient(
      new TransportClient({
        endpoint: { unix: socket.path },
        node: 'node-a',
        psk: TEST_PSK,
        backoff: FAST_BACKOFF,
        keepAliveIntervalMs: 0,
      }),
    )
    await good.connect()
    good.send(makeMessage({ payload: { seq: 1 } }))
    await good.waitForDrain()
    expect(handled).toHaveLength(1)
  })
})

describe('the receiving node refuses what is not a valid envelope', () => {
  test('a malformed envelope is rejected, not handled', async () => {
    const socket = makeSocketPath()
    cleanups.push(socket.cleanup)

    const handled: QianmoMessage[] = []
    const server = track(
      startTransportServer({
        unix: socket.path,
        psk: TEST_PSK,
        onMessage: message => {
          handled.push(message)
        },
      }),
    )

    const client = trackClient(
      new TransportClient({
        endpoint: { unix: socket.path },
        node: 'node-a',
        psk: TEST_PSK,
        backoff: FAST_BACKOFF,
        keepAliveIntervalMs: 0,
      }),
    )
    await client.connect()

    // An envelope whose `to` is not an address. Typing keeps this out of
    // production code, which is why the test has to construct it by hand.
    const bogus = {
      ...makeMessage(),
      to: 'not-an-address',
    } as unknown as QianmoMessage
    client.send(bogus)

    await waitUntil(
      () => server.events.byType(TransportEventType.MessageRejected).length > 0,
    )
    expect(handled).toHaveLength(0)
    // The sender is told, and stops retrying a message that can never parse.
    await waitUntil(() => client.pending === 0)
    expect(
      client.events.byType(TransportEventType.MessageRejected)[0]?.detail[
        'code'
      ],
    ).toBe('E_BAD_ADDRESS')
  })
})
