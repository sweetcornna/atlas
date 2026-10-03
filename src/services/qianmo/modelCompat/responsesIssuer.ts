// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which Responses endpoint minted a reasoning item's `encrypted_content`, and
 * whether the current endpoint may be sent it (P18.8, hermes #23; design
 * `providers-console-m1.md` §5.4 「跨端点」, §5.6 row 23).
 *
 * Under `store: false` the next turn replays every reasoning item verbatim
 * (`OPENAI_REASONING_ITEMS_FIELD`). The encrypted payload is sealed to the
 * endpoint that issued it, so a session that moves to another Responses
 * endpoint — another relay, another `OPENAI_BASE_URL`, API key → ChatGPT
 * subscription — used to replay a blob the new endpoint cannot decrypt, and
 * every later turn of the session failed the same way.
 *
 * Now each item is stamped with its issuer when it is captured, and an item
 * stamped by a different issuer is left out of the replay.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 *   - `agent/codex_responses_adapter.py:28-52` `_classify_responses_issuer` —
 *     the payload is sealed to its issuer; replaying it elsewhere
 *     "deterministically returns HTTP 400 invalid_encrypted_content"; the
 *     Codex backend is one issuer, any other endpoint is keyed by its base
 *     URL;
 *   - `:450-461`, `:535-569` — stamp on capture, drop on replay when the
 *     stamps differ, and "Legacy items without a stamp are still replayed
 *     (backwards-compatible)"; the stamp itself is never sent.
 * Only the facts are taken; the code is ours.
 *
 * Qianmo difference: hermes stores the base URL itself in the stamp. Qianmo
 * stores a digest of the normalised `/responses` URL instead, because the
 * stamp is persisted in session transcripts and a base URL can carry
 * credentials (userinfo, query). Normalisation drops userinfo, query and
 * fragment, lower-cases the host and trims trailing slashes, so the same
 * endpoint written two ways is still one issuer.
 */
import { createHash } from 'node:crypto'

/** The ChatGPT subscription route (Codex backend), whatever the base URL. */
const CHATGPT_ISSUER = 'chatgpt-codex'

function normalisedEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    const path = url.pathname.replace(/\/+$/, '')
    return `${url.protocol}//${url.host.toLowerCase()}${path}`
  } catch {
    return endpoint.trim()
  }
}

/**
 * The issuer of a Responses request: `chatgpt` is the ChatGPT subscription
 * route, `endpoint` the resolved `/responses` URL of the API-key route.
 */
export function responsesIssuer(route: {
  chatgpt: boolean
  endpoint: string
}): string {
  if (route.chatgpt) return CHATGPT_ISSUER
  const digest = createHash('sha256')
    .update(normalisedEndpoint(route.endpoint))
    .digest('hex')
    .slice(0, 16)
  return `api:${digest}`
}

/**
 * The items `issuer` may be sent: unstamped (captured before P18.8) and
 * stamped by `issuer` itself.
 */
export function replayableReasoningItems<T extends { issuer?: string }>(
  items: readonly T[],
  issuer: string,
): T[] {
  return items.filter(
    item => item.issuer === undefined || item.issuer === issuer,
  )
}
