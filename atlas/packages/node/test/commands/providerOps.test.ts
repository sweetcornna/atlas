// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `handleProviderLine` — everything `qm provider serve-stdin` does between
 * stdin and stdout — in this process, against a temporary config root.
 *
 * One case per code of the closed error set (§2.5), the two ways `apply`
 * ends (committed here, or left for a running resident and signalled), and
 * `status` filled from the resident's own files. Every response any case got
 * is scanned for the keys at the end.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type EffectiveState,
  PROVIDER_ERROR_CODES,
  type ProviderErrorCode,
  secretFingerprint,
} from '@qianmo/providers'
import { qianmoConfigPath } from '@qianmo/paths'
import { getModelCompatCapabilities } from '../../src/providers/capabilities.js'
import {
  applyRequest,
  CANARY_KEY,
  CANARY_KEY_2,
  model,
} from '../providers/helpers.js'
import {
  readProviderState,
  configuredProvider,
  readYaml,
  recordProviderGeneration,
} from '../../src/providers/node.js'
import { providerPaths } from '../../src/providers/store.js'
import {
  handleProviderLine,
  type NodeProviderResponse,
  type ProviderContext,
} from '../../src/commands/providerOps.js'
import { sourceLaunch, withoutRunnerKeys } from './providerSource.js'
import { RecordingStub, refusedOrigin } from './providerStub.js'

const NOW = new Date('2026-10-03T08:00:00Z')
const STUB_KEY = 'sk-test-canary-ops-stub-5Rw8Lq'

const EFFECTIVE: EffectiveState = {
  apiProvider: 'firstParty',
  wire: 'anthropic',
  model: 'vendor-model-pro',
  wireModel: 'vendor-model-pro',
  modelSettingsSlot: 'opus',
  effortOnWire: true,
  effortLevel: 'max',
  contextTokens: 200_000,
  autoCompactWindow: 200_000,
  autoCompactSource: 'auto',
}

let root: string
let config: string
let previousConfigDir: string | undefined
let previousUmask: number
let warnings: string[]
let signals: number
const responses: NodeProviderResponse[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-provider-ops-'))
  config = join(root, 'config')
  mkdirSync(join(config, 'omp', 'agent'), { mode: 0o700, recursive: true })
  chmodSync(config, 0o700)
  previousConfigDir = process.env.QIANMO_CONFIG_DIR
  process.env.QIANMO_CONFIG_DIR = config
  previousUmask = process.umask(0o022)
  warnings = []
  signals = 0
})

afterEach(() => {
  process.umask(previousUmask)
  if (previousConfigDir === undefined) delete process.env.QIANMO_CONFIG_DIR
  else process.env.QIANMO_CONFIG_DIR = previousConfigDir
  rmSync(root, { recursive: true, force: true })
})

afterAll(() => {
  // Whatever any case got back: names, hashes and fingerprints, never a key.
  const all = JSON.stringify(responses)
  expect(responses.length).toBeGreaterThan(20)
  for (const key of [CANARY_KEY, CANARY_KEY_2, STUB_KEY]) {
    expect(all).not.toContain(key)
  }
})

function context(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    node: 'beta-1',
    now: () => NOW,
    warn: line => warnings.push(line),
    effective: async () => ({ ok: true, effective: EFFECTIVE }),
    signalResident: async () => {
      signals += 1
      return 'signalled'
    },
    ...overrides,
  }
}

async function send(
  request: unknown,
  overrides: Partial<ProviderContext> = {},
): Promise<NodeProviderResponse> {
  const line = typeof request === 'string' ? request : JSON.stringify(request)
  const response = await handleProviderLine(line, context(overrides))
  responses.push(response)
  // What goes on the wire is this, serialized; it must survive the trip.
  expect(JSON.parse(JSON.stringify(response))).toEqual(response)
  return response
}

function codeOf(response: NodeProviderResponse): ProviderErrorCode | 'ok' {
  return response.ok ? 'ok' : response.code
}

let sequence = 0
function requestId(): string {
  sequence += 1
  return `01JBOPS${String(sequence).padStart(19, '0')}`
}

/** A request's wire profile, as `applyRequest` would carry it. */
function rawProfile(overrides: Record<string, unknown> = {}) {
  return applyRequest({ profile: overrides }).profile
}

function probeRequest(
  mode: string,
  profile: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    op: 'probe',
    requestId: requestId(),
    node: 'beta-1',
    profile: rawProfile(profile),
    probe: { mode },
  }
}

function statusRequest(): Record<string, unknown> {
  return { v: 1, op: 'status', requestId: requestId(), node: 'beta-1' }
}

function autocompactRequest(): Record<string, unknown> {
  return { v: 1, op: 'autocompact', requestId: requestId(), node: 'beta-1' }
}

/** Time for one CLI child started from source. */
const CHILD_TIMEOUT_MS = 60_000

/**
 * `qm provider …` children from source, in this test's config root (the
 * dispatcher hands on this process's env, `CLAUDE_CONFIG_DIR` included) and
 * with a throwaway HOME.
 */
function sourceChild(cliArgs: string[], env: NodeJS.ProcessEnv) {
  return sourceLaunch(cliArgs, {
    ...withoutRunnerKeys(env),
    NODE_ENV: 'production',
    NO_COLOR: '1',
  })
}

const settingsFile = () => join(config, 'omp', 'agent', 'config.yml')
const readEnv = () =>
  (
    JSON.parse(readFileSync(settingsFile(), 'utf8')) as {
      env?: Record<string, string>
    }
  ).env ?? {}

/** A pid that has exited: the stale case of every pid file. */
function deadPid(): number {
  const child = Bun.spawnSync([process.execPath, '-e', '0'])
  return child.pid
}

function writeResidentFile(name: string, value: unknown): void {
  const path = qianmoConfigPath('resident', name)
  mkdirSync(join(config, 'resident'), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

/** A resident that wrote its P18.3 pid file; this test process stands in. */
function residentWithPidFile(pid = process.pid): void {
  writeResidentFile('resident.pid', {
    pid,
    startedAt: NOW.toISOString(),
    nonce: 'test',
  })
}

async function commitFirst(): Promise<NodeProviderResponse> {
  const response = await send(applyRequest())
  expect(codeOf(response)).toBe('ok')
  return response
}

describe('the closed error set: one case per code', () => {
  const seen = new Set<ProviderErrorCode>()
  const expectCode = (
    response: NodeProviderResponse,
    code: ProviderErrorCode,
  ) => {
    expect(codeOf(response)).toBe(code)
    if (!response.ok) {
      expect(response.message.length).toBeGreaterThan(0)
      seen.add(code)
    }
  }

  test('bad-request: not JSON, not an object, no requestId, a missing profile', async () => {
    const notJson = await send('{"v":1,')
    expectCode(notJson, 'bad-request')
    expect(notJson.requestId).toBeNull()
    expectCode(await send('[]'), 'bad-request')
    expectCode(
      await send({ v: 1, op: 'status', requestId: 'x', node: 'beta-1' }),
      'bad-request',
    )
    const { profile: _dropped, ...noProfile } = probeRequest('auth')
    const missing = await send(noProfile)
    expectCode(missing, 'bad-request')
    expect(missing.requestId).toBe(noProfile.requestId as string)
  })

  test('version-skew: a v2 request', async () => {
    expectCode(await send({ ...statusRequest(), v: 2 }), 'version-skew')
  })

  test('unsupported-op: an op outside the four', async () => {
    expectCode(
      await send({ ...statusRequest(), op: 'restart' }),
      'unsupported-op',
    )
  })

  test('node-mismatch: a request for another node', async () => {
    expectCode(
      await send({ ...statusRequest(), node: 'beta-2' }),
      'node-mismatch',
    )
    // Without --node nothing is checked (`qm provider status` run by hand).
    expect(
      codeOf(
        await send({ ...statusRequest(), node: 'beta-2' }, { node: undefined }),
      ),
    ).toBe('ok')
  })

  test('unknown-key: a compat key outside the closed set', async () => {
    for (const key of ['PATH', 'CLAUDE_CODE_USE_OPENAI']) {
      expectCode(
        await send(applyRequest({ profile: { compat: { [key]: '1' } } })),
        'unknown-key',
      )
    }
    expect(existsSync(join(config, 'qianmo'))).toBe(false)
  })

  test('bad-value: a probe mode that does not exist', async () => {
    expectCode(await send(probeRequest('deep')), 'bad-value')
  })

  test('effort-unsendable: an explicit effort on the gemini lane', async () => {
    expectCode(
      await send(
        probeRequest('auth', {
          lane: 'gemini',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          models: [model()],
        }),
      ),
      'effort-unsendable',
    )
  })

  test('retired-model: a model past its retirement date', async () => {
    expectCode(
      await send(
        applyRequest({
          profile: { models: [model({ id: 'mimo-v2-flash' })] },
        }),
      ),
      'retired-model',
    )
  })

  test('secret-mismatch: `keep` naming a key this node does not hold', async () => {
    const keep = {
      auth: {
        scheme: 'bearer',
        keys: [{ id: 'k1', keep: secretFingerprint(CANARY_KEY_2) }],
      },
    }
    // A probe on a node that holds no key at all…
    expectCode(await send(probeRequest('auth', keep)), 'secret-mismatch')
    // …and an apply on a managed node holding a different one.
    await commitFirst()
    expectCode(
      await send(
        applyRequest({
          expect: { ownedHash: readProviderState().appliedHash },
          profile: keep,
        }),
      ),
      'secret-mismatch',
    )
  })

  test('unsupported-multi-key: two keys on custom Anthropic x-api-key endpoint', async () => {
    expectCode(
      await send(
        applyRequest({
          profile: {
            auth: {
              scheme: 'x-api-key',
              keys: [
                { id: 'k1', value: CANARY_KEY },
                { id: 'k2', value: CANARY_KEY_2 },
              ],
            },
          },
        }),
      ),
      'unsupported-multi-key',
    )
  })

  test('conflict: a managed node and an apply that expects an unmanaged one', async () => {
    await commitFirst()
    const response = await send(applyRequest())
    expectCode(response, 'conflict')
    expect(response.ok ? null : response.state?.managed).toBe(true)
  })

  test('busy: another apply holds the lock', async () => {
    mkdirSync(join(config, 'qianmo', 'provider'), {
      recursive: true,
      mode: 0o700,
    })
    writeFileSync(
      providerPaths.lock(),
      JSON.stringify({ pid: process.pid, at: 'x', nonce: 'other' }),
    )
    expectCode(await send(applyRequest()), 'busy')
  })

  test('write-failed: the commit is refused on a config root that is not 0700; the intent stays', async () => {
    writeFileSync(settingsFile(), '{"env":{"MY_TOOL_FLAG":"on"}}\n', {
      mode: 0o600,
    })
    chmodSync(config, 0o755)
    const response = await send(applyRequest())
    chmodSync(config, 0o700)
    expectCode(response, 'write-failed')
    expect(readFileSync(settingsFile(), 'utf8')).toBe(
      '{"env":{"MY_TOOL_FLAG":"on"}}\n',
    )
    expect(response.ok ? null : response.state?.pending).not.toBeNull()
  })

  test('probe-failed: a probe that does not pass, with reachable', async () => {
    const response = await send(
      probeRequest('auth', { baseUrl: await refusedOrigin() }),
    )
    expectCode(response, 'probe-failed')
    expect(response.reachable).toBe(false)
  })

  test(
    'legacy environment compaction override is ignored by native settings',
    async () => {
      await commitFirst()
      const previous = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '300000'
      try {
        const response = await send(
          { ...autocompactRequest(), value: 150000 },
          { launch: sourceChild },
        )
        expect(response).toMatchObject({
          ok: true,
          autoCompactWindow: 150000,
          source: 'settings',
        })
      } finally {
        if (previous === undefined)
          delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
        else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = previous
      }
    },
    CHILD_TIMEOUT_MS,
  )

  test('every code of the closed set has a case above', () => {
    expect([...seen].sort()).toEqual(
      PROVIDER_ERROR_CODES.filter(code => code !== 'env-override').sort(),
    )
  })
})

describe('autocompact through the dispatcher', () => {
  test(
    'read only: the node’s window and where it comes from, nothing written',
    async () => {
      await commitFirst()
      const raw =
        JSON.stringify({
          ...readYaml(settingsFile()),
          compaction: { thresholdTokens: 150000, thresholdPercent: -1 },
        }) + '\n'
      writeFileSync(settingsFile(), raw, { mode: 0o600 })
      const response = await send(autocompactRequest(), { launch: sourceChild })
      expect(response).toMatchObject({
        ok: true,
        autoCompactWindow: 150_000,
        configured: 150_000,
        source: 'settings',
      })
      expect(readFileSync(settingsFile(), 'utf8')).toBe(raw)
    },
    CHILD_TIMEOUT_MS,
  )

  test('a child that does not answer: write-failed, saying the outcome is unknown', async () => {
    const response = await send(
      { ...autocompactRequest(), value: 200_000 },
      {
        launch: (_args, env) => ({
          execPath: join(root, 'no-such-runtime'),
          args: [],
          env,
          windowsHide: false,
        }),
      },
    )
    expect(codeOf(response)).toBe('write-failed')
    expect(response.ok ? '' : response.message).toContain('是否已写入未知')
    expect(warnings).toContain('[qm provider] autocompact child: spawn-failed')
  })
})

describe('apply', () => {
  test('no resident: committed here — settings.json written, nothing pending, nobody signalled', async () => {
    writeFileSync(settingsFile(), '{"env":{"MY_TOOL_FLAG":"on"}}\n', {
      mode: 0o600,
    })
    const request = applyRequest()
    const response = await send(request)
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.requestId).toBe(request.requestId)
    expect(response.state?.managed).toBe(true)
    expect(response.state?.applied?.requestId).toBe(request.requestId)
    expect(response.state?.pending).toBeNull()
    expect(response.diffKeys?.some(k => k.endsWith('.apiKey'))).toBe(true)
    expect(configuredProvider()?.secret).toBe(CANARY_KEY)
    expect(readEnv().MY_TOOL_FLAG).toBe('on')
    expect(signals).toBe(0)
  })

  test('a stale pid file (dead pid) does not count as a resident', async () => {
    residentWithPidFile(deadPid())
    writeResidentFile('lifecycle.json', { phase: 'running', pid: deadPid() })
    const response = await send(applyRequest())
    expect(response.ok && response.state?.pending).toBeNull()
    expect(configuredProvider()?.secret).toBe(CANARY_KEY)
    expect(signals).toBe(0)
  })

  test('a running resident (pid file): left pending, resident signalled, settings.json untouched', async () => {
    residentWithPidFile()
    const request = applyRequest()
    const response = await send(request)
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.state?.pending?.requestId).toBe(request.requestId)
    expect(response.state?.resident?.running).toBe(true)
    expect(response.state?.managed).toBe(false)
    expect(existsSync(settingsFile())).toBe(false)
    expect(signals).toBe(1)
    expect(warnings).toContain('[qm provider] resident: signalled')
  })

  test('a resident older than its pid file: a live `running` lifecycle stamp counts too', async () => {
    writeResidentFile('lifecycle.json', {
      v: 1,
      phase: 'running',
      pid: process.pid,
      node: 'beta-1',
    })
    const response = await send(applyRequest())
    expect(response.ok && response.state?.pending).not.toBeNull()
    expect(response.ok && response.state?.resident?.running).toBe(true)
    expect(existsSync(settingsFile())).toBe(false)
    expect(signals).toBe(1)
  })

  test('a signal that throws is reported and the intent still stands (the 5 s poll finds it)', async () => {
    residentWithPidFile()
    const response = await send(applyRequest(), {
      signalResident: async () => {
        throw new TypeError('boom')
      },
    })
    expect(response.ok && response.state?.pending).not.toBeNull()
    expect(warnings).toContain(
      '[qm provider] resident not signalled: TypeError',
    )
  })

  test('dryRun: key names that would change, no state, nothing written', async () => {
    const response = await send(applyRequest({ dryRun: true }))
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.state).toBeUndefined()
    expect(response.diffKeys?.some(k => k.endsWith('.apiKey'))).toBe(true)
    expect(existsSync(join(config, 'qianmo', 'provider', 'pending.json'))).toBe(
      false,
    )
    expect(existsSync(settingsFile())).toBe(false)
  })
})

describe('status', () => {
  test('an untouched node: unmanaged, no resident, capabilities from the call layer, effective attached', async () => {
    const response = await send(statusRequest())
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.state?.managed).toBe(false)
    expect(response.state?.resident).toBeNull()
    expect(response.state?.capabilities).toEqual({
      ...readProviderState().capabilities,
      ...getModelCompatCapabilities(),
    })
    expect(response.effective).toEqual(EFFECTIVE)
    // Nothing was created by looking.
    expect(existsSync(join(config, 'qianmo'))).toBe(false)
  })

  test('effective that could not be computed is left out, not guessed', async () => {
    const response = await send(statusRequest(), {
      effective: async () => ({ ok: false, reason: 'timeout' }),
    })
    expect(response.ok).toBe(true)
    expect(response.ok && 'effective' in response).toBe(false)
    expect(warnings).toContain('[qm provider] effective not computed: timeout')
  })

  test('not managed, resident started with provider keys: effective left out, not computed, saying why', async () => {
    recordProviderGeneration({
      generation: 1,
      env: {
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_BASE_URL: 'https://gw.test/v1',
      },
    })
    let computed = 0
    const response = await send(statusRequest(), {
      effective: async () => {
        computed += 1
        return { ok: true, effective: EFFECTIVE }
      },
    })
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.state?.managed).toBe(false)
    expect(response.state?.inheritedProviderKeys).toEqual([
      'CLAUDE_CODE_USE_OPENAI',
      'OPENAI_BASE_URL',
    ])
    expect('effective' in response).toBe(false)
    expect(computed).toBe(0)
    expect(warnings).toContain(
      '[qm provider] effective not computed: not managed, the resident started with CLAUDE_CODE_USE_OPENAI, OPENAI_BASE_URL in its environment',
    )
  })

  test('managed, resident started with provider keys: effective still attached (the child strips them)', async () => {
    await send(applyRequest())
    recordProviderGeneration({
      generation: 2,
      env: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    const response = await send(statusRequest())
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.state?.managed).toBe(true)
    expect(response.state?.inheritedProviderKeys).toEqual([
      'CLAUDE_CODE_USE_OPENAI',
    ])
    expect(response.effective).toEqual(EFFECTIVE)
  })

  test('a resident waiting on a pending intent: generation, in-flight work and waiting turns', async () => {
    residentWithPidFile()
    recordProviderGeneration({ generation: 4, env: {} })
    const request = applyRequest()
    await send(request)
    writeResidentFile('provider-switch.json', {
      v: 1,
      pid: process.pid,
      updatedAt: NOW.toISOString(),
      waiting: {
        requestId: request.requestId,
        since: NOW.toISOString(),
        inFlight: {
          turns: 1,
          queued: 2,
          tasks: 3,
          deliveries: 0,
          polls: 1,
          admissions: 0,
        },
        alertedAt: null,
      },
      last: null,
      reconciledRequestId: null,
    })
    const response = await send(statusRequest())
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.state?.resident).toEqual({
      running: true,
      generation: 4,
      inFlight: 7,
    })
    expect(response.state?.pending?.requestId).toBe(request.requestId)
    expect(response.state?.pending?.waitingTurns).toBe(3)
  })

  test('a provider-switch.json from another (dead) resident is not believed', async () => {
    residentWithPidFile()
    const request = applyRequest()
    await send(request)
    writeResidentFile('provider-switch.json', {
      v: 1,
      pid: deadPid(),
      updatedAt: NOW.toISOString(),
      waiting: {
        requestId: request.requestId,
        since: NOW.toISOString(),
        inFlight: {
          turns: 5,
          queued: 0,
          tasks: 0,
          deliveries: 0,
          polls: 0,
          admissions: 0,
        },
        alertedAt: null,
      },
      last: null,
      reconciledRequestId: null,
    })
    const response = await send(statusRequest())
    expect(response.ok && response.state?.resident?.inFlight).toBeNull()
    expect(response.ok && response.state?.pending?.waitingTurns).toBeNull()
  })

  test('P18.18: a multi-key apply commits; status reports each key by id, never a value', async () => {
    const applied = await send(
      applyRequest({
        profile: {
          lane: 'openai-responses',
          baseUrl: 'https://api.vendor.example/v1',
          compat: {},
          models: [
            model({
              capabilities: { mode: 'family' },
              effort: { send: 'auto' },
            }),
          ],
          auth: {
            scheme: 'bearer',
            keys: [
              { id: 'k1', value: CANARY_KEY },
              { id: 'k2', value: CANARY_KEY_2 },
            ],
          },
          keySelection: 'least_used',
        },
      }),
    )
    expect(applied.ok && applied.state?.keys).toEqual([
      { id: 'k1', state: 'ok' },
      { id: 'k2', state: 'ok' },
    ])
    expect(configuredProvider()?.secret).toBe(CANARY_KEY)
    const response = await send(statusRequest())
    expect(response.ok && response.state?.capabilities.multiKey).toBe(true)
    expect(response.ok && response.state?.keys).toEqual([
      { id: 'k1', state: 'ok' },
      { id: 'k2', state: 'ok' },
    ])
    // The afterAll scan covers these responses too.
    expect(JSON.stringify(response)).not.toContain(CANARY_KEY_2)
  })

  test('a single-key node reports no keys', async () => {
    await send(applyRequest())
    const response = await send(statusRequest())
    expect(response.ok && 'keys' in (response.state ?? {})).toBe(false)
  })

  test('a resident that is not running any more: known, not running', async () => {
    writeResidentFile('lifecycle.json', {
      v: 1,
      phase: 'stopped',
      pid: deadPid(),
      node: 'beta-1',
    })
    const response = await send(statusRequest())
    expect(response.ok && response.state?.resident).toEqual({
      running: false,
      generation: null,
      inFlight: null,
    })
  })
})

describe('probe and models through the dispatcher', () => {
  test('probe auth: ok with no code; the request’s key reached the vendor stub', async () => {
    const stub = new RecordingStub()
    stub.on('GET /v1/models', () =>
      Response.json({ data: [{ id: 'vendor-model-pro' }] }),
    )
    const response = await send(
      probeRequest('auth', {
        lane: 'openai-chat',
        baseUrl: `${stub.origin}/v1`,
        auth: { scheme: 'bearer', keys: [{ id: 'k1', value: STUB_KEY }] },
        models: [
          model({
            capabilities: { mode: 'family' },
            effort: { send: 'auto' },
          }),
        ],
        compat: {},
      }),
    )
    await stub.stop()
    expect(response).toMatchObject({ ok: true, reachable: true })
    expect('code' in response).toBe(false)
    expect(stub.requests[0]?.authorization).toBe(`Bearer ${STUB_KEY}`)
  })

  test('models without a profile on an unmanaged node: bad-request, nothing fetched', async () => {
    const response = await send({
      v: 1,
      op: 'models',
      requestId: requestId(),
      node: 'beta-1',
    })
    expect(codeOf(response)).toBe('bad-request')
  })

  test('models without a profile on a managed node: the applied configuration is listed', async () => {
    const stub = new RecordingStub()
    stub.on('GET /anthropic/v1/models', () =>
      Response.json({
        data: [{ id: 'vendor-model-pro' }, { id: 'vendor-model-flash' }],
      }),
    )
    await send(
      applyRequest({ profile: { baseUrl: `${stub.origin}/anthropic` } }),
    )
    const response = await send({
      v: 1,
      op: 'models',
      requestId: requestId(),
      node: 'beta-1',
    })
    await stub.stop()
    expect(response.ok).toBe(true)
    expect(response.models).toEqual([
      { id: 'vendor-model-pro' },
      { id: 'vendor-model-flash' },
    ])
    // The applied key, read from settings.json, is what went out.
    expect(stub.requests[0]?.authorization).toBe(`Bearer ${CANARY_KEY}`)
  })
})

describe('the resident’s file names, as the resident spells them', () => {
  test('provider-switch.json, lifecycle.json and resident.pid are where the resident writes them', () => {
    const service = readFileSync(
      join(import.meta.dir, '../../src/host/resident.ts'),
      'utf8',
    )
    expect(service).toContain(
      "const PROVIDER_SWITCH_FILE = 'provider-switch.json'",
    )
    expect(service).toContain(
      "qianmoConfigPath('resident', PROVIDER_SWITCH_FILE)",
    )
    expect(service).toContain("qianmoConfigPath('resident', 'lifecycle.json')")
    const handler = readFileSync(
      join(import.meta.dir, '../../src/commands/resident.ts'),
      'utf8',
    )
    expect(handler).toContain("qianmoConfigPath('resident', 'resident.pid')")
    expect(providerPaths.residentPid()).toBe(
      qianmoConfigPath('resident', 'resident.pid'),
    )
  })
})
