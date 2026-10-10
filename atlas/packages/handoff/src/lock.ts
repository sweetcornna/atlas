// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

/**
 * An exclusive lock file: created with `O_EXCL`, holding the owner's pid.
 *
 * Ruling 10 of 2026-10-03 for the hub ledger, and reused by `qm handoff` for
 * its per-project sync lock: one writer, and a crash must not wedge the next
 * start. So a lock whose pid no longer exists is stale and is reclaimed; a
 * lock whose pid is alive — this process included, through another handle —
 * is held.
 *
 * What it does not defend against, stated rather than implied:
 *
 * - **pid reuse.** A dead holder whose pid now belongs to an unrelated process
 *   reads as alive. The error names the pid and the file, so a person can
 *   check and remove it.
 * - **two reclaimers at the same instant.** Both can read the same stale pid,
 *   and the second unlink can remove the first one's fresh lock. The content
 *   is re-read right before the unlink to narrow that to the gap between two
 *   syscalls; M1 has one hub process and one user, and the case is two of
 *   them starting in the same millisecond after a crash.
 */

/** A lock file this process holds. */
export interface ExclusiveLock {
  readonly path: string
  /** Remove the file if it is still ours. Idempotent. */
  release(): void
}

/** The lock is held by a live process (or is being written right now). */
export class LockHeldError extends Error {
  readonly path: string
  /** The holder's pid, `null` when the file did not hold a readable one. */
  readonly holder: number | null

  constructor(path: string, holder: number | null) {
    super(
      holder === null
        ? `lock ${path} is being taken by another process`
        : `lock ${path} is held by pid ${holder}` +
            (holder === process.pid ? ' (this process)' : ''),
    )
    this.name = 'LockHeldError'
    this.path = path
    this.holder = holder
  }
}

/**
 * A lock file without a readable pid younger than this is a holder caught
 * between `open` and `write`, not a stale lock.
 */
const UNREADABLE_GRACE_MS = 5_000

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, it is just not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readHolder(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function pidOf(content: string): number | null {
  const text = content.trim()
  if (!/^\d{1,10}$/.test(text)) return null
  const pid = Number(text)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

function create(path: string): ExclusiveLock | null {
  let fd: number
  try {
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      FILE_MODE,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
    throw error
  }
  const mine = `${process.pid}\n`
  try {
    writeSync(fd, mine)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  let released = false
  return {
    path,
    release() {
      if (released) return
      released = true
      // Only our own file: a lock somebody reclaimed from under us is theirs.
      if (readHolder(path) === mine) {
        try {
          unlinkSync(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    },
  }
}

/**
 * Whether the file at `path` is a lock nobody holds any more. Removes it when
 * so, and only if it still reads the same as when it was judged.
 */
function reclaimIfStale(path: string): LockHeldError | null {
  const content = readHolder(path)
  if (content === null) return null
  const holder = pidOf(content)
  if (holder === null) {
    let age = 0
    try {
      age = Date.now() - statSync(path).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    if (age < UNREADABLE_GRACE_MS) return new LockHeldError(path, null)
  } else if (isAlive(holder)) {
    return new LockHeldError(path, holder)
  }
  if (readHolder(path) === content) {
    try {
      unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return null
}

/**
 * Take the lock at `path`, reclaiming a stale one. `null` when a live process
 * holds it. The parent directory is created (0700) if missing.
 */
export function tryExclusiveLock(path: string): ExclusiveLock | null {
  try {
    return acquireExclusiveLock(path)
  } catch (error) {
    if (error instanceof LockHeldError) return null
    throw error
  }
}

/** As {@link tryExclusiveLock}, but a held lock is a {@link LockHeldError}. */
export function acquireExclusiveLock(path: string): ExclusiveLock {
  mkdirSync(dirname(path), { recursive: true, mode: DIRECTORY_MODE })
  // Twice at most: once as found, once after reclaiming a stale file.
  for (let attempt = 0; attempt < 2; attempt++) {
    const lock = create(path)
    if (lock !== null) return lock
    const held = reclaimIfStale(path)
    if (held !== null) throw held
  }
  const content = readHolder(path)
  throw new LockHeldError(path, content === null ? null : pidOf(content))
}
