// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The audit port's cursor (P18.11, D5): `before` pages back, `since` reads
 * what arrived, and a walk from the newest page to the oldest meets every
 * matching record exactly once — on a real trail file, through the real
 * `createAuditPort`, with lines appended while the walk is under way.
 *
 * The trails are written here line by line with the same digest the writer
 * uses (`@qianmo/audit`, `digestOf`): `AuditTrail` fsyncs per record, which
 * is right for a node and far too slow for a fixture of thousands.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AuditSource,
  GENESIS_PREVIOUS,
  TrailReader,
  digestOf,
  queryTrail,
  readTrail,
  type AuditInput,
  type AuditRecord,
  type TrailQuery,
} from '@qianmo/audit'
import type { AuditFilter, AuditPage } from '@qianmo/console'
import { createAuditPort } from '../consolePorts.js'

const roots: string[] = []

afterAll(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function trailPath(name = 'audit.ndjson'): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-audit-paging-'))
  roots.push(dir)
  return join(dir, name)
}

const SOURCES = [
  AuditSource.Transport,
  AuditSource.Router,
  AuditSource.Resident,
] as const
const OUTCOMES = ['ok', 'refused', 'dropped'] as const

/** The `index`-th record's content: deterministic, varied enough to filter on. */
function inputAt(index: number): AuditInput {
  return {
    at: 1_800_000_000_000 + index,
    source: SOURCES[index % SOURCES.length] ?? AuditSource.Router,
    kind: index % 7 === 0 ? 'Message.Duplicate' : 'forwarded',
    outcome: OUTCOMES[index % OUTCOMES.length] ?? 'ok',
    traceId: `00-${String(index % 13).padStart(32, '0')}-00f067aa0ba902b7-01`,
    taskId: `task-${index % 11}`,
    node: `node-${index % 4}`,
    ...(index % 19 === 0 ? { detail: { job: `nightly-${index}` } } : {}),
  }
}

/** Where a chain written by {@link writeChain} stands, to continue it. */
interface ChainEnd {
  readonly seq: number
  readonly prev: string
}

const START: ChainEnd = { seq: 0, prev: GENESIS_PREVIOUS }

/**
 * Append `count` chained records to `path`, continuing from `from`: the bytes
 * `AuditTrail.append` would have written, without an fsync per line.
 */
function writeChain(path: string, count: number, from: ChainEnd = START) {
  const lines: string[] = []
  let { seq, prev } = from
  for (let index = 0; index < count; index++) {
    const record: AuditRecord = { ...inputAt(seq), seq: seq + 1, prev }
    lines.push(JSON.stringify(record))
    seq = record.seq
    prev = digestOf(record)
  }
  const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`
  if (from === START) writeFileSync(path, text)
  else appendFileSync(path, text)
  return { seq, prev }
}

async function page(
  port: ReturnType<typeof createAuditPort>,
  filter: AuditFilter,
): Promise<AuditPage> {
  const result = await port.read(filter)
  if (!result.ok) throw new Error(result.failure.message)
  return result.value
}

/** The filters the walks run under, with the `TrailQuery` each one means. */
const FILTERS: readonly (readonly [AuditFilter, TrailQuery])[] = [
  [{}, {}],
  [{ outcome: 'refused' }, { outcome: 'refused' }],
  [{ source: AuditSource.Transport }, { source: AuditSource.Transport }],
  [{ q: 'duplicate' }, { text: 'duplicate' }],
  [{ q: 'NIGHTLY' }, { text: 'NIGHTLY' }],
  [
    { q: 'node-2', outcome: 'ok' },
    { text: 'node-2', outcome: 'ok' },
  ],
  [{ q: 'no such thing' }, { text: 'no such thing' }],
]

describe('the audit port pages by cursor (D5)', () => {
  for (const [index, [filter, query]] of FILTERS.entries()) {
    test(`filter ${index}: every match exactly once, newest first, with lines appended mid-walk`, async () => {
      const path = trailPath()
      let end = writeChain(path, 1_200)
      const port = createAuditPort({ path })
      // What the walk must meet: the matches as of the first page, newest
      // first. Lines appended later are above every cursor already handed out.
      const expected = queryTrail(readTrail(path).records, query)
        .map(record => record.seq)
        .reverse()

      const seen: number[] = []
      let before: number | undefined
      let head: number | undefined
      for (let pages = 0; pages < 1_000; pages++) {
        const current = await page(port, {
          ...filter,
          limit: 37,
          ...(before === undefined ? {} : { before }),
        })
        head ??= current.head
        const seqs = current.records.map(record => record.seq)
        // Oldest first within a page, as `/v0/audit` has always answered.
        expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
        expect(seqs.length).toBeLessThanOrEqual(37)
        seen.push(...[...seqs].reverse())
        if (pages === 0) end = writeChain(path, 40, end)
        if (current.earlier === null || current.earlier === undefined) break
        expect(current.earlier).toBe(seqs[0] ?? Number.NaN)
        before = current.earlier
      }
      expect(new Set(seen).size).toBe(seen.length)
      expect(seen).toEqual(expected)
      expect(head).toBe(1_200)

      // What arrived meanwhile is exactly what `since` answers.
      const since = await page(port, { ...filter, since: 1_200, limit: 500 })
      const arrived = queryTrail(readTrail(path).records, query)
        .filter(record => record.seq > 1_200)
        .map(record => record.seq)
      expect(since.records.map(record => record.seq)).toEqual(arrived)
      expect(since.head).toBe(1_240)
      expect(since.earlier).toBeNull()
    })
  }

  test('since: more than a page arrived says so with a cursor into the gap', async () => {
    const path = trailPath()
    const end = writeChain(path, 10)
    const port = createAuditPort({ path })
    expect((await page(port, { since: 10 })).records).toEqual([])
    writeChain(path, 25, end)
    const arrived = await page(port, { since: 10, limit: 20 })
    expect(arrived.records.map(record => record.seq)).toEqual(
      Array.from({ length: 20 }, (_, index) => 16 + index),
    )
    // Five more lie between the page and the old head.
    expect(arrived.earlier).toBe(16)
    const rest = await page(port, { since: 10, before: 16, limit: 20 })
    expect(rest.records.map(record => record.seq)).toEqual([11, 12, 13, 14, 15])
    expect(rest.earlier).toBeNull()
  })

  test('the head is the newest seq, 0 for an empty trail and for none at all', async () => {
    const empty = trailPath()
    writeFileSync(empty, '')
    expect((await page(createAuditPort({ path: empty }), {})).head).toBe(0)
    const absent = await page(
      createAuditPort({ path: trailPath('never-written.ndjson') }),
      {},
    )
    expect(absent.head).toBe(0)
    expect(absent.chain).toBe('absent')
    const path = trailPath()
    writeChain(path, 3)
    const three = await page(createAuditPort({ path }), { limit: 1 })
    expect(three.head).toBe(3)
    expect(three.records.map(record => record.seq)).toEqual([3])
    expect(three.earlier).toBe(3)
  })

  test('a cursor that is not a non-negative integer is refused, not read as no cursor', async () => {
    const path = trailPath()
    writeChain(path, 5)
    const port = createAuditPort({ path })
    for (const filter of [
      { before: -1 },
      { before: 1.5 },
      { since: Number.NaN },
      { since: -2 },
    ] satisfies AuditFilter[]) {
      expect(await port.read(filter)).toMatchObject({
        ok: false,
        failure: { code: 'invalid' },
      })
    }
  })

  test('one reader serves read and chain: an unchanged trail is not checked twice', async () => {
    const path = trailPath()
    writeChain(path, 500)
    const reader = new TrailReader(path)
    const port = createAuditPort({ path, reader })
    await page(port, {})
    const first = reader.stats
    expect(first.fullReads).toBe(1)
    expect(first.linesChecked).toBe(500)
    await page(port, { q: 'nightly' })
    const trace = '0'.repeat(32)
    const chain = await port.chain(trace)
    expect(chain.ok).toBe(true)
    // Two more reads, nothing more checked: the file did not change.
    expect(reader.stats.linesChecked).toBe(500)
    expect(reader.stats.fullReads).toBe(1)
  })
})
