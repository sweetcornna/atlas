// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import {
  AuditSource,
  buildAuthorizationReport,
  queryTrail,
  type AuditRecord,
} from '../src/index.js'

function event(
  kind: string,
  at: number,
  detail: AuditRecord['detail'] = {},
  node = 'node-a',
): AuditRecord {
  return {
    seq: at,
    at,
    source: AuditSource.Capability,
    kind: `authz.${kind}`,
    node,
    outcome: 'ok',
    prev: '0'.repeat(64),
    detail: { requestId: 'req-1', ...detail },
  }
}

test('authorization lifecycle, refusal counts and action join preserve distinct HTTP IDs', () => {
  const report = buildAuthorizationReport(
    [
      event('requested', 100, {
        agent: 'worker',
        contextId: 'ctx-1',
        tool: 'bash',
        digest: 'abcdef0123456789',
        rawInput: 'secret',
      }),
      event('decision', 130, {
        status: 'approved',
        approver: 'u:123',
        scope: 'once',
        expiresAt: 500,
      }),
      event('grant_used', 140),
      event('refused', 150, { reason: 'replay' }),
    ],
    [
      {
        at: 130,
        requestId: 'http-1',
        target: 'req-1',
        subject: 'u:123',
        action: 'approval.decide',
        outcome: 'ok',
      },
    ],
  )
  expect(report.rows[0]).toMatchObject({
    requestId: 'req-1',
    node: 'node-a',
    digest: 'abcdef012345',
    status: 'used',
    decisionLatencyMs: 30,
    usedAt: 140,
    refusals: 1,
    actions: [{ requestId: 'http-1', target: 'req-1' }],
  })
  expect(report.summary).toEqual([
    { node: 'node-a', requests: 1, used: 1, pending: 0, refused: 1 },
  ])
  expect(JSON.stringify(report)).not.toContain('secret')
})

test('ambiguous request IDs do not join accounts across nodes; posture is a whitelist', () => {
  const report = buildAuthorizationReport(
    [
      event('requested', 1),
      event('requested', 2, {}, 'node-b'),
      event('posture', 3, {
        safeMode: true,
        policy: 'guarded',
        secret: 'must-not-leak',
      }),
    ],
    [
      {
        at: 2,
        requestId: 'http',
        subject: 'u:1',
        target: 'req-1',
        action: 'approval.decide',
        outcome: 'ok',
      },
    ],
  )
  expect(report.rows).toHaveLength(2)
  expect(report.rows.every(row => row.actions.length === 0)).toBe(true)
  expect(report.postures).toEqual([
    { node: 'node-a', at: 3, safeMode: true, policy: 'guarded' },
  ])
})

test('source, outcome and kind filters combine rather than override', () => {
  const records = [
    event('requested', 1),
    { ...event('refused', 2), outcome: 'refused' as const },
    { ...event('refused', 3), source: AuditSource.Router },
  ]
  expect(
    queryTrail(records, {
      source: AuditSource.Capability,
      outcome: 'refused',
      kind: 'authz.ref',
    }).map(row => row.seq),
  ).toEqual([2])
  expect(queryTrail(records, { kind: 'not-present' })).toEqual([])
})
