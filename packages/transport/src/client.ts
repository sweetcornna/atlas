// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

// `ws` is declared once, at the workspace root (`package.json:77`), and not
// re-declared here: knip's zero-tolerance "unused dependencies" gate reports a
// second declaration of a root dependency as dead weight. This package is
// private and never published, so the root declaration is the whole contract.
import WebSocket from 'ws'
import { isValidSegment, type QianmoMessage } from '@qianmo/protocol'
import {
  DEFAULT_BACKOFF,
  ReconnectSchedule,
  type BackoffOptions,
  type RandomSource,
} from './backoff.js'
import {
  EventRecorder,
  TransportEventType,
  type EventDetail,
  type TransportEventSink,
} from './events.js'
import {
  FrameType,
  ReceiptStatus,
  parseFrame,
  serializeFrame,
  type ReceiptFrame,
  type TransportFrame,
} from './frames.js'
import { assertUsablePsk, computeMac, newNonce } from './handshake.js'

/**
 * The dialling half of a Qianmo hop.
 *
 * At-least-once lives here, and it is one rule: **an envelope leaves the
 * outbox only when a receipt for it comes back.** Everything else follows —
 * a message handed over while the link is down waits in the outbox; a
 * reconnect replays whatever is still in it, in order; the receiver's dedup
 * (`dedup.ts`) absorbs whatever that replay duplicates. There is deliberately
 * no "sent, probably fine" state in between.
 *
 * This is where it parts company with the base's client, which retires its
 * buffer against an `X-Last-Request-Id` header supplied by the upstream
 * service (`src/cli/transports/WebSocketTransport.ts:582-642`). That contract
 * belongs to that service; ours is the receipt frame, and ours has to survive
 * the peer restarting with no memory of the connection.
 *
 * **Not done here, on purpose**: the outbox does not expire its own entries at
 * the delivery deadline. protocol.md §8.2 row 7 (`queued → expired`) is a
 * state-machine transition that has to emit `error(E_TTL_EXPIRED)` back to
 * whoever asked for the send, and that state machine belongs to the router
 * (P4.2), not to a transport that would have to invent the reporting channel
 * to do it. A long outage therefore replays envelopes that are already past
 * their deadline; the receiving node refuses them by rule T-1's second check.
 */

/** Where to dial. A unix socket for one machine, a URL for two. */
export type TransportEndpoint =
  | { readonly url: string }
  | { readonly unix: string; readonly path?: string }

/** TLS materials for a `wss://` dial, passed through to the socket. */
export interface ClientTlsOptions {
  readonly ca?: string | readonly string[]
  readonly cert?: string
  readonly key?: string
  /** Leave unset (i.e. verifying) outside of a lab. */
  readonly rejectUnauthorized?: boolean
}

export interface TransportClientOptions {
  readonly endpoint: TransportEndpoint
  /** This node's segment, e.g. `node-a`. Sent in the handshake. */
  readonly node: string
  /** Pre-shared key. Injected — never a literal (see `handshake.ts`). */
  readonly psk: string
  readonly tls?: ClientTlsOptions
  readonly backoff?: Partial<BackoffOptions>
  /** Cap on unreceipted envelopes before {@link TransportClient.send} refuses. */
  readonly maxQueued?: number
  /** Keep-alive period, ms. `0` disables it. */
  readonly keepAliveIntervalMs?: number
  readonly now?: () => number
  readonly random?: RandomSource
  readonly events?: TransportEventSink
  readonly eventCapacity?: number
}

/** Default outbox depth, matching the base's replay buffer. */
export const DEFAULT_MAX_QUEUED = 1_000

/** Default keep-alive period: well inside the server's idle timeout. */
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000

/** How long {@link TransportClient.connect} waits before reporting failure. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000

/** Raised by {@link TransportClient.send} when the outbox is full. */
export class OutboxFullError extends Error {
  constructor(depth: number) {
    super(`transport outbox is full (${depth} unreceipted messages)`)
    this.name = 'OutboxFullError'
  }
}

type ClientState = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed'

/** Build the dial URL. `ws+unix://<socket>:<path>` is the `ws` package's form. */
export function dialUrl(endpoint: TransportEndpoint): string {
  if ('unix' in endpoint) {
    return `ws+unix://${endpoint.unix}:${endpoint.path ?? '/'}`
  }
  return endpoint.url
}

export class TransportClient {
  private socket: WebSocket | null = null
  private state: ClientState = 'idle'
  private readonly outbox = new Map<string, QianmoMessage>()
  private readonly schedule: ReconnectSchedule
  private readonly recorder: EventRecorder
  private readonly now: () => number
  private readonly maxQueued: number
  private readonly keepAliveIntervalMs: number
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  private lastInboundAt = 0
  private readyWaiters: Array<() => void> = []
  private drainWaiters: Array<() => void> = []

  constructor(private readonly options: TransportClientOptions) {
    assertUsablePsk(options.psk)
    if (!isValidSegment(options.node)) {
      throw new Error(`invalid node segment: ${options.node}`)
    }
    this.now = options.now ?? (() => Date.now())
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED
    this.keepAliveIntervalMs =
      options.keepAliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS
    this.schedule = new ReconnectSchedule(
      { ...DEFAULT_BACKOFF, ...options.backoff },
      options.random,
    )
    this.recorder = new EventRecorder(options.eventCapacity, options.events)
  }

  /** Records this client kept. */
  get events(): EventRecorder {
    return this.recorder
  }

  /** Envelopes handed over but not yet receipted. */
  get pending(): number {
    return this.outbox.size
  }

  /** True once the handshake has completed on the current socket. */
  isReady(): boolean {
    return this.state === 'ready'
  }

  /**
   * True once this client will never carry another envelope.
   *
   * Three ways in: `close()`, a 4003 (the key is wrong), and the reconnect
   * budget running out. All three are terminal, and none of them is visible
   * through {@link isReady}, which cannot tell "down for a moment" from "down
   * for good". A holder of a long-lived client needs that distinction —
   * otherwise it keeps handing envelopes to a corpse, and `send` throwing is
   * the first it hears of it. The activator's link pool reads this to decide
   * when a link has to be replaced rather than waited on.
   */
  isClosed(): boolean {
    return this.state === 'closed'
  }

  /**
   * Dial, and resolve when the handshake completes.
   *
   * Rejection is reserved for "this will never work" — a refused key closes
   * the socket with 4003 and is reported here rather than retried, matching
   * how the base treats the same code
   * (`src/cli/transports/WebSocketTransport.ts:43-47`).
   */
  connect(timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      // Bounded because retrying is unbounded by design: a peer that is merely
      // down keeps the backoff loop running for ten minutes, and a caller
      // awaiting `connect()` should not be held for ten minutes to learn that.
      // The loop keeps running after this rejects — a later `send` still
      // queues, and a peer that comes back is still picked up.
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter(w => w !== waiter)
        reject(
          new Error(`transport did not become ready within ${timeoutMs}ms`),
        )
      }, timeoutMs)
      const waiter = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.readyWaiters.push(waiter)
      const fail = (error: Error): void => {
        clearTimeout(timer)
        reject(error)
      }
      // A dial already in flight (or a retry already scheduled) will settle
      // these waiters; opening a second socket would leave one orphaned.
      if (this.socket === null && this.reconnectTimer === null) {
        this.openSocket(fail)
      }
    })
  }

  /**
   * Hand an envelope to the transport.
   *
   * Returns as soon as it is in the outbox, whether or not the link is up:
   * "queued while disconnected" is the ordinary case this package exists to
   * survive, not an error. Delivery is reported by receipts, observable
   * through {@link waitForDrain}.
   */
  send(message: QianmoMessage): void {
    if (this.state === 'closed') {
      throw new Error('transport client is closed')
    }
    if (!this.outbox.has(message.msgId) && this.outbox.size >= this.maxQueued) {
      throw new OutboxFullError(this.outbox.size)
    }
    this.outbox.set(message.msgId, message)
    if (this.state === 'ready') this.writeEnvelope(message)
  }

  /** Resolve once every queued envelope has been receipted. */
  waitForDrain(timeoutMs = 5_000): Promise<void> {
    if (this.outbox.size === 0) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.drainWaiters = this.drainWaiters.filter(w => w !== waiter)
        reject(new Error(`outbox did not drain within ${timeoutMs}ms`))
      }, timeoutMs)
      const waiter = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.drainWaiters.push(waiter)
    })
  }

  /** Stop for good: no reconnect, no timers, socket closed. */
  async close(): Promise<void> {
    this.state = 'closed'
    this.clearTimers()
    const socket = this.socket
    this.socket = null
    if (socket !== null) {
      socket.removeAllListeners()
      // Re-arm 'error' before touching the socket again. `removeAllListeners`
      // takes the error handler with it, and on an EventEmitter an 'error' with
      // no listener is rethrown — so tearing down a socket that is still
      // mid-handshake (exactly the case terminate() exists for) turns a routine
      // shutdown into an unhandled ErrorEvent that takes the process with it.
      socket.on('error', () => {})
      socket.close(1000, 'client shutdown')
      // A socket closed mid-handshake never fires 'close'; terminate() is the
      // only way to be sure the handle is gone when this promise resolves.
      socket.terminate()
    }
    this.readyWaiters = []
    this.drainWaiters = []
    await Promise.resolve()
  }

  private record(type: TransportEventType, detail: EventDetail): void {
    this.recorder.record({ type, at: this.now(), detail })
  }

  private openSocket(onFatal?: (error: Error) => void): void {
    if (this.state === 'closed') return
    this.state = this.state === 'idle' ? 'connecting' : this.state
    const url = dialUrl(this.options.endpoint)
    const socket = new WebSocket(url, {
      ...(this.options.tls === undefined ? {} : toTlsOptions(this.options.tls)),
    })
    this.socket = socket
    this.lastInboundAt = this.now()

    socket.on('message', (data: WebSocket.RawData) => {
      this.lastInboundAt = this.now()
      this.onFrame(socket, data.toString())
    })
    socket.on('pong', () => {
      this.lastInboundAt = this.now()
    })
    socket.on('error', () => {
      // 'close' always follows; reconnect logic lives there so a failed dial
      // and a dropped link take exactly one path.
    })
    socket.on('close', (code: number) => {
      this.onClose(socket, code, onFatal)
    })
  }

  private onFrame(socket: WebSocket, raw: string): void {
    const frame = parseFrame(raw)
    if (frame === null) return
    switch (frame.t) {
      case FrameType.Challenge: {
        const clientNonce = newNonce()
        this.write(socket, {
          t: FrameType.Auth,
          v: 0,
          node: this.options.node,
          nonce: frame.nonce,
          clientNonce,
          mac: computeMac(
            this.options.psk,
            frame.nonce,
            clientNonce,
            this.options.node,
          ),
        })
        return
      }
      case FrameType.Ready:
        this.onReady()
        return
      case FrameType.Receipt:
        this.onReceipt(frame)
        return
      default:
        // Server never sends the others; ignore rather than tear down, so a
        // newer peer speaking a superset does not knock this one offline.
        return
    }
  }

  private onReady(): void {
    this.state = 'ready'
    this.schedule.succeeded()
    this.startKeepAlive()
    // Replay everything unreceipted, oldest first. Duplicates are the
    // receiver's problem by design — that is the whole at-least-once bargain.
    for (const message of this.outbox.values()) this.writeEnvelope(message)
    const waiters = this.readyWaiters
    this.readyWaiters = []
    for (const resolve of waiters) resolve()
  }

  private onReceipt(frame: ReceiptFrame): void {
    const known = this.outbox.delete(frame.msgId)
    if (frame.status === ReceiptStatus.Rejected) {
      this.record(TransportEventType.MessageRejected, {
        msgId: frame.msgId,
        code: frame.code ?? '',
        reason: frame.reason ?? '',
      })
    } else if (known) {
      this.record(
        frame.status === ReceiptStatus.Duplicate
          ? TransportEventType.MessageDuplicate
          : TransportEventType.MessageAccepted,
        { msgId: frame.msgId },
      )
    }
    if (this.outbox.size === 0) {
      const waiters = this.drainWaiters
      this.drainWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  private onClose(
    socket: WebSocket,
    code: number,
    onFatal?: (error: Error) => void,
  ): void {
    if (this.socket !== socket) return
    socket.removeAllListeners()
    // Same reason as in close(): a listener-less 'error' is rethrown, and this
    // socket may still emit one while it finishes tearing down.
    socket.on('error', () => {})
    this.socket = null
    this.stopKeepAlive()
    if (this.state === 'closed') return

    this.record(TransportEventType.ConnectionClosed, { code })

    // 4003 is the peer saying the key is wrong. Retrying cannot fix a wrong
    // key, and hammering a door that answers 'unauthorized' is how one
    // misconfigured node becomes everyone's incident.
    if (code === 4003) {
      this.state = 'closed'
      this.clearTimers()
      const error = new Error('transport handshake rejected (4003)')
      this.record(TransportEventType.AuthRejected, { code })
      this.readyWaiters = []
      onFatal?.(error)
      return
    }

    this.state = 'reconnecting'
    const decision = this.schedule.next(this.now())
    if (decision.action === 'give-up') {
      this.state = 'closed'
      this.clearTimers()
      this.record(TransportEventType.ReconnectGaveUp, {
        elapsedMs: decision.elapsedMs,
      })
      this.readyWaiters = []
      onFatal?.(new Error('transport reconnect budget exhausted'))
      return
    }
    if (decision.timeJumpDetected) {
      this.record(TransportEventType.TimeJumpDetected, {
        attempt: decision.attempt,
      })
    }
    this.record(TransportEventType.ReconnectScheduled, {
      attempt: decision.attempt,
      delayMs: decision.delayMs,
    })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket(onFatal)
    }, decision.delayMs)
    this.reconnectTimer.unref?.()
  }

  private write(socket: WebSocket, frame: TransportFrame): void {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(serializeFrame(frame))
  }

  private writeEnvelope(message: QianmoMessage): void {
    const socket = this.socket
    if (socket === null) return
    this.write(socket, { t: FrameType.Envelope, v: 0, envelope: message })
  }

  private startKeepAlive(): void {
    this.stopKeepAlive()
    if (this.keepAliveIntervalMs <= 0) return
    this.keepAliveTimer = setInterval(() => {
      const socket = this.socket
      if (socket === null || this.state !== 'ready') return
      // Silence for three periods means the link is gone in a way TCP has not
      // noticed yet (NAT drop, frozen peer). Tearing it down is cheap: the
      // outbox replays and the receiver dedups.
      if (this.now() - this.lastInboundAt > this.keepAliveIntervalMs * 3) {
        socket.terminate()
        return
      }
      this.write(socket, { t: FrameType.KeepAlive, v: 0 })
    }, this.keepAliveIntervalMs)
    this.keepAliveTimer.unref?.()
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }

  private clearTimers(): void {
    this.stopKeepAlive()
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}

/**
 * Emit the TLS materials in **both** accepted shapes.
 *
 * Measured on Bun 1.3.13: a `wss://` dial carrying node-style top-level `ca`
 * fails with "TLS handshake failed", while the same dial carrying Bun's nested
 * `{ tls: { ca } }` succeeds — Bun answers `import 'ws'` with its own
 * implementation, which reads only the nested form. The base hits the same
 * fork and branches on `typeof Bun`
 * (`src/cli/transports/WebSocketTransport.ts:160-184`).
 *
 * Emitting both is deliberate: each runtime ignores the shape it does not
 * know, so there is one code path instead of a runtime test that only one CI
 * job ever exercises.
 */
function toTlsOptions(tls: ClientTlsOptions): Record<string, unknown> {
  const nodeStyle: Record<string, unknown> = {
    ...(tls.ca === undefined ? {} : { ca: [tls.ca].flat() }),
    ...(tls.cert === undefined ? {} : { cert: tls.cert }),
    ...(tls.key === undefined ? {} : { key: tls.key }),
    ...(tls.rejectUnauthorized === undefined
      ? {}
      : { rejectUnauthorized: tls.rejectUnauthorized }),
  }
  return { ...nodeStyle, tls: nodeStyle }
}
