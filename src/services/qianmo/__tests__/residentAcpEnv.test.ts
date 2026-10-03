// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The ACP child's environment on a managed and an unmanaged node (design
 * `providers-console-m1.md` §2.9 step 4, §7.5; P18.7).
 *
 * Unmanaged — the three fleet nodes today — is pinned byte for byte against
 * the formula this module had before P18.7, for the fleet's own shape of
 * parent environment. Managed is checked both on the object and in a real
 * child process that prints the environment it was started with.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COMPAT_KEYS } from '@qianmo/providers'
import { resetSettingsCache } from '../../../utils/settings/settingsCache.js'
import { ALL_PROFILE_ENV_KEYS } from '../../providerProfiles/envKeys.js'
import { applyRequest, CANARY_KEY } from '../providers/__tests__/helpers.js'
import {
  commitPendingProviderConfig,
  readProviderState,
  stageProviderApply,
} from '../providers/node.js'
import { residentAcpEnvironment } from '../residentAcpEnv.js'

const PROCESS_KEY = 'sk-test-canary-acp-env-process-6Vb3'

/** A fleet node's resident: its model named in the process environment. */
function fleetParent(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/node',
    LANG: 'C.UTF-8',
    OCC_CONFIG_DIR: '/srv/beta/nodes/beta-1/config',
    QIANMO_TRANSPORT_PSK: 'not-a-model-key',
    CLAUDE_CODE_USE_OPENAI: '1',
    CLAUDE_CODE_USE_BEDROCK: '0',
    OPENAI_BASE_URL: 'https://gateway.example.test/v1',
    OPENAI_API_KEY: PROCESS_KEY,
    OPENAI_MODEL: 'gpt-6-luna',
    OPENAI_WIRE_API: 'responses',
    ANTHROPIC_AUTH_TOKEN: PROCESS_KEY,
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
    CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
    API_TIMEOUT_MS: '600000',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '400000',
    CLAUDE_CODE_SUBAGENT_MODEL: 'gpt-6-luna',
  }
}

/** `residentAcpEnvironment` exactly as it was before P18.7. */
function legacyEnvironment(
  parent: NodeJS.ProcessEnv,
  options: { readonly memoryRoot?: string } = {},
): NodeJS.ProcessEnv {
  return {
    ...parent,
    OCC_IDENTITY: 'qianmo',
    CLAUDE_CODE_REMOTE_SEND_KEEPALIVES: '1',
    CLAUDE_CODE_SAFE_MODE: '1',
    ...(options.memoryRoot === undefined
      ? {}
      : { QIANMO_RESIDENT_MEMORY_ROOT: options.memoryRoot }),
  }
}

/** Every key a managed child must not inherit from its parent. */
function isProviderKey(key: string): boolean {
  return (
    ALL_PROFILE_ENV_KEYS.includes(key) ||
    (COMPAT_KEYS as readonly string[]).includes(key) ||
    key.startsWith('CLAUDE_CODE_USE_')
  )
}

let root: string
let config: string
let previousConfigDir: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-acp-env-'))
  config = join(root, 'config')
  mkdirSync(config, { mode: 0o700 })
  chmodSync(config, 0o700)
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  resetSettingsCache()
})

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  resetSettingsCache()
  rmSync(root, { recursive: true, force: true })
})

/** Make this config root managed the way production does: stage, commit. */
function manage(): void {
  const staged = stageProviderApply(applyRequest())
  if (!staged.ok) throw new Error(JSON.stringify(staged))
  expect(commitPendingProviderConfig().status).toBe('committed')
  expect(readProviderState().managed).toBe(true)
}

function writeState(content: string): void {
  const dir = join(config, 'qianmo', 'provider')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'state.json'), content, { mode: 0o600 })
}

/** The environment a real child process sees when started with `env`. */
function seenByChild(env: NodeJS.ProcessEnv): Record<string, string> {
  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      'process.stdout.write(JSON.stringify(process.env))',
    ],
    { env: env as Record<string, string>, stdout: 'pipe', stderr: 'pipe' },
  )
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString()) as Record<string, string>
}

describe('unmanaged node: byte for byte what it was before', () => {
  const cases: [string, () => void][] = [
    ['no provider state at all', () => {}],
    [
      'a state file without an applied profile (first apply ended in conflict)',
      () =>
        writeState(
          `${JSON.stringify({ v: 1, applied: null, appliedHash: null })}\n`,
        ),
    ],
    ['a state file that does not parse', () => writeState('{"v":1,')],
    [
      'a state file of another version',
      () => writeState(`${JSON.stringify({ v: 2, applied: { a: 1 } })}\n`),
    ],
  ]

  for (const [name, arrange] of cases) {
    test(name, () => {
      arrange()
      expect(readProviderState().managed).toBe(false)
      for (const options of [{}, { memoryRoot: '/srv/memory' }]) {
        for (const parent of [fleetParent(), { PATH: '/usr/bin' }, {}]) {
          expect(JSON.stringify(residentAcpEnvironment(parent, options))).toBe(
            JSON.stringify(legacyEnvironment(parent, options)),
          )
        }
      }
    })
  }

  test('a real child started with it sees exactly that environment', () => {
    const env = residentAcpEnvironment(fleetParent(), {
      memoryRoot: '/srv/memory',
    })
    const seen = seenByChild(env)
    expect(seen).toEqual(env as Record<string, string>)
    // Positive control for the managed case below: the fleet's keys do reach
    // an unmanaged child.
    expect(seen.OPENAI_API_KEY).toBe(PROCESS_KEY)
    expect(seen.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(seen.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined()
  })
})

describe('managed node', () => {
  test('the judgment is the one readProviderState() makes', () => {
    expect(readProviderState().managed).toBe(false)
    expect(residentAcpEnvironment(fleetParent()).OPENAI_API_KEY).toBe(
      PROCESS_KEY,
    )
    manage()
    expect(residentAcpEnvironment(fleetParent()).OPENAI_API_KEY).toBeUndefined()
  })

  test('no provider key, compat key or CLAUDE_CODE_USE_* switch comes from the parent', () => {
    manage()
    const parent = fleetParent()
    const before = JSON.stringify(parent)
    const env = residentAcpEnvironment(parent, { memoryRoot: '/srv/memory' })
    expect(JSON.stringify(parent)).toBe(before)
    for (const key of Object.keys(env)) {
      expect({ key, provider: isProviderKey(key) }).toEqual({
        key,
        provider: false,
      })
    }
    expect(Object.values(env)).not.toContain(PROCESS_KEY)
    expect(env).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/node',
      LANG: 'C.UTF-8',
      OCC_CONFIG_DIR: '/srv/beta/nodes/beta-1/config',
      QIANMO_TRANSPORT_PSK: 'not-a-model-key',
      // Node policy, not a provider property (§3.6 不收): kept.
      CLAUDE_CODE_SUBAGENT_MODEL: 'gpt-6-luna',
      OCC_IDENTITY: 'qianmo',
      CLAUDE_CODE_REMOTE_SEND_KEEPALIVES: '1',
      CLAUDE_CODE_SAFE_MODE: '1',
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      QIANMO_RESIDENT_MEMORY_ROOT: '/srv/memory',
    })
  })

  test('a real child started with it sees none of them', () => {
    manage()
    const parent: NodeJS.ProcessEnv = { ...fleetParent() }
    // Every key of the base's list and every compat key, not just the fleet's.
    for (const key of ALL_PROFILE_ENV_KEYS) parent[key] = `value-of-${key}`
    for (const key of COMPAT_KEYS) parent[key] = `value-of-${key}`
    parent.CLAUDE_CODE_USE_VERTEX = '1'
    parent.CLAUDE_CODE_USE_GEMINI = '1'
    const seen = seenByChild(residentAcpEnvironment(parent))
    const leaked = Object.keys(seen).filter(isProviderKey)
    expect(leaked).toEqual([])
    expect(Object.values(seen)).not.toContain(PROCESS_KEY)
    expect(seen.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1')
    expect(seen.PATH).toBe(parent.PATH as string)
    // The managed key lives in settings.json, never in the spawn env.
    expect(Object.values(seen)).not.toContain(CANARY_KEY)
  })
})
