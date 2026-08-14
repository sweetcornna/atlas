// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { describe, expect, mock, test } from 'bun:test'
import { FreezeAwareWatchdog } from '../freezeAwareWatchdog.js'

class ManualScheduler {
  callback: (() => void) | null = null

  schedule = (_delayMs: number, callback: () => void): { cancel(): void } => {
    this.callback = callback
    return {
      cancel: () => {
        if (this.callback === callback) this.callback = null
      },
    }
  }

  fire(): void {
    const callback = this.callback
    this.callback = null
    callback?.()
  }
}

describe('freeze-aware watchdog', () => {
  test('ordinary elapsed time still fires the watchdog', () => {
    let now = 0
    const scheduler = new ManualScheduler()
    const onTimeout = mock(() => {})
    const watchdog = new FreezeAwareWatchdog({
      timeoutMs: 90_000,
      cadenceMs: 10_000,
      now: () => now,
      schedule: scheduler.schedule,
      onTimeout,
    })
    watchdog.reset()

    for (let elapsed = 10_000; elapsed <= 90_000; elapsed += 10_000) {
      now = elapsed
      scheduler.fire()
    }

    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  test.each([
    34_700, 97_000,
  ])('a %ims freeze rebases the idle deadline', freezeMs => {
    let now = 0
    const scheduler = new ManualScheduler()
    const onTimeout = mock(() => {})
    const watchdog = new FreezeAwareWatchdog({
      timeoutMs: 90_000,
      cadenceMs: 10_000,
      now: () => now,
      schedule: scheduler.schedule,
      onTimeout,
    })
    watchdog.reset()
    for (let elapsed = 10_000; elapsed <= 50_000; elapsed += 10_000) {
      now = elapsed
      scheduler.fire()
    }
    now += freezeMs
    scheduler.fire()

    expect(onTimeout).not.toHaveBeenCalled()

    while (now < 90_000 + freezeMs) {
      now = Math.min(now + 10_000, 90_000 + freezeMs)
      scheduler.fire()
    }
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  test('reset starts a fresh idle budget after thaw', () => {
    let now = 0
    const scheduler = new ManualScheduler()
    const onTimeout = mock(() => {})
    const watchdog = new FreezeAwareWatchdog({
      timeoutMs: 90_000,
      cadenceMs: 10_000,
      now: () => now,
      schedule: scheduler.schedule,
      onTimeout,
    })
    watchdog.reset()
    now = 97_000
    scheduler.fire()
    watchdog.reset()
    const resetAt = now
    while (now < resetAt + 89_999) {
      now = Math.min(now + 10_000, resetAt + 89_999)
      scheduler.fire()
    }

    expect(onTimeout).not.toHaveBeenCalled()
    now = resetAt + 90_000
    scheduler.fire()
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })
})
