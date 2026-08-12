// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { ProtocolErrorCode } from '@qianmo/protocol'

/**
 * Wire frames of the transport hop.
 *
 * These are **not** protocol messages. `@qianmo/protocol` owns what travels
 * end to end (the envelope); this module owns the five frames two adjacent
 * nodes exchange to move one envelope across one hop: a handshake pair, a
 * ready marker, the envelope carrier and a receipt.
 *
 * The distinction matters most for {@link ReceiptFrame}. A receipt says "this
 * hop has taken responsibility for the envelope" — it is emphatically **not**
 * the protocol's `ack`, which may only be emitted once the target agent has
 * actually read the message out of its mailbox (protocol.md §4.5: emitting an
 * ack at write time hides mailbox eviction and breaks AC-2). Nothing in this
 * package ever constructs a `MessageType.Ack`.
 */

/** Version of the frame grammar. Bumped only when frames change shape. */
export const FRAME_VERSION = 0

/** Discriminant of {@link TransportFrame}. */
export enum FrameType {
  /** Server → client, first frame on an open socket: a single-use nonce. */
  Challenge = 'challenge',
  /** Client → server: the keyed answer to a challenge. */
  Auth = 'auth',
  /** Server → client: the handshake passed, envelopes may flow. */
  Ready = 'ready',
  /** Client → server: one protocol envelope. */
  Envelope = 'envelope',
  /** Server → client: what became of one envelope on this hop. */
  Receipt = 'receipt',
  /**
   * Client → server: a data frame carrying nothing, sent to keep the socket
   * from being reaped as idle.
   *
   * A WebSocket ping would be the obvious choice and is the wrong one: proxies
   * do not count control frames toward their idle timers, which is exactly why
   * the base grew a `keep_alive` **data** frame of its own
   * (`src/cli/transports/WebSocketTransport.ts:21, :775-800`). Bun's own server
   * default is a 10 s idle timeout, so without this a quiet link dies in ten
   * seconds.
   */
  KeepAlive = 'keep_alive',
}

/** Outcome recorded by a {@link ReceiptFrame}. */
export enum ReceiptStatus {
  /** First sighting; the receiving node has taken it in. */
  Accepted = 'accepted',
  /** Dedup hit — already handled. The sender may retire it all the same. */
  Duplicate = 'duplicate',
  /** Refused. `code` says why; resending the same bytes will not help. */
  Rejected = 'rejected',
}

export interface ChallengeFrame {
  readonly t: FrameType.Challenge
  readonly v: typeof FRAME_VERSION
  /** Single-use server nonce, hex. */
  readonly nonce: string
}

export interface AuthFrame {
  readonly t: FrameType.Auth
  readonly v: typeof FRAME_VERSION
  /** Node segment the dialer claims to be. Audit only — the MAC is the proof. */
  readonly node: string
  /** Echo of {@link ChallengeFrame.nonce}. */
  readonly nonce: string
  /** Dialer-chosen nonce, hex; keeps the MAC input fresh on both sides. */
  readonly clientNonce: string
  /** `HMAC-SHA256` over the two nonces and the node name, hex. */
  readonly mac: string
}

export interface ReadyFrame {
  readonly t: FrameType.Ready
  readonly v: typeof FRAME_VERSION
}

export interface EnvelopeFrame {
  readonly t: FrameType.Envelope
  readonly v: typeof FRAME_VERSION
  /**
   * A `QianmoMessage`, still `unknown` here on purpose: everything arriving
   * over the wire is untrusted until `validateMessage` has narrowed it, and
   * the receiving node is the only place that check belongs.
   */
  readonly envelope: unknown
}

export interface ReceiptFrame {
  readonly t: FrameType.Receipt
  readonly v: typeof FRAME_VERSION
  /** `msgId` of the envelope this receipt is about. */
  readonly msgId: string
  readonly status: ReceiptStatus
  /** Present when `status` is {@link ReceiptStatus.Rejected}. */
  readonly code?: ProtocolErrorCode
  /** Short human-readable reason. Never carries payload content. */
  readonly reason?: string
}

export interface KeepAliveFrame {
  readonly t: FrameType.KeepAlive
  readonly v: typeof FRAME_VERSION
}

export type TransportFrame =
  | ChallengeFrame
  | AuthFrame
  | ReadyFrame
  | EnvelopeFrame
  | ReceiptFrame
  | KeepAliveFrame

/** JSON encoding of a frame; one frame per WebSocket message. */
export function serializeFrame(frame: TransportFrame): string {
  return JSON.stringify(frame)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

const ERROR_CODES: ReadonlySet<string> = new Set<string>(
  Object.values(ProtocolErrorCode),
)

function isErrorCode(value: unknown): value is ProtocolErrorCode {
  return typeof value === 'string' && ERROR_CODES.has(value)
}

function isReceiptStatus(value: unknown): value is ReceiptStatus {
  return (
    value === ReceiptStatus.Accepted ||
    value === ReceiptStatus.Duplicate ||
    value === ReceiptStatus.Rejected
  )
}

/**
 * Parse one wire frame, or `null` when the bytes are not a frame of this
 * version.
 *
 * Returning `null` rather than throwing is deliberate: a malformed frame is a
 * routine event on a public socket, and the caller's answer to it is always
 * the same (drop the connection), never a stack trace.
 */
export function parseFrame(raw: string): TransportFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed['v'] !== FRAME_VERSION) return null

  switch (parsed['t']) {
    case FrameType.Challenge:
      return isNonEmptyString(parsed['nonce'])
        ? { t: FrameType.Challenge, v: FRAME_VERSION, nonce: parsed['nonce'] }
        : null
    case FrameType.Auth:
      return isNonEmptyString(parsed['node']) &&
        isNonEmptyString(parsed['nonce']) &&
        isNonEmptyString(parsed['clientNonce']) &&
        isNonEmptyString(parsed['mac'])
        ? {
            t: FrameType.Auth,
            v: FRAME_VERSION,
            node: parsed['node'],
            nonce: parsed['nonce'],
            clientNonce: parsed['clientNonce'],
            mac: parsed['mac'],
          }
        : null
    case FrameType.Ready:
      return { t: FrameType.Ready, v: FRAME_VERSION }
    case FrameType.KeepAlive:
      return { t: FrameType.KeepAlive, v: FRAME_VERSION }
    case FrameType.Envelope:
      return 'envelope' in parsed
        ? {
            t: FrameType.Envelope,
            v: FRAME_VERSION,
            envelope: parsed['envelope'],
          }
        : null
    case FrameType.Receipt: {
      if (!isNonEmptyString(parsed['msgId'])) return null
      if (!isReceiptStatus(parsed['status'])) return null
      const code = parsed['code']
      const reason = parsed['reason']
      return {
        t: FrameType.Receipt,
        v: FRAME_VERSION,
        msgId: parsed['msgId'],
        status: parsed['status'],
        ...(isErrorCode(code) ? { code } : {}),
        ...(isNonEmptyString(reason) ? { reason } : {}),
      }
    }
    default:
      return null
  }
}
