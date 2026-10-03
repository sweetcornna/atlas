// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the chat lane does to the raw SDK chunk stream before the stream
 * adapter sees it (P18.12; design `providers-console-m1.md` §5.6).
 *
 * The adapter (`openaiStreamAdapter.ts`) sees normalised chunks: its first
 * step is `normalizeReasoningChunks`, which rewrites reasoning fields and
 * splits a chunk so usage comes first and tool calls / finish_reason last.
 * Anything that needs the vendor's chunks as sent — the `reasoning_details`
 * array OpenRouter wants back verbatim — has to look before that, which is
 * here: the lanes call {@link adaptGuardedChatStream} where they called
 * `adaptOpenAIStreamToAnthropic`, with the same three arguments and one more.
 */
import { adaptOpenAIStreamToAnthropic } from '@ant/model-provider'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import { tapReasoningDetails } from './reasoningDetailsReplay.js'

export type ChatStreamGuards = {
  /**
   * Receives this attempt's `reasoning_details` entries in order
   * (`reasoningDetailsReplay.ts`); emptied when the attempt starts.
   */
  reasoningDetails?: unknown[]
}

/** `stream` with every guard in `guards` applied, in chunk order. */
export function guardChatStream(
  stream: AsyncIterable<ChatCompletionChunk>,
  guards: ChatStreamGuards,
): AsyncIterable<ChatCompletionChunk> {
  let guarded = stream
  if (guards.reasoningDetails) {
    guarded = tapReasoningDetails(guarded, guards.reasoningDetails)
  }
  return guarded
}

/**
 * `adaptOpenAIStreamToAnthropic(stream, model, options)` over the guarded
 * raw stream.
 */
export function adaptGuardedChatStream(
  stream: AsyncIterable<ChatCompletionChunk>,
  model: string,
  options: Parameters<typeof adaptOpenAIStreamToAnthropic>[2],
  guards: ChatStreamGuards,
): ReturnType<typeof adaptOpenAIStreamToAnthropic> {
  return adaptOpenAIStreamToAnthropic(
    guardChatStream(stream, guards),
    model,
    options,
  )
}
