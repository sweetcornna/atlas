// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.8 hermes #10 at the send boundary: a carried Gemini tool-call signature
 * becomes `extra_content` for Gemini-family targets only, and no other lane
 * ever serialises it.
 *
 * Constructed fixtures, not recorded; no vendor is called. The model rule is
 * hermes `agent/transports/chat_completions.py:218-231` at `f9b29c49b6`.
 * The end-to-end rows (stub HTTP capture) are in `requestParity.test.ts`.
 */
import { describe, expect, test } from 'bun:test'
import {
  anthropicMessagesToOpenAI,
  GEMINI_THOUGHT_SIGNATURE_FIELD,
} from '@ant/model-provider'
import { buildOpenAIRequestBody } from 'src/services/api/openai/requestBody.js'
import { buildResponsesRequest } from 'src/services/api/openai/responsesAdapter.js'
import type { AssistantMessage, UserMessage } from 'src/types/message.js'
import { asSystemPrompt } from 'src/utils/session/systemPromptType.js'
import { consumesThoughtSignature } from '../thoughtSignatureReplay.js'

const history = [
  {
    type: 'user',
    uuid: 'u1',
    message: { role: 'user', content: 'q1' },
  },
  {
    type: 'assistant',
    uuid: 'a1',
    message: {
      id: 'm1',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_a',
          name: 'Read',
          input: { p: 1 },
          [GEMINI_THOUGHT_SIGNATURE_FIELD]: 'SIG-A',
        },
        { type: 'tool_use', id: 'call_b', name: 'Grep', input: {} },
      ],
    },
  },
  {
    type: 'user',
    uuid: 'u2',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_a', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'call_b', content: 'ok' },
      ],
    },
  },
] as unknown as (UserMessage | AssistantMessage)[]

function converted() {
  return anthropicMessagesToOpenAI(history, asSystemPrompt([]))
}

function sentToolCalls(model: string, baseURL: string): unknown {
  const body = buildOpenAIRequestBody({
    model,
    messages: converted(),
    tools: [],
    toolChoice: undefined,
    enableThinking: false,
    maxTokens: 1024,
    baseURL,
  })
  // The wire form: what the SDK serialises.
  const wire = JSON.parse(JSON.stringify(body)) as {
    messages: { role: string; tool_calls?: unknown }[]
  }
  return wire.messages.find(m => m.role === 'assistant')?.tool_calls
}

const READ_CALL = {
  id: 'call_a',
  type: 'function',
  function: { name: 'Read', arguments: '{"p":1}' },
}
const GREP_CALL = {
  id: 'call_b',
  type: 'function',
  function: { name: 'Grep', arguments: '{}' },
}

describe('consumesThoughtSignature (hermes rule)', () => {
  test('gemini / gemma in the model id, any case, any host', () => {
    expect(consumesThoughtSignature('gemini-3-pro-preview')).toBe(true)
    expect(consumesThoughtSignature('google/Gemini-3-Flash')).toBe(true)
    expect(consumesThoughtSignature('gemma-4-27b-it')).toBe(true)
    expect(consumesThoughtSignature('gpt-4.1')).toBe(false)
    expect(consumesThoughtSignature('kimi-k3')).toBe(false)
  })
})

describe('chat lane send boundary', () => {
  test('Gemini target: the signed call gets extra_content, the other not', () => {
    expect(
      sentToolCalls(
        'gemini-3-pro-preview',
        'https://generativelanguage.googleapis.com/v1beta/openai',
      ),
    ).toEqual([
      {
        ...READ_CALL,
        extra_content: { google: { thought_signature: 'SIG-A' } },
      },
      GREP_CALL,
    ])
  })

  test('Gemma on a local server: same', () => {
    expect(
      sentToolCalls('gemma-4-27b-it', 'http://localhost:11434/v1'),
    ).toEqual([
      {
        ...READ_CALL,
        extra_content: { google: { thought_signature: 'SIG-A' } },
      },
      GREP_CALL,
    ])
  })

  test('any other target: the calls exactly as before', () => {
    for (const [model, baseURL] of [
      ['mistral-large-latest', 'https://api.mistral.ai/v1'],
      ['kimi-k3', 'https://api.moonshot.cn/v1'],
      ['deepseek-v4-pro', 'https://api.deepseek.com'],
    ] as const) {
      expect(sentToolCalls(model, baseURL)).toEqual([READ_CALL, GREP_CALL])
    }
  })

  test('the converted messages are not mutated', () => {
    const messages = converted()
    buildOpenAIRequestBody({
      model: 'gemini-3-pro-preview',
      messages,
      tools: [],
      toolChoice: undefined,
      enableThinking: false,
      maxTokens: 1024,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    })
    expect(JSON.stringify(messages)).not.toContain('extra_content')
  })
})

describe('lanes that do not pass the send boundary never carry it', () => {
  test('Responses: function_call items have no signature', () => {
    const request = buildResponsesRequest({
      model: 'gemini-3-pro-preview',
      messages: converted(),
      tools: [],
      toolChoice: undefined,
    })
    const json = JSON.stringify(request)
    expect(json).not.toContain('SIG-A')
    expect(json).not.toContain('extra_content')
  })

  test('Grok (sends the conversion as is): no signature in the JSON', () => {
    const json = JSON.stringify(converted())
    expect(json).not.toContain('SIG-A')
    expect(json).not.toContain('extra_content')
  })
})
