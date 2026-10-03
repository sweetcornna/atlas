// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Grok lane's history goes through the same send-boundary replay policy
 * as the OpenAI lane (P18.12, follow-up from the P18.8 audit; hermes #4).
 *
 * Before: `grok/index.ts` built its body straight from
 * `anthropicMessagesToOpenAI`, so every thinking block in history went to
 * xAI as `reasoning_content`, whichever vendor wrote it. Constructed history;
 * the requests are answered by a local stub.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Message } from 'src/types/message.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import { captureGrokRequests } from './support/grokCapture.js'

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => settingsMock.reset())

const HISTORY = [
  {
    type: 'user',
    uuid: 'u-1',
    message: { role: 'user', content: 'q' },
  },
  {
    type: 'assistant',
    uuid: 'a-1',
    message: {
      id: 'm1',
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'another vendor reasoned',
          signature: '',
        },
        { type: 'text', text: 'ok' },
      ],
    },
  },
  {
    type: 'user',
    uuid: 'u-2',
    message: { role: 'user', content: 'follow up' },
  },
] as unknown as Message[]

async function replayedAssistant(
  model: string,
  baseURL: string | undefined,
): Promise<Record<string, unknown>> {
  const [request] = await captureGrokRequests({
    model,
    baseURL,
    messages: HISTORY,
  })
  const messages = request!.body.messages as Record<string, unknown>[]
  const reply = messages.find(m => m.role === 'assistant')
  if (!reply) throw new Error('no assistant turn on the wire')
  return reply
}

describe('Grok lane replay filter', () => {
  test('xAI (default endpoint): reasoning_content from history is stripped', async () => {
    const reply = await replayedAssistant('grok-4', undefined)
    expect(reply.content).toBe('ok')
    expect('reasoning_content' in reply).toBe(false)
  })

  test('decided by GROK_BASE_URL: a family host keeps its echo contract', async () => {
    // A kimi host requires the key on every assistant turn, so the policy
    // must have been given this endpoint, not a hard-coded one.
    const reply = await replayedAssistant(
      'kimi-k3',
      'https://api.moonshot.ai/v1',
    )
    expect(reply.reasoning_content).toBe('another vendor reasoned')
  })
})
