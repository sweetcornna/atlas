// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * hermes #24 — reasoning that used the whole output budget is not continued
 * (P18.12). Runs the real `query()` loop over the real chat lane; the SSE
 * bodies are constructed (reasoning deltas, `finish_reason: "length"`, usage
 * in the final chunk). No vendor was called.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { resetStateForTests } from 'src/bootstrap/state.js'
import type { Message } from 'src/types/message.js'
import { createUserMessage } from 'src/utils/messages.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import { thinkingExhaustion } from '../thinkingExhaustion.js'
import { emittedTexts, runQueryOverOpenAILane } from './support/queryHarness.js'

const settingsMock = setupSettingsMock()
const ENV: Record<string, string> = {
  CLAUDE_CODE_USE_OPENAI: '1',
  OPENAI_API_KEY: 'sk-test-canary-p1812-exhaustion',
  OPENAI_BASE_URL: 'https://api.relay.example/v1',
  OPENAI_WIRE_API: 'chat',
  CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
}
const ENV_CLEARED = [
  'OPENAI_MAX_TOKENS',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'GEMINI_MAX_TOKENS',
  'GROK_MAX_TOKENS',
]
const saved = new Map<string, string | undefined>()
beforeAll(() => {
  settingsMock.set({ getInitialSettings: () => ({}) })
  for (const key of [...Object.keys(ENV), ...ENV_CLEARED]) {
    saved.set(key, process.env[key])
  }
  for (const [key, value] of Object.entries(ENV)) process.env[key] = value
  for (const key of ENV_CLEARED) delete process.env[key]
})
afterAll(() => {
  settingsMock.reset()
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetStateForTests()
})

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}
function usage(completionTokens: number) {
  return `data: ${JSON.stringify({
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: completionTokens },
  })}\n\n`
}

/** Reasoning only, stopped by the limit. */
function exhaustedSSE(completionTokens: number): string {
  return (
    chunk({ role: 'assistant', reasoning_content: 'Let me think about' }) +
    chunk({ reasoning_content: ' this for a very long time' }) +
    chunk({}, 'length') +
    usage(completionTokens) +
    'data: [DONE]\n\n'
  )
}

/** Visible text, stopped by the limit — the case continuation is for. */
const TRUNCATED_ANSWER_SSE =
  chunk({ role: 'assistant', content: 'The answer begins' }) +
  chunk({}, 'length') +
  usage(4096) +
  'data: [DONE]\n\n'

const DONE_SSE =
  chunk({ role: 'assistant', content: 'done' }) +
  chunk({}, 'stop') +
  usage(10) +
  'data: [DONE]\n\n'

function lane(answers: string[]) {
  const sent: { maxTokens: unknown; lastUser: string }[] = []
  const fetchOverride = (async (
    _input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      max_tokens?: number
      max_completion_tokens?: number
      messages: { role: string; content: unknown }[]
    }
    const lastUser = body.messages.filter(m => m.role === 'user').at(-1)
    sent.push({
      maxTokens: body.max_tokens ?? body.max_completion_tokens,
      lastUser: typeof lastUser?.content === 'string' ? lastUser.content : '',
    })
    const sse = answers.length > 1 ? answers.shift()! : answers[0]!
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch
  return { sent, fetchOverride }
}

const HISTORY = [createUserMessage({ content: 'q' })] as unknown as Message[]
const CONTINUATION = 'Output token limit hit. Resume directly'

describe('thinkingExhaustion — the verdict', () => {
  const reasoningOnly = {
    type: 'assistant',
    uuid: randomUUID(),
    message: {
      content: [{ type: 'thinking', thinking: 'hm', signature: '' }],
      usage: { output_tokens: 4096 },
    },
  } as never

  test('reasoning only, limit below 64k, nothing set: raise', () => {
    expect(
      thinkingExhaustion({
        assistantMessages: [reasoningOnly],
        maxOutputTokensOverride: undefined,
        escalatedMaxTokens: 64_000,
        env: {},
      }),
    ).toBe('raise')
  })

  test('already raised, or the user set a limit: stop', () => {
    expect(
      thinkingExhaustion({
        assistantMessages: [reasoningOnly],
        maxOutputTokensOverride: 64_000,
        escalatedMaxTokens: 64_000,
        env: {},
      }),
    ).toBe('stop')
    expect(
      thinkingExhaustion({
        assistantMessages: [reasoningOnly],
        maxOutputTokensOverride: undefined,
        escalatedMaxTokens: 64_000,
        env: { OPENAI_MAX_TOKENS: '4096' },
      }),
    ).toBe('stop')
  })

  test('no reasoning (hermes: a normal truncation): none', () => {
    expect(
      thinkingExhaustion({
        assistantMessages: [
          {
            type: 'assistant',
            message: { content: [], usage: { output_tokens: 4096 } },
          } as never,
        ],
        maxOutputTokensOverride: undefined,
        escalatedMaxTokens: 64_000,
        env: {},
      }),
    ).toBe('none')
  })
})

describe('end to end through query()', () => {
  test('reasoning took the budget: raised once to 64k, then a clear error — never continued', async () => {
    const { sent, fetchOverride } = lane([
      exhaustedSSE(4096),
      exhaustedSSE(64_000),
    ])
    const { emitted, stray, overrides } = await runQueryOverOpenAILane({
      model: 'reasoner-x',
      history: HISTORY,
      fetchOverride,
    })
    expect(stray).toEqual([])
    expect(overrides).toEqual([undefined, 64_000])
    expect(sent).toHaveLength(2)
    expect(sent[1]!.maxTokens).toBe(64_000)
    expect(
      sent.some(request => request.lastUser.startsWith(CONTINUATION)),
    ).toBe(false)
    const texts = emittedTexts(emitted)
    expect(texts.at(-1)).toContain('used its whole output budget on reasoning')
  })

  test('the user set the limit: no raise, the error at once', async () => {
    process.env.OPENAI_MAX_TOKENS = '4096'
    try {
      const { sent, fetchOverride } = lane([exhaustedSSE(4096)])
      const { emitted } = await runQueryOverOpenAILane({
        model: 'reasoner-y',
        history: HISTORY,
        fetchOverride,
      })
      expect(sent).toHaveLength(1)
      expect(emittedTexts(emitted).at(-1)).toContain(
        'used its whole output budget on reasoning',
      )
    } finally {
      delete process.env.OPENAI_MAX_TOKENS
    }
  })

  test('control: a visible answer cut by the limit is still continued', async () => {
    const { sent, fetchOverride } = lane([TRUNCATED_ANSWER_SSE, DONE_SSE])
    await runQueryOverOpenAILane({
      model: 'writer-z',
      history: HISTORY,
      fetchOverride,
    })
    expect(sent).toHaveLength(2)
    expect(sent[1]!.lastUser.startsWith(CONTINUATION)).toBe(true)
  })
})
