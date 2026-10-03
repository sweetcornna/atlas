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
 */
// The flags module, not the `state.js` barrel: the barrel's graph closes one
// more type-level import cycle through openai/retry.ts (check:cycles), as in
// src/utils/attachments/deltas.ts.
import { getIsNonInteractiveSession } from 'src/bootstrap/state/flags.js'

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
