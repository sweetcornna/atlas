// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { parseAddress } from './address.js'
import { ProtocolError, ProtocolErrorCode, issue } from './errors.js'
import { computeFingerprint } from './fingerprint.js'
import { LIMITS } from './limits.js'

/** Envelope version currently spoken on the network. */
export const ENVELOPE_VERSION = 0

/** Every message kind the v0 protocol carries. */
export enum MessageType {
  /** Ask an agent to perform work. */
  TaskRequest = 'task.request',
  /**
   * A-class acknowledgement: the target agent has taken the message into its
   * input. Payload is field-closed — see {@link AckPayload}.
   */
  Ack = 'ack',
  /** Terminal answer to a `task.request`, correlated by `taskId` (C-1). */
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
 * Message types that *answer* an earlier message under its `taskId`, rather
 * than asking a handler to do something.
 *
 * The distinction is not cosmetic: it is what keeps loop detection (D-2) from
 * eating the reply path. A reply is addressed back at the requester and
 * carries the request's `taskId` by contract (C-1), so `(handler, taskId)`
 * revisit — the loop key — is the *expected* shape of a correct `ack` and a
 * correct `task.result`. Judging replies by that key would declare AC-2's
 * return path a loop on its first message.
 */
export function isReplyType(type: MessageType): boolean {
  return (
    type === MessageType.Ack ||
    type === MessageType.TaskResult ||
    type === MessageType.Error ||
    type === MessageType.Pong
  )
}

/**
 * The only value `trust` ever takes: a cross-node message is never trusted.
 * A closed set means the receiver has nothing to decide, only to label.
 */
export const TRUST_UNTRUSTED = 'untrusted'

/**
 * Provenance label (protocol.md §10.2).
 *
 * The receiving node fills this in from what it can verify itself; it never
 * takes the envelope's own account of where it came from. A sender still has
 * to emit the field — it seeds `node` / `agent` from its own `from` address,
 * and the receiver overwrites all of it on the way in.
 */
export interface MessageOrigin {
  /** Source node segment. */
  readonly node: string
  /** Source agent segment. */
  readonly agent: string
  /** `iss` of the capability token presented, when there was one. */
  readonly capIss?: string
  /** Epoch ms at which this node took the message in. */
  readonly receivedAt?: number
}

/**
 * The v0 wire envelope. Immutable by contract: routing produces new envelopes
 * (see {@link withHop}) rather than mutating one in flight.
 */
export interface QianmoMessage<P = unknown> {
  /** Envelope version. Always `0` for this release. */
  readonly v: 0
  /**
   * Unique id of *this transmission*. An at-least-once retransmission keeps
   * the same value — it is the receiver's first-level dedup key (§7.2).
   */
  readonly msgId: string
  /**
   * W3C `traceparent`: `00-<32 hex>-<16 hex>-<2 hex>` (§7.1). Only the
   * trace-id segment is stable across hops. Audit correlation only — the
   * request/reply correlation key is {@link QianmoMessage.taskId} (C-1).
   */
  readonly traceId: string
  /**
   * Task identifier. Half of the loop-detection key (D-2), the correlation
   * key between a request and its ack / result (C-1), and part of the
   * content fingerprint.
   */
  readonly taskId: string
  /** Conversation context spanning several tasks. Optional (A2A alignment). */
  readonly contextId?: string
  /** Sender address, `qianmo://<node>/<agent>`. */
  readonly from: string
  /** Recipient address, `qianmo://<node>/<agent>`. */
  readonly to: string
  readonly type: MessageType
  /**
   * Business payload, discriminated by `type`. Cross-node content is always
   * untrusted, and it must never restate an envelope field (no second `to`,
   * no second deadline, no second trace) — routing and business must not have
   * two sources of truth.
   */
  readonly payload: P
  /** Epoch milliseconds when the sender created the envelope. */
  readonly createdAt: number
  /**
   * DELIVERY deadline in ms from `createdAt`, covering `created → acked`
   * (§5.1). Expiry lands the message in `expired`.
   */
  readonly deliverTtlMs: number
  /**
   * TASK deadline in ms from `createdAt`, covering
   * `created → completed / failed` (§5.1). Expiry lands the message in
   * `timeout`.
   */
  readonly taskTtlMs: number
  /**
   * Node names already traversed, oldest first. A `maxHops` backstop and an
   * audit trail — **not** the loop detector (§6.2).
   */
  readonly hops: readonly string[]
  /** Content fingerprint, the second-level dedup key (§7.2). */
  readonly fingerprint: string
  /** Provenance label, authoritative only once the receiver has written it. */
  readonly origin: MessageOrigin
  /** Trust marker. Always {@link TRUST_UNTRUSTED}. */
  readonly trust: typeof TRUST_UNTRUSTED
  /** Capability token (Ed25519, detached signature). Absent means read-only. */
  readonly cap?: string
  /**
   * Hard spending ceiling. M0 pins it to `0` (charter N-1): the field exists
   * so the "a hard cap can stop the message" mechanism is exercised, nothing
   * more. A non-zero value is rejected outbound with `E_BUDGET_EXHAUSTED`.
   */
  readonly costLimit: number
}

/** Fields a caller supplies to {@link createMessage}; the rest are defaulted. */
export interface CreateMessageInput<P = unknown> {
  readonly from: string
  readonly to: string
  readonly type: MessageType
  readonly payload: P
  readonly msgId?: string
  readonly traceId?: string
  readonly taskId?: string
  readonly contextId?: string
  readonly createdAt?: number
  readonly deliverTtlMs?: number
  readonly taskTtlMs?: number
  readonly hops?: readonly string[]
  /** Override the computed fingerprint. Only re-senders should need this. */
  readonly fingerprint?: string
  readonly origin?: MessageOrigin
  readonly cap?: string
  readonly costLimit?: number
}

/** Fresh, collision-resistant identifier for envelopes and tasks. */
export function newId(): string {
  return crypto.randomUUID()
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return Array.from(buffer, byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * A fresh W3C `traceparent` (§7.1): `00-<32 hex>-<16 hex>-01`.
 *
 * Sampled (`01`) because C-6 wants every cross-node message reconstructable
 * from the audit log. Per-hop `parent-id` regeneration is the routing layer's
 * job; the trace-id segment is what stays constant end to end.
 */
export function newTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`
}

const TRACEPARENT_PATTERN = /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/

/**
 * Continue a trace at the next hop: same trace-id, fresh parent-id (§7.1).
 *
 * W3C `traceparent` names the *caller's* span in `parent-id`, so a relay that
 * passes the header through unchanged tells every downstream span that its
 * parent is the origin — the chain flattens and "who forwarded this to whom"
 * stops being answerable, which is the one question C-6 asks of the field.
 * Only the trace-id segment is meant to survive a hop, and it is what audit
 * correlation keys on.
 *
 * A value that is not a well-formed traceparent is returned untouched: this
 * function is not a validator, and inventing a header for a malformed one
 * would hide the malformation from the check that does reject it.
 */
export function advanceTraceparent(traceparent: string): string {
  if (!TRACEPARENT_PATTERN.test(traceparent)) return traceparent
  const [version, traceId, , flags] = traceparent.split('-')
  return `${version}-${traceId}-${randomHex(8)}-${flags}`
}

function originOf(from: string): MessageOrigin {
  const parsed = parseAddress(from)
  // A malformed `from` is caught by validation; do not invent a provenance.
  return parsed === null
    ? { node: '', agent: '' }
    : { node: parsed.node, agent: parsed.agent }
}

/**
 * Build a well-formed envelope, defaulting every field the caller omits:
 * ids, `traceId` as a fresh traceparent, both deadlines from `LIMITS`, an
 * empty hop list, the computed fingerprint, an origin seeded from `from`,
 * `trust` and a zero `costLimit`.
 */
export function createMessage<P>(
  input: CreateMessageInput<P>,
): QianmoMessage<P> {
  const taskId = input.taskId ?? newId()
  return {
    v: ENVELOPE_VERSION,
    msgId: input.msgId ?? newId(),
    traceId: input.traceId ?? newTraceparent(),
    taskId,
    ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
    from: input.from,
    to: input.to,
    type: input.type,
    payload: input.payload,
    createdAt: input.createdAt ?? Date.now(),
    deliverTtlMs: input.deliverTtlMs ?? LIMITS.defaultTtlMs,
    taskTtlMs: input.taskTtlMs ?? LIMITS.defaultTaskTtlMs,
    hops: Object.freeze([...(input.hops ?? [])]),
    fingerprint:
      input.fingerprint ??
      computeFingerprint({
        from: input.from,
        to: input.to,
        type: input.type,
        taskId,
        payload: input.payload,
      }),
    origin: input.origin ?? originOf(input.from),
    trust: TRUST_UNTRUSTED,
    ...(input.cap === undefined ? {} : { cap: input.cap }),
    costLimit: input.costLimit ?? 0,
  }
}

/**
 * Append `node` to the hop list, returning a new envelope.
 *
 * Wiring — protocol.md §6.3 pins the call sites to **exactly two**, and the
 * router built in P4.2 must honour that:
 *
 * 1. **Initial seeding**: the sender calls `withHop(msg, selfNode)` after
 *    {@link createMessage} and before handing the envelope to the transport,
 *    so `hops[0]` is the originating node. Skipping this leaves the audit
 *    chain headless and under-counts `maxHops` by one.
 * 2. **Before forwarding**: a relay calls it before passing the envelope on.
 *
 * The **terminal node does not call it** — it forwards nothing, so appending
 * itself would only inflate the hop count of the reply. One sentence: call it
 * right before handing a message to the transport, first time or n-th time.
 *
 * `hops` is a `maxHops` backstop plus an audit trail; it is **not** the loop
 * detector (D-2). Loop detection is keyed on `(handler address, taskId)` and
 * lives in the routing layer, not in this package — a node may legitimately be
 * traversed twice for two different handlers.
 *
 * Throws {@link ProtocolError} with `E_TOO_MANY_HOPS` when the append would
 * overflow `LIMITS.maxHops` — routers must reject instead of forwarding.
 */
export function withHop<P>(
  message: QianmoMessage<P>,
  node: string,
): QianmoMessage<P> {
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

/**
 * Epoch ms at which delivery gives up: `createdAt + deliverTtlMs` (§5.1).
 *
 * The end of this window is `acked` — the target agent having actually read
 * the message — not "written into the mailbox". A message that made it to
 * disk but was then evicted has *not* been delivered, and this deadline is
 * what still catches it (§4.5).
 */
export function deliveryExpiresAt(message: QianmoMessage): number {
  return message.createdAt + message.deliverTtlMs
}

/**
 * True when the DELIVERY deadline has passed at `now` → terminal `expired`.
 *
 * Evaluated in three places, none skippable (rule T-1): before sending, on
 * arrival before the mailbox write, and while watching for the read flag.
 * The last two must first clear the time-jump gate (T-2) — a node that just
 * thawed would otherwise judge every in-flight message dead at once.
 */
export function isDeliveryExpired(
  message: QianmoMessage,
  now: number = Date.now(),
): boolean {
  return now > deliveryExpiresAt(message)
}

/** Epoch ms at which the task gives up: `createdAt + taskTtlMs` (§5.1). */
export function taskExpiresAt(message: QianmoMessage): number {
  return message.createdAt + message.taskTtlMs
}

/**
 * True when the TASK deadline has passed at `now` → terminal `timeout`.
 *
 * This is the sender-side deadline for a terminal `task.result`; it is the
 * one that may absorb the seconds of working-set warm-up an A-class ack
 * deliberately excludes (§4.3).
 */
export function isTaskExpired(
  message: QianmoMessage,
  now: number = Date.now(),
): boolean {
  return now > taskExpiresAt(message)
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

/**
 * Payload of an `ack`, and the whole of it (rule K-1, protocol.md §4.3).
 *
 * `ack` is A-class: it asserts that the target agent has taken the message
 * into its input — the `read` flag flipped — and nothing else. Correlation
 * identifiers remain in the envelope, so the payload only names the handler
 * and the instant at which it observed the read.
 */
export interface AckPayload {
  /** Address of the acknowledging handler, `qianmo://<node>/<agent>`. */
  readonly handler: string
  /** Local epoch ms at which the read flag was observed. */
  readonly ackAt: number
}

const ACK_PAYLOAD_KEYS: readonly string[] = ['handler', 'ackAt']

/** True when `value` is an {@link AckPayload} with no extra fields. */
export function isAckPayload(value: unknown): value is AckPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const keys = Object.keys(value)
  if (keys.length !== ACK_PAYLOAD_KEYS.length) return false
  if (!ACK_PAYLOAD_KEYS.every(key => keys.includes(key))) return false
  const payload = value as Record<string, unknown>
  return (
    parseAddress(payload['handler']) !== null &&
    typeof payload['ackAt'] === 'number' &&
    Number.isFinite(payload['ackAt']) &&
    payload['ackAt'] > 0
  )
}

/** Terminal result of a `task.request`, field-closed in both branches. */
export type TaskResultPayload =
  | {
      readonly outcome: 'completed'
      readonly content: string
      readonly completedAt: number
    }
  | {
      readonly outcome: 'failed'
      readonly code: ProtocolErrorCode
      readonly reason: string
      readonly completedAt: number
    }

/** Input accepted by {@link createTaskResult}; the factory supplies the clock. */
export type TaskResultInput =
  | { readonly outcome: 'completed'; readonly content: string }
  | {
      readonly outcome: 'failed'
      readonly code: ProtocolErrorCode
      readonly reason: string
    }

const TASK_RESULT_COMPLETED_KEYS: readonly string[] = [
  'outcome',
  'content',
  'completedAt',
]
const TASK_RESULT_FAILED_KEYS: readonly string[] = [
  'outcome',
  'code',
  'reason',
  'completedAt',
]
const PROTOCOL_ERROR_CODES: ReadonlySet<string> = new Set<string>(
  Object.values(ProtocolErrorCode),
)

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expected.length && expected.every(key => keys.includes(key))
  )
}

/** True when `value` is a closed successful or failed task result. */
export function isTaskResultPayload(
  value: unknown,
): value is TaskResultPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const payload = value as Record<string, unknown>
  const completedAt = payload['completedAt']
  if (
    typeof completedAt !== 'number' ||
    !Number.isFinite(completedAt) ||
    completedAt <= 0
  ) {
    return false
  }
  if (payload['outcome'] === 'completed') {
    return (
      hasExactKeys(payload, TASK_RESULT_COMPLETED_KEYS) &&
      typeof payload['content'] === 'string'
    )
  }
  if (payload['outcome'] === 'failed') {
    return (
      hasExactKeys(payload, TASK_RESULT_FAILED_KEYS) &&
      typeof payload['code'] === 'string' &&
      PROTOCOL_ERROR_CODES.has(payload['code']) &&
      typeof payload['reason'] === 'string' &&
      payload['reason'].length > 0
    )
  }
  return false
}

/** Build the A-class `ack` after `handler` observes the input read. */
export function createAck(
  original: QianmoMessage,
  handler: string,
  now: number = Date.now(),
): QianmoMessage<AckPayload> {
  return createMessage({
    from: handler,
    to: original.from,
    type: MessageType.Ack,
    traceId: original.traceId,
    taskId: original.taskId,
    ...(original.contextId === undefined
      ? {}
      : { contextId: original.contextId }),
    createdAt: now,
    payload: { handler, ackAt: now },
  })
}

/** Build the terminal `task.result` for an original request. */
export function createTaskResult(
  original: QianmoMessage,
  handler: string,
  result: TaskResultInput,
  now: number = Date.now(),
): QianmoMessage<TaskResultPayload> {
  return createMessage({
    from: handler,
    to: original.from,
    type: MessageType.TaskResult,
    traceId: original.traceId,
    taskId: original.taskId,
    ...(original.contextId === undefined
      ? {}
      : { contextId: original.contextId }),
    createdAt: now,
    payload: { ...result, completedAt: now },
  })
}

/** Payload of a protocol `error`; correlation stays in the envelope. */
export interface ErrorPayload {
  readonly code: ProtocolErrorCode
  readonly reason: string
}

/** Build the standard `error` reply for a rejected message. */
export function errorReply(
  original: QianmoMessage,
  code: ProtocolErrorCode,
  reason: string,
  now: number = Date.now(),
): QianmoMessage<ErrorPayload> {
  return createMessage({
    from: original.to,
    to: original.from,
    type: MessageType.Error,
    traceId: original.traceId,
    taskId: original.taskId,
    ...(original.contextId === undefined
      ? {}
      : { contextId: original.contextId }),
    createdAt: now,
    payload: { code, reason },
  })
}

/** Node name embedded in `to`, or `null` when the address is malformed. */
export function destinationNode(message: QianmoMessage): string | null {
  return parseAddress(message.to)?.node ?? null
}
