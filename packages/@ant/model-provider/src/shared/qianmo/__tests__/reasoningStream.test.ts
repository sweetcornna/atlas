// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.8 hermes #7: the reasoning field the provider uses → one thinking block.
 *
 * The chunk sequences below are CONSTRUCTED, not recorded. Field names follow
 * hermes `agent/chat_completion_helpers.py:4128` and
 * `agent/agent_runtime_helpers.py:1810-1823` at `f9b29c49b6`, and the
 * hermes-research §11.9-①A probe that showed the defect on Qianmo; none was
 * received from a real endpoint.
 */
import { describe, expect, test } from 'bun:test'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import { adaptOpenAIStreamToAnthropic } from '../../openaiStreamAdapter.js'
import {
  normalizeReasoningChunks,
  readDeltaReasoning,
} from '../reasoningStream.js'

type Delta = Record<string, unknown>

function chunk(delta: Delta, finish: string | null = null) {
  return {
    id: 'chatcmpl-p188',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [{ index: 0, delta, finish_reason: finish }],
  } as unknown as ChatCompletionChunk
}

const STOP = chunk({}, 'stop')

async function* streamOf(chunks: ChatCompletionChunk[]) {
  for (const c of chunks) yield c
}

type Block = { type: string; text: string }

/** Content blocks in order, with their concatenated text. */
async function blocks(chunks: ChatCompletionChunk[]): Promise<Block[]> {
  const byIndex = new Map<number, Block>()
  for await (const raw of adaptOpenAIStreamToAnthropic(streamOf(chunks), 'm')) {
    const event = raw as unknown as Record<string, any>
    if (event.type === 'content_block_start') {
      byIndex.set(event.index, { type: event.content_block.type, text: '' })
    }
    if (event.type === 'content_block_delta') {
      const block = byIndex.get(event.index)!
      block.text += event.delta.thinking ?? event.delta.text ?? ''
    }
  }
  return [...byIndex.values()]
}

describe('§11.9-① A — reasoning under another field is not lost', () => {
  test('OpenRouter / vLLM / Ollama `delta.reasoning`', async () => {
    expect(
      await blocks([
        chunk({ role: 'assistant', reasoning: 'plan ' }),
        chunk({ reasoning: 'more' }),
        chunk({ content: 'answer' }),
        STOP,
      ]),
    ).toEqual([
      { type: 'thinking', text: 'plan more' },
      { type: 'text', text: 'answer' },
    ])
  })

  test('OpenRouter `reasoning_details[]` text when no reasoning field', async () => {
    expect(
      await blocks([
        chunk({
          reasoning_details: [{ type: 'reasoning.text', text: 'step one; ' }],
        }),
        chunk({
          reasoning_details: [
            { type: 'reasoning.summary', summary: 'step two' },
          ],
        }),
        chunk({ content: 'answer' }),
        STOP,
      ]),
    ).toEqual([
      { type: 'thinking', text: 'step one; step two' },
      { type: 'text', text: 'answer' },
    ])
  })

  test('both fields with the same text (vLLM transition) are read once', async () => {
    expect(
      await blocks([
        chunk({
          reasoning_content: 'plan',
          reasoning: 'plan',
          reasoning_details: [{ type: 'reasoning.text', text: 'plan' }],
        }),
        chunk({ content: 'answer' }),
        STOP,
      ]),
    ).toEqual([
      { type: 'thinking', text: 'plan' },
      { type: 'text', text: 'answer' },
    ])
  })

  test('an encrypted-only detail carries no text and opens nothing', async () => {
    expect(
      await blocks([
        chunk({
          reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }],
        }),
        chunk({ content: 'answer' }),
        STOP,
      ]),
    ).toEqual([{ type: 'text', text: 'answer' }])
  })
})

describe('the empty-string signals are unchanged', () => {
  test('DeepSeek `reasoning_content: ""` before text still opens its empty block', async () => {
    expect(
      await blocks([
        chunk({ reasoning_content: '' }),
        chunk({ content: 'answer' }),
        STOP,
      ]),
    ).toEqual([
      { type: 'thinking', text: '' },
      { type: 'text', text: 'answer' },
    ])
  })

  test('`reasoning: ""` alone is no signal', async () => {
    expect(
      await blocks([
        chunk({ reasoning: '' }),
        chunk({ content: 'answer' }),
        STOP,
      ]),
    ).toEqual([{ type: 'text', text: 'answer' }])
  })

  test('#31: an empty field paired with every text chunk does not churn', async () => {
    expect(
      await blocks([
        chunk({ reasoning: 'r' }),
        chunk({ content: 'a', reasoning_content: '', reasoning: '' }),
        chunk({ content: 'b', reasoning_content: '', reasoning: '' }),
        chunk({ content: 'c', reasoning_content: '', reasoning: '' }),
        STOP,
      ]),
    ).toEqual([
      { type: 'thinking', text: 'r' },
      { type: 'text', text: 'abc' },
    ])
  })
})

describe('readDeltaReasoning', () => {
  test('first non-empty wins, in hermes order', () => {
    expect(readDeltaReasoning({ reasoning_content: 'a', reasoning: 'b' })).toBe(
      'a',
    )
    expect(readDeltaReasoning({ reasoning_content: '', reasoning: 'b' })).toBe(
      'b',
    )
    expect(
      readDeltaReasoning({
        reasoning: null,
        reasoning_details: [{ summary: '', thinking: 't', text: 'x' }],
      }),
    ).toBe('t')
    expect(readDeltaReasoning({ content: 'answer' })).toBeUndefined()
  })
})

describe('normalizeReasoningChunks', () => {
  test('a chunk that needs nothing is passed through as the same object', async () => {
    const plain = [
      chunk({ content: 'a' }),
      chunk({ reasoning_content: 'r' }),
      chunk({ reasoning_content: '' }),
      STOP,
    ]
    const out: ChatCompletionChunk[] = []
    for await (const c of normalizeReasoningChunks(streamOf(plain))) out.push(c)
    expect(out.every((c, i) => c === plain[i])).toBe(true)
  })

  test('a rewritten chunk is a copy; the input is not mutated', async () => {
    const input = chunk({ reasoning: 'r' })
    const out: ChatCompletionChunk[] = []
    for await (const c of normalizeReasoningChunks(streamOf([input]))) {
      out.push(c)
    }
    expect(out[0]).not.toBe(input)
    expect(
      (out[0]!.choices[0]!.delta as Record<string, unknown>).reasoning_content,
    ).toBe('r')
    expect(
      (input.choices[0]!.delta as Record<string, unknown>).reasoning_content,
    ).toBeUndefined()
  })
})

describe('events are unchanged for providers already read', () => {
  test('a reasoning_content stream gives the same events', async () => {
    const chunks = [
      chunk({ role: 'assistant', reasoning_content: 'plan' }),
      chunk({ content: 'answer' }),
      STOP,
    ]
    const events: BetaRawMessageStreamEvent[] = []
    for await (const e of adaptOpenAIStreamToAnthropic(streamOf(chunks), 'm')) {
      events.push(e)
    }
    expect(events.map(e => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
  })
})
