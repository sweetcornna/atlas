// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The keepalive face: the heartbeat that keeps a resident node out of the
 * freezer.
 *
 * ## The counter-intuitive part, first
 *
 * The obvious way to keep a sandbox alive is to configure it never to stop.
 * **That is not a fix; it is a strictly worse failure mode**, and E3 measured
 * it:
 *
 *   - A process burning 100 % CPU inside the sandbox was frozen **110 s** after
 *     start, made **zero progress for the following 411 s**, and never came
 *     back on its own. The ledger read `frozen` the whole time.
 *   - The idle judgement is refreshed **only by API entry points**. It has no
 *     visibility into CPU or IO inside the container. Work done inside the
 *     sandbox is, to the freezer, indistinguishable from idleness.
 *   - Setting `stopAfterSeconds: null` does not save the process. It removes
 *     the *stop* transition while leaving the *freeze* transition in place, so
 *     the failure is promoted from "fell to stopped, cold-starts next time"
 *     to **"frozen mid-task, silently, forever"**. The system loses the ability
 *     to recover by restarting, which was the only recovery it had.
 *
 * So: the heartbeat has to come from **outside** the sandbox, has to reach the
 * **daemon API** (nothing done inside counts), and its period has to be
 * strictly under the freeze threshold with room for a miss. That is this file.
 * {@link assertResidencyPolicy} refuses the `stopAfterSeconds: null`
 * configuration outright, so the lesson survives the departure of everyone who
 * remembers it.
 *
 * ## Why this is the same component as the activator
 *
 * Both faces live host-side and both act on the sandbox's behalf against the
 * daemon API. Sharing one component means sharing one capability surface — and
 * that surface has no destructive verb in it (`capability.ts`). Splitting them
 * would mean two places where a destructive verb could be added, and only one
 * of them would be the one anybody audits. Note the type of `daemon` below:
 * this face is narrowed to `touch` alone and cannot even wake a sandbox.
 */

import { ActivatorEventType, type AuditLog } from './audit.js'
import type { SandboxDaemon } from './daemon.js'
import {
  type CancelTimer,
  type Clock,
  type Scheduler,
  TimeJumpGate,
  systemClock,
  timerScheduler,
} from './clock.js'

/**
 * The sandbox's own cooling configuration, as the daemon holds it.
 *
 * `null` means "this transition is disabled".
 */
export interface ResidencyPolicy {
  /** Seconds of idleness before the sandbox is frozen. */
  readonly freezeAfterSeconds: number | null
  /** Seconds of idleness before the sandbox is stopped. */
  readonly stopAfterSeconds: number | null
}

/** Rejected configuration, with the measurement that rejects it. */
export class ResidencyPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResidencyPolicyError'
  }
}

/**
 * Refuse a residency policy that E3 showed to be a trap.
 *
 * The single rule: **`stopAfterSeconds` may not be `null`.** Disabling the stop
 * transition looks like the safe choice and is the opposite of one — it deletes
 * the recoverable failure and leaves the unrecoverable one. If the freeze
 * transition is what you want gone, disable *that* (`freezeAfterSeconds: null`,
 * which forfeits the point of using a freezing sandbox at all) or run the
 * heartbeat in this file. Those are the two honest options; there is no third.
 */
export function assertResidencyPolicy(policy: ResidencyPolicy): void {
  if (policy.stopAfterSeconds === null) {
    throw new ResidencyPolicyError(
      'stopAfterSeconds: null is refused. E3 measured what it does: the freeze ' +
        'transition still fires (a 100%-CPU process was frozen at 110 s and made zero ' +
        'progress for 411 s), while the stop transition that would have let a restart ' +
        'recover the node is gone. It upgrades "fell to stopped, cold-start next time" ' +
        'into "frozen mid-task, silently, forever". Keep a finite stopAfterSeconds and ' +
        'run the keepalive heartbeat, or disable freezeAfterSeconds instead.',
    )
  }
  if (policy.stopAfterSeconds <= 0) {
    throw new ResidencyPolicyError(
      `stopAfterSeconds must be positive, got ${policy.stopAfterSeconds}`,
    )
  }
  if (policy.freezeAfterSeconds !== null) {
    if (policy.freezeAfterSeconds <= 0) {
      throw new ResidencyPolicyError(
        `freezeAfterSeconds must be positive or null, got ${policy.freezeAfterSeconds}`,
      )
    }
    if (policy.freezeAfterSeconds >= policy.stopAfterSeconds) {
      throw new ResidencyPolicyError(
        `freezeAfterSeconds (${policy.freezeAfterSeconds}s) must be below stopAfterSeconds ` +
          `(${policy.stopAfterSeconds}s); otherwise the sandbox stops before it ever freezes ` +
          'and the freeze threshold this heartbeat is sized against does not exist',
      )
    }
  }
}

/**
 * Fraction of the freeze threshold used as the default heartbeat period.
 *
 * A third, so two consecutive beats can fail before the threshold is even in
 * sight. A half would mean one lost beat puts the node one round-trip from a
 * silent freeze, and a lost beat is the expected case, not the exotic one.
 */
export const DEFAULT_PERIOD_RATIO = 1 / 3

/**
 * The largest period this file will accept relative to the freeze threshold.
 *
 * Above a half there is no room for a single retry, so the heartbeat would be
 * making a promise it cannot keep.
 */
export const MAX_PERIOD_RATIO = 0.5

/** Consecutive failures before the loop declares itself degraded. */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3

/** Floor on the post-failure retry delay, so a hard-down daemon is not a spin loop. */
export const MIN_RETRY_DELAY_MS = 50

/** The heartbeat period a policy implies, or `null` when none is needed. */
export function keepalivePeriodMs(
  policy: ResidencyPolicy,
  ratio: number = DEFAULT_PERIOD_RATIO,
): number | null {
  assertResidencyPolicy(policy)
  if (policy.freezeAfterSeconds === null) return null
  if (!(ratio > 0) || ratio > MAX_PERIOD_RATIO) {
    throw new ResidencyPolicyError(
      `period ratio must be in (0, ${MAX_PERIOD_RATIO}], got ${ratio}`,
    )
  }
  return Math.max(1, Math.floor(policy.freezeAfterSeconds * 1_000 * ratio))
}

/** Why the loop gave up on being healthy. */
export interface KeepaliveDegraded {
  readonly sandboxId: string
  readonly consecutiveFailures: number
  /** Milliseconds since the last beat the daemon actually accepted. */
  readonly sinceLastSuccessMs: number
  readonly freezeAfterMs: number
  readonly at: number
}

/** Outcome of one beat. */
export interface KeepaliveBeat {
  readonly ok: boolean
  readonly at: number
  /** How long the loop intends to wait before the next beat. */
  readonly nextDelayMs: number
  readonly consecutiveFailures: number
  readonly timeJumpDetected: boolean
  readonly gapMs: number
  /** Present when `ok` is false. */
  readonly error?: string
}

/** Knobs of {@link KeepaliveLoop}. */
export interface KeepaliveOptions {
  readonly sandboxId: string
  /**
   * Narrowed to `touch` on purpose. The heartbeat cannot wake a sandbox, let
   * alone anything worse — the type says so and the allowlist enforces it.
   */
  readonly daemon: Pick<SandboxDaemon, 'touch'>
  readonly policy: ResidencyPolicy
  readonly audit: AuditLog
  readonly clock?: Clock
  readonly scheduler?: Scheduler
  /** Overrides the period derived from `policy`. Still bounded by MAX_PERIOD_RATIO. */
  readonly periodMs?: number
  readonly periodRatio?: number
  readonly maxConsecutiveFailures?: number
  readonly onDegraded?: (detail: KeepaliveDegraded) => void
  readonly graceMs?: number
}

/**
 * The heartbeat loop.
 *
 * Drive it with {@link start} in production, or call {@link beat} directly in a
 * test: the two share all of the logic, and `beat` returns the delay the loop
 * would have used, so the retry policy is checkable without waiting for it.
 */
export class KeepaliveLoop {
  readonly #sandboxId: string
  readonly #daemon: Pick<SandboxDaemon, 'touch'>
  readonly #audit: AuditLog
  readonly #clock: Clock
  readonly #scheduler: Scheduler
  readonly #periodMs: number
  readonly #freezeAfterMs: number
  readonly #maxFailures: number
  readonly #onDegraded: ((detail: KeepaliveDegraded) => void) | undefined
  readonly #gate: TimeJumpGate

  #running = false
  #cancel: CancelTimer | null = null
  #consecutiveFailures = 0
  #lastSuccessAt: number | null = null
  #beats = 0

  constructor(options: KeepaliveOptions) {
    assertResidencyPolicy(options.policy)
    if (options.policy.freezeAfterSeconds === null) {
      throw new ResidencyPolicyError(
        'this sandbox never freezes, so a keepalive loop would only add load; ' +
          'call keepalivePeriodMs() and skip the loop when it returns null',
      )
    }
    this.#freezeAfterMs = options.policy.freezeAfterSeconds * 1_000

    const derived = keepalivePeriodMs(options.policy, options.periodRatio)
    // `derived` cannot be null here: freezeAfterSeconds was checked above.
    const period = options.periodMs ?? derived ?? 0
    if (!(period > 0)) {
      throw new ResidencyPolicyError(
        `keepalive period must be positive, got ${period}`,
      )
    }
    if (period > this.#freezeAfterMs * MAX_PERIOD_RATIO) {
      throw new ResidencyPolicyError(
        `keepalive period ${period}ms is not safely under the freeze threshold ` +
          `${this.#freezeAfterMs}ms; it must be at most ${MAX_PERIOD_RATIO} of it so a ` +
          'single failed beat still leaves time to retry before the sandbox freezes',
      )
    }
    this.#periodMs = period

    this.#sandboxId = options.sandboxId
    this.#daemon = options.daemon
    this.#audit = options.audit
    this.#clock = options.clock ?? systemClock
    this.#scheduler = options.scheduler ?? timerScheduler
    this.#maxFailures =
      options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES
    this.#onDegraded = options.onDegraded
    this.#gate = new TimeJumpGate({
      periodMs: period,
      ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
    })
  }

  /** The interval between healthy beats. */
  get periodMs(): number {
    return this.#periodMs
  }

  /** The freeze threshold this loop is sized against. */
  get freezeAfterMs(): number {
    return this.#freezeAfterMs
  }

  /** Beats attempted since construction. */
  get beatCount(): number {
    return this.#beats
  }

  get running(): boolean {
    return this.#running
  }

  /** Beat now, then keep beating. Idempotent. */
  start(): void {
    if (this.#running) return
    this.#running = true
    this.#schedule(0)
  }

  /** Stop beating. Idempotent, and safe to call from inside a beat. */
  stop(): void {
    this.#running = false
    this.#cancel?.()
    this.#cancel = null
  }

  #schedule(delayMs: number): void {
    if (!this.#running) return
    this.#cancel = this.#scheduler.after(delayMs, () => {
      void this.beat().then(result => {
        this.#schedule(result.nextDelayMs)
      })
    })
  }

  /**
   * One beat: observe the clock, touch the daemon, decide when to come back.
   *
   * Never rejects. A heartbeat that can throw is a heartbeat that stops beating
   * the first time the network hiccups, which is precisely the failure it
   * exists to prevent.
   */
  async beat(): Promise<KeepaliveBeat> {
    const at = this.#clock.now()
    this.#beats += 1

    const observation = this.#gate.observe(at)
    if (observation.jumped) {
      // We were frozen. The idle timer on the daemon side was reset by whatever
      // thawed us, but our own notion of "recently touched" is stale by exactly
      // the frozen interval, so it is rebased rather than believed.
      this.#audit.record(ActivatorEventType.TimeJumpDetected, at, {
        sandboxId: this.#sandboxId,
        gapMs: observation.gapMs,
        thresholdMs: this.#gate.thresholdMs,
        face: 'keepalive',
      })
      if (this.#lastSuccessAt !== null) {
        this.#lastSuccessAt = this.#gate.rebase(
          this.#lastSuccessAt,
          observation,
        )
      }
      this.#consecutiveFailures = 0
    }

    try {
      await this.#daemon.touch(this.#sandboxId)
      this.#consecutiveFailures = 0
      this.#lastSuccessAt = at
      this.#audit.record(ActivatorEventType.KeepaliveTick, at, {
        sandboxId: this.#sandboxId,
        periodMs: this.#periodMs,
      })
      return {
        ok: true,
        at,
        nextDelayMs: this.#periodMs,
        consecutiveFailures: 0,
        timeJumpDetected: observation.jumped,
        gapMs: observation.gapMs,
      }
    } catch (error) {
      this.#consecutiveFailures += 1
      const reason = error instanceof Error ? error.message : String(error)
      this.#audit.record(ActivatorEventType.KeepaliveTickFailed, at, {
        sandboxId: this.#sandboxId,
        consecutiveFailures: this.#consecutiveFailures,
        reason,
      })
      const nextDelayMs = this.#retryDelay(at)
      if (this.#consecutiveFailures >= this.#maxFailures) this.#degrade(at)
      return {
        ok: false,
        at,
        nextDelayMs,
        consecutiveFailures: this.#consecutiveFailures,
        timeJumpDetected: observation.jumped,
        gapMs: observation.gapMs,
        error: reason,
      }
    }
  }

  /**
   * How long to wait after a failed beat.
   *
   * **Backwards from ordinary backoff, and deliberately so.** Retrying later
   * after a failure is the right instinct when the cost of retrying is load on
   * a struggling peer. Here the cost of *not* retrying is a silent freeze with
   * no self-recovery, so a failure always brings the next attempt *forward*:
   * half a period at most, and half of whatever freeze budget is left once that
   * is the tighter of the two. Floored at 50 ms so a hard-down daemon cannot
   * turn into a spin loop.
   */
  #retryDelay(now: number): number {
    const since =
      this.#lastSuccessAt === null
        ? this.#freezeAfterMs
        : now - this.#lastSuccessAt
    const remaining = this.#freezeAfterMs - since
    if (remaining <= 0) return MIN_RETRY_DELAY_MS
    return Math.max(
      MIN_RETRY_DELAY_MS,
      Math.min(Math.floor(this.#periodMs / 2), Math.floor(remaining / 2)),
    )
  }

  #degrade(at: number): void {
    const detail: KeepaliveDegraded = {
      sandboxId: this.#sandboxId,
      consecutiveFailures: this.#consecutiveFailures,
      sinceLastSuccessMs:
        this.#lastSuccessAt === null ? -1 : at - this.#lastSuccessAt,
      freezeAfterMs: this.#freezeAfterMs,
      at,
    }
    this.#audit.record(ActivatorEventType.KeepaliveDegraded, at, {
      sandboxId: detail.sandboxId,
      consecutiveFailures: detail.consecutiveFailures,
      sinceLastSuccessMs: detail.sinceLastSuccessMs,
    })
    this.#onDegraded?.(detail)
  }
}
