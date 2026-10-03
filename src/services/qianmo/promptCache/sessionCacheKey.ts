// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One `prompt_cache_key` per (session, model), fixed at the first request
 * (P18.19 CH-3, design `providers-console-m1.md` §5.11.5).
 *
 * The base derives the key from the request's cached prefix — model, every
 * system/developer text, tool names (`formatOpenAIPrefixCacheKey`) — and
 * recomputes it on every request. That is what lets a fresh session land on
 * the node already holding an identical prefix (measured 0% → 98% on a first
 * turn), and it is kept: the FIRST key of a session is still that hash.
 *
 * Recomputing it on every later request is the part this module replaces.
 * Anything that rewrites the instructions mid-session (on the recording stub:
 * the process cwd's git status re-read on an ACP session switch) changed the
 * key, and on key-routed models a new key is a new machine — a whole-prefix
 * miss, not a partial one. From GPT-5.6 on OpenAI also reports a changed key
 * as a miss (`prompt_cache_key_changed`). hermes keeps its key stable the
 * other way round, by never changing the instructions within a session;
 * CH-1 (`sessionPromptContext.ts`) does that here too, and this pin is the
 * backstop for every source of instruction drift CH-1 does not cover.
 *
 * Left exactly as the base has them: a withheld key (endpoint rejected it,
 * `OPENAI_PROMPT_CACHE_KEY=0`), `OPENAI_PROMPT_CACHE_KEY_SCOPE=session`, and a
 * request with no cacheable prefix, which falls back to the session key.
 *
 * Pins survive an ACP child being replaced: CH-1 writes them into the
 * session's prompt-context sidecar and restores them on resume.
 */
import {
  formatOpenAIPromptCacheKey,
  resolveOpenAIPromptCacheKey,
} from 'src/services/api/openai/openaiShared.js'

type ResolveParams = Parameters<typeof resolveOpenAIPromptCacheKey>[0]

/** Sessions remembered at once; the least recently used is dropped first. */
export const MAX_PINNED_SESSIONS = 256

/** sessionId → (model → pinned key), in least-recently-used-first order. */
const pins = new Map<string, Map<string, string>>()

function touch(sessionId: string): Map<string, string> | undefined {
  const byModel = pins.get(sessionId)
  if (byModel !== undefined) {
    pins.delete(sessionId)
    pins.set(sessionId, byModel)
  }
  return byModel
}

function remember(sessionId: string, model: string, key: string): void {
  const byModel = touch(sessionId) ?? new Map<string, string>()
  byModel.set(model, key)
  pins.set(sessionId, byModel)
  while (pins.size > MAX_PINNED_SESSIONS) {
    const oldest = pins.keys().next().value
    if (oldest === undefined) break
    pins.delete(oldest)
  }
}

/**
 * Drop-in for `resolveOpenAIPromptCacheKey`: same parameters, same withheld
 * and session-scope behaviour, but a prefix key is computed once per
 * (session, model) and reused for the rest of the session.
 */
export function resolveSessionStablePromptCacheKey(
  params: ResolveParams,
): string | undefined {
  const fresh = resolveOpenAIPromptCacheKey(params)
  // Withheld, or the session-scoped key (scope=session, or nothing cacheable
  // to route to): both are already constant for the session.
  if (
    fresh === undefined ||
    fresh === formatOpenAIPromptCacheKey(params.sessionId)
  ) {
    return fresh
  }
  const pinned = touch(params.sessionId)?.get(params.model)
  if (pinned !== undefined) return pinned
  remember(params.sessionId, params.model, fresh)
  return fresh
}

/** The pins of one session, for the prompt-context sidecar. */
export function getPinnedPromptCacheKeys(
  sessionId: string,
): Record<string, string> {
  return Object.fromEntries(pins.get(sessionId) ?? [])
}

/**
 * Re-establish a session's pins after its ACP child was replaced. A pin the
 * live process already holds wins: it is the one this process has been
 * sending.
 */
export function restorePinnedPromptCacheKeys(
  sessionId: string,
  keys: Readonly<Record<string, string>>,
): void {
  for (const [model, key] of Object.entries(keys)) {
    if (typeof key !== 'string' || key.length === 0) continue
    if (pins.get(sessionId)?.has(model)) continue
    remember(sessionId, model, key)
  }
}

/** Test seam. */
export function resetPinnedPromptCacheKeysForTesting(): void {
  pins.clear()
}
