// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Reading a lane's error the way the P18.12 rule tables ask it: the error and
 * the objects it wraps (`error`, `cause`, `response`, `data`), its HTTP
 * status, and its string fields. The lanes throw several shapes for the same
 * failure — the OpenAI SDK's `APIError` (body under `error`),
 * `OpenAIRequestError` (body under `cause`), Gemini's own class — and the
 * tables should not care which.
 *
 * Same walk as `retryClassification.ts`'s private `collectErrorRecords`
 * (bounded at 16 records, cycle-safe); kept separate so the rule tables do
 * not widen that base module's exports.
 */

/** `error` and every object it wraps, outermost first. */
export function errorRecords(error: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  const pending: unknown[] = [error]
  const seen = new Set<object>()
  while (pending.length > 0 && records.length < 16) {
    const current = pending.shift()
    if (typeof current !== 'object' || current === null) continue
    if (seen.has(current)) continue
    seen.add(current)
    const record = current as Record<string, unknown>
    records.push(record)
    for (const key of ['error', 'cause', 'response', 'data']) {
      if (record[key] !== undefined) pending.push(record[key])
    }
  }
  return records
}

/** The first HTTP status any record states (`status`, `statusCode`, …). */
export function httpStatus(
  records: readonly Record<string, unknown>[],
): number | undefined {
  for (const record of records) {
    for (const key of ['status', 'statusCode', 'httpStatus']) {
      const value = record[key]
      const status =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && /^\d{3}$/.test(value)
            ? Number(value)
            : undefined
      if (status !== undefined && status >= 100 && status < 600) return status
    }
  }
  return undefined
}

/** Every string under `keys` in any record, lower-cased. */
export function lowerStrings(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
): string[] {
  return records.flatMap(record =>
    keys
      .map(key => record[key])
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.toLowerCase()),
  )
}
