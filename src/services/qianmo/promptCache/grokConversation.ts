// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Sticky routing for the Grok lane (P18.19 CH-7, design
 * `providers-console-m1.md` §5.11.5).
 *
 * xAI keeps prompt caches per backend server and routes requests carrying the
 * same `x-grok-conv-id` header to the same server ("Maximizing Cache Hits",
 * https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits.md,
 * fetched 2026-10-03). hermes sends the conversation's root session id there
 * (`agent/transports/codex.py:671`, `f9b29c49b6`). The session id is that
 * root here: compaction and resume keep it.
 *
 * The caller hands the session id in (`claude.ts` already holds it when it
 * dispatches to the Grok lane). This module reads no session state itself,
 * so the Grok lane gains no import of `bootstrap/state` — and no import
 * cycle (`check:cycles` is a ratchet that only goes down).
 */

export const GROK_CONVERSATION_HEADER = 'x-grok-conv-id'

/** The routing header for `sessionId`; none without one. */
export function grokConversationHeaders(
  sessionId: string | undefined,
): Record<string, string> {
  return sessionId ? { [GROK_CONVERSATION_HEADER]: sessionId } : {}
}
