// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.8 hermes #10: Gemini's tool-call thought signature is captured from a
 * Chat Completions stream and carried through the message conversion without
 * being serialised.
 *
 * The chunks are CONSTRUCTED, not recorded: the `extra_content` shape is the
 * one hermes documents (`agent/transports/types.py:27-32` at `f9b29c49b6`);
 * none was received from a real Gemini endpoint.
 */
import { describe, expect, test } from 'bun:test'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import { GEMINI_THOUGHT_SIGNATURE_FIELD } from '../../../providers/gemini/types.js'
import type { AssistantMessage, UserMessage } from '../../../types/message.js'
import type { SystemPrompt } from '../../../types/systemPrompt.js'
import { anthropicMessagesToOpenAI } from '../../openaiConvertMessages.js'
import { adaptOpenAIStreamToAnthropic } from '../../openaiStreamAdapter.js'
import {
  carriedToolCallSignature,
  GEMINI_TOOL_CALL_SIGNATURE,
  readExtraContentSignature,
} from '../geminiToolSignature.js'
import { ToolCallDeltaAssembler } from '../toolCallDeltas.js'

const NO_SYSTEM = [] as unknown as SystemPrompt

const signed = (signature: string) => ({
  google: { thought_signature: signature },
})

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: 'chatcmpl-p188',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gemini-3-pro-preview',
    choices: [{ index: 0, delta, finish_reason: finish }],
  } as unknown as ChatCompletionChunk
}

async function toolUseStarts(chunks: ChatCompletionChunk[]) {
  async function* source() {
    for (const c of chunks) yield c
  }
  const starts: Record<string, unknown>[] = []
  for await (const raw of adaptOpenAIStreamToAnthropic(source(), 'm')) {
    const event = raw as unknown as Record<string, any>
    if (
      event.type === 'content_block_start' &&
      event.content_block.type === 'tool_use'
    ) {
      starts.push(event.content_block)
    }
  }
  return starts
}

describe('readExtraContentSignature', () => {
  test('reads google.thought_signature, nothing else', () => {
    expect(readExtraContentSignature(signed('SIG'))).toBe('SIG')
    expect(readExtraContentSignature(signed(''))).toBeUndefined()
    expect(readExtraContentSignature({ google: {} })).toBeUndefined()
    expect(readExtraContentSignature('SIG')).toBeUndefined()
    expect(readExtraContentSignature(undefined)).toBeUndefined()
  })
})

describe('capture: the stream puts the signature on the tool_use block', () => {
  test('two parallel calls, only the first signed (Gemini signs the first)', async () => {
    const starts = await toolUseStarts([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_a',
            type: 'function',
            function: { name: 'Read', arguments: '{"p":1}' },
            extra_content: signed('SIG-A'),
          },
          {
            index: 1,
            id: 'call_b',
            type: 'function',
            function: { name: 'Grep', arguments: '{}' },
          },
        ],
      }),
      chunk({}, 'tool_calls'),
    ])
    expect(starts).toEqual([
      {
        type: 'tool_use',
        id: 'call_a',
        name: 'Read',
        input: {},
        [GEMINI_THOUGHT_SIGNATURE_FIELD]: 'SIG-A',
      },
      { type: 'tool_use', id: 'call_b', name: 'Grep', input: {} },
    ])
  })

  test('a signature ahead of the name is held with the call', () => {
    const assembler = new ToolCallDeltaAssembler(() => 'gen')
    expect(
      assembler.accept([{ index: 0, id: 'c', extra_content: signed('S0') }]),
    ).toEqual([])
    expect(
      assembler.accept([{ index: 0, extra_content: signed('S1') }]),
    ).toEqual([])
    expect(
      assembler.accept([{ index: 0, function: { name: 'Read' } }]),
    ).toEqual([
      { type: 'start', slot: 0, id: 'c', name: 'Read', thoughtSignature: 'S1' },
    ])
  })

  test('a signature after the block opened is not kept (documented limit)', () => {
    const assembler = new ToolCallDeltaAssembler(() => 'gen')
    assembler.accept([{ index: 0, id: 'c', function: { name: 'Read' } }])
    expect(
      assembler.accept([
        { index: 0, function: { arguments: '{}' }, extra_content: signed('S') },
      ]),
    ).toEqual([{ type: 'arguments', slot: 0, fragment: '{}' }])
  })

  test('an unsigned stream gives the same start step as before', () => {
    const assembler = new ToolCallDeltaAssembler(() => 'gen')
    const [start] = assembler.accept([
      { index: 0, id: 'c', function: { name: 'Read' } },
    ])
    expect(start).toEqual({ type: 'start', slot: 0, id: 'c', name: 'Read' })
    expect(Object.keys(start!)).not.toContain('thoughtSignature')
  })
})

describe('conversion: carried, never serialised', () => {
  const history = [
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
  ] as unknown as (UserMessage | AssistantMessage)[]

  test('the signed call carries it under the symbol key only', () => {
    const [assistant] = anthropicMessagesToOpenAI(history, NO_SYSTEM)
    const calls = (
      assistant as unknown as { tool_calls: Record<symbol, unknown>[] }
    ).tool_calls
    expect(calls[0]![GEMINI_TOOL_CALL_SIGNATURE]).toBe('SIG-A')
    expect(calls[1]![GEMINI_TOOL_CALL_SIGNATURE]).toBeUndefined()
  })

  test('JSON of the converted messages is unchanged by it', () => {
    const converted = anthropicMessagesToOpenAI(history, NO_SYSTEM)
    const json = JSON.stringify(converted)
    expect(json).not.toContain('SIG-A')
    expect(json).not.toContain('extra_content')
    expect(json).not.toContain(GEMINI_THOUGHT_SIGNATURE_FIELD)
  })

  test('the symbol key survives object spread', () => {
    const carried = carriedToolCallSignature({
      [GEMINI_THOUGHT_SIGNATURE_FIELD]: 'S',
    })
    expect({ ...{ id: 'x' }, ...carried }[GEMINI_TOOL_CALL_SIGNATURE]).toBe('S')
    expect(carriedToolCallSignature({})).toEqual({})
  })
})
