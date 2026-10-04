// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How long the third-party ladders wait between retries, where the answer is
 * not one of the ladder's own constants (P18.12; design
 * `providers-console-m1.md` §5.6 rows 16 and 17).
 *
 * #16 — the longest `Retry-After` worth waiting out, by run mode. The ladders
 * gave up on anything past 60 s (`MAX_RETRY_AFTER_MS` in `openai/retry.ts`),
 * and the main loop's ladder (`retryThirdPartyEventStream`) did not read
 * `Retry-After` at all: it re-asked a limiter on its own 0.5 s → 32 s
 * schedule. 60 s stays the bound for an interactive terminal, where someone
 * is watching and can act; a session nobody is watching — the resident ACP
 * agent, `-p`, the SDK — waits up to 600 s, since giving up there only ends
 * the turn for nobody to retry. Past the bound the ladder still gives up, as
 * it did at 60 s.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 * `agent/conversation_loop.py:6328-6342` — `Retry-After` is honoured up to
 * 600 s ("Anthropic Tier 1 input-token buckets reset in ~171s, so a 120s cap
 * caused us to retry before the actual reset window … 600s covers all
 * realistic provider reset windows"). Only the bound is taken; the code is
 * ours.
 *
 * Qianmo differences: hermes clamps a longer value to 600 s and waits; here a
 * longer value still ends the ladder (the existing contract, pinned by
 * `openai/__tests__/retry.test.ts`). hermes has one bound for every run mode;
 * here the interactive terminal keeps 60 s (design §5.6 row 16).
 *
 * #17 — Z.AI's Coding Plan endpoint answers GLM-5.2 requests with `429` code
 * `1305` ("The service may be temporarily overloaded") for otherwise valid
 * requests. Short retries hit the same overloaded window; after three of
 * them the wait widens to 30 / 60 / 90 / 120 s, and the ladder stops after
 * seven retries in all.
 *
 * 规则来源同上，`agent/retry_utils.py`:
 *   - `:21-35` — the long table `(30, 60, 90, 120)` s after 3 short retries;
 *   - `:143-159` `is_zai_coding_overload_error` — status 429, base URL
 *     containing `api.z.ai/api/coding/paas/v4`, model containing `glm-5.2`,
 *     error text containing `1305` or `temporarily overloaded`; only that
 *     narrow shape, so quota and billing 429s still fail fast;
 *   - `:162-190` `adaptive_rate_limit_backoff` — the long wait is the table
 *     entry plus up to 20 % jitter, the last entry repeating;
 *   - `:193-208` `zai_coding_overload_retry_ceiling` — 3 + 4 retries.
 * Qianmo difference: hermes RAISES a smaller retry budget to that ceiling so
 * the long tier is reachable; here an explicit `CLAUDE_CODE_MAX_RETRIES` below
 * 7 is the user's choice and is kept. The default budget (10) is lowered to
 * 7, which is the "fail visibly in minutes" bound hermes sizes it for.
 */
// The flags module, not the `state.js` barrel: the barrel's graph closes one
// more type-level import cycle through openai/retry.ts (check:cycles), as in
// src/utils/attachments/deltas.ts.
import { getIsNonInteractiveSession } from 'src/bootstrap/state/flags.js'
import { errorRecords, httpStatus, lowerStrings } from './errorRecords.js'

/** hermes `conversation_loop.py:6341`. */
export const UNATTENDED_RETRY_AFTER_CAP_MS = 600_000

/**
 * The longest `Retry-After` to wait out in this process: `interactiveCapMs`
 * for the interactive REPL, {@link UNATTENDED_RETRY_AFTER_CAP_MS} for every
 * session nobody is watching (`getIsNonInteractiveSession()` — ACP, `-p`,
 * SDK).
 */
export function retryAfterCapMs(interactiveCapMs: number): number {
  return getIsNonInteractiveSession()
    ? UNATTENDED_RETRY_AFTER_CAP_MS
    : interactiveCapMs
}

/** The request a ladder is retrying: wire model and endpoint. */
export type BackoffTarget = { model: string; baseURL: string | undefined }

/** hermes `_ZAI_CODING_OVERLOAD_SHORT_ATTEMPTS`. */
const ZAI_SHORT_RETRIES = 3
/** hermes `_ZAI_CODING_OVERLOAD_LONG_BACKOFF`, in ms. */
const ZAI_LONG_BACKOFF_MS = [30_000, 60_000, 90_000, 120_000] as const
/** hermes `zai_coding_overload_retry_ceiling()` − 1: retries, not attempts. */
export const ZAI_OVERLOAD_MAX_RETRIES =
  ZAI_SHORT_RETRIES + ZAI_LONG_BACKOFF_MS.length

/** hermes `is_zai_coding_overload_error`. */
export function isZaiCodingOverload(
  error: unknown,
  target: BackoffTarget | undefined,
): boolean {
  if (!target) return false
  const base = (target.baseURL ?? '').toLowerCase()
  if (!base.includes('api.z.ai/api/coding/paas/v4')) return false
  if (!target.model.toLowerCase().includes('glm-5.2')) return false
  const records = errorRecords(error)
  if (httpStatus(records) !== 429) return false
  const text = [
    ...lowerStrings(records, ['message', 'code', 'type']),
    ...records
      .map(record => record.code)
      .filter((code): code is number => typeof code === 'number')
      .map(String),
  ]
  return text.some(
    value => value.includes('1305') || value.includes('temporarily overloaded'),
  )
}

/**
 * The wait before the `retry`-th re-send (1-based) of a Z.AI coding overload:
 * `undefined` when `error` is not one (the caller keeps its own backoff),
 * `shortDelayMs` for the first three, then the long table with up to 20 %
 * jitter, and `giveUp` past {@link ZAI_OVERLOAD_MAX_RETRIES}.
 */
export function zaiOverloadWait(
  error: unknown,
  retry: number,
  shortDelayMs: number,
  target: BackoffTarget | undefined,
  random: () => number = Math.random,
): { giveUp: true } | { giveUp: false; delayMs: number } | undefined {
  if (!isZaiCodingOverload(error, target)) return undefined
  if (retry > ZAI_OVERLOAD_MAX_RETRIES) return { giveUp: true }
  if (retry <= ZAI_SHORT_RETRIES)
    return { giveUp: false, delayMs: shortDelayMs }
  const index = Math.min(
    retry - ZAI_SHORT_RETRIES - 1,
    ZAI_LONG_BACKOFF_MS.length - 1,
  )
  const baseMs = ZAI_LONG_BACKOFF_MS[index]!
  return {
    giveUp: false,
    delayMs: Math.round(baseMs + random() * 0.2 * baseMs),
  }
}
