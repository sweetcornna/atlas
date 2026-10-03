// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.5 hermes #12 (part b): the shared drop-and-resend mechanism. The
 * wording rule follows hermes `agent/auxiliary_client.py:4275-4306` at
 * `f9b29c49b6`; error strings are CONSTRUCTED, not recorded.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { _resetPromptCacheKeySupportForTesting } from 'src/services/api/openai/openaiShared.js'
import {
  isUnsupportedParameterError,
  isUnsupportedParameterText,
  sendDroppingRejectedParameters,
} from '../unsupportedParam.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import { captureOpenAIRequests } from './support/requestCapture.js'

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => settingsMock.reset())
afterEach(() => _resetPromptCacheKeySupportForTesting())

describe('isUnsupportedParameterText (hermes markers)', () => {
  test.each([
    [
      "Unsupported parameter: 'temperature' is not supported with this model.",
      true,
    ],
    ['unsupported_parameter: temperature', true],
    [
      "Unsupported value: 'temperature' does not support 0 with this model.",
      true,
    ],
    ['Unknown parameter: temperature', true],
    ['Unrecognized request argument supplied: temperature', true],
    ['Invalid parameter: temperature must be between 0 and 2', true],
    ['temperature is fine; the model is overloaded', false],
    ["Unsupported parameter: 'top_p'", false],
  ])('%s → %s', (text, expected) => {
    expect(isUnsupportedParameterText(text, 'temperature')).toBe(expected)
  })

  test('a caller-supplied marker list replaces the default', () => {
    expect(
      isUnsupportedParameterText(
        'summary: organization must be verified',
        'summary',
        ['must be verified'],
      ),
    ).toBe(true)
    expect(
      isUnsupportedParameterText(
        'summary: organization must be verified',
        'summary',
      ),
    ).toBe(false)
  })

  test('reads the SDK envelope too', () => {
    expect(
      isUnsupportedParameterError(
        {
          message: '400 status code',
          error: { message: 'Unknown parameter: temperature' },
        },
        'temperature',
      ),
    ).toBe(true)
  })
})

describe('sendDroppingRejectedParameters', () => {
  const rejection = (key: string) => new Error(`Unknown parameter: ${key}`)
  const droppable = (key: string, log: string[]) => ({
    key,
    isRejection: (error: unknown) =>
      error instanceof Error && error.message.includes(key),
    onDropped: () => log.push(key),
  })

  test('drops a refused key once and re-sends', async () => {
    const sent: Record<string, unknown>[] = []
    const log: string[] = []
    const result = await sendDroppingRejectedParameters({
      body: { a: 1, b: 2 },
      send: async body => {
        sent.push(body)
        if ('b' in body) throw rejection('b')
        return 'ok'
      },
      signal: new AbortController().signal,
      droppable: [droppable('b', log)],
    })
    expect(result).toBe('ok')
    expect(sent).toEqual([{ a: 1, b: 2 }, { a: 1 }])
    expect(log).toEqual(['b'])
  })

  test('two keys, one at a time, each once', async () => {
    const sent: Record<string, unknown>[] = []
    await sendDroppingRejectedParameters({
      body: { a: 1, b: 2, c: 3 },
      send: async body => {
        sent.push(body)
        if ('b' in body) throw rejection('b')
        if ('c' in body) throw rejection('c')
        return 'ok'
      },
      signal: new AbortController().signal,
      droppable: [droppable('b', []), droppable('c', [])],
    })
    expect(sent).toEqual([{ a: 1, b: 2, c: 3 }, { a: 1, c: 3 }, { a: 1 }])
  })

  test('a key the body does not carry is never "dropped"', async () => {
    let calls = 0
    await expect(
      sendDroppingRejectedParameters({
        body: { a: 1 },
        send: async () => {
          calls++
          throw rejection('b')
        },
        signal: new AbortController().signal,
        droppable: [droppable('b', [])],
      }),
    ).rejects.toThrow('Unknown parameter: b')
    expect(calls).toBe(1)
  })

  test('an aborted request surfaces at once', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    await expect(
      sendDroppingRejectedParameters({
        body: { a: 1, b: 2 },
        send: async () => {
          calls++
          throw rejection('b')
        },
        signal: controller.signal,
        droppable: [droppable('b', [])],
      }),
    ).rejects.toThrow()
    expect(calls).toBe(1)
  })
})

describe('chat lane: prompt_cache_key fallback behaves as before', () => {
  test('refused key → one re-send without it', async () => {
    const requests = await captureOpenAIRequests({
      model: 'glm-5.2',
      baseURL: 'https://gateway.example/v1',
      env: { OPENAI_WIRE_API: 'chat' },
      failFirst: [
        {
          status: 400,
          body: {
            error: {
              message:
                'Unrecognized request argument supplied: prompt_cache_key',
            },
          },
        },
      ],
    })
    expect(requests).toHaveLength(2)
    expect('prompt_cache_key' in requests[0]!.body).toBe(true)
    expect('prompt_cache_key' in requests[1]!.body).toBe(false)
  })
})
