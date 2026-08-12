// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/** Hard boundaries of the v0 protocol. Shared by every node on the network. */
export const LIMITS = {
  /** Maximum size of one serialized envelope, in bytes (256 KiB). */
  maxMessageBytes: 256 * 1024,
  /** Maximum number of nodes a message may traverse. */
  maxHops: 8,
  /**
   * Default DELIVERY deadline when the sender does not set one (30s).
   *
   * Bounds `created → acked` only. It is not the task deadline: one field used
   * to carry both meanings, which is why a 30s default appeared to contradict
   * AC-2's 60s ack line. `defaultTaskTtlMs` below carries the other half.
   */
  defaultTtlMs: 30_000,
  /**
   * Default TASK deadline when the sender does not set one (5 min).
   *
   * Bounds `created → completed / failed`. Set to exactly AC-2's result line:
   * a task that outruns this has already failed acceptance, so the protocol
   * must not still count it alive. Wake-time is excluded by the time-jump
   * gate, so a frozen node does not burn its task budget while paused.
   */
  defaultTaskTtlMs: 300_000,
  /** Per-sender inbound budget enforced by a receiving node. */
  ratePerMinute: 600,
} as const

export type Limits = typeof LIMITS
