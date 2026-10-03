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
 *
 * #19 — an error sent inside the stream. Some OpenAI-compatible providers
 * answer a bad request with a chunk that has no `choices` and the error in
 * top-level `error_type` / `error_message` (DeepInfra). The SDK only throws
 * for a top-level `error` object, and the adapter reads a chunk without
 * `choices` as an empty delta — so the stream ended without a finish_reason
 * and the ladder re-sent the same bad request, then reported "stream ended
 * before finish_reason" (fixture `__tests__/fixtures/deepinfraErrorChunk.ts`,
 * measured 1 + `CLAUDE_CODE_MAX_RETRIES` requests). Now such a chunk ends the
 * attempt with a `NonRetryableError` carrying the vendor's words.
 *
 * 规则来源同上，`agent/chat_completion_helpers.py:4091-4122` (#65631): "Some
 * OpenAI-compatible providers (DeepInfra, etc.) return validation errors as
 * in-stream error chunks … Without this check the error is silently dropped
 * … and pointless retries on the same bad request." Qianmo difference: hermes
 * derives a status from the payload and lets its classifier decide; here the
 * chunk is never retried (design §5.6 row 19), its category taken from the
 * classifier.
 */
import { adaptOpenAIStreamToAnthropic } from '@ant/model-provider'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import { OpenAIRequestError } from 'src/services/api/openai/retry.js'
import {
  classifyRetryableAPIError,
  NonRetryableError,
} from 'src/services/api/retryClassification.js'
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
  /** End the attempt at an in-stream error chunk (#19). */
  errorChunks?: { label: string }
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

/**
 * The in-stream error a chunk carries (#19): `choices` missing or empty and
 * a top-level `error_type` or `error_message`. `undefined` for every other
 * chunk, including the usage-only final chunk.
 */
export function streamErrorChunk(
  chunk: unknown,
): { type?: string; message?: string } | undefined {
  if (typeof chunk !== 'object' || chunk === null) return undefined
  const record = chunk as Record<string, unknown>
  const choices = record.choices
  if (Array.isArray(choices) && choices.length > 0) return undefined
  const type =
    typeof record.error_type === 'string' && record.error_type
      ? record.error_type
      : undefined
  const message =
    typeof record.error_message === 'string' && record.error_message
      ? record.error_message
      : undefined
  return type || message ? { type, message } : undefined
}

/** `stream`, ending the attempt at the first in-stream error chunk. */
export async function* throwOnStreamErrorChunks(
  stream: AsyncIterable<ChatCompletionChunk>,
  label: string,
): AsyncGenerator<ChatCompletionChunk> {
  for await (const chunk of stream) {
    const error = streamErrorChunk(chunk)
    if (error) {
      const detail = [error.type, error.message].filter(Boolean).join(': ')
      throw new NonRetryableError(`${label} stream error: ${detail}`, {
        category: classifyRetryableAPIError({
          type: error.type,
          message: error.message,
        }).category,
      })
    }
    yield chunk
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
  if (guards.errorChunks) {
    guarded = throwOnStreamErrorChunks(guarded, guards.errorChunks.label)
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
