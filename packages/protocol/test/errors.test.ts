// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { describe, expect, test } from 'bun:test'
import { ProtocolError, ProtocolErrorCode, issue } from '../src/index.js'

/** protocol.md §11 — the whole v0.1 code table, nothing more. */
const V0_1_CODES = [
  'E_BAD_ENVELOPE',
  'E_BAD_VERSION',
  'E_BAD_ADDRESS',
  'E_BAD_TYPE',
  'E_TOO_LARGE',
  'E_TTL_EXPIRED',
  'E_TOO_MANY_HOPS',
  'E_LOOP',
  'E_RATE_LIMITED',
  'E_UNKNOWN_AGENT',
  'E_TASK_TIMEOUT',
  'E_TASK_FAILED',
  'E_EVICTED',
  'E_UNDELIVERABLE',
  'E_PAYLOAD_UNAVAILABLE',
  'E_CAP_INVALID',
  'E_CAP_INSUFFICIENT',
  'E_BUDGET_EXHAUSTED',
  // §13, added by P5.2.
  'E_RESOURCE_REFUSED',
] as const

describe('ProtocolErrorCode', () => {
  test('matches the §11 table exactly — all 19, no extras', () => {
    expect((Object.values(ProtocolErrorCode) as string[]).sort()).toEqual(
      [...V0_1_CODES].sort(),
    )
    expect(Object.values(ProtocolErrorCode)).toHaveLength(19)
  })

  test('every code is its own wire string', () => {
    for (const [key, value] of Object.entries(ProtocolErrorCode)) {
      expect(String(value)).toBe(key)
    }
  })

  test('ProtocolError carries the first issue', () => {
    const error = new ProtocolError([
      issue(ProtocolErrorCode.E_TASK_TIMEOUT, 'taskTtlMs', 'task deadline'),
      issue(ProtocolErrorCode.E_EVICTED, '', 'evicted'),
    ])
    expect(error.code).toBe(ProtocolErrorCode.E_TASK_TIMEOUT)
    expect(error.field).toBe('taskTtlMs')
    expect(error.issues).toHaveLength(2)
  })
})
