// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Reasoning tokens on the Responses lane (P18.8, hermes #26; design
 * `providers-console-m1.md` §5.6 row 26). The chat lane's reader is
 * `packages/@ant/model-provider/src/shared/qianmo/usageFields.ts`; the package
 * does not export it to `src/`, so the one rule this lane needs is here.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 * `agent/usage_pricing.py:1381-1391` — the Responses usage shape reports
 * reasoning as `output_tokens_details.reasoning_tokens`. Only the rule is
 * taken; the code is ours.
 */

/** `usage.output_tokens_details.reasoning_tokens`, when a finite number. */
export function readResponsesReasoningTokens(
  usage: Record<string, unknown> | undefined,
): number | undefined {
  const details = usage?.output_tokens_details
  if (!details || typeof details !== 'object') return undefined
  const value = (details as Record<string, unknown>).reasoning_tokens
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
