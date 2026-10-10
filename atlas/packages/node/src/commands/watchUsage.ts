// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  FileUsageStore,
  type ConsoleAuditSource,
  type UsageScope,
} from '@qianmo/console'
import {
  assertAddress,
  isTaskResultPayload,
  MessageType,
  type QianmoMessage,
} from '@qianmo/protocol'
import { qianmoConfigPath } from '@qianmo/paths'
import type { ScheduledJob } from '@qianmo/scheduler'
import { createAuditPort } from './consolePorts.js'
import { loadUsagePolicy, startUsageCollection } from './consoleUsage.js'
import type { WatchBoundary } from './watchBoundary.js'

export const watchUsageSnapshotPath = () =>
  qianmoConfigPath('watch', 'usage-status.json')
interface Origin {
  job: string
  target: string
  tenant: string | null
}

/** Watch has one durable writer, separate from the console's person ledger. */
export class WatchUsage {
  readonly #origins: Database
  readonly #collection: ReturnType<typeof startUsageCollection>
  constructor(
    readonly store: FileUsageStore,
    readonly boundary: WatchBoundary,
    audits: readonly (readonly [string, string])[],
  ) {
    const path = qianmoConfigPath('watch', 'tasks.sqlite')
    this.#origins = new Database(path, { create: true, strict: true })
    chmodSync(path, 0o600)
    this.#origins.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, job TEXT NOT NULL, target TEXT NOT NULL, tenant TEXT)',
    )
    const sources: ConsoleAuditSource[] = audits.map(([node, path]) => {
      const audit = createAuditPort({ path, mirror: true })
      return {
        node,
        kind: 'mirror',
        audit: {
          ...audit,
          read: async filter => {
            const result = await audit.read(filter)
            if (!result.ok) return result
            return {
              ok: true,
              value: {
                ...result.value,
                records: result.value.records.filter(
                  row =>
                    row.taskId &&
                    this.origin(row.taskId) &&
                    assertAddress(this.origin(row.taskId)!.target).node ===
                      node,
                ),
              },
            }
          },
        },
      }
    })
    this.#collection = startUsageCollection(store, sources, error => {
      process.stderr.write(`[watch] usage audit: ${String(error)}\n`)
    })
  }
  static async open(
    boundary: WatchBoundary,
    jobs: readonly ScheduledJob[],
    policy?: string,
    audits: readonly (readonly [string, string])[] = [],
  ) {
    const ttl =
      jobs.reduce((max, job) => Math.max(max, job.taskTtlMs), 3_600_000) +
      30_000
    if (!Number.isSafeInteger(Date.now() + ttl))
      throw new Error('watch reservation TTL overflows')
    const store = new FileUsageStore({
      path: qianmoConfigPath('watch', 'usage.ndjson'),
      policy: loadUsagePolicy(policy),
      reservationTtlMs: ttl,
    })
    const snapshot = await store.read()
    if (snapshot.problem) {
      store.close()
      throw new Error(snapshot.problem)
    }
    try {
      return new WatchUsage(store, boundary, audits)
    } catch (error) {
      store.close()
      throw error
    }
  }
  origin(taskId: string): Origin | undefined {
    const origin = this.#origins
      .query<Origin, [string]>('SELECT job,target,tenant FROM tasks WHERE id=?')
      .get(taskId)
    const scope = this.store.taskScope(taskId)
    return origin &&
      scope?.kind === 'job' &&
      scope.subject === origin.job &&
      (scope.tenant ?? null) === origin.tenant
      ? origin
      : undefined
  }
  bind(reservationId: string, message: QianmoMessage, scope: UsageScope): void {
    this.#origins
      .query('INSERT INTO tasks(id,job,target,tenant) VALUES (?,?,?,?)')
      .run(message.taskId, scope.subject, message.to, scope.tenant ?? null)
    this.store.bindTask(
      reservationId,
      message.taskId,
      assertAddress(message.to).node,
    )
  }
  /** Caller must first pass WatchBoundary.inbound with the actual connection. */
  result(message: QianmoMessage): void {
    if (
      message.type !== MessageType.TaskResult ||
      !isTaskResultPayload(message.payload)
    )
      return
    const origin = this.origin(message.taskId)
    const job = this.boundary.jobs.find(job => job.id === origin?.job)
    const current = job ? this.boundary.scope(job) : undefined
    if (
      origin &&
      current &&
      (current.tenant ?? null) === origin.tenant &&
      origin.target === message.from &&
      origin.job === message.contextId
    )
      this.store.finishTask(message.taskId, assertAddress(message.from).node)
  }
  async snapshot(): Promise<void> {
    await this.#collection.tick()
    const path = watchUsageSnapshotPath()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${randomUUID()}.tmp`
    writeFileSync(
      temp,
      JSON.stringify({ observedAt: Date.now(), ...(await this.store.read()) }),
      { mode: 0o600, flag: 'wx' },
    )
    renameSync(temp, path)
  }
  close(): void {
    this.#collection.stop()
    this.#origins.close()
    this.store.close()
  }
}
