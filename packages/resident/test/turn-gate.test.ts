// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { describe, expect, test } from 'bun:test'
import { LIMITS } from '@qianmo/protocol'
import {
  NodeTurnExpiredError,
  NodeTurnGate,
  NodeTurnQueueFullError,
} from '../src/turn-gate.js'

describe('node turn gate', () => {
  test('serializes turns across different sessions in arrival order', async () => {
    const gate = new NodeTurnGate()
    const events: string[] = []
    let releaseFirst!: () => void

    const first = gate.run(async () => {
      events.push('a:start')
      await new Promise<void>(resolve => {
        releaseFirst = resolve
      })
      events.push('a:end')
    })
    const second = gate.run(async () => {
      events.push('b:start')
      events.push('b:end')
    })

    await Promise.resolve()
    expect(events).toEqual(['a:start'])
    expect(gate.active).toBe(true)
    expect(gate.queued).toBe(1)

    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
    expect(gate.active).toBe(false)
  })

  test('a failed turn still releases the next one', async () => {
    const gate = new NodeTurnGate()
    const first = gate.run(async () => {
      throw new Error('turn failed')
    })
    const second = gate.run(async () => 'next')

    await expect(first).rejects.toThrow('turn failed')
    await expect(second).resolves.toBe('next')
  })

  test('refuses at the queue bound instead of growing without one', async () => {
    const gate = new NodeTurnGate()
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const ran: number[] = []
    const depths: number[] = []

    // One running turn, then a queue filled to exactly the bound behind it.
    const runs = [gate.run(async () => await held)]
    depths.push(gate.queued)
    for (let index = 0; index < LIMITS.maxQueuedTurns; index++) {
      runs.push(
        gate.run(async () => {
          ran.push(index)
        }),
      )
      depths.push(gate.queued)
    }

    expect(depths).toEqual([
      0,
      ...Array.from({ length: LIMITS.maxQueuedTurns }, (_, i) => i + 1),
    ])
    expect(gate.saturated).toBe(true)

    let extraRan = false
    const refused = gate.run(async () => {
      extraRan = true
    })
    await expect(refused).rejects.toBeInstanceOf(NodeTurnQueueFullError)
    // The bound is the protocol's number, read from the one place it is
    // written down — not a copy kept in step by hand.
    await expect(refused).rejects.toThrow(String(LIMITS.maxQueuedTurns))
    expect(extraRan).toBe(false)
    expect(gate.queued).toBe(LIMITS.maxQueuedTurns)

    release()
    await Promise.all(runs)
    expect(ran).toHaveLength(LIMITS.maxQueuedTurns)
    expect(gate.saturated).toBe(false)
  })

  test('drops a queued turn past its deadline without ever running it', async () => {
    const gate = new NodeTurnGate()
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const first = gate.run(async () => await held)

    // The spy is the whole assertion: not "it finished quickly" — it never
    // started. A node that has already answered E_TASK_TIMEOUT must not spend
    // a turn on the task afterwards.
    let expiredRan = 0
    const expired = gate.run(
      async () => {
        expiredRan += 1
      },
      { deadlineAt: Date.now() - 1, sessionId: 'session-expired' },
    )
    let liveRan = 0
    const live = gate.run(
      async () => {
        liveRan += 1
      },
      { deadlineAt: Date.now() + 60_000, sessionId: 'session-live' },
    )

    expect(gate.queued).toBe(2)
    release()

    await expect(expired).rejects.toBeInstanceOf(NodeTurnExpiredError)
    await expect(expired).rejects.toThrow('session-expired')
    await Promise.all([first, live])
    expect(expiredRan).toBe(0)
    expect(liveRan).toBe(1)
  })

  test('an expiry that passes while a turn is waiting is caught at the head', async () => {
    const gate = new NodeTurnGate()
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const first = gate.run(async () => await held)

    // Alive at enqueue, dead by the time its slot comes up: the deadline is
    // read at the head of the queue, which is the only place it can be read
    // and still mean anything.
    let ran = 0
    const queued = gate.run(
      async () => {
        ran += 1
      },
      { deadlineAt: Date.now() + 30, sessionId: 'session-slow' },
    )
    await new Promise(resolve => setTimeout(resolve, 45))
    release()

    await expect(queued).rejects.toBeInstanceOf(NodeTurnExpiredError)
    await first
    expect(ran).toBe(0)
  })
})
