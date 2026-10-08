// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `probe` with `mode: call` (design `providers-console-m1.md` §5.5): one real
 * `-p` run of this CLI, from source, in a throwaway config root, against a
 * recording Chat Completions stub.
 *
 * The stub looks at the root while the request is in flight — that is the
 * only moment it exists — so the 0700 / 0600 modes and what the settings file
 * holds are checked where they matter; after the call the root is gone. The
 * key is an `sk-test-canary-…` string.
 */

import {
  afterAll,
  beforeAll,
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
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NodeCapabilities } from '@qianmo/providers'
import { wireProfile } from '../../../services/qianmo/providers/__tests__/helpers.js'
import { resetSettingsCache } from '../../../utils/settings/settingsCache.js'
import { callProbeRoot, probeCall } from '../providerCall.js'
import { profileTarget } from '../providerProbe.js'
import { childEnv, sourceLaunch } from './providerSource.js'
import { RecordingStub, refusedOrigin } from './providerStub.js'

const KEY = 'sk-test-canary-call-probe-3Hs9Vw1'
const OLD_KEY = 'sk-test-canary-call-node-old-6Pq2'
const CAPABILITIES: NodeCapabilities = {
  protocol: 1,
  chatEffortHonorsOverride: true,
  replayFilter: false,
  multiKey: false,
}
const TEST_TIMEOUT_MS = 180_000
const CALL_TIMEOUT_MS = 90_000

let root: string
let config: string
let previousConfigDir: string | undefined
let sequence = 0

function chatProfile(baseUrl: string) {
  return wireProfile(
    {
      id: 'call-probe',
      lane: 'openai-chat',
      baseUrl,
      auth: { scheme: 'bearer', keys: [{ id: 'k1', value: KEY }] },
      models: [
        {
          id: 'call-probe-model',
          role: 'main',
          tiers: ['opus', 'sonnet', 'haiku', 'fable'],
          capabilities: { mode: 'family' },
          effort: { send: 'auto' },
        },
      ],
      compat: {},
    },
    CAPABILITIES,
  )
}

/** A streamed Chat Completions answer of one word. */
function streamed(text: string): Response {
  const frame = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: 'stub',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'stub',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  return new Response(
    `${frame({ role: 'assistant', content: text }, null)}${frame({}, 'stop')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

async function call(
  baseUrl: string,
  requestId: string,
  timeoutMs = CALL_TIMEOUT_MS,
  launch = sourceLaunch,
) {
  const resolved = profileTarget(chatProfile(baseUrl), CAPABILITIES)
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.issue))
  return probeCall({
    requestId,
    baseUrl: resolved.target.baseUrl,
    compiled: resolved.compiled,
    timeoutMs,
    env: childEnv({ HOME: join(root, 'home'), TMPDIR: tmpdir() }),
    launch,
  })
}

function nextRequestId(): string {
  sequence += 1
  return `01JBCALL${String(sequence).padStart(18, '0')}`
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'qianmo-provider-call-')))
  config = join(root, 'config')
  mkdirSync(config, { mode: 0o700 })
  chmodSync(config, 0o700)
  mkdirSync(join(root, 'home'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  resetSettingsCache()
})

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  resetSettingsCache()
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  // The node's own settings: an unrelated key of its operators, and the key
  // of whatever it runs on now.
  writeFileSync(
    join(config, 'settings.json'),
    `${JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      modelType: 'openai',
      env: { QM_NODE_FLAG: 'on', OPENAI_API_KEY: OLD_KEY },
    })}\n`,
    { mode: 0o600 },
  )
})

describe('probe call', () => {
  test(
    'a real one-turn run in a private throwaway root, removed afterwards',
    async () => {
      const stub = new RecordingStub()
      const requestId = nextRequestId()
      const probeRoot = callProbeRoot(requestId)
      const during: {
        rootMode?: number
        settingsMode?: number
        settings?: { env?: Record<string, string>; permissions?: unknown }
      } = {}
      stub.on('POST /v1/chat/completions', async request => {
        during.rootMode = statSync(probeRoot).mode & 0o777
        const settingsPath = join(probeRoot, 'settings.json')
        during.settingsMode = statSync(settingsPath).mode & 0o777
        during.settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
        const body = (await request.json()) as { stream?: unknown }
        return body.stream === true
          ? streamed('OK')
          : Response.json({
              id: 'stub',
              object: 'chat.completion',
              created: 1,
              model: 'stub',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'OK' },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            })
      })
      const outcome = await call(`${stub.origin}/v1`, requestId)
      await stub.stop()

      expect(outcome).toEqual({
        ok: true,
        reachable: true,
        message: '可用 · 真实调用成功',
      })
      const turns = stub.requests.filter(
        r => r.method === 'POST' && r.path === '/v1/chat/completions',
      )
      expect(turns.length).toBeGreaterThanOrEqual(1)
      expect(turns[0]?.authorization).toBe(`Bearer ${KEY}`)
      expect((turns[0]?.body as { model?: unknown }).model).toBe(
        'call-probe-model',
      )
      // While it ran: private, and the node's settings with the candidate
      // laid over them — its own key gone, its unrelated settings kept.
      expect(during.rootMode).toBe(0o700)
      expect(during.settingsMode).toBe(0o600)
      expect(during.settings?.env?.OPENAI_API_KEY).toBe(KEY)
      expect(during.settings?.env?.QM_NODE_FLAG).toBe('on')
      expect(during.settings?.permissions).toEqual({ allow: ['Bash(ls:*)'] })
      expect(JSON.stringify(during.settings)).not.toContain(OLD_KEY)
      // Afterwards: gone.
      expect(existsSync(probeRoot)).toBe(false)
      expect(JSON.stringify(outcome)).not.toContain(KEY)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'a rejected key: reachable, not ok, the vendor’s words not passed on; root removed',
    async () => {
      const stub = new RecordingStub()
      const requestId = nextRequestId()
      stub.on('POST /v1/chat/completions', () =>
        Response.json(
          {
            error: {
              message: `Incorrect API key provided: ${KEY}`,
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          },
          { status: 401 },
        ),
      )
      const outcome = await call(`${stub.origin}/v1`, requestId)
      await stub.stop()
      expect(outcome.ok).toBe(false)
      expect(outcome.reachable).toBe(true)
      expect(outcome.message).toContain('凭据被拒')
      expect(outcome.httpStatus).toBe(401)
      expect(JSON.stringify(outcome)).not.toContain(KEY)
      expect(JSON.stringify(outcome)).not.toContain('Incorrect API key')
      expect(existsSync(callProbeRoot(requestId))).toBe(false)
    },
    TEST_TIMEOUT_MS,
  )

  test('an unreachable endpoint: nothing spawned, nothing spent, no root left', async () => {
    const requestId = nextRequestId()
    const outcome = await call(`${await refusedOrigin()}/v1`, requestId)
    expect(outcome).toMatchObject({ ok: false, reachable: false })
    expect(existsSync(callProbeRoot(requestId))).toBe(false)
  })

  test('a runtime that cannot be started: reported, root removed', async () => {
    const stub = new RecordingStub()
    const requestId = nextRequestId()
    const outcome = await call(
      `${stub.origin}/v1`,
      requestId,
      CALL_TIMEOUT_MS,
      (_args, env) => ({
        execPath: join(root, 'no-such-runtime'),
        args: [],
        env,
        windowsHide: false,
      }),
    )
    await stub.stop()
    expect(outcome).toEqual({
      ok: false,
      reachable: true,
      message: '节点没能启动真实调用',
    })
    expect(existsSync(callProbeRoot(requestId))).toBe(false)
  })

  test(
    'a run that overruns its deadline is killed; root removed',
    async () => {
      const stub = new RecordingStub()
      const requestId = nextRequestId()
      let release = () => {}
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      stub.on('POST /v1/chat/completions', async () => {
        await held
        return Response.json({}, { status: 500 })
      })
      const outcome = await call(`${stub.origin}/v1`, requestId, 8_000)
      release()
      await stub.stop()
      expect(outcome.ok).toBe(false)
      expect(outcome.reachable).toBe(true)
      expect(outcome.message).toContain('超时')
      expect(existsSync(callProbeRoot(requestId))).toBe(false)
    },
    TEST_TIMEOUT_MS,
  )
})
