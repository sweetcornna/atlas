// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve, basename } from 'node:path'
import {
  parseTenantConfig,
  type TenantConfig,
  type TenantPort,
  type TenantSnapshot,
} from '@qianmo/console'

/** Resolve the deepest existing ancestor, including symlinks in an uncreated root. */
export function canonicalTenantRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error('记忆根必须是绝对路径')
  let candidate = resolve(path)
  const tail: string[] = []
  for (;;) {
    try {
      return join(realpathSync(candidate), ...tail)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(candidate)
      if (parent === candidate) throw error
      tail.unshift(basename(candidate))
      candidate = parent
    }
  }
}

/** Explicitly enabled store. Missing, symlinked or malformed policy never disables tenancy. */
export class FileTenantStore implements TenantPort {
  readonly #listeners = new Set<() => void>()
  #revision: string | null = null
  #timer: ReturnType<typeof setInterval> | undefined
  constructor(readonly path: string) {
    if (!isAbsolute(path)) throw new Error('租户配置路径必须是绝对路径')
    this.read()
  }
  #changed(revision: string): void {
    const old = this.#revision
    this.#revision = revision
    if (old !== null && old !== revision)
      for (const listener of [...this.#listeners]) listener()
  }
  read(): TenantSnapshot {
    try {
      if (lstatSync(this.path).isSymbolicLink())
        throw new Error('租户配置不能是符号链接')
      const fd = openSync(
        this.path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      )
      let text: string
      try {
        const stat = fstatSync(fd)
        if (
          !stat.isFile() ||
          (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
        )
          throw new Error('租户配置必须是私有普通文件 (0600)')
        text = readFileSync(fd, 'utf8')
      } finally {
        closeSync(fd)
      }
      const config = parseTenantConfig(JSON.parse(text), canonicalTenantRoot)
      const revision = createHash('sha256')
        .update(JSON.stringify(config))
        .digest('hex')
      this.#changed(revision)
      return { config, revision }
    } catch (error) {
      this.#changed('unavailable')
      throw error
    }
  }
  /** Local operator API; writes a fully validated snapshot, never a partial mapping. */
  replace(input: unknown): TenantConfig {
    const config = parseTenantConfig(input, canonicalTenantRoot)
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    const fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    )
    try {
      writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, this.path)
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(this.path), constants.O_RDONLY)
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
    }
    // Keep validation and notification identical to the read path.
    this.read()
    return config
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    if (this.#timer === undefined) {
      this.#timer = setInterval(() => {
        try {
          this.read()
        } catch {
          /* listeners already closed */
        }
      }, 1000)
      this.#timer.unref()
    }
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size === 0 && this.#timer !== undefined) {
        clearInterval(this.#timer)
        this.#timer = undefined
      }
    }
  }
}
