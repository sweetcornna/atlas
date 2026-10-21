// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The group rules every platform shares (`src/channels/gate.ts`), rewritten
 * from grantley's router (`test_hermes_router.py`: keywords, cooldown) and
 * its speech cap.
 */

import { describe, expect, test } from 'bun:test'
import {
  defaultGroupGate,
  matchesKeyword,
  RoomBudget,
} from '../../src/channels/gate.js'
import type { GroupPolicy } from '../../src/channels/types.js'
import { inbound } from './fakes.js'

const policy = (over: Partial<GroupPolicy> = {}): GroupPolicy => ({
  trigger: 'mention',
  freeGroups: [],
  keywords: [],
  followed: false,
  ...over,
})

describe('shared group rules (grantley router)', () => {
  test('keywords are case-insensitive substrings; empty words never match', () => {
    expect(matchesKeyword('hey AEMEATH', ['aemeath'])).toBe(true)
    expect(matchesKeyword('anything', [''])).toBe(false)
    expect(matchesKeyword('anything', [])).toBe(false)
  })

  test('the default gate: named is explicit; free rooms, `all`, followed threads and keywords are implicit', () => {
    const room = { chat: { type: 'group', id: 'g' } as const }
    expect(
      defaultGroupGate(inbound({ ...room, addressed: true }), policy()),
    ).toBe('explicit')
    expect(
      defaultGroupGate(inbound({ ...room, addressed: false }), policy()),
    ).toBeNull()
    for (const over of [
      { trigger: 'all' as const },
      { followed: true },
      { freeGroups: ['g'] },
      { keywords: ['你好'] },
    ])
      expect(
        defaultGroupGate(inbound({ ...room, addressed: false }), policy(over)),
      ).toBe('implicit')
  })

  test('cooldown: implicit replies wait it out, a summons passes and restarts it, per room', () => {
    let now = 0
    const budget = new RoomBudget(() => now)
    expect(budget.admit('a', 'implicit', 3_600_000)).toBe(true)
    now = 1_000
    expect(budget.admit('a', 'implicit', 3_600_000)).toBe(false)
    expect(budget.admit('a', 'explicit', 3_600_000)).toBe(true)
    expect(budget.admit('b', 'implicit', 3_600_000)).toBe(true)
    now = 3_601_000
    expect(budget.admit('a', 'implicit', 3_600_000)).toBe(true)
    expect(budget.admit('a', 'implicit', 0)).toBe(true)
  })

  test('speech cap: at most N in the trailing window; 0 turns it off', () => {
    let now = 0
    const budget = new RoomBudget(() => now)
    expect(budget.speak('a', 2, 60_000)).toBe(true)
    expect(budget.speak('a', 2, 60_000)).toBe(true)
    expect(budget.speak('a', 2, 60_000)).toBe(false)
    now = 60_000
    expect(budget.speak('a', 2, 60_000)).toBe(true)
    for (let i = 0; i < 10; i++) expect(budget.speak('b', 0, 60_000)).toBe(true)
  })
})
