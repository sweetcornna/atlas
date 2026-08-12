// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { isValidAddress, isValidSegment } from './address.js'
import {
  ProtocolError,
  ProtocolErrorCode,
  issue,
  type ProtocolIssue,
} from './errors.js'
import { isFingerprint } from './fingerprint.js'
import { LIMITS } from './limits.js'
import {
  deliveryExpiresAt,
  ENVELOPE_VERSION,
  isAckPayload,
  isMessageType,
  messageBytes,
  MessageType,
  type QianmoMessage,
  TRUST_UNTRUSTED,
} from './message.js'

/** Knobs for {@link validateMessage}; every field falls back to `LIMITS`. */
export interface ValidateOptions {
  /**
   * Name of the node running the check. When set, a message whose `hops`
   * already contains this node is rejected with `E_LOOP`.
   *
   * **Debug / test use only — inbound validation must never pass it** (D-2,
   * protocol.md §6.2). Node granularity kills legitimate spirals: the same
   * node may be traversed twice for two different handlers. Real loop
   * detection is keyed on `(handler address, taskId)` in the routing layer.
   */
  readonly node?: string
  /** Injected clock for TTL checks; defaults to `Date.now()`. */
  readonly now?: number
  readonly maxMessageBytes?: number
  readonly maxHops?: number
}

/** Outcome of {@link validateMessage}: the narrowed message, or the reasons. */
export type ValidationResult =
  | { readonly ok: true; readonly message: QianmoMessage }
  | { readonly ok: false; readonly issues: readonly ProtocolIssue[] }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isAbsent(value: unknown): boolean {
  return value === undefined
}

/** Structural check of the `origin` provenance label (§10.2). */
function originIssues(value: unknown): readonly ProtocolIssue[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [
      issue(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'origin',
        'origin must be an object',
      ),
    ]
  }
  const origin = value as Record<string, unknown>
  const problems: ProtocolIssue[] = []
  if (!isValidSegment(origin['node']) || !isValidSegment(origin['agent'])) {
    problems.push(
      issue(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'origin',
        'origin.node and origin.agent must be valid segments',
      ),
    )
  }
  if (!isAbsent(origin['capIss']) && !isNonEmptyString(origin['capIss'])) {
    problems.push(
      issue(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'origin.capIss',
        'origin.capIss must be a non-empty string when present',
      ),
    )
  }
  if (
    !isAbsent(origin['receivedAt']) &&
    !isPositiveFinite(origin['receivedAt'])
  ) {
    problems.push(
      issue(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'origin.receivedAt',
        'origin.receivedAt must be a positive epoch time when present',
      ),
    )
  }
  return problems
}

/**
 * Validate an untrusted value as a v0 envelope.
 *
 * Runs in two phases: structural checks first, then boundary checks (size,
 * TTL, hop count, loops) which only make sense on a well-formed envelope.
 * All failures of a phase are reported together.
 */
export function validateMessage(
  input: unknown,
  options: ValidateOptions = {},
): ValidationResult {
  const issues: ProtocolIssue[] = []

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      issues: [
        issue(
          ProtocolErrorCode.E_BAD_ENVELOPE,
          '',
          'message must be a plain object',
        ),
      ],
    }
  }

  const raw = input as Record<string, unknown>

  // --- phase 1: structure -------------------------------------------------
  if (raw['v'] !== ENVELOPE_VERSION) {
    issues.push(
      issue(
        ProtocolErrorCode.E_BAD_VERSION,
        'v',
        `unsupported envelope version: ${String(raw['v'])}`,
      ),
    )
  }
  if (!isNonEmptyString(raw['msgId'])) {
    issues.push(
      issue(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'msgId',
        'msgId must be a non-empty string',
      ),
    )
  }
  if (!isNonEmptyString(raw['traceId'])) {
    issues.push(
      issue(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'traceId',
        'traceId must be a non-empty string',
      ),
    )
  }
  if (!isNonEmptyString(raw['taskId'])) {
    issues.push(
      issue(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'taskId',
        'taskId must be a non-empty string',
      ),
    )
  }
  if (!isAbsent(raw['contextId']) && !isNonEmptyString(raw['contextId'])) {
    issues.push(
      issue(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'contextId',
        'contextId must be a non-empty string when present',
      ),
    )
  }
  if (!isValidAddress(raw['from'])) {
    issues.push(
      issue(
        ProtocolErrorCode.E_BAD_ADDRESS,
        'from',
        `invalid sender address: ${String(raw['from'])}`,
      ),
    )
  }
  if (!isValidAddress(raw['to'])) {
    issues.push(
      issue(
        ProtocolErrorCode.E_BAD_ADDRESS,
        'to',
        `invalid recipient address: ${String(raw['to'])}`,
      ),
    )
  }
  if (!isMessageType(raw['type'])) {
    issues.push(
      issue(
        ProtocolErrorCode.E_BAD_TYPE,
        'type',
        `unknown message type: ${String(raw['type'])}`,
      ),
    )
  }
  if (!('payload' in raw)) {
    issues.push(
      issue(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'payload',
        'payload field is required',
      ),
    )
  } else if (raw['type'] === MessageType.Ack && !isAckPayload(raw['payload'])) {
    // Rule K-1: an ack payload is field-closed, extras included. Enforced here
    // as well as in the type so a peer cannot smuggle in a field whose value
    // only a warm working set could produce (§4.3).
    issues.push(
      issue(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'payload',
        'ack payload must be exactly { ofMsgId, taskId, handler, ackAt }',
      ),
    )
  }
  if (!isPositiveFinite(raw['createdAt'])) {
    issues.push(
      issue(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'createdAt',
        'createdAt must be a positive epoch time',
      ),
    )
  }
  if (!isPositiveFinite(raw['deliverTtlMs'])) {
    issues.push(
      issue(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'deliverTtlMs',
        'deliverTtlMs must be a positive number',
      ),
    )
  }
  if (!isPositiveFinite(raw['taskTtlMs'])) {
    issues.push(
      issue(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'taskTtlMs',
        'taskTtlMs must be a positive number',
      ),
    )
  }
  if (!isFingerprint(raw['fingerprint'])) {
    issues.push(
      issue(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'fingerprint',
        'fingerprint must be a sha-256 hex digest',
      ),
    )
  }
  issues.push(...originIssues(raw['origin']))
  if (raw['trust'] !== TRUST_UNTRUSTED) {
    issues.push(
      issue(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'trust',
        `trust must be "${TRUST_UNTRUSTED}"`,
      ),
    )
  }
  if (!isAbsent(raw['cap']) && !isNonEmptyString(raw['cap'])) {
    issues.push(
      issue(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'cap',
        'cap must be a non-empty token string when present',
      ),
    )
  }
  if (
    typeof raw['costLimit'] !== 'number' ||
    !Number.isFinite(raw['costLimit']) ||
    raw['costLimit'] < 0
  ) {
    issues.push(
      issue(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'costLimit',
        'costLimit must be a non-negative number',
      ),
    )
  }

  const hops: unknown = raw['hops']
  if (!Array.isArray(hops)) {
    issues.push(
      issue(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'hops',
        'hops must be an array of node names',
      ),
    )
  } else {
    const hopList: readonly unknown[] = hops
    if (!hopList.every(isValidSegment)) {
      issues.push(
        issue(
          ProtocolErrorCode.E_BAD_ADDRESS,
          'hops',
          'hops must contain valid node names',
        ),
      )
    }
  }

  if (issues.length > 0) return { ok: false, issues }

  const message = input as QianmoMessage

  // --- phase 2: boundaries ------------------------------------------------
  const maxHops = options.maxHops ?? LIMITS.maxHops
  const maxBytes = options.maxMessageBytes ?? LIMITS.maxMessageBytes
  const now = options.now ?? Date.now()

  if (options.node !== undefined && message.hops.includes(options.node)) {
    issues.push(
      issue(
        ProtocolErrorCode.E_LOOP,
        'hops',
        `message already visited node ${options.node}`,
      ),
    )
  }
  if (message.hops.length > maxHops) {
    issues.push(
      issue(
        ProtocolErrorCode.E_TOO_MANY_HOPS,
        'hops',
        `hop count ${message.hops.length} exceeds limit ${maxHops}`,
      ),
    )
  }

  const bytes = messageBytes(message)
  if (bytes > maxBytes) {
    issues.push(
      issue(
        ProtocolErrorCode.E_TOO_LARGE,
        '',
        `message is ${bytes} bytes, limit is ${maxBytes}`,
      ),
    )
  }

  // M0 pins every message to zero spend (charter N-1); a non-zero ceiling is
  // stopped outbound, which is the whole mechanism the field exists to prove.
  if (message.costLimit !== 0) {
    issues.push(
      issue(
        ProtocolErrorCode.E_BUDGET_EXHAUSTED,
        'costLimit',
        `costLimit must be 0 in M0, got ${message.costLimit}`,
      ),
    )
  }

  // Only the DELIVERY deadline is an envelope-validity question. The task
  // deadline is a sender-side timer over the whole task (§8.2 row 21), so it
  // is exposed as `isTaskExpired` rather than judged here.
  if (now > deliveryExpiresAt(message)) {
    issues.push(
      issue(
        ProtocolErrorCode.E_TTL_EXPIRED,
        'deliverTtlMs',
        `delivery expired at ${deliveryExpiresAt(message)}, now is ${now}`,
      ),
    )
  }

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, message }
}

/** Validate or throw. Returns the narrowed envelope on success. */
export function assertValidMessage(
  input: unknown,
  options: ValidateOptions = {},
): QianmoMessage {
  const result = validateMessage(input, options)
  if (!result.ok) throw new ProtocolError(result.issues)
  return result.message
}

/** First error code of a failed validation, for terse logging and replies. */
export function firstErrorCode(
  result: ValidationResult,
): ProtocolErrorCode | null {
  return result.ok ? null : (result.issues[0]?.code ?? null)
}
