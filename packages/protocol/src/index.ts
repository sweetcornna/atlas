// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `@qianmo/protocol` — the wire contract of the Qianmo agent network.
 *
 * Types plus pure functions only: no I/O, no runtime dependencies, so both
 * nodes and tooling can share one definition of "a valid message".
 */

export {
  ADDRESS_SCHEME,
  MAX_SEGMENT_LENGTH,
  addressEquals,
  assertAddress,
  formatAddress,
  isValidAddress,
  isValidSegment,
  nodeOf,
  parseAddress,
  type QianmoAddress,
} from './address.js'

export {
  ProtocolError,
  ProtocolErrorCode,
  issue,
  type ProtocolIssue,
} from './errors.js'

export {
  computeFingerprint,
  isFingerprint,
  payloadDigest,
  type FingerprintInput,
} from './fingerprint.js'

export { LIMITS, type Limits } from './limits.js'

export {
  ENVELOPE_VERSION,
  MESSAGE_TYPES,
  MessageType,
  TRUST_UNTRUSTED,
  createAck,
  createMessage,
  deliveryExpiresAt,
  destinationNode,
  errorReply,
  isAckPayload,
  isDeliveryExpired,
  isMessageType,
  isTaskExpired,
  messageBytes,
  newId,
  newTraceparent,
  serializeMessage,
  taskExpiresAt,
  withHop,
  type AckPayload,
  type CreateMessageInput,
  type MessageOrigin,
  type QianmoMessage,
} from './message.js'

export {
  assertValidMessage,
  firstErrorCode,
  validateMessage,
  type ValidateOptions,
export {
  DEFAULT_GRACE_MS,
  DEFAULT_MIN_JUMP_GAP_MS,
  DEFAULT_TIME_JUMP_FACTOR,
  TimeJumpGate,
  type TimeJumpGateOptions,
  type TimeJumpObservation,
} from './time-jump.js'

  type ValidationResult,
} from './validate.js'
