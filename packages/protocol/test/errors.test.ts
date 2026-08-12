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
  'E_EVICTED',
  'E_UNDELIVERABLE',
  'E_PAYLOAD_UNAVAILABLE',
  'E_CAP_INVALID',
  'E_CAP_INSUFFICIENT',
  'E_BUDGET_EXHAUSTED',
] as const

describe('ProtocolErrorCode', () => {
  test('matches the §11 table exactly', () => {
    expect(Object.values(ProtocolErrorCode).sort()).toEqual(
      [...V0_1_CODES].sort(),
    )
  })

  test('every code is its own wire string', () => {
    for (const [key, value] of Object.entries(ProtocolErrorCode)) {
      expect(value).toBe(key)
    }
  })

  test('the seven v0.1 additions are present', () => {
    expect(ProtocolErrorCode.E_TASK_TIMEOUT).toBe('E_TASK_TIMEOUT')
    expect(ProtocolErrorCode.E_EVICTED).toBe('E_EVICTED')
    expect(ProtocolErrorCode.E_UNDELIVERABLE).toBe('E_UNDELIVERABLE')
    expect(ProtocolErrorCode.E_PAYLOAD_UNAVAILABLE).toBe(
      'E_PAYLOAD_UNAVAILABLE',
    )
    expect(ProtocolErrorCode.E_CAP_INVALID).toBe('E_CAP_INVALID')
    expect(ProtocolErrorCode.E_CAP_INSUFFICIENT).toBe('E_CAP_INSUFFICIENT')
    expect(ProtocolErrorCode.E_BUDGET_EXHAUSTED).toBe('E_BUDGET_EXHAUSTED')
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
