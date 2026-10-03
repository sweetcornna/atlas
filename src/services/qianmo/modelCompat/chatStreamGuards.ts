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
 *
 * #18 — the idle watchdog. The Responses lane times out a stream that goes
 * quiet (`responsesAdapter.ts`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS`); the chat
 * lane had only the SDK's request timeout, which stops counting once the
 * response headers arrive, so a stream that stalled after its headers held
 * the turn until the process was killed. Now a chunk that does not arrive
 * within the idle timeout aborts the request and fails the attempt with a
 * retryable error, which the ladder (`retryThirdPartyEventStream`) handles
 * like any other dropped stream.
 *
 * The timer counts chunks, not bytes: the SDK owns the body, and
 * `getOpenAIClient` caches its client without regard to a per-request
 * `fetch`, so a byte-level wrapper cannot be attached reliably. A gateway's
 * SSE comment keepalive (`: PROCESSING`) therefore does not reset it. That is
 * why the default here is hermes's chat-stream stale timeout, 180 s, and not
 * the Responses lane's byte-level 90 s; an explicit
 * `CLAUDE_STREAM_IDLE_TIMEOUT_MS` applies to both.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 * `agent/chat_completion_helpers.py:5017-5022` — a streamed chat call with no
 * chunk for `HERMES_STREAM_STALE_TIMEOUT` (default 180 s) is killed and
 * retried. hermes also raises the bound for large contexts, reasoning models
 * and local endpoints (`:5023-5075`); not taken here. Only the default is
 * taken; the code is ours.
 */
import { adaptOpenAIStreamToAnthropic } from '@ant/model-provider'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import { OpenAIRequestError } from 'src/services/api/openai/retry.js'
import {
  clearFreezeAwareTimeout,
  setFreezeAwareTimeout,
} from 'src/utils/network/freezeAwareWatchdog.js'
import { tapReasoningDetails } from './reasoningDetailsReplay.js'

/** hermes `HERMES_STREAM_STALE_TIMEOUT` default. */
export const CHAT_STREAM_IDLE_DEFAULT_MS = 180_000

/** `CLAUDE_STREAM_IDLE_TIMEOUT_MS` when set, else 180 s. */
export function chatStreamIdleTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    Number.parseInt(env.CLAUDE_STREAM_IDLE_TIMEOUT_MS ?? '', 10) ||
    CHAT_STREAM_IDLE_DEFAULT_MS
  )
}

export type ChatStreamGuards = {
  /**
   * Receives this attempt's `reasoning_details` entries in order
   * (`reasoningDetailsReplay.ts`); emptied when the attempt starts.
   */
  reasoningDetails?: unknown[]
  /** Fail the attempt when no chunk arrives for this long (#18). */
  idleTimeout?: { ms: number; label: string }
}

/**
 * `stream`, failing with a retryable `OpenAIRequestError` when the next
 * chunk takes longer than `ms`. The SDK stream's own controller is aborted,
 * which cancels the HTTP request.
 */
export async function* watchChatStreamIdle(
  stream: AsyncIterable<ChatCompletionChunk>,
  idleTimeout: { ms: number; label: string },
): AsyncGenerator<ChatCompletionChunk> {
  const iterator = stream[Symbol.asyncIterator]()
  const controller = (stream as { controller?: unknown }).controller
  let finished = false
  try {
    while (true) {
      const result = await new Promise<IteratorResult<ChatCompletionChunk>>(
        (resolve, reject) => {
          const timer = setFreezeAwareTimeout(() => {
            const error = new OpenAIRequestError(
              `${idleTimeout.label} stream idle timeout after ${idleTimeout.ms}ms`,
              { retryable: true },
            )
            reject(error)
            if (controller instanceof AbortController) controller.abort(error)
          }, idleTimeout.ms)
          iterator.next().then(
            value => {
              clearFreezeAwareTimeout(timer)
              resolve(value)
            },
            error => {
              clearFreezeAwareTimeout(timer)
              reject(error)
            },
          )
        },
      )
      if (result.done) {
        finished = true
        return
      }
      yield result.value
    }
  } finally {
    // Left early (idle timeout, or the consumer stopped): let the SDK
    // stream release its request. Not awaited — after a stall the iterator
    // may never settle on its own.
    if (!finished) void Promise.resolve(iterator.return?.()).catch(() => {})
  }
}

/** `stream` with every guard in `guards` applied, in chunk order. */
export function guardChatStream(
  stream: AsyncIterable<ChatCompletionChunk>,
  guards: ChatStreamGuards,
): AsyncIterable<ChatCompletionChunk> {
  let guarded = stream
  if (guards.idleTimeout) {
    guarded = watchChatStreamIdle(guarded, guards.idleTimeout)
  }
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
