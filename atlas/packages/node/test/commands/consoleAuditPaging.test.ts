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
import {
  createConsoleHandler,
  type AuditFilter,
  type AuditPage,
} from '@qianmo/console'
import {
  consoleLimits,
  createAuditPort,
} from '../../src/commands/consolePorts.js'

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

// ---------------------------------------------------------------------------
// 100 000 records: the first screen has an upper bound (D5 / G2)
// ---------------------------------------------------------------------------

const BIG = 100_000

/** A console over one real trail file, reading it through `reader`. */
function consoleOver(path: string, reader: TrailReader) {
  const audit = createAuditPort({ path, reader })
  const handle = createConsoleHandler(
    {
      registry: {
        list: () => Promise.resolve({ ok: true, value: [] }),
        register: () => Promise.reject(new Error('not in this test')),
        deregister: () => Promise.reject(new Error('not in this test')),
        heartbeat: () => Promise.reject(new Error('not in this test')),
      },
      audit,
      limits: consoleLimits(),
      now: () => 1_800_000_000_000,
    },
    { view: VIEW_TOKEN, admin: ADMIN_TOKEN },
  )
  return async (path_: string) => {
    const started = performance.now()
    const response = await handle(
      new Request(`http://console.test${path_}`, {
        headers: { authorization: `Bearer ${VIEW_TOKEN}` },
      }),
    )
    const body = await response.text()
    return { status: response.status, body, ms: performance.now() - started }
  }
}

const VIEW_TOKEN = 'view-token-0000000000001'
const ADMIN_TOKEN = 'admin-token-000000000001'

/** Rows drawn in the page's main table. */
function rowCount(html: string, id: string): number {
  const start = html.indexOf(`id="${id}"`)
  if (start === -1) return 0
  const body = html.slice(start, html.indexOf('</tbody>', start))
  return body.split('<tr ').length - 1
}

describe('100 000 records: the first screen is bounded (D5, G2)', () => {
  test('cold once, then every first screen and every poll touches only what is new', async () => {
    const path = trailPath()
    const generated = performance.now()
    let end = writeChain(path, BIG)
    const generateMs = performance.now() - generated
    const reader = new TrailReader(path)
    const get = consoleOver(path, reader)

    // Cold: the one full read and check this console does for this file.
    const cold = await get('/audit')
    expect(cold.status).toBe(200)
    expect(rowCount(cold.body, 'audit-rows')).toBe(50)
    const afterCold = reader.stats
    expect(afterCold.fullReads).toBe(1)
    expect(afterCold.linesChecked).toBe(BIG)

    // Warm: a second tab's first screen. Nothing was written, so nothing is
    // read: the count is the bound, the clock only says so in milliseconds.
    const warm = await get('/audit')
    expect(rowCount(warm.body, 'audit-rows')).toBe(50)
    expect(reader.stats.linesChecked - afterCold.linesChecked).toBe(0)
    expect(reader.stats.bytesRead - afterCold.bytesRead).toBe(0)
    expect(warm.body.length).toBeLessThan(160_000)

    // The poll the page set up: since the head it was drawn at.
    const poll = /data-poll="([^"]+)"/
      .exec(warm.body)?.[1]
      ?.replaceAll('&amp;', '&')
    expect(poll).toBe(`/fragments/audit?since=${BIG}`)
    const quiet = await get(poll ?? '')
    expect(quiet.body.length).toBeLessThan(4_000)

    end = writeChain(path, 10, end)
    const beforePoll = reader.stats
    const news = await get(poll ?? '')
    expect(rowCount(news.body, 'audit-fresh')).toBe(10)
    // Ten new lines checked, and the bytes read are theirs plus the one line
    // spot-checked before them — not the 30-odd MB behind it.
    expect(reader.stats.linesChecked - beforePoll.linesChecked).toBe(10)
    expect(reader.stats.bytesRead - beforePoll.bytesRead).toBeLessThan(8_000)
    expect(news.body.length).toBeLessThan(16_000)

    // A deep page: a cursor far back is found by seq, not by a walk.
    const deep = await get('/audit?before=1234')
    expect(rowCount(deep.body, 'audit-rows')).toBe(50)

    // The bounds, in milliseconds, on whatever machine runs this. The count
    // assertions above are what the bound rests on; these are generous
    // enough for a loaded CI box and still an order below a full read.
    const warmAgain = await get('/audit')
    console.log(
      `[audit 100k] generate ${generateMs.toFixed(0)} ms · cold first screen ` +
        `${cold.ms.toFixed(0)} ms · warm first screen ${warm.ms.toFixed(1)} ms / ` +
        `${warmAgain.ms.toFixed(1)} ms · quiet poll ${quiet.ms.toFixed(1)} ms · ` +
        `poll with 10 new ${news.ms.toFixed(1)} ms · page before=1234 ` +
        `${deep.ms.toFixed(1)} ms · first screen ${warm.body.length} chars · ` +
        `quiet poll ${quiet.body.length} chars · poll with 10 new ${news.body.length} chars`,
    )
    expect(cold.ms).toBeLessThan(15_000)
    expect(Math.min(warm.ms, warmAgain.ms)).toBeLessThan(250)
    expect(news.ms).toBeLessThan(250)
    expect(deep.ms).toBeLessThan(250)
  }, 60_000)

  test('the control: a reader that trusts nothing reads all 100 000 lines on every first screen', async () => {
    // What the bound above would be without the cache: the same request,
    // through a reader whose checked prefix expires at once. If the bound's
    // count assertion were measuring nothing, this one could not differ.
    const path = trailPath()
    writeChain(path, BIG)
    const reader = new TrailReader(path, { recheckMs: 0 })
    const get = consoleOver(path, reader)
    await get('/audit')
    const before = reader.stats
    const again = await get('/audit')
    expect(rowCount(again.body, 'audit-rows')).toBe(50)
    expect(reader.stats.linesChecked - before.linesChecked).toBe(BIG)
    console.log(
      `[audit 100k] control · first screen with no cache ${again.ms.toFixed(0)} ms`,
    )
  }, 60_000)
})
