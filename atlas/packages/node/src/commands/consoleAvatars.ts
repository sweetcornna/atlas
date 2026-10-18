// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  type AvatarKey,
  type AvatarRecord,
  type AvatarSpec,
  type AvatarsPort,
  type ConsoleResult,
  type DirectionActor,
  parseAvatar,
  parseAvatarKey,
} from '@qianmo/console'
import { qianmoConfigPath } from '@qianmo/paths'
import { ensurePrivateDir, writePrivateJson } from '../providers/store.js'

const MAX_AVATARS = 10_000
const STALE_LOCK_MS = 30_000
const LOCK_WAIT_MS = 5_000
const LOCK_RETRY_MS = 10

interface Options {
  readonly path?: string
  readonly now?: () => number
  /** How long a write waits for a held lock before refusing (default 5 s); tests shorten it. */
  readonly lockWaitMs?: number
}

interface AvatarLock {
  assertHeld(): void
  release(): void
}

const rejected = <T>(message: string): ConsoleResult<T> => ({
  ok: false,
  failure: { code: 'rejected', message },
})
const unreachable = <T>(): ConsoleResult<T> => ({
  ok: false,
  failure: {
    code: 'unreachable',
    message: '形象存储不可用 · 检查文件格式、权限与写入锁',
  },
})

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decode(text: string): Map<AvatarKey, AvatarRecord> {
  const raw: unknown = JSON.parse(text)
  if (!object(raw) || raw.v !== 1 || !object(raw.avatars)) {
    throw new Error('invalid avatar store')
  }
  const entries = Object.entries(raw.avatars)
  if (entries.length > MAX_AVATARS) throw new Error('too many avatars')
  const saved = new Map<AvatarKey, AvatarRecord>()
  for (const [rawKey, record] of entries) {
    const key = parseAvatarKey(rawKey)
    if (key === null || !object(record)) {
      throw new Error('invalid avatar record')
    }
    const spec = parseAvatar(record.spec)
    if (
      spec === null ||
      typeof record.updatedAt !== 'number' ||
      !Number.isSafeInteger(record.updatedAt) ||
      record.updatedAt < 0 ||
      typeof record.updatedBy !== 'string' ||
      record.updatedBy.length === 0
    ) {
      throw new Error('invalid avatar record')
    }
    saved.set(key, {
      spec,
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
    })
  }
  return saved
}

/** Private atomic JSON. Reads never repair a bad file; the page draws defaults. */
export class ConsoleAvatars implements AvatarsPort {
  readonly path: string
  readonly #now: () => number
  readonly #lockWaitMs: number

  constructor(options: Options = {}) {
    this.path =
      options.path ?? qianmoConfigPath('qianmo', 'console', 'avatars.json')
    this.#now = options.now ?? Date.now
    this.#lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS
  }

  #read(): Map<AvatarKey, AvatarRecord> {
    let fd: number
    try {
      // Check and read the same inode, refusing links and non-regular files.
      fd = fs.openSync(
        this.path,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      )
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return new Map()
      throw error
    }
    try {
      const stat = fs.fstatSync(fd)
      if (
        !stat.isFile() ||
        (stat.mode & 0o7777) !== 0o600 ||
        (process.getuid !== undefined && stat.uid !== process.getuid())
      ) {
        throw new Error('avatar store must be a private owner file')
      }
      return decode(fs.readFileSync(fd, 'utf8'))
    } finally {
      fs.closeSync(fd)
    }
  }

  async read(
    keys: readonly AvatarKey[],
  ): Promise<ConsoleResult<ReadonlyMap<AvatarKey, AvatarRecord>>> {
    if (
      keys.some(key => typeof key !== 'string' || parseAvatarKey(key) === null)
    ) {
      return rejected('不认识的形象键')
    }
    try {
      const saved = this.#read()
      const found = new Map<AvatarKey, AvatarRecord>()
      for (const key of keys) {
        const record = saved.get(key)
        if (record !== undefined) found.set(key, record)
      }
      return { ok: true, value: found }
    } catch {
      return unreachable()
    }
  }

  async save(
    key: AvatarKey,
    spec: AvatarSpec | null,
    actor: DirectionActor,
  ): Promise<ConsoleResult<AvatarRecord | null>> {
    const parsed = spec === null ? null : parseAvatar(spec)
    if (
      typeof key !== 'string' ||
      parseAvatarKey(key) === null ||
      (spec !== null && parsed === null) ||
      typeof actor.subject !== 'string' ||
      actor.subject.length === 0
    ) {
      return rejected('形象键、选项或操作主体不合法')
    }
    let lock: AvatarLock | undefined
    try {
      lock = await this.#lock()
      lock.assertHeld()
      // Re-read under the lock: another console may have saved a different key.
      const saved = this.#read()
      let record: AvatarRecord | null = null
      if (parsed === null) {
        if (!saved.delete(key)) return { ok: true, value: null }
      } else {
        if (!saved.has(key) && saved.size >= MAX_AVATARS) {
          return rejected('形象最多保存 10 000 个')
        }
        record = {
          spec: parsed,
          updatedAt: Math.floor(this.#now()),
          updatedBy: actor.subject,
        }
        if (!Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0) {
          return rejected('形象更新时间不合法')
        }
        saved.set(key, record)
      }
      lock.assertHeld()
      writePrivateJson(this.path, { v: 1, avatars: Object.fromEntries(saved) })
      return { ok: true, value: record }
    } catch {
      return unreachable()
    } finally {
      lock?.release()
    }
  }

  async #lock(): Promise<AvatarLock> {
    ensurePrivateDir(path.dirname(this.path))
    const lockPath = `${this.path}.lock`
    // Lock age uses the real filesystem clock, not the record's injected clock.
    const deadline = Date.now() + this.#lockWaitMs
    for (;;) {
      if (Date.now() >= deadline) throw new Error('avatar lock busy')
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600)
        const held = fs.fstatSync(fd)
        return {
          assertHeld() {
            const current = fs.lstatSync(lockPath)
            if (
              current.dev !== held.dev ||
              current.ino !== held.ino ||
              Date.now() - current.mtimeMs > STALE_LOCK_MS
            ) {
              throw new Error('avatar lock expired or replaced')
            }
          },
          release() {
            fs.closeSync(fd)
            try {
              const current = fs.lstatSync(lockPath)
              // A stale holder must not remove a successor's lock when it resumes.
              if (current.dev === held.dev && current.ino === held.ino) {
                fs.unlinkSync(lockPath)
              }
            } catch {
              // The mutation's result must survive an already removed lock.
            }
          },
        }
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error
        try {
          const stale = fs.lstatSync(lockPath)
          if (
            !stale.isFile() ||
            (stale.mode & 0o7777) !== 0o600 ||
            (process.getuid !== undefined && stale.uid !== process.getuid())
          ) {
            throw new Error('invalid avatar lock')
          }
          if (Date.now() - stale.mtimeMs > STALE_LOCK_MS) {
            const current = fs.lstatSync(lockPath)
            if (
              current.dev === stale.dev &&
              current.ino === stale.ino &&
              current.mtimeMs === stale.mtimeMs
            ) {
              fs.unlinkSync(lockPath)
            }
            continue
          }
        } catch (lockError) {
          if (!isErrno(lockError, 'ENOENT')) throw lockError
          continue
        }
        if (Date.now() >= deadline) throw new Error('avatar lock busy')
        await Bun.sleep(LOCK_RETRY_MS)
      }
    }
  }
}
