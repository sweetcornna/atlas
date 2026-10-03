// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a Responses reply says about itself, kept on the assistant message
 * (P18.19 CH-6, design `providers-console-m1.md` §5.11.5):
 *
 * - `_openaiResponseId` — the response id. Without it a cache miss cannot be
 *   asked about after the fact: OpenAI's diagnostics compare a request with an
 *   earlier response by id (`prompt_cache_options.comparison_response_id`).
 * - `_openaiPromptCacheDiagnostics` — the `prompt_cache_diagnostics` object a
 *   reply carries when the request asked for a comparison (`type`, `reason`,
 *   `comparison_reusable_tokens`, `cache_missed_tokens`), verbatim. OpenAI puts
 *   it on the `response.completed` event's `response` when streaming.
 *
 * Both ride on the message the same way `_openaiReasoningItems` does, so they
 * reach the transcript with it.
 */

export const OPENAI_RESPONSE_ID_FIELD = '_openaiResponseId'
export const OPENAI_PROMPT_CACHE_DIAGNOSTICS_FIELD =
  '_openaiPromptCacheDiagnostics'

/** Filled from the stream's `response` objects as they arrive. */
export type ResponseCapture = {
  id?: string
  diagnostics?: Record<string, unknown>
}

/** Record what a `response.*` event's `response` object says. */
export function captureResponse(
  capture: ResponseCapture,
  response: unknown,
): void {
  if (typeof response !== 'object' || response === null) return
  const r = response as Record<string, unknown>
  if (typeof r.id === 'string' && r.id.length > 0) capture.id = r.id
  const diagnostics = r.prompt_cache_diagnostics
  if (typeof diagnostics === 'object' && diagnostics !== null) {
    capture.diagnostics = diagnostics as Record<string, unknown>
  }
}

/** `base` plus the captured fields; undefined when there is nothing at all. */
export function withResponseMetadata(
  base: Record<string, unknown> | undefined,
  capture: ResponseCapture,
): Record<string, unknown> | undefined {
  if (capture.id === undefined && capture.diagnostics === undefined) return base
  return {
    ...base,
    ...(capture.id !== undefined && { [OPENAI_RESPONSE_ID_FIELD]: capture.id }),
    ...(capture.diagnostics !== undefined && {
      [OPENAI_PROMPT_CACHE_DIAGNOSTICS_FIELD]: capture.diagnostics,
    }),
  }
}

/**
 * The response id of the newest assistant message in `messages` (the
 * conversation as the query layer holds it), if it has one.
 */
export function previousResponseId(
  messages: readonly unknown[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (typeof m !== 'object' || m === null) continue
    const record = m as Record<string, unknown>
    if (record.type !== 'assistant') continue
    const inner = record.message
    if (typeof inner !== 'object' || inner === null) continue
    const id = (inner as Record<string, unknown>)[OPENAI_RESPONSE_ID_FIELD]
    if (typeof id === 'string' && id.length > 0) return id
  }
  return undefined
}
