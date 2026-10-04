// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * hermes #19 — an error sent inside the stream (DeepInfra shape) ends the
 * attempt as a non-retryable error carrying the vendor's words (P18.12).
 *
 * Before (measured on the base of this package with this fixture): the chunk
 * had no `choices`, so the adapter skipped it as an empty delta, the stream
 * ended without a finish_reason, and the ladder re-sent the same bad request
 * — 1 + CLAUDE_CODE_MAX_RETRIES requests — before reporting a generic
 * failure that never mentioned the vendor's message.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import {
  DEEPINFRA_ERROR_SSE,
  DEEPINFRA_ERROR_SSE_EMPTY_CHOICES,
  USAGE_ONLY_SSE,
} from './fixtures/deepinfraErrorChunk.js'
import { captureGrokRequests } from './support/grokCapture.js'
import { captureOpenAIRequests } from './support/requestCapture.js'

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => settingsMock.reset())

type Output = {
  type?: string
  error?: string
  isApiErrorMessage?: boolean
  message?: { content?: { type: string; text?: string }[] }
}

function errorMessages(outputs: unknown[]): Output[] {
  return (outputs as Output[]).filter(o => o.isApiErrorMessage === true)
}

function text(output: Output | undefined): string {
  return (output?.message?.content ?? []).map(b => b.text ?? '').join('')
}

describe('OpenAI chat lane', () => {
  test.each([
    ['choices missing', DEEPINFRA_ERROR_SSE],
    ['choices empty', DEEPINFRA_ERROR_SSE_EMPTY_CHOICES],
  ])('%s: one request, the vendor message, not retried', async (_l, sse) => {
    const outputs: unknown[] = []
    const requests = await captureOpenAIRequests({
      model: 'meta-llama/Llama-4-Scout',
      baseURL: 'https://api.deepinfra.com/v1/openai',
      env: { OPENAI_WIRE_API: 'chat', CLAUDE_CODE_MAX_RETRIES: '2' },
      chatSSE: sse,
      outputs,
    })
    expect(requests).toHaveLength(1)
    const [error] = errorMessages(outputs)
    expect(text(error)).toContain(
      'Requested token count exceeds the model maximum context length',
    )
    expect(error?.error).toBe('invalid_request')
  })

  test('a usage-only final chunk with empty choices is not an error', async () => {
    const outputs: unknown[] = []
    await captureOpenAIRequests({
      model: 'meta-llama/Llama-4-Scout',
      baseURL: 'https://api.deepinfra.com/v1/openai',
      env: { OPENAI_WIRE_API: 'chat' },
      chatSSE: USAGE_ONLY_SSE,
      outputs,
    })
    expect(errorMessages(outputs)).toEqual([])
  })
})

describe('Grok lane', () => {
  test('same rule', async () => {
    const outputs: unknown[] = []
    const requests = await captureGrokRequests({
      model: 'grok-4',
      env: { CLAUDE_CODE_MAX_RETRIES: '2' },
      chatSSE: DEEPINFRA_ERROR_SSE,
      outputs,
    })
    expect(requests).toHaveLength(1)
    expect(text(errorMessages(outputs)[0])).toContain(
      'Requested token count exceeds',
    )
  })
})
