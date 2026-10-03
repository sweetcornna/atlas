// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Gemini's thought signature on tool calls made through an OpenAI-compatible
 * endpoint: captured from the stream, carried to the next request (P18.8,
 * hermes #10; design `providers-console-m1.md` §5.6 row 10).
 *
 * Gemini 3 thinking models attach `extra_content.google.thought_signature` to
 * each tool call and reject the next request with HTTP 400 if the call is
 * replayed without it. The chat lane dropped it: the stream adapter never
 * read it and the message conversion never wrote it.
 *
 * The path, end to end:
 *   1. capture — `toolCallDeltas.ts` reads the signature off the tool-call
 *      delta; the stream adapter puts it on the `tool_use` block as
 *      `_geminiThoughtSignature` (`GEMINI_THOUGHT_SIGNATURE_FIELD`), the field
 *      the native Gemini lane already stores its signatures in — so the
 *      Anthropic lane already strips it (`claude.ts`) and a later native
 *      Gemini request already replays it;
 *   2. conversion — `anthropicMessagesToOpenAI` copies it onto the tool call
 *      under {@link GEMINI_TOOL_CALL_SIGNATURE}, a symbol key that no
 *      serialiser writes, so no endpoint ever receives it from here;
 *   3. send — the chat lane's send boundary
 *      (`src/services/qianmo/modelCompat/reasoningEcho.ts`) turns it into
 *      `extra_content` only when the target model is Gemini-family.
 *
 * Why a symbol rather than an `extra_content` key written at conversion:
 * the conversion does not know the target, and its output is also sent
 * unfiltered by the Grok lane and read by the Responses converter. A plain
 * key would reach every strict endpoint in a mixed-provider session — the
 * very 400 hermes strips it to avoid. A symbol-keyed property survives object
 * spread and is ignored by `JSON.stringify`.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 *   - `agent/chat_completion_helpers.py:4227-4236` — the streamed tool-call
 *     delta's `extra_content` is kept on the call; a later one replaces it;
 *   - `agent/transports/types.py:27-32` — its shape,
 *     `{"google": {"thought_signature": "..."}}`.
 * Only the rules are taken; the code is ours.
 *
 * Qianmo differences: only the signature string is kept — other keys of
 * `extra_content` are not; and a signature that arrives after the call's
 * block has opened (its first named delta) is not kept: the block is already
 * on the wire. The fixtures put the signature on that first named delta;
 * that Gemini does so has not been checked against a real endpoint.
 */

import { GEMINI_THOUGHT_SIGNATURE_FIELD } from '../../providers/gemini/types.js'

/**
 * Registered (`Symbol.for`) so the send boundary in `src/` can read it
 * without this package exporting it; the key string is the contract.
 */
export const GEMINI_TOOL_CALL_SIGNATURE: unique symbol = Symbol.for(
  'qianmo.geminiToolCallThoughtSignature',
)

/** The signature in a tool call's `extra_content`, if it carries one. */
export function readExtraContentSignature(extra: unknown): string | undefined {
  if (typeof extra !== 'object' || extra === null) return undefined
  const google = (extra as Record<string, unknown>).google
  if (typeof google !== 'object' || google === null) return undefined
  const signature = (google as Record<string, unknown>).thought_signature
  return typeof signature === 'string' && signature !== ''
    ? signature
    : undefined
}

/**
 * The signature a `tool_use` block captured, keyed for the converted tool
 * call; `{}` when it has none.
 */
export function carriedToolCallSignature(block: object): {
  [GEMINI_TOOL_CALL_SIGNATURE]?: string
} {
  const signature = (block as Record<string, unknown>)[
    GEMINI_THOUGHT_SIGNATURE_FIELD
  ]
  return typeof signature === 'string' && signature !== ''
    ? { [GEMINI_TOOL_CALL_SIGNATURE]: signature }
    : {}
}
