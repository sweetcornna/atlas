// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ScheduleWhen } from '@qianmo/console'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timezone: string): Intl.DateTimeFormat {
  if (typeof timezone !== 'string' || timezone.trim() === '')
    throw new RangeError('时区必须是 Intl 能识别的 IANA 名称')
  let value = formatters.get(timezone)
  if (!value) {
    value = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formatters.set(timezone, value)
  }
  return value
}

/** Represent wall-clock fields as UTC solely for calendar arithmetic. */
function wallAt(at: number, fmt: Intl.DateTimeFormat): number {
  const fields: Record<string, number> = {}
  for (const part of fmt.formatToParts(at)) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value)
  }
  const date = new Date(0)
  date.setUTCFullYear(fields.year!, fields.month! - 1, fields.day!)
  date.setUTCHours(fields.hour!, fields.minute!, fields.second!, 0)
  return date.getTime()
}

export function validateScheduleWhen(
  when: ScheduleWhen,
  timezone: string,
): void {
  formatter(timezone)
  if (!when || typeof when !== 'object') throw new RangeError('时间规则无效')
  if (when.kind === 'interval') {
    if (
      !Number.isSafeInteger(when.everyMinutes) ||
      when.everyMinutes < 15 ||
      when.everyMinutes * MINUTE > Number.MAX_SAFE_INTEGER
    )
      throw new RangeError('间隔必须是至少 15 分钟的整数')
    if (when.anchorMs !== undefined && !Number.isFinite(when.anchorMs))
      throw new RangeError('间隔锚点无效')
    return
  }
  if (when.kind !== 'daily' && when.kind !== 'weekly')
    throw new RangeError('时间规则必须是 daily、weekly 或 interval')
  if (
    typeof when.time !== 'string' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(when.time)
  )
    throw new RangeError('时间必须为 HH:MM（00:00–23:59）')
  if (
    when.kind === 'weekly' &&
    (!Array.isArray(when.days) ||
      !when.days.length ||
      when.days.some(day => !Number.isInteger(day) || day < 1 || day > 7) ||
      new Set(when.days).size !== when.days.length)
  )
    throw new RangeError('星期必须是非空、不重复的 1–7（周一到周日）')
}

/** Resolve folds to their first occurrence, gaps to the first existing minute. */
function instantFor(wall: number, fmt: Intl.DateTimeFormat): number {
  const offsets = new Set<number>()
  // Sample both sides, including midnight transitions and whole-day gaps.
  for (let delta = -2 * DAY; delta <= 2 * DAY; delta += 6 * 60 * MINUTE) {
    const sample = wall + delta
    offsets.add(wallAt(sample, fmt) - sample)
  }
  const candidates = [...offsets]
    .map(offset => wall - offset)
    .sort((a, b) => a - b)
  const exact = candidates.find(candidate => wallAt(candidate, fmt) === wall)
  if (exact !== undefined) return exact
  for (
    let at = candidates[0]!;
    at <= candidates[candidates.length - 1]!;
    at += MINUTE
  ) {
    if (wallAt(at, fmt) >= wall) return at
  }
  throw new RangeError('无法解析本地时间')
}

/** Strictly after `after`, including on a repeated wall-clock minute. */
export function nextRunAt(
  when: ScheduleWhen,
  timezone: string,
  after: number,
): number | null {
  validateScheduleWhen(when, timezone)
  if (!Number.isFinite(after) || Number.isNaN(new Date(after).getTime()))
    throw new RangeError('after 必须是有效时间戳')
  if (when.kind === 'interval') {
    const step = when.everyMinutes * MINUTE
    const anchor = when.anchorMs ?? 0
    const next =
      anchor + Math.max(1, Math.floor((after - anchor) / step) + 1) * step
    return Number.isFinite(next) && !Number.isNaN(new Date(next).getTime())
      ? next
      : null
  }
  const fmt = formatter(timezone)
  const local = new Date(wallAt(after, fmt))
  local.setUTCHours(0, 0, 0, 0)
  const [hour, minute] = when.time.split(':').map(Number)
  for (let days = 0; days <= 8; days++) {
    const day = new Date(local.getTime() + days * DAY)
    if (when.kind === 'weekly' && !when.days.includes(day.getUTCDay() || 7))
      continue
    const wall = day.getTime() + hour! * 60 * MINUTE + minute! * MINUTE
    if (Number.isNaN(new Date(wall).getTime())) return null
    const next = instantFor(wall, fmt)
    if (next > after) return next
  }
  return null
}
