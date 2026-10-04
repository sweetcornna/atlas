// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The node's model-call capability report (design §2.4) — the whole object,
 * and `replayFilter` (P18.8) pinned to the behaviour behind it, so the flag
 * cannot stay `true` after either filter is unwired. The Q-1 flag has its own
 * behavioural pin in `chatEffort.test.ts`; `multiKey` (P18.18) in
 * `credentialPoolLane.test.ts`.
 *
 * Constructed fixtures, not recorded; no vendor is called.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { OPENAI_REASONING_ITEMS_FIELD } from '@ant/model-provider'
import { buildOpenAIRequestBody } from 'src/services/api/openai/requestBody.js'
import {
  buildResponsesRequest,
  resolveResponsesEndpoint,
} from 'src/services/api/openai/responsesAdapter.js'
import { getModelCompatCapabilities } from '../capabilities.js'
import { responsesIssuer } from '../responsesIssuer.js'

const savedBaseURL = process.env.OPENAI_BASE_URL
const savedAuthMode = process.env.OPENAI_AUTH_MODE
afterEach(() => {
  if (savedBaseURL === undefined) delete process.env.OPENAI_BASE_URL
  else process.env.OPENAI_BASE_URL = savedBaseURL
  if (savedAuthMode === undefined) delete process.env.OPENAI_AUTH_MODE
  else process.env.OPENAI_AUTH_MODE = savedAuthMode
})

describe('getModelCompatCapabilities', () => {
  test('reports every flag this node implements', () => {
    expect(getModelCompatCapabilities()).toEqual({
      chatEffortHonorsOverride: true,
      replayFilter: true,
      multiKey: true,
    })
  })
})

describe('replayFilter is backed by both filters', () => {
  test('#4: a strict chat endpoint is not sent history reasoning', () => {
    const body = buildOpenAIRequestBody({
      model: 'mistral-large-latest',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', reasoning_content: 'from kimi' },
        { role: 'user', content: 'q2' },
      ],
      tools: [],
      toolChoice: undefined,
      enableThinking: false,
      maxTokens: 1024,
      baseURL: 'https://api.mistral.ai/v1',
    })
    expect(JSON.stringify(body.messages)).not.toContain('reasoning_content')
  })

  test('#23: a Responses item minted elsewhere is not replayed', () => {
    process.env.OPENAI_BASE_URL = 'https://relay-b.example/v1'
    delete process.env.OPENAI_AUTH_MODE
    const foreign = responsesIssuer({
      chatgpt: false,
      endpoint: resolveResponsesEndpoint('https://relay-a.example/v1'),
    })
    const request = buildResponsesRequest({
      model: 'gpt-6-luna',
      messages: [
        {
          role: 'assistant',
          content: 'a',
          [OPENAI_REASONING_ITEMS_FIELD]: [
            { id: 'rs', encrypted_content: 'ENC', issuer: foreign },
          ],
        },
      ],
      tools: [],
      toolChoice: undefined,
    })
    expect(request.input.some(item => item.type === 'reasoning')).toBe(false)
  })
})
