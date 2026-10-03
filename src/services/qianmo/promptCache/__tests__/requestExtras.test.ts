// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.19 T-6 (retention, CH-5) and T-7 (response id and cache diagnostics,
 * CH-6), design `providers-console-m1.md` §5.11.7.
 *
 * The wire half runs the REAL `queryModelOpenAI` through the P18.5 recording
 * stub (`modelCompat/__tests__/support/requestCapture.ts`): what the generic
 * `/responses` route puts in the body, and what the assistant message it
 * yields carries. The transcript half of T-7 ① and the same fields across a
 * replaced ACP child are in `tests/integration/qianmo-prompt-cache.test.ts`.
 *
 * Nothing leaves the process; the key is a canary.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import type { Message } from 'src/types/message.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import { captureOpenAIRequests } from '../../modelCompat/__tests__/support/requestCapture.js'
import {
  resetPromptCacheExtrasForTesting,
  resolvePromptCacheOptions,
  resolvePromptCacheRetention,
} from '../requestExtras.js'
import {
  OPENAI_PROMPT_CACHE_DIAGNOSTICS_FIELD,
  OPENAI_RESPONSE_ID_FIELD,
  previousResponseId,
} from '../responseRecord.js'
import { resetPinnedPromptCacheKeysForTesting } from '../sessionCacheKey.js'

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => settingsMock.reset())

const GATEWAY = 'https://gateway.example/v1'
const META = 'https://api.meta.ai/v1'
/** The fleet's settings (design §5.11.2). */
const FLEET_ENV = {
  OPENAI_WIRE_API: 'responses',
  CLAUDE_CODE_EFFORT_LEVEL: 'max',
  CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
}
/** `fleet lock: full key set` in requestParity.test.ts, gateway row. */
const GATEWAY_BASELINE_KEYS = [
  'include',
  'input',
  'instructions',
  'max_output_tokens',
  'model',
  'parallel_tool_calls',
  'prompt_cache_key',
  'reasoning',
  'store',
  'stream',
]

const savedEnv = {
  OPENAI_PROMPT_CACHE_RETENTION: process.env.OPENAI_PROMPT_CACHE_RETENTION,
  OPENAI_PROMPT_CACHE_DIAGNOSTICS: process.env.OPENAI_PROMPT_CACHE_DIAGNOSTICS,
}

afterEach(() => {
  resetPromptCacheExtrasForTesting()
  resetPinnedPromptCacheKeysForTesting()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** A Responses reply whose `response` objects carry `id`, as OpenAI's do. */
function answer(id: string, diagnostics?: Record<string, unknown>): string {
  const events = [
    { type: 'response.created', response: { id, status: 'in_progress' } },
    { type: 'response.output_text.delta', delta: 'ok' },
    {
      type: 'response.completed',
      response: {
        id,
        status: 'completed',
        ...(diagnostics !== undefined && {
          prompt_cache_diagnostics: diagnostics,
        }),
      },
    },
  ]
  return events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')
}

function user(uuid: string, content: string): Message {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content },
  } as unknown as Message
}

function rejection(param: string): { status: number; body: unknown } {
  return {
    status: 400,
    body: {
      error: {
        message: `Unsupported parameter: '${param}' is not supported with this model.`,
        type: 'invalid_request_error',
        param,
        code: 'unsupported_parameter',
      },
    },
  }
}

/** One turn: every request it put on the wire, and the assistant message. */
async function turn(params: {
  baseURL?: string
  env?: Record<string, string | undefined>
  messages: Message[]
  sse?: string
  failFirst?: { status: number; body: unknown }[]
}): Promise<{ bodies: Record<string, unknown>[]; reply: Message | undefined }> {
  const outputs: unknown[] = []
  const requests = await captureOpenAIRequests({
    model: 'gpt-6-luna',
    baseURL: params.baseURL ?? GATEWAY,
    env: { ...FLEET_ENV, ...params.env },
    messages: params.messages,
    responsesSSE: params.sse,
    failFirst: params.failFirst,
    outputs,
  })
  const assistants = outputs.filter(
    o => (o as { type?: string }).type === 'assistant',
  ) as Message[]
  expect(assistants.length).toBeLessThanOrEqual(1)
  return { bodies: requests.map(r => r.body), reply: assistants[0] }
}

function field(m: Message | undefined, key: string): unknown {
  return (m?.message as Record<string, unknown> | undefined)?.[key]
}

describe('T-6: prompt_cache_retention (CH-5)', () => {
  test('① unset: the body is the fleet baseline, byte for byte', async () => {
    const plain = await turn({ messages: [user('u1', 'q1')] })
    const off = await turn({
      env: {
        OPENAI_PROMPT_CACHE_RETENTION: 'off',
        OPENAI_PROMPT_CACHE_DIAGNOSTICS: '0',
      },
      messages: [user('u1', 'q1')],
    })
    expect(Object.keys(plain.bodies[0]!).sort()).toEqual(GATEWAY_BASELINE_KEYS)
    expect(JSON.stringify(off.bodies[0])).toBe(JSON.stringify(plain.bodies[0]))
  })

  test('② OPENAI_PROMPT_CACHE_RETENTION=24h (or in_memory) is sent as given', async () => {
    for (const value of ['24h', 'in_memory']) {
      const { bodies } = await turn({
        env: { OPENAI_PROMPT_CACHE_RETENTION: value },
        messages: [user('u1', 'q1')],
      })
      expect(bodies.length).toBe(1)
      expect(bodies[0]!.prompt_cache_retention).toBe(value)
    }
  })

  test('③ api.meta.ai gets 24h without being asked; off turns it off', async () => {
    const meta = await turn({ baseURL: META, messages: [user('u1', 'q1')] })
    expect(meta.bodies[0]!.prompt_cache_retention).toBe('24h')
    const metaOff = await turn({
      baseURL: META,
      env: { OPENAI_PROMPT_CACHE_RETENTION: 'off' },
      messages: [user('u1', 'q1')],
    })
    expect('prompt_cache_retention' in metaOff.bodies[0]!).toBe(false)
  })

  test('④ refused once: re-sent without it before anything streamed, then never sent again', async () => {
    const env = { OPENAI_PROMPT_CACHE_RETENTION: '24h' }
    const first = await turn({
      env,
      messages: [user('u1', 'q1')],
      failFirst: [rejection('prompt_cache_retention')],
    })
    expect(first.bodies.length).toBe(2)
    expect(first.bodies[0]!.prompt_cache_retention).toBe('24h')
    expect('prompt_cache_retention' in first.bodies[1]!).toBe(false)
    // One answer, not a partial one plus a retried one: the retry happened
    // on the refused request.
    expect(first.reply).toBeDefined()
    // Everything else about the re-sent request is unchanged.
    const { prompt_cache_retention: _sent, ...rest } = first.bodies[0]!
    expect(first.bodies[1]).toEqual(rest)

    const later = await turn({ env, messages: [user('u1', 'q1')] })
    expect(later.bodies.length).toBe(1)
    expect('prompt_cache_retention' in later.bodies[0]!).toBe(false)
  })

  test('an unrelated 400 is not taken for a refusal: no retry, nothing latched', async () => {
    const env = { OPENAI_PROMPT_CACHE_RETENTION: '24h' }
    const failed = await turn({
      env,
      messages: [user('u1', 'q1')],
      failFirst: [
        {
          status: 400,
          body: { error: { message: 'Invalid value for input[0].content' } },
        },
      ],
    })
    // One request, and the turn ends in the lane's API-error message.
    expect(failed.bodies.length).toBe(1)
    expect(failed.bodies[0]!.prompt_cache_retention).toBe('24h')
    expect(JSON.stringify(failed.reply)).toContain('Invalid value for input')
    const next = await turn({ env, messages: [user('u1', 'q1')] })
    expect(next.bodies[0]!.prompt_cache_retention).toBe('24h')
  })
})

describe('T-7: response id and prompt cache diagnostics (CH-6)', () => {
  const DIAG = { OPENAI_PROMPT_CACHE_DIAGNOSTICS: '1' }
  const DIAGNOSTICS = {
    type: 'cache_miss',
    reason: 'tools_changed',
    comparison_reusable_tokens: 5629,
    cache_missed_tokens: 5629,
  }

  test('① the assistant message records the response id, diagnostics or not', async () => {
    const { reply } = await turn({
      messages: [user('u1', 'q1')],
      sse: answer('resp_first'),
    })
    expect(field(reply, OPENAI_RESPONSE_ID_FIELD)).toBe('resp_first')
    expect(field(reply, OPENAI_PROMPT_CACHE_DIAGNOSTICS_FIELD)).toBeUndefined()
  })

  test('② with diagnostics on, the first request names nothing and the next names the previous response', async () => {
    const first = await turn({
      env: DIAG,
      messages: [user('u1', 'q1')],
      sse: answer('resp_first'),
    })
    expect('prompt_cache_options' in first.bodies[0]!).toBe(false)
    const second = await turn({
      env: DIAG,
      messages: [user('u1', 'q1'), first.reply!, user('u2', 'q2')],
      sse: answer('resp_second'),
    })
    expect(second.bodies[0]!.prompt_cache_options).toEqual({
      comparison_response_id: 'resp_first',
    })
    expect(field(second.reply, OPENAI_RESPONSE_ID_FIELD)).toBe('resp_second')
  })

  test("③ the reply's prompt_cache_diagnostics is kept on the message verbatim", async () => {
    const first = await turn({
      env: DIAG,
      messages: [user('u1', 'q1')],
      sse: answer('resp_first'),
    })
    const second = await turn({
      env: DIAG,
      messages: [user('u1', 'q1'), first.reply!, user('u2', 'q2')],
      sse: answer('resp_second', DIAGNOSTICS),
    })
    expect(field(second.reply, OPENAI_PROMPT_CACHE_DIAGNOSTICS_FIELD)).toEqual(
      DIAGNOSTICS,
    )
  })

  test('④ refused once: re-sent without it, then never sent again in this process', async () => {
    const first = await turn({
      env: DIAG,
      messages: [user('u1', 'q1')],
      sse: answer('resp_first'),
    })
    const history = [user('u1', 'q1'), first.reply!, user('u2', 'q2')]
    const refused = await turn({
      env: DIAG,
      messages: history,
      failFirst: [
        {
          status: 400,
          body: {
            error: { message: "Unknown parameter: 'prompt_cache_options'." },
          },
        },
      ],
    })
    expect(refused.bodies.length).toBe(2)
    expect(refused.bodies[0]!.prompt_cache_options).toEqual({
      comparison_response_id: 'resp_first',
    })
    expect('prompt_cache_options' in refused.bodies[1]!).toBe(false)
    expect(refused.reply).toBeDefined()
    const later = await turn({ env: DIAG, messages: history })
    expect('prompt_cache_options' in later.bodies[0]!).toBe(false)
  })

  test('⑤ off: a recorded response id changes nothing on the wire', async () => {
    const first = await turn({
      messages: [user('u1', 'q1')],
      sse: answer('resp_first'),
    })
    const withId = first.reply!
    const withoutId = {
      ...withId,
      message: { ...withId.message },
    } as Message
    delete (withoutId.message as Record<string, unknown>)[
      OPENAI_RESPONSE_ID_FIELD
    ]
    const a = await turn({
      messages: [user('u1', 'q1'), withId, user('u2', 'q2')],
    })
    const b = await turn({
      messages: [user('u1', 'q1'), withoutId, user('u2', 'q2')],
    })
    expect(JSON.stringify(a.bodies[0])).toBe(JSON.stringify(b.bodies[0]))
    expect(JSON.stringify(a.bodies[0])).not.toContain('resp_first')
    expect(Object.keys(a.bodies[0]!).sort()).toEqual(GATEWAY_BASELINE_KEYS)
  })
})

describe('resolvers', () => {
  test('retention: only the two documented values; anything else is not sent', () => {
    for (const [raw, expected] of [
      ['24h', '24h'],
      [' IN_MEMORY ', 'in_memory'],
      ['30m', undefined],
      ['none', undefined],
      ['', undefined],
    ] as const) {
      process.env.OPENAI_PROMPT_CACHE_RETENTION = raw
      expect({ raw, got: resolvePromptCacheRetention(GATEWAY) }).toEqual({
        raw,
        got: expected,
      })
    }
    delete process.env.OPENAI_PROMPT_CACHE_RETENTION
    expect(resolvePromptCacheRetention(GATEWAY)).toBeUndefined()
    expect(resolvePromptCacheRetention('https://API.META.AI/v1')).toBe('24h')
    expect(resolvePromptCacheRetention('not a url')).toBeUndefined()
  })

  test('the comparison is the newest assistant message that has an id', () => {
    const assistant = (id?: string): Message =>
      ({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [],
          ...(id !== undefined && { [OPENAI_RESPONSE_ID_FIELD]: id }),
        },
      }) as unknown as Message
    const history = [
      user('u1', 'q'),
      assistant('resp_old'),
      user('u2', 'q'),
      assistant('resp_new'),
      user('u3', 'q'),
      assistant(),
      user('u4', 'q'),
    ]
    expect(previousResponseId(history)).toBe('resp_new')
    expect(previousResponseId([user('u1', 'q')])).toBeUndefined()
    expect(resolvePromptCacheOptions(history)).toBeUndefined()
    process.env.OPENAI_PROMPT_CACHE_DIAGNOSTICS = '1'
    expect(resolvePromptCacheOptions(history)).toEqual({
      comparison_response_id: 'resp_new',
    })
  })
})
