// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * A retained logical channel owns authenticated state, not merely a node
 * label. These tests use raw sockets so a server-originated envelope can stay
 * deliberately unreceipted while another credential tries the same channel.
 *
 * Three properties, and the second is the one that is easy to lose while
 * getting the first right:
 *
 * 1. a channel's identity is frozen at admission, and no other identity —
 *    weaker *or* stronger — inherits its outbox;
 * 2. a dialer whose own identity legitimately moved is not killed for it. It
 *    is refused with a code of its own and recovers onto a fresh channel,
 *    bounded, leaving the old channel to expire untouched;
 * 3. the exact-credential proof is checked whenever a credential is claimed —
 *    never skipped because the directory said less than expected.
 */

import {
  createServer as createNetServer,
  connect as netConnect,
  type Socket,
} from 'node:net'
import { afterEach, describe, expect, test } from 'bun:test'
import WebSocket from 'ws'
import {
  generateNodeKeyPair,
  signBytes,
  type NodeKeyPair,
} from '@qianmo/capability'
import {
  CLOSE_CHANNEL_CONFLICT,
  CLOSE_UNAUTHORIZED,
  FRAME_VERSION,
  FrameType,
  HandshakeRejection,
  MAX_CHANNEL_ROTATIONS,
  ReadyRejection,
  TransportClient,
  TransportEventType,
  authCredentialProofInput,
  authSigningInput,
  computeMac,
  newNonce,
  parseFrame,
  readyCredentialProofInput,
  readySigningInput,
  serializeFrame,
  startTransportServer,
  verifyAuthAttempt,
  verifyReady,
  type AuthAttempt,
  type AuthenticatedCredential,
  type HandshakeCredentialClaim,
  type HandshakeCredentialDirectory,
  type TransportChannel,
  type TransportEvent,
  type TransportFrame,
  type TransportServerHandle,
} from '../src/index.js'
import {
  TEST_PSK,
  WRONG_PSK,
  makeMessage,
  sleep,
  waitUntil,
} from './helpers.js'

const DIALER = 'node-a'
const LISTENER = 'node-b'
const F1 = 'fingerprint-f1'
const F2 = 'fingerprint-f2'
const K2 = 'fingerprint-key-2'

const listenerKeys = generateNodeKeyPair()
const firstKeys = generateNodeKeyPair()
const secondKeys = generateNodeKeyPair()

type RawAuthentication =
  | { readonly kind: 'psk' }
  | { readonly kind: 'signature'; readonly keys: NodeKeyPair }
  | {
      readonly kind: 'credential_signature'
      readonly keys: NodeKeyPair
      readonly credential: HandshakeCredentialClaim
    }

interface RawSession {
  readonly socket: WebSocket
  readonly outcome: 'ready' | 'closed'
  readonly closeCode: number | undefined
  readonly closed: Promise<number>
  readonly frames: TransportFrame[]
}

/** The taskId of the envelope a retained channel must never hand over. */
const RETAINED_SECRET = 'retained-only-for-the-old-identity'

const servers: TransportServerHandle[] = []
const sockets: WebSocket[] = []
const clients: TransportClient[] = []
const relays: Relay[] = []
const conflicting: ConflictingListener[] = []
const releases: Array<() => void> = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  for (const client of clients.splice(0)) await client.close()
  for (const release of releases.splice(0)) release()
  for (const relay of relays.splice(0)) await relay.close()
  for (const listener of conflicting.splice(0)) await listener.close()
  for (const server of servers.splice(0)) await server.stop()
})

function exact(
  selector: string,
  keys: NodeKeyPair = firstKeys,
): RawAuthentication {
  return {
    kind: 'credential_signature',
    keys,
    credential: { selector, source: 'certificate', id: selector },
  }
}

async function rawHandshake(
  url: string,
  channelId: string,
  authentication: RawAuthentication,
): Promise<RawSession> {
  const socket = new WebSocket(url)
  sockets.push(socket)
  const frames: TransportFrame[] = []
  let resolveClosed: (code: number) => void = () => {}
  const closed = new Promise<number>(resolve => {
    resolveClosed = resolve
  })
  const result = await new Promise<{
    readonly outcome: 'ready' | 'closed'
    readonly closeCode?: number
  }>((resolve, reject) => {
    let settled = false
    socket.once('error', reject)
    socket.once('close', code => {
      resolveClosed(code)
      if (!settled) {
        settled = true
        resolve({ outcome: 'closed', closeCode: code })
      }
    })
    socket.on('message', raw => {
      const frame = parseFrame(raw.toString())
      if (frame === null) return
      frames.push(frame)
      if (frame.t === FrameType.Challenge) {
        const clientNonce = newNonce()
        socket.send(
          serializeFrame({
            t: FrameType.Auth,
            v: FRAME_VERSION,
            node: DIALER,
            nonce: frame.nonce,
            clientNonce,
            channelId,
            mac: computeMac(
              TEST_PSK,
              frame.nonce,
              clientNonce,
              DIALER,
              channelId,
            ),
            ...(authentication.kind === 'psk'
              ? {}
              : {
                  sig: signBytes(
                    authentication.keys,
                    authSigningInput(
                      frame.nonce,
                      clientNonce,
                      DIALER,
                      channelId,
                    ),
                  ),
                }),
            ...(authentication.kind !== 'credential_signature'
              ? {}
              : {
                  credential: authentication.credential.selector,
                  credentialProof: signBytes(
                    authentication.keys,
                    authCredentialProofInput(
                      frame.nonce,
                      clientNonce,
                      DIALER,
                      channelId,
                      authentication.credential.selector,
                      authentication.credential.source,
                      authentication.credential.id,
                    ),
                  ),
                }),
          }),
        )
        return
      }
      if (frame.t === FrameType.Ready && !settled) {
        settled = true
        resolve({ outcome: 'ready' })
      }
    })
  })
  return {
    socket,
    outcome: result.outcome,
    closeCode: result.closeCode,
    closed,
    frames,
  }
}

function hasEnvelope(session: RawSession): boolean {
  return session.frames.some(frame => frame.t === FrameType.Envelope)
}

function sendRequest(session: RawSession, taskId: string): void {
  session.socket.send(
    serializeFrame({
      t: FrameType.Envelope,
      v: FRAME_VERSION,
      envelope: makeMessage({ taskId }),
    }),
  )
}

function credentialDirectory(
  legacyKey: () => string,
): HandshakeCredentialDirectory {
  return {
    publicKeyOf(node) {
      if (node === LISTENER) return listenerKeys.publicKey
      if (node === DIALER) return legacyKey()
      return null
    },
    handshakeCredentialOf(node, selector) {
      if (node !== DIALER) return null
      if (selector === F1 || selector === F2) {
        return {
          publicKey: firstKeys.publicKey,
          source: 'certificate',
          id: selector,
        }
      }
      if (selector === K2) {
        return {
          publicKey: secondKeys.publicKey,
          source: 'certificate',
          id: selector,
        }
      }
      return null
    },
  }
}

function serverFor(
  directory: HandshakeCredentialDirectory,
): TransportServerHandle {
  const server = startTransportServer({
    port: 0,
    psk: TEST_PSK,
    signing: { node: LISTENER, keys: listenerKeys, directory },
    onMessage: (_message, context) => {
      context.channel.send(
        makeMessage({
          taskId: `retained-secret-${crypto.randomUUID()}`,
          payload: { retained: true },
        }),
      )
    },
  })
  servers.push(server)
  return server
}

describe('retained channel authentication binding', () => {
  test('same exact credential replays, while F2 and another key get 4004 with no payload', async () => {
    const directory = credentialDirectory(() => firstKeys.publicKey)
    const server = serverFor(directory)
    const url = server.url ?? ''
    const channelId = '1'.repeat(32)

    const first = await rawHandshake(url, channelId, exact(F1))
    expect(first.outcome).toBe('ready')
    sendRequest(first, 'seed-retained-outbox')
    await waitUntil(() => hasEnvelope(first))
    first.socket.close(1000)
    await first.closed
    await waitUntil(() => server.connections === 0 && server.channels === 1)

    // Both sockets authenticate concurrently. Only the credential that owns
    // the retained channel may bind and trigger the outbox replay.
    const [same, f2] = await Promise.all([
      rawHandshake(url, channelId, exact(F1)),
      rawHandshake(url, channelId, exact(F2)),
    ])
    expect(same.outcome).toBe('ready')
    await waitUntil(() => hasEnvelope(same))
    expect(f2.outcome).toBe('closed')
    // 4004, not 4003: the dialer's key is fine and its channel id is taken, and
    // those two call for opposite responses (`CLOSE_CHANNEL_CONFLICT`). What
    // the code must never do is let the refused socket see the payload.
    expect(f2.closeCode).toBe(CLOSE_CHANNEL_CONFLICT)
    expect(hasEnvelope(f2)).toBe(false)

    const anotherKey = await rawHandshake(url, channelId, exact(K2, secondKeys))
    expect(anotherKey.outcome).toBe('closed')
    expect(anotherKey.closeCode).toBe(CLOSE_CHANNEL_CONFLICT)
    expect(hasEnvelope(anotherKey)).toBe(false)
    expect(same.socket.readyState).toBe(WebSocket.OPEN)
  })

  test('PSK, legacy signature, and exact signature cannot inherit each other', async () => {
    let legacyKey = firstKeys.publicKey
    const server = serverFor(credentialDirectory(() => legacyKey))
    const url = server.url ?? ''
    const psk: RawAuthentication = { kind: 'psk' }
    const legacy: RawAuthentication = { kind: 'signature', keys: firstKeys }
    const credential = exact(F1)
    const transitions: readonly (readonly [
      RawAuthentication,
      RawAuthentication,
    ])[] = [
      [psk, legacy],
      [legacy, psk],
      [psk, credential],
      [credential, psk],
      [legacy, credential],
      [credential, legacy],
    ]

    for (const [index, [initial, replacement]] of transitions.entries()) {
      const channelId = String(index + 2).repeat(32)
      const first = await rawHandshake(url, channelId, initial)
      expect(first.outcome).toBe('ready')
      sendRequest(first, `seed-transition-${index}`)
      await waitUntil(() => hasEnvelope(first))
      first.socket.close(1000)
      await first.closed

      const refused = await rawHandshake(url, channelId, replacement)
      expect(refused.outcome).toBe('closed')
      expect(refused.closeCode).toBe(CLOSE_CHANNEL_CONFLICT)
      expect(hasEnvelope(refused)).toBe(false)
    }

    // Legacy signatures have no credential source/id, so the verified key is
    // retained as an additional internal binding. A directory key rotation
    // must not let a new key inherit the old key's payloads.
    const channelId = '8'.repeat(32)
    const original = await rawHandshake(url, channelId, legacy)
    expect(original.outcome).toBe('ready')
    sendRequest(original, 'seed-legacy-key-rotation')
    await waitUntil(() => hasEnvelope(original))
    original.socket.close(1000)
    await original.closed

    legacyKey = secondKeys.publicKey
    const changedKey = await rawHandshake(url, channelId, {
      kind: 'signature',
      keys: secondKeys,
    })
    expect(changedKey.outcome).toBe('closed')
    expect(changedKey.closeCode).toBe(CLOSE_CHANNEL_CONFLICT)
    expect(hasEnvelope(changedKey)).toBe(false)
  })
})

/**
 * A TCP relay the test can sever on demand.
 *
 * Severing a live link *without* telling either endpoint anything is the one
 * thing neither half of this package exposes, and it is exactly the shape of
 * the production event these tests are about: the dialer sees a dropped socket
 * and reconnects, while the listener sees its socket close and keeps the
 * logical channel — with whatever is still in its outbox — retained. Killing
 * the listener instead would take the retained channel with it and test
 * nothing.
 */
interface Relay {
  readonly url: string
  sever(): void
  close(): Promise<void>
}

function startRelay(targetPort: number): Promise<Relay> {
  const live = new Set<Socket>()
  const server = createNetServer(downstream => {
    const upstream = netConnect(targetPort, '127.0.0.1')
    live.add(downstream)
    live.add(upstream)
    // A severed socket emits ECONNRESET on both halves; unhandled 'error' on an
    // EventEmitter is rethrown and would take the test process with it.
    downstream.on('error', () => {})
    upstream.on('error', () => {})
    downstream.pipe(upstream)
    upstream.pipe(downstream)
    const drop = (): void => {
      live.delete(downstream)
      live.delete(upstream)
      downstream.destroy()
      upstream.destroy()
    }
    downstream.on('close', drop)
    upstream.on('close', drop)
  })
  return new Promise<Relay>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port =
        typeof address === 'object' && address !== null ? address.port : 0
      const killLive = (): void => {
        for (const socket of [...live]) socket.destroy()
        live.clear()
      }
      resolve({
        url: `ws://127.0.0.1:${port}`,
        sever: killLive,
        close: () =>
          new Promise<void>(done => {
            killLive()
            server.close(() => done())
          }),
      })
    })
  })
}

/**
 * A listener that answers every auth frame with {@link CLOSE_CHANNEL_CONFLICT}.
 *
 * No real transport server can do this: a fresh 128-bit channel id cannot
 * collide with a channel that does not exist, so the *first* rotation always
 * resolves a genuine conflict. Which is why the bound is only observable
 * against a listener refusing unconditionally — and that is also the case the
 * bound exists for. A listener saying no to everything is not a collision, and
 * rotating at it forever is a reconnect storm wearing recovery's clothes.
 */
interface ConflictingListener {
  readonly url: string
  /** Channel ids offered, in order. */
  readonly seen: string[]
  close(): Promise<void>
}

function conflictingListener(): ConflictingListener {
  const seen: string[] = []
  const listener = Bun.serve<undefined, never>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, server) {
      return server.upgrade(request)
        ? undefined
        : new Response('expected websocket', { status: 426 })
    },
    websocket: {
      open(socket) {
        socket.send(
          serializeFrame({
            t: FrameType.Challenge,
            v: FRAME_VERSION,
            nonce: newNonce(),
          }),
        )
      },
      message(socket, raw) {
        const frame = parseFrame(typeof raw === 'string' ? raw : raw.toString())
        if (frame === null || frame.t !== FrameType.Auth) return
        seen.push(frame.channelId)
        socket.close(
          CLOSE_CHANNEL_CONFLICT,
          'logical channel identity conflict',
        )
      },
    },
  })
  return {
    url: `ws://127.0.0.1:${listener.port ?? 0}`,
    seen,
    close: async (): Promise<void> => {
      // Bounded for the reason `server.ts` records at its own `stop`: on Bun
      // 1.3.13 a server that has closed a WebSocket itself never resolves
      // `stop()`, and closing every socket is all this listener does. The port
      // is released either way; only the promise is lost.
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        listener.stop(true),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, 200)
          timer.unref?.()
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

/** Rejections of one kind, as the listener recorded them. */
function rejectionsOf(
  server: TransportServerHandle,
  rejection: HandshakeRejection,
): readonly TransportEvent[] {
  return server.events
    .byType(TransportEventType.AuthRejected)
    .filter(event => event.detail['rejection'] === rejection)
}

describe('a conflicting channel id is survivable, not fatal', () => {
  test('a directory change under a retained channel moves the dialer to a fresh channel, leaving the old outbox behind', async () => {
    // The production trigger reproduced exactly: the dialer changes nothing —
    // same key, same certificate, same bytes — while the listener's directory
    // gains an explicit trust row for that key mid-task. The *effective*
    // credential therefore moves under a channel that is still retained, and
    // the dialer is locked out of a channel it never stopped owning.
    let effective: AuthenticatedCredential = { source: 'certificate', id: F1 }
    const directory: HandshakeCredentialDirectory = {
      publicKeyOf(node) {
        if (node === LISTENER) return listenerKeys.publicKey
        if (node === DIALER) return firstKeys.publicKey
        return null
      },
      handshakeCredentialOf(node, selector) {
        if (node !== DIALER || selector !== F1) return null
        return {
          publicKey: firstKeys.publicKey,
          source: effective.source,
          id: effective.id,
          // The dialer's proof always covers the certificate it claimed; only
          // the credential this listener adopts locally moves.
          proofCredential: { source: 'certificate', id: F1 },
        }
      },
    }

    // An array, not a `let`: TypeScript keeps the `null` narrowing across an
    // assignment it only sees inside a callback.
    const retained: TransportChannel[] = []
    const server = startTransportServer({
      port: 0,
      psk: TEST_PSK,
      signing: { node: LISTENER, keys: listenerKeys, directory },
      onMessage: (_message, context) => {
        if (retained.length > 0) return
        retained.push(context.channel)
        // A hold is what a node in the middle of a task takes, and it is the
        // ordinary reason a channel is still in the table when its peer comes
        // back (`resident.ts`, `activator/routes.ts`).
        releases.push(context.channel.hold())
      },
    })
    servers.push(server)
    const relay = await startRelay(server.port ?? 0)
    relays.push(relay)

    const delivered: string[] = []
    const client = new TransportClient({
      endpoint: { url: relay.url },
      node: DIALER,
      peerNode: LISTENER,
      psk: TEST_PSK,
      keepAliveIntervalMs: 0,
      // Wide enough that the reconnect cannot land in the middle of the
      // listener-side setup below, which takes microseconds.
      backoff: {
        baseDelayMs: 400,
        maxDelayMs: 400,
        jitterRatio: 0,
        giveUpAfterMs: 20_000,
      },
      signing: {
        keys: firstKeys,
        directory,
        credential: { selector: F1, source: 'certificate', id: F1 },
      },
      onMessage: message => {
        delivered.push(message.taskId)
      },
    })
    clients.push(client)

    await client.connect(5_000)
    const original = client.id
    await client.sendAndWait(makeMessage({ taskId: 'seed-hold' }), 5_000)
    expect(retained).toHaveLength(1)

    // The listener's view of this dialer changes while the link is up. The live
    // channel keeps the identity it was admitted under; only the next handshake
    // resolves differently.
    effective = { source: 'explicit', id: 'operator-pinned' }

    relay.sever()
    await waitUntil(() => server.connections === 0)
    expect(server.channels).toBe(1)

    // The retained channel now holds an envelope only the old identity is
    // entitled to. This is the payload the identity freeze exists to protect.
    const channel = retained[0]
    channel?.send(makeMessage({ taskId: RETAINED_SECRET }))
    expect(channel?.pending).toBe(1)

    await waitUntil(() => client.isReady(), 10_000)
    expect(client.isClosed()).toBe(false)
    expect(client.id).not.toBe(original)

    // The security invariant, asserted head-on rather than inferred from "it
    // reconnected": the retained envelope is still on the old channel and was
    // never handed to the identity that replaced it.
    await sleep(150)
    expect(delivered).not.toContain(RETAINED_SECRET)
    expect(channel?.pending).toBe(1)
    expect(server.channels).toBe(2)

    // The listener's record names the channel, which is the one field an
    // operator needs to find the other side of the collision, and says how much
    // was stranded on it.
    const mismatches = rejectionsOf(
      server,
      HandshakeRejection.ChannelIdentityMismatch,
    )
    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]?.detail['channelId']).toBe(original)
    expect(mismatches[0]?.detail['pending']).toBe(1)
    expect(mismatches[0]?.detail['closeCode']).toBe(CLOSE_CHANNEL_CONFLICT)
    expect(mismatches[0]?.detail['node']).toBe(DIALER)

    // And the dialer's record admits the loss rather than passing the rotation
    // off as an ordinary reconnect.
    const rotations = client.events.byType(TransportEventType.ChannelRotated)
    expect(rotations).toHaveLength(1)
    expect(rotations[0]?.detail['abandoned']).toBe(original)
    expect(rotations[0]?.detail['channelId']).toBe(client.id)
    expect(rotations[0]?.detail['rotation']).toBe(1)
  })

  test('a caller-supplied channel id is pinned, and the conflict stays fatal', async () => {
    const directory = credentialDirectory(() => firstKeys.publicKey)
    const server = serverFor(directory)
    const url = server.url ?? ''
    const channelId = 'a'.repeat(32)

    const owner = await rawHandshake(url, channelId, exact(F1))
    expect(owner.outcome).toBe('ready')
    sendRequest(owner, 'seed-pinned-channel')
    await waitUntil(() => hasEnvelope(owner))
    owner.socket.close(1000)
    await owner.closed
    await waitUntil(() => server.connections === 0 && server.channels === 1)

    // Naming the channel is the whole request; moving to a different one would
    // hand back a healthy-looking link that answers a question nobody asked.
    const pinned = new TransportClient({
      endpoint: { url },
      node: DIALER,
      peerNode: LISTENER,
      psk: TEST_PSK,
      channelId,
      keepAliveIntervalMs: 0,
      signing: {
        keys: secondKeys,
        directory,
        credential: { selector: K2, source: 'certificate', id: K2 },
      },
    })
    clients.push(pinned)

    await expect(pinned.connect(5_000)).rejects.toThrow(/4004/)
    expect(pinned.isClosed()).toBe(true)
    expect(pinned.id).toBe(channelId)
    expect(
      pinned.events.byType(TransportEventType.ChannelRotated),
    ).toHaveLength(0)
  })

  test('rotation is bounded, and the fatal end tells parked sends the real cause', async () => {
    const listener = conflictingListener()
    conflicting.push(listener)
    const client = new TransportClient({
      endpoint: { url: listener.url },
      node: DIALER,
      psk: TEST_PSK,
      keepAliveIntervalMs: 0,
      backoff: {
        baseDelayMs: 5,
        maxDelayMs: 10,
        jitterRatio: 0,
        giveUpAfterMs: 20_000,
      },
    })
    clients.push(client)

    // Parked before the link ever comes up, with a receipt timeout far longer
    // than this test can run. Settling at all therefore means the fatal path
    // closed the outbox with the real reason, not that the timeout fired —
    // which is the difference between "handshake rejected (4004)" and "no
    // receipt within 30000ms", i.e. between the cause and the symptom.
    const startedAt = Date.now()
    const parked = client
      .sendAndWait(makeMessage({ taskId: 'parked-across-fatal' }), 30_000)
      .then(() => 'resolved')
      .catch((error: unknown) =>
        error instanceof Error ? error.message : String(error),
      )

    await expect(client.connect(10_000)).rejects.toThrow(/4004/)
    expect(await parked).toMatch(/4004/)
    expect(Date.now() - startedAt).toBeLessThan(15_000)
    expect(client.isClosed()).toBe(true)

    expect(
      client.events.byType(TransportEventType.ChannelRotated),
    ).toHaveLength(MAX_CHANNEL_ROTATIONS)
    // One dial per channel id, and never the same id twice: a rotation that
    // reused an id would collide again by construction.
    expect(listener.seen).toHaveLength(MAX_CHANNEL_ROTATIONS + 1)
    expect(new Set(listener.seen).size).toBe(MAX_CHANNEL_ROTATIONS + 1)
  })

  test('a 4003 tells parked sends the real cause too', async () => {
    const server = serverFor(credentialDirectory(() => firstKeys.publicKey))
    const client = new TransportClient({
      endpoint: { url: server.url ?? '' },
      node: DIALER,
      psk: WRONG_PSK,
      keepAliveIntervalMs: 0,
    })
    clients.push(client)

    const startedAt = Date.now()
    const parked = client
      .sendAndWait(makeMessage({ taskId: 'parked-across-4003' }), 30_000)
      .then(() => 'resolved')
      .catch((error: unknown) =>
        error instanceof Error ? error.message : String(error),
      )

    await expect(client.connect(5_000)).rejects.toThrow(/4003/)
    expect(await parked).toMatch(/4003/)
    expect(Date.now() - startedAt).toBeLessThan(15_000)
  })

  test('a malformed channel id is still bad_channel, and carries no channel id', async () => {
    const server = serverFor(credentialDirectory(() => firstKeys.publicKey))
    const malformed = await rawHandshake(
      server.url ?? '',
      'not-a-channel-id',
      exact(F1),
    )
    expect(malformed.outcome).toBe('closed')
    // Still 4003 and still 'unauthorized': the dialer sent nonsense in the
    // field, which is a different problem with a different fix, and must not
    // be reported as the recoverable one.
    expect(malformed.closeCode).toBe(CLOSE_UNAUTHORIZED)

    expect(rejectionsOf(server, HandshakeRejection.BadChannel)).toHaveLength(1)
    expect(
      rejectionsOf(server, HandshakeRejection.ChannelIdentityMismatch),
    ).toHaveLength(0)
    // The mismatch rejection is the only one that names a channel; a
    // `bad_channel` record naming one would be echoing an unverified field.
    expect(
      rejectionsOf(server, HandshakeRejection.BadChannel)[0]?.detail[
        'channelId'
      ],
    ).toBeUndefined()
  })
})

describe('the credential proof is never skipped', () => {
  const NONCE = 'c'.repeat(32)
  const CLIENT_NONCE = 'd'.repeat(32)
  const CHANNEL = 'e'.repeat(32)
  const EFFECTIVE = { source: 'explicit', id: 'operator-pinned' } as const
  const PROVEN = { source: 'certificate', id: F1 } as const

  /**
   * A directory whose adopted credential differs from the one the peer proves.
   *
   * `proofCredential` exists for exactly this: an explicit trust row wins
   * locally while the peer can only ever prove the certificate it holds. The
   * check must therefore bind `proofCredential` — and must *run*, which is the
   * property these two cases pin. Written as a rejection of a proof over the
   * adopted credential, because that is the value the pre-fix code would have
   * had to fall back to had the check been skipped.
   */
  function splitDirectory(
    proofCredential: AuthenticatedCredential | undefined,
  ): HandshakeCredentialDirectory {
    return {
      publicKeyOf(node) {
        if (node === LISTENER) return listenerKeys.publicKey
        if (node === DIALER) return firstKeys.publicKey
        return null
      },
      handshakeCredentialOf(node, selector) {
        if (selector !== F1) return null
        return {
          publicKey:
            node === LISTENER ? listenerKeys.publicKey : firstKeys.publicKey,
          ...EFFECTIVE,
          // `undefined` is the shape a directory written before this field
          // existed produces; the resolver falls it back to the adopted
          // credential rather than treating "nothing said" as "nothing to
          // check". Asserted below in both shapes.
          ...(proofCredential === undefined ? {} : { proofCredential }),
        }
      },
    }
  }

  function authAttempt(
    keys: NodeKeyPair,
    proofOver: AuthenticatedCredential,
  ): AuthAttempt {
    return {
      node: DIALER,
      nonce: NONCE,
      clientNonce: CLIENT_NONCE,
      channelId: CHANNEL,
      mac: computeMac(TEST_PSK, NONCE, CLIENT_NONCE, DIALER, CHANNEL),
      sig: signBytes(
        keys,
        authSigningInput(NONCE, CLIENT_NONCE, DIALER, CHANNEL),
      ),
      credential: F1,
      credentialProof: signBytes(
        keys,
        authCredentialProofInput(
          NONCE,
          CLIENT_NONCE,
          DIALER,
          CHANNEL,
          F1,
          proofOver.source,
          proofOver.id,
        ),
      ),
    }
  }

  function readyFrame(
    keys: NodeKeyPair,
    proofOver: AuthenticatedCredential,
  ): {
    node: string
    sig: string
    credential: string
    credentialProof: string
  } {
    return {
      node: LISTENER,
      sig: signBytes(
        keys,
        readySigningInput(NONCE, CLIENT_NONCE, DIALER, CHANNEL, LISTENER),
      ),
      credential: F1,
      credentialProof: signBytes(
        keys,
        readyCredentialProofInput(
          NONCE,
          CLIENT_NONCE,
          DIALER,
          CHANNEL,
          LISTENER,
          F1,
          proofOver.source,
          proofOver.id,
        ),
      ),
    }
  }

  const tuple = {
    serverNonce: NONCE,
    clientNonce: CLIENT_NONCE,
    node: DIALER,
    channelId: CHANNEL,
  }

  test('auth: the proof must bind the proof credential, and a split directory refuses anything else', () => {
    const directory = splitDirectory(PROVEN)
    const signing = { keys: listenerKeys, directory }

    const good = verifyAuthAttempt(
      TEST_PSK,
      signing,
      NONCE,
      authAttempt(firstKeys, PROVEN),
    )
    expect(good.ok).toBe(true)
    // The connection is owned by the credential this listener adopts, not by
    // the one the peer proved.
    expect(good.ok && good.credential).toEqual(EFFECTIVE)
    expect(good.ok && good.authentication).toBe('credential_signature')

    const wrong = verifyAuthAttempt(
      TEST_PSK,
      signing,
      NONCE,
      authAttempt(firstKeys, EFFECTIVE),
    )
    expect(wrong.ok).toBe(false)
    expect(!wrong.ok && wrong.rejection).toBe(
      HandshakeRejection.BadCredentialProof,
    )
  })

  test('auth: a directory that names no proof credential still gets its proof checked', () => {
    const signing = { keys: listenerKeys, directory: splitDirectory(undefined) }
    // Falls back to the adopted credential — and *checks* it. A skipped check
    // would admit this second attempt as `credential_signature` on a proof over
    // bytes the directory never named.
    expect(
      verifyAuthAttempt(
        TEST_PSK,
        signing,
        NONCE,
        authAttempt(firstKeys, EFFECTIVE),
      ).ok,
    ).toBe(true)
    const wrong = verifyAuthAttempt(
      TEST_PSK,
      signing,
      NONCE,
      authAttempt(firstKeys, PROVEN),
    )
    expect(wrong.ok).toBe(false)
    expect(!wrong.ok && wrong.rejection).toBe(
      HandshakeRejection.BadCredentialProof,
    )
  })

  test('ready: the proof must bind the proof credential, and a split directory refuses anything else', () => {
    const directory = splitDirectory(PROVEN)
    const signing = { keys: firstKeys, directory }

    const good = verifyReady(
      LISTENER,
      signing,
      tuple,
      readyFrame(listenerKeys, PROVEN),
    )
    expect(good.ok).toBe(true)
    expect(good.ok && good.credential).toEqual(EFFECTIVE)

    const wrong = verifyReady(
      LISTENER,
      signing,
      tuple,
      readyFrame(listenerKeys, EFFECTIVE),
    )
    expect(wrong.ok).toBe(false)
    expect(!wrong.ok && wrong.rejection).toBe(ReadyRejection.BadCredentialProof)
  })

  test('ready: a directory that names no proof credential still gets its proof checked', () => {
    const signing = { keys: firstKeys, directory: splitDirectory(undefined) }
    expect(
      verifyReady(LISTENER, signing, tuple, readyFrame(listenerKeys, EFFECTIVE))
        .ok,
    ).toBe(true)
    const wrong = verifyReady(
      LISTENER,
      signing,
      tuple,
      readyFrame(listenerKeys, PROVEN),
    )
    expect(wrong.ok).toBe(false)
    expect(!wrong.ok && wrong.rejection).toBe(ReadyRejection.BadCredentialProof)
  })
})
