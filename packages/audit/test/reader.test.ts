// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `TrailReader` answers what `readTrail` answers, reading each byte once.
 *
 * Every path the reader can take — first read, nothing new, an append, a
 * half-written last line and its completion, truncation, a rewrite in place,
 * a replaced file, a deleted one — is compared with `readTrail` on the same
 * file, and the counters say which path it took. The one place the two are
 * allowed to differ is spelled out and bounded: an in-place edit followed by
 * an append is found by the next full check, `recheckMs` later.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AuditSource,
  AuditTrail,
  TrailReader,
  readTrail,
  type TrailSnapshot,
} from '../src/index.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function trailPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-reader-'))
  dirs.push(dir)
  return join(dir, 'audit.ndjson')
}

function append(path: string, count: number, start = 0): void {
  const trail = new AuditTrail(path)
  for (let index = 0; index < count; index++) {
    trail.append({
      at: 1_800_000_000_000 + start + index,
      source: AuditSource.Router,
      kind: 'forwarded',
      node: 'node-a',
      outcome: index % 7 === 0 ? 'refused' : 'ok',
      detail: { n: start + index },
    })
  }
  trail.close()
}

/** What `readTrail` says, in the reader's shape without `ordered`. */
function withoutOrder(snapshot: TrailSnapshot) {
  const { ordered: _ordered, ...rest } = snapshot
  return rest
}

/** A clock a test moves by hand. */
function clock(start = 1_000) {
  let now = start
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
    },
  }
}

describe('TrailReader reads what readTrail reads', () => {
  test('a missing file is absent, and so is one deleted after a read', () => {
    const path = trailPath()
    const reader = new TrailReader(path)
    expect(withoutOrder(reader.read())).toEqual(readTrail(path))
    append(path, 3)
    expect(reader.read().records).toHaveLength(3)
    rmSync(path)
    const gone = reader.read()
    expect(withoutOrder(gone)).toEqual(readTrail(path))
    expect(gone.present).toBe(false)
  })

  test('nothing written: the second read checks no line and reads no byte', () => {
    const path = trailPath()
    append(path, 50)
    const reader = new TrailReader(path)
    const first = reader.read()
    expect(withoutOrder(first)).toEqual(readTrail(path))
    const after = reader.stats
    expect(after.fullReads).toBe(1)
    expect(after.linesChecked).toBe(50)

    const second = reader.read()
    expect(second).toBe(first)
    expect(reader.stats).toEqual(after)
  })

  test('an append is read and checked alone, continuing the chain', () => {
    const path = trailPath()
    append(path, 40)
    const reader = new TrailReader(path)
    reader.read()
    const before = reader.stats

    append(path, 5, 40)
    const extended = reader.read()
    expect(withoutOrder(extended)).toEqual(readTrail(path))
    expect(extended.intact).toBe(true)
    expect(extended.records.map(record => record.seq).at(-1)).toBe(45)
    expect(reader.stats.fullReads).toBe(1)
    expect(reader.stats.linesChecked - before.linesChecked).toBe(5)
    // The new bytes and the one line spot-checked, nothing else.
    const size = statSync(path).size
    expect(reader.stats.bytesRead - before.bytesRead).toBeLessThan(size / 4)
  })

  test('a snapshot already handed out does not grow when the trail does', () => {
    const path = trailPath()
    append(path, 10)
    const reader = new TrailReader(path)
    const first = reader.read()
    append(path, 3, 10)
    const second = reader.read()
    expect(first.records).toHaveLength(10)
    expect(second.records).toHaveLength(13)
  })

  test('a half-written last line is judged like readTrail judges it, and read again once finished', () => {
    const path = trailPath()
    append(path, 4)
    const reader = new TrailReader(path)
    reader.read()

    // Build the fifth line in a second file, then land it in two halves.
    const scratch = trailPath()
    writeFileSync(scratch, readFileSync(path))
    append(scratch, 1, 4)
    const whole = readFileSync(scratch, 'utf8').split('\n').at(-2) ?? ''
    appendFileSync(path, whole.slice(0, 30))

    const torn = reader.read()
    expect(withoutOrder(torn)).toEqual(readTrail(path))
    expect(torn.issues.map(issue => issue.kind)).toEqual(['torn_tail'])
    expect(torn.records).toHaveLength(4)

    appendFileSync(path, `${whole.slice(30)}\n`)
    const finished = reader.read()
    expect(withoutOrder(finished)).toEqual(readTrail(path))
    expect(finished.intact).toBe(true)
    expect(finished.records).toHaveLength(5)
    expect(reader.stats.fullReads).toBe(1)
  })

  test('a whole last line without its newline is a record, as in readTrail', () => {
    const path = trailPath()
    append(path, 3)
    const text = readFileSync(path, 'utf8')
    writeFileSync(path, text.slice(0, -1))
    const reader = new TrailReader(path)
    const read = reader.read()
    expect(withoutOrder(read)).toEqual(readTrail(path))
    expect(read.records).toHaveLength(3)
    appendFileSync(path, '\n')
    expect(withoutOrder(reader.read())).toEqual(readTrail(path))
  })

  test('a shorter file is read whole again', () => {
    const path = trailPath()
    append(path, 6)
    const reader = new TrailReader(path)
    reader.read()
    const lines = readFileSync(path, 'utf8').split('\n')
    writeFileSync(path, `${lines.slice(0, 3).join('\n')}\n`)
    const read = reader.read()
    expect(withoutOrder(read)).toEqual(readTrail(path))
    expect(read.records).toHaveLength(3)
    expect(reader.stats.fullReads).toBe(2)
  })

  test('the same size written in place is read whole again, and the edit is found', () => {
    const path = trailPath()
    append(path, 6)
    const reader = new TrailReader(path)
    reader.read()
    const text = readFileSync(path, 'utf8')
    // Same length: one refusal turned into a pass on the first line.
    const edited = text.replace('"outcome":"refused"', '"outcome":"dropped"')
    expect(edited.length).toBe(text.length)
    writeFileSync(path, edited)
    const mtime = statSync(path).mtimeMs / 1000
    utimesSync(path, mtime + 5, mtime + 5)

    const read = reader.read()
    expect(withoutOrder(read)).toEqual(readTrail(path))
    expect(read.intact).toBe(false)
    expect(reader.stats.fullReads).toBe(2)
  })

  test('a file replaced by another is read whole again', () => {
    const path = trailPath()
    append(path, 6)
    const reader = new TrailReader(path)
    reader.read()
    const other = `${path}.new`
    append(other, 9)
    renameSync(other, path)
    const read = reader.read()
    expect(withoutOrder(read)).toEqual(readTrail(path))
    expect(read.records).toHaveLength(9)
    expect(reader.stats.fullReads).toBe(2)
  })

  test('the last checked line rewritten before an append: read whole again', () => {
    const path = trailPath()
    append(path, 6)
    const reader = new TrailReader(path)
    reader.read()
    const lines = readFileSync(path, 'utf8').split('\n')
    const last = lines[5] ?? ''
    lines[5] = last.replace('"kind":"forwarded"', '"kind":"forwardeD"')
    writeFileSync(path, lines.join('\n'))
    append(path, 2, 6)
    const read = reader.read()
    // The writer chained the new lines off the edited one, so the chain
    // itself holds — the end of a chain is what only the witness can vouch
    // for. What matters here is that the reader noticed and read it all.
    expect(withoutOrder(read)).toEqual(readTrail(path))
    expect(read.records[5]?.kind).toBe('forwardeD')
    expect(reader.stats.fullReads).toBe(2)
  })

  test('an edit deeper in the file with an append after it is found by the next full check', () => {
    const path = trailPath()
    append(path, 20)
    const time = clock()
    const reader = new TrailReader(path, { recheckMs: 60_000, now: time.now })
    reader.read()

    const lines = readFileSync(path, 'utf8').split('\n')
    lines[2] = (lines[2] ?? '').replace('"n":2', '"n":9')
    writeFileSync(path, lines.join('\n'))
    append(path, 1, 20)

    // Inside the window the cache stands: this is the documented trade.
    const early = reader.read()
    expect(early.intact).toBe(true)
    expect(reader.stats.fullReads).toBe(1)

    time.advance(60_000)
    const late = reader.read()
    expect(withoutOrder(late)).toEqual(readTrail(path))
    expect(late.intact).toBe(false)
    expect(reader.stats.fullReads).toBe(2)
  })

  test('ordered is true for what the writer wrote and false for a trail out of order', () => {
    const path = trailPath()
    append(path, 5)
    expect(new TrailReader(path).read().ordered).toBe(true)
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    writeFileSync(
      path,
      `${[lines[0], lines[2], lines[1], lines[3], lines[4]].join('\n')}\n`,
    )
    const read = new TrailReader(path).read()
    expect(read.ordered).toBe(false)
    expect(withoutOrder(read)).toEqual(readTrail(path))
  })

  test('a directory where the file should be throws, as readTrail does', () => {
    const path = trailPath()
    const reader = new TrailReader(join(path, '..'))
    expect(() => reader.read()).toThrow()
    expect(() => readTrail(join(path, '..'))).toThrow()
  })
})
