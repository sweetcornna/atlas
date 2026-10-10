// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { type A2aTask, terminal } from './types.js'

export interface TaskMapping {
  id: string
  owner: string
  direction: 'inbound' | 'outbound'
  internalId: string
  externalId?: string
  peer?: string
  dedupKey: string
  digest: string
  task: A2aTask
}
/** One process owns a store. WAL transactions durably reserve IDs before dispatch. */
export class A2aTaskStore {
  readonly #db: Database
  readonly #owner = crypto.randomUUID()
  #owns = false
  constructor(path: string) {
    if (path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.#db = new Database(path, { create: true, strict: true })
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.#db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS a2a_tasks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, direction TEXT NOT NULL, internal_id TEXT NOT NULL, dedup_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS a2a_writer (id INTEGER PRIMARY KEY CHECK (id=1), pid INTEGER NOT NULL, owner TEXT NOT NULL);',
    )
  }
  get(id: string): TaskMapping | null {
    const row = this.#db
      .query<{ data: string }, [string]>(
        'SELECT data FROM a2a_tasks WHERE id = ?',
      )
      .get(id)
    return row ? JSON.parse(row.data) : null
  }
  duplicate(key: string): TaskMapping | null {
    const row = this.#db
      .query<{ data: string }, [string]>(
        'SELECT data FROM a2a_tasks WHERE dedup_key = ?',
      )
      .get(key)
    return row ? JSON.parse(row.data) : null
  }
  #claim(): void {
    if (this.#owns) return
    this.#db
      .transaction(() => {
        const current = this.#db
          .query<{ pid: number; owner: string }, []>(
            'SELECT pid, owner FROM a2a_writer WHERE id=1',
          )
          .get()
        if (current) {
          let alive = true
          try {
            process.kill(current.pid, 0)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false
          }
          if (alive)
            throw new Error(
              'A2A store already has a live writer; use one gateway per state directory',
            )
        }
        this.#db
          .query(
            'INSERT OR REPLACE INTO a2a_writer (id,pid,owner) VALUES (1,?,?)',
          )
          .run(process.pid, this.#owner)
      })
      .immediate()
    this.#owns = true
  }
  reserve(mapping: TaskMapping): void {
    this.#claim()
    const total = this.#db
      .query<{ total: number }, []>('SELECT COUNT(*) AS total FROM a2a_tasks')
      .get()!.total
    if (total >= 100000)
      throw new Error(
        'A2A task retention limit reached; archive the store before accepting more tasks',
      )
    this.#db
      .query(
        'INSERT INTO a2a_tasks (id,owner,direction,internal_id,dedup_key,data) VALUES (?,?,?,?,?,?)',
      )
      .run(
        mapping.id,
        mapping.owner,
        mapping.direction,
        mapping.internalId,
        mapping.dedupKey,
        JSON.stringify(mapping),
      )
  }
  save(mapping: TaskMapping): void {
    this.#claim()
    if (
      this.#db
        .query('UPDATE a2a_tasks SET data=? WHERE id=?')
        .run(JSON.stringify(mapping), mapping.id).changes !== 1
    )
      throw new Error('unknown task mapping')
  }
  /** Never blindly replay a possibly executed task after a process crash. */
  recover(): number {
    this.#claim()
    let count = 0
    this.#db.transaction(() => {
      for (const row of this.#db
        .query<{ data: string }, []>('SELECT data FROM a2a_tasks')
        .all()) {
        const mapping: TaskMapping = JSON.parse(row.data)
        if (terminal(mapping.task.status.state)) continue
        mapping.task.status = {
          state: 'TASK_STATE_FAILED',
          timestamp: new Date().toISOString(),
          message: {
            messageId: crypto.randomUUID(),
            role: 'ROLE_AGENT',
            parts: [
              {
                text: 'Gateway restarted while task was in progress; execution outcome is unknown. Inspect the internal task before retrying.',
              },
            ],
          },
        }
        this.save(mapping)
        count++
      }
    })()
    return count
  }
  close(): void {
    if (this.#owns)
      this.#db.query('DELETE FROM a2a_writer WHERE owner=?').run(this.#owner)
    this.#db.close()
  }
}
