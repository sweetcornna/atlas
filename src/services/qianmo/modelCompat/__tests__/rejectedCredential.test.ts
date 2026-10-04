// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A key OpenAI refused is `authentication_failed`, not `invalid_request`
 * (P18.12, follow-up from the P18.7 audit; `errorText.ts`
 * `isRejectedCredential`).
 *
 * The body is constructed in the shape OpenAI documents for a bad key
 * (`401`, `type: invalid_request_error`, `code: invalid_api_key`); it was not
 * received from a real endpoint here. P18.7's audit observed the same shape
 * from a real key and had to work around it in call mode only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import OpenAI from 'openai'
import {
  createOpenAIResponseError,
  OpenAIRequestError,
} from 'src/services/api/openai/retry.js'
import {
  classifyRetryableAPIError,
  describeAPIError,
} from 'src/services/api/retryClassification.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import { captureOpenAIRequests } from './support/requestCapture.js'

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => settingsMock.reset())

const BAD_KEY_BODY = {
  error: {
    message:
      'Incorrect API key provided: sk-test-****-key. You can find your API key at https://platform.openai.com/account/api-keys.',
    type: 'invalid_request_error',
    param: null,
    code: 'invalid_api_key',
  },
}

describe('401 invalid_request_error is a refused key', () => {
  test('OpenAI SDK AuthenticationError (chat lane)', () => {
    const error = OpenAI.APIError.generate(
      401,
      BAD_KEY_BODY,
      undefined,
      new Headers({ 'content-type': 'application/json' }),
    )
    expect(error).toBeInstanceOf(OpenAI.AuthenticationError)
    expect(classifyRetryableAPIError(error)).toEqual({
      category: 'authentication_failed',
      persistence: 'permanent',
      retryable: false,
    })
  })

  test('OpenAIRequestError built from the HTTP response (Responses lane)', async () => {
    const error = await createOpenAIResponseError(
      new Response(JSON.stringify(BAD_KEY_BODY), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
      'OpenAI Responses API',
    )
    expect(error).toBeInstanceOf(OpenAIRequestError)
    expect(error.retryable).toBe(false)
    expect(describeAPIError(error).category).toBe('authentication_failed')
  })

  test('a 401 naming a model keeps its model verdict', () => {
    expect(
      classifyRetryableAPIError({
        status: 401,
        error: {
          type: 'ModelError',
          message: 'Model kimi-x is not supported',
        },
      }).category,
    ).toBe('invalid_request')
    expect(
      classifyRetryableAPIError({
        status: 401,
        error: {
          type: 'invalid_request_error',
          code: 'model_not_found',
          message: 'The model does not exist',
        },
      }).category,
    ).toBe('invalid_request')
  })

  test('the generic body type under any other status is unchanged', () => {
    expect(
      classifyRetryableAPIError({
        status: 400,
        error: { type: 'invalid_request_error', message: 'bad' },
      }).category,
    ).toBe('invalid_request')
  })
})

describe('what the lane yields for a refused key', () => {
  for (const wire of ['chat', 'responses'] as const) {
    test(`${wire}: one request, an authentication_failed message`, async () => {
      const outputs: unknown[] = []
      const requests = await captureOpenAIRequests({
        model: 'gpt-6-luna',
        baseURL: 'https://api.openai.com/v1',
        env: { OPENAI_WIRE_API: wire },
        failFirst: [{ status: 401, body: BAD_KEY_BODY }],
        outputs,
      })
      expect(requests).toHaveLength(1)
      const failure = outputs.find(
        o => (o as { type?: string }).type === 'assistant',
      ) as { error?: string; isApiErrorMessage?: boolean } | undefined
      expect(failure).toMatchObject({
        isApiErrorMessage: true,
        error: 'authentication_failed',
      })
    })
  }
})
