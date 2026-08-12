// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import {
  ProtocolError,
  assertAddress,
  formatAddress,
  isValidAddress,
  parseAddress,
  type QianmoAddress,
} from '@qianmo/protocol'
import { systemClock, type Clock } from './clock.js'

/** How long a registration survives without a heartbeat. */
export const DEFAULT_TTL_MS = 90_000

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
 * Ed25519 public key, base64url without padding: 32 raw bytes → 43 chars.
 *
 * protocol.md §10.1 fixes the algorithm but not the encoding; base64url is
 * chosen to match RFC 8037 (the OKP `x` parameter), so the same string can be
 * dropped into the compact-JSON capability tokens that section describes.
 */
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/

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
}

/**
 * True when `value` can be dialled: a Qianmo address, or an http(s)/ws(s) URL.
 *
 * `wss:` is here because the node-to-node transport is a single wss long
 * connection (selection-m0 §4) — without it a node could not publish the
 * endpoint peers are meant to dial. `ws:` rides along for local integration
 * tests; production nodes register `wss:` (charter N-3 keeps TLS in M0).
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
      url.protocol === 'wss:'
    )
  } catch {
    return false
  }
}

/** True when `value` is a base64url-encoded Ed25519 public key. */
export function isValidPublicKey(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_KEY_PATTERN.test(value)
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

/**
 * Process-local registration and discovery table.
 *
 * Every entry point takes a full `qianmo://<node>/<agent>` address — there is
 * deliberately no second form (protocol.md §2.4 A-3). Entries expire `ttlMs`
 * after their last heartbeat; expiry is evaluated lazily on read, so no timer
 * is needed and tests can drive a `ManualClock`.
 */
export class InMemoryRegistry {
  readonly #entries = new Map<string, AgentRecord>()
  readonly #ttlMs: number
  readonly #clock: Clock

  constructor(options: RegistryOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.#clock = options.clock ?? systemClock
  }

  get ttlMs(): number {
    return this.#ttlMs
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
    return { ok: true, created: existing === null, entry }
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
    const live: AgentRecord[] = []
    for (const entry of this.#entries.values()) {
      if (entry.expiresAt >= now) live.push(entry)
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
    return entry
  }

  /** Drop expired entries eagerly; returns how many were removed. */
  prune(): number {
    const now = this.#clock.now()
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt < now) {
        this.#entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  /** Forget everything. Test helper. */
  clear(): void {
    this.#entries.clear()
  }

  #live(key: string, now: number): AgentRecord | null {
    const entry = this.#entries.get(key)
    if (entry === undefined) return null
    if (entry.expiresAt < now) {
      this.#entries.delete(key)
      return null
    }
    return entry
  }
}
