// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The key pool on its own (P18.18; design §9.2 P18.18, §5.11.6 X-1): real
 * files in a temp config root, the lane's real error constructor
 * (`createOpenAIResponseError` over a constructed `Response`), a clock the
 * test moves. No `mock.module`.
 *
 * Pinned here: the three strategies and that each chooses once per session;
 * every row of the hermes behaviour table at the decision level (the same
 * rows end to end through the lane are in `credentialPoolLane.test.ts`); a
 * provider-given reset time beating the default cooldown, from each place it
 * can be read; every key out → an error naming the first key back and when;
 * the state file 0600, without any key value, and still in force in a fresh
 * process; `status` per key with ids only.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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
import { createOpenAIResponseError } from 'src/services/api/openai/retry.js'
import { providerPaths } from '../../providers/store.js'
import {
  activeCredentialPool,
  CredentialPool,
  CredentialPoolExhaustedError,
  keyPoolStatus,
  poolDecision,
  resetAtFromError,
  resetCredentialPoolMemoryForTesting,
} from '../credentialPool.js'
import {
  type KeyPoolFile,
  readKeyPool,
  readKeyPoolState,
  writeKeyPool,
} from '../credentialPoolStore.js'

const K1 = 'sk-test-canary-pool-one-Qx81LmN0pW4xR'
const K2 = 'sk-test-canary-pool-two-Hd02KsP9vQ3mZ'
const K3 = 'sk-test-canary-pool-three-Zt55RcB2nY7'
const VALUES = [K1, K2, K3]
const T0 = Date.parse('2026-10-04T08:00:00.000Z')
const HOUR = 3_600_000
const RUNNER = join(
  import.meta.dir,
  'fixtures',
  'credentialPoolRestart.runner.ts',
)

let root: string
let config: string
let previousConfigDir: string | undefined
let clock = T0

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-key-pool-'))
  config = join(root, 'config')
  mkdirSync(config, { mode: 0o700 })
  chmodSync(config, 0o700)
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  clock = T0
  resetCredentialPoolMemoryForTesting()
})

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  rmSync(root, { recursive: true, force: true })
})

function poolFile(
  selection: KeySelection,
  values: readonly string[] = VALUES,
): KeyPoolFile {
  return {
    v: 1,
    profile: { id: 'luna', revision: 7 },
    requestId: 'req-pool-0001',
    selection,
    envKey: 'OPENAI_API_KEY',
    keys: values.map((value, index) => ({ id: `k${index + 1}`, value })),
  }
}

function install(
  selection: KeySelection,
  values: readonly string[] = VALUES,
): CredentialPool {
  const file = poolFile(selection, values)
  writeKeyPool(
    file,
    Object.fromEntries(
      file.keys.map(key => [key.id, secretFingerprint(key.value)]),
    ),
  )
  const read = readKeyPool()
  if (read === null) throw new Error('pool did not read back')
  return new CredentialPool(read, () => clock)
}

async function httpError(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return createOpenAIResponseError(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    }),
    'Responses API',
  )
}

const RATE_LIMIT = {
  error: { message: 'Rate limit reached', type: 'rate_limit_error' },
}

function stateText(): string {
  return readFileSync(providerPaths.keyPoolState(), 'utf8')
}

// ─── strategies (X-1: chosen once per session) ───────────────────────────────

describe('strategies choose once per session, never per request', () => {
  test('fill_first: every session takes the first key until it goes out', async () => {
    const pool = install('fill_first')
    expect(['s1', 's2', 's3'].map(s => pool.keyFor(s).id)).toEqual([
      'k1',
      'k1',
      'k1',
    ])
    expect(pool.failed('s1', pool.keyFor('s1'), await httpError(402, {}))).toBe(
      'rotated',
    )
    expect(['s1', 's2', 's4'].map(s => pool.keyFor(s).id)).toEqual([
      'k2',
      'k2',
      'k2',
    ])
  })

  test('round_robin: new sessions take the next key; a session keeps its own', () => {
    const pool = install('round_robin')
    expect(['s1', 's2', 's3', 's4'].map(s => pool.keyFor(s).id)).toEqual([
      'k1',
      'k2',
      'k3',
      'k1',
    ])
    // Ten more requests of s2 do not move it, and do not move the cursor.
    for (let i = 0; i < 10; i += 1) expect(pool.keyFor('s2').id).toBe('k2')
    expect(pool.keyFor('s5').id).toBe('k2')
  })

  test('round_robin skips a key that is out', async () => {
    const pool = install('round_robin')
    pool.keyFor('s1')
    expect(pool.failed('s1', pool.keyFor('s1'), await httpError(402, {}))).toBe(
      'rotated',
    )
    // The cursor stands at k2; k1 (out) is skipped on the way round.
    expect(['s2', 's3', 's4'].map(s => pool.keyFor(s).id)).toEqual([
      'k2',
      'k3',
      'k2',
    ])
  })

  test('least_used: the key chosen least often, ties in pool order', async () => {
    const pool = install('least_used')
    expect(['s1', 's2', 's3'].map(s => pool.keyFor(s).id)).toEqual([
      'k1',
      'k2',
      'k3',
    ])
    // k2 goes out; while it is out the other two take turns.
    pool.failed('s2', pool.keyFor('s2'), await httpError(402, {}))
    expect(['s4', 's5', 's6'].map(s => pool.keyFor(s).id)).toEqual([
      'k1',
      'k3',
      'k1',
    ])
    // Back after its hour, k2 is the least used and comes first.
    clock = T0 + HOUR + 1
    expect(pool.keyFor('s7').id).toBe('k2')
    expect(readKeyPoolState().selections).toMatchObject({
      k1: { count: 3 },
      k2: { count: 2 },
      k3: { count: 2 },
    })
  })

  test('X-1 at the pool: ten requests of one session, one choice written', () => {
    const pool = install('round_robin')
    const ids = Array.from({ length: 10 }, () => pool.keyFor('only').id)
    expect(new Set(ids)).toEqual(new Set(['k1']))
    expect(readKeyPoolState().selections).toEqual({
      k1: { fp: secretFingerprint(K1), count: 1 },
    })
  })
})

// ─── the behaviour table, row by row ─────────────────────────────────────────

describe('the hermes behaviour table', () => {
  test('429: the first is retried with the same key, the second takes it out for an hour', async () => {
    const pool = install('fill_first')
    const key = pool.keyFor('s1')
    expect(pool.failed('s1', key, await httpError(429, RATE_LIMIT))).toBe(
      'retry-same',
    )
    expect(pool.keyFor('s1').id).toBe('k1')
    expect(pool.failed('s1', key, await httpError(429, RATE_LIMIT))).toBe(
      'rotated',
    )
    expect(readKeyPoolState().marks.k1).toMatchObject({
      state: 'cooling',
      reason: 'rate-limit',
      status: 429,
      until: new Date(T0 + HOUR).toISOString(),
    })
    expect(pool.keyFor('s1').id).toBe('k2')
  })

  test('a success between two 429s resets the retry', async () => {
    const pool = install('fill_first')
    const key = pool.keyFor('s1')
    pool.failed('s1', key, await httpError(429, RATE_LIMIT))
    pool.succeeded('s1')
    expect(pool.failed('s1', key, await httpError(429, RATE_LIMIT))).toBe(
      'retry-same',
    )
  })

  test('a first 429 the ladder would not wait out (Retry-After past its bound) rotates at once, to that time', async () => {
    const pool = install('fill_first')
    const key = pool.keyFor('s1')
    expect(
      pool.failed(
        's1',
        key,
        await httpError(429, RATE_LIMIT, { 'retry-after': '7200' }),
      ),
    ).toBe('rotated')
    expect(readKeyPoolState().marks.k1?.until).toBe(
      new Date(T0 + 2 * HOUR).toISOString(),
    )
  })

  test('usage cap: out at once for an hour (code or wording)', async () => {
    for (const body of [
      { error: { message: 'You have hit a cap', code: 'usage_limit_reached' } },
      {
        error: {
          message: 'The usage limit has been reached for this key',
          type: 'rate_limit_error',
        },
      },
    ]) {
      const pool = install('fill_first')
      resetCredentialPoolMemoryForTesting()
      const key = pool.keyFor('s1')
      expect(pool.failed('s1', key, await httpError(429, body))).toBe('rotated')
      expect(readKeyPoolState().marks.k1).toMatchObject({
        reason: 'usage-limit',
        until: new Date(T0 + HOUR).toISOString(),
      })
      rmSync(providerPaths.keyPoolState())
    }
  })

  test('402: out at once for an hour', async () => {
    const pool = install('fill_first')
    expect(
      pool.failed(
        's1',
        pool.keyFor('s1'),
        await httpError(402, {
          error: { message: 'Payment required', type: 'payment_required' },
        }),
      ),
    ).toBe('rotated')
    expect(readKeyPoolState().marks.k1).toMatchObject({
      state: 'cooling',
      reason: 'billing',
      status: 402,
      until: new Date(T0 + HOUR).toISOString(),
    })
  })

  test('a 429 that is really billing (insufficient_quota) is billing: out at once', async () => {
    const pool = install('fill_first')
    expect(
      pool.failed(
        's1',
        pool.keyFor('s1'),
        await httpError(429, {
          error: {
            message: 'You exceeded your current quota',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        }),
      ),
    ).toBe('rotated')
    expect(readKeyPoolState().marks.k1?.reason).toBe('billing')
  })

  test('401: out for five minutes; a revoked credential is dead', async () => {
    const pool = install('fill_first')
    expect(
      pool.failed(
        's1',
        pool.keyFor('s1'),
        await httpError(401, {
          error: { message: 'Incorrect API key', code: 'invalid_api_key' },
        }),
      ),
    ).toBe('rotated')
    expect(readKeyPoolState().marks.k1).toMatchObject({
      state: 'cooling',
      reason: 'auth',
      until: new Date(T0 + 5 * 60_000).toISOString(),
    })
    expect(
      pool.failed(
        's1',
        pool.keyFor('s1'),
        await httpError(401, {
          error: { message: 'Token revoked', code: 'token_revoked' },
        }),
      ),
    ).toBe('rotated')
    expect(readKeyPoolState().marks.k2).toMatchObject({
      state: 'dead',
      reason: 'revoked',
    })
    expect(readKeyPoolState().marks.k2?.until).toBeUndefined()
    // Dead does not come back with time.
    clock = T0 + 1000 * HOUR
    expect(keyPoolStatus(clock)?.find(key => key.id === 'k2')?.state).toBe(
      'dead',
    )
  })

  test('not the key: an overloaded 429, a 500, a 400 leave it in rotation', async () => {
    const pool = install('fill_first')
    const key = pool.keyFor('s1')
    for (const error of [
      await httpError(429, {
        error: {
          message: 'The service may be temporarily overloaded',
          code: '1305',
        },
      }),
      await httpError(500, { error: { message: 'boom' } }),
      await httpError(400, {
        error: { message: 'bad field', type: 'invalid_request_error' },
      }),
    ]) {
      expect(pool.failed('s1', key, error)).toBe('none')
    }
    expect(readKeyPoolState().marks).toEqual({})
  })
})

// ─── provider-given reset times beat the default ─────────────────────────────

describe('Retry-After / reset_at win over the default cooldown', () => {
  const at = (ms: number) => new Date(ms).toISOString()

  test('every place a reset time is read from, in hermes order', async () => {
    const cases: [string, Promise<unknown>, number][] = [
      [
        'body reset_at (ISO)',
        httpError(402, {
          error: { message: 'x', reset_at: at(T0 + 3 * HOUR) },
        }),
        T0 + 3 * HOUR,
      ],
      [
        'body resets_at (epoch seconds)',
        httpError(402, {
          error: { message: 'x', resets_at: (T0 + 2 * HOUR) / 1000 },
        }),
        T0 + 2 * HOUR,
      ],
      [
        'body retry_after (seconds)',
        httpError(402, { error: { message: 'x', retry_after: 90 } }),
        T0 + 90_000,
      ],
      [
        'Retry-After header (seconds)',
        httpError(402, { error: { message: 'x' } }, { 'retry-after': '120' }),
        T0 + 120_000,
      ],
      [
        'retry-after-ms header',
        httpError(
          402,
          { error: { message: 'x' } },
          { 'retry-after-ms': '1500' },
        ),
        T0 + 1500,
      ],
      [
        'x-ratelimit-reset header (epoch ms)',
        httpError(
          402,
          { error: { message: 'x' } },
          {
            'x-ratelimit-reset': String(T0 + 45 * 60_000),
          },
        ),
        T0 + 45 * 60_000,
      ],
      [
        'the message: resets in 2h 30m',
        httpError(402, { error: { message: 'Quota resets in 2h 30m' } }),
        T0 + 2.5 * HOUR,
      ],
      [
        'the message: quotaResetDelay',
        httpError(402, { error: { message: 'quotaResetDelay: "750ms"' } }),
        T0 + 750,
      ],
      [
        'the message: retry after 30 seconds',
        httpError(402, { error: { message: 'Please retry after 30 seconds' } }),
        T0 + 30_000,
      ],
      [
        'body reset_at beats a Retry-After header',
        httpError(
          402,
          { error: { message: 'x', reset_at: at(T0 + 4 * HOUR) } },
          { 'retry-after': '10' },
        ),
        T0 + 4 * HOUR,
      ],
    ]
    for (const [label, error, expected] of cases) {
      expect([label, resetAtFromError(await error, T0)]).toEqual([
        label,
        expected,
      ])
    }
  })

  test('the reset time is the cooldown: 402 with reset_at, 401 with Retry-After, second 429 with Retry-After', async () => {
    const pool = install('fill_first', [
      K1,
      K2,
      K3,
      'sk-test-canary-pool-four-Wm20',
    ])
    pool.failed(
      'a',
      pool.keyFor('a'),
      await httpError(402, {
        error: { message: 'x', reset_at: at(T0 + 10 * 60_000) },
      }),
    )
    pool.failed(
      'a',
      pool.keyFor('a'),
      await httpError(
        401,
        { error: { message: 'x' } },
        {
          'retry-after': '30',
        },
      ),
    )
    const k3 = pool.keyFor('a')
    const limited = await httpError(429, RATE_LIMIT, { 'retry-after': '20' })
    expect(pool.failed('a', k3, limited)).toBe('retry-same')
    expect(pool.failed('a', k3, limited)).toBe('rotated')
    const marks = readKeyPoolState().marks
    expect(marks.k1?.until).toBe(at(T0 + 10 * 60_000))
    expect(marks.k2?.until).toBe(at(T0 + 30_000))
    expect(marks.k3?.until).toBe(at(T0 + 20_000))
  })

  test('decision without a pool: the same table, as data', async () => {
    expect(
      poolDecision(await httpError(402, {}), { retried429: false, nowMs: T0 }),
    ).toEqual({
      kind: 'out',
      state: 'cooling',
      reason: 'billing',
      untilMs: T0 + HOUR,
      status: 402,
    })
  })
})

// ─── every key out ───────────────────────────────────────────────────────────

describe('every key out of rotation', () => {
  test('the error names the key back first and when; it is not retried', async () => {
    const pool = install('round_robin')
    const out = async (session: string, error: Promise<unknown>) =>
      pool.failed(session, pool.keyFor(session), await error)
    clock = T0
    await out('s1', httpError(402, {})) // k1 until T0 + 1h
    await out('s2', httpError(401, { error: { message: 'x' } })) // k2 until T0 + 5 min
    await out(
      's3',
      httpError(402, { error: { message: 'x', retry_after: 1800 } }),
    ) // k3 until T0 + 30 min
    let caught: unknown
    try {
      pool.keyFor('s4')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CredentialPoolExhaustedError)
    const error = caught as CredentialPoolExhaustedError
    expect(error.next).toEqual({
      keyId: 'k2',
      at: new Date(T0 + 5 * 60_000).toISOString(),
    })
    expect(error.message).toContain('k2')
    expect(error.message).toContain(new Date(T0 + 5 * 60_000).toISOString())
    expect(error.retryable).toBe(false)
    expect(error.category).toBe('rate_limit')
    for (const value of VALUES) expect(error.message).not.toContain(value)
    // Once that time passes, k2 is back.
    clock = T0 + 5 * 60_000
    expect(pool.keyFor('s4').id).toBe('k2')
  })

  test('every key dead: no time to wait for, an authentication failure', async () => {
    const pool = install('fill_first', [K1, K2])
    const revoked = () =>
      httpError(401, { error: { message: 'gone', code: 'token_invalidated' } })
    pool.failed('s', pool.keyFor('s'), await revoked())
    pool.failed('s', pool.keyFor('s'), await revoked())
    let caught: unknown
    try {
      pool.keyFor('s')
    } catch (error) {
      caught = error
    }
    expect((caught as CredentialPoolExhaustedError).next).toBeNull()
    expect((caught as CredentialPoolExhaustedError).category).toBe(
      'authentication_failed',
    )
  })

  test('all billing: a billing error', async () => {
    const pool = install('fill_first', [K1, K2])
    pool.failed('s', pool.keyFor('s'), await httpError(402, {}))
    pool.failed('s', pool.keyFor('s'), await httpError(402, {}))
    expect(() => pool.keyFor('s')).toThrow(CredentialPoolExhaustedError)
    try {
      pool.keyFor('s')
    } catch (error) {
      expect((error as CredentialPoolExhaustedError).category).toBe(
        'billing_error',
      )
    }
  })
})

// ─── the state on disk ───────────────────────────────────────────────────────

describe('the state on disk', () => {
  test('both files 0600 in a 0700 directory; the state holds no key value', async () => {
    const pool = install('round_robin')
    pool.keyFor('s1')
    pool.failed('s1', pool.keyFor('s1'), await httpError(402, {}))
    const mode = (path: string) => statSync(path).mode & 0o777
    expect(mode(providerPaths.keyPool())).toBe(0o600)
    expect(mode(providerPaths.keyPoolState())).toBe(0o600)
    expect(mode(join(config, 'qianmo', 'provider'))).toBe(0o700)
    const text = stateText()
    for (const value of VALUES) {
      expect(text).not.toContain(value)
      expect(text).not.toContain(value.slice(-8))
    }
    // Positive control: the pool file does hold them.
    expect(readFileSync(providerPaths.keyPool(), 'utf8')).toContain(K1)
  })

  test('a cooldown and a binding hold in a fresh process (restart)', async () => {
    // The fresh process reads the real clock: cool to a real future time.
    clock = Date.now()
    const pool = install('fill_first')
    expect(pool.keyFor('other').id).toBe('k1')
    pool.failed('other', pool.keyFor('other'), await httpError(402, {}))
    expect(pool.keyFor('kept-session').id).toBe('k2')
    const run = (session: string) => {
      const env: Record<string, string> = {}
      for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined && !name.endsWith('_API_KEY')) env[name] = value
      }
      const result = Bun.spawnSync([process.execPath, 'run', RUNNER, session], {
        env: { ...env, CLAUDE_CONFIG_DIR: config, OPENAI_API_KEY: K1 },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const line = result.stdout
        .toString()
        .split('\n')
        .find(text => text.startsWith('QIANMO_POOL '))
      if (result.exitCode !== 0 || line === undefined) {
        throw new Error(
          `runner ${result.exitCode}: ${result.stderr.toString()}`,
        )
      }
      for (const value of VALUES) expect(line).not.toContain(value)
      return JSON.parse(line.slice('QIANMO_POOL '.length)) as {
        pool: boolean
        key: string | null
        status: { id: string; state: string }[]
      }
    }
    // fill_first after a restart: k1 is still cooling, so a new session
    // skips it; the bound session keeps k2.
    expect(run('kept-session').key).toBe('k2')
    const fresh = run('new-session')
    expect(fresh.key).toBe('k2')
    expect(fresh.status.map(key => [key.id, key.state])).toEqual([
      ['k1', 'cooling'],
      ['k2', 'ok'],
      ['k3', 'ok'],
    ])
    // Positive control: the same fresh process with the cooldown gone picks k1.
    rmSync(providerPaths.keyPoolState())
    expect(run('newer-session').key).toBe('k1')
  }, 30_000)

  test('a new value for a key id clears what the old value earned', async () => {
    const pool = install('fill_first')
    pool.failed('s1', pool.keyFor('s1'), await httpError(402, {}))
    expect(keyPoolStatus(clock)?.[0]?.state).toBe('cooling')
    const rotated = install('fill_first', [
      'sk-test-canary-pool-new-one-Rr4',
      K2,
      K3,
    ])
    expect(keyPoolStatus(clock)?.[0]).toEqual({ id: 'k1', state: 'ok' })
    expect(readKeyPoolState().marks).toEqual({})
    expect(rotated.keyFor('s9').id).toBe('k1')
  })
})

// ─── status and the env binding ──────────────────────────────────────────────

describe('status and the env binding', () => {
  test('status: one entry per key, ids and states only', async () => {
    const pool = install('fill_first')
    pool.failed('s', pool.keyFor('s'), await httpError(402, {}))
    pool.failed(
      's',
      pool.keyFor('s'),
      await httpError(401, {
        error: { message: 'x', code: 'token_revoked' },
      }),
    )
    const status = keyPoolStatus(clock)
    expect(status).toEqual([
      {
        id: 'k1',
        state: 'cooling',
        until: new Date(T0 + HOUR).toISOString(),
        reason: 'billing',
      },
      { id: 'k2', state: 'dead', reason: 'revoked' },
      { id: 'k3', state: 'ok' },
    ])
    const text = JSON.stringify(status)
    for (const value of VALUES) expect(text).not.toContain(value)
    // Past the cooldown it reads ok again.
    expect(keyPoolStatus(T0 + HOUR)?.[0]).toEqual({ id: 'k1', state: 'ok' })
  })

  test('no pool file: no status, no pool', () => {
    expect(keyPoolStatus()).toBeNull()
    expect(activeCredentialPool({ OPENAI_API_KEY: K1 })).toBeNull()
  })

  test('the pool is used only while the env holds its primary key', () => {
    install('fill_first')
    expect(activeCredentialPool({ OPENAI_API_KEY: K1 })).not.toBeNull()
    expect(activeCredentialPool({ OPENAI_API_KEY: K2 })).toBeNull()
    expect(activeCredentialPool({})).toBeNull()
  })
})
