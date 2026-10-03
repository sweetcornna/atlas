// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ResidentChildConnection {
  readonly closed: Promise<void>
  stop(): void | Promise<void>
}

export interface ResidentSupervisorOptions {
  readonly start: () => Promise<ResidentChildConnection>
  readonly initialBackoffMs?: number
  readonly maxBackoffMs?: number
  readonly stableAfterMs?: number
  readonly maxRapidFailures?: number
  readonly now?: () => number
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>
  readonly onError?: (error: unknown) => void
  readonly onParked?: (failures: number) => void
}

const DEFAULT_INITIAL_BACKOFF_MS = 2_000
const DEFAULT_MAX_BACKOFF_MS = 120_000
const DEFAULT_STABLE_AFTER_MS = 10_000
const DEFAULT_MAX_RAPID_FAILURES = 5

function defaultWait(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(resolve, delayMs)
    timer.unref?.()
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

export class ResidentSupervisor {
  readonly #options: ResidentSupervisorOptions
  readonly #controller = new AbortController()
  #running: Promise<void> | null = null
  #child: ResidentChildConnection | null = null
  #parked = false
  /** The generation now running was stopped by {@link recycle}. */
  #recycling = false

  constructor(options: ResidentSupervisorOptions) {
    this.#options = options
  }

  get parked(): boolean {
    return this.#parked
  }

  run(): Promise<void> {
    this.#running ??= this.#loop()
    return this.#running
  }

  stop(): void {
    if (this.#controller.signal.aborted) return
    this.#controller.abort(new Error('resident supervisor stopped'))
    this.#child?.stop()
  }

  /**
   * Stop the generation now running and let the loop start the next one
   * (design `providers-console-m1.md` §2.7: a new provider configuration is
   * only loaded by a new ACP child).
   *
   * The stop is planned, so it is not a failure: it does not count towards
   * parking, however short-lived the generation was, and the child's exit on
   * the way down is not reported through `onError`. A generation that lived
   * past `stableAfterMs` still resets the backoff exactly as a stable one
   * always has.
   *
   * Returns `false` when there is no generation to stop — the loop is between
   * generations, has parked, or was stopped. The caller decides what that
   * means; nothing is queued for later.
   *
   * `stop()` is called synchronously, the same way {@link stop} calls it, so
   * whatever a child does before its first `await` (the resident retires its
   * runtime there) has happened by the time this returns.
   */
  recycle(): boolean {
    if (this.#controller.signal.aborted || this.#parked) return false
    const child = this.#child
    if (child === null) return false
    this.#recycling = true
    const report = (error: unknown): void => {
      if (!this.#controller.signal.aborted) this.#options.onError?.(error)
    }
    try {
      void Promise.resolve(child.stop()).catch(report)
    } catch (error) {
      report(error)
    }
    return true
  }

  async #loop(): Promise<void> {
    const now = this.#options.now ?? Date.now
    const wait = this.#options.wait ?? defaultWait
    const initialBackoff =
      this.#options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS
    const maxBackoff = this.#options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
    const stableAfter = this.#options.stableAfterMs ?? DEFAULT_STABLE_AFTER_MS
    const maxRapidFailures =
      this.#options.maxRapidFailures ?? DEFAULT_MAX_RAPID_FAILURES
    let backoff = initialBackoff
    let rapidFailures = 0

    while (!this.#controller.signal.aborted) {
      const startedAt = now()
      this.#recycling = false
      try {
        this.#child = await this.#options.start()
        if (this.#controller.signal.aborted) {
          await this.#child.stop()
        } else {
          await this.#child.closed
        }
      } catch (error) {
        // A recycled child exits because it was told to; its exit status is
        // not news.
        if (!this.#controller.signal.aborted && !this.#recycling) {
          this.#options.onError?.(error)
        }
      } finally {
        try {
          await this.#child?.stop()
        } catch (error) {
          if (!this.#controller.signal.aborted) this.#options.onError?.(error)
        }
        this.#child = null
      }
      if (this.#controller.signal.aborted) return

      const duration = now() - startedAt
      if (this.#recycling) {
        // Planned: neither a rapid failure nor proof of a healthy child.
        if (duration >= stableAfter) {
          rapidFailures = 0
          backoff = initialBackoff
        }
      } else if (duration < stableAfter) {
        rapidFailures += 1
        if (rapidFailures >= maxRapidFailures) {
          this.#parked = true
          this.#options.onParked?.(rapidFailures)
          return
        }
      } else {
        rapidFailures = 0
        backoff = initialBackoff
      }

      try {
        await wait(backoff, this.#controller.signal)
      } catch {
        if (this.#controller.signal.aborted) return
        throw new Error('resident supervisor wait failed')
      }
      backoff = Math.min(backoff * 2, maxBackoff)
    }
  }
}
