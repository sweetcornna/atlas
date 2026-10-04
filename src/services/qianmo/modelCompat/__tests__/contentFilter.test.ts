// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * hermes #27 — a response the provider's content filter cut short says so
 * (P18.12). The partial answer stays; an error message after it names the
 * filter.
 *
 * Before (base of this package): the chat lane mapped `content_filter` to
 * `end_turn` and the Responses lane carried `content_filter` as a bare stop
 * reason; both yielded the partial answer alone, exactly as if it had ended.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import { contentFilterNotice } from '../contentFilter.js'
import { captureGrokRequests } from './support/grokCapture.js'
import { captureOpenAIRequests } from './support/requestCapture.js'

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => settingsMock.reset())

type Output = {
  type?: string
  isApiErrorMessage?: boolean
  message?: {
    stop_reason?: string | null
    content?: { type: string; text?: string }[]
  }
}

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-p1812-27',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

const FILTERED_CHAT_SSE =
  chunk({ role: 'assistant', content: 'The first half' }, null) +
  chunk({}, 'content_filter') +
  'data: [DONE]\n\n'

const FINISHED_CHAT_SSE =
  chunk({ role: 'assistant', content: 'The whole answer' }, null) +
  chunk({}, 'stop') +
  'data: [DONE]\n\n'

const EMPTY_FILTERED_CHAT_SSE =
  chunk({ role: 'assistant' }, null) +
  chunk({}, 'content_filter') +
  'data: [DONE]\n\n'

const FILTERED_RESPONSES_SSE =
  'data: {"type":"response.output_text.delta","delta":"The first half"}\n\n' +
  'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"content_filter"}}}\n\n'

function replies(outputs: unknown[]): Output[] {
  return (outputs as Output[]).filter(
    o => o.type === 'assistant' && o.isApiErrorMessage !== true,
  )
}

function notices(outputs: unknown[]): string[] {
  return (outputs as Output[])
    .filter(o => o.isApiErrorMessage === true)
    .map(o => (o.message?.content ?? []).map(b => b.text ?? '').join(''))
}

const NOTICE = "The provider's content filter stopped this response"

describe('OpenAI chat lane', () => {
  test('partial answer, then the notice', async () => {
    const outputs: unknown[] = []
    await captureOpenAIRequests({
      model: 'deepseek-chat',
      baseURL: 'https://gateway.example/v1',
      env: { OPENAI_WIRE_API: 'chat' },
      chatSSE: FILTERED_CHAT_SSE,
      outputs,
    })
    const [reply] = replies(outputs)
    expect(reply?.message?.content?.[0]?.text).toBe('The first half')
    // The stop reason the adapter gives is left alone.
    expect(reply?.message?.stop_reason).toBe('end_turn')
    expect(notices(outputs)).toHaveLength(1)
    expect(notices(outputs)[0]).toContain(NOTICE)
  })

  test('a finished answer gets no notice', async () => {
    const outputs: unknown[] = []
    await captureOpenAIRequests({
      model: 'deepseek-chat',
      baseURL: 'https://gateway.example/v1',
      env: { OPENAI_WIRE_API: 'chat' },
      chatSSE: FINISHED_CHAT_SSE,
      outputs,
    })
    expect(replies(outputs)).toHaveLength(1)
    expect(notices(outputs)).toEqual([])
  })
})

describe('OpenAI Responses lane', () => {
  test('partial answer, then the notice', async () => {
    const outputs: unknown[] = []
    await captureOpenAIRequests({
      model: 'gpt-6-luna',
      baseURL: 'https://gateway.example/v1',
      env: { OPENAI_WIRE_API: 'responses' },
      responsesSSE: FILTERED_RESPONSES_SSE,
      outputs,
    })
    const [reply] = replies(outputs)
    expect(reply?.message?.content?.[0]?.text).toBe('The first half')
    expect(reply?.message?.stop_reason).toBe('content_filter')
    expect(notices(outputs)).toHaveLength(1)
    expect(notices(outputs)[0]).toContain(NOTICE)
  })
})

describe('Grok lane', () => {
  test('partial answer, then the notice', async () => {
    const outputs: unknown[] = []
    await captureGrokRequests({
      model: 'grok-4',
      chatSSE: FILTERED_CHAT_SSE,
      outputs,
    })
    expect(replies(outputs)[0]?.message?.content?.[0]?.text).toBe(
      'The first half',
    )
    expect(notices(outputs)).toHaveLength(1)
    expect(notices(outputs)[0]).toContain(NOTICE)
  })

  test('an empty filtered attempt is re-sent, and nothing is marked', async () => {
    // An empty filtered attempt is an empty response: the adapter throws, the
    // ladder closes the attempt itself and re-sends. Neither that synthetic
    // close nor the re-sent answer, which finishes normally, is the filter's.
    const outputs: unknown[] = []
    const requests = await captureGrokRequests({
      model: 'grok-4',
      chatSSE: [EMPTY_FILTERED_CHAT_SSE, FINISHED_CHAT_SSE],
      outputs,
    })
    expect(requests).toHaveLength(2)
    expect(replies(outputs)[0]?.message?.content?.[0]?.text).toBe(
      'The whole answer',
    )
    expect(notices(outputs)).toEqual([])
  })
})

describe('contentFilterNotice', () => {
  test.each([
    ['end_turn', undefined, false],
    ['end_turn', { seen: false }, false],
    ['end_turn', { seen: true }, true],
    ['content_filter', undefined, true],
    // A refusal the Responses lane saw is shown as the refusal itself.
    ['refusal', undefined, false],
    [null, undefined, false],
  ] as const)('stop %p, sink %p → %p', (stopReason, sink, expected) => {
    const notice = contentFilterNotice(
      stopReason,
      sink === undefined ? undefined : { ...sink },
    )
    expect(notice !== undefined).toBe(expected)
    if (notice) expect(notice.errorDetails).toBe('finish_reason=content_filter')
  })
})
