// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

export interface ResidentPollerOptions {
  readonly poll: () => Promise<void>
  readonly intervalMs?: number
  readonly onError?: (error: unknown) => void
  readonly schedule?: (
    delayMs: number,
    callback: () => void,
  ) => { cancel(): void }
}

export const DEFAULT_RESIDENT_POLL_INTERVAL_MS = 500

function defaultSchedule(
  delayMs: number,
  callback: () => void,
): { cancel(): void } {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

export class ResidentPoller {
  readonly #options: ResidentPollerOptions
  #running = false
  #timer: { cancel(): void } | null = null

  constructor(options: ResidentPollerOptions) {
    this.#options = options
  }

  get running(): boolean {
    return this.#running
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#schedule(0)
  }

  stop(): void {
    this.#running = false
    this.#timer?.cancel()
    this.#timer = null
  }

  #schedule(delayMs: number): void {
    if (!this.#running) return
    const schedule = this.#options.schedule ?? defaultSchedule
    this.#timer = schedule(delayMs, () => {
      this.#timer = null
      void this.#tick()
    })
  }

  async #tick(): Promise<void> {
    try {
      await this.#options.poll()
    } catch (error) {
      this.#options.onError?.(error)
    } finally {
      this.#schedule(
        this.#options.intervalMs ?? DEFAULT_RESIDENT_POLL_INTERVAL_MS,
      )
    }
  }
}
