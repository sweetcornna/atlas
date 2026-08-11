/** Stable, wire-visible error codes for the Qianmo protocol. */
export enum ProtocolErrorCode {
  /** The value is not a message-shaped object, or a required field is missing. */
  E_BAD_ENVELOPE = "E_BAD_ENVELOPE",
  /** Envelope version is unknown or unsupported. */
  E_BAD_VERSION = "E_BAD_VERSION",
  /** `from` / `to` is not a well-formed `qianmo://<node>/<agent>` address. */
  E_BAD_ADDRESS = "E_BAD_ADDRESS",
  /** `type` is not a member of {@link MessageType}. */
  E_BAD_TYPE = "E_BAD_TYPE",
  /** Serialized message exceeds `LIMITS.maxMessageBytes`. */
  E_TOO_LARGE = "E_TOO_LARGE",
  /** `createdAt + ttlMs` is in the past. */
  E_TTL_EXPIRED = "E_TTL_EXPIRED",
  /** `hops` is longer than `LIMITS.maxHops`. */
  E_TOO_MANY_HOPS = "E_TOO_MANY_HOPS",
  /** A node appears twice in `hops`, or the receiving node is already in it. */
  E_LOOP = "E_LOOP",
  /** Sender exceeded `LIMITS.ratePerMinute`. */
  E_RATE_LIMITED = "E_RATE_LIMITED",
  /** The destination agent is unknown to this node. */
  E_UNKNOWN_AGENT = "E_UNKNOWN_AGENT",
}

/** A single reason why a message was rejected. */
export interface ProtocolIssue {
  readonly code: ProtocolErrorCode;
  /** Offending field path, or `""` when the whole envelope is at fault. */
  readonly field: string;
  readonly message: string;
}

/** Convenience constructor for {@link ProtocolIssue}. */
export function issue(
  code: ProtocolErrorCode,
  field: string,
  message: string,
): ProtocolIssue {
  return { code, field, message };
}

/** Error carrying a {@link ProtocolErrorCode}, thrown by the `assert*` helpers. */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly field: string;
  readonly issues: readonly ProtocolIssue[];

  constructor(issues: readonly ProtocolIssue[]) {
    const first = issues[0];
    super(first ? `${first.code}: ${first.message}` : "protocol error");
    this.name = "ProtocolError";
    this.code = first?.code ?? ProtocolErrorCode.E_BAD_ENVELOPE;
    this.field = first?.field ?? "";
    this.issues = issues;
  }
}
