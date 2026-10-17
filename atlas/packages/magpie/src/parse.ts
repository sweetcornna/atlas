// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * magpie's JSON rows, read into this package's types. Each reader takes an
 * object a remote process wrote and returns null for one it cannot use; a
 * field of the wrong type reads as absent.
 */

import {
  LIMIT_PERIODS,
  type MagpieAccess,
  type MagpieGroup,
  type MagpieKey,
  type MagpieLimit,
  type MagpieLimitPeriod,
  type MagpieLimitStatus,
} from './types.js'

type Json = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function strings(value: unknown, max = 500): readonly string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item !== '')
    .slice(0, max)
}

/** The magpie preset that reaches another magpie as magpie's own client. */
const REMOTE_MAGPIE_PRESET = 'remote-magpie'

/**
 * How a provider row (`GET /api/providers`) reaches its vendor: a row with
 * an `account` is a signed-in subscription (plugins included, which need
 * one: `provider.IsPlugin`); `ownClient` sends as the vendor's own client
 * (`provider.OwnClient`), as does another magpie; the rest use a key.
 */
export function accessOf(raw: Json): MagpieAccess {
  if (isRecord(raw['account'])) return 'account'
  if (
    raw['ownClient'] === true ||
    text(raw['preset']) === REMOTE_MAGPIE_PRESET
  ) {
    return 'client'
  }
  return 'key'
}

/** A group row (`GET /api/groups`): its own members apart from those matched. */
export function groupOf(raw: Json): MagpieGroup | null {
  const id = text(raw['id'])
  if (id === '') return null
  const matched = strings(raw['matched'])
  const members = strings(raw['members']).filter(
    member => !matched.includes(member),
  )
  const routing = text(raw['routing'])
  const affinity = text(raw['affinity'])
  return {
    id,
    name: text(raw['name']) || id,
    members,
    matched,
    match: strings(raw['match']),
    routing: routing === '' ? 'smart' : routing,
    affinity: affinity === '' ? 'auto' : affinity,
    classifier: text(raw['classifier']),
    ready: raw['ready'] === true,
  }
}

function periodOf(value: unknown): MagpieLimitPeriod | null {
  const period = text(value)
  return (LIMIT_PERIODS as readonly string[]).includes(period)
    ? (period as MagpieLimitPeriod)
    : null
}

function limitOf(raw: unknown): MagpieLimit | null {
  if (!isRecord(raw)) return null
  const period = periodOf(raw['period'])
  if (period === null) return null
  const tokens = num(raw['tokens'])
  const cost = num(raw['cost'])
  // A limit with neither cap is no limit (`Limit.Limited`).
  if (tokens <= 0 && cost <= 0) return null
  return {
    period,
    ...(period === 'days' ? { days: num(raw['days']) } : {}),
    ...(period === 'hours' ? { hours: num(raw['hours']) } : {}),
    ...(tokens > 0 ? { tokens } : {}),
    ...(cost > 0 ? { cost } : {}),
    ...(raw['cacheReads'] === true ? { cacheReads: true } : {}),
  }
}

function timeOf(value: unknown): string | null {
  const at = text(value)
  return at === '' || at.startsWith('0001-') ? null : at
}

function statusOf(raw: unknown): MagpieLimitStatus | null {
  if (!isRecord(raw)) return null
  const period = periodOf(raw['period'])
  if (period === null) return null
  const tokens = num(raw['tokenLimit'])
  const cost = num(raw['costLimit'])
  return {
    period,
    ...(period === 'days' ? { days: num(raw['days']) } : {}),
    ...(period === 'hours' ? { hours: num(raw['hours']) } : {}),
    ...(tokens > 0 ? { tokens } : {}),
    ...(cost > 0 ? { cost } : {}),
    ...(raw['cacheReads'] === true ? { cacheReads: true } : {}),
    start: timeOf(raw['start']),
    reset: timeOf(raw['reset']),
    tokensUsed: num(raw['tokens']),
    costUsed: num(raw['cost']),
    spent: raw['spent'] === true,
  }
}

/**
 * A gateway key row (`GET /api/caller-keys`, `keyRow`). Its `secret` is
 * never read: magpie masks it in lists, and this reader would not pass it
 * on if it did not.
 */
export function keyOf(raw: Json): MagpieKey | null {
  const id = text(raw['id'])
  if (id === '') return null
  const limits = [
    raw['limit'],
    ...(Array.isArray(raw['moreLimits']) ? raw['moreLimits'] : []),
  ]
    .map(limitOf)
    .filter((limit): limit is MagpieLimit => limit !== null)
  const used = (Array.isArray(raw['usedAll']) ? raw['usedAll'] : [])
    .map(statusOf)
    .filter((status): status is MagpieLimitStatus => status !== null)
  const masked = text(raw['masked'])
  return {
    id,
    name: text(raw['name']) || id,
    enabled: raw['off'] !== true,
    masked: masked === '' ? null : masked.slice(0, 40),
    models: strings(raw['models']),
    accounts: strings(raw['accounts']),
    limits,
    used,
  }
}
