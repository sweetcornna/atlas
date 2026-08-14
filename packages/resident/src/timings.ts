// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

export type ResidentTimingStage =
  | 'acp_ready'
  | 'detected'
  | 'admitted'
  | 'read'
  | 'first_content'
  | 'turn_completed'
  | 'turn_failed'

export interface ResidentTimingEvent {
  readonly stage: ResidentTimingStage
  readonly at: number
  readonly sessionId: string
  readonly inputMessageId?: string
  readonly networkMsgId?: string
  readonly agent?: string
  readonly activityReconnectFactor?: number
  readonly error?: string
}

export type ResidentTimingSink = (event: ResidentTimingEvent) => void

export const DEFAULT_RESIDENT_TIMING_CAPACITY = 256

export class ResidentTimingRecorder {
  readonly #sink: ResidentTimingSink | undefined
  readonly #capacity: number
  readonly #events: ResidentTimingEvent[] = []

  constructor(
    sink?: ResidentTimingSink,
    capacity = DEFAULT_RESIDENT_TIMING_CAPACITY,
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        'resident timing capacity must be a positive integer',
      )
    }
    this.#sink = sink
    this.#capacity = capacity
  }

  record(event: ResidentTimingEvent): void {
    this.#events.push(event)
    if (this.#events.length > this.#capacity) this.#events.shift()
    try {
      this.#sink?.(event)
    } catch {
      // Timing is evidence, not part of admission or execution semantics.
    }
  }

  all(): readonly ResidentTimingEvent[] {
    return [...this.#events]
  }
}
