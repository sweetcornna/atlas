// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * How long a turn may produce **nothing at all** before it is failed early.
 *
 * Two minutes, chosen against `LIMITS.defaultTaskTtlMs` (five minutes): the
 * point of B10 is to fail *earlier* than the wall clock, and a watchdog set at
 * or above the default task deadline would never be the one to fire.
 *
 * Silence here means silence: every `session/update` counts, including
 * `agent_thought_chunk`, so a model that spends two minutes thinking out loud
 * keeps resetting it. What trips it is an ACP side that has stopped speaking.
 */
export const DEFAULT_RESIDENT_INACTIVITY_MS = 120_000

/**
 * A turn was failed because its ACP side went silent, not because it failed.
 *
 * The distinction is the whole deliverable: `reason` has to say "inactivity"
 * so the sender can tell this apart from a refusal or a crash and act on it —
 * the correct action being a retry with a longer `taskTtlMs`, which is a thing
 * only the sender may decide (design §3.B10: the wall clock belongs to the
 * sender and a node has no business quietly extending it).
 */
export class ResidentInactivityError extends Error {
  readonly sessionId: string
  readonly messageId: string
  readonly idleMs: number

  constructor(sessionId: string, messageId: string, idleMs: number) {
    super(
      `resident ACP turn ${messageId} produced no activity for ${idleMs}ms and was failed for inactivity; the task deadline itself has not expired, so retrying with a longer taskTtlMs is the sender's call`,
    )
    this.name = 'ResidentInactivityError'
    this.sessionId = sessionId
    this.messageId = messageId
    this.idleMs = idleMs
  }
}

export interface ResidentInactivityTurn {
  readonly sessionId: string
  readonly messageId: string
}

export interface ResidentInactivityOptions {
  /** `0` or negative disables the watchdog entirely. */
  readonly timeoutMs?: number
  readonly schedule?: (
    delayMs: number,
    callback: () => void,
  ) => { cancel(): void }
  /**
   * Called once, on expiry, before the guarded promise rejects.
   *
   * This is where a caller asks the ACP side to stop — see the class comment
   * for why the watchdog itself does not know how.
   */
  readonly onExpired?: (turn: ResidentInactivityTurn) => void
}

function defaultSchedule(
  delayMs: number,
  callback: () => void,
): { cancel(): void } {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

interface ArmedTurn {
  readonly turn: ResidentInactivityTurn
  timer: { cancel(): void } | null
  settled: boolean
  fire: () => void
}

/**
 * Inactivity-based early failure for a running turn (design §3.B10, hermes B10).
 *
 * hermes uses an inactivity timeout to *replace* a wall clock, so long jobs are
 * not killed. Atlas runs it in the opposite direction: the wall clock is
 * `taskTtlMs`, it belongs to the sender, and the node may not extend it — so
 * this watchdog only ever makes a turn fail **sooner**, and it exists to turn a
 * five-minute silence into a diagnosable answer instead of a bare timeout.
 *
 * ## What this mechanism deliberately does not do
 *
 * - **It does not extend anything.** There is no path here that makes a turn
 *   live longer than `taskTtlMs`. A node that quietly renewed a deadline the
 *   sender set would make every sender's timeout estimate a fiction.
 * - **It does not know what ACP is.** Expiry calls {@link
 *   ResidentInactivityOptions.onExpired} and rejects; asking the agent to stop
 *   is the caller's job, because "how to cancel" is a property of the transport
 *   this package is deliberately not coupled to.
 * - **It cannot un-run work already dispatched.** Rejecting the guarded promise
 *   frees the node's turn gate; the ACP side keeps going until it honours the
 *   cancel. That residual window is the same one every mid-flight turn failure
 *   already has (an ACP protocol error rejects the prompt while the agent keeps
 *   working), so it introduces no new shape — but it is real, and the cancel is
 *   sent precisely to keep it short.
 * - **It writes nothing to disk**, so it is the one member of the reliability
 *   kit with no fail-open story to tell: there is nothing that can fail.
 */
export class ResidentInactivityWatchdog {
  readonly #timeoutMs: number
  readonly #schedule: (
    delayMs: number,
    callback: () => void,
  ) => { cancel(): void }
  readonly #onExpired: ((turn: ResidentInactivityTurn) => void) | undefined
  readonly #armed = new Map<string, ArmedTurn>()

  constructor(options: ResidentInactivityOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_RESIDENT_INACTIVITY_MS
    this.#schedule = options.schedule ?? defaultSchedule
    this.#onExpired = options.onExpired
  }

  get timeoutMs(): number {
    return this.#timeoutMs
  }

  /** Turns currently being watched. Observation only. */
  get watching(): number {
    return this.#armed.size
  }

  /**
   * Run `work` under the watchdog.
   *
   * Rejects with {@link ResidentInactivityError} if nothing calls
   * {@link touch} for this session within the timeout. Otherwise it is exactly
   * `work()`, including its rejection.
   */
  async guard<T>(
    turn: ResidentInactivityTurn,
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.#timeoutMs <= 0) return await work()

    let rejectIdle!: (error: unknown) => void
    const idle = new Promise<never>((_resolve, reject) => {
      rejectIdle = reject
    })
    // Attached up front: once the race settles on `work`, nothing else is
    // listening to this promise, and an unhandled rejection from a watchdog
    // would take the process down over an event that did not matter.
    idle.catch(() => {})

    const armed: ArmedTurn = {
      turn,
      timer: null,
      settled: false,
      fire: () => {
        if (armed.settled) return
        armed.settled = true
        try {
          this.#onExpired?.(turn)
        } catch {
          // Cancelling is best effort; the failure below is the deliverable.
        }
        rejectIdle(
          new ResidentInactivityError(
            turn.sessionId,
            turn.messageId,
            this.#timeoutMs,
          ),
        )
      },
    }
    const previous = this.#armed.get(turn.sessionId)
    this.#armed.set(turn.sessionId, armed)
    this.#rearm(armed)

    try {
      return await Promise.race([work(), idle])
    } finally {
      armed.settled = true
      armed.timer?.cancel()
      armed.timer = null
      if (this.#armed.get(turn.sessionId) === armed) {
        // Restoring rather than deleting: `guard` is not nested today (the node
        // turn gate serializes), and if that ever changes, dropping the outer
        // watch silently would be the worst possible way to find out.
        if (previous === undefined) this.#armed.delete(turn.sessionId)
        else this.#armed.set(turn.sessionId, previous)
      }
    }
  }

  /** Report activity on a session, restarting its countdown. */
  touch(sessionId: string): void {
    const armed = this.#armed.get(sessionId)
    if (armed === undefined || armed.settled) return
    this.#rearm(armed)
  }

  #rearm(armed: ArmedTurn): void {
    armed.timer?.cancel()
    armed.timer = this.#schedule(this.#timeoutMs, armed.fire)
  }
}
