// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { describe, expect, test } from 'bun:test'
import { LIMITS } from '@qianmo/protocol'
import {
  InboundBudget,
  RUNTIME_RATE,
  RuntimeThrottle,
  TokenBucket,
} from '../src/index.js'
import { ARCHIVIST, NODE_A, PLANNER, REVIEWER } from './helpers.js'

const CLOCK = 1_000_000

describe('runtime layer — one sender towards one target', () => {
  test('the 21st message in a minute is refused', () => {
    // Charter AC-3 ①, stated exactly as the criterion states it.
    const throttle = new RuntimeThrottle()
    for (let index = 0; index < RUNTIME_RATE.capacity; index += 1) {
      expect(throttle.admit(PLANNER, REVIEWER, CLOCK + index)).toBe(true)
    }
    expect(throttle.admit(PLANNER, REVIEWER, CLOCK + 20)).toBe(false)
    expect(RUNTIME_RATE.capacity).toBe(20)
    expect(RUNTIME_RATE.windowMs).toBe(60_000)
  })

  test('the budget is per target, not per sender', () => {
    const throttle = new RuntimeThrottle()
    for (let index = 0; index < RUNTIME_RATE.capacity; index += 1) {
      throttle.admit(PLANNER, REVIEWER, CLOCK)
    }
    expect(throttle.admit(PLANNER, REVIEWER, CLOCK)).toBe(false)
    // Same sender, different target: untouched allowance.
    expect(throttle.admit(PLANNER, ARCHIVIST, CLOCK)).toBe(true)
  })

  test('tokens come back continuously, not in a step at the window edge', () => {
    const throttle = new RuntimeThrottle()
    for (let index = 0; index < RUNTIME_RATE.capacity; index += 1) {
      throttle.admit(PLANNER, REVIEWER, CLOCK)
    }
    // A fixed window would still be refusing here and would then hand back the
    // whole allowance at once, letting a sender spend 40 across the boundary.
    const third = CLOCK + RUNTIME_RATE.windowMs / 3
    expect(throttle.remaining(PLANNER, REVIEWER, third)).toBeCloseTo(20 / 3, 5)
    expect(throttle.admit(PLANNER, REVIEWER, third)).toBe(true)
  })

  test('a full minute of silence restores the whole allowance', () => {
    const throttle = new RuntimeThrottle()
    for (let index = 0; index < RUNTIME_RATE.capacity; index += 1) {
      throttle.admit(PLANNER, REVIEWER, CLOCK)
    }
    const later = CLOCK + RUNTIME_RATE.windowMs
    expect(throttle.remaining(PLANNER, REVIEWER, later)).toBe(
      RUNTIME_RATE.capacity,
    )
  })

  test('the key table stays bounded under a spray of distinct targets', () => {
    const throttle = new RuntimeThrottle({ maxKeys: 8 })
    for (let index = 0; index < 200; index += 1) {
      throttle.admit(PLANNER, `qianmo://node-x/agent-${index}`, CLOCK + index)
    }
    expect(throttle.size).toBeLessThanOrEqual(8)
  })
})

describe('protocol layer — one receiving node, per sending node', () => {
  test('the ceiling is the protocol number, taken from LIMITS', () => {
    const budget = new InboundBudget()
    for (let index = 0; index < LIMITS.ratePerMinute; index += 1) {
      expect(budget.admit(PLANNER, CLOCK)).toBe(true)
    }
    expect(budget.admit(PLANNER, CLOCK)).toBe(false)
  })

  test('two agents on one node share that node’s budget', () => {
    // Otherwise a peer buys itself more allowance by naming more agents.
    const budget = new InboundBudget({ perMinute: 4 })
    expect(budget.admit('qianmo://node-a/planner', CLOCK)).toBe(true)
    expect(budget.admit('qianmo://node-a/archivist', CLOCK)).toBe(true)
    expect(budget.admit('qianmo://node-a/third', CLOCK)).toBe(true)
    expect(budget.admit('qianmo://node-a/fourth', CLOCK)).toBe(true)
    expect(budget.admit('qianmo://node-a/fifth', CLOCK)).toBe(false)
    // A different node is unaffected.
    expect(budget.admit('qianmo://node-b/reviewer', CLOCK)).toBe(true)
  })

  test('a burst that straddles 100 ms is handed one extra token', () => {
    // 600 per 60 s is one token every 100 ms, and the refill is continuous — so
    // how many messages a burst gets through depends on how long the burst
    // takes, not just on the ceiling. roadmap v2.34 writes it as `B·(1/T+1/60)`.
    //
    // Nobody had pinned that down as a test, and the AC-3 harness walked into
    // it: `demo/lib/ac3-loop-rate.ts` fired 601 messages on a real clock and
    // expected the 601st to be refused, which only holds while the burst fits
    // inside 100 ms. On a 2 vCPU box it does not (demo-env.md §7.5), one token
    // came back, and the harness read a healthy limiter as a failure. The
    // limiter is right; this test says what "right" means.
    const refillMs = 60_000 / LIMITS.ratePerMinute
    expect(refillMs).toBe(100)

    const budget = new InboundBudget()
    for (let index = 0; index < LIMITS.ratePerMinute; index += 1) {
      expect(budget.admit(PLANNER, CLOCK)).toBe(true)
    }
    // Same instant: the ceiling holds.
    expect(budget.admit(PLANNER, CLOCK)).toBe(false)
    // One millisecond short of the refill is still short.
    expect(budget.remaining(NODE_A, CLOCK + refillMs - 1)).toBeLessThan(1)
    expect(budget.admit(PLANNER, CLOCK + refillMs - 1)).toBe(false)
    // Across the line, exactly one more message gets in.
    expect(budget.remaining(NODE_A, CLOCK + refillMs)).toBeCloseTo(1, 5)
    expect(budget.admit(PLANNER, CLOCK + refillMs)).toBe(true)
    expect(budget.admit(PLANNER, CLOCK + refillMs)).toBe(false)
  })

  test('an unparseable sender is charged rather than waved through', () => {
    const budget = new InboundBudget({ perMinute: 1 })
    expect(budget.admit('not-an-address', CLOCK)).toBe(true)
    expect(budget.admit('not-an-address', CLOCK)).toBe(false)
  })
})

describe('the two layers are independent', () => {
  test('exhausting the runtime bucket leaves the inbound budget untouched', () => {
    const throttle = new RuntimeThrottle()
    const budget = new InboundBudget()
    for (let index = 0; index < 25; index += 1) {
      throttle.admit(PLANNER, REVIEWER, CLOCK)
    }
    expect(throttle.admit(PLANNER, REVIEWER, CLOCK)).toBe(false)
    expect(budget.remaining('node-a', CLOCK)).toBe(LIMITS.ratePerMinute)
    expect(budget.admit(PLANNER, CLOCK)).toBe(true)
  })

  test('the runtime ceiling is not a protocol number', () => {
    // CLAUDE.md §2.2 pins protocol-level numbers to `LIMITS`; protocol.md §6.4
    // puts the runtime layer outside that document. Both statements can only
    // stay true if this value is absent from `LIMITS`.
    expect(Object.values(LIMITS)).not.toContain(RUNTIME_RATE.capacity)
  })
})

describe('token bucket arithmetic', () => {
  test('a clock that goes backwards does not mint tokens', () => {
    const bucket = new TokenBucket(2, 1_000, CLOCK)
    expect(bucket.tryConsume(CLOCK)).toBe(true)
    expect(bucket.tryConsume(CLOCK)).toBe(true)
    expect(bucket.tryConsume(CLOCK - 10_000)).toBe(false)
  })

  test('a non-positive capacity or window is refused', () => {
    expect(() => new TokenBucket(0, 1_000, CLOCK)).toThrow(RangeError)
    expect(() => new TokenBucket(1, 0, CLOCK)).toThrow(RangeError)
  })
})
