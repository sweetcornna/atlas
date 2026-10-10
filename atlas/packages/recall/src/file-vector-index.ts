// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from 'bun:sqlite'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs'
import { join } from 'node:path'
import type { FileMemoryStore } from '@qianmo/memory'
import { isUsableVector } from './embedding.js'
import type { VectorIndex, VectorKey } from './vector-index.js'

function keyString(key: VectorKey): string {
  return JSON.stringify([
    key.entryId,
    key.contentHash,
    key.providerId,
    key.model,
    key.dimensions,
  ])
}

/** Disposable ranking cache. No memory text, authority or liveness is stored here. */
export class FileVectorIndex implements VectorIndex {
  readonly #db: Database
  constructor(memoryRoot: string) {
    const directory = join(memoryRoot, 'index')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const dir = lstatSync(directory)
    if (
      !dir.isDirectory() ||
      dir.isSymbolicLink() ||
      (process.platform !== 'win32' && (dir.mode & 0o077) !== 0)
    )
      throw new Error('vector index directory must be private')
    const path = join(directory, 'vectors.sqlite')
    const fd = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      const stat = fstatSync(fd)
      if (
        !stat.isFile() ||
        (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      )
        throw new Error('vector index must be a private regular file')
    } finally {
      closeSync(fd)
    }
    this.#db = new Database(path)
    this.#db.exec(
      'PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, entry_id TEXT NOT NULL, vector TEXT NOT NULL)',
    )
  }
  get(key: VectorKey): readonly number[] | undefined {
    const row = this.#db
      .query('SELECT vector FROM vectors WHERE key = ?')
      .get(keyString(key)) as { vector: string } | null
    if (row === null) return undefined
    const value: unknown = JSON.parse(row.vector)
    if (!isUsableVector(value, key.dimensions))
      throw new Error('invalid cached vector')
    return value
  }
  set(key: VectorKey, vector: readonly number[]): void {
    if (!isUsableVector(vector, key.dimensions))
      throw new Error('invalid vector')
    this.#db
      .query(
        'INSERT OR REPLACE INTO vectors (key,entry_id,vector) VALUES (?,?,?)',
      )
      .run(keyString(key), key.entryId, JSON.stringify(vector))
  }
  /** Revoke removes the reversible cache row, never the auditable memory record. */
  remove(entryId: string): void {
    this.#db.query('DELETE FROM vectors WHERE entry_id = ?').run(entryId)
  }
  clear(): void {
    this.#db.exec('DELETE FROM vectors')
  }
  prune(store: Pick<FileMemoryStore, 'getEntry'>): void {
    const rows = this.#db
      .query('SELECT DISTINCT entry_id FROM vectors')
      .all() as { entry_id: string }[]
    for (const row of rows) {
      const entry = store.getEntry(row.entry_id)
      if (entry === null || entry.expiredAt !== null) this.remove(row.entry_id)
    }
  }
  close(): void {
    this.#db.close()
  }
}
