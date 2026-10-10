// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SQL } from 'bun'
import { createRegistryHandler } from './http.js'
import {
  DEFAULT_TTL_MS,
  InMemoryRegistry,
  REGISTRY_SNAPSHOT_VERSION,
} from './registry.js'
import type { RegistryStore } from './store.js'
import { assertRegistryWriteToken, registryWriteTokenMatches } from './token.js'

const MAX_BODY_BYTES = 1024 * 1024

class TransactionDocument implements RegistryStore {
  dirty = false
  constructor(public value: unknown) {}
  read(): unknown {
    return this.value
  }
  write(document: unknown): void {
    this.value = document
    this.dirty = true
  }
}

export interface PostgresRegistryOptions {
  /** A managed HA PostgreSQL endpoint in production. Never logged. */
  readonly databaseUrl: string
  readonly namespace?: string
  readonly writeToken: string
  readonly ttlMs?: number
}

function failure(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}

/** API replicas serialize one registry transaction on the shared row. There is
 * no process cache and no success response before COMMIT. PostgreSQL owns the
 * clock, locks and failover; API replicas never elect themselves database leaders.
 */
export class PostgresRegistry {
  readonly #sql: SQL
  readonly #namespace: string
  readonly #writeToken: string
  readonly #ttlMs: number

  constructor(options: PostgresRegistryOptions) {
    assertRegistryWriteToken(options.writeToken, 'registry write token')
    let url: URL
    try {
      url = new URL(options.databaseUrl)
    } catch {
      throw new Error('registry database URL is invalid')
    }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
      throw new Error('registry database must use PostgreSQL')
    }
    this.#namespace = options.namespace ?? 'default'
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(this.#namespace)) {
      throw new Error('registry namespace must be 1–64 letters, digits, _ or -')
    }
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1) {
      throw new Error('registry TTL must be a positive integer')
    }
    this.#writeToken = options.writeToken
    this.#sql = new SQL(options.databaseUrl, {
      max: 8,
      connectionTimeout: 5,
      idleTimeout: 30,
    })
  }

  /** Explicit bootstrap, not an implicit fallback to empty state on DB errors. */
  async initialize(): Promise<void> {
    await this.#sql`
      CREATE TABLE IF NOT EXISTS qianmo_registry_state (
        namespace text PRIMARY KEY,
        schema_version integer NOT NULL,
        ttl_ms bigint NOT NULL,
        agents jsonb NOT NULL,
        revocation_list jsonb,
        revision bigint NOT NULL DEFAULT 0
      )`
    const initial = {
      version: REGISTRY_SNAPSHOT_VERSION,
      agents: [],
    }
    await this.#sql`
      INSERT INTO qianmo_registry_state
        (namespace, schema_version, ttl_ms, agents)
      VALUES (${this.#namespace}, 1, ${this.#ttlMs}, ${initial}::jsonb)
      ON CONFLICT (namespace) DO NOTHING`
    const [row] = await this.#sql`
      SELECT schema_version, ttl_ms FROM qianmo_registry_state
      WHERE namespace = ${this.#namespace}`
    if (row?.schema_version !== 1 || Number(row?.ttl_ms) !== this.#ttlMs) {
      throw new Error('registry schema or TTL differs from shared database')
    }
  }

  async close(): Promise<void> {
    await this.#sql.close()
  }

  async fetch(request: Request): Promise<Response> {
    const writes = !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    if (writes) {
      const header = request.headers.get('authorization') ?? ''
      const token = header.startsWith('Bearer ') ? header.slice(7) : ''
      if (!registryWriteTokenMatches(token, this.#writeToken)) {
        return failure(
          401,
          'E_UNAUTHORIZED',
          'registry writes require the write token',
        )
      }
    }
    // Consume a bounded body before taking the cluster lock. Slow clients do
    // not hold the shared transaction; the server's idle timeout bounds reading.
    let bounded = request
    if (request.body !== null) {
      const reader = request.body.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          bytes += part.value.byteLength
          if (bytes > MAX_BODY_BYTES) {
            await reader.cancel()
            return failure(413, 'E_BAD_REQUEST', 'registry body exceeds 1 MiB')
          }
          chunks.push(part.value)
        }
      } catch {
        return failure(400, 'E_BAD_REQUEST', 'registry body could not be read')
      } finally {
        reader.releaseLock()
      }
      bounded = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: new Blob(chunks),
      })
    }
    try {
      return await this.#sql.begin(async tx => {
        await tx`SET LOCAL lock_timeout = '2s'`
        await tx`SET LOCAL statement_timeout = '5s'`
        const [row] = await tx`
          SELECT schema_version, ttl_ms, agents, revocation_list
          FROM qianmo_registry_state WHERE namespace = ${this.#namespace}
          FOR UPDATE`
        const [time] =
          await tx`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms`
        const snapshot = row?.agents
        if (
          row?.schema_version !== 1 ||
          Number(row?.ttl_ms) !== this.#ttlMs ||
          typeof snapshot !== 'object' ||
          snapshot === null ||
          snapshot.version !== REGISTRY_SNAPSHOT_VERSION ||
          !Array.isArray(snapshot.agents)
        )
          throw new Error('registry state is incompatible')
        const store = new TransactionDocument(snapshot)
        const revocations = new TransactionDocument(row.revocation_list)
        const table = new InMemoryRegistry({
          store,
          revocationListStore: revocations,
          ttlMs: this.#ttlMs,
          clock: { now: () => Number(time.now_ms) },
        })
        table.prune()
        const response = await createRegistryHandler(table, {
          writeToken: this.#writeToken,
        })(bounded)
        if (store.dirty || revocations.dirty) {
          await tx`
            UPDATE qianmo_registry_state
            SET agents = ${store.value}::jsonb,
              revocation_list = ${revocations.value}::jsonb,
              revision = revision + 1
            WHERE namespace = ${this.#namespace}`
        }
        return response
      })
    } catch {
      // SQL errors may contain credentials or record contents. The caller
      // receives a stable retryable error, never an old in-memory success.
      return failure(503, 'E_STORAGE', 'registry storage is unavailable')
    }
  }
}
