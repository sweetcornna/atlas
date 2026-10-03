// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.19 T-5 (design `providers-console-m1.md` §5.11.7): the requests that
 * are not the main loop's still route by the conversation.
 *
 * - A side query on the generic `/responses` route carries the session key
 *   `<bin>:<sessionId>` of the session it runs in, and gets the same key back
 *   when that session is current again (what a resume does).
 * - The Grok lane sends `x-grok-conv-id: <sessionId>` (CH-7): the same on
 *   every request of a session, different between sessions.
 *
 * Both run the real request path: `sideQuery` against a loopback endpoint;
 * the Grok lane from `queryModelWithStreaming` (claude.ts, which passes the
 * session id down) through `options.fetchOverride`. Canary keys, no network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options } from 'src/services/api/claude.js'
import type { SessionId } from 'src/types/ids.js'
import type { SystemPrompt } from 'src/utils/session/systemPromptType.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import {
  getSessionId,
  resetStateForTests,
  switchSession,
} from '../../../../bootstrap/state.js'
import { BIN_NAME } from 'src/constants/brand.js'
import { sideQuery } from '../../../../utils/session/sideQuery.js'
import { GROK_CONVERSATION_HEADER } from '../grokConversation.js'

// MACRO is a build-time define; provide it for the bare test runtime (same
// pattern as src/services/api/__tests__/streamFinalization.test.ts).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as unknown as { MACRO: unknown }).MACRO = {
    VERSION: '0.0.0-test',
    BUILD_TIME: '0',
  }
}

const settingsMock = setupSettingsMock()

const SESSION_A = 'aaaaaaaa-1111-4000-8000-00000000000a' as SessionId
const SESSION_B = 'bbbbbbbb-2222-4000-8000-00000000000b' as SessionId

const ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GROK',
  'CLAUDE_CODE_USE_GEMINI',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_WIRE_API',
  'OPENAI_AUTH_MODE',
  'OPENAI_PROMPT_CACHE_KEY',
  'OPENAI_PROMPT_CACHE_KEY_SCOPE',
  'GROK_API_KEY',
  'XAI_API_KEY',
  'GROK_BASE_URL',
  'GROK_MAX_TOKENS',
  'CLAUDE_CODE_TEST_FIXTURES_ROOT',
  'VCR_RECORD',
] as const
const savedEnv = new Map<string, string | undefined>()

/** Loopback `/responses`: records each body, answers one line of text. */
const sideQueryBodies: Record<string, unknown>[] = []
let endpoint: ReturnType<typeof Bun.serve> | undefined

beforeAll(() => {
  settingsMock.set({ getInitialSettings: () => ({}) })
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  endpoint = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async req => {
      sideQueryBodies.push((await req.json()) as Record<string, unknown>)
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
          'data: {"type":"response.completed","response":{"id":"resp_side","status":"completed","usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
})

afterAll(async () => {
  await endpoint?.stop(true)
  settingsMock.reset()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetStateForTests()
})

describe('T-5: a side query on the generic /responses route', () => {
  async function sideQueryKey(): Promise<unknown> {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_API_KEY = 'sk-test-canary-p1819-not-a-real-key'
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${endpoint!.port}/v1`
    process.env.OPENAI_WIRE_API = 'responses'
    try {
      const from = sideQueryBodies.length
      await sideQuery({
        model: 'gpt-6-luna',
        messages: [{ role: 'user', content: 'classify this' }],
        max_tokens: 16,
        querySource: 'model_validation',
      })
      expect(sideQueryBodies.length).toBe(from + 1)
      return sideQueryBodies.at(-1)!.prompt_cache_key
    } finally {
      for (const key of ENV_KEYS) delete process.env[key]
    }
  }

  test('carries the current session key, and the same one when the session is current again', async () => {
    switchSession(SESSION_A)
    const a1 = await sideQueryKey()
    const a2 = await sideQueryKey()
    switchSession(SESSION_B)
    const b = await sideQueryKey()
    // What resuming A does: A is the current session again.
    switchSession(SESSION_A)
    const a3 = await sideQueryKey()

    expect(a1).toBe(`${BIN_NAME}:${SESSION_A}`)
    expect(a2).toBe(a1)
    expect(b).toBe(`${BIN_NAME}:${SESSION_B}`)
    expect(a3).toBe(a1)
  })
})

describe('T-5: the Grok lane (CH-7)', () => {
  const CHAT_SSE =
    'data: {"id":"chatcmpl-p1819","object":"chat.completion.chunk","created":0,"model":"grok-4","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n' +
    'data: {"id":"chatcmpl-p1819","object":"chat.completion.chunk","created":0,"model":"grok-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    'data: [DONE]\n\n'

  /**
   * One Grok main-loop request, dispatched by claude.ts the way production
   * does it; the value of the routing header it carried.
   */
  async function grokConversationHeader(): Promise<string | null> {
    process.env.CLAUDE_CODE_USE_GROK = '1'
    process.env.GROK_API_KEY = 'xai-test-canary-p1819-not-a-real-key'
    process.env.GROK_BASE_URL = 'https://grok.example/v1'
    // queryModelWithStreaming wraps the loop in the VCR cassette layer, armed
    // by NODE_ENV=test: a throwaway root and record mode make every run miss
    // and execute the real loop, writing nothing into the repo.
    const fixtures = mkdtempSync(join(tmpdir(), 'qm-grok-routing-'))
    process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = fixtures
    process.env.VCR_RECORD = '1'
    const seen: Headers[] = []
    const fetchOverride = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      seen.push(
        new Headers(
          input instanceof Request ? input.headers : (init?.headers ?? {}),
        ),
      )
      return new Response(CHAT_SSE, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch
    const options = {
      model: 'grok-4',
      querySource: 'sdk',
      isNonInteractiveSession: true,
      agents: [],
      hasAppendSystemPrompt: false,
      mcpTools: [],
      getToolPermissionContext: async () => ({ mode: 'default' }),
      fetchOverride,
    } as unknown as Options
    try {
      const { queryModelWithStreaming } = await import('../../../api/claude.js')
      const outputs: unknown[] = []
      for await (const output of queryModelWithStreaming({
        messages: [],
        systemPrompt: ['test'] as unknown as SystemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal: new AbortController().signal,
        options,
      })) {
        outputs.push(output)
      }
      expect(seen.length).toBe(1)
      expect(
        outputs.some(o => (o as { type?: string }).type === 'assistant'),
      ).toBe(true)
      return seen[0]!.get(GROK_CONVERSATION_HEADER)
    } finally {
      for (const key of ENV_KEYS) delete process.env[key]
      rmSync(fixtures, { recursive: true, force: true })
    }
  }

  test('x-grok-conv-id is the session id: constant within a session, different across sessions', async () => {
    switchSession(SESSION_A)
    const a1 = await grokConversationHeader()
    const a2 = await grokConversationHeader()
    switchSession(SESSION_B)
    const b = await grokConversationHeader()

    expect(a1).toBe(SESSION_A)
    expect(a2).toBe(a1)
    expect(b).toBe(SESSION_B)
    expect(getSessionId()).toBe(SESSION_B)
  })
})
