// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The key pool end to end through the OpenAI lane (P18.18; design §9.2
 * P18.18, §5.11.6 X-1): the REAL `queryModelOpenAI` with its retry ladder,
 * recording stub (`captureOpenAIRequests`) answering per key, a pool written
 * the way the node's commit writes it into a temp config root. Canary keys,
 * no network.
 *
 * Pinned here, by which key each request went out with:
 *
 *   - X-1: one session, ten requests, one key — for every strategy, so that
 *     `round_robin` / `least_used` choosing per request would show;
 *   - the hermes behaviour table row by row (429 twice → switch; usage limit,
 *     402, 401 → switch at once; a revoked key → dead), with the cooldown each
 *     row leaves and a provider-given reset time beating the default;
 *   - every key out → the turn ends with an error naming the first key back
 *     and when, without a request;
 *   - a failure after output (past the commitment barrier) is never re-sent
 *     with another key: one request, the key is accounted for, the NEXT turn
 *     takes the next key;
 *   - no pool, or a pool the env is not bound to → the env's key;
 *   - no key value in the pool's log lines, in what the lane yielded, or in
 *     the state file.
 *
 * Sessions other than the process's own are switched for real in
 * `credentialPoolSessions.runner.ts` (see `credentialPoolSessions.isolated.test.ts`).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type KeySelection, secretFingerprint } from '@qianmo/providers'
import { _resetPromptCacheKeySupportForTesting } from 'src/services/api/openai/openaiShared.js'
import { _resetReasoningSummarySupportForTesting } from 'src/services/api/openai/responsesAdapter.js'
import { resetPromptCacheExtrasForTesting } from 'src/services/qianmo/promptCache/requestExtras.js'
import { resetPinnedPromptCacheKeysForTesting } from 'src/services/qianmo/promptCache/sessionCacheKey.js'
import type { Message } from 'src/types/message.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import { providerPaths } from '../../providers/store.js'
import {
  keyPoolStatus,
  resetCredentialPoolMemoryForTesting,
  setCredentialPoolNoteSinkForTesting,
} from '../credentialPool.js'
import {
  type KeyPoolFile,
  readKeyPoolState,
  updateKeyPoolState,
  writeKeyPool,
} from '../credentialPoolStore.js'
import {
  type CapturedRequest,
  type CaptureParams,
  captureOpenAIRequests,
} from './support/requestCapture.js'

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => settingsMock.reset())

const K1 = 'sk-test-canary-lane-one-Vb20QmT7xLp4'
const K2 = 'sk-test-canary-lane-two-Rk61NwE3sYa8'
const K3 = 'sk-test-canary-lane-three-Gd94ZcU1hJq5'
const VALUES = [K1, K2, K3]
const ENV_ONLY = 'sk-test-canary-lane-env-only-Pn38Wf'
const GATEWAY = 'https://gateway.example/v1'
const HOUR = 3_600_000
const MINUTE = 60_000

const HISTORY: Message[] = [
  {
    type: 'user',
    uuid: 'u-pool-lane-1',
    message: { role: 'user', content: 'say ok' },
  } as unknown as Message,
]

let root: string
let previousConfigDir: string | undefined
let notes: string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-key-pool-lane-'))
  const config = join(root, 'config')
  mkdirSync(config, { mode: 0o700 })
  chmodSync(config, 0o700)
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  notes = []
  setCredentialPoolNoteSinkForTesting(line => notes.push(line))
  resetCredentialPoolMemoryForTesting()
  resetPinnedPromptCacheKeysForTesting()
  _resetPromptCacheKeySupportForTesting()
  _resetReasoningSummarySupportForTesting()
  resetPromptCacheExtrasForTesting()
})

afterEach(() => {
  setCredentialPoolNoteSinkForTesting(null)
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  rmSync(root, { recursive: true, force: true })
})

function install(selection: KeySelection = 'fill_first'): void {
  const file: KeyPoolFile = {
    v: 1,
    profile: { id: 'luna', revision: 3 },
    requestId: 'req-pool-lane-0001',
    selection,
    envKey: 'OPENAI_API_KEY',
    keys: VALUES.map((value, index) => ({ id: `k${index + 1}`, value })),
  }
  writeKeyPool(
    file,
    Object.fromEntries(
      file.keys.map(key => [key.id, secretFingerprint(key.value)]),
    ),
  )
}

/** Which key a request went out with: `k1`…`k3`, `env`, or the raw header. */
function keyOf(request: CapturedRequest): string {
  const token = (request.headers.authorization ?? '').replace(/^Bearer /, '')
  const index = VALUES.indexOf(token)
  if (index >= 0) return `k${index + 1}`
  return token === ENV_ONLY ? 'env' : `?${token.length}`
}

function json(status: number, body: unknown, headers = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

type Responder = () => Response | undefined
/** Answer per key; a key without an entry gets the default stream. */
function byKey(
  answers: Partial<Record<string, Responder>>,
): CaptureParams['respond'] {
  return request => answers[keyOf(request)]?.()
}

const RATE_LIMIT: Responder = () =>
  json(429, {
    error: { message: 'Rate limit reached for requests', type: 'requests' },
  })
const USAGE_LIMIT: Responder = () =>
  json(429, {
    error: {
      type: 'usage_limit_reached',
      code: 'usage_limit_reached',
      message: 'The usage limit has been reached',
    },
  })
const PAYMENT: Responder = () =>
  json(402, {
    error: { message: 'Payment required', type: 'payment_required' },
  })
const BAD_KEY: Responder = () =>
  json(401, {
    error: {
      message: 'Incorrect API key provided',
      type: 'invalid_request_error',
      code: 'invalid_api_key',
    },
  })
const REVOKED: Responder = () =>
  json(401, {
    error: {
      message: 'This key was revoked',
      type: 'invalid_request_error',
      code: 'token_revoked',
    },
  })

function visible(outputs: unknown[]): string[] {
  const texts: string[] = []
  for (const output of outputs) {
    const record = output as { type?: string; message?: { content?: unknown } }
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

type Turn = { keys: string[]; texts: string[]; outputs: unknown[] }

const yielded: unknown[] = []

/** One turn of the current session on the fleet's Responses lane. */
async function turn(
  respond?: CaptureParams['respond'],
  extra: Partial<CaptureParams> = {},
): Promise<Turn> {
  const outputs: unknown[] = []
  const requests = await captureOpenAIRequests({
    model: 'gpt-6-luna',
    baseURL: GATEWAY,
    env: {
      OPENAI_WIRE_API: 'responses',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
      OPENAI_API_KEY: K1,
    },
    messages: HISTORY,
    outputs,
    ...(respond ? { respond } : {}),
    ...extra,
  })
  yielded.push(...outputs)
  return { keys: requests.map(keyOf), texts: visible(outputs), outputs }
}

function untilOf(id: string): number {
  const until = readKeyPoolState().marks[id]?.until
  return until === undefined ? Number.NaN : Date.parse(until)
}

// ─── X-1 ─────────────────────────────────────────────────────────────────────

describe('X-1: one session, ten requests, one key', () => {
  for (const selection of [
    'fill_first',
    'round_robin',
    'least_used',
  ] as const) {
    test(selection, async () => {
      install(selection)
      const keys: string[] = []
      for (let i = 0; i < 10; i += 1) keys.push(...(await turn()).keys)
      expect(keys).toEqual(Array(10).fill('k1'))
      // Chosen once: one selection counted, the cursor moved once.
      const state = readKeyPoolState()
      expect(state.selections.k1?.count).toBe(1)
      expect(state.selections.k2).toBeUndefined()
      if (selection === 'round_robin') expect(state.cursor).toBe(1)
    }, 60_000)
  }

  test('on the chat lane too', async () => {
    install('round_robin')
    const keys: string[] = []
    for (let i = 0; i < 10; i += 1) {
      keys.push(
        ...(
          await turn(undefined, {
            model: 'vendor-chat-model',
            env: { OPENAI_WIRE_API: 'chat', OPENAI_API_KEY: K1 },
          })
        ).keys,
      )
    }
    expect(keys).toEqual(Array(10).fill('k1'))
  }, 60_000)
})

// ─── the hermes behaviour table ──────────────────────────────────────────────

describe('behaviour table, end to end', () => {
  test('429: the same key once more, then the next key; cooldown 1 h', async () => {
    install()
    const started = Date.now()
    const result = await turn(byKey({ k1: RATE_LIMIT }))
    expect(result.keys).toEqual(['k1', 'k1', 'k2'])
    expect(result.texts.join('')).toBe('ok')
    expect(untilOf('k1')).toBeGreaterThanOrEqual(started + HOUR)
    expect(untilOf('k1')).toBeLessThanOrEqual(Date.now() + HOUR)
    expect(readKeyPoolState().marks.k1?.reason).toBe('rate-limit')
    // The session stays on its new key.
    expect((await turn(byKey({ k1: RATE_LIMIT }))).keys).toEqual(['k2'])
  }, 30_000)

  test('429 usage limit: the next key at once; cooldown 1 h', async () => {
    install()
    const result = await turn(byKey({ k1: USAGE_LIMIT }))
    expect(result.keys).toEqual(['k1', 'k2'])
    expect(result.texts.join('')).toBe('ok')
    expect(readKeyPoolState().marks.k1).toMatchObject({
      state: 'cooling',
      reason: 'usage-limit',
      status: 429,
    })
  }, 30_000)

  test('402: the next key at once; cooldown 1 h', async () => {
    install()
    const started = Date.now()
    const result = await turn(byKey({ k1: PAYMENT }))
    expect(result.keys).toEqual(['k1', 'k2'])
    expect(result.texts.join('')).toBe('ok')
    expect(readKeyPoolState().marks.k1).toMatchObject({
      reason: 'billing',
      status: 402,
    })
    expect(untilOf('k1')).toBeGreaterThanOrEqual(started + HOUR)
    expect(untilOf('k1')).toBeLessThanOrEqual(Date.now() + HOUR)
  }, 30_000)

  test('402 on the chat lane: the next key at once', async () => {
    install()
    const result = await turn(byKey({ k1: PAYMENT }), {
      model: 'vendor-chat-model',
      env: { OPENAI_WIRE_API: 'chat', OPENAI_API_KEY: K1 },
    })
    expect(result.keys).toEqual(['k1', 'k2'])
    expect(result.texts.join('')).toBe('ok')
  }, 30_000)

  test('401: the next key at once; cooldown 5 min', async () => {
    install()
    const started = Date.now()
    const result = await turn(byKey({ k1: BAD_KEY }))
    expect(result.keys).toEqual(['k1', 'k2'])
    expect(result.texts.join('')).toBe('ok')
    expect(readKeyPoolState().marks.k1).toMatchObject({
      state: 'cooling',
      reason: 'auth',
    })
    expect(untilOf('k1')).toBeGreaterThanOrEqual(started + 5 * MINUTE)
    expect(untilOf('k1')).toBeLessThanOrEqual(Date.now() + 5 * MINUTE)
  }, 30_000)

  test('401 revoked: the next key at once; the key is dead', async () => {
    install()
    const result = await turn(byKey({ k1: REVOKED }))
    expect(result.keys).toEqual(['k1', 'k2'])
    expect(keyPoolStatus()?.[0]).toEqual({
      id: 'k1',
      state: 'dead',
      reason: 'revoked',
    })
  }, 30_000)

  test('a Retry-After beyond what the ladder waits: the next key at once, out until then', async () => {
    install()
    const started = Date.now()
    const result = await turn(
      byKey({
        k1: () =>
          json(
            429,
            { error: { message: 'Rate limit', type: 'requests' } },
            { 'retry-after': '7200' },
          ),
      }),
    )
    expect(result.keys).toEqual(['k1', 'k2'])
    // The provider's time, not the default hour.
    expect(untilOf('k1')).toBeGreaterThanOrEqual(started + 2 * HOUR)
    expect(untilOf('k1')).toBeLessThanOrEqual(Date.now() + 2 * HOUR)
  }, 30_000)

  test('a reset time in the body beats the default cooldown', async () => {
    install()
    const reset = new Date(Date.now() + 30 * MINUTE).toISOString()
    const result = await turn(
      byKey({
        k1: () =>
          json(429, {
            error: { message: 'Rate limit', type: 'requests', reset_at: reset },
          }),
      }),
    )
    expect(result.keys).toEqual(['k1', 'k1', 'k2'])
    expect(readKeyPoolState().marks.k1?.until).toBe(reset)
  }, 30_000)

  test('a server error is not the key: no switch, no mark', async () => {
    install()
    let failures = 1
    const result = await turn(
      byKey({
        k1: () =>
          failures-- > 0
            ? json(500, { error: { message: 'boom', type: 'server_error' } })
            : undefined,
      }),
    )
    expect(result.keys).toEqual(['k1', 'k1'])
    expect(readKeyPoolState().marks).toEqual({})
  }, 30_000)
})

// ─── every key out ───────────────────────────────────────────────────────────

describe('every key out', () => {
  test('the turn ends without a request, naming the first key back and when', async () => {
    install()
    const now = Date.now()
    const at = (minutes: number) =>
      new Date(now + minutes * MINUTE).toISOString()
    updateKeyPoolState(state => {
      for (const [id, minutes, reason] of [
        ['k1', 50, 'billing'],
        ['k2', 5, 'auth'],
        ['k3', 20, 'rate-limit'],
      ] as const) {
        const value = VALUES[Number(id.slice(1)) - 1] as string
        state.marks[id] = {
          fp: secretFingerprint(value),
          state: 'cooling',
          until: at(minutes),
          reason,
          at: at(0),
        }
      }
    })
    const result = await turn()
    expect(result.keys).toEqual([])
    expect(result.texts.join('\n')).toContain(
      `the first back is key k2 at ${at(5)} (auth)`,
    )
  }, 30_000)

  test('the last key failing ends the turn the same way', async () => {
    install()
    const result = await turn(
      byKey({ k1: PAYMENT, k2: USAGE_LIMIT, k3: BAD_KEY }),
    )
    expect(result.keys).toEqual(['k1', 'k2', 'k3'])
    expect(result.texts.join('\n')).toContain('the first back is key k3 at')
    expect(keyPoolStatus()?.map(key => key.state)).toEqual([
      'cooling',
      'cooling',
      'cooling',
    ])
  }, 30_000)
})

// ─── the commitment barrier ──────────────────────────────────────────────────

describe('after output, never another key in the same turn', () => {
  const PARTIAL_THEN_USAGE_LIMIT =
    'data: {"type":"response.output_text.delta","delta":"partial"}\n\n' +
    'data: {"type":"error","error":{"type":"usage_limit_reached","code":"usage_limit_reached","message":"The usage limit has been reached"}}\n\n'

  test('one request; the key is out; the next turn takes the next key', async () => {
    install()
    const first = await turn(
      byKey({
        k1: () =>
          new Response(PARTIAL_THEN_USAGE_LIMIT, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
      }),
    )
    expect(first.keys).toEqual(['k1'])
    // The partial text reached the reader before the error did.
    expect(JSON.stringify(first.outputs)).toContain(
      '"delta":{"type":"text_delta","text":"partial"}',
    )
    expect(first.texts.join('')).toContain('The usage limit has been reached')
    expect(readKeyPoolState().marks.k1?.reason).toBe('usage-limit')
    expect(readKeyPoolState().sessions).toEqual({})

    const second = await turn()
    expect(second.keys).toEqual(['k2'])
    expect(second.texts.join('')).toBe('ok')
  }, 30_000)
})

// ─── no pool ─────────────────────────────────────────────────────────────────

describe('without a pool the env key goes out', () => {
  test('no key-pool.json', async () => {
    const result = await turn(undefined, {
      env: { OPENAI_WIRE_API: 'responses', OPENAI_API_KEY: ENV_ONLY },
    })
    expect(result.keys).toEqual(['env'])
  })

  test('a pool the env is not bound to (a local edit replaced the key)', async () => {
    install()
    const result = await turn(byKey({ env: PAYMENT }), {
      env: { OPENAI_WIRE_API: 'responses', OPENAI_API_KEY: ENV_ONLY },
    })
    expect(result.keys).toEqual(['env'])
    expect(readKeyPoolState().sessions).toEqual({})
  })
})

// ─── canary ──────────────────────────────────────────────────────────────────

describe('no key value anywhere but the request', () => {
  test('log lines, yielded output, state file', async () => {
    install('round_robin')
    await turn(byKey({ k1: PAYMENT }))
    await turn(byKey({ k2: REVOKED }))
    await turn(byKey({ k3: RATE_LIMIT }))
    const statePath = providerPaths.keyPoolState()
    expect(statSync(statePath).mode & 0o777).toBe(0o600)
    expect(statSync(providerPaths.keyPool()).mode & 0o777).toBe(0o600)
    const haystacks = [
      notes.join('\n'),
      JSON.stringify(yielded),
      readFileSync(statePath, 'utf8'),
      JSON.stringify(keyPoolStatus()),
    ]
    expect(notes.length).toBeGreaterThan(0)
    for (const value of VALUES) {
      for (const haystack of haystacks) expect(haystack).not.toContain(value)
      // Not even a prefix long enough to identify it.
      for (const haystack of haystacks) {
        expect(haystack).not.toContain(value.slice(-12))
      }
    }
  }, 60_000)
})
