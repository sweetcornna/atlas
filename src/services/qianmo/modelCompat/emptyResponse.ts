// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * When an empty model response is the answer rather than a glitch (P18.12,
 * hermes #25; design `providers-console-m1.md` §5.6 row 25).
 *
 * The ladder retries an empty response (`EmptyModelResponseError`) twice on
 * its own small budget (`streamAssembly.ts`). Each retry re-sends the whole
 * conversation. When the endpoint has twice in a row reported a successful
 * completion with input counted and nothing generated, for the same
 * finish_reason, the same prompt keeps producing the same nothing — the
 * last retry is skipped and the error surfaces at once.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 * `agent/empty_response_guard.py:18-26` — "two consecutive empty attempts,
 * both with usage present and output_tokens == 0, from the same (model,
 * provider, finish_reason), are treated as deterministic … Attempts with
 * missing usage … never classify as deterministic and keep the full retry
 * budget"; `:181-190` — usage counts as present only with input tokens ("A
 * genuine completion always has input tokens — without them the usage is not
 * evidence, fail open"). Only the rule is taken; the code is ours. Not taken:
 * hermes's cost-aware budget (design §5.6 row 25), and its walk to the
 * fallback chain afterwards (an empty is not a #1 fallback reason here).
 */

/** The fields of `EmptyModelResponseError` the rule reads. */
type EmptyAttempt = {
  finishReason: string
  inputTokens: number
  outputTokens: number
}

function reportedNothing(attempt: EmptyAttempt): boolean {
  return attempt.inputTokens > 0 && attempt.outputTokens === 0
}

/**
 * Whether `current`, following `previous` with no other failure between,
 * makes the streak deterministic. Same model and endpoint is implied: both
 * come from one ladder.
 */
export function isDeterministicEmpty(
  previous: EmptyAttempt | undefined,
  current: EmptyAttempt,
): boolean {
  return (
    previous !== undefined &&
    reportedNothing(previous) &&
    reportedNothing(current) &&
    previous.finishReason === current.finishReason
  )
}
