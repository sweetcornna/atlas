// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.19 CH-3 / T-4: the prompt-cache key is fixed per (session, model) at its
 * first request, and is still the base's prefix hash — so sessions with the
 * same prefix share it, and `OPENAI_PROMPT_CACHE_KEY_SCOPE=session` still
 * gives each session its own.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { BIN_NAME } from 'src/constants/brand.js'
import {
  _resetPromptCacheKeySupportForTesting,
  markPromptCacheKeyRejected,
  resolveOpenAIPromptCacheKey,
} from 'src/services/api/openai/openaiShared.js'
import {
  getPinnedPromptCacheKeys,
  MAX_PINNED_SESSIONS,
  resetPinnedPromptCacheKeysForTesting,
  resolveSessionStablePromptCacheKey,
  restorePinnedPromptCacheKeys,
} from '../sessionCacheKey.js'

const BASE_URL = 'https://gateway.example/v1'
const TOOLS = [
  { type: 'function', name: 'Read' },
  { type: 'function', name: 'Glob' },
]

function request(
  sessionId: string,
  instructions: string,
  model = 'gpt-6-luna',
): Parameters<typeof resolveSessionStablePromptCacheKey>[0] {
  return {
    baseURL: BASE_URL,
    sessionId,
    wireProtocol: 'responses',
    model,
    messages: [{ role: 'system', content: instructions }],
    tools: TOOLS,
  }
}

const ENV_KEYS = [
  'OPENAI_PROMPT_CACHE_KEY',
  'OPENAI_PROMPT_CACHE_KEY_SCOPE',
] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  resetPinnedPromptCacheKeysForTesting()
  _resetPromptCacheKeySupportForTesting()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  resetPinnedPromptCacheKeysForTesting()
  _resetPromptCacheKeySupportForTesting()
})

describe('resolveSessionStablePromptCacheKey', () => {
  test('instructions rewritten mid-session keep the first key (the base resolver would flip)', () => {
    const first = resolveSessionStablePromptCacheKey(
      request('s-a', 'Status: (clean)'),
    )
    const later = resolveSessionStablePromptCacheKey(
      request('s-a', 'Status: ?? deployed.txt'),
    )
    expect(first).toStartWith(`${BIN_NAME}:p:`)
    expect(later).toBe(first)
    // Positive control: what the base sends for the same two requests.
    expect(
      resolveOpenAIPromptCacheKey(request('s-a', 'Status: ?? deployed.txt')),
    ).not.toBe(first)
  })

  test('the first key is the prefix hash, so two sessions with the same prefix share it', () => {
    const a = resolveSessionStablePromptCacheKey(request('s-a', 'same prefix'))
    const b = resolveSessionStablePromptCacheKey(request('s-b', 'same prefix'))
    expect(a).toBe(b)
    expect(a).toBe(resolveOpenAIPromptCacheKey(request('s-c', 'same prefix')))
  })

  test('OPENAI_PROMPT_CACHE_KEY_SCOPE=session: different per session, constant within one', () => {
    process.env.OPENAI_PROMPT_CACHE_KEY_SCOPE = 'session'
    const a1 = resolveSessionStablePromptCacheKey(request('s-a', 'one'))
    const a2 = resolveSessionStablePromptCacheKey(request('s-a', 'two'))
    const b1 = resolveSessionStablePromptCacheKey(request('s-b', 'one'))
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b1)
    expect(a1).toEndWith(':s-a')
  })

  test('a model switch re-keys once, then the new key holds', () => {
    const luna = resolveSessionStablePromptCacheKey(request('s-a', 'p'))
    const other = resolveSessionStablePromptCacheKey(
      request('s-a', 'p', 'gpt-6-sol'),
    )
    const otherLater = resolveSessionStablePromptCacheKey(
      request('s-a', 'p changed', 'gpt-6-sol'),
    )
    expect(other).not.toBe(luna)
    expect(otherLater).toBe(other)
    // and back: the first model's pin is still there
    expect(
      resolveSessionStablePromptCacheKey(request('s-a', 'p changed')),
    ).toBe(luna)
  })

  test('a withheld key stays withheld (explicit off, and the rejection latch)', () => {
    resolveSessionStablePromptCacheKey(request('s-a', 'p'))
    process.env.OPENAI_PROMPT_CACHE_KEY = '0'
    expect(
      resolveSessionStablePromptCacheKey(request('s-a', 'p')),
    ).toBeUndefined()
    delete process.env.OPENAI_PROMPT_CACHE_KEY
    markPromptCacheKeyRejected('responses')
    expect(
      resolveSessionStablePromptCacheKey(request('s-a', 'p')),
    ).toBeUndefined()
  })

  test('nothing cacheable falls back to the session key, unpinned', () => {
    const key = resolveSessionStablePromptCacheKey({
      ...request('s-a', ''),
      messages: [],
      tools: [],
    })
    expect(key).toEndWith(':s-a')
    expect(getPinnedPromptCacheKeys('s-a')).toEqual({})
  })

  test('pins round-trip through the sidecar form; a live pin wins over a restored one', () => {
    const live = resolveSessionStablePromptCacheKey(request('s-a', 'p'))!
    const saved = getPinnedPromptCacheKeys('s-a')
    expect(saved).toEqual({ 'gpt-6-luna': live })

    resetPinnedPromptCacheKeysForTesting()
    restorePinnedPromptCacheKeys('s-a', saved)
    expect(
      resolveSessionStablePromptCacheKey(
        request('s-a', 'rewritten after resume'),
      ),
    ).toBe(live)

    restorePinnedPromptCacheKeys('s-a', { 'gpt-6-luna': `${BIN_NAME}:p:stale` })
    expect(resolveSessionStablePromptCacheKey(request('s-a', 'p'))).toBe(live)
  })

  test('memory is bounded: the least recently used session is dropped first', () => {
    for (let i = 0; i <= MAX_PINNED_SESSIONS; i++) {
      resolveSessionStablePromptCacheKey(request(`s-${i}`, 'p'))
    }
    expect(getPinnedPromptCacheKeys('s-0')).toEqual({})
    expect(
      Object.keys(getPinnedPromptCacheKeys(`s-${MAX_PINNED_SESSIONS}`)),
    ).toEqual(['gpt-6-luna'])
  })
})
