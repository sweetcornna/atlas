import { isValidAddress, isValidSegment } from "@qianmo/protocol";
import { systemClock, type Clock } from "./clock.ts";

/** How long a registration survives without a heartbeat. */
export const DEFAULT_TTL_MS = 90_000;

/** Maximum capabilities advertised by a single agent. */
export const MAX_CAPABILITIES = 64;

/** A live registration in the discovery table. */
export interface AgentRecord {
  /** Agent name, unique per registry. */
  readonly name: string;
  /** Where to reach the agent: a `qianmo://` address or an http(s) URL. */
  readonly endpoint: string;
  readonly capabilities: readonly string[];
  readonly registeredAt: number;
  readonly lastHeartbeatAt: number;
  /** Instant after which the entry is considered offline. */
  readonly expiresAt: number;
}

/** Failure modes of the registry, mapped 1:1 onto HTTP status codes. */
export enum RegistryErrorCode {
  E_BAD_REQUEST = "E_BAD_REQUEST",
  E_CONFLICT = "E_CONFLICT",
  E_NOT_FOUND = "E_NOT_FOUND",
}

export type RegisterResult =
  | { readonly ok: true; readonly created: boolean; readonly entry: AgentRecord }
  | { readonly ok: false; readonly code: RegistryErrorCode; readonly message: string };

export interface RegistryOptions {
  /** Entry lifetime in milliseconds. */
  readonly ttlMs?: number;
  readonly clock?: Clock;
}

/** True when `value` can be dialled: a Qianmo address or an http(s) URL. */
export function isValidEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  if (isValidAddress(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normaliseCapabilities(value: unknown): readonly string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const items: readonly unknown[] = value;
  if (items.length > MAX_CAPABILITIES) return null;
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string" || item.length === 0 || item.length > 64) return null;
    out.push(item);
  }
  return out;
}

/**
 * Process-local registration and discovery table.
 *
 * Entries expire `ttlMs` after their last heartbeat; expiry is evaluated
 * lazily on read, so no timer is needed and tests can drive a `ManualClock`.
 */
export class InMemoryRegistry {
  readonly #entries = new Map<string, AgentRecord>();
  readonly #ttlMs: number;
  readonly #clock: Clock;

  constructor(options: RegistryOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#clock = options.clock ?? systemClock;
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  /** Number of live entries, expired ones excluded. */
  get size(): number {
    return this.list().length;
  }

  /**
   * Add or refresh a registration.
   *
   * Re-registering the same name with the same endpoint refreshes the lease;
   * a different endpoint for a still-live name is a conflict, so that a
   * restarted agent cannot be silently hijacked by another process.
   */
  register(name: unknown, endpoint: unknown, capabilities?: unknown): RegisterResult {
    if (!isValidSegment(name)) {
      return {
        ok: false,
        code: RegistryErrorCode.E_BAD_REQUEST,
        message: `invalid agent name: ${String(name)}`,
      };
    }
    if (!isValidEndpoint(endpoint)) {
      return {
        ok: false,
        code: RegistryErrorCode.E_BAD_REQUEST,
        message: `invalid endpoint: ${String(endpoint)}`,
      };
    }
    const caps = normaliseCapabilities(capabilities);
    if (caps === null) {
      return {
        ok: false,
        code: RegistryErrorCode.E_BAD_REQUEST,
        message: "capabilities must be an array of non-empty strings",
      };
    }

    const now = this.#clock.now();
    const existing = this.#live(name, now);
    if (existing !== null && existing.endpoint !== endpoint) {
      return {
        ok: false,
        code: RegistryErrorCode.E_CONFLICT,
        message: `agent ${name} is already registered at ${existing.endpoint}`,
      };
    }

    const entry: AgentRecord = {
      name,
      endpoint,
      capabilities: caps,
      registeredAt: existing?.registeredAt ?? now,
      lastHeartbeatAt: now,
      expiresAt: now + this.#ttlMs,
    };
    this.#entries.set(name, entry);
    return { ok: true, created: existing === null, entry };
  }

  /** Look up one agent; `null` when unknown or expired. */
  resolve(name: string): AgentRecord | null {
    return this.#live(name, this.#clock.now());
  }

  /** Every live agent, ordered by name. */
  list(): readonly AgentRecord[] {
    const now = this.#clock.now();
    const live: AgentRecord[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.expiresAt >= now) live.push(entry);
    }
    return live.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Remove an agent. `false` when it was unknown or already expired. */
  deregister(name: string): boolean {
    const existed = this.#live(name, this.#clock.now()) !== null;
    this.#entries.delete(name);
    return existed;
  }

  /** Extend a lease. `null` when the agent is unknown or already expired. */
  heartbeat(name: string): AgentRecord | null {
    const now = this.#clock.now();
    const existing = this.#live(name, now);
    if (existing === null) return null;

    const entry: AgentRecord = {
      ...existing,
      lastHeartbeatAt: now,
      expiresAt: now + this.#ttlMs,
    };
    this.#entries.set(name, entry);
    return entry;
  }

  /** Drop expired entries eagerly; returns how many were removed. */
  prune(): number {
    const now = this.#clock.now();
    let removed = 0;
    for (const [name, entry] of this.#entries) {
      if (entry.expiresAt < now) {
        this.#entries.delete(name);
        removed += 1;
      }
    }
    return removed;
  }

  /** Forget everything. Test helper. */
  clear(): void {
    this.#entries.clear();
  }

  #live(name: string, now: number): AgentRecord | null {
    const entry = this.#entries.get(name);
    if (entry === undefined) return null;
    if (entry.expiresAt < now) {
      this.#entries.delete(name);
      return null;
    }
    return entry;
  }
}
