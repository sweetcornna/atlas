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
} from "./address.ts";

export {
  ProtocolError,
  ProtocolErrorCode,
  issue,
  type ProtocolIssue,
} from "./errors.ts";

export { LIMITS, type Limits } from "./limits.ts";

export {
  ENVELOPE_VERSION,
  MESSAGE_TYPES,
  MessageType,
  createMessage,
  destinationNode,
  errorReply,
  expiresAt,
  isExpired,
  isMessageType,
  messageBytes,
  newId,
  serializeMessage,
  withHop,
  type CreateMessageInput,
  type QianmoMessage,
} from "./message.ts";

export {
  assertValidMessage,
  firstErrorCode,
  validateMessage,
  type ValidateOptions,
  type ValidationResult,
} from "./validate.ts";
