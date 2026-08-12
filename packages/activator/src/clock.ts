// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * Clock, scheduler, and the time-jump gate.
 *
 * The gate is the reason this file exists. E4 measured a Bun process across
 * three freeze/thaw rounds and found:
 *
 *   - `CLOCK_MONOTONIC` **keeps advancing while the sandbox is frozen**
 *     (`gap_mono` and `gap_wall` agreed to within 10 ms across 34 s and 97 s
 *     freezes). Reaching for a monotonic clock does not dodge this; there is
 *     no clock source in the sandbox that skips the freeze.
 *   - `setInterval` does **not** replay missed ticks: a 34.7 s gap produced
 *     exactly one tick.
 *
 * Put together: at the instant of thaw, every "how long since I last saw X"
 * test crosses its threshold *simultaneously*. Without a gate a resident node
 * wakes up, concludes that its peer is gone, its in-flight deliveries have all
 * expired and its own retry budget is spent — and declares itself dead once per
 * wake. protocol.md §5.3 rule T-2 makes the gate mandatory for exactly this
 * reason, and P2.5 needs it on both faces: the heartbeat must not read a thaw
 * as "the daemon stopped answering", and the activator must not read a thaw as
 * "the target never became ready".
 *
 * Deliberately not imported from `@qianmo/transport`. That package has a gate
 * of the same lineage inside `ReconnectSchedule`, but it is welded to retry
 * budgets and is not part of that package's public surface; reaching into
 * another package's internals to share nine lines of arithmetic would buy a
 * coupling worth far more than the nine lines. The shapes differ too: there,
 * a jump resets an attempt budget; here, it opens a grace window during which
 * deadline judgements are suspended.
 */

/** Wall-clock source. Injected everywhere so tests never sleep to pass. */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number
}

/** The real clock. */
export const systemClock: Clock = { now: () => Date.now() }

/** Cancels a pending timer. Idempotent. */
export type CancelTimer = () => void

/**
 * Somewhere to put a delayed callback.
 *
 * A port rather than a direct `setTimeout` call so a keepalive covering hours
 * of wall clock can be exercised in a millisecond, and so a test can place the
 * process at any point of a freeze without freezing anything.
 */
export interface Scheduler {
  after(delayMs: number, callback: () => void): CancelTimer
}

/**
 * `setTimeout`-backed scheduler.
 *
 * `setTimeout` rather than `setInterval` on purpose: `setInterval` does not
 * replay missed ticks (E4), so an interval-driven heartbeat silently loses
 * every beat it slept through and then keeps its original phase. Rescheduling
 * from the completion of each beat keeps the *gap* bounded, which is the
 * property the freeze threshold actually cares about.
 */
export const timerScheduler: Scheduler = {
  after(delayMs, callback) {
    const handle = setTimeout(callback, Math.max(0, delayMs))
    // Node/Bun timers hold the event loop open; a heartbeat must not be the
    // reason a CLI refuses to exit.
    handle.unref?.()
    return () => clearTimeout(handle)
  },
}

/** Knobs of {@link TimeJumpGate}. */
export interface TimeJumpGateOptions {
  /**
   * The cadence the caller expects to observe at. A gap much larger than this
   * is evidence of a freeze rather than of elapsed work.
   */
  readonly periodMs: number
  /**
   * A gap above `periodMs × factor` is read as a freeze. Two, matching the
   * base's own dormancy heuristic and `@qianmo/transport`'s.
   */
  readonly factor?: number
  /**
   * How long after a detected thaw deadline judgements stay suspended.
   *
   * Sized for the *working set*, not the syscall: `unpause` itself is
   * 46.6–55.5 ms, but bringing a 400 MiB working set back to full speed took
   * 9.0–10.2 s in three consistent runs (E2). A grace window shorter than that
   * re-arms the judgements while the node is still crawling, which is the same
   * self-declared death the gate was built to prevent, just delayed.
   */
  readonly graceMs?: number
  /**
   * Floor under the detection threshold, whatever `periodMs × factor` works out
   * to.
   *
   * Without it, a caller observing every 10 ms would call any 25 ms scheduling
   * hiccup a freeze. Two seconds is far above anything an event loop does to
   * itself and far below any freeze worth detecting — E4's were 34 s and 97 s.
   */
  readonly minJumpGapMs?: number
}

/** Default freeze threshold multiplier. */
export const DEFAULT_TIME_JUMP_FACTOR = 2

/** Default floor under the detection threshold. */
export const DEFAULT_MIN_JUMP_GAP_MS = 2_000

/** Default grace window, covering E2's measured 9.0–10.2 s warm-up with margin. */
export const DEFAULT_GRACE_MS = 15_000

/** What {@link TimeJumpGate.observe} concluded. */
export interface TimeJumpObservation {
  /** True when this gap looks like a freeze rather than elapsed work. */
  readonly jumped: boolean
  /** Milliseconds since the previous observation; 0 for the first one. */
  readonly gapMs: number
  /** Epoch ms until which deadline judgements are suspended. */
  readonly graceUntil: number
}

/**
 * Detects "this process was frozen" and suspends deadline judgements after it.
 *
 * Stateful, and every method takes `now` as an argument rather than reading a
 * clock — the same discipline `@qianmo/transport`'s schedule uses, and the
 * reason a 97-second freeze is testable without waiting 97 seconds.
 */
export class TimeJumpGate {
  readonly #periodMs: number
  readonly #factor: number
  readonly #graceMs: number
  readonly #minGapMs: number
  #lastSeenAt: number | null = null
  #graceUntil = 0
  #jumps = 0

  constructor(options: TimeJumpGateOptions) {
    if (!(options.periodMs > 0)) {
      throw new RangeError(`periodMs must be positive, got ${options.periodMs}`)
    }
    const factor = options.factor ?? DEFAULT_TIME_JUMP_FACTOR
    if (!(factor > 1)) {
      throw new RangeError(`factor must be greater than 1, got ${factor}`)
    }
    this.#periodMs = options.periodMs
    this.#factor = factor
    this.#graceMs = options.graceMs ?? DEFAULT_GRACE_MS
    this.#minGapMs = options.minJumpGapMs ?? DEFAULT_MIN_JUMP_GAP_MS
  }

  /** How many thaws this gate has seen. */
  get jumpCount(): number {
    return this.#jumps
  }

  /** The gap above which an observation is read as a thaw. */
  get thresholdMs(): number {
    return Math.max(this.#periodMs * this.#factor, this.#minGapMs)
  }

  /**
   * Feed the gate one observation, letting it measure the gap itself.
   *
   * The first observation can never be a jump: with no previous timestamp
   * there is no gap to measure, and guessing would open a grace window on
   * every startup.
   */
  observe(now: number): TimeJumpObservation {
    const previous = this.#lastSeenAt
    if (previous === null) {
      this.#lastSeenAt = now
      return { jumped: false, gapMs: 0, graceUntil: this.#graceUntil }
    }
    return this.observeGap(now - previous, now)
  }

  /**
   * Feed the gate a gap the caller measured itself.
   *
   * For callers that know exactly how long they *asked* to be away — a loop
   * that slept for a known interval, most of all. Measuring across a known
   * wait is a far better freeze detector than measuring across arbitrary work:
   * an operation that legitimately blocks for six seconds is us running, and
   * calling that a freeze would hand out grace windows nobody earned.
   */
  observeGap(gapMs: number, now: number): TimeJumpObservation {
    this.#lastSeenAt = now
    if (gapMs > this.thresholdMs) {
      this.#jumps += 1
      this.#graceUntil = now + this.#graceMs
      return { jumped: true, gapMs, graceUntil: this.#graceUntil }
    }
    return { jumped: false, gapMs, graceUntil: this.#graceUntil }
  }

  /** True while deadline judgements are suspended. */
  inGrace(now: number): boolean {
    return now < this.#graceUntil
  }

  /**
   * Whether `deadlineAt` may be enforced at `now`.
   *
   * The asymmetry is intentional and is the whole safety argument: being wrong
   * here costs one late timeout, while being wrong the other way costs a node
   * that kills every in-flight delivery each time it wakes up.
   */
  expired(deadlineAt: number, now: number): boolean {
    if (this.inGrace(now)) return false
    return now >= deadlineAt
  }

  /**
   * Push a deadline out by the length of a freeze.
   *
   * T-2's "reset the deadline basis for everything in flight": the sender's
   * budget was meant to cover delivery work, not paused wall clock, so the
   * frozen interval is added back rather than the deadline being recomputed
   * from scratch — which would let a long enough freeze grant unlimited time.
   */
  rebase(deadlineAt: number, observation: TimeJumpObservation): number {
    return observation.jumped ? deadlineAt + observation.gapMs : deadlineAt
  }
}
