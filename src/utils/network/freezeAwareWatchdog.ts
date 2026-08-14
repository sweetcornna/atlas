// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { TimeJumpGate } from '@qianmo/protocol'

interface FreezeAwareWatchdogOptions {
  readonly timeoutMs: number
  readonly onTimeout: () => void
  readonly now?: () => number
  readonly cadenceMs?: number
  readonly schedule?: (
    delayMs: number,
    callback: () => void,
  ) => { cancel(): void }
}

const DEFAULT_CADENCE_MS = 10_000

function scheduleTimer(
  delayMs: number,
  callback: () => void,
): { cancel(): void } {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

export class FreezeAwareWatchdog {
  readonly #options: FreezeAwareWatchdogOptions
  readonly #now: () => number
  readonly #cadenceMs: number
  readonly #timeoutMs: number
  readonly #gate: TimeJumpGate
  #deadlineAt = 0
  #timer: { cancel(): void } | null = null
  #running = false

  constructor(options: FreezeAwareWatchdogOptions) {
    if (!Number.isFinite(options.timeoutMs)) {
      throw new RangeError(`timeoutMs must be finite, got ${options.timeoutMs}`)
    }
    // A non-positive timeout is a misconfiguration (`CLAUDE_STREAM_IDLE_TIMEOUT_MS=-1`
    // survives `parseInt` untouched), and the thing it replaced — `setTimeout`
    // with a negative delay — fired at once and produced the proper timeout
    // error. Throwing from inside a stream reader instead would escape that
    // classification and kill the request, so clamp rather than throw.
    this.#timeoutMs = Math.max(1, options.timeoutMs)
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#cadenceMs = Math.min(
      options.cadenceMs ?? DEFAULT_CADENCE_MS,
      this.#timeoutMs,
    )
    this.#gate = new TimeJumpGate({ periodMs: this.#cadenceMs })
  }

  reset(): void {
    const now = this.#now()
    this.#gate.observe(now)
    this.#deadlineAt = now + this.#timeoutMs
    this.#running = true
    this.#schedule()
  }

  stop(): void {
    this.#running = false
    this.#timer?.cancel()
    this.#timer = null
  }

  #schedule(): void {
    this.#timer?.cancel()
    if (!this.#running) return
    const now = this.#now()
    const remaining = Math.max(0, this.#deadlineAt - now)
    const delay =
      remaining === 0 ? this.#cadenceMs : Math.min(this.#cadenceMs, remaining)
    const schedule = this.#options.schedule ?? scheduleTimer
    this.#timer = schedule(delay, () => {
      this.#timer = null
      this.#tick()
    })
  }

  #tick(): void {
    if (!this.#running) return
    const now = this.#now()
    const observation = this.#gate.observe(now)
    this.#deadlineAt = this.#gate.rebase(this.#deadlineAt, observation)
    if (this.#gate.expired(this.#deadlineAt, now)) {
      this.stop()
      this.#options.onTimeout()
      return
    }
    this.#schedule()
  }
}
