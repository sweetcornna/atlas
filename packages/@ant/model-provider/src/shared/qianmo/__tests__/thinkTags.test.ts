// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.8 hermes #8: reasoning written inline in the answer text → thinking.
 *
 * The chunk sequences below are CONSTRUCTED, not recorded. They follow the
 * provider behaviour hermes describes at `f9b29c49b6` — MiniMax-M2.7 streaming
 * `<think>` / reasoning / `</think>` as separate deltas
 * (`agent/think_scrubber.py:8-12`), the boundary rule for prose that mentions
 * a tag (`:47-54`) — and the hermes-research §11.9-①B probe that showed the
 * defect on Qianmo; none was received from a real endpoint.
 */
import { describe, expect, test } from 'bun:test'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import { adaptOpenAIStreamToAnthropic } from '../../openaiStreamAdapter.js'
import { normalizeReasoningChunks } from '../reasoningStream.js'
import { type InlineSegment, InlineThinkSplitter } from '../thinkTags.js'

type Delta = Record<string, unknown>

function chunk(delta: Delta | null, finish: string | null = null) {
  return {
    id: 'chatcmpl-p188',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finish }],
  } as unknown as ChatCompletionChunk
}

const STOP = chunk({}, 'stop')

async function* streamOf(chunks: ChatCompletionChunk[]) {
  for (const c of chunks) yield c
}

type Block = { type: string; text: string }

async function run(chunks: ChatCompletionChunk[]) {
  const byIndex = new Map<number, Block>()
  let stopReason: unknown
  let usage: unknown
  for await (const raw of adaptOpenAIStreamToAnthropic(streamOf(chunks), 'm')) {
    const event = raw as unknown as Record<string, any>
    if (event.type === 'content_block_start') {
      const block = event.content_block
      byIndex.set(event.index, {
        type: block.type,
        text: block.type === 'tool_use' ? block.name : '',
      })
    }
    if (event.type === 'content_block_delta') {
      const block = byIndex.get(event.index)!
      block.text +=
        event.delta.thinking ?? event.delta.text ?? event.delta.partial_json
    }
    if (event.type === 'message_delta') {
      stopReason = event.delta.stop_reason
      usage = event.usage
    }
  }
  return { blocks: [...byIndex.values()], stopReason, usage }
}

async function blocks(chunks: ChatCompletionChunk[]): Promise<Block[]> {
  return (await run(chunks)).blocks
}

const text = (t: string) => chunk({ content: t })

describe('§11.9-① B — inline <think> is reasoning, not answer', () => {
  test('one delta with the whole block (the probe)', async () => {
    expect(await blocks([text('<think>plan</think>answer'), STOP])).toEqual([
      { type: 'thinking', text: 'plan' },
      { type: 'text', text: 'answer' },
    ])
  })

  test('MiniMax: open tag, reasoning and close tag as separate deltas', async () => {
    expect(
      await blocks([
        chunk({ role: 'assistant', content: '<think>' }),
        text('\nLet me check their config'),
        text('</think>'),
        text('\n\nanswer'),
        STOP,
      ]),
    ).toEqual([
      { type: 'thinking', text: 'Let me check their config' },
      { type: 'text', text: 'answer' },
    ])
  })
})

describe('a tag cut between two deltas', () => {
  test('open and close tags each split across deltas', async () => {
    expect(
      await blocks([
        text('<thi'),
        text('nk>plan</th'),
        text('ink>answer'),
        STOP,
      ]),
    ).toEqual([
      { type: 'thinking', text: 'plan' },
      { type: 'text', text: 'answer' },
    ])
  })

  test('cut one character in', async () => {
    expect(
      await blocks([text('<'), text('think>plan<'), text('/think>ok'), STOP]),
    ).toEqual([
      { type: 'thinking', text: 'plan' },
      { type: 'text', text: 'ok' },
    ])
  })

  test('a held "<" that is not a tag is released in order', async () => {
    expect(await blocks([text('if a <'), text(' b then'), STOP])).toEqual([
      { type: 'text', text: 'if a < b then' },
    ])
  })

  test('a held "<" at the very end is released at finish_reason', async () => {
    expect(await blocks([text('a <'), STOP])).toEqual([
      { type: 'text', text: 'a <' },
    ])
  })
})

describe('tag variants, from hermes', () => {
  for (const tag of [
    'think',
    'thinking',
    'reasoning',
    'thought',
    'REASONING_SCRATCHPAD',
    'THINK',
    'Thinking',
  ]) {
    test(`<${tag}>`, async () => {
      expect(await blocks([text(`<${tag}>r</${tag}>a`), STOP])).toEqual([
        { type: 'thinking', text: 'r' },
        { type: 'text', text: 'a' },
      ])
    })
  }
})

describe('prose that mentions a tag is left alone', () => {
  test('an open tag mid-line, with no close, stays text', async () => {
    expect(
      await blocks([text('Wrap the plan in a <think>'), text(' tag.'), STOP]),
    ).toEqual([{ type: 'text', text: 'Wrap the plan in a <think> tag.' }])
  })

  test('an open tag at the start of a later line opens a block', async () => {
    expect(
      await blocks([
        text('intro\n'),
        text('<think>more'),
        text('</think>\ntail'),
        STOP,
      ]),
    ).toEqual([
      { type: 'text', text: 'intro\n' },
      { type: 'thinking', text: 'more' },
      { type: 'text', text: 'tail' },
    ])
  })
})

describe('end of stream and tool calls', () => {
  test('an unterminated block stays reasoning; nothing leaks into text', async () => {
    expect(
      await blocks([text('<think>plan'), text(' still going</thi'), STOP]),
    ).toEqual([{ type: 'thinking', text: 'plan still going</thi' }])
  })

  test('Qwen3 with thinking off: the empty block leaves the answer alone', async () => {
    expect(
      await blocks([text('<think>\n\n</think>\n\n'), text('answer'), STOP]),
    ).toEqual([{ type: 'text', text: 'answer' }])
  })

  test('an orphan close tag is removed with its whitespace', async () => {
    expect(await blocks([text('</think>\n\nanswer'), STOP])).toEqual([
      { type: 'text', text: 'answer' },
    ])
  })

  test('think then a tool call: no whitespace-only text block', async () => {
    const { blocks: out, stopReason } = await run([
      text('<think>read it first</think>\n\n'),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            function: { name: 'Read', arguments: '{}' },
          },
        ],
      }),
      chunk({}, 'tool_calls'),
    ])
    expect(out).toEqual([
      { type: 'thinking', text: 'read it first' },
      { type: 'tool_use', text: 'Read{}' },
    ])
    expect(stopReason).toBe('tool_use')
  })

  test('block, text, tool call and finish in one chunk keep their order', async () => {
    const { blocks: out, stopReason } = await run([
      chunk(
        {
          content: '<think>r</think>a',
          tool_calls: [
            { index: 0, id: 'c', function: { name: 'Bash', arguments: '{}' } },
          ],
        },
        'tool_calls',
      ),
    ])
    expect(out).toEqual([
      { type: 'thinking', text: 'r' },
      { type: 'text', text: 'a' },
      { type: 'tool_use', text: 'Bash{}' },
    ])
    expect(stopReason).toBe('tool_use')
  })

  test('usage on a split chunk is counted once', async () => {
    const withUsage = {
      ...(chunk({ content: '<think>r</think>a' }, 'stop') as object),
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    } as unknown as ChatCompletionChunk
    const { usage } = await run([withUsage])
    expect(usage).toMatchObject({ input_tokens: 10, output_tokens: 3 })
  })

  test('a held tail is released when the stream ends with a usage chunk', async () => {
    const terminalUsage = {
      ...(chunk(null) as object),
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    } as unknown as ChatCompletionChunk
    expect(await blocks([text('x <'), terminalUsage])).toEqual([
      { type: 'text', text: 'x <' },
    ])
  })
})

describe('structured reasoning is unaffected', () => {
  test('reasoning_content plus a tagged-looking answer line mid-text', async () => {
    expect(
      await blocks([
        chunk({ reasoning_content: 'plan' }),
        text('Use the <reasoning> element'),
        STOP,
      ]),
    ).toEqual([
      { type: 'thinking', text: 'plan' },
      { type: 'text', text: 'Use the <reasoning> element' },
    ])
  })

  test('#31: empty reasoning_content mid-text still does not churn', async () => {
    expect(
      await blocks([
        chunk({ reasoning_content: 'r' }),
        chunk({ content: 'a', reasoning_content: '' }),
        chunk({ content: '<think>x</think>b', reasoning_content: '' }),
        chunk({ content: 'c', reasoning_content: '' }),
        STOP,
      ]),
    ).toEqual([
      { type: 'thinking', text: 'r' },
      { type: 'text', text: 'a' },
      { type: 'thinking', text: 'x' },
      { type: 'text', text: 'bc' },
    ])
  })

  test('plain text chunks are passed through as the same objects', async () => {
    const plain = [text('a <b>bold</b>'), text('\n'), text('c'), STOP]
    const out: ChatCompletionChunk[] = []
    for await (const c of normalizeReasoningChunks(streamOf(plain))) out.push(c)
    expect(out.length).toBe(plain.length)
    expect(out.every((c, i) => c === plain[i])).toBe(true)
  })
})

describe('InlineThinkSplitter', () => {
  function feedAll(deltas: string[]): InlineSegment[] {
    const splitter = new InlineThinkSplitter()
    const out: InlineSegment[] = []
    for (const d of deltas) out.push(...splitter.feed(d))
    out.push(...splitter.flush())
    return out
  }

  test('streams block text as it arrives, holding only a possible tag', () => {
    const splitter = new InlineThinkSplitter()
    expect(splitter.feed('<think>abc</')).toEqual([
      { kind: 'reasoning', text: 'abc' },
    ])
    expect(splitter.feed('think>z')).toEqual([{ kind: 'text', text: 'z' }])
  })

  test('the earlier of a closed pair and a boundary open wins', () => {
    expect(feedAll(['x <think>a</think> y\n<thought>b'])).toEqual([
      { kind: 'text', text: 'x ' },
      { kind: 'reasoning', text: 'a' },
      { kind: 'text', text: 'y\n' },
      { kind: 'reasoning', text: 'b' },
    ])
  })

  test('flush starts a new stream', () => {
    const splitter = new InlineThinkSplitter()
    splitter.feed('mid-line ')
    splitter.flush()
    expect(splitter.feed('<think>r')).toEqual([
      { kind: 'reasoning', text: 'r' },
    ])
  })
})
