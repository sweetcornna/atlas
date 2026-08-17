// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * Everything the console reads or acts on, expressed as ports.
 *
 * The console package is a leaf: it never imports the host's `src/`, never
 * opens the audit file itself and never talks to a socket on its own. The CLI
 * handler that starts it (`occ console`) is the only place that knows where the
 * registry lives, which trail file to read and how to send a wake — it injects
 * those here. That keeps this package testable with plain objects and keeps the
 * host's dependency direction pointing inward, the same rule the tool-runtime
 * facades follow (root CLAUDE.md, "Host facade 模式").
 *
 * Every port returns data or a typed failure. None of them throw for an
 * expected condition — a console that 500s because the registry is down is
 * worse than one that renders "注册中心不可达" next to the rest of the page.
 */

import type { AuditRecord, MessageChain } from '@qianmo/audit'

/** One agent as the registry reports it (registry HTTP v0 `AgentBody`). */
export interface ConsoleAgent {
  readonly address: string
  readonly endpoint: string
  readonly capabilities: readonly string[]
  /** Absent until the node publishes one; never a private key. */
  readonly publicKey?: string
  readonly status: string
  readonly registeredAt: number
  readonly lastHeartbeatAt: number
  readonly expiresAt: number
}

/** Uniform failure shape for every port. `code` is for tests, not for users. */
export interface ConsoleFailure {
  readonly code:
    | 'unreachable'
    | 'rejected'
    | 'not_found'
    | 'unsupported'
    | 'invalid'
  readonly message: string
}

export type ConsoleResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ConsoleFailure }

/** Registration input accepted from the page — the reason the console exists. */
export interface RegisterAgentInput {
  readonly address: string
  readonly endpoint: string
  readonly capabilities?: readonly string[]
  readonly publicKey?: string
  readonly status?: string
}

/**
 * The registry face. Backed by HTTP v0 in production, by a fake in tests.
 * `list` is the only call the read-only view makes.
 */
export interface RegistryPort {
  list(): Promise<ConsoleResult<readonly ConsoleAgent[]>>
  register(input: RegisterAgentInput): Promise<ConsoleResult<ConsoleAgent>>
  deregister(address: string): Promise<ConsoleResult<void>>
  heartbeat(address: string): Promise<ConsoleResult<ConsoleAgent>>
}

/** What a trail read yields, integrity verdict included. */
export interface AuditPage {
  readonly records: readonly AuditRecord[]
  /** False when the hash chain is broken — surfaced, never swallowed. */
  readonly intact: boolean
  /** How many issues the reader found, whatever their kind. */
  readonly issueCount: number
  /** Total records in the trail before filtering, for "showing N of M". */
  readonly total: number
}

/** Filter accepted by the audit view; every field is optional and ANDed. */
export interface AuditFilter {
  readonly source?: string
  readonly outcome?: string
  readonly traceId?: string
  readonly taskId?: string
  readonly agent?: string
  readonly from?: number
  readonly to?: number
  /** Tail size. The port clamps it; the view never asks for the whole file. */
  readonly limit?: number
}

export interface AuditPort {
  read(filter: AuditFilter): Promise<ConsoleResult<AuditPage>>
  chain(traceId: string): Promise<ConsoleResult<MessageChain | null>>
}

/** A wake request as the page can express it. */
export interface WakeInput {
  readonly from: string
  readonly to: string
  readonly prompt: string
  readonly url: string
  readonly afterMs?: number
}

export interface WakeOutcome {
  readonly msgId: string
  readonly taskId: string
  readonly receipt: string
}

/**
 * Optional: absent when the console runs without a transport PSK, in which
 * case the page shows the wake form disabled with the reason, rather than
 * offering a button that always fails.
 */
export interface WakePort {
  send(input: WakeInput): Promise<ConsoleResult<WakeOutcome>>
}

/** Protocol/runtime ceilings, read from the packages that own them. */
export interface LimitsSnapshot {
  /** `@qianmo/protocol` LIMITS — the single source for protocol ceilings. */
  readonly protocol: {
    readonly maxMessageBytes: number
    readonly maxHops: number
    readonly defaultTtlMs: number
    readonly defaultTaskTtlMs: number
    readonly ratePerMinute: number
  }
  /**
   * `@qianmo/router` RUNTIME_RATE. Deliberately a separate column: the two
   * rate limits are structurally distinct and must not be shown as one number
   * (`packages/router/src/rate.ts` module note).
   */
  readonly runtime: {
    readonly capacity: number
    readonly windowMs: number
  }
  /** Registry lease TTL, so the roster's "expires" column has a scale. */
  readonly registryTtlMs: number
}

/** Everything a console instance needs. `wake` is the only optional port. */
export interface ConsoleDeps {
  readonly registry: RegistryPort
  readonly audit: AuditPort
  readonly limits: LimitsSnapshot
  readonly wake?: WakePort
  /** Injected for deterministic tests; defaults to `Date.now` at the edges. */
  readonly now?: () => number
  /** Shown in the page header so two consoles are never confused. */
  readonly label?: string
}
