// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * hermes #23 — Responses `encrypted_content` is replayed only to the endpoint
 * that minted it (P18.8).
 *
 * Constructed fixtures, not recorded: the item shape is the one
 * `extractReasoningItem` keeps; the drop rule follows hermes
 * `agent/codex_responses_adapter.py:450-461, 535-569`. The end-to-end lock for
 * the fleet path (same endpoint keeps replaying) is in `requestParity.test.ts`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { OPENAI_REASONING_ITEMS_FIELD } from '@ant/model-provider'
import {
  adaptResponsesStreamToAnthropic,
  buildResponsesRequest,
  resolveResponsesEndpoint,
} from 'src/services/api/openai/responsesAdapter.js'
import {
  replayableReasoningItems,
  responsesIssuer,
} from '../responsesIssuer.js'

const A = 'https://relay-a.example/v1'
const B = 'https://relay-b.example/v1'

const saved = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_AUTH_MODE: process.env.OPENAI_AUTH_MODE,
}
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function issuerOf(baseURL: string): string {
  return responsesIssuer({
    chatgpt: false,
    endpoint: resolveResponsesEndpoint(baseURL),
  })
}

describe('responsesIssuer', () => {
  test('the ChatGPT route is one issuer whatever the base URL', () => {
    expect(responsesIssuer({ chatgpt: true, endpoint: A })).toBe(
      'chatgpt-codex',
    )
    expect(responsesIssuer({ chatgpt: true, endpoint: B })).toBe(
      'chatgpt-codex',
    )
  })

  test('one endpoint written two ways is one issuer', () => {
    expect(
      responsesIssuer({
        chatgpt: false,
        endpoint: 'https://Relay-A.example/v1/responses/',
      }),
    ).toBe(
      responsesIssuer({
        chatgpt: false,
        endpoint: 'https://relay-a.example/v1/responses?x=1#f',
      }),
    )
  })

  test('different hosts or paths are different issuers', () => {
    expect(issuerOf(A)).not.toBe(issuerOf(B))
    expect(issuerOf('https://relay-a.example/v2')).not.toBe(issuerOf(A))
    expect(issuerOf(A)).not.toBe(
      responsesIssuer({ chatgpt: true, endpoint: A }),
    )
  })

  test('the stamp carries no URL and no credential', () => {
    const stamp = responsesIssuer({
      chatgpt: false,
      endpoint: 'https://user:sk-test-canary-p188@relay-a.example/v1/responses',
    })
    expect(stamp).toMatch(/^api:[0-9a-f]{16}$/)
    expect(stamp).toBe(issuerOf(A))
  })
})

describe('replayableReasoningItems', () => {
  const items = [
    { id: 'legacy', encrypted_content: 'E0' },
    { id: 'same', encrypted_content: 'E1', issuer: 'api:aaaa' },
    { id: 'other', encrypted_content: 'E2', issuer: 'api:bbbb' },
  ]
  test('keeps unstamped and same-issuer items, drops the rest', () => {
    expect(
      replayableReasoningItems(items, 'api:aaaa').map(item => item.id),
    ).toEqual(['legacy', 'same'])
  })
})

describe('buildResponsesRequest — replay filtered by the current endpoint', () => {
  function assistantWith(items: Record<string, unknown>[]) {
    return {
      role: 'assistant',
      content: 'a1',
      [OPENAI_REASONING_ITEMS_FIELD]: items,
    }
  }
  function replayedIds(baseURL: string): unknown[] {
    process.env.OPENAI_BASE_URL = baseURL
    delete process.env.OPENAI_AUTH_MODE
    const request = buildResponsesRequest({
      model: 'gpt-6-luna',
      messages: [
        { role: 'user', content: 'q1' },
        assistantWith([
          { id: 'rs_a', encrypted_content: 'ENC_A', issuer: issuerOf(A) },
          { id: 'rs_legacy', encrypted_content: 'ENC_L' },
        ]),
        { role: 'user', content: 'q2' },
      ],
      tools: [],
      toolChoice: undefined,
      reasoningEffort: 'high',
    })
    return request.input
      .filter(item => item.type === 'reasoning')
      .map(item => item.encrypted_content)
  }

  test('same endpoint: the stamped item is replayed with its payload', () => {
    expect(replayedIds(A)).toEqual(['ENC_A', 'ENC_L'])
  })

  test('another endpoint: the stamped item is dropped, legacy kept', () => {
    expect(replayedIds(B)).toEqual(['ENC_L'])
  })

  test('the stamp is never sent', () => {
    process.env.OPENAI_BASE_URL = A
    const request = buildResponsesRequest({
      model: 'gpt-6-luna',
      messages: [
        assistantWith([
          { id: 'rs_a', encrypted_content: 'ENC_A', issuer: issuerOf(A) },
        ]),
      ],
      tools: [],
      toolChoice: undefined,
    })
    expect(JSON.stringify(request)).not.toContain('issuer')
  })
})

describe('adaptResponsesStreamToAnthropic — items are stamped on capture', () => {
  async function capture(): Promise<Record<string, unknown>[]> {
    const captured: Record<string, unknown>[] = []
    const stream = (async function* () {
      yield {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC' },
      }
      yield { type: 'response.completed', response: { status: 'completed' } }
    })()
    for await (const _ of adaptResponsesStreamToAnthropic(stream, 'm', {
      onReasoningItem: item => captured.push(item),
    })) {
      // drain
    }
    return captured
  }

  test('API-key route: the endpoint digest', async () => {
    process.env.OPENAI_BASE_URL = A
    delete process.env.OPENAI_AUTH_MODE
    expect((await capture())[0]?.issuer).toBe(issuerOf(A))
  })

  test('ChatGPT subscription route: the Codex backend', async () => {
    process.env.OPENAI_BASE_URL = A
    process.env.OPENAI_AUTH_MODE = 'chatgpt'
    expect((await capture())[0]?.issuer).toBe('chatgpt-codex')
  })
})
