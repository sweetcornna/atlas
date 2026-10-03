// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where a Chat Completions stream carries the model's reasoning, normalised
 * before the stream adapter sees it (P18.8, hermes #7; design
 * `providers-console-m1.md` §5.6 row 7).
 *
 * `openaiStreamAdapter.ts` reads one field, `delta.reasoning_content`
 * (DeepSeek, Moonshot, Qwen). Providers that put the reasoning under
 * `delta.reasoning` (OpenRouter, vLLM, Ollama) or only in
 * `delta.reasoning_details[]` (OpenRouter's unified format) lost all of it:
 * the answer arrived with no thinking block (hermes-research §11.9-①A).
 *
 * Now each chunk's reasoning is read from whichever field carries it and
 * handed to the adapter as `reasoning_content`; a chunk that needs nothing is
 * passed through as the same object.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 *   - `agent/chat_completion_helpers.py:4128` — the streamed reasoning is
 *     `delta.reasoning_content or delta.reasoning`: the first non-empty one;
 *   - `agent/agent_runtime_helpers.py:1810-1823` — a `reasoning_details[]`
 *     entry's text is the first non-empty of `summary`, `thinking`, `content`,
 *     `text`. hermes reads that array off the finished message only; here it
 *     is the third choice for a delta that has neither field.
 * Only the rules are taken; the code is ours.
 *
 * Qianmo difference: `reasoning_content: ""` with nothing else is kept as
 * `""`. hermes drops it (falsy); the adapter needs it — it is DeepSeek's
 * "answered directly" signal, whose empty thinking block must round-trip.
 * `reasoning: ""` carries no such contract and is dropped, as in hermes.
 *
 * Not done here: `reasoning_details` is only read, not kept for replay. Raw
 * replay needs message-level metadata written in `src/services/api/openai/
 * index.ts`, which P18.8 does not touch; hermes's own streaming path does not
 * replay it either.
 */
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'

type ReasoningDelta = ChatCompletionChunk.Choice.Delta & {
  reasoning_content?: string | null
}

/** `reasoning_details[]` entry fields that carry text, in hermes's order. */
const DETAIL_TEXT_FIELDS = ['summary', 'thinking', 'content', 'text'] as const

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function reasoningDetailsText(details: unknown): string {
  if (!Array.isArray(details)) return ''
  let text = ''
  for (const detail of details) {
    if (typeof detail !== 'object' || detail === null) continue
    const record = detail as Record<string, unknown>
    for (const field of DETAIL_TEXT_FIELDS) {
      const value = nonEmptyString(record[field])
      if (value !== undefined) {
        text += value
        break
      }
    }
  }
  return text
}

/**
 * The reasoning one delta carries: `reasoning_content`, else `reasoning`,
 * else the text of `reasoning_details[]` — the first that is non-empty; `""`
 * when the only signal is `reasoning_content: ""`; `undefined` when none.
 */
export function readDeltaReasoning(
  delta: Record<string, unknown>,
): string | undefined {
  const text =
    nonEmptyString(delta.reasoning_content) ??
    nonEmptyString(delta.reasoning) ??
    nonEmptyString(reasoningDetailsText(delta.reasoning_details))
  if (text !== undefined) return text
  return delta.reasoning_content === '' ? '' : undefined
}

function normalizeChunk(chunk: ChatCompletionChunk): ChatCompletionChunk {
  const choice = chunk.choices?.[0]
  const delta = choice?.delta as ReasoningDelta | undefined
  if (!choice || !delta) return chunk
  const reasoning = readDeltaReasoning(delta as Record<string, unknown>)
  if (reasoning === undefined && delta.reasoning_content == null) return chunk
  if (reasoning === delta.reasoning_content) return chunk
  const normalized: ReasoningDelta = { ...delta, reasoning_content: reasoning }
  return {
    ...chunk,
    choices: [{ ...choice, delta: normalized }, ...chunk.choices.slice(1)],
  }
}

/**
 * The stream with each chunk's reasoning under `delta.reasoning_content`, the
 * one field the adapter reads.
 */
export async function* normalizeReasoningChunks(
  stream: AsyncIterable<ChatCompletionChunk>,
): AsyncGenerator<ChatCompletionChunk, void> {
  for await (const chunk of stream) {
    yield normalizeChunk(chunk)
  }
}
