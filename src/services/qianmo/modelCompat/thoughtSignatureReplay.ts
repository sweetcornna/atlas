// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Gemini's tool-call thought signature, sent back only to Gemini-family
 * targets on the chat lane (P18.8, hermes #10; design
 * `providers-console-m1.md` §5.6 row 10).
 *
 * The signature was captured from the stream and carried through the message
 * conversion under a symbol key that is never serialised
 * (`packages/@ant/model-provider/src/shared/qianmo/geminiToolSignature.ts`
 * explains the path). Here, at the send boundary (`requestBody.ts`, via
 * `applyReasoningReplayPolicy`), it becomes
 * `extra_content: { google: { thought_signature } }` when the target model is
 * Gemini-family — which rejects a replayed call without it — and stays
 * invisible for every other target, which rejects the key.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 *   - `agent/transports/chat_completions.py:218-231`
 *     `_model_consumes_thought_signature` — kept only when the outgoing model
 *     id contains `gemini` or `gemma` (case-insensitive), whatever the host;
 *     stripped for everyone else, "including non-Gemini models that inherited
 *     stale Gemini `extra_content` earlier in a mixed-provider session"
 *     (`:254-261`, `:280-282`, `:399-416`).
 * Only the rules are taken; the code is ours.
 */
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions/completions.mjs'

/**
 * Same registered symbol as `GEMINI_TOOL_CALL_SIGNATURE` in
 * `geminiToolSignature.ts` (the package does not export it to `src/`); the
 * key string is the contract, pinned end to end by `thoughtSignature.test.ts`.
 */
const GEMINI_TOOL_CALL_SIGNATURE: unique symbol = Symbol.for(
  'qianmo.geminiToolCallThoughtSignature',
)

type AssistantParam = Extract<ChatCompletionMessageParam, { role: 'assistant' }>
type ToolCall = NonNullable<AssistantParam['tool_calls']>[number]
type CarriedToolCall = ToolCall & {
  [GEMINI_TOOL_CALL_SIGNATURE]?: unknown
  extra_content?: unknown
}

/** hermes `_model_consumes_thought_signature`. */
export function consumesThoughtSignature(model: string): boolean {
  const lower = model.toLowerCase()
  return lower.includes('gemini') || lower.includes('gemma')
}

function withExtraContent(call: CarriedToolCall): ToolCall {
  const signature = call[GEMINI_TOOL_CALL_SIGNATURE]
  if (typeof signature !== 'string' || signature === '') return call
  if (call.extra_content !== undefined) return call
  const replayed: CarriedToolCall = {
    ...call,
    extra_content: { google: { thought_signature: signature } },
  }
  return replayed
}

/**
 * `message` with each carried signature written as `extra_content` when
 * `model` is Gemini-family; the same object otherwise, or when there is none.
 */
export function replayThoughtSignatures<T extends AssistantParam>(
  message: T,
  model: string,
): T {
  const calls = message.tool_calls
  if (!consumesThoughtSignature(model) || !calls?.length) return message
  const replayed = calls.map(withExtraContent)
  if (replayed.every((call, i) => call === calls[i])) return message
  return { ...message, tool_calls: replayed }
}
