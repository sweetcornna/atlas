// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** What the `qianmo_notify` tool asks the host for. */
export interface QianmoNotifyRequest {
  /**
   * Which omp RPC session is asking.
   *
   * Load-bearing, not bookkeeping: it is how the host finds the running turn,
   * and through it the task, the hub address and the channel to answer on.
   * A request the host cannot attribute to a running turn is refused rather
   * than guessed at.
   */
  readonly sessionId: string
  readonly kind: string
  readonly severity: string
  readonly summary: string
  readonly detail?: string
  readonly dedupKey?: string
}

/**
 * What the host answers.
 *
 * Every branch is reported honestly, including the ones that mean "not yet":
 * the tool turns this into text the model reads, and a `queued` that
 * presented itself as `sent` would teach the model that its notifications
 * always land.
 */
export interface QianmoNotifyVerdict {
  readonly status: 'sent' | 'queued' | 'unsupported' | 'duplicate' | 'rejected'
  readonly detail?: string
  /** Set only when the sliding window is what held it back. */
  readonly retryAfterMs?: number
}

const VERDICT_STATUSES: ReadonlySet<string> = new Set([
  'sent',
  'queued',
  'unsupported',
  'duplicate',
  'rejected',
])

/**
 * Read a verdict off the wire.
 *
 * An unrecognized answer becomes `rejected` rather than an exception: the two
 * ends of this hop are one process pair that upgrades together, so a shape
 * mismatch means something is genuinely wrong — but the failure a *turn*
 * should see for that is "your notification did not go out", not a thrown
 * error that ends the turn.
 */
export function parseNotifyVerdict(
  value: Record<string, unknown> | null | undefined,
): QianmoNotifyVerdict {
  const status = value?.['status']
  if (typeof status !== 'string' || !VERDICT_STATUSES.has(status)) {
    return {
      status: 'rejected',
      detail: 'the resident host returned an unrecognized notify verdict',
    }
  }
  const detail = value?.['detail']
  const retryAfterMs = value?.['retryAfterMs']
  return {
    status: status as QianmoNotifyVerdict['status'],
    ...(typeof detail === 'string' ? { detail } : {}),
    ...(typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
      ? { retryAfterMs }
      : {}),
  }
}
