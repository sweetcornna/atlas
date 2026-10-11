// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from 'bun:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  isOperationId,
  ProtocolErrorCode,
  type ControlOutcome,
} from '@qianmo/protocol'

const RETENTION_MS = 24 * 60 * 60 * 1_000
const MAX_ENTRIES = 1_024
const MAX_RESULT_BYTES = 16 * 1024 * 1024
const interrupted: ControlOutcome = {
  ok: false,
  code: 'unknown',
  message: '操作可能已执行，结果未知；请使用原操作号核对',
}

interface Entry {
  digest: string
  result: string
}

export interface ControlOperationContext {
  readonly operationId?: string
  readonly peer: string
  readonly actor: string
  readonly agent?: string
}

/** JSON key order is not a business parameter; array order is. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** Reserve durably before invoking: a crash between effect and commit never reruns it. */
export class ControlLedger {
  readonly #file: string
  readonly #now: () => number
  readonly #maxEntries: number
  readonly #retentionMs: number
  readonly #maxResultBytes: number
  readonly #onError: ((error: unknown) => void) | undefined
  #db: Database | undefined
  readonly #active = new Map<
    string,
    { digest: string; result: Promise<ControlOutcome> }
  >()

  constructor(options: {
    file: string
    now?: () => number
    maxEntries?: number
    retentionMs?: number
    maxResultBytes?: number
    onError?: (error: unknown) => void
  }) {
    this.#file = options.file
    this.#now = options.now ?? Date.now
    this.#maxEntries = options.maxEntries ?? MAX_ENTRIES
    this.#retentionMs = options.retentionMs ?? RETENTION_MS
    this.#maxResultBytes = options.maxResultBytes ?? MAX_RESULT_BYTES
    this.#onError = options.onError
  }

  #database(): Database {
    if (this.#db) return this.#db
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 })
    const fd = fs.openSync(this.#file, 'a', 0o600)
    fs.closeSync(fd)
    fs.chmodSync(this.#file, 0o600)
    const db = new Database(this.#file, { strict: true })
    // FULL + rollback journal makes both the reservation and result durable;
    // SQLite creates its journal with the database's restrictive permissions.
    db.exec(
      'PRAGMA page_size = 4096; PRAGMA max_page_count = 8192; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000;',
    )
    db.exec(
      'CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL, expires INTEGER NOT NULL)',
    )
    this.#db = db
    return db
  }

  async execute(
    op: string,
    args: Record<string, unknown>,
    ctx: ControlOperationContext,
    invoke: () => Promise<ControlOutcome>,
  ): Promise<ControlOutcome> {
    if (!isOperationId(ctx.operationId))
      return {
        ok: false,
        code: 'invalid',
        message: '有副作用的操作必须带有效的 operationId',
      }
    const id = ctx.operationId.toLowerCase()
    const digest = new Bun.CryptoHasher('sha256')
      .update(
        canonical(
          JSON.parse(
            JSON.stringify({
              op,
              args,
              peer: ctx.peer,
              actor: ctx.actor,
              agent: ctx.agent,
            }),
          ),
        ),
      )
      .digest('hex')
    const conflict: ControlOutcome = {
      ok: false,
      code: 'invalid',
      message: '操作号复用：参数或调用身份不同',
    }
    const active = this.#active.get(id)
    if (active) return active.digest === digest ? active.result : conflict
    const db = this.#database()
    let reservationExpires = 0
    const prior = db
      .transaction(() => {
        const now = this.#now()
        reservationExpires = now + this.#retentionMs
        db.query('DELETE FROM operations WHERE expires <= ?').run(now)
        const found = db
          .query<Entry, [string]>(
            'SELECT digest, result FROM operations WHERE id = ?',
          )
          .get(id)
        if (found)
          return found.digest === digest
            ? (JSON.parse(found.result) as ControlOutcome)
            : conflict
        const size = db
          .query<{ count: number; bytes: number }, []>(
            'SELECT count(*) AS count, coalesce(sum(length(CAST(result AS BLOB))), 0) AS bytes FROM operations',
          )
          .get()!
        if (
          size.count >= this.#maxEntries ||
          size.bytes + Buffer.byteLength(JSON.stringify(interrupted)) >
            this.#maxResultBytes
        )
          return {
            ok: false,
            code: ProtocolErrorCode.E_BUSY,
            message: '控制幂等账本已满，请稍后重试',
          } as ControlOutcome
        db.query(
          'INSERT INTO operations (id, digest, result, expires) VALUES (?, ?, ?, ?)',
        ).run(id, digest, JSON.stringify(interrupted), reservationExpires)
        return undefined
      })
      .immediate()
    if (prior) return prior
    const result = (async (): Promise<ControlOutcome> => {
      try {
        const outcome = await invoke()
        const encoded = JSON.stringify(outcome)
        // Never discard an unrecordable effect's reservation to make space.
        const stored = db
          .transaction(() => {
            const size = db
              .query<{ bytes: number }, [string]>(
                'SELECT coalesce(sum(length(CAST(result AS BLOB))), 0) AS bytes FROM operations WHERE id != ?',
              )
              .get(id)!
            if (size.bytes + Buffer.byteLength(encoded) > this.#maxResultBytes)
              return false
            // Cleanup or another receiver may have expired/reassigned the id
            // while the effect ran. Never overwrite a different reservation.
            return (
              db
                .query(
                  'UPDATE operations SET result = ?, expires = ? WHERE id = ? AND digest = ? AND expires = ?',
                )
                .run(
                  encoded,
                  this.#now() + this.#retentionMs,
                  id,
                  digest,
                  reservationExpires,
                ).changes === 1
            )
          })
          .immediate()
        return stored ? outcome : interrupted
      } catch (error) {
        this.#onError?.(error)
        return interrupted
      }
    })()
    this.#active.set(id, { digest, result })
    try {
      return await result
    } finally {
      this.#active.delete(id)
    }
  }

  async close(): Promise<void> {
    // Every in-flight effect already has a durable unknown reservation. An
    // uncooperative handler must not prevent resident shutdown; a late result
    // sees the closed database and remains unknown instead of being rerun.
    this.#db?.close()
    this.#db = undefined
  }
}
