// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ConsolePrincipal } from './contracts.js'
import type { ConsoleResult } from './contracts.js'

/** Provider tokens, not a provider's ambiguous totalTokens. */
export interface TokenColumns {
  readonly input: number
  readonly output: number
  readonly cacheWrite: number
  readonly cacheRead: number
}

export interface UsageScope {
  readonly subject: string
  readonly kind: 'person' | 'job'
  readonly tenant?: string
}

export interface UsageLimits {
  readonly messages?: number
  readonly wakes?: number
  readonly tokens?: number
  readonly inFlight?: number
  readonly sessions?: number
}

export interface UsagePolicy {
  readonly mode: 'shadow' | 'enforce'
  readonly person: UsageLimits
  readonly job: UsageLimits
  readonly global: UsageLimits
  readonly tenants?: Readonly<Record<string, UsageLimits>>
}

export interface UsageRow extends TokenColumns {
  readonly messages: number
  readonly wakes: number
  readonly bucket: string
  readonly day: string
  readonly charged: number
  readonly inFlight: number
  readonly sessions: number
  readonly limits: UsageLimits
}

export interface UsageSnapshot {
  readonly mode: UsagePolicy['mode']
  readonly day: string
  readonly resetsAt: number
  readonly lowerBound: true
  readonly problem: string | null
  readonly rows: readonly UsageRow[]
}

export type UsageAdmission =
  | {
      readonly ok: true
      readonly reservationId: string
      readonly shadowExceeded: readonly string[]
    }
  | {
      readonly ok: false
      readonly reason: 'quota' | 'unavailable'
      readonly snapshot: UsageSnapshot
    }

/** Scope is chosen by the authenticated host, never by request JSON. */
export interface UsagePort {
  read(subject?: string): Promise<UsageSnapshot>
  reserve(
    scope: UsageScope,
    input?: {
      readonly sessionId?: string
      readonly newSession?: boolean
      readonly operation?: 'message' | 'wake' | 'session'
    },
  ): UsageAdmission
  finish(reservationId: string, usage?: TokenColumns): void
  bindTask(reservationId: string, taskId: string, node?: string): void
  adoptSession(reservationId: string, sessionId: string): void
  finishTask(taskId: string, node?: string): void
  recordTask(
    eventId: string,
    taskId: string,
    usage: TokenColumns,
    observedAt?: number,
    node?: string,
  ): void
  closeSession(scope: UsageScope, sessionId: string): void
  /** Idempotent observation of one node/turn or audit event. */
  record(
    eventId: string,
    scope: UsageScope,
    usage: TokenColumns,
    observedAt?: number,
  ): void
}

export interface ApprovalItem {
  readonly requestId: string
  readonly node: string
  readonly agent: string
  readonly contextId: string
  readonly owner: string | null
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
  readonly digest: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly continuation?: 'reserved' | 'sent'
  readonly origin?: {
    readonly from: string | null
    readonly taskId: string | null
    readonly traceId: string | null
    readonly trust: string
  }
  readonly status:
    | 'pending'
    | 'allowed'
    | 'denied'
    | 'expired'
    | 'delivery-unknown'
}

export interface ApprovalDecisionInput {
  readonly requestId: string
  readonly digest: string
  readonly decision: 'allow-once' | 'allow-window' | 'deny'
  readonly windowMs?: number
}

export type ApprovalContinueResult =
  | ConsoleResult<{ readonly sessionId: string; readonly taskId: string }>
  | {
      readonly ok: false
      readonly quota: Extract<UsageAdmission, { readonly ok: false }>
    }

/** The host rechecks ownership, credential freshness and digest on every call. */
export interface ApprovalPort {
  continue?(
    principal: ConsolePrincipal,
    input: { readonly requestId: string; readonly digest: string },
  ): Promise<ApprovalContinueResult>
  list(
    principal: ConsolePrincipal,
  ): Promise<ConsoleResult<readonly ApprovalItem[]>>
  decide(
    principal: ConsolePrincipal,
    input: ApprovalDecisionInput,
  ): Promise<ConsoleResult<{ readonly delivered: boolean }>>
  revoke(
    principal: ConsolePrincipal,
    requestId: string,
  ): Promise<ConsoleResult<{ readonly delivered: boolean }>>
}
