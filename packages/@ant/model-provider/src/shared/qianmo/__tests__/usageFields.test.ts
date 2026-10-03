// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.8 hermes #26: reasoning tokens and Anthropic-style top-level cache
 * fields on the Chat Completions lane.
 *
 * The usage objects are CONSTRUCTED, not recorded: field names from hermes
 * `agent/usage_pricing.py:1332-1397` at `f9b29c49b6`; none was received from
 * a real endpoint.
 */
import { describe, expect, test } from 'bun:test'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import { adaptOpenAIStreamToAnthropic } from '../../openaiStreamAdapter.js'
import { readOpenAICachedTokens } from '../../openaiUsage.js'
import {
  readAnthropicStyleCacheWriteTokens,
  readReasoningTokens,
} from '../usageFields.js'

function chunk(
  delta: Record<string, unknown> | null,
  finish: string | null = null,
  usage?: Record<string, unknown>,
) {
  return {
    id: 'chatcmpl-p188',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finish }],
    ...(usage && { usage }),
  } as unknown as ChatCompletionChunk
}

async function finalUsage(
  usage: Record<string, unknown>,
  options?: { includeCacheWriteTokens?: boolean },
) {
  async function* source() {
    yield chunk({ content: 'ok' })
    yield chunk({}, 'stop')
    yield chunk(null, null, usage)
  }
  let last: unknown
  for await (const raw of adaptOpenAIStreamToAnthropic(
    source(),
    'm',
    options,
  )) {
    const event = raw as unknown as Record<string, unknown>
    if (event.type === 'message_delta') last = event.usage
  }
  return last
}

describe('readers', () => {
  test('reasoning: Responses shape first, then chat shape', () => {
    expect(
      readReasoningTokens({
        completion_tokens_details: { reasoning_tokens: 7 },
      }),
    ).toBe(7)
    expect(
      readReasoningTokens({
        output_tokens_details: { reasoning_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 7 },
      }),
    ).toBe(3)
    expect(readReasoningTokens({ completion_tokens: 9 })).toBeUndefined()
  })

  test('cache read: top-level Anthropic-style after the OpenAI spelling', () => {
    expect(readOpenAICachedTokens({ cache_read_input_tokens: 40 })).toBe(40)
    expect(
      readOpenAICachedTokens({
        prompt_tokens_details: { cached_tokens: 10 },
        cache_read_input_tokens: 40,
      }),
    ).toBe(10)
    // Before DeepSeek's and the flattened spelling, as hermes orders them.
    expect(
      readOpenAICachedTokens({
        cache_read_input_tokens: 40,
        prompt_cache_hit_tokens: 5,
        cached_tokens: 6,
      }),
    ).toBe(40)
  })

  test('cache write: Anthropic-style spellings, in hermes order', () => {
    expect(
      readAnthropicStyleCacheWriteTokens({
        prompt_tokens_details: { cache_creation_input_tokens: 4 },
        cache_creation_input_tokens: 5,
      }),
    ).toBe(4)
    expect(
      readAnthropicStyleCacheWriteTokens({ cache_creation_input_tokens: 5 }),
    ).toBe(5)
    expect(readAnthropicStyleCacheWriteTokens({ cache_write_tokens: 6 })).toBe(
      6,
    )
    expect(readAnthropicStyleCacheWriteTokens({ prompt_tokens: 1 })).toBe(
      undefined,
    )
  })
})

describe('stream adapter usage', () => {
  test('reasoning_tokens is carried when the endpoint reports it', async () => {
    expect(
      await finalUsage({
        prompt_tokens: 100,
        completion_tokens: 30,
        completion_tokens_details: { reasoning_tokens: 21 },
      }),
    ).toEqual({
      input_tokens: 100,
      output_tokens: 30,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      reasoning_tokens: 21,
    })
  })

  test('no reasoning report: the usage object is exactly as before', async () => {
    const usage = await finalUsage({
      prompt_tokens: 100,
      completion_tokens: 30,
    })
    expect(usage).toEqual({
      input_tokens: 100,
      output_tokens: 30,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
    expect(Object.keys(usage as object)).not.toContain('reasoning_tokens')
  })

  test('a Claude-routing proxy: top-level cache read and write', async () => {
    expect(
      await finalUsage({
        prompt_tokens: 1000,
        completion_tokens: 10,
        cache_read_input_tokens: 600,
        cache_creation_input_tokens: 300,
      }),
    ).toEqual({
      input_tokens: 100,
      output_tokens: 10,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 600,
    })
  })

  test("OpenAI's own endpoint still reads its own write field", async () => {
    expect(
      await finalUsage(
        {
          prompt_tokens: 1000,
          completion_tokens: 10,
          prompt_tokens_details: {
            cached_tokens: 600,
            cache_write_tokens: 200,
          },
        },
        { includeCacheWriteTokens: true },
      ),
    ).toEqual({
      input_tokens: 200,
      output_tokens: 10,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 600,
    })
  })

  test('elsewhere the OpenAI write field is still not trusted', async () => {
    expect(
      await finalUsage({
        prompt_tokens: 1000,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 200 },
      }),
    ).toEqual({
      input_tokens: 400,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 600,
    })
  })
})
