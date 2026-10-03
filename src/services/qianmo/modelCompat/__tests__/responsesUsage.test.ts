// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.8 hermes #26 on the Responses lane: `output_tokens_details.
 * reasoning_tokens` is carried into the usage the lane reports.
 *
 * Constructed `response.completed` payloads, not recorded (field names from
 * hermes `agent/usage_pricing.py:1381-1391` at `f9b29c49b6`).
 */
import { describe, expect, test } from 'bun:test'
import { extractUsage } from 'src/services/api/openai/responsesAdapter.js'
import { readResponsesReasoningTokens } from '../responsesUsage.js'

describe('Responses usage', () => {
  test('reasoning tokens are carried', () => {
    expect(
      extractUsage({
        usage: {
          input_tokens: 1000,
          output_tokens: 300,
          input_tokens_details: { cached_tokens: 800 },
          output_tokens_details: { reasoning_tokens: 250 },
        },
      }),
    ).toEqual({
      input_tokens: 200,
      output_tokens: 300,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 800,
      reasoning_tokens: 250,
    })
  })

  test('without a report the usage object is exactly as before', () => {
    const usage = extractUsage({
      usage: { input_tokens: 10, output_tokens: 3 },
    })
    expect(usage).toEqual({
      input_tokens: 10,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
    expect(Object.keys(usage)).not.toContain('reasoning_tokens')
  })

  test('reader', () => {
    expect(
      readResponsesReasoningTokens({
        output_tokens_details: { reasoning_tokens: 0 },
      }),
    ).toBe(0)
    expect(readResponsesReasoningTokens({ output_tokens: 3 })).toBeUndefined()
    expect(readResponsesReasoningTokens(undefined)).toBeUndefined()
  })
})
