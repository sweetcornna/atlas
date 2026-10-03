// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Usage fields the Chat Completions lane did not read (P18.8, hermes #26;
 * design `providers-console-m1.md` §5.6 row 26).
 *
 *   - Reasoning tokens. OpenAI-compatible endpoints report the hidden
 *     reasoning inside `completion_tokens` and break it out in
 *     `completion_tokens_details.reasoning_tokens` (Responses:
 *     `output_tokens_details.reasoning_tokens`). Nothing read it, so per-user
 *     metering (P15.7) could not tell thinking from answer.
 *   - Anthropic-style cache fields at the top level. Proxies that route
 *     Claude models (OpenRouter, Vercel AI Gateway, Cline) can report
 *     `cache_read_input_tokens` / `cache_creation_input_tokens` there instead
 *     of in `prompt_tokens_details`; reads were then missed, and writes were
 *     always counted as zero off OpenAI's own endpoint.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 *   - `agent/usage_pricing.py:1332-1344` — cache read: after
 *     `prompt_tokens_details.cached_tokens`, the top-level
 *     `cache_read_input_tokens` (port of cline/cline#10266);
 *   - `:1363-1378` — cache write: `prompt_tokens_details.cache_write_tokens`,
 *     then `prompt_tokens_details.cache_creation_input_tokens`, then the
 *     top-level `cache_creation_input_tokens`, then top-level
 *     `cache_write_tokens`;
 *   - `:1381-1397` — reasoning: `output_tokens_details.reasoning_tokens`,
 *     then `completion_tokens_details.reasoning_tokens`.
 * Only the rules are taken; the code is ours.
 *
 * Qianmo differences: an explicit `0` counts as an answer (the first finite
 * number wins, as `readOpenAICachedTokens` already does), where hermes falls
 * through zeros; and `prompt_tokens_details.cache_write_tokens` stays read
 * only on OpenAI's own endpoint (`openaiStreamAdapter.ts`
 * `includeCacheWriteTokens`) — the fallbacks below are the explicit
 * Anthropic-style statements, read everywhere.
 */

function firstNumber(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate
    }
  }
  return undefined
}

function field(record: unknown, key: string): unknown {
  return record && typeof record === 'object'
    ? (record as Record<string, unknown>)[key]
    : undefined
}

/** hermes `usage_pricing.py:1366-1378`, minus OpenAI's own field. */
export function readAnthropicStyleCacheWriteTokens(
  usage: unknown,
): number | undefined {
  return firstNumber(
    field(field(usage, 'prompt_tokens_details'), 'cache_creation_input_tokens'),
    field(usage, 'cache_creation_input_tokens'),
    field(usage, 'cache_write_tokens'),
  )
}

/** hermes `usage_pricing.py:1381-1397`. */
export function readReasoningTokens(usage: unknown): number | undefined {
  return firstNumber(
    field(field(usage, 'output_tokens_details'), 'reasoning_tokens'),
    field(field(usage, 'completion_tokens_details'), 'reasoning_tokens'),
  )
}
