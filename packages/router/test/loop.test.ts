// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { describe, expect, test } from 'bun:test'
import {
  LIMITS,
  createAck,
  createTaskResult,
  deliveryExpiresAt,
} from '@qianmo/protocol'
import { LoopGuard, LoopVerdict } from '../src/index.js'
import { ARCHIVIST, PLANNER, REVIEWER, makeMessage } from './helpers.js'

const CLOCK = 1_000_000

describe('handler granularity — the D-2 key', () => {
  test('the same handler asked twice for one task is a loop', () => {
    const guard = new LoopGuard()
    const first = makeMessage({ createdAt: CLOCK, taskId: 't-1' })
    expect(guard.admit(first, CLOCK)).toBe(LoopVerdict.Fresh)

    // A different envelope — new msgId, new createdAt — carrying the same task
    // back to the same handler. Dedup cannot see this one: the sender is not
    // retransmitting, it is circling.
    const again = makeMessage({ createdAt: CLOCK + 10, taskId: 't-1' })
    expect(again.msgId).not.toBe(first.msgId)
    expect(guard.admit(again, CLOCK + 10)).toBe(LoopVerdict.Revisited)
  })

  test('the same node reached for a different handler is not a loop', () => {
    // The whole point of D-2. Node granularity would cut this, and RFC 3261
    // Appendix A records that design as a specification-level bug.
    const guard = new LoopGuard()
    const toReviewer = makeMessage({ createdAt: CLOCK, taskId: 't-2' })
    expect(guard.admit(toReviewer, CLOCK)).toBe(LoopVerdict.Fresh)

    const toArchivist = makeMessage({
      createdAt: CLOCK,
      taskId: 't-2',
      from: REVIEWER,
      to: ARCHIVIST,
    })
    expect(guard.admit(toArchivist, CLOCK)).toBe(LoopVerdict.Fresh)

    // And the second handler is itself protected from a revisit.
    expect(
      guard.admit(
        makeMessage({
          createdAt: CLOCK,
          taskId: 't-2',
          from: REVIEWER,
          to: ARCHIVIST,
        }),
        CLOCK,
      ),
    ).toBe(LoopVerdict.Revisited)
  })

  test('the same handler for a different task is not a loop', () => {
    const guard = new LoopGuard()
    expect(guard.admit(makeMessage({ createdAt: CLOCK, taskId: 'a' }), CLOCK)) //
      .toBe(LoopVerdict.Fresh)
    expect(guard.admit(makeMessage({ createdAt: CLOCK, taskId: 'b' }), CLOCK)) //
      .toBe(LoopVerdict.Fresh)
    expect(guard.size).toBe(2)
  })
})

describe('origin seeding — D-2s second defect', () => {
  test('a seeded origin catches A -> B -> A on the first return', () => {
    const guard = new LoopGuard()
    const request = makeMessage({ createdAt: CLOCK, taskId: 't-3' })
    // What `NodeRouter.outbound` does at the origin.
    guard.seed(request.from, request.taskId, deliveryExpiresAt(request))

    const returning = makeMessage({
      createdAt: CLOCK + 50,
      taskId: 't-3',
      from: REVIEWER,
      to: PLANNER,
    })
    expect(guard.admit(returning, CLOCK + 50)).toBe(LoopVerdict.Revisited)
  })

  test('without seeding the same return reads as fresh traffic', () => {
    // The defect, stated as a test so nobody removes the seeding call and
    // watches the suite stay green.
    const guard = new LoopGuard()
    const returning = makeMessage({
      createdAt: CLOCK,
      taskId: 't-4',
      from: REVIEWER,
      to: PLANNER,
    })
    expect(guard.admit(returning, CLOCK)).toBe(LoopVerdict.Fresh)
  })
})

describe('replies are never judged by the loop key', () => {
  test('ack and task.result to the seeded origin pass', () => {
    const guard = new LoopGuard()
    const request = makeMessage({ createdAt: CLOCK, taskId: 't-5' })
    guard.seed(request.from, request.taskId, deliveryExpiresAt(request))

    const ack = createAck(request, REVIEWER, CLOCK + 5)
    const result = createTaskResult(
      request,
      REVIEWER,
      { outcome: 'completed', content: 'done' },
      CLOCK + 6,
    )
    expect(ack.to).toBe(PLANNER)
    expect(ack.taskId).toBe(request.taskId)
    expect(guard.admit(ack, CLOCK + 5)).toBe(LoopVerdict.NotSubject)
    expect(guard.admit(result, CLOCK + 6)).toBe(LoopVerdict.NotSubject)
  })

  test('a reply is not recorded, so it cannot make a later request look like a loop', () => {
    const guard = new LoopGuard()
    const request = makeMessage({ createdAt: CLOCK, taskId: 't-6' })
    const ack = createAck(request, REVIEWER, CLOCK)
    guard.admit(ack, CLOCK)
    expect(guard.size).toBe(0)
  })
})

describe('the maxHops backstop behind the detector', () => {
  test('a hop list past the limit is refused even with an empty table', () => {
    const guard = new LoopGuard()
    const hops = Array.from({ length: LIMITS.maxHops + 1 }, (_, i) => `n-${i}`)
    const message = makeMessage({ createdAt: CLOCK, taskId: 't-7', hops })
    expect(guard.admit(message, CLOCK)).toBe(LoopVerdict.HopLimitExceeded)
    expect(guard.size).toBe(0)
  })

  test('exactly at the limit still passes — the backstop is not the detector', () => {
    const guard = new LoopGuard()
    const hops = Array.from({ length: LIMITS.maxHops }, (_, i) => `n-${i}`)
    expect(
      guard.admit(
        makeMessage({ createdAt: CLOCK, taskId: 't-8', hops }),
        CLOCK,
      ),
    ).toBe(LoopVerdict.Fresh)
  })
})

describe('expiry and bounds', () => {
  test('entries expire on the delivery deadline, not later', () => {
    const guard = new LoopGuard()
    const message = makeMessage({
      createdAt: CLOCK,
      taskId: 't-9',
      deliverTtlMs: 1_000,
    })
    expect(guard.admit(message, CLOCK)).toBe(LoopVerdict.Fresh)

    const later = makeMessage({
      createdAt: CLOCK + 2_000,
      taskId: 't-9',
      deliverTtlMs: 1_000,
    })
    // Past the first message's deadline the key is gone: a re-send of the same
    // task is a new attempt, not a circling one.
    expect(guard.admit(later, CLOCK + 2_000)).toBe(LoopVerdict.Fresh)
    expect(guard.size).toBe(1)
  })

  test('release drops every handler of one task', () => {
    const guard = new LoopGuard()
    guard.admit(makeMessage({ createdAt: CLOCK, taskId: 't-10' }), CLOCK)
    guard.admit(
      makeMessage({ createdAt: CLOCK, taskId: 't-10', to: ARCHIVIST }),
      CLOCK,
    )
    expect(guard.size).toBe(2)
    guard.release('t-10')
    expect(guard.size).toBe(0)
    expect(
      guard.admit(makeMessage({ createdAt: CLOCK, taskId: 't-10' }), CLOCK),
    ).toBe(LoopVerdict.Fresh)
  })

  test('capacity is enforced by dropping the soonest to expire', () => {
    const guard = new LoopGuard({ capacity: 2 })
    guard.seed(REVIEWER, 'short', CLOCK + 10)
    guard.seed(REVIEWER, 'medium', CLOCK + 1_000)
    guard.seed(REVIEWER, 'long', CLOCK + 10_000)
    expect(guard.size).toBe(2)
    // The one about to lapse anyway is the one that went.
    expect(
      guard.admit(
        makeMessage({ createdAt: CLOCK, taskId: 'long', to: REVIEWER }),
        CLOCK,
      ),
    ).toBe(LoopVerdict.Revisited)
  })

  test('a non-positive capacity is refused at construction', () => {
    expect(() => new LoopGuard({ capacity: 0 })).toThrow(RangeError)
  })
})
