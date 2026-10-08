// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Reading one trail again and again without checking all of it every time.
 *
 * `readTrail` parses and hashes the whole file on every call. That is
 * the right answer for a command run once, and the wrong one for a page that
 * polls: a 100 000-record trail is about 34 MB, and a console tab asking for
 * its newest fifty lines every five seconds was re-reading and re-hashing all
 * of them each time (`console-audit.md` D5, G2).
 *
 * A {@link TrailReader} keeps the part it has already checked — the records,
 * the issues, where the hash chain stands, and how many bytes that was — and
 * on the next read looks at the file before reading it:
 *
 * - **not there** — the cache is dropped and the answer is `readTrail`'s for a
 *   missing file;
 * - **same size, same mtime** — nothing was written, the last answer stands;
 * - **longer, same file** — the last checked line is compared byte for byte
 *   with what is on disk now, and only the bytes after it are read and
 *   checked, continuing the chain from where it stood. An append-only file
 *   only ever changes this way;
 * - **anything else** — shorter, another inode, the same size with a new
 *   mtime (written in place: not an append), or the last checked line no
 *   longer there — the whole file is read and checked again, as `readTrail`
 *   would.
 *
 * ## What the cache gives up, and for how long
 *
 * An edit in the middle of the file that keeps every later byte where it was
 * and is followed by an append passes the checks above. It is still caught:
 * the whole file is checked again once `recheckMs` (one minute by default)
 * has passed since the last full read. So the trail stays what `trail.ts`
 * says it is — an outside edit is **detectable** — with the detection
 * deferred by at most that long instead of to the next read. Nothing here
 * makes an edit easier to hide from the off-host witness, which reads the
 * file on its own (`@qianmo/witness`).
 *
 * ## A snapshot does not change after it is handed out
 *
 * The records array of an answer is never appended to: a later read that
 * finds new lines builds a new array. A caller that awaits between reading a
 * snapshot and using it gets the trail as it was, not a mixture.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import {
  scanLine,
  startScan,
  type TrailReadResult,
  type TrailScan,
} from './trail.js'

/** One read of a trail, with what a paging caller needs besides. */
export interface TrailSnapshot extends TrailReadResult {
  /**
   * Every record's `seq` is above the one before it, in file order — true of
   * any trail the writer produced. `pageTrail` may then stop scanning at a
   * `seq` instead of looking at every record.
   */
  readonly ordered: boolean
}

/** Counters a test reads to tell a cached read from a full one. */
export interface TrailReaderStats {
  /** Times the whole file was read and checked. */
  readonly fullReads: number
  /** Lines checked — parsed, and hashed when they parsed — across all reads. */
  readonly linesChecked: number
  /** Bytes read from the file across all reads. */
  readonly bytesRead: number
}

export interface TrailReaderOptions {
  /**
   * How long a checked prefix is trusted before the whole file is checked
   * again, in milliseconds. Default {@link DEFAULT_RECHECK_MS}.
   */
  readonly recheckMs?: number
  /** The clock `recheckMs` is measured on. Default `Date.now`. */
  readonly now?: () => number
}

/** One minute: how late an in-place edit with an append after it may be noticed. */
export const DEFAULT_RECHECK_MS = 60_000

const NEWLINE = 0x0a

const ABSENT: TrailSnapshot = {
  records: [],
  issues: [],
  intact: true,
  present: false,
  ordered: true,
}

/** What the reader keeps between reads. Every field describes complete lines only. */
interface Checked {
  readonly dev: number
  readonly ino: number
  /** File size and mtime when this was read: unchanged means nothing was written. */
  readonly size: number
  readonly mtimeMs: number
  /** Bytes up to and including the last newline. */
  readonly offset: number
  /** Complete lines checked. */
  readonly lines: number
  readonly scan: TrailScan
  /** The last complete line's bytes, newline included; empty when there is none. */
  readonly lastLine: Buffer
  /** When the whole file was last read and checked. */
  readonly verifiedAt: number
  /** The answer this state gave, unfinished last line included. */
  readonly snapshot: TrailSnapshot
}

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

/** `length` bytes of `fd` from `position`, however many reads that takes. */
function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const got = readSync(fd, buffer, done, length - done, position + done)
    if (got === 0) break
    done += got
  }
  return done === length ? buffer : buffer.subarray(0, done)
}

/** A scan whose arrays are this one's copies, so appending leaves the original alone. */
function copyScan(scan: TrailScan): TrailScan {
  return {
    records: [...scan.records],
    issues: [...scan.issues],
    previous: scan.previous,
    expectedSeq: scan.expectedSeq,
    ordered: scan.ordered,
    lastSeq: scan.lastSeq,
  }
}

function snapshotOf(scan: TrailScan): TrailSnapshot {
  const { records, issues, ordered } = scan
  return {
    records,
    issues,
    intact: issues.length === 0,
    present: true,
    ordered,
  }
}

/**
 * A trail reader that checks each byte of the file once, and the whole file
 * again only when something other than an append happened to it.
 *
 * Its answers are `readTrail`'s answers for the file as it stood at the
 * read (`test/reader.test.ts` compares them on every path above), plus
 * {@link TrailSnapshot.ordered}.
 */
export class TrailReader {
  readonly path: string
  readonly #recheckMs: number
  readonly #now: () => number
  #checked: Checked | null = null
  #fullReads = 0
  #linesChecked = 0
  #bytesRead = 0

  constructor(path: string, options: TrailReaderOptions = {}) {
    if (path.trim() === '') throw new Error('audit path must not be empty')
    this.path = path
    this.#recheckMs = options.recheckMs ?? DEFAULT_RECHECK_MS
    this.#now = options.now ?? Date.now
  }

  get stats(): TrailReaderStats {
    return {
      fullReads: this.#fullReads,
      linesChecked: this.#linesChecked,
      bytesRead: this.#bytesRead,
    }
  }

  /**
   * The trail as it is now. Throws what `readTrail` would throw (a
   * permission error, a directory where the file should be); a missing file
   * is an answer, not an error.
   */
  read(): TrailSnapshot {
    let fd: number
    try {
      fd = openSync(this.path, 'r')
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') {
        this.#checked = null
        return ABSENT
      }
      throw error
    }
    try {
      return this.#readOpen(fd)
    } finally {
      closeSync(fd)
    }
  }

  #readOpen(fd: number): TrailSnapshot {
    const stat = fstatSync(fd)
    const now = this.#now()
    const checked = this.#checked
    if (
      checked !== null &&
      checked.dev === stat.dev &&
      checked.ino === stat.ino &&
      now - checked.verifiedAt < this.#recheckMs
    ) {
      if (stat.size === checked.size) {
        // Same length and untouched: nothing was written. Same length and
        // touched: something was written in place, which an append never is.
        if (stat.mtimeMs === checked.mtimeMs) return checked.snapshot
      } else if (stat.size > checked.size && this.#tailHolds(fd, checked)) {
        return this.#extend(fd, checked, stat.size, stat.mtimeMs)
      }
    }
    return this.#full(fd, stat.dev, stat.ino, stat.size, stat.mtimeMs, now)
  }

  /** The last checked line is still on disk where it was. */
  #tailHolds(fd: number, checked: Checked): boolean {
    const length = checked.lastLine.length
    if (length === 0) return true
    const onDisk = readAt(fd, checked.offset - length, length)
    this.#bytesRead += onDisk.length
    return onDisk.equals(checked.lastLine)
  }

  #full(
    fd: number,
    dev: number,
    ino: number,
    size: number,
    mtimeMs: number,
    now: number,
  ): TrailSnapshot {
    this.#fullReads += 1
    const bytes = readAt(fd, 0, size)
    this.#bytesRead += bytes.length
    return this.#continue(
      {
        dev,
        ino,
        size: bytes.length,
        mtimeMs,
        offset: 0,
        lines: 0,
        scan: startScan(),
        lastLine: Buffer.alloc(0),
        verifiedAt: now,
      },
      bytes,
    )
  }

  #extend(
    fd: number,
    checked: Checked,
    size: number,
    mtimeMs: number,
  ): TrailSnapshot {
    const bytes = readAt(fd, checked.offset, size - checked.offset)
    this.#bytesRead += bytes.length
    return this.#continue(
      {
        ...checked,
        size: checked.offset + bytes.length,
        mtimeMs,
        scan: copyScan(checked.scan),
      },
      bytes,
    )
  }

  /**
   * Check `bytes`, which start at `base.offset`, against the chain `base`
   * stands on. The complete lines join the cache; whatever follows the last
   * newline is judged the way `readTrail` judges a last line without one,
   * and is read again next time.
   */
  #continue(base: Omit<Checked, 'snapshot'>, bytes: Buffer): TrailSnapshot {
    const scan = base.scan
    const end = bytes.lastIndexOf(NEWLINE) + 1
    let lines = base.lines
    let lastLine = base.lastLine
    if (end > 0) {
      const text = bytes.toString('utf8', 0, end - 1)
      for (const line of text.split('\n')) {
        lines += 1
        scanLine(scan, line, lines, true)
        this.#linesChecked += 1
      }
      // `lastIndexOf` reads a negative offset from the end of the buffer, so
      // a chunk that is one newline long is spelled out.
      const start = end >= 2 ? bytes.lastIndexOf(NEWLINE, end - 2) + 1 : 0
      lastLine = Buffer.from(bytes.subarray(start, end))
    }

    let snapshot = snapshotOf(scan)
    if (end < bytes.length) {
      const pending = copyScan(scan)
      scanLine(pending, bytes.toString('utf8', end), lines + 1, false)
      this.#linesChecked += 1
      snapshot = snapshotOf(pending)
    }

    this.#checked = {
      ...base,
      offset: base.offset + end,
      lines,
      lastLine,
      snapshot,
    }
    return snapshot
  }
}
