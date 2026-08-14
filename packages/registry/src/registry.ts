// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import {
  ProtocolError,
  TimeJumpGate,
  isNodePublicKey,
  assertAddress,
  formatAddress,
  isValidAddress,
  parseAddress,
  type QianmoAddress,
  type TimeJumpObservation,
} from '@qianmo/protocol'
import { systemClock, type Clock } from './clock.js'
import type { RegistryStore } from './store.js'

/** How long a registration survives without a heartbeat. */
export const DEFAULT_TTL_MS = 90_000

/**
 * Schema version of the persisted table.
 *
 * A document carrying any other version is ignored wholesale rather than
 * read optimistically: a future field the current code silently drops is a
 * far worse failure than one round of re-registration.
 */
export const REGISTRY_SNAPSHOT_VERSION = 1

/** Maximum capabilities advertised by a single agent. */
export const MAX_CAPABILITIES = 64

/**
 * Lifecycle state of a registration (roadmap P2.1: 在线 / 休眠 / 离线).
 *
 * Only the first two are ever *declared* by an agent — see
 * {@link DeclaredStatus}. `offline` is derived from the clock by
 * {@link InMemoryRegistry.statusOf}: an agent goes offline by falling silent,
 * not by saying so, otherwise a crashed node would stay "online" forever.
 */
export enum AgentStatus {
  /** Live lease; the agent is serving. */
  Online = 'online',
  /** Live lease, but the agent has parked itself — wake it before dispatch. */
  Dormant = 'dormant',
  /** Lease expired, or the address was never registered. Never stored. */
  Offline = 'offline',
}

/** The subset of {@link AgentStatus} an agent may claim for itself. */
export type DeclaredStatus = AgentStatus.Online | AgentStatus.Dormant

const DECLARABLE: readonly DeclaredStatus[] = [
  AgentStatus.Online,
  AgentStatus.Dormant,
]

/**
 * A live registration in the discovery table.
 *
 * Keyed by the composite `<node>/<agent>` derived from {@link address}
 * (protocol.md §2.4 A-3), so two nodes may each run a `reviewer` without
 * colliding.
 */
export interface AgentRecord {
  /** Canonical `qianmo://<node>/<agent>` address; unique per registry. */
  readonly address: string
  /** Where to reach the agent: a `qianmo://` address or an http(s)/ws(s) URL. */
  readonly endpoint: string
  readonly capabilities: readonly string[]
  /**
   * Ed25519 public key of the **node** hosting this agent, base64url
   * unpadded (protocol.md §10.1). Every agent on one node republishes that
   * one node key; it is absent until capability signing lands (P4.3).
   */
  readonly publicKey?: string
  /** Last state the agent declared. Never `offline` — see {@link AgentStatus}. */
  readonly status: DeclaredStatus
  readonly registeredAt: number
  readonly lastHeartbeatAt: number
  /** Instant after which the entry is considered offline. */
  readonly expiresAt: number
}

/** Failure modes of the registry, mapped 1:1 onto HTTP status codes. */
export enum RegistryErrorCode {
  E_BAD_REQUEST = 'E_BAD_REQUEST',
  E_CONFLICT = 'E_CONFLICT',
  E_NOT_FOUND = 'E_NOT_FOUND',
}

export type RegisterResult =
  | {
      readonly ok: true
      readonly created: boolean
      readonly entry: AgentRecord
    }
  | {
      readonly ok: false
      readonly code: RegistryErrorCode
      readonly message: string
    }

/**
 * What an agent declares about itself on top of its address and endpoint.
 *
 * Fields are `unknown` because they arrive straight off the HTTP surface and
 * are validated here, at the trust boundary.
 */
export interface RegisterInput {
  readonly capabilities?: unknown
  readonly publicKey?: unknown
  readonly status?: unknown
}

export interface RegistryOptions {
  /** Entry lifetime in milliseconds. */
  readonly ttlMs?: number
  readonly clock?: Clock
  /**
   * Durable backing for the table, read once at construction and rewritten
   * after every change. Omit for a purely in-process registry — persistence is
   * opt-in so that constructing a registry never touches the user's config
   * root by surprise.
   */
  readonly store?: RegistryStore
  /**
   * Called when {@link RegistryStore.write} throws.
   *
   * Persistence failures do not fail the operation that triggered them: the
   * in-memory table stays authoritative for this process and every entry is
   * re-announced within one TTL, so a full disk should cost durability, not
   * availability. Without this hook that trade-off would be silent.
   */
  readonly onPersistError?: (error: unknown) => void
}

/**
 * True when `value` can be dialled: a Qianmo address, or an http(s)/ws(s) URL.
 *
 * `wss:` is here because the node-to-node transport is a single wss long
 * connection (selection-m0 §4) — without it a node could not publish the
 * endpoint peers are meant to dial. `ws:` rides along for local integration
 * tests; production nodes register `wss:` (charter N-3 keeps TLS in M0).
 *
 * `ws+unix:` is the shape `@qianmo/transport`'s own `dialUrl({unix})` emits,
 * and roadmap P2.2 fixes unix sockets as *the* transport for single-machine
 * integration runs. Refusing it left the one endpoint form those runs need as
 * the only one a node could not publish — which forced tests to register a
 * placeholder URL and derive the socket elsewhere, i.e. to stop exercising the
 * resolve→dial path they exist to cover. A unix endpoint is reachable only
 * from the same host; that is a property of the deployment, and it fails loudly
 * at dial time rather than silently, so it is not the validator's to police.
 */
export function isValidEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512)
    return false
  if (isValidAddress(value)) return true
  try {
    const url = new URL(value)
    return (
      url.protocol === 'http:' ||
      url.protocol === 'https:' ||
      url.protocol === 'ws:' ||
      url.protocol === 'wss:' ||
      url.protocol === 'ws+unix:'
    )
  } catch {
    return false
  }
}

/**
 * True when `value` is a base64url-encoded Ed25519 public key.
 *
 * The encoding itself is defined once, in `@qianmo/protocol` (§10.1 says so in
 * as many words): a registry that accepted a shape the verifier rejects would
 * publish keys nobody can use, and the failure would surface as "signatures
 * stopped verifying" rather than as "these two regexes disagree".
 */
export function isValidPublicKey(value: unknown): value is string {
  return isNodePublicKey(value)
}

/**
 * The table key for an address: `<node>/<agent>`, one flat map, no per-node
 * partitioning (protocol.md §2.4).
 */
function keyOf(address: QianmoAddress): string {
  return `${address.node}/${address.agent}`
}

/** Key for a raw address, or `null` when it is not a well-formed address. */
function keyOfRaw(raw: unknown): string | null {
  const parsed = parseAddress(raw)
  return parsed === null ? null : keyOf(parsed)
}

function normaliseCapabilities(value: unknown): readonly string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const items: readonly unknown[] = value
  if (items.length > MAX_CAPABILITIES) return null
  const out: string[] = []
  for (const item of items) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 64)
      return null
    out.push(item)
  }
  return out
}

/** `online` when unset; `null` when the value is not a declarable status. */
function normaliseStatus(value: unknown): DeclaredStatus | null {
  if (value === undefined) return AgentStatus.Online
  return DECLARABLE.find(candidate => candidate === value) ?? null
}

/** `null` unless `value` is a real, finite number. */
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * One agent as it appears in the persisted document.
 *
 * `expiresAt` is absent on purpose. It is a *derived* fact — `lastHeartbeatAt`
 * plus the TTL in force — and writing it down would let a stored deadline
 * outlive the configuration that produced it: restart with a shorter `ttlMs`
 * and the old, longer lease would keep a silent agent listed as online. What is
 * stored is only what was observed.
 */
interface PersistedAgent {
  readonly address: string
  readonly endpoint: string
  readonly capabilities: readonly string[]
  readonly publicKey?: string
  readonly status: DeclaredStatus
  readonly registeredAt: number
  readonly lastHeartbeatAt: number
}

function toPersisted(entry: AgentRecord): PersistedAgent {
  return {
    address: entry.address,
    endpoint: entry.endpoint,
    capabilities: [...entry.capabilities],
    publicKey: entry.publicKey,
    status: entry.status,
    registeredAt: entry.registeredAt,
    lastHeartbeatAt: entry.lastHeartbeatAt,
  }
}

/**
 * Rebuild one entry from the persisted document, or `null` if it is unusable.
 *
 * Everything here arrives off disk, which is a trust boundary just like the
 * HTTP surface: the file is editable by the account running the node, and may
 * equally be a leftover from an older schema. So each field goes through
 * the same validators {@link InMemoryRegistry.register} uses, and a record that
 * fails any of them is dropped rather than repaired — a discovery table would
 * rather forget an agent (it re-registers) than hand out a bad endpoint.
 */
function restoreEntry(
  value: unknown,
  ttlMs: number,
): { readonly key: string; readonly entry: AgentRecord } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null
  const raw = value as Record<string, unknown>

  const parsed = parseAddress(raw['address'])
  if (parsed === null) return null
  const endpoint = raw['endpoint']
  if (!isValidEndpoint(endpoint)) return null
  const capabilities = normaliseCapabilities(raw['capabilities'])
  if (capabilities === null) return null
  const publicKey = raw['publicKey']
  if (publicKey !== undefined && !isValidPublicKey(publicKey)) return null
  const status = normaliseStatus(raw['status'])
  if (status === null) return null
  const lastHeartbeatAt = finiteNumber(raw['lastHeartbeatAt'])
  if (lastHeartbeatAt === null) return null
  const registeredAt = finiteNumber(raw['registeredAt']) ?? lastHeartbeatAt

  return {
    key: keyOf(parsed),
    entry: {
      address: formatAddress(parsed),
      endpoint,
      capabilities,
      publicKey,
      status,
      registeredAt,
      lastHeartbeatAt,
      expiresAt: lastHeartbeatAt + ttlMs,
    },
  }
}

/** The `agents` array of a snapshot at the version we understand, else `null`. */
function readSnapshot(document: unknown): readonly unknown[] | null {
  if (
    typeof document !== 'object' ||
    document === null ||
    Array.isArray(document)
  )
    return null
  const raw = document as Record<string, unknown>
  if (raw['version'] !== REGISTRY_SNAPSHOT_VERSION) return null
  const agents = raw['agents']
  return Array.isArray(agents) ? (agents as readonly unknown[]) : null
}

/**
 * Registration and discovery table, served entirely from memory.
 *
 * Every entry point takes a full `qianmo://<node>/<agent>` address — there is
 * deliberately no second form (protocol.md §2.4 A-3). Entries expire `ttlMs`
 * after their last heartbeat; expiry is evaluated lazily on read, so no timer
 * is needed and tests can drive a `ManualClock`.
 *
 * Given a {@link RegistryOptions.store} the map is mirrored to durable storage
 * after every change and read back at construction, so the table survives a
 * restart of the registry process (roadmap P2.1 DoD). The map stays the serving
 * path either way — the store is write-through, never on a lookup.
 *
 * **Leases are re-judged against the clock on restore, not trusted.** A
 * registry that was down for an hour comes back with an hour-old file, and
 * every agent in it has been unreachable for that hour; replaying those
 * records as-is would mean answering lookups with addresses that stopped
 * answering long ago.
 */
export class InMemoryRegistry {
  readonly #entries = new Map<string, AgentRecord>()
  readonly #ttlMs: number
  readonly #clock: Clock
  readonly #store: RegistryStore | null
  readonly #onPersistError: ((error: unknown) => void) | undefined
  #timeJumpGate: TimeJumpGate | null = null

  constructor(options: RegistryOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.#clock = options.clock ?? systemClock
    this.#store = options.store ?? null
    this.#onPersistError = options.onPersistError
    if (this.#store !== null) this.#restore(this.#store.read())
  }

  get ttlMs(): number {
    return this.#ttlMs
  }

  observeClock(periodMs: number): TimeJumpObservation {
    this.#timeJumpGate ??= new TimeJumpGate({ periodMs })
    const now = this.#clock.now()
    const observation = this.#timeJumpGate.observe(now)
    if (!observation.jumped) return observation
    for (const [key, entry] of this.#entries) {
      this.#entries.set(key, {
        ...entry,
        expiresAt: this.#timeJumpGate.rebase(entry.expiresAt, observation),
      })
    }
    this.#persist()
    return observation
  }

  /** Number of live entries, expired ones excluded. */
  get size(): number {
    return this.list().length
  }

  /**
   * Add or refresh a registration.
   *
   * Re-registering the same address with the same endpoint refreshes the
   * lease; a different endpoint for a still-live address is a conflict, so
   * that a restarted agent cannot be silently hijacked by another process.
   * Two nodes registering the same agent name are *not* in conflict: they are
   * different addresses, hence different keys.
   *
   * Each call is a complete declaration — capabilities, public key and status
   * are replaced, not merged, so omitting one clears it.
   */
  register(
    address: unknown,
    endpoint: unknown,
    input: RegisterInput = {},
  ): RegisterResult {
    let parsed: QianmoAddress
    try {
      parsed = assertAddress(address, 'address')
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error
      return {
        ok: false,
        code: RegistryErrorCode.E_BAD_REQUEST,
        message: error.message,
      }
    }
    if (!isValidEndpoint(endpoint)) {
      return {
        ok: false,
        code: RegistryErrorCode.E_BAD_REQUEST,
        message: `invalid endpoint: ${String(endpoint)}`,
      }
    }
    const caps = normaliseCapabilities(input.capabilities)
    if (caps === null) {
      return {
        ok: false,
        code: RegistryErrorCode.E_BAD_REQUEST,
        message: 'capabilities must be an array of non-empty strings',
      }
    }
    const publicKey = input.publicKey
    if (publicKey !== undefined && !isValidPublicKey(publicKey)) {
      return {
        ok: false,
        code: RegistryErrorCode.E_BAD_REQUEST,
        message: 'publicKey must be a base64url Ed25519 key',
      }
    }
    const status = normaliseStatus(input.status)
    if (status === null) {
      return {
        ok: false,
        code: RegistryErrorCode.E_BAD_REQUEST,
        // `offline` is derived from the lease, so it cannot be declared:
        // an agent that wants to disappear deregisters or stops beating.
        message: `status must be one of: ${DECLARABLE.join(', ')}`,
      }
    }

    const canonical = formatAddress(parsed)
    const key = keyOf(parsed)
    const now = this.#clock.now()
    const existing = this.#live(key, now)
    if (existing !== null && existing.endpoint !== endpoint) {
      return {
        ok: false,
        code: RegistryErrorCode.E_CONFLICT,
        message: `${canonical} is already registered at ${existing.endpoint}`,
      }
    }
    const nodeKey = this.#nodeKeyOf(parsed.node, key, now)
    if (publicKey !== undefined && nodeKey !== null && nodeKey !== publicKey) {
      // protocol.md §10.1 says the key belongs to the **node**, while a record
      // belongs to an agent — so nothing but this check stops one node's agents
      // publishing two different keys. Left unchecked it would not fail here at
      // all: it would fail later, as signatures that verify for one agent and
      // not for another, which is a far harder thing to read.
      //
      // First live registration wins, and "live" is the whole rule: the key is
      // derived from the entries that still hold a lease, so once every agent
      // on a node has gone silent a restarted node with a new identity file is
      // free to publish again. No second table, nothing to keep in sync.
      return {
        ok: false,
        code: RegistryErrorCode.E_CONFLICT,
        message: `node ${parsed.node} already published a different public key`,
      }
    }

    const entry: AgentRecord = {
      address: canonical,
      endpoint,
      capabilities: caps,
      publicKey,
      status,
      registeredAt: existing?.registeredAt ?? now,
      lastHeartbeatAt: now,
      expiresAt: now + this.#ttlMs,
    }
    this.#entries.set(key, entry)
    this.#persist()
    return { ok: true, created: existing === null, entry }
  }

  /**
   * The public key this node's other live agents have already published.
   *
   * `exclude` is the entry being re-registered: an agent republishing its own
   * record must not collide with itself.
   */
  #nodeKeyOf(node: string, exclude: string, now: number): string | null {
    for (const [key, entry] of this.#entries) {
      if (key === exclude) continue
      if (!key.startsWith(`${node}/`)) continue
      if (entry.publicKey === undefined) continue
      if (entry.expiresAt <= now) continue
      return entry.publicKey
    }
    return null
  }

  /** Look up one agent by address; `null` when unknown, malformed or expired. */
  resolve(address: unknown): AgentRecord | null {
    const key = keyOfRaw(address)
    return key === null ? null : this.#live(key, this.#clock.now())
  }

  /**
   * Observed state of an address.
   *
   * `offline` covers "never registered", "malformed" and "lease ran out"
   * alike: from a caller's side they are the same fact — nothing there to
   * talk to (roadmap P2.1 DoD: 心跳超时后状态自动转 offline).
   */
  statusOf(address: unknown): AgentStatus {
    return this.resolve(address)?.status ?? AgentStatus.Offline
  }

  /** Every live agent, ordered by address. */
  list(): readonly AgentRecord[] {
    const now = this.#clock.now()
    const inGrace = this.#timeJumpGate?.inGrace(now) === true
    const live: AgentRecord[] = []
    for (const entry of this.#entries.values()) {
      if (inGrace || entry.expiresAt >= now) live.push(entry)
    }
    return live.sort((a, b) =>
      a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
    )
  }

  /** Remove an agent. `false` when it was unknown or already expired. */
  deregister(address: unknown): boolean {
    const key = keyOfRaw(address)
    if (key === null) return false
    const existed = this.#live(key, this.#clock.now()) !== null
    this.#entries.delete(key)
    if (existed) this.#persist()
    return existed
  }

  /** Extend a lease. `null` when the agent is unknown or already expired. */
  heartbeat(address: unknown): AgentRecord | null {
    const key = keyOfRaw(address)
    if (key === null) return null
    const now = this.#clock.now()
    const existing = this.#live(key, now)
    if (existing === null) return null

    const entry: AgentRecord = {
      ...existing,
      lastHeartbeatAt: now,
      expiresAt: now + this.#ttlMs,
    }
    this.#entries.set(key, entry)
    this.#persist()
    return entry
  }

  /** Drop expired entries eagerly; returns how many were removed. */
  prune(): number {
    const now = this.#clock.now()
    if (this.#timeJumpGate?.inGrace(now) === true) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt < now) {
        this.#entries.delete(key)
        removed += 1
      }
    }
    if (removed > 0) this.#persist()
    return removed
  }

  /** Forget everything, persisted copy included. Test helper. */
  clear(): void {
    this.#entries.clear()
    this.#persist()
  }

  #live(key: string, now: number): AgentRecord | null {
    const entry = this.#entries.get(key)
    if (entry === undefined) return null
    if (this.#timeJumpGate?.inGrace(now) === true) return entry
    if (entry.expiresAt < now) {
      this.#entries.delete(key)
      return null
    }
    return entry
  }

  /**
   * Seed the table from a persisted document.
   *
   * Expired leases are dropped here rather than left for the lazy check, so
   * that a restored table never *starts* holding records nothing will ever ask
   * about again.
   */
  #restore(document: unknown): void {
    const agents = readSnapshot(document)
    if (agents === null) return
    const now = this.#clock.now()
    for (const candidate of agents) {
      const restored = restoreEntry(candidate, this.#ttlMs)
      if (restored === null) continue
      if (restored.entry.expiresAt < now) continue
      this.#entries.set(restored.key, restored.entry)
    }
  }

  /**
   * Mirror the whole table to the store.
   *
   * Rewriting everything rather than appending a delta is what makes the store
   * contract a single atomic file swap; at M0's scale (one node, tens of
   * agents, a heartbeat every TTL) the table is a few kilobytes.
   *
   * Expired-but-not-yet-evicted rows ride along unchanged — {@link #restore}
   * re-judges every lease against the clock, so the deadline never has to be
   * accurate on disk, only recoverable.
   */
  #persist(): void {
    const store = this.#store
    if (store === null) return
    try {
      store.write({
        version: REGISTRY_SNAPSHOT_VERSION,
        agents: [...this.#entries.values()].map(toPersisted),
      })
    } catch (error) {
      this.#onPersistError?.(error)
    }
  }
}
