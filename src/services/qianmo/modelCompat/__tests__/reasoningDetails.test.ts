// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `reasoning_details` is captured on the chat lane and sent back verbatim to
 * the OpenRouter / MiniMax model that produced it, and to nothing else
 * (P18.12, follow-up from the P18.8 audit).
 *
 * The SSE chunks are constructed in OpenRouter's documented streaming shape
 * (https://openrouter.ai/docs/use-cases/reasoning-tokens, fetched
 * 2026-10-03T18:57Z): each chunk's `delta.reasoning_details` holds the next
 * part of the sequence, the last one a signature. Not recorded; no vendor
 * was called.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Message } from 'src/types/message.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import { tapReasoningDetails } from '../reasoningDetailsReplay.js'
import { captureOpenAIRequests } from './support/requestCapture.js'

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => settingsMock.reset())

const MODEL = 'qwen/qwen3.8-max'
const OPENROUTER = 'https://openrouter.ai/api/v1'

const DETAILS = [
  {
    type: 'reasoning.text',
    text: 'Let me',
    format: 'anthropic-claude-v1',
    index: 0,
  },
  {
    type: 'reasoning.text',
    text: ' think',
    format: 'anthropic-claude-v1',
    index: 0,
  },
  {
    type: 'reasoning.text',
    signature: 'sig-opaque-abc',
    format: 'anthropic-claude-v1',
    index: 0,
  },
]

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({
    id: 'gen-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

const SSE =
  chunk({
    role: 'assistant',
    content: '',
    reasoning: 'Let me',
    reasoning_details: [DETAILS[0]],
  }) +
  chunk({ reasoning: ' think', reasoning_details: [DETAILS[1]] }) +
  chunk({ reasoning_details: [DETAILS[2]] }) +
  chunk({ content: 'ok' }) +
  chunk({}, 'stop') +
  'data: [DONE]\n\n'

async function firstTurn(baseURL: string): Promise<Record<string, unknown>> {
  const outputs: unknown[] = []
  await captureOpenAIRequests({
    model: MODEL,
    baseURL,
    env: { OPENAI_WIRE_API: 'chat' },
    chatSSE: SSE,
    outputs,
  })
  const reply = outputs.find(
    o => (o as { type?: string }).type === 'assistant',
  ) as { message: Record<string, unknown> } | undefined
  if (!reply) throw new Error('no assistant message')
  return reply as unknown as Record<string, unknown>
}

async function replayedTurn(
  history: Record<string, unknown>,
  target: { model: string; baseURL: string },
): Promise<Record<string, unknown>> {
  const messages = [
    { type: 'user', uuid: 'u-1', message: { role: 'user', content: 'q' } },
    history,
    {
      type: 'user',
      uuid: 'u-2',
      message: { role: 'user', content: 'go on' },
    },
  ] as unknown as Message[]
  const [request] = await captureOpenAIRequests({
    model: target.model,
    baseURL: target.baseURL,
    env: { OPENAI_WIRE_API: 'chat' },
    messages,
  })
  const sent = (request!.body.messages as Record<string, unknown>[]).find(
    m => m.role === 'assistant',
  )
  if (!sent) throw new Error('no assistant turn on the wire')
  return sent
}

describe('capture', () => {
  test('OpenRouter: the chunks are concatenated in order and stamped', async () => {
    const reply = await firstTurn(OPENROUTER)
    expect(
      (reply.message as Record<string, unknown>)._openaiReasoningDetails,
    ).toEqual({ vendor: 'openrouter', model: MODEL, details: DETAILS })
  })

  test('any other endpoint: nothing is kept', async () => {
    const reply = await firstTurn('https://gateway.example/v1')
    expect('_openaiReasoningDetails' in (reply.message as object)).toBe(false)
  })

  test('one attempt per tap: a retry starts from empty', async () => {
    const sink: unknown[] = []
    async function* attempt(entry: unknown) {
      yield {
        choices: [{ index: 0, delta: { reasoning_details: [entry] } }],
      } as never
    }
    for await (const _ of tapReasoningDetails(attempt('first'), sink)) {
    }
    for await (const _ of tapReasoningDetails(attempt('second'), sink)) {
    }
    expect(sink).toEqual(['second'])
  })
})

describe('replay at the send boundary', () => {
  test('same OpenRouter model: reasoning_details verbatim, no reasoning_content', async () => {
    const history = await firstTurn(OPENROUTER)
    const sent = await replayedTurn(history, {
      model: MODEL,
      baseURL: OPENROUTER,
    })
    expect(sent.reasoning_details).toEqual(DETAILS)
    expect('reasoning_content' in sent).toBe(false)
  })

  test('another model on OpenRouter: not sent', async () => {
    const history = await firstTurn(OPENROUTER)
    const sent = await replayedTurn(history, {
      model: 'openai/gpt-oss-120b',
      baseURL: OPENROUTER,
    })
    expect('reasoning_details' in sent).toBe(false)
  })

  test.each([
    ['a strict vendor', 'https://api.mistral.ai/v1'],
    ['a relay', 'https://api.cornna.xyz/v1'],
    ['MiniMax (another replay vendor)', 'https://api.minimax.io/v1'],
  ])('same model on %s: not sent', async (_label, baseURL) => {
    const history = await firstTurn(OPENROUTER)
    const sent = await replayedTurn(history, { model: MODEL, baseURL })
    expect('reasoning_details' in sent).toBe(false)
  })

  test('MiniMax: captured and replayed on its own hosts', async () => {
    const history = await firstTurn('https://api.minimax.io/v1')
    const sent = await replayedTurn(history, {
      model: MODEL,
      baseURL: 'https://api.minimaxi.com/v1',
    })
    expect(sent.reasoning_details).toEqual(DETAILS)
  })
})
