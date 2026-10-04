// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Saying so when a provider's content filter cut a response short (P18.12,
 * hermes #27; design `providers-console-m1.md` §5.6 row 27).
 *
 * The chat adapter maps `finish_reason: "content_filter"` to `end_turn`, and
 * the Responses lane passes `content_filter` through as the stop reason with
 * nothing shown: either way a filtered answer ended like a finished one, and
 * the reader had no way to tell that the rest was withheld. Now the lane
 * appends an error message saying the content filter stopped the response
 * (`assembleFinalAssistantOutputs`' `terminalError`, as the Gemini lane does
 * for its own terminations). The partial answer stays.
 *
 * The chat lane learns of it from the raw chunks (`chatStreamGuards.ts`),
 * because the adapter's stop reason no longer says it; the stop reason itself
 * is left as it was, `end_turn`.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 * `agent/conversation_loop.py:3403-3416` — a successful response whose finish
 * reason is `content_filter` is a refusal to surface clearly, not a normal
 * stop. Only the rule is taken; the code is ours. Not taken: hermes's single
 * try of a configured fallback model afterwards (a #1 reason it is not here),
 * and an empty filtered response still goes through the empty-response retry.
 */

/** Per attempt: whether a raw chat chunk ended with `content_filter`. */
export type ContentFilterSink = { seen: boolean }

/**
 * The `terminalError` for a response the content filter stopped, or
 * `undefined`. `stopReason` is the lane's (Responses passes
 * `content_filter`); `sink` is the chat lane's raw-chunk record.
 */
export function contentFilterNotice(
  stopReason: string | null,
  sink?: ContentFilterSink,
): { content: string; errorDetails: string } | undefined {
  if (stopReason !== 'content_filter' && sink?.seen !== true) return undefined
  return {
    content:
      "The provider's content filter stopped this response; the text above may be incomplete.",
    errorDetails: 'finish_reason=content_filter',
  }
}
