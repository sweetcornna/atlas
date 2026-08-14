// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { describe, expect, mock, test } from 'bun:test'
import { ResidentPoller } from '../src/poller.js'

describe('resident mailbox poller', () => {
  test('reschedules after each completed poll instead of replaying missed ticks', async () => {
    const callbacks: Array<() => void> = []
    const delays: number[] = []
    let release!: () => void
    const poll = mock(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        }),
    )
    const poller = new ResidentPoller({
      poll,
      intervalMs: 500,
      schedule: (delay, callback) => {
        delays.push(delay)
        callbacks.push(callback)
        return { cancel: () => {} }
      },
    })

    poller.start()
    callbacks.shift()?.()
    await Promise.resolve()
    expect(delays).toEqual([0])

    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(delays).toEqual([0, 500])
    poller.stop()
  })

  test('reports a poll failure and continues', async () => {
    const callbacks: Array<() => void> = []
    const onError = mock((_error: unknown) => {})
    const poller = new ResidentPoller({
      poll: async () => {
        throw new Error('mailbox unavailable')
      },
      onError,
      schedule: (_delay, callback) => {
        callbacks.push(callback)
        return { cancel: () => {} }
      },
    })

    poller.start()
    callbacks.shift()?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(callbacks).toHaveLength(1)
    poller.stop()
  })
})
