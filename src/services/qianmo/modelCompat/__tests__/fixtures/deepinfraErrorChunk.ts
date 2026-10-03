// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DeepInfra-shaped in-stream error (hermes #19). CONSTRUCTED, not recorded:
 * the shape is the one hermes describes at `agent/chat_completion_helpers.py:
 * 4097-4122` (`f9b29c49b6`) — a chunk with `choices` missing or empty and the
 * error in top-level `error_type` / `error_message` — "Some OpenAI-compatible
 * providers (DeepInfra, etc.) return validation errors as in-stream error
 * chunks". The message text is ours. Kept as a `.ts` module because the
 * license-header gate does not accept `.jsonl`.
 */

const ROLE_CHUNK = {
  id: 'chatcmpl-deepinfra-fixture',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'meta-llama/Llama-4-Scout',
  choices: [
    {
      index: 0,
      delta: { role: 'assistant', content: '' },
      finish_reason: null,
    },
  ],
}

/** `choices` absent, error at the top level. */
export const DEEPINFRA_ERROR_CHUNK = {
  id: 'chatcmpl-deepinfra-fixture',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'meta-llama/Llama-4-Scout',
  error_type: 'invalid_request_error',
  error_message:
    'Requested token count exceeds the model maximum context length',
}

/** The same with `choices: []`. */
export const DEEPINFRA_ERROR_CHUNK_EMPTY_CHOICES = {
  ...DEEPINFRA_ERROR_CHUNK,
  choices: [],
}

function sse(...chunks: object[]): string {
  return `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
}

export const DEEPINFRA_ERROR_SSE = sse(ROLE_CHUNK, DEEPINFRA_ERROR_CHUNK)
export const DEEPINFRA_ERROR_SSE_EMPTY_CHOICES = sse(
  ROLE_CHUNK,
  DEEPINFRA_ERROR_CHUNK_EMPTY_CHOICES,
)

/** A usage-only final chunk (OpenAI's `include_usage`) — not an error. */
export const USAGE_ONLY_SSE = sse(
  {
    ...ROLE_CHUNK,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: 'ok' },
        finish_reason: null,
      },
    ],
  },
  { ...ROLE_CHUNK, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  {
    ...ROLE_CHUNK,
    choices: [],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  },
)
