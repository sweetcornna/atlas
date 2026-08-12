// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { unlinkSync } from 'node:fs'
import type { Server, ServerWebSocket, TLSOptions, WebSocketHandler } from 'bun'
import {
  LIMITS,
  ProtocolErrorCode,
  firstErrorCode,
  validateMessage,
  type QianmoMessage,
} from '@qianmo/protocol'
import { DedupTable, DedupVerdict } from './dedup.js'
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
import {
  CLOSE_PROTOCOL_ERROR,
  CLOSE_UNAUTHORIZED,
  HandshakeRejection,
  assertUsablePsk,
  newNonce,
  verifyAuth,
} from './handshake.js'

/**
 * The listening half of a Qianmo hop — the half the base does not have.
 *
 * `src/cli/transports/` is 3,326 lines of *client*: every one of them dials
 * out (`WebSocketTransport.ts:163` / `:180`) and none of them accepts. A node
 * that other nodes can send to needs the other side of that connection, and
 * this file is it.
 *
 * Responsibilities, in the order a byte meets them: accept, challenge, verify
 * the pre-shared key, validate the envelope, dedup it, hand it to the node,
 * and answer with a receipt. Anything before the handshake completes is
 * answered with a close code, never with an error body — an unauthenticated
 * peer learns nothing from us.
 *
 * A receipt is **not** the protocol's `ack` (see `frames.ts`): it means this
 * node has taken the envelope in, and the acknowledgement that the target
 * agent actually read it belongs to `@qianmo/adapter`, one layer up.
 */

/** Longest claimed id echoed back on a rejection. Bounds an abusive value. */
const MAX_ECHOED_ID_LENGTH = 64

/** The `msgId` an unvalidated value claims, if it plausibly claims one. */
function claimedMsgId(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null || !('msgId' in raw)) return ''
  const value: unknown = raw.msgId
  return typeof value === 'string' ? value.slice(0, MAX_ECHOED_ID_LENGTH) : ''
}

/** Per-connection state. Mutable — the handshake flips `authed` in place. */
interface ConnectionState {
  readonly nonce: string
  readonly openedAt: number
  node: string | null
  authed: boolean
}

/** What a delivered envelope brings with it beyond the envelope itself. */
export interface InboundContext {
  /** Node segment the peer authenticated as. Audit label, not authority. */
  readonly peerNode: string
  /** Local epoch ms at which this node took the envelope in. */
  readonly receivedAt: number
}

/**
 * The node's own handler.
 *
 * Throwing is meaningful: the envelope is un-remembered and the sender is told
 * `E_UNDELIVERABLE`, so its at-least-once retry can still land. Swallowing an
 * error here instead would turn a transient local fault into silent loss.
 */
export type InboundHandler = (
  message: QianmoMessage,
  context: InboundContext,
) => void | Promise<void>

export interface TransportServerOptions {
  /** Pre-shared key. Injected — never a literal (see `handshake.ts`). */
  readonly psk: string
  readonly onMessage: InboundHandler
  /** Listen on a unix socket. Mutually exclusive with `port`. */
  readonly unix?: string
  /** Listen on TCP. `0` lets the OS choose. */
  readonly port?: number
  readonly hostname?: string
  /** TLS materials, passed straight to Bun. Meaningless with `unix`. */
  readonly tls?: TLSOptions
  /** Injected clock. */
  readonly now?: () => number
  /** Extra sink for records, on top of the retained ring. */
  readonly events?: TransportEventSink
  /** Share one table across servers, or inject a clock into it. */
  readonly dedup?: DedupTable
  /**
   * Seconds of silence before Bun reaps a connection. Bun's own default is
   * 10 s, which a long-lived node link would trip constantly; clients send a
   * keep-alive data frame well inside this window.
   */
  readonly idleTimeoutSec?: number
  readonly eventCapacity?: number
}

export interface TransportServerHandle {
  /** Unix socket path, when listening on one. */
  readonly unix?: string
  /** Bound TCP port, when listening on one. */
  readonly port?: number
  /** Dial URL for a client, when listening on TCP. */
  readonly url?: string
  readonly events: EventRecorder
  readonly dedup: DedupTable
  /** Open connections, authenticated or not. */
  readonly connections: number
  stop(): Promise<void>
}

/** Seconds. Comfortably above the client's keep-alive period. */
export const DEFAULT_IDLE_TIMEOUT_SEC = 120

/** How long {@link TransportServerHandle.stop} waits on Bun before moving on. */
const STOP_GRACE_MS = 200

/**
 * Largest frame the socket will buffer: the protocol's own envelope ceiling
 * plus room for the frame wrapper.
 *
 * Refusing at the socket layer matters because `JSON.parse` happens before any
 * validation can: without this, a peer could make the receiver allocate for a
 * payload that `validateMessage` was always going to refuse. Bun's default is
 * 16 MB, which is 64× more generosity than this protocol has any use for.
 */
const MAX_FRAME_BYTES = LIMITS.maxMessageBytes + 4096

export function startTransportServer(
  options: TransportServerOptions,
): TransportServerHandle {
  assertUsablePsk(options.psk)
  if (options.unix !== undefined && options.port !== undefined) {
    throw new Error('transport server takes either `unix` or `port`, not both')
  }

  const now = options.now ?? (() => Date.now())
  const recorder = new EventRecorder(options.eventCapacity, options.events)
  const dedup = options.dedup ?? new DedupTable({ now })
  const sockets = new Set<ServerWebSocket<ConnectionState>>()

  function record(type: TransportEventType, detail: EventDetail): void {
    recorder.record({ type, at: now(), detail })
  }

  function send(ws: ServerWebSocket<ConnectionState>, frame: TransportFrame) {
    ws.send(serializeFrame(frame))
  }

  function receipt(
    msgId: string,
    status: ReceiptStatus,
    code?: ProtocolErrorCode,
    reason?: string,
  ): ReceiptFrame {
    return {
      t: FrameType.Receipt,
      v: 0,
      msgId,
      status,
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    }
  }

  /**
   * Drop a connection that broke the grammar.
   *
   * Before the handshake this is an auth rejection — the record an operator
   * greps for after a failed deployment. After it, the peer is authenticated
   * and merely wrong, which is a different fact and gets a different record.
   */
  function refuse(
    ws: ServerWebSocket<ConnectionState>,
    rejection: HandshakeRejection,
    closeCode: number,
  ): void {
    record(
      ws.data.authed
        ? TransportEventType.ConnectionClosed
        : TransportEventType.AuthRejected,
      { rejection, node: ws.data.node ?? '', closeCode },
    )
    ws.close(closeCode, ws.data.authed ? 'protocol error' : 'unauthorized')
  }

  async function handleEnvelope(
    ws: ServerWebSocket<ConnectionState>,
    raw: unknown,
    peerNode: string,
  ): Promise<void> {
    const validation = validateMessage(raw)
    if (!validation.ok) {
      // Quote back the id the sender claimed, so it can retire the right
      // outbox entry — bounded and never interpreted, because on this path it
      // is by definition a value that failed validation.
      const badId = claimedMsgId(raw)
      const code =
        firstErrorCode(validation) ?? ProtocolErrorCode.E_BAD_ENVELOPE
      record(TransportEventType.MessageRejected, {
        node: peerNode,
        code,
      })
      send(ws, receipt(badId, ReceiptStatus.Rejected, code, 'invalid envelope'))
      return
    }

    const message = validation.message
    const verdict = dedup.admit(message)
    if (verdict !== DedupVerdict.Fresh) {
      record(TransportEventType.MessageDuplicate, {
        node: peerNode,
        msgId: message.msgId,
        level: verdict,
      })
      send(ws, receipt(message.msgId, ReceiptStatus.Duplicate))
      return
    }

    try {
      await options.onMessage(message, { peerNode, receivedAt: now() })
    } catch (error) {
      // Un-remember it: the work did not happen, so the sender's retry has to
      // be able to get through rather than be absorbed as a duplicate.
      dedup.forget(message)
      record(TransportEventType.MessageRejected, {
        node: peerNode,
        msgId: message.msgId,
        code: ProtocolErrorCode.E_UNDELIVERABLE,
        reason: error instanceof Error ? error.name : 'unknown',
      })
      send(
        ws,
        receipt(
          message.msgId,
          ReceiptStatus.Rejected,
          ProtocolErrorCode.E_UNDELIVERABLE,
          'handler failed',
        ),
      )
      return
    }

    record(TransportEventType.MessageAccepted, {
      node: peerNode,
      msgId: message.msgId,
    })
    send(ws, receipt(message.msgId, ReceiptStatus.Accepted))
  }

  const websocket: WebSocketHandler<ConnectionState> = {
    idleTimeout: options.idleTimeoutSec ?? DEFAULT_IDLE_TIMEOUT_SEC,
    maxPayloadLength: MAX_FRAME_BYTES,
    open(ws) {
      sockets.add(ws)
      record(TransportEventType.ConnectionOpened, {})
      send(ws, { t: FrameType.Challenge, v: 0, nonce: ws.data.nonce })
    },
    close(ws, code) {
      sockets.delete(ws)
      record(TransportEventType.ConnectionClosed, {
        node: ws.data.node ?? '',
        code,
        durationMs: now() - ws.data.openedAt,
      })
    },
    async message(ws, raw) {
      const frame = parseFrame(typeof raw === 'string' ? raw : raw.toString())
      if (frame === null) {
        refuse(ws, HandshakeRejection.MalformedFrame, CLOSE_PROTOCOL_ERROR)
        return
      }

      if (!ws.data.authed) {
        if (frame.t !== FrameType.Auth) {
          refuse(ws, HandshakeRejection.UnexpectedFrame, CLOSE_UNAUTHORIZED)
          return
        }
        const result = verifyAuth(options.psk, ws.data.nonce, frame)
        if (!result.ok) {
          // Record the claimed name so an operator can tell a misconfigured
          // peer from a scan. It is a claim, not an identity — the handshake
          // is precisely what failed.
          ws.data.node = frame.node
          refuse(ws, result.rejection, CLOSE_UNAUTHORIZED)
          return
        }
        ws.data.authed = true
        ws.data.node = result.node
        record(TransportEventType.AuthAccepted, { node: result.node })
        send(ws, { t: FrameType.Ready, v: 0 })
        return
      }

      const peerNode = ws.data.node ?? ''
      switch (frame.t) {
        case FrameType.KeepAlive:
          return
        case FrameType.Envelope:
          await handleEnvelope(ws, frame.envelope, peerNode)
          return
        default:
          // Challenge / auth / ready / receipt are server-to-client frames or
          // a second handshake; either way the peer is not speaking v0.
          refuse(ws, HandshakeRejection.UnexpectedFrame, CLOSE_PROTOCOL_ERROR)
      }
    },
  }

  function upgrade(
    request: Request,
    server: Server<ConnectionState>,
  ): Response | undefined {
    const data: ConnectionState = {
      nonce: newNonce(),
      openedAt: now(),
      node: null,
      authed: false,
    }
    if (server.upgrade(request, { data })) return undefined
    return new Response('expected a websocket upgrade', { status: 426 })
  }

  const server: Server<ConnectionState> =
    options.unix === undefined
      ? Bun.serve<ConnectionState, never>({
          port: options.port ?? 0,
          hostname: options.hostname ?? '127.0.0.1',
          ...(options.tls === undefined ? {} : { tls: options.tls }),
          fetch: upgrade,
          websocket,
        })
      : Bun.serve<ConnectionState, never>({
          unix: options.unix,
          fetch: upgrade,
          websocket,
        })

  const scheme = options.tls === undefined ? 'ws' : 'wss'
  return {
    ...(options.unix === undefined
      ? {
          port: server.port ?? 0,
          url: `${scheme}://${options.hostname ?? '127.0.0.1'}:${server.port ?? 0}`,
        }
      : { unix: options.unix }),
    events: recorder,
    dedup,
    get connections(): number {
      return sockets.size
    },
    stop: async (): Promise<void> => {
      // Bounded, not a plain await, because of a measured Bun behaviour: once
      // this server has closed a WebSocket itself — which is exactly what
      // refusing a handshake does — `server.stop()` never resolves, on unix
      // sockets and TCP alike, with or without `force`. Measured on Bun
      // 1.3.13: closer=server hangs, closer=client resolves in 0 ms.
      //
      // The listener really is released regardless (a fresh server binds the
      // same path immediately afterwards and serves), so the only thing lost
      // is the promise. Waiting on it forever would mean a node that ever
      // rejected one dial could never shut down.
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        server.stop(true),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, STOP_GRACE_MS)
          timer.unref?.()
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
      // Stopping does not remove the socket file; leaving it behind is how a
      // restarted node fails to take its own address back. The base unlinks
      // its own socket for the same reason
      // (`src/ssh/SSHAuthProxy.ts:128-135`).
      if (options.unix !== undefined) {
        try {
          unlinkSync(options.unix)
        } catch {
          // Already gone, or never ours to remove.
        }
      }
    },
  }
}
