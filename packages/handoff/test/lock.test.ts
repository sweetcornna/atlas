// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  acquireExclusiveLock,
  LockHeldError,
  tryExclusiveLock,
} from '../src/lock.js'
import { cleanupTemporaries, tempDir } from './helpers.js'

afterAll(cleanupTemporaries)

/** A pid that is not running: spawn something trivial and wait for it. */
function deadPid(): number {
  const proc = Bun.spawnSync(['true'])
  return proc.pid
}

describe('exclusive lock files', () => {
  test('holds the pid, refuses a second holder, and is gone after release', () => {
    const path = join(tempDir(), 'nested', 'state.lock')
    const lock = acquireExclusiveLock(path)
    expect(readFileSync(path, 'utf8')).toBe(`${process.pid}\n`)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)

    // This process again, through another handle, is still a live holder.
    expect(tryExclusiveLock(path)).toBeNull()
    let caught: unknown
    try {
      acquireExclusiveLock(path)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(LockHeldError)
    expect((caught as LockHeldError).holder).toBe(process.pid)

    lock.release()
    lock.release()
    expect(existsSync(path)).toBe(false)
    const again = tryExclusiveLock(path)
    expect(again).not.toBeNull()
    again?.release()
  })

  test('a lock left by a dead pid is reclaimed', () => {
    const path = join(tempDir(), 'ledger.ndjson.lock')
    writeFileSync(path, `${deadPid()}\n`)
    const lock = acquireExclusiveLock(path)
    expect(readFileSync(path, 'utf8')).toBe(`${process.pid}\n`)
    lock.release()
  })

  test('an unreadable lock is held while young and reclaimed when old', () => {
    const path = join(tempDir(), 'sync.lock')
    writeFileSync(path, '')
    expect(tryExclusiveLock(path)).toBeNull()
    const old = new Date(Date.now() - 60_000)
    utimesSync(path, old, old)
    const lock = tryExclusiveLock(path)
    expect(lock).not.toBeNull()
    lock?.release()
  })

  test('release leaves a lock somebody else now holds alone', () => {
    const path = join(tempDir(), 'sync.lock')
    const lock = acquireExclusiveLock(path)
    // Simulate a reclaim from under us: the file now names someone else.
    writeFileSync(path, '1\n')
    lock.release()
    expect(readFileSync(path, 'utf8')).toBe('1\n')
  })
})
