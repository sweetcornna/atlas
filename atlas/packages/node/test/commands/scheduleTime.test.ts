// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import type { ScheduleWhen } from '@qianmo/console'
import { nextRunAt } from '../../src/commands/scheduleTime.js'

function next(
  when: ScheduleWhen,
  timezone: string,
  after: string,
): string | null {
  const value = nextRunAt(when, timezone, Date.parse(after))
  return value === null ? null : new Date(value).toISOString()
}

describe('wall-clock scheduling', () => {
  test('Shanghai crosses midnight and the year, and equality advances one day', () => {
    const when: ScheduleWhen = { kind: 'daily', time: '08:30' }
    expect(next(when, 'Asia/Shanghai', '2026-12-31T23:59:00+08:00')).toBe(
      '2027-01-01T00:30:00.000Z',
    )
    expect(next(when, 'Asia/Shanghai', '2027-01-01T08:30:00+08:00')).toBe(
      '2027-01-02T00:30:00.000Z',
    )
    expect(next(when, 'Asia/Shanghai', '2027-01-01T08:29:59.999+08:00')).toBe(
      '2027-01-01T00:30:00.000Z',
    )
  })

  test('weekly Monday/Sunday wraps across the week and year', () => {
    expect(
      next(
        { kind: 'weekly', days: [1], time: '00:00' },
        'Asia/Shanghai',
        '2026-12-28T00:00:00+08:00',
      ),
    ).toBe('2027-01-03T16:00:00.000Z')
    expect(
      next(
        { kind: 'weekly', days: [7, 1], time: '08:00' },
        'Asia/Shanghai',
        '2026-10-10T22:00:00Z',
      ),
    ).toBe('2026-10-11T00:00:00.000Z')
  })

  test('New York spring gap advances 02:30 to 03:00, not 03:30', () => {
    const when: ScheduleWhen = { kind: 'daily', time: '02:30' }
    expect(next(when, 'America/New_York', '2026-03-08T05:00:00Z')).toBe(
      '2026-03-08T07:00:00.000Z',
    )
    expect(next(when, 'America/New_York', '2026-03-08T07:00:00Z')).toBe(
      '2026-03-09T06:30:00.000Z',
    )
  })

  test('New York fall fold fires once; after the first occurrence it skips the second', () => {
    const when: ScheduleWhen = { kind: 'daily', time: '01:30' }
    expect(next(when, 'America/New_York', '2026-11-01T04:00:00Z')).toBe(
      '2026-11-01T05:30:00.000Z',
    )
    expect(next(when, 'America/New_York', '2026-11-01T05:30:00Z')).toBe(
      '2026-11-02T06:30:00.000Z',
    )
    expect(next(when, 'America/New_York', '2026-11-01T06:15:00Z')).toBe(
      '2026-11-02T06:30:00.000Z',
    )
  })

  test('London resolves both transitions using its own dates', () => {
    const when: ScheduleWhen = { kind: 'weekly', days: [7], time: '01:30' }
    expect(next(when, 'Europe/London', '2026-03-29T00:00:00Z')).toBe(
      '2026-03-29T01:00:00.000Z',
    )
    expect(next(when, 'Europe/London', '2026-10-25T00:00:00Z')).toBe(
      '2026-10-25T00:30:00.000Z',
    )
    expect(next(when, 'Europe/London', '2026-10-25T00:30:00Z')).toBe(
      '2026-11-01T01:30:00.000Z',
    )
  })

  test('intervals keep the creation anchor across elapsed slots, equality and timezone changes', () => {
    const anchorMs = Date.parse('2026-10-11T00:07:00Z')
    const when: ScheduleWhen = { kind: 'interval', everyMinutes: 15, anchorMs }
    expect(next(when, 'Asia/Shanghai', '2026-10-11T00:00:00Z')).toBe(
      '2026-10-11T00:22:00.000Z',
    )
    expect(next(when, 'America/New_York', '2026-10-11T00:22:00Z')).toBe(
      '2026-10-11T00:37:00.000Z',
    )
    expect(next(when, 'Europe/London', '2026-10-12T00:08:00Z')).toBe(
      '2026-10-12T00:22:00.000Z',
    )
  })

  test('rejects malformed time, days, intervals and unknown timezone', () => {
    const bad: ScheduleWhen[] = [
      { kind: 'daily', time: '8:00' },
      { kind: 'daily', time: '24:00' },
      { kind: 'daily', time: '12:60' },
      { kind: 'weekly', time: '08:00', days: [] },
      { kind: 'weekly', time: '08:00', days: [0] },
      { kind: 'weekly', time: '08:00', days: [8] },
      { kind: 'weekly', time: '08:00', days: [1, 1] },
      { kind: 'interval', everyMinutes: 14 },
      { kind: 'interval', everyMinutes: 15.5 },
    ]
    for (const when of bad)
      expect(() => nextRunAt(when, 'Asia/Shanghai', Date.now())).toThrow(
        RangeError,
      )
    expect(() =>
      nextRunAt({ kind: 'daily', time: '08:00' }, 'Mars/Olympus', Date.now()),
    ).toThrow(RangeError)
    expect(() =>
      nextRunAt({ kind: 'daily', time: '08:00' }, 'Asia/Shanghai', NaN),
    ).toThrow(RangeError)
  })
})
