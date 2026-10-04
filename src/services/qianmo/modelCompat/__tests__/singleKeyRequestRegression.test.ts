// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.18 completion standard 1, request half: with a single key (no key pool
 * on the node), what the OpenAI lane puts on the wire — every request of a
 * scenario, its URL, its credential header, its header names and its body
 * text — is byte for byte what it was when P18.12 merged (`df8531dc`).
 *
 * The golden (`fixtures/single-key-requests.df8531dc.json`) was written by
 * this file running on `df8531dc` itself, before any P18.18 change, with
 * `P18_18_WRITE_GOLDEN=1`; later runs only compare. Header VALUES other than
 * the three that carry no platform detail are left out: the OpenAI SDK's
 * `x-stainless-*` headers name the OS and runtime, which differ between a
 * developer machine and CI. Their names are kept.
 *
 * The failure scenarios pin the retry behaviour a pool must not disturb: a
 * 429 is retried with the same key, a 402 and a refused key end the turn
 * after one request.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionId } from 'src/bootstrap/state.js'
import { _resetPromptCacheKeySupportForTesting } from 'src/services/api/openai/openaiShared.js'
import { _resetReasoningSummarySupportForTesting } from 'src/services/api/openai/responsesAdapter.js'
import { resetPromptCacheExtrasForTesting } from 'src/services/qianmo/promptCache/requestExtras.js'
import { resetPinnedPromptCacheKeysForTesting } from 'src/services/qianmo/promptCache/sessionCacheKey.js'
import type { Message } from 'src/types/message.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import {
  type CapturedRequest,
  type CaptureParams,
  captureOpenAIRequests,
} from './support/requestCapture.js'

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => settingsMock.reset())

beforeEach(() => {
  resetPinnedPromptCacheKeysForTesting()
  _resetPromptCacheKeySupportForTesting()
  _resetReasoningSummarySupportForTesting()
  resetPromptCacheExtrasForTesting()
})

const GOLDEN = join(
  import.meta.dir,
  'fixtures',
  'single-key-requests.df8531dc.json',
)
const WRITE = process.env.P18_18_WRITE_GOLDEN === '1'
const GATEWAY = 'https://gateway.example/v1'

const HISTORY: Message[] = [
  {
    type: 'user',
    uuid: 'u-golden-1',
    message: { role: 'user', content: 'say ok' },
  } as unknown as Message,
]

const FLEET_ENV = {
  OPENAI_WIRE_API: 'responses',
  CLAUDE_CODE_EFFORT_LEVEL: 'max',
  CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
}

type Scenario = { name: string; params: CaptureParams }

const SCENARIOS: Scenario[] = [
  {
    name: 'fleet-responses',
    params: {
      model: 'gpt-6-luna',
      baseURL: GATEWAY,
      env: FLEET_ENV,
      messages: HISTORY,
    },
  },
  {
    name: 'chat',
    params: {
      model: 'vendor-chat-model',
      baseURL: GATEWAY,
      env: { OPENAI_WIRE_API: 'chat' },
      messages: HISTORY,
    },
  },
  {
    name: 'responses-429-then-ok',
    params: {
      model: 'gpt-6-luna',
      baseURL: GATEWAY,
      env: FLEET_ENV,
      messages: HISTORY,
      failFirst: [
        {
          status: 429,
          body: { error: { message: 'Rate limit', type: 'rate_limit_error' } },
        },
      ],
    },
  },
  {
    name: 'chat-402',
    params: {
      model: 'vendor-chat-model',
      baseURL: GATEWAY,
      env: { OPENAI_WIRE_API: 'chat' },
      messages: HISTORY,
      failFirst: [
        {
          status: 402,
          body: {
            error: { message: 'Payment required', type: 'payment_required' },
          },
        },
      ],
    },
  },
  {
    name: 'responses-401',
    params: {
      model: 'gpt-6-luna',
      baseURL: GATEWAY,
      env: FLEET_ENV,
      messages: HISTORY,
      failFirst: [
        {
          status: 401,
          body: {
            error: {
              message: 'Incorrect API key provided',
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          },
        },
      ],
    },
  },
]

/** Values kept as sent; every other header contributes only its name. */
const KEPT_HEADERS = ['authorization', 'content-type', 'accept']

function shape(request: CapturedRequest, sessionId: string) {
  return {
    url: request.url,
    headers: Object.fromEntries(
      KEPT_HEADERS.filter(name => name in request.headers).map(name => [
        name,
        request.headers[name],
      ]),
    ),
    headerNames: Object.keys(request.headers).sort(),
    // The session-scoped cache key falls back to the (random) session id.
    body: request.bodyText.split(sessionId).join('<session>'),
  }
}

/** The text of what the lane yielded: error messages, by their visible text. */
function visible(outputs: unknown[]): string[] {
  const texts: string[] = []
  for (const output of outputs) {
    const record = output as {
      type?: string
      message?: { content?: unknown }
    }
    if (record.type !== 'assistant') continue
    const content = record.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as { type?: string; text?: string }[]) {
      if (block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text)
      }
    }
  }
  return texts
}

async function run(scenario: Scenario) {
  const outputs: unknown[] = []
  const requests = await captureOpenAIRequests({ ...scenario.params, outputs })
  const sessionId = getSessionId()
  return {
    requests: requests.map(request => shape(request, sessionId)),
    visible: visible(outputs),
  }
}

type Golden = {
  generatedOn: string
  scenarios: Record<string, Awaited<ReturnType<typeof run>>>
}

describe('single-key requests: byte-identical to df8531dc', () => {
  if (WRITE) {
    test('write the golden (P18_18_WRITE_GOLDEN=1, on df8531dc only)', async () => {
      const golden: Golden = { generatedOn: 'df8531dc', scenarios: {} }
      for (const scenario of SCENARIOS) {
        resetPinnedPromptCacheKeysForTesting()
        golden.scenarios[scenario.name] = await run(scenario)
      }
      writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 2)}\n`)
    }, 60_000)
    return
  }

  const golden = (): Golden =>
    JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden

  for (const scenario of SCENARIOS) {
    test(scenario.name, async () => {
      const expected = golden().scenarios[scenario.name]
      expect(expected).toBeDefined()
      const now = await run(scenario)
      expect(now.requests.length).toBe(expected?.requests.length ?? -1)
      now.requests.forEach((request, index) => {
        expect({ index, request }).toEqual({
          index,
          request: expected?.requests[index] as typeof request,
        })
      })
      expect(now.visible).toEqual(expected?.visible ?? [])
    }, 30_000)
  }
})
