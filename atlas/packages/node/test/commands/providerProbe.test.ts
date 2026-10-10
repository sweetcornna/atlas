// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `auth`, `latency` and `models` against a recording stub (design
 * `providers-console-m1.md` §5.5, §9.2 P18.7): the three states with the four
 * cases the package table names — 200 with a normal body, 200 with an error
 * body, 400 for a bad key, connection refused — the `/v1` correction both
 * ways, and which request a preset profile makes. Every outcome is scanned
 * for the key, including the cases where the stub's own error text quotes it.
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
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type NodeCapabilities,
  presetById,
  secretFingerprint,
  type WireProfile,
} from '@qianmo/providers'
import { presetProfile, wireProfile } from '../providers/helpers.js'
import { providerPaths, writePrivateJson } from '../../src/providers/store.js'
import {
  listModels,
  type ProbeOutcome,
  type ProbeTarget,
  probeAuth,
  probeLatency,
  profileTarget,
} from '../../src/commands/providerProbe.js'
import { RecordingStub, refusedOrigin } from './providerStub.js'

const KEY = 'sk-test-canary-probe-key-5Rm8Qz2X'
const CAPABILITIES: NodeCapabilities = {
  protocol: 1,
  chatEffortHonorsOverride: true,
  replayFilter: false,
  multiKey: false,
}
const TIMEOUT_MS = 10_000

const AUTO_MODEL = {
  id: 'stub-model',
  role: 'main',
  tiers: ['opus', 'sonnet', 'haiku', 'fable'],
  capabilities: { mode: 'family' },
  effort: { send: 'auto' },
}

function profile(
  lane: 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini',
  baseUrl: string,
  key: Record<string, unknown> = { id: 'k1', value: KEY },
): WireProfile {
  return wireProfile(
    {
      id: 'stub-profile',
      lane,
      baseUrl,
      auth: { scheme: 'bearer', keys: [key] },
      models: [AUTO_MODEL],
      compat: {},
    },
    CAPABILITIES,
  )
}

function target(p: WireProfile): ProbeTarget {
  const resolved = profileTarget(p, CAPABILITIES)
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.issue))
  return resolved.target
}

/** Every outcome a test produced, scanned for the key once at the end. */
const seen: ProbeOutcome[] = []
function keep(outcome: ProbeOutcome): ProbeOutcome {
  seen.push(outcome)
  return outcome
}

let stub: RecordingStub
let root: string
let previousConfigDir: string | undefined

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-provider-probe-'))
  const config = join(root, 'config')
  mkdirSync(config, { mode: 0o700 })
  chmodSync(config, 0o700)
  previousConfigDir = process.env.QIANMO_CONFIG_DIR
  process.env.QIANMO_CONFIG_DIR = config
  writePrivateJson(providerPaths.models(), {
    providers: { 'qm-probe': { apiKey: KEY } },
  })
})

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.QIANMO_CONFIG_DIR
  else process.env.QIANMO_CONFIG_DIR = previousConfigDir
  rmSync(root, { recursive: true, force: true })
  // The scan: no outcome of this file ever carried the key.
  expect(seen.length).toBeGreaterThan(10)
  expect(JSON.stringify(seen)).not.toContain(KEY)
  expect(JSON.stringify(seen)).not.toContain(KEY.slice(-12))
})

beforeEach(() => {
  stub = new RecordingStub()
})

afterEach(async () => {
  await stub.stop()
})

describe('probe auth: three states, four cases', () => {
  test('200 with a normal body → ok', async () => {
    stub.on('/v1/models', () => Response.json({ data: [{ id: 'stub-model' }] }))
    const outcome = keep(
      await probeAuth(
        target(profile('openai-chat', `${stub.origin}/v1`)),
        TIMEOUT_MS,
      ),
    )
    expect(outcome).toMatchObject({
      ok: true,
      reachable: true,
      httpStatus: 200,
    })
    expect(stub.requests).toHaveLength(1)
    expect(stub.requests[0]?.authorization).toBe(`Bearer ${KEY}`)
  })

  test('200 with an error body → reachable, not ok; the vendor’s text is not passed on', async () => {
    stub.on('/v1/models', () =>
      Response.json({
        error: {
          code: 'invalid_api_key',
          message: `Incorrect API key provided: ${KEY}`,
        },
      }),
    )
    const outcome = keep(
      await probeAuth(
        target(profile('openai-chat', `${stub.origin}/v1`)),
        TIMEOUT_MS,
      ),
    )
    expect(outcome).toMatchObject({
      ok: false,
      reachable: true,
      httpStatus: 200,
      vendorCode: 'invalid_api_key',
    })
    expect(outcome.message).not.toContain('Incorrect')
  })

  test('200 with the other error-body shapes vendors use', async () => {
    const bodies = [
      { code: 1001, msg: 'Authentication failed' },
      { base_resp: { status_code: 1004, status_msg: 'login fail' } },
      { success: false, message: 'denied' },
    ]
    for (const body of bodies) {
      const one = new RecordingStub()
      one.on('/v1/models', () => Response.json(body))
      const outcome = keep(
        await probeAuth(
          target(profile('openai-chat', `${one.origin}/v1`)),
          TIMEOUT_MS,
        ),
      )
      await one.stop()
      expect({ body, ok: outcome.ok, reachable: outcome.reachable }).toEqual({
        body,
        ok: false,
        reachable: true,
      })
    }
  })

  test('400 for a bad key (Gemini, xAI) → reachable, not ok, with the word code', async () => {
    stub.on('/v1/models', () =>
      Response.json(
        {
          error: {
            code: 400,
            message: `API key not valid: ${KEY}`,
            status: 'INVALID_ARGUMENT',
          },
        },
        { status: 400 },
      ),
    )
    const outcome = keep(
      await probeAuth(
        target(profile('openai-chat', `${stub.origin}/v1`)),
        TIMEOUT_MS,
      ),
    )
    expect(outcome).toMatchObject({
      ok: false,
      reachable: true,
      httpStatus: 400,
      vendorCode: 'INVALID_ARGUMENT',
    })
  })

  test('connection refused → not reachable', async () => {
    const origin = await refusedOrigin()
    const outcome = keep(
      await probeAuth(
        target(profile('openai-chat', `${origin}/v1`)),
        TIMEOUT_MS,
      ),
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.reachable).toBe(false)
    expect(outcome.httpStatus).toBeUndefined()
    expect(outcome.message).toContain('连接被拒')
  })

  test('401 → reachable, rejected key', async () => {
    stub.on('/v1/models', () =>
      Response.json(
        { error: { type: 'authentication_error' } },
        { status: 401 },
      ),
    )
    const outcome = keep(
      await probeAuth(
        target(profile('openai-chat', `${stub.origin}/v1`)),
        TIMEOUT_MS,
      ),
    )
    expect(outcome).toMatchObject({
      ok: false,
      reachable: true,
      httpStatus: 401,
    })
    expect(outcome.message).toContain('凭据被拒')
  })

  test('a redirect is not followed, so the key never reaches the other host', async () => {
    const elsewhere = new RecordingStub()
    elsewhere.on('/v1/models', () => Response.json({ data: [] }))
    stub.on('/v1/models', () =>
      Response.redirect(`${elsewhere.origin}/v1/models`, 302),
    )
    const outcome = keep(
      await probeAuth(
        target(profile('openai-chat', `${stub.origin}/v1`)),
        TIMEOUT_MS,
      ),
    )
    expect(outcome).toMatchObject({
      ok: false,
      reachable: true,
      httpStatus: 302,
    })
    expect(elsewhere.requests).toEqual([])
    await elsewhere.stop()
  })

  test('a 200 that is not JSON (a web page) → not ok', async () => {
    stub.on(
      '/v1/models',
      () => new Response('<html>hello</html>', { status: 200 }),
    )
    const outcome = keep(
      await probeAuth(
        target(profile('openai-chat', `${stub.origin}/v1`)),
        TIMEOUT_MS,
      ),
    )
    expect(outcome).toMatchObject({
      ok: false,
      reachable: true,
      httpStatus: 200,
    })
  })

  test('keep: the key a fingerprint names is read from the node’s settings', async () => {
    stub.on('/v1/models', () => Response.json({ data: [] }))
    const kept = profile('openai-chat', `${stub.origin}/v1`, {
      id: 'k1',
      keep: secretFingerprint(KEY),
    })
    keep(await probeAuth(target(kept), TIMEOUT_MS))
    expect(stub.requests[0]?.authorization).toBe(`Bearer ${KEY}`)

    const unknown = profileTarget(
      profile('openai-chat', `${stub.origin}/v1`, {
        id: 'k1',
        keep: secretFingerprint('sk-test-canary-not-on-this-node'),
      }),
      CAPABILITIES,
    )
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.issue.code).toBe('secret-mismatch')
  })
})

describe('the /v1 correction', () => {
  test('OpenAI lane: /models is 404 without /v1, the /v1 address answers → suggestion', async () => {
    stub.on('/v1/models', () => Response.json({ data: [{ id: 'stub-model' }] }))
    const outcome = keep(
      await probeAuth(target(profile('openai-chat', stub.origin)), TIMEOUT_MS),
    )
    expect(stub.paths()).toEqual(['/models', '/v1/models'])
    expect(outcome).toMatchObject({
      ok: true,
      reachable: true,
      suggestion: { baseUrl: `${stub.origin}/v1` },
    })
  })

  test('OpenAI lane: both 404 → the address as given fails, nothing suggested', async () => {
    const outcome = keep(
      await probeAuth(
        target(profile('openai-responses', stub.origin)),
        TIMEOUT_MS,
      ),
    )
    expect(stub.paths()).toEqual(['/models', '/v1/models'])
    expect(outcome).toMatchObject({
      ok: false,
      reachable: true,
      httpStatus: 404,
    })
    expect(outcome.suggestion).toBeUndefined()
  })

  test('OpenAI lane with /v1 already: no second try', async () => {
    const outcome = keep(
      await probeAuth(
        target(profile('openai-chat', `${stub.origin}/v1`)),
        TIMEOUT_MS,
      ),
    )
    expect(stub.paths()).toEqual(['/v1/models'])
    expect(outcome.suggestion).toBeUndefined()
  })

  test('Anthropic lane: a base ending in /v1 is suggested without it and probed that way', async () => {
    stub.on('/v1/models', () => Response.json({ data: [{ id: 'stub-model' }] }))
    const outcome = keep(
      await probeAuth(
        target(profile('anthropic', `${stub.origin}/v1`)),
        TIMEOUT_MS,
      ),
    )
    expect(stub.paths()).toEqual(['/v1/models'])
    expect(stub.requests[0]?.anthropicVersion).toBe('2023-06-01')
    expect(stub.requests[0]?.authorization).toBe(`Bearer ${KEY}`)
    expect(outcome).toMatchObject({
      ok: true,
      suggestion: { baseUrl: stub.origin },
    })
  })

  test('Anthropic lane: the suggestion stands even when the stripped address fails', async () => {
    const outcome = keep(
      await probeAuth(
        target(profile('anthropic', `${stub.origin}/v1/`)),
        TIMEOUT_MS,
      ),
    )
    expect(outcome).toMatchObject({
      ok: false,
      reachable: true,
      suggestion: { baseUrl: stub.origin },
    })
  })
})

describe('probe latency', () => {
  test('a warm-up and three timed checks against the same address', async () => {
    stub.on('/v1/models', () => Response.json({ data: [] }))
    const outcome = keep(
      await probeLatency(
        target(profile('openai-chat', `${stub.origin}/v1`)),
        TIMEOUT_MS,
      ),
    )
    expect(stub.paths()).toEqual(Array(4).fill('/v1/models'))
    expect(outcome.ok).toBe(true)
    expect(outcome.latency?.samples).toBe(3)
    expect(outcome.latency?.minMs).toBeLessThanOrEqual(
      outcome.latency?.medianMs ?? -1,
    )
    expect(outcome.message).toContain('不含推理')
  })

  test('a failing warm-up ends it', async () => {
    stub.on('/v1/models', () => Response.json({}, { status: 401 }))
    const outcome = keep(
      await probeLatency(
        target(profile('openai-chat', `${stub.origin}/v1`)),
        TIMEOUT_MS,
      ),
    )
    expect(stub.requests).toHaveLength(1)
    expect(outcome).toMatchObject({
      ok: false,
      reachable: true,
      httpStatus: 401,
    })
    expect(outcome.latency).toBeUndefined()
  })
})

describe('models', () => {
  test('the vendor list, ids only, never one that holds the key', async () => {
    stub.on('/v1/models', () =>
      Response.json({
        data: [
          { id: 'stub-model' },
          { id: 'stub-model' },
          { id: 'deepseek-ai/DeepSeek-V4-Pro' },
          { id: `leak-${KEY}` },
          { id: 'has spaces' },
        ],
      }),
    )
    const outcome = keep(
      await listModels(
        target(profile('openai-chat', `${stub.origin}/v1`)),
        TIMEOUT_MS,
      ),
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.models).toEqual([
      { id: 'stub-model' },
      { id: 'deepseek-ai/DeepSeek-V4-Pro' },
    ])
  })

  test('Gemini’s native list shape', async () => {
    stub.on('/v1beta/models', () =>
      Response.json({ models: [{ name: 'models/gemini-3.8-flash' }] }),
    )
    const outcome = keep(
      await listModels(
        target(profile('gemini', `${stub.origin}/v1beta`)),
        TIMEOUT_MS,
      ),
    )
    expect(outcome.models).toEqual([{ id: 'gemini-3.8-flash' }])
    expect(stub.requests[0]?.googKey).toBe(KEY)
  })

  test('the /v1 correction applies to the list too', async () => {
    stub.on('/v1/models', () => Response.json({ data: [{ id: 'a' }] }))
    const outcome = keep(
      await listModels(target(profile('openai-chat', stub.origin)), TIMEOUT_MS),
    )
    expect(outcome).toMatchObject({
      ok: true,
      models: [{ id: 'a' }],
      suggestion: { baseUrl: `${stub.origin}/v1` },
    })
  })

  test('a 200 without a list → reachable, not ok', async () => {
    stub.on('/v1/models', () => Response.json({ object: 'list' }))
    const outcome = keep(
      await listModels(
        target(profile('openai-chat', `${stub.origin}/v1`)),
        TIMEOUT_MS,
      ),
    )
    expect(outcome).toMatchObject({ ok: false, reachable: true })
  })
})

describe('which request a preset profile makes', () => {
  test('a preset as delivered uses its own probe requests', () => {
    const deepseek = presetById('deepseek')
    if (deepseek === undefined) throw new Error('no deepseek preset')
    const t = target(presetProfile(deepseek, KEY))
    expect(t.spec?.auth?.path).toBe('/user/balance')
    // omp uses the configured Anthropic endpoint directly.
    expect(t.style).toBe('anthropic')
  })

  test('one URL shared by presets with the same requests still matches', () => {
    const minimax = presetById('minimax')
    if (minimax === undefined) throw new Error('no minimax preset')
    expect(target(presetProfile(minimax, KEY)).spec?.auth?.path).toBe(
      '/v1/models',
    )
  })

  test('one URL shared by presets that disagree falls back to the generic request', () => {
    const zhipu = presetById('zhipu')
    if (zhipu === undefined) throw new Error('no zhipu preset')
    expect(target(presetProfile(zhipu, KEY)).spec).toBeNull()
  })

  test('an edited base URL is no longer the preset', () => {
    const openai = presetById('openai')
    if (openai === undefined) throw new Error('no openai preset')
    const edited = wireProfile(
      {
        ...JSON.parse(JSON.stringify(presetProfile(openai, KEY))),
        baseUrl: 'https://api.openai.com/v1/proxy',
      },
      CAPABILITIES,
    )
    expect(target(edited).spec).toBeNull()
    expect(target(presetProfile(openai, KEY)).spec?.auth?.path).toBe(
      '/v1/models',
    )
  })
})
