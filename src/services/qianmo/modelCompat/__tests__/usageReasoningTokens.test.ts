// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `reasoning_tokens` reaches the persisted assistant message (P18.12,
 * follow-up from the P18.8 audit). P18.8 taught both OpenAI adapters to read
 * it (hermes #26); the lanes' `updateOpenAIUsage` then dropped it on the way
 * to the message, which is what per-user metering (P15.7) reads.
 *
 * SSE bodies are constructed (OpenAI's documented usage shapes), not recorded.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { updateOpenAIUsage } from 'src/services/api/openai/openaiShared.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import { captureOpenAIRequests } from './support/requestCapture.js'

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => settingsMock.reset())

const CHAT_SSE =
  'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n' +
  'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":7,"completion_tokens_details":{"reasoning_tokens":5}}}\n\n' +
  'data: [DONE]\n\n'

const RESPONSES_SSE =
  'data: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
  'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":6,"output_tokens_details":{"reasoning_tokens":4}}}}\n\n'

async function persistedUsage(
  wire: 'chat' | 'responses',
): Promise<Record<string, unknown>> {
  const outputs: unknown[] = []
  await captureOpenAIRequests({
    model: 'gpt-6-luna',
    baseURL: 'https://gateway.example/v1',
    env: { OPENAI_WIRE_API: wire },
    chatSSE: CHAT_SSE,
    responsesSSE: RESPONSES_SSE,
    outputs,
  })
  const reply = outputs.find(
    o => (o as { type?: string }).type === 'assistant',
  ) as { message: { usage: Record<string, unknown> } } | undefined
  if (!reply) throw new Error('no assistant message')
  return reply.message.usage
}

describe('reasoning_tokens on the persisted message', () => {
  test('chat lane: completion_tokens_details.reasoning_tokens', async () => {
    expect(await persistedUsage('chat')).toMatchObject({
      output_tokens: 7,
      reasoning_tokens: 5,
    })
  })

  test('Responses lane: output_tokens_details.reasoning_tokens', async () => {
    expect(await persistedUsage('responses')).toMatchObject({
      output_tokens: 6,
      reasoning_tokens: 4,
    })
  })
})

describe('updateOpenAIUsage', () => {
  const ZERO = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }

  test('keeps the last reported value across a delta without one', () => {
    const first = updateOpenAIUsage(ZERO, {
      output_tokens: 3,
      reasoning_tokens: 2,
    })
    expect(updateOpenAIUsage(first, { output_tokens: 9 })).toEqual({
      ...ZERO,
      output_tokens: 9,
      reasoning_tokens: 2,
    })
  })

  test('no field when no endpoint reported one', () => {
    expect(
      'reasoning_tokens' in updateOpenAIUsage(ZERO, { output_tokens: 1 }),
    ).toBe(false)
  })
})
