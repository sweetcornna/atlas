// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The key pool: one profile, several keys of the same vendor account family,
 * one of them in use per session (P18.18, hermes #2; design
 * `providers-console-m1.md` §9.2 P18.18, §5.11.6 X-1, D-6).
 *
 * ## Which key a session uses (X-1)
 *
 * A session is bound to one key at its first request and keeps it until an
 * error that calls for another key — on that session, or on any session that
 * took the same key out of rotation. Never per request: provider prompt caches
 * are scoped to the account behind a key, and spreading one session over
 * several keys re-reads its whole prefix on every switch. The strategy only
 * decides the first choice and the next one after a key goes out:
 *
 *   - `fill_first`  the first available key, in the pool's order (primary
 *                   first: priority, then list order);
 *   - `round_robin` the next available key after the last one chosen (a
 *                   cursor kept on disk), so new sessions spread over keys;
 *   - `least_used`  the available key chosen least often (ties: pool order);
 *                   choosing it counts one.
 * `random` is not offered (§0.5).
 *
 * ## When a key goes out (the hermes behaviour table)
 *
 *   - 429: the first one on a session is retried with the same key — by the
 *     lane's own ladder, after its own wait; the second in a row takes the key
 *     out (rate-limit) for an hour;
 *   - a usage cap ("usage limit reached"): out at once (usage-limit), an hour;
 *   - 402, or any refusal the classifier calls `billing_error`: out at once
 *     (billing), an hour;
 *   - 401: out (auth) for five minutes; a 401 naming a revoked credential
 *     takes it out for good (dead) until the hub delivers a new value;
 *   - a server reporting itself overloaded through a 429 is not the key's
 *     fault: no change;
 *   - a time the provider gives — `reset_at` / `resets_at` in the body, a
 *     body `retry_after`, `Retry-After`, `x-ratelimit-reset`, a "resets in …"
 *     sentence — replaces the default cooldown.
 * Qianmo difference: hermes waits up to 600 s for a first 429's
 * `Retry-After` and then retries the same key; here the lane's ladder gives up
 * past its run-mode bound (`openai/retry.ts` `resolveRetryWait`), so a first
 * 429 the ladder would not retry takes the key out at once, cooled to the time
 * the server named.
 *
 * Every key out with none left: {@link CredentialPoolExhaustedError}, naming
 * the key that comes back first and when.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-04 取用）：
 *   - `website/docs/user-guide/features/credential-pools.md:22-42, 137-150` —
 *     the behaviour table and the four strategies;
 *   - `agent/credential_pool.py:66-90` `_TERMINAL_AUTH_REASONS`, `:124-126`
 *     the 401 / 429 / default cooldowns, `:318-360` `_exhausted_ttl`,
 *     `:362-389` `_parse_absolute_timestamp`, `:440-452` `_exhausted_until`
 *     (a provider time wins), `:1995-2036` the strategies;
 *   - `agent/agent_runtime_helpers.py:940-1283` `recover_with_credential_pool`
 *     (retry a 429 once, rotate on the second; usage cap and billing rotate at
 *     once; the usage-cap phrasings at `:1153-1161`), `:4121-4199`
 *     `extract_api_error_context` (where a reset time is read from, in order).
 * Only the facts are taken; the code is ours. Not taken: hermes shortens a
 * SOLE credential's transient cooldown to 60 s (`:127-131`) — a profile with
 * one key has no pool here at all; OAuth refresh before rotating on 401 —
 * delivered keys are API keys.
 */

import {
  type KeyOutReason,
  type KeySelection,
  type KeyStatus,
  secretFingerprint,
} from '@qianmo/providers'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import {
  resolveRetryWait,
  retryAfterMsFromError,
} from '../../api/openai/retry.js'
import {
  classifyRetryableAPIError,
  NonRetryableError,
} from '../../api/retryClassification.js'
import {
  type KeyPoolFile,
  type KeyPoolState,
  readKeyPool,
  readKeyPoolState,
  updateKeyPoolState,
} from './credentialPoolStore.js'
import { errorMessageTexts } from './errorMessages.js'
import { errorRecords, httpStatus, lowerStrings } from './errorRecords.js'
import { isOverloadedErrorText } from './errorText.js'

/** `capabilities.multiKey`: this call layer rotates keys (P18.18). */
export const MULTI_KEY = true

/** hermes `credential_pool.py:124`. */
const COOLDOWN_401_MS = 5 * 60_000
/** hermes `credential_pool.py:125-126`: 429, 402 and everything else. */
const COOLDOWN_DEFAULT_MS = 60 * 60_000

/** hermes `credential_pool.py:80-87`: a 401 for these never recovers. */
const TERMINAL_AUTH_REASONS = new Set([
  'token_invalidated',
  'token_revoked',
  'invalid_token',
  'invalid_grant',
  'unauthorized_client',
  'refresh_token_reused',
])

/** hermes `agent_runtime_helpers.py:1153-1161`. */
const USAGE_CAP_CODES = ['usage_limit_reached', 'gousagelimit']
const USAGE_CAP_TEXT = ['usage limit reached', 'usage limit has been reached']

type PoolDecision =
  | { kind: 'none' }
  | { kind: 'retry-same' }
  | {
      kind: 'out'
      state: 'cooling' | 'dead'
      reason: KeyOutReason
      /** `cooling`: epoch ms the key is tried again. */
      untilMs?: number
      status?: number
    }

// ---------------------------------------------------------------------------
// Reading a reset time off an error
// ---------------------------------------------------------------------------

/**
 * hermes `_parse_absolute_timestamp`: epoch seconds, epoch milliseconds
 * (anything past 1e12), or an ISO string. Epoch ms, or `undefined`.
 */
function absoluteMs(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined
    return value > 1_000_000_000_000 ? value : value * 1000
  }
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (raw === '') return undefined
  if (/^\d+(?:\.\d+)?$/.test(raw)) return absoluteMs(Number(raw))
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? undefined : parsed
}

function headerValue(error: unknown, name: string): string | undefined {
  for (const record of errorRecords(error)) {
    const headers = record.headers
    if (headers instanceof Headers) {
      const value = headers.get(name)
      if (value !== null) return value
    } else if (typeof headers === 'object' && headers !== null) {
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === name && typeof value === 'string') {
          return value
        }
      }
    }
  }
  return undefined
}

/** hermes `agent_runtime_helpers.py:4171-4199`: the three sentences. */
function resetFromText(texts: readonly string[]): number | undefined {
  for (const text of texts) {
    const quota = text.match(/quotaResetDelay[:\s"]+(\d+(?:\.\d+)?)(ms|s)/i)
    if (quota?.[1] && quota[2]) {
      const value = Number(quota[1])
      return quota[2].toLowerCase() === 'ms' ? value : value * 1000
    }
    const resetsIn = text.match(
      /resets?\s+in\s+(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b\s*)?(?:(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b\s*)?(?:(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b)?/i,
    )
    if (resetsIn && (resetsIn[1] || resetsIn[2] || resetsIn[3])) {
      return (
        Number(resetsIn[1] ?? 0) * 3_600_000 +
        Number(resetsIn[2] ?? 0) * 60_000 +
        Number(resetsIn[3] ?? 0) * 1000
      )
    }
    const retry = text.match(
      /retry\s+(?:after\s+)?(\d+(?:\.\d+)?)\s*(?:sec|secs|seconds|s\b)/i,
    )
    if (retry?.[1]) return Number(retry[1]) * 1000
  }
  return undefined
}

/**
 * When the provider says the key works again, as epoch ms. In hermes's order
 * (`extract_api_error_context`): a body `resets_at` / `reset_at`, a body
 * `retry_after` (seconds), `Retry-After` (read with the lane's own parser:
 * `retry-after-ms`, seconds or an HTTP date), `x-ratelimit-reset`, then the
 * message.
 */
export function resetAtFromError(
  error: unknown,
  nowMs: number,
): number | undefined {
  const records = errorRecords(error)
  for (const record of records) {
    for (const key of ['resets_at', 'reset_at']) {
      const at = absoluteMs(record[key])
      if (at !== undefined) return at
    }
  }
  for (const record of records) {
    const raw = record.retry_after
    const seconds =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw.trim())
          ? Number(raw)
          : undefined
    if (seconds !== undefined && Number.isFinite(seconds) && seconds >= 0) {
      return nowMs + seconds * 1000
    }
  }
  const retryAfterMs = retryAfterMsFromError(error)
  if (retryAfterMs !== undefined) return nowMs + retryAfterMs
  const reset = absoluteMs(headerValue(error, 'x-ratelimit-reset'))
  if (reset !== undefined) return reset
  const inMs = resetFromText(errorMessageTexts(error))
  return inMs === undefined ? undefined : nowMs + inMs
}

// ---------------------------------------------------------------------------
// The behaviour table
// ---------------------------------------------------------------------------

function isUsageCap(codes: readonly string[], texts: readonly string[]) {
  return (
    codes.some(code => USAGE_CAP_CODES.some(cap => code.includes(cap))) ||
    texts.some(text => USAGE_CAP_TEXT.some(cap => text.includes(cap)))
  )
}

/**
 * What one failure of a request made with a pool key means for that key.
 * `retried429`: this session already retried this key after a 429.
 */
export function poolDecision(
  error: unknown,
  context: { retried429: boolean; nowMs: number },
): PoolDecision {
  const records = errorRecords(error)
  const status = httpStatus(records)
  const codes = lowerStrings(records, ['code', 'type', 'error', 'reason'])
  const texts = errorMessageTexts(error).map(text => text.toLowerCase())
  const verdict = classifyRetryableAPIError(error)
  const category = verdict.category
  const resetAt = resetAtFromError(error, context.nowMs)
  const out = (
    reason: KeyOutReason,
    defaultMs: number,
  ): Extract<PoolDecision, { kind: 'out' }> => ({
    kind: 'out',
    state: 'cooling',
    reason,
    untilMs: resetAt ?? context.nowMs + defaultMs,
    ...(status === undefined ? {} : { status }),
  })

  if (status === 401) {
    if (codes.some(code => TERMINAL_AUTH_REASONS.has(code))) {
      return { kind: 'out', state: 'dead', reason: 'revoked', status }
    }
    return out('auth', COOLDOWN_401_MS)
  }
  if (status === 402 || category === 'billing_error') {
    return out('billing', COOLDOWN_DEFAULT_MS)
  }
  // An error frame inside a stream has no status; its code is all there is
  // to tell a usage cap (hermes reads the same code off `error_context`).
  const usageCap = isUsageCap(codes, texts)
  const rateLimited =
    status === 429 ||
    (status === undefined && (category === 'rate_limit' || usageCap))
  if (!rateLimited) return { kind: 'none' }
  if (texts.some(isOverloadedErrorText)) return { kind: 'none' }
  if (usageCap) return out('usage-limit', COOLDOWN_DEFAULT_MS)
  // "Retry once with the same key" happens on the lane's ladder; when the
  // ladder would not retry this error (past its Retry-After bound, or told
  // not to), it would not happen at all — rotate now instead.
  if (
    !context.retried429 &&
    verdict.retryable &&
    !resolveRetryWait(error, 1).giveUp
  ) {
    return { kind: 'retry-same' }
  }
  return out('rate-limit', COOLDOWN_DEFAULT_MS)
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

export type PoolKey = {
  readonly id: string
  readonly value: string
  readonly fp: string
}

/** Every key out of rotation; nothing to send with. Never retried. */
export class CredentialPoolExhaustedError extends NonRetryableError {
  /** The key back first and when (ISO), or `null` when every key is dead. */
  readonly next: { keyId: string; at: string } | null

  constructor(
    message: string,
    category: ConstructorParameters<typeof NonRetryableError>[1]['category'],
    next: { keyId: string; at: string } | null,
  ) {
    super(message, { category })
    this.name = 'CredentialPoolExhaustedError'
    this.next = next
  }
}

let note: (line: string) => void = line => logForDebugging(line)

/** Test seam: where the pool's diagnostic lines go (key ids, never values). */
export function setCredentialPoolNoteSinkForTesting(
  sink: ((line: string) => void) | null,
): void {
  note = sink ?? (line => logForDebugging(line))
}

/** sessionId → id of the key it retried once after a 429 (in memory only). */
const retried429 = new Map<string, string>()

/** Test seam. */
export function resetCredentialPoolMemoryForTesting(): void {
  retried429.clear()
}

function markOf(
  state: KeyPoolState,
  key: PoolKey,
): KeyPoolState['marks'][string] | undefined {
  const mark = state.marks[key.id]
  return mark !== undefined && mark.fp === key.fp ? mark : undefined
}

function isAvailable(state: KeyPoolState, key: PoolKey, nowMs: number) {
  const mark = markOf(state, key)
  if (mark === undefined) return true
  if (mark.state === 'dead') return false
  return Date.parse(mark.until ?? '') <= nowMs
}

function choose(
  selection: KeySelection,
  keys: readonly PoolKey[],
  available: readonly PoolKey[],
  state: KeyPoolState,
): { key: PoolKey; cursor?: number } {
  if (selection === 'round_robin') {
    for (let step = 0; step < keys.length; step += 1) {
      const index = (state.cursor + step) % keys.length
      const key = keys[index] as PoolKey
      if (available.includes(key)) {
        return { key, cursor: (index + 1) % keys.length }
      }
    }
  }
  if (selection === 'least_used') {
    const count = (key: PoolKey) => {
      const entry = state.selections[key.id]
      return entry !== undefined && entry.fp === key.fp ? entry.count : 0
    }
    let best = available[0] as PoolKey
    for (const key of available) if (count(key) < count(best)) best = key
    return { key: best }
  }
  return { key: available[0] as PoolKey }
}

export class CredentialPool {
  readonly keys: readonly PoolKey[]
  readonly selection: KeySelection
  readonly #now: () => number

  constructor(file: KeyPoolFile, now: () => number = Date.now) {
    this.keys = file.keys.map(key => ({
      id: key.id,
      value: key.value,
      fp: secretFingerprint(key.value),
    }))
    this.selection = file.selection
    this.#now = now
  }

  /**
   * The key for this session's next request: its bound key while that is
   * still in rotation, otherwise a new choice by the strategy, recorded.
   */
  keyFor(sessionId: string): PoolKey {
    const nowMs = this.#now()
    const state = readKeyPoolState()
    const available = this.keys.filter(key => isAvailable(state, key, nowMs))
    const bound = state.sessions[sessionId]
    const kept = available.find(
      key => key.id === bound?.key && key.fp === bound.fp,
    )
    if (kept !== undefined) return kept
    if (available.length === 0) throw this.#exhausted(state, nowMs)
    const { key, cursor } = choose(this.selection, this.keys, available, state)
    updateKeyPoolState(next => {
      next.sessions[sessionId] = {
        key: key.id,
        fp: key.fp,
        at: new Date(nowMs).toISOString(),
      }
      const counted = next.selections[key.id]
      next.selections[key.id] = {
        fp: key.fp,
        count:
          counted !== undefined && counted.fp === key.fp
            ? counted.count + 1
            : 1,
      }
      if (cursor !== undefined) next.cursor = cursor
    })
    note(
      `[credential pool] key ${key.id} chosen for a session (${this.selection})`,
    )
    return key
  }

  /**
   * Account for one failed request made with `key`. `rotated`: the key is out
   * and the session unbound — the next {@link keyFor} picks another key;
   * `retry-same`: send once more with this key; `none`: not the key's doing.
   * Never sends anything itself.
   */
  failed(
    sessionId: string,
    key: PoolKey,
    error: unknown,
  ): 'rotated' | 'retry-same' | 'none' {
    const nowMs = this.#now()
    const decision = poolDecision(error, {
      retried429: retried429.get(sessionId) === key.id,
      nowMs,
    })
    if (decision.kind === 'none') return 'none'
    if (decision.kind === 'retry-same') {
      retried429.set(sessionId, key.id)
      note(`[credential pool] key ${key.id}: 429, retrying it once`)
      return 'retry-same'
    }
    retried429.delete(sessionId)
    const at = new Date(nowMs).toISOString()
    updateKeyPoolState(state => {
      state.marks[key.id] = {
        fp: key.fp,
        state: decision.state,
        ...(decision.untilMs === undefined
          ? {}
          : { until: new Date(decision.untilMs).toISOString() }),
        reason: decision.reason,
        ...(decision.status === undefined ? {} : { status: decision.status }),
        at,
      }
      const bound = state.sessions[sessionId]
      if (bound?.key === key.id) delete state.sessions[sessionId]
    })
    note(
      `[credential pool] key ${key.id} ${decision.state} (${decision.reason}${
        decision.untilMs === undefined
          ? ''
          : ` until ${new Date(decision.untilMs).toISOString()}`
      })`,
    )
    return 'rotated'
  }

  /** A request with this session's key went through. */
  succeeded(sessionId: string): void {
    retried429.delete(sessionId)
  }

  #exhausted(state: KeyPoolState, nowMs: number): CredentialPoolExhaustedError {
    const marks = this.keys.map(key => ({ key, mark: markOf(state, key) }))
    const cooling = marks
      .filter(({ mark }) => mark?.state === 'cooling')
      .map(({ key, mark }) => ({
        keyId: key.id,
        at: mark?.until ?? new Date(nowMs).toISOString(),
        reason: mark?.reason,
      }))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    const reasons = new Set(marks.map(({ mark }) => mark?.reason))
    const category = !cooling.length
      ? 'authentication_failed'
      : reasons.size === 1 && reasons.has('billing')
        ? 'billing_error'
        : 'rate_limit'
    const first = cooling[0]
    const message =
      first === undefined
        ? `All ${this.keys.length} keys of this model service were refused as revoked; an operator has to set new keys.`
        : `All ${this.keys.length} keys of this model service are out of rotation; the first back is key ${first.keyId} at ${first.at} (${first.reason ?? 'cooling'}).`
    return new CredentialPoolExhaustedError(
      message,
      category,
      first === undefined ? null : { keyId: first.keyId, at: first.at },
    )
  }
}

let poolCache: { file: KeyPoolFile; pool: CredentialPool } | undefined

/**
 * The node's key pool for this process's current provider env, or `null`.
 *
 * Bound to the env on purpose: the pool is only used while `envKey` still
 * holds the pool's primary key, i.e. while `settings.json` is the one the
 * pool was committed with. A local edit, `/provider use`, or a credential
 * mirror rewriting the env all fall back to the single key in the env.
 */
export function activeCredentialPool(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CredentialPool | null {
  const file = readKeyPool()
  if (file === null) return null
  if (env[file.envKey] !== file.keys[0]?.value) return null
  if (poolCache?.file !== file) {
    poolCache = { file, pool: new CredentialPool(file) }
  }
  return poolCache.pool
}

/**
 * `status.keys`: every key of the committed pool, in pool order — ids and
 * states only. `null` when the node has no pool, or — given the env the node
 * runs on (`settings.json`'s) — when that env is not bound to it, as for
 * {@link activeCredentialPool}.
 */
export function keyPoolStatus(
  nowMs: number = Date.now(),
  env?: Readonly<Record<string, string | undefined>>,
): KeyStatus[] | null {
  const file = readKeyPool()
  if (file === null) return null
  if (env !== undefined && env[file.envKey] !== file.keys[0]?.value) {
    return null
  }
  const state = readKeyPoolState()
  return file.keys.map(({ id, value }): KeyStatus => {
    const mark = markOf(state, { id, value, fp: secretFingerprint(value) })
    if (mark === undefined) return { id, state: 'ok' }
    if (mark.state === 'dead') return { id, state: 'dead', reason: mark.reason }
    return Date.parse(mark.until ?? '') > nowMs
      ? {
          id,
          state: 'cooling',
          ...(mark.until === undefined ? {} : { until: mark.until }),
          reason: mark.reason,
        }
      : { id, state: 'ok' }
  })
}
