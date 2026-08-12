// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { occConfigPath } from '../../../src/config/paths.js'

/**
 * Durable home for one JSON document.
 *
 * Deliberately untyped on both sides: what comes back off disk is whatever the
 * previous process (or a text editor, or a half-finished migration) left there,
 * so it is `unknown` until the registry validates it. Keeping the shape out of
 * this interface also keeps the store free of any dependency on
 * `registry.ts` — the file layer moves bytes, the registry owns the schema and
 * the trust boundary.
 */
export interface RegistryStore {
  /** The stored document, or `null` when there is nothing usable to read. */
  read(): unknown
  /** Replace the stored document. Must be atomic against a killed process. */
  write(document: unknown): void
}

/**
 * Where the registry keeps its table by default.
 *
 * Derived from {@link occConfigPath} rather than assembled by hand, because the
 * config root is identity-scoped (`~/.occ` vs `~/.qianmo`, and either one
 * overridable by `OCC_CONFIG_DIR`). A hand-rolled `join(homedir(), '.occ')`
 * would resolve to one fixed directory and punch straight through that
 * isolation — see the header of `src/config/paths.ts`.
 */
export function defaultRegistryStatePath(): string {
  return occConfigPath('registry', 'agents.json')
}

/** Owner-only, matching the rest of the config root. */
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/**
 * A {@link RegistryStore} backed by a single JSON file.
 *
 * Writes go to a sibling temporary file which is flushed and then `rename`d
 * over the target. `rename` within one directory is atomic on POSIX, so a
 * process killed at any instant leaves either the previous complete document
 * or the new complete one — never a truncated file that would make the whole
 * table unreadable on the next boot.
 */
export class FileRegistryStore implements RegistryStore {
  readonly #path: string

  /** @param path Defaults to {@link defaultRegistryStatePath}. */
  constructor(path: string = defaultRegistryStatePath()) {
    this.#path = path
  }

  get path(): string {
    return this.#path
  }

  /**
   * `null` for a missing, unreadable or malformed file.
   *
   * A registry table is soft state — every entry is refreshed by a heartbeat
   * within one TTL — so the recovery for an unusable file is to start empty and
   * let agents re-register. Throwing here would instead turn one bad byte into
   * a registry that cannot boot at all.
   */
  read(): unknown {
    let raw: string
    try {
      raw = readFileSync(this.#path, 'utf8')
    } catch {
      return null
    }
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return null
    }
  }

  write(document: unknown): void {
    const directory = dirname(this.#path)
    mkdirSync(directory, { recursive: true, mode: DIR_MODE })

    // Same directory as the target: `rename` is only atomic within a filesystem.
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`
    try {
      const handle = openSync(temporary, 'wx', FILE_MODE)
      try {
        writeFileSync(handle, `${JSON.stringify(document, null, 2)}\n`)
        // Without the flush the rename can land before the bytes do, which on a
        // power loss yields the one outcome the temp file was meant to prevent.
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
      renameSync(temporary, this.#path)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }
}
