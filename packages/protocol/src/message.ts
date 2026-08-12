// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { parseAddress } from './address.js'
import { ProtocolError, ProtocolErrorCode, issue } from './errors.js'
import { LIMITS } from './limits.js'

/** Envelope version currently spoken on the network. */
export const ENVELOPE_VERSION = 0

/** Every message kind the v0 protocol carries. */
export enum MessageType {
  /** Ask an agent to perform work. */
  TaskRequest = 'task.request',
  /** Terminal answer to a `task.request`, correlated by `traceId`. */
  TaskResult = 'task.result',
  /** Liveness probe. */
  Ping = 'ping',
  /** Reply to `ping`. */
  Pong = 'pong',
  /** Bring a sleeping agent back to `running`. */
  Wake = 'wake',
  /** Delivery or processing failure, payload carries a ProtocolErrorCode. */
  Error = 'error',
}

/** All message types, in declaration order. */
export const MESSAGE_TYPES: readonly MessageType[] = Object.freeze(
  Object.values(MessageType),
)

const MESSAGE_TYPE_SET: ReadonlySet<string> = new Set<string>(MESSAGE_TYPES)

/** True when `value` is one of the known {@link MessageType} members. */
export function isMessageType(value: unknown): value is MessageType {
  return typeof value === 'string' && MESSAGE_TYPE_SET.has(value)
}

/**
 * The v0 wire envelope. Immutable by contract: routing produces new envelopes
 * (see {@link withHop}) rather than mutating one in flight.
 */
export interface QianmoMessage<P = unknown> {
  /** Envelope version. Always `0` for this release. */
  readonly v: 0
  /** Unique id of this envelope. */
  readonly msgId: string
  /** Correlates a request with its results across nodes. */
  readonly traceId: string
  /** Sender address, `qianmo://<node>/<agent>`. */
  readonly from: string
  /** Recipient address, `qianmo://<node>/<agent>`. */
  readonly to: string
  readonly type: MessageType
  readonly payload: P
  /** Epoch milliseconds when the sender created the envelope. */
  readonly createdAt: number
  /** Lifetime in milliseconds, counted from `createdAt`. */
  readonly ttlMs: number
  /** Node names already traversed, oldest first. Used for loop detection. */
  readonly hops: readonly string[]
}

/** Fields a caller supplies to {@link createMessage}; the rest are defaulted. */
export interface CreateMessageInput<P = unknown> {
  readonly from: string
  readonly to: string
  readonly type: MessageType
  readonly payload: P
  readonly msgId?: string
  readonly traceId?: string
  readonly createdAt?: number
  readonly ttlMs?: number
  readonly hops?: readonly string[]
}

/** Fresh, collision-resistant identifier for envelopes and traces. */
export function newId(): string {
  return crypto.randomUUID()
}

/**
 * Build a well-formed envelope, filling in `msgId`, `traceId`, `createdAt`,
 * `ttlMs` and `hops` when the caller omits them.
 */
export function createMessage<P>(
  input: CreateMessageInput<P>,
): QianmoMessage<P> {
  return {
    v: ENVELOPE_VERSION,
    msgId: input.msgId ?? newId(),
    traceId: input.traceId ?? newId(),
    from: input.from,
    to: input.to,
    type: input.type,
    payload: input.payload,
    createdAt: input.createdAt ?? Date.now(),
    ttlMs: input.ttlMs ?? LIMITS.defaultTtlMs,
    hops: Object.freeze([...(input.hops ?? [])]),
  }
}

/**
 * Append `node` to the hop list, returning a new envelope.
 * Throws {@link ProtocolError} when that would create a loop or overflow
 * `LIMITS.maxHops` — routers must reject such a message instead of forwarding.
 */
export function withHop<P>(
  message: QianmoMessage<P>,
  node: string,
): QianmoMessage<P> {
  if (message.hops.includes(node)) {
    throw new ProtocolError([
      issue(ProtocolErrorCode.E_LOOP, 'hops', `node already in hops: ${node}`),
    ])
  }
  if (message.hops.length + 1 > LIMITS.maxHops) {
    throw new ProtocolError([
      issue(
        ProtocolErrorCode.E_TOO_MANY_HOPS,
        'hops',
        `hop limit ${LIMITS.maxHops} exceeded`,
      ),
    ])
  }
  return { ...message, hops: Object.freeze([...message.hops, node]) }
}

/** Epoch milliseconds at which the message stops being deliverable. */
export function expiresAt(message: QianmoMessage): number {
  return message.createdAt + message.ttlMs
}

/** True when the message's TTL has elapsed at `now`. */
export function isExpired(
  message: QianmoMessage,
  now: number = Date.now(),
): boolean {
  return now > expiresAt(message)
}

/** Canonical JSON encoding used for size accounting and transport. */
export function serializeMessage(message: QianmoMessage): string {
  return JSON.stringify(message)
}

const ENCODER = new TextEncoder()

/** Size of the serialized envelope in bytes (UTF-8). */
export function messageBytes(message: QianmoMessage): number {
  return ENCODER.encode(serializeMessage(message)).length
}

/** Build the standard `error` reply for a rejected message. */
export function errorReply(
  original: QianmoMessage,
  code: ProtocolErrorCode,
  reason: string,
  now: number = Date.now(),
): QianmoMessage<{ code: ProtocolErrorCode; reason: string; ofMsgId: string }> {
  return createMessage({
    from: original.to,
    to: original.from,
    type: MessageType.Error,
    traceId: original.traceId,
    createdAt: now,
    payload: { code, reason, ofMsgId: original.msgId },
  })
}

/** Node name embedded in `to`, or `null` when the address is malformed. */
export function destinationNode(message: QianmoMessage): string | null {
  return parseAddress(message.to)?.node ?? null
}
