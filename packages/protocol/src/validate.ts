import { isValidAddress, isValidSegment } from './address.js'
import {
  ProtocolError,
  ProtocolErrorCode,
  issue,
  type ProtocolIssue,
} from './errors.js'
import { LIMITS } from './limits.js'
import {
  ENVELOPE_VERSION,
  expiresAt,
  isMessageType,
  messageBytes,
  type QianmoMessage,
} from './message.js'

/** Knobs for {@link validateMessage}; every field falls back to `LIMITS`. */
export interface ValidateOptions {
  /**
   * Name of the node running the check. When set, a message whose `hops`
   * already contains this node is rejected with `E_LOOP`.
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
  if (!isPositiveFinite(raw['ttlMs'])) {
    issues.push(
      issue(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'ttlMs',
        'ttlMs must be a positive number',
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

  if (new Set(message.hops).size !== message.hops.length) {
    issues.push(
      issue(ProtocolErrorCode.E_LOOP, 'hops', 'duplicate node in hops'),
    )
  }
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

  if (now > expiresAt(message)) {
    issues.push(
      issue(
        ProtocolErrorCode.E_TTL_EXPIRED,
        'ttlMs',
        `message expired at ${expiresAt(message)}, now is ${now}`,
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
