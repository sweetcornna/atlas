// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * hermes #18 — the chat lane's idle watchdog (P18.12).
 *
 * The stub answers with response headers and a first chunk, then never sends
 * another byte — the stall the SDK's request timeout does not cover once
 * headers have arrived. `CLAUDE_STREAM_IDLE_TIMEOUT_MS` is shortened so the
 * case runs in well under a second.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import {
  CHAT_STREAM_IDLE_DEFAULT_MS,
  chatStreamIdleTimeoutMs,
} from '../chatStreamGuards.js'
import { captureGrokRequests } from './support/grokCapture.js'
import { captureOpenAIRequests } from './support/requestCapture.js'

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => settingsMock.reset())

const FIRST_CHUNK =
  'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n'
const COMPLETE =
  FIRST_CHUNK +
  'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"recovered"},"finish_reason":null}]}\n\n' +
  'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n'

/**
 * A fetch whose first answer stalls after one chunk and whose later answers
 * complete. Records whether the stalled request was aborted.
 */
function stallingFetch() {
  const state = { requests: 0, stalledRequestAborted: false }
  const fetchOverride = (async (
    _input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    state.requests++
    if (state.requests > 1) {
      return new Response(COMPLETE, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    init?.signal?.addEventListener('abort', () => {
      state.stalledRequestAborted = true
    })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(FIRST_CHUNK))
        // …and nothing else, ever.
      },
    })
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch
  return { state, fetchOverride }
}

function textOf(outputs: unknown[]): string {
  return outputs
    .flatMap(output => {
      const o = output as {
        type?: string
        message?: { content?: { type: string; text?: string }[] }
      }
      return o.type === 'assistant'
        ? (o.message?.content ?? []).map(block => block.text ?? '')
        : []
    })
    .join('|')
}

describe('the bound', () => {
  test('CLAUDE_STREAM_IDLE_TIMEOUT_MS when set, else 180 s', () => {
    expect(chatStreamIdleTimeoutMs({})).toBe(CHAT_STREAM_IDLE_DEFAULT_MS)
    expect(CHAT_STREAM_IDLE_DEFAULT_MS).toBe(180_000)
    expect(
      chatStreamIdleTimeoutMs({ CLAUDE_STREAM_IDLE_TIMEOUT_MS: '5000' }),
    ).toBe(5000)
  })
})

describe('OpenAI chat lane', () => {
  test('a stalled stream times out, is aborted, and the ladder re-sends', async () => {
    const { state, fetchOverride } = stallingFetch()
    const outputs: unknown[] = []
    const captured = await captureOpenAIRequests({
      model: 'vendor-model-x',
      baseURL: 'https://gateway.example/v1',
      env: {
        OPENAI_WIRE_API: 'chat',
        CLAUDE_STREAM_IDLE_TIMEOUT_MS: '150',
        CLAUDE_CODE_MAX_RETRIES: '1',
      },
      fetchOverride,
      outputs,
    })
    expect(captured).toHaveLength(0) // answered by the custom fetch
    expect(state.requests).toBe(2)
    expect(state.stalledRequestAborted).toBe(true)
    expect(textOf(outputs)).toBe('recovered')
  })

  test('no retries left: the turn ends with the idle-timeout error', async () => {
    const { fetchOverride } = stallingFetch()
    const outputs: unknown[] = []
    await captureOpenAIRequests({
      model: 'vendor-model-x',
      baseURL: 'https://gateway.example/v1',
      env: {
        OPENAI_WIRE_API: 'chat',
        CLAUDE_STREAM_IDLE_TIMEOUT_MS: '150',
        CLAUDE_CODE_MAX_RETRIES: '0',
      },
      fetchOverride,
      outputs,
    })
    expect(textOf(outputs)).toContain('stream idle timeout after 150ms')
  })
})

describe('Grok lane', () => {
  test('same watchdog', async () => {
    const outputs: unknown[] = []
    const stall = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(FIRST_CHUNK))
      },
    })
    await captureGrokRequests({
      model: 'grok-4',
      env: {
        CLAUDE_STREAM_IDLE_TIMEOUT_MS: '150',
        CLAUDE_CODE_MAX_RETRIES: '0',
      },
      chatSSE: stall,
      outputs,
    })
    expect(textOf(outputs)).toContain('Grok stream idle timeout after 150ms')
  })
})
