// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * hermes #1 — model fallback on the third-party lanes (P18.12).
 *
 * Errors are constructed in the shapes the lanes see (SDK APIError bodies,
 * OpenCode's ModelError, Gemini's NOT_FOUND); the end-to-end case runs the
 * real `query()` loop over the real `queryModelOpenAI` with a local stub for
 * the endpoint. No vendor was called.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { resetStateForTests } from 'src/bootstrap/state.js'
import { queryModelOpenAI } from 'src/services/api/openai/index.js'
import { OpenAIRequestError } from 'src/services/api/openai/retry.js'
import { retryThirdPartyEventStream } from 'src/services/api/streamAssembly.js'
import { FallbackTriggeredError } from 'src/services/api/withRetry.js'
import { getEmptyToolPermissionContext } from 'src/Tool.js'
import type { Message } from 'src/types/message.js'
import { createUserMessage } from 'src/utils/messages.js'
import { asSystemPrompt } from 'src/utils/session/systemPromptType.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import { thirdPartyFallback } from '../thirdPartyFallback.js'
import { captureGrokRequests } from './support/grokCapture.js'
import { emittedTexts, runQueryOverOpenAILane } from './support/queryHarness.js'
import { captureOpenAIRequests } from './support/requestCapture.js'

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => settingsMock.reset())

const TARGET = { model: 'primary-model', fallbackModel: 'fallback-model' }

function httpError(status: number, body: Record<string, unknown>) {
  return new OpenAIRequestError(`request failed (${status})`, {
    retryable: status >= 500,
    status,
    cause: body,
  })
}

describe('thirdPartyFallback — reasons', () => {
  test.each([
    [500, 'server_error'],
    [502, 'server_error'],
    [503, 'overloaded'],
    [529, 'overloaded'],
  ] as const)('exhausted %d → %s', (status, reason) => {
    const fallback = thirdPartyFallback(
      httpError(status, { message: 'upstream' }),
      TARGET,
      'exhausted',
    )
    expect(fallback).toBeInstanceOf(FallbackTriggeredError)
    expect(fallback?.reason).toBe(reason)
    expect(fallback?.fallbackModel).toBe('fallback-model')
    expect(fallback?.originalModel).toBe('primary-model')
  })

  test.each([
    [
      'OpenAI model_not_found',
      404,
      {
        code: 'model_not_found',
        message:
          'The model `primary-model` does not exist or you do not have access to it.',
      },
      'model_not_found',
    ],
    [
      'OpenCode ModelError (401)',
      401,
      { type: 'ModelError', message: 'Model primary-model is not supported' },
      'model_not_found',
    ],
    [
      'Gemini NOT_FOUND',
      404,
      {
        code: 404,
        status: 'NOT_FOUND',
        message: 'models/primary-model is not found for API version v1beta',
      },
      'model_not_found',
    ],
    [
      'a 400 naming an invalid model',
      400,
      { message: 'invalid model ID' },
      'model_not_found',
    ],
    [
      'OpenCode model disabled (403)',
      403,
      {
        code: 'managed_inference_model_disabled',
        message: 'Model is disabled for this organization',
      },
      'permission_denied',
    ],
    [
      '403 naming the model',
      403,
      { message: 'You do not have access to model primary-model' },
      'permission_denied',
    ],
  ] as const)('refused: %s → %s', (_label, status, body, reason) => {
    expect(
      thirdPartyFallback(httpError(status, body), TARGET, 'refused')?.reason,
    ).toBe(reason)
  })

  test.each([
    ['bad key (401)', 401, { message: 'Incorrect API key provided' }],
    ['no balance (402)', 402, { message: 'Insufficient balance' }],
    ['rate limit (429)', 429, { message: 'Rate limit reached' }],
    ['bad request (400)', 400, { message: 'messages: field required' }],
    [
      'OpenRouter data policy (404)',
      404,
      {
        message:
          'No endpoints found matching your data policy for model primary-model',
      },
    ],
    ['gateway 404 without a model', 404, { message: 'Not Found' }],
  ] as const)('refused: %s → no fallback', (_label, status, body) => {
    expect(
      thirdPartyFallback(httpError(status, body), TARGET, 'refused'),
    ).toBeUndefined()
  })

  test('exhausted: a non-5xx (timeout, dropped stream) → no fallback', () => {
    expect(
      thirdPartyFallback(new Error('Stream ended'), TARGET, 'exhausted'),
    ).toBeUndefined()
  })

  test('no fallback armed, or the fallback is the same model → none', () => {
    const error = httpError(500, {})
    expect(
      thirdPartyFallback(
        error,
        { model: 'm', fallbackModel: undefined },
        'exhausted',
      ),
    ).toBeUndefined()
    expect(
      thirdPartyFallback(
        error,
        { model: 'm', fallbackModel: 'm' },
        'exhausted',
      ),
    ).toBeUndefined()
    expect(thirdPartyFallback(error, undefined, 'exhausted')).toBeUndefined()
  })
})

describe('retryThirdPartyEventStream — gives up into the fallback', () => {
  async function drain(
    create: () => Promise<AsyncIterable<BetaRawMessageStreamEvent>>,
    fallback = TARGET,
  ): Promise<unknown> {
    try {
      for await (const _ of retryThirdPartyEventStream({
        create,
        signal: new AbortController().signal,
        maxRetries: 2,
        delay: async () => {},
        fallback,
      })) {
      }
      return undefined
    } catch (error) {
      return error
    }
  }

  test('5xx: after the retries, not before', async () => {
    let attempts = 0
    const error = await drain(async () => {
      attempts++
      throw httpError(500, { message: 'internal' })
    })
    expect(error).toBeInstanceOf(FallbackTriggeredError)
    expect(attempts).toBe(3)
  })

  test('model not found: at once', async () => {
    let attempts = 0
    const error = await drain(async () => {
      attempts++
      throw httpError(404, { code: 'model_not_found', message: 'no model' })
    })
    expect(error).toBeInstanceOf(FallbackTriggeredError)
    expect(attempts).toBe(1)
  })

  test('after visible output: the interruption error, not a fallback', async () => {
    const error = await drain(async () =>
      (async function* () {
        yield {
          type: 'message_start',
          message: { id: 'm', content: [], usage: {} },
        } as unknown as BetaRawMessageStreamEvent
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        } as BetaRawMessageStreamEvent
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'partial' },
        } as BetaRawMessageStreamEvent
        throw httpError(500, { message: 'internal' })
      })(),
    )
    expect(error).not.toBeInstanceOf(FallbackTriggeredError)
    expect(String(error)).toContain('Connection lost mid-response')
  })

  test('a bad key keeps its own error', async () => {
    const original = httpError(401, { message: 'Incorrect API key provided' })
    expect(
      await drain(async () => {
        throw original
      }),
    ).toBe(original)
  })
})

describe('the lanes let it through', () => {
  test('OpenAI lane: thrown, not turned into an error message', async () => {
    const outputs: unknown[] = []
    const run = captureOpenAIRequests({
      model: 'primary-model',
      baseURL: 'https://gateway.example/v1',
      env: { OPENAI_WIRE_API: 'chat' },
      fallbackModel: 'fallback-model',
      failFirst: [
        {
          status: 404,
          body: {
            error: {
              code: 'model_not_found',
              message: 'The model `primary-model` does not exist',
            },
          },
        },
      ],
      outputs,
    })
    await expect(run).rejects.toBeInstanceOf(FallbackTriggeredError)
    expect(
      outputs.some(o => (o as { type?: string }).type === 'assistant'),
    ).toBe(false)
  })

  test('Grok lane: same', async () => {
    const run = captureGrokRequests({
      model: 'grok-primary',
      fallbackModel: 'grok-fallback',
      failFirst: [
        {
          status: 404,
          body: { error: { code: 'model_not_found', message: 'no model' } },
        },
      ],
    })
    await expect(run).rejects.toBeInstanceOf(FallbackTriggeredError)
  })

  test('no fallback armed: the error message as before', async () => {
    const outputs: unknown[] = []
    await captureOpenAIRequests({
      model: 'primary-model',
      baseURL: 'https://gateway.example/v1',
      env: { OPENAI_WIRE_API: 'chat' },
      failFirst: [
        {
          status: 404,
          body: { error: { code: 'model_not_found', message: 'no model' } },
        },
      ],
      outputs,
    })
    expect(
      outputs.some(
        o =>
          (o as { type?: string; isApiErrorMessage?: boolean }).type ===
            'assistant' &&
          (o as { isApiErrorMessage?: boolean }).isApiErrorMessage === true,
      ),
    ).toBe(true)
  })
})

describe('end to end through query(): 5xx retries spent → fallback model', () => {
  const ENV = {
    CLAUDE_CODE_USE_OPENAI: '1',
    OPENAI_API_KEY: 'sk-test-canary-p1812-fallback',
    // A relay: the deepseek family keeps reasoning_content here by name,
    // a model from no echo family gets it stripped (reasoningEcho.ts).
    OPENAI_BASE_URL: 'https://api.relay.example/v1',
    OPENAI_WIRE_API: 'chat',
    CLAUDE_CODE_MAX_RETRIES: '1',
    CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
    // The relevant-memory prefetch is a side query of its own.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  }
  const saved = new Map<string, string | undefined>()
  beforeAll(() => {
    for (const [key, value] of Object.entries(ENV)) {
      saved.set(key, process.env[key])
      process.env[key] = value
    }
  })
  afterAll(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetStateForTests()
  })

  const OK_SSE =
    'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"from the fallback"},"finish_reason":null}]}\n\n' +
    'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    'data: [DONE]\n\n'

  test('switches after the retries, and the fallback request is filtered for its own target', async () => {
    const sent: { model: string; assistant: Record<string, unknown> }[] = []
    const fetchOverride = (async (
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        model: string
        messages: Record<string, unknown>[]
      }
      sent.push({
        model: body.model,
        assistant: body.messages.find(m => m.role === 'assistant') ?? {},
      })
      if (body.model === 'deepseek-v4-pro') {
        return new Response(
          JSON.stringify({ error: { message: 'internal error' } }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(OK_SSE, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch

    const history = [
      createUserMessage({ content: 'q' }),
      {
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          model: 'deepseek-v4-pro',
          content: [
            { type: 'thinking', thinking: 'deepseek reasoned', signature: '' },
            { type: 'text', text: 'first answer' },
          ],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      createUserMessage({ content: 'follow up' }),
    ] as unknown as Message[]

    const { emitted, stray, mainLoopModel } = await runQueryOverOpenAILane({
      model: 'deepseek-v4-pro',
      history,
      fetchOverride,
      fallbackModels: ['vendor-model-x'],
    })
    expect(stray).toEqual([])
    // Two tries on the primary (one retry), then the fallback.
    expect(sent.map(request => request.model)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-pro',
      'vendor-model-x',
    ])
    // The relay keeps deepseek's reasoning for deepseek …
    expect(sent[0]!.assistant.reasoning_content).toBe('deepseek reasoned')
    // … and the fallback request was filtered for the fallback target.
    expect('reasoning_content' in sent[2]!.assistant).toBe(false)

    expect(mainLoopModel).toBe('vendor-model-x')
    const texts = emittedTexts(emitted)
    expect(texts.some(text => text.startsWith('Switched to'))).toBe(true)
    expect(texts).toContain('from the fallback')
  }, 20_000)
})

describe('the Gemini lane lets it through too', () => {
  test('404 NOT_FOUND naming the model → FallbackTriggeredError', async () => {
    const { queryModelGemini } = await import(
      'src/services/api/gemini/index.js'
    )
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_USE_GEMINI: '1',
      CLAUDE_CODE_USE_OPENAI: undefined,
      GEMINI_API_KEY: 'sk-test-canary-p1812-gemini',
      GEMINI_BASE_URL: 'https://gemini.example/v1beta',
    }
    const saved = new Map<string, string | undefined>()
    for (const [key, value] of Object.entries(env)) {
      saved.set(key, process.env[key])
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    const urls: string[] = []
    const fetchOverride = (async (input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input))
      return new Response(
        JSON.stringify({
          error: {
            code: 404,
            status: 'NOT_FOUND',
            message:
              'models/gemini-primary is not found for API version v1beta',
          },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    try {
      const run = (async () => {
        for await (const _ of queryModelGemini(
          [],
          asSystemPrompt([]),
          [],
          new AbortController().signal,
          {
            model: 'gemini-primary',
            fallbackModel: 'gemini-fallback',
            querySource: 'main_loop',
            agents: [],
            allowedAgentTypes: [],
            fetchOverride,
            getToolPermissionContext: async () =>
              getEmptyToolPermissionContext(),
          } as never,
          { type: 'disabled' } as never,
        )) {
        }
      })()
      await expect(run).rejects.toBeInstanceOf(FallbackTriggeredError)
      expect(urls).toHaveLength(1)
      expect(urls[0]).toStartWith('https://gemini.example/')
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
