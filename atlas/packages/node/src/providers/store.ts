// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Private apply journal and omp config files; all writes are fsync + rename. */

import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { qianmoConfigPath, ompAgentDir } from '@qianmo/paths'

export const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIR_MODE = 0o700

export function providerDir(): string {
  return qianmoConfigPath('qianmo', 'provider')
}

export const providerPaths = {
  models: () => `${ompAgentDir()}/models.yml`,
  config: () => `${ompAgentDir()}/config.yml`,
  auth: () => `${ompAgentDir()}/agent.db`,
  pool: () => qianmoConfigPath('qianmo', 'provider', 'pool.json'),
  lock: () => qianmoConfigPath('qianmo', 'provider', 'apply.lock'),
  pending: () => qianmoConfigPath('qianmo', 'provider', 'pending.json'),
  state: () => qianmoConfigPath('qianmo', 'provider', 'state.json'),
  generation: () => qianmoConfigPath('qianmo', 'provider', 'generation.json'),
  firstWrite: () =>
    qianmoConfigPath('qianmo', 'provider', 'first-write', 'config.json'),
  /** Written by the resident (P18.3, §2.7): `{pid, startedAt, nonce}`. */
  residentPid: () => qianmoConfigPath('resident', 'resident.pid'),
}

/** Create `dir` (and parents) and force it to 0700. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
  chmodSync(dir, PRIVATE_DIR_MODE)
}

/** True when nobody but the owner has any bit on `path`. */
export function isOwnerOnly(path: string): boolean {
  return (statSync(path).mode & 0o077) === 0
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === code
  )
}

function isMissing(error: unknown): boolean {
  return isErrno(error, 'ENOENT')
}

/** Atomic write with the tmp file created 0600 (`wx`: never reuse a path). */
export function writePrivateFileAtomic(path: string, content: string): void {
  ensurePrivateDir(dirname(path))
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  const fd = openSync(tmp, 'wx', PRIVATE_FILE_MODE)
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // Best effort; the original error is the one worth reporting.
    }
    throw error
  }
}

export function writePrivateJson(path: string, value: unknown): void {
  writePrivateFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** `undefined` when the file does not exist; the raw text otherwise. */
export function readTextIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

export function removeIfExists(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

/** Whether a pid names a live process this user can see. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: alive but owned by someone else — still alive.
    return isErrno(error, 'EPERM')
  }
}

type LockRecord = { pid: number; at: string; nonce: string }

type ApplyLock = { release(): void }

/**
 * `apply.lock` via `O_EXCL` (§2.6 step 1). A lock whose pid is gone is stale
 * and reclaimed once; a live holder means `busy` (`null`).
 */
export function acquireApplyLock(now: Date = new Date()): ApplyLock | null {
  ensurePrivateDir(providerDir())
  const path = providerPaths.lock()
  const record: LockRecord = {
    pid: process.pid,
    at: now.toISOString(),
    nonce: randomBytes(8).toString('hex'),
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', PRIVATE_FILE_MODE)
      try {
        writeSync(fd, JSON.stringify(record))
      } finally {
        closeSync(fd)
      }
      return {
        release() {
          const current = readTextIfExists(path)
          if (current !== undefined && current.includes(record.nonce)) {
            removeIfExists(path)
          }
        },
      }
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error
      if (attempt > 0 || !isStaleLock(path)) return null
      removeIfExists(path)
    }
  }
  return null
}

/** How long an unreadable lock is presumed to be a holder mid-write. */
const TORN_LOCK_GRACE_MS = 10_000

function isStaleLock(path: string): boolean {
  const text = readTextIfExists(path)
  if (text === undefined) return true
  try {
    const parsed = JSON.parse(text) as Partial<LockRecord>
    return typeof parsed.pid !== 'number' || !isProcessAlive(parsed.pid)
  } catch {
    // Unreadable: either a holder between open() and write(), or a torn
    // write from a crashed one. Only age tells them apart.
    try {
      return Date.now() - statSync(path).mtimeMs > TORN_LOCK_GRACE_MS
    } catch (error) {
      return isMissing(error)
    }
  }
}
