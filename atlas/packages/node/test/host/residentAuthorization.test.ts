// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'bun:test'
import { approvalWaitBudget } from '../../src/host/residentAuthorization.js'

test('approval wait preserves ten seconds of watchdog and respects task TTL', () => {
  expect(approvalWaitBudget(120_000, 120_000)).toBe(60_000)
  expect(approvalWaitBudget(120_000, 40_000)).toBe(30_000)
  expect(approvalWaitBudget(5_000, 40_000)).toBe(5_000)
  expect(approvalWaitBudget(120_000, 9_999)).toBe(0)
  expect(approvalWaitBudget(-1, 120_000)).toBe(0)
})
