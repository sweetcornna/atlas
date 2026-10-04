// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `pageTrail`: newest first, a cursor that neither repeats nor skips, and a
 * first screen whose cost does not grow with the trail.
 */

import { describe, expect, test } from 'bun:test'
import {
  AuditSource,
  pageTrail,
  queryTrail,
  type AuditRecord,
  type TrailQuery,
} from '../src/index.js'

const SOURCES = [
  AuditSource.Router,
  AuditSource.Transport,
  AuditSource.Resident,
]
const OUTCOMES = ['ok', 'refused', 'dropped'] as const

/** A deterministic trail of `count` records starting at `seq`. */
function records(count: number, start = 1): AuditRecord[] {
  const out: AuditRecord[] = []
  for (let index = 0; index < count; index++) {
    const seq = start + index
    out.push({
      seq,
      at: 1_800_000_000_000 + seq,
      source: SOURCES[seq % 3] ?? AuditSource.Router,
      kind: seq % 5 === 0 ? 'Message.Duplicate' : 'forwarded',
      traceId: `00-${String(seq % 11).padStart(32, '0')}-00f067aa0ba902b7-01`,
      taskId: `task-${seq % 13}`,
      node: `node-${seq % 4}`,
      outcome: OUTCOMES[seq % 3] ?? 'ok',
      ...(seq % 17 === 0 ? { detail: { job: `nightly-${seq}` } } : {}),
      prev: '0'.repeat(64),
    })
  }
  return out
}

/** Every page from the newest back, following `earlier`. */
function walk(
  trail: readonly AuditRecord[],
  query: TrailQuery,
  limit: number,
  ordered: boolean,
  onPage?: () => void,
): number[] {
  const seen: number[] = []
  let before: number | undefined
  for (let pages = 0; pages < 10_000; pages++) {
    const page = pageTrail(trail, query, {
      limit,
      ordered,
      ...(before === undefined ? {} : { before }),
    })
    expect(page.records.length).toBeLessThanOrEqual(limit)
    const seqs = page.records.map(record => record.seq)
    // Oldest first within the page.
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    seen.push(...seqs.reverse())
    onPage?.()
    if (page.earlier === null) return seen
    expect(page.earlier).toBe(page.records[0]?.seq ?? Number.NaN)
    before = page.earlier
  }
  throw new Error('the cursor never reached the oldest page')
}

const QUERIES: readonly TrailQuery[] = [
  {},
  { source: AuditSource.Transport },
  { outcome: 'refused' },
  { text: 'duplicate' },
  { text: 'NIGHTLY' },
  { agent: 'node-2', outcome: 'ok' },
  { traceId: `00-${'0'.repeat(31)}7-ffffffffffffffff-01` },
  { from: 1_800_000_000_100, to: 1_800_000_000_700 },
  { text: 'nothing-matches-this' },
]

describe('pageTrail', () => {
  for (const [index, query] of QUERIES.entries()) {
    for (const limit of [1, 7, 50]) {
      for (const ordered of [true, false]) {
        test(`query ${index}, ${limit} per page, ordered ${ordered}: every match once, newest first`, () => {
          const trail = records(900)
          const expected = queryTrail(trail, query)
            .map(record => record.seq)
            .reverse()
          expect(walk(trail, query, limit, ordered)).toEqual(expected)
        })
      }
    }
  }

  test('lines appended between pages do not shift the pages still to come', () => {
    const trail = records(300)
    const original = queryTrail(trail, { outcome: 'ok' })
      .map(record => record.seq)
      .reverse()
    let next = 301
    const seen = walk(trail, { outcome: 'ok' }, 20, true, () => {
      trail.push(...records(9, next))
      next += 9
    })
    // The first page was read before anything was appended, so the walk is
    // exactly the trail as it stood then.
    expect(seen).toEqual(original)
  })

  test('after: only what arrived since, the same ordered or not', () => {
    const trail = records(200)
    for (const ordered of [true, false]) {
      const page = pageTrail(trail, {}, { after: 195, limit: 50, ordered })
      expect(page.records.map(record => record.seq)).toEqual([
        196, 197, 198, 199, 200,
      ])
      expect(page.earlier).toBeNull()
      const crowded = pageTrail(trail, {}, { after: 100, limit: 50, ordered })
      expect(crowded.records).toHaveLength(50)
      // More arrived than one page holds: the caller is told there is a gap.
      expect(crowded.earlier).toBe(151)
    }
  })

  test('text matches any field, ignoring case', () => {
    const trail = records(60)
    expect(
      pageTrail(trail, { text: 'TASK-12' }, { limit: 100 }).records.map(
        record => record.seq,
      ),
    ).toEqual([12, 25, 38, 51])
    expect(
      pageTrail(trail, { text: 'nightly-34' }, { limit: 100 }).records.map(
        record => record.seq,
      ),
    ).toEqual([34])
    expect(
      pageTrail(trail, { text: 'resident' }, { limit: 100 }).records.every(
        record => record.source === AuditSource.Resident,
      ),
    ).toBe(true)
  })

  test('the first screen of 100 000 records touches limit + 1 of them; a deep page a few more', () => {
    const trail = records(100_000)
    let touched = 0
    const counted = new Proxy(trail, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) touched += 1
        return Reflect.get(target, key, receiver)
      },
    })
    const first = pageTrail(counted, {}, { limit: 50, ordered: true })
    expect(first.records).toHaveLength(50)
    expect(first.records.at(-1)?.seq).toBe(100_000)
    expect(first.earlier).toBe(99_951)
    expect(touched).toBe(51)

    touched = 0
    const deep = pageTrail(
      counted,
      {},
      {
        limit: 50,
        ordered: true,
        before: 1_234,
      },
    )
    expect(deep.records.at(-1)?.seq).toBe(1_233)
    // A binary search to the cursor, then the page.
    expect(touched).toBeLessThanOrEqual(51 + 18)

    // The control: without `ordered` the same deep page walks the whole tail.
    touched = 0
    pageTrail(counted, {}, { limit: 50, before: 1_234 })
    expect(touched).toBeGreaterThan(98_000)
  })
})
