// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the client hands back, normalised from magpie's own JSON.
 *
 * Every shape below is read defensively out of a response a remote process
 * wrote: a field magpie leaves out reads as its zero, a field of the wrong
 * type is the same as absent, and nothing here ever carries a secret value —
 * magpie's lists mask keys themselves and the client drops the one field
 * (`secret`) that would not be masked.
 */

/** magpie's usage windows (`internal/usage/usage.go` `Period`). */
export const MAGPIE_PERIODS = ['today', '7d', '30d', 'all'] as const
export type MagpiePeriod = (typeof MAGPIE_PERIODS)[number]

/** A gateway key's limit windows (`internal/access/limit.go` `Periods`). */
export const LIMIT_PERIODS = ['day', 'week', 'month', 'days', 'hours'] as const
export type MagpieLimitPeriod = (typeof LIMIT_PERIODS)[number]

/** At most this many limits per key (`access.MaxLimits`). */
export const MAX_KEY_LIMITS = 5

/**
 * Routing over a group's members (`internal/provider/routing.go`). `smart`
 * is magpie's empty string; the other names are magpie's own.
 */
export const GROUP_ROUTINGS = [
  'smart',
  'order',
  'rotate',
  'usage',
  'pace',
] as const
export type MagpieRouting = (typeof GROUP_ROUTINGS)[number]

/** How long a conversation stays with a member (`provider.Affinities`). */
export const GROUP_AFFINITIES = [
  'auto',
  'session',
  'turn',
  'off',
  'strict',
] as const
export type MagpieAffinity = (typeof GROUP_AFFINITIES)[number]

/**
 * How a provider reaches its vendor, as far as Qianmo's L-6 guard cares:
 *
 * - `key` — an API key (or none, for a local server): Qianmo may route to it;
 * - `account` — a signed-in subscription (`providerJSON.account`): never;
 * - `client` — requests go out as a vendor's own client (`ownClient`:
 *   OpenCode, Cline, Kilo, another magpie): never, it borrows an identity.
 */
export type MagpieAccess = 'key' | 'account' | 'client'

export interface MagpieHello {
  readonly name: 'magpie'
  readonly version: string
}

/** What the management side says about itself (`GET /api/settings`). */
export interface MagpieInfo {
  readonly version: string
  /** The gateway address as magpie itself names it, or null. */
  readonly gateway: string | null
  /** The gateway listens beyond loopback: every caller needs a key. */
  readonly onNetwork: boolean
}

export interface MagpieProvider {
  readonly id: string
  readonly name: string
  /** The preset it was added from; empty for a custom one. */
  readonly preset: string
  /** Host only, as magpie shows it; never a path or a key. */
  readonly host: string
  readonly enabled: boolean
  readonly ready: boolean
  /** Models it serves now (magpie's `exposed`). */
  readonly models: number
  /** Their ids, without the provider prefix. */
  readonly modelIds: readonly string[]
  readonly access: MagpieAccess
  /** A subscription account's plan label, when magpie knows it. */
  readonly plan: string | null
}

export interface MagpiePreset {
  readonly id: string
  readonly name: string
  readonly kind: string
  /** A local server: the key is optional. */
  readonly noKey: boolean
}

export interface MagpieProviderDraft {
  /** A magpie preset id, or empty for a custom provider given by its URLs. */
  readonly preset: string
  readonly key?: string
  readonly name?: string
  /** Base URLs for a custom provider (chat and responses end in `/v1`). */
  readonly chat?: string
  readonly responses?: string
  readonly anthropic?: string
}

export interface MagpieTestResult {
  readonly protocol: string
  readonly ok: boolean
  /** The vendor's HTTP status, when there was one. The vendor's text is dropped. */
  readonly status: number | null
  readonly ms: number
  readonly model: string | null
}

export interface MagpieGroup {
  readonly id: string
  readonly name: string
  /** The members the group names itself (`provider/model[:effort]`, `group/<id>`). */
  readonly members: readonly string[]
  /** Members its patterns match now; derived by magpie on every read. */
  readonly matched: readonly string[]
  /** Its patterns (`provider/*`, globs, `re:` expressions). */
  readonly match: readonly string[]
  /** magpie's routing name; `smart` for its empty default. */
  readonly routing: string
  /** magpie's affinity name; `auto` for its empty default. */
  readonly affinity: string
  /** The classifier model a ruled group asks, or empty. */
  readonly classifier: string
  readonly ready: boolean
}

export interface MagpieGroupDraft {
  readonly id: string
  /** The id it had: a different one renames it. */
  readonly from?: string
  readonly name?: string
  readonly members?: readonly string[]
  readonly routing?: MagpieRouting
  readonly affinity?: MagpieAffinity
}

export interface MagpieLimit {
  readonly period: MagpieLimitPeriod
  /** A `days` cycle's length, 1 to 3650. */
  readonly days?: number
  /** An `hours` cycle's length, 1 to 8760. */
  readonly hours?: number
  readonly tokens?: number
  /** US dollars at magpie's prices — magpie's estimate, not a bill. */
  readonly cost?: number
  /** Count cache reads in `tokens` too. */
  readonly cacheReads?: boolean
}

/** One limit with what the key has used of it (`budget.Status`). */
export interface MagpieLimitStatus extends MagpieLimit {
  readonly start: string | null
  readonly reset: string | null
  readonly tokensUsed: number
  readonly costUsed: number
  readonly spent: boolean
}

export interface MagpieKey {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  /** magpie's own mask (`…abcd` for a key of the caller's value). */
  readonly masked: string | null
  readonly models: readonly string[]
  readonly accounts: readonly string[]
  readonly limits: readonly MagpieLimit[]
  readonly used: readonly MagpieLimitStatus[]
}

/** A model or group a key may be held to (`GET /api/caller-keys/models`). */
export interface MagpieKeyChoice {
  readonly id: string
  readonly name: string
  readonly provider: string | null
  readonly group: boolean
}

export interface MagpieUsageTotals {
  readonly calls: number
  readonly errors: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /** magpie's estimate in US dollars for the priced calls. */
  readonly cost: number
  /** Calls with tokens and no known price. */
  readonly unpriced: number
}

export interface MagpieUsage {
  readonly period: MagpiePeriod
  readonly since: string | null
  readonly totals: MagpieUsageTotals
  readonly models: readonly (MagpieUsageTotals & {
    readonly id: string
    readonly name: string
  })[]
  readonly keys: readonly (MagpieUsageTotals & {
    readonly keyId: string
    readonly name: string
  })[]
}

/** One model of the gateway's catalog as a key sees it (`GET /v1/models`). */
export interface MagpieModel {
  readonly id: string
  readonly name: string
  readonly owner: string
}
