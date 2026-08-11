/** Hard boundaries of the v0 protocol. Shared by every node on the network. */
export const LIMITS = {
  /** Maximum size of one serialized envelope, in bytes (256 KiB). */
  maxMessageBytes: 256 * 1024,
  /** Maximum number of nodes a message may traverse. */
  maxHops: 8,
  /** Default lifetime applied when the sender does not set one (30s). */
  defaultTtlMs: 30_000,
  /** Per-sender inbound budget enforced by a receiving node. */
  ratePerMinute: 600,
} as const

export type Limits = typeof LIMITS
