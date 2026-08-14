// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { describe, expect, test } from 'bun:test'
import { buildAc3Report, type Ac3Observations } from './ac3-report-core.js'

/** What a clean AC-3 run looks like; each test spoils exactly one thing. */
function observations(
  overrides: {
    loop?: Partial<Ac3Observations['loop']>
    spiral?: Partial<Ac3Observations['spiral']>
    runtime?: Partial<Ac3Observations['runtime']>
    budget?: Partial<Ac3Observations['budget']>
  } = {},
): Ac3Observations {
  return {
    loop: {
      firstHopDelivered: true,
      bounceRejected: true,
      bounceHandlerSkipped: true,
      replyCode: 'E_LOOP',
      hopCountAtCut: 2,
      maxHops: 8,
      loopEvents: 1,
      traceChainMatches: true,
      hopPath: 'node-a -> node-b',
      loopKeyHandler: 'qianmo://node-a/planner',
      loopKeyTaskId: 'ac3-loop',
      ...overrides.loop,
    },
    spiral: {
      delivered: true,
      handler: 'qianmo://node-a/archivist',
      loopEvents: 0,
      ...overrides.spiral,
    },
    runtime: {
      capacity: 20,
      windowMs: 60_000,
      allowed: 20,
      refusedCode: 'E_RUNTIME_THROTTLED',
      refusedStayedLocal: true,
      otherTargetAllowed: true,
      noProtocolEvent: true,
      ...overrides.runtime,
    },
    budget: {
      perMinute: 600,
      accepted: 600,
      refusedCode: 'E_RATE_LIMITED',
      senderAgents: 31,
      noRuntimeEvent: true,
      ...overrides.budget,
    },
  }
}

describe('AC-3 report', () => {
  test('passes only when all ten judgements hold', () => {
    const report = buildAc3Report(observations())
    expect(report.pass).toBe(true)
    expect(Object.values(report.checks).filter(Boolean)).toHaveLength(10)
  })

  test('a cut that the hop backstop made does not count as first-revisit', () => {
    // The distinction the whole of D-2 rests on: both cut the message, only one
    // of them cuts it on the first revisit.
    const report = buildAc3Report(
      observations({ loop: { hopCountAtCut: 9, maxHops: 8 } }),
    )
    expect(report.checks.loopNotByHopBackstop).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('a cut with no audit event fails even though the message stopped', () => {
    const report = buildAc3Report(observations({ loop: { loopEvents: 0 } }))
    expect(report.checks.loopCutAtFirstRevisit).toBe(true)
    expect(report.checks.loopAuditEvent).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('an audit event missing the chain fails', () => {
    const report = buildAc3Report(
      observations({ loop: { traceChainMatches: false } }),
    )
    expect(report.checks.loopAuditCarriesChain).toBe(false)
  })

  test('a cut legitimate spiral fails the report', () => {
    // The reverse case is a judgement, not a footnote: node granularity would
    // pass every other check in this file.
    const report = buildAc3Report(
      observations({ spiral: { delivered: false, loopEvents: 1 } }),
    )
    expect(report.checks.spiralNotCut).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('a throttled message that still went out fails', () => {
    const report = buildAc3Report(
      observations({ runtime: { refusedStayedLocal: false } }),
    )
    expect(report.checks.runtimeThrottleStaysLocal).toBe(false)
  })

  test('a single sender agent cannot prove the budget counts nodes', () => {
    const report = buildAc3Report(observations({ budget: { senderAgents: 1 } }))
    expect(report.checks.protocolBudgetAtLimit).toBe(false)
  })

  test('one layer firing the other layer’s event fails', () => {
    expect(
      buildAc3Report(observations({ runtime: { noProtocolEvent: false } }))
        .checks.layersDoNotOverlap,
    ).toBe(false)
    expect(
      buildAc3Report(observations({ budget: { noRuntimeEvent: false } })).checks
        .layersDoNotOverlap,
    ).toBe(false)
  })
})
