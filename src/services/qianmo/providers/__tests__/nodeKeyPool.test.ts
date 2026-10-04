// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The node's half of P18.18: a multi-key apply staged and committed through
 * the real write path (`stageProviderApply` → `commitPendingProviderConfig`)
 * in a temp config root.
 *
 * - `settings.json` gets the primary key only; every key, primary first, goes
 *   to `key-pool.json` (0600) for the call layer.
 * - `keep` finds a key that only the pool holds.
 * - Rotating or removing one key leaves its old value in no file under the
 *   config root (byte scan); a single-key apply removes the pool.
 * - `status.keys`: per key `ok` / `cooling` / `dead`, ids only, and only
 *   while `settings.json` runs on the pool.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { secretFingerprint } from '@qianmo/providers'
import { resetSettingsCache } from '../../../../utils/settings/settingsCache.js'
import {
  keyPoolPaths,
  updateKeyPoolState,
} from '../../modelCompat/credentialPoolStore.js'
import {
  commitPendingProviderConfig,
  readProviderState,
  stageProviderApply,
} from '../node.js'
import { providerPaths } from '../store.js'
import { applyRequest, model } from './helpers.js'

const KA = 'sk-test-canary-node-pool-a-Fw71Kd2Qp'
const KB = 'sk-test-canary-node-pool-b-Lz04Hs8Vn'
const KC = 'sk-test-canary-node-pool-c-Ux39Te6Rm'
const KB_NEW = 'sk-test-canary-node-pool-b2-Oc52Yj1W'

let root: string
let config: string
let previousConfigDir: string | undefined
let previousUmask: number

const mode = (path: string) => statSync(path).mode & 0o777
const settingsFile = () => join(config, 'settings.json')
const readJson = (path: string) =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-node-key-pool-'))
  config = join(root, 'config')
  mkdirSync(config, { mode: 0o700 })
  chmodSync(config, 0o700)
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  previousUmask = process.umask(0o022)
  resetSettingsCache()
})

afterEach(() => {
  process.umask(previousUmask)
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  resetSettingsCache()
  rmSync(root, { recursive: true, force: true })
})

type Key =
  | { id: string; value: string; priority?: number }
  | { id: string; keep: string; priority?: number }

function poolProfile(keys: Key[], extra: Record<string, unknown> = {}) {
  return {
    lane: 'openai-responses',
    baseUrl: 'https://api.vendor.example/v1',
    compat: {},
    models: [
      model({ capabilities: { mode: 'family' }, effort: { send: 'auto' } }),
    ],
    auth: { scheme: 'bearer', keys },
    keySelection: 'round_robin',
    ...extra,
  }
}

let clock = Date.parse('2026-10-04T08:00:00Z')

/** Stage and commit one apply; managed after the first. */
function apply(keys: Key[], extra: Record<string, unknown> = {}) {
  clock += 60_000
  const managed = readProviderState().managed
  const staged = stageProviderApply(
    applyRequest({
      profile: poolProfile(keys, extra),
      ...(managed
        ? { expect: { ownedHash: readProviderState().appliedHash } }
        : {}),
    }),
    { node: 'beta-1', now: new Date(clock) },
  )
  if (!staged.ok) throw new Error(`${staged.code}: ${staged.message}`)
  const committed = commitPendingProviderConfig({ now: new Date(clock) })
  if (committed.status !== 'committed') {
    throw new Error(JSON.stringify(committed))
  }
  return committed
}

/** Every file under the config root whose bytes contain `value`. */
function filesHolding(value: string): string[] {
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (readFileSync(path).includes(Buffer.from(value))) {
        hits.push(path.slice(config.length + 1))
      }
    }
  }
  walk(config)
  return hits.sort()
}

describe('commit: settings get the primary, the pool gets every key', () => {
  test('primary by priority; key-pool.json 0600, primary first; pending gone', () => {
    apply([
      { id: 'ka', value: KA },
      { id: 'kb', value: KB, priority: 9 },
      { id: 'kc', value: KC },
    ])
    const env = readJson(settingsFile()).env as Record<string, string>
    expect(env.OPENAI_API_KEY).toBe(KB)
    expect(JSON.stringify(readJson(settingsFile()))).not.toContain(KA)
    expect(JSON.stringify(readJson(settingsFile()))).not.toContain(KC)

    expect(mode(keyPoolPaths.pool())).toBe(0o600)
    expect(mode(join(config, 'qianmo', 'provider'))).toBe(0o700)
    const pool = readJson(keyPoolPaths.pool())
    expect(pool).toMatchObject({
      v: 1,
      selection: 'round_robin',
      envKey: 'OPENAI_API_KEY',
      keys: [
        { id: 'kb', value: KB },
        { id: 'ka', value: KA },
        { id: 'kc', value: KC },
      ],
    })
    expect(existsSync(providerPaths.pending())).toBe(false)
    // Values live in settings.json and key-pool.json, nowhere else.
    expect(filesHolding(KA)).toEqual(['qianmo/provider/key-pool.json'])
    expect(filesHolding(KB)).toEqual([
      'qianmo/provider/key-pool.json',
      'settings.json',
    ])
  })

  test('the staged intent carries the pool; a single-key intent does not', () => {
    stageProviderApply(
      applyRequest({
        profile: poolProfile([
          { id: 'ka', value: KA },
          { id: 'kb', value: KB },
        ]),
      }),
      { node: 'beta-1' },
    )
    const pending = readJson(providerPaths.pending())
    expect(mode(providerPaths.pending())).toBe(0o600)
    expect(pending.pool).toEqual({
      selection: 'round_robin',
      envKey: 'OPENAI_API_KEY',
      keys: [
        { id: 'ka', value: KA },
        { id: 'kb', value: KB },
      ],
    })
    rmSync(providerPaths.pending())
    stageProviderApply(
      applyRequest({ profile: poolProfile([{ id: 'ka', value: KA }]) }),
      { node: 'beta-1' },
    )
    expect('pool' in readJson(providerPaths.pending())).toBe(false)
  })

  test('a pending pool that does not match its patch is a bad pending file', () => {
    stageProviderApply(
      applyRequest({
        profile: poolProfile([
          { id: 'ka', value: KA },
          { id: 'kb', value: KB },
        ]),
      }),
      { node: 'beta-1' },
    )
    const pending = readJson(providerPaths.pending())
    const pool = pending.pool as { keys: { id: string; value: string }[] }
    pool.keys.reverse()
    writeFileSync(providerPaths.pending(), JSON.stringify(pending), {
      mode: 0o600,
    })
    expect(commitPendingProviderConfig().status).toBe('bad-pending')
    expect(existsSync(keyPoolPaths.pool())).toBe(false)
  })
})

describe('keep', () => {
  test('finds a key only the pool holds', () => {
    apply([
      { id: 'ka', value: KA },
      { id: 'kb', value: KB },
    ])
    apply([
      { id: 'ka', keep: secretFingerprint(KA) },
      { id: 'kb', keep: secretFingerprint(KB) },
    ])
    expect(readJson(keyPoolPaths.pool()).keys).toEqual([
      { id: 'ka', value: KA },
      { id: 'kb', value: KB },
    ])
  })

  test('a keep nothing on the node matches names the key', () => {
    apply([
      { id: 'ka', value: KA },
      { id: 'kb', value: KB },
    ])
    const result = stageProviderApply(
      applyRequest({
        profile: poolProfile([
          { id: 'ka', keep: secretFingerprint(KA) },
          { id: 'kc', keep: secretFingerprint(KC) },
        ]),
        expect: { ownedHash: readProviderState().appliedHash },
      }),
      { node: 'beta-1' },
    )
    expect(result.ok ? 'ok' : `${result.code} ${result.message}`).toBe(
      'secret-mismatch 节点上没有指纹相符的密钥 kc · 需要重新填写',
    )
  })
})

describe('rotating or removing one key leaves no trace of the old value', () => {
  test('rotate kb: the old value is in no file; kb’s cooldown is forgotten, ka’s kept', () => {
    apply([
      { id: 'ka', value: KA },
      { id: 'kb', value: KB },
    ])
    updateKeyPoolState(state => {
      for (const [id, value] of [
        ['ka', KA],
        ['kb', KB],
      ] as const) {
        state.marks[id] = {
          fp: secretFingerprint(value),
          state: 'cooling',
          until: '2099-01-01T00:00:00.000Z',
          reason: 'rate-limit',
          at: '2026-10-04T08:00:00.000Z',
        }
      }
    })
    apply([
      { id: 'ka', keep: secretFingerprint(KA) },
      { id: 'kb', value: KB_NEW },
    ])
    expect(filesHolding(KB)).toEqual([])
    expect(filesHolding(KB_NEW)).toEqual(['qianmo/provider/key-pool.json'])
    expect(readProviderState().keys).toEqual([
      {
        id: 'ka',
        state: 'cooling',
        until: '2099-01-01T00:00:00.000Z',
        reason: 'rate-limit',
      },
      { id: 'kb', state: 'ok' },
    ])
  })

  test('remove kc: the old value is in no file', () => {
    apply([
      { id: 'ka', value: KA },
      { id: 'kb', value: KB },
      { id: 'kc', value: KC },
    ])
    apply([
      { id: 'ka', keep: secretFingerprint(KA) },
      { id: 'kb', keep: secretFingerprint(KB) },
    ])
    expect(filesHolding(KC)).toEqual([])
    expect(readProviderState().keys?.map(key => key.id)).toEqual(['ka', 'kb'])
  })

  test('down to one key: the pool and its state are gone, status has no keys', () => {
    apply([
      { id: 'ka', value: KA },
      { id: 'kb', value: KB },
    ])
    updateKeyPoolState(state => {
      state.cursor = 1
    })
    apply([{ id: 'ka', keep: secretFingerprint(KA) }])
    expect(existsSync(keyPoolPaths.pool())).toBe(false)
    expect(existsSync(keyPoolPaths.state())).toBe(false)
    expect(filesHolding(KB)).toEqual([])
    expect('keys' in readProviderState()).toBe(false)
  })
})

describe('status.keys', () => {
  test('ok / cooling / dead, ids only, no value anywhere in the state', () => {
    apply([
      { id: 'ka', value: KA },
      { id: 'kb', value: KB },
      { id: 'kc', value: KC },
    ])
    updateKeyPoolState(state => {
      state.marks.kb = {
        fp: secretFingerprint(KB),
        state: 'cooling',
        until: '2099-01-01T00:00:00.000Z',
        reason: 'billing',
        status: 402,
        at: '2026-10-04T08:00:00.000Z',
      }
      state.marks.kc = {
        fp: secretFingerprint(KC),
        state: 'dead',
        reason: 'revoked',
        status: 401,
        at: '2026-10-04T08:00:00.000Z',
      }
    })
    const state = readProviderState()
    expect(state.keys).toEqual([
      { id: 'ka', state: 'ok' },
      {
        id: 'kb',
        state: 'cooling',
        until: '2099-01-01T00:00:00.000Z',
        reason: 'billing',
      },
      { id: 'kc', state: 'dead', reason: 'revoked' },
    ])
    const text = JSON.stringify(state)
    for (const value of [KA, KB, KC]) {
      expect(text).not.toContain(value)
      expect(text).not.toContain(secretFingerprint(value))
    }
  })

  test('a cooldown that has run out reads ok', () => {
    apply([
      { id: 'ka', value: KA },
      { id: 'kb', value: KB },
    ])
    updateKeyPoolState(state => {
      state.marks.ka = {
        fp: secretFingerprint(KA),
        state: 'cooling',
        until: '2000-01-01T00:00:00.000Z',
        reason: 'auth',
        at: '2000-01-01T00:00:00.000Z',
      }
    })
    expect(readProviderState().keys?.[0]).toEqual({ id: 'ka', state: 'ok' })
  })

  test('a local edit of the key in settings.json: no pool in force, no keys', () => {
    apply([
      { id: 'ka', value: KA },
      { id: 'kb', value: KB },
    ])
    const settings = readJson(settingsFile())
    ;(settings.env as Record<string, string>).OPENAI_API_KEY =
      'sk-test-canary-hand-edited'
    writeFileSync(settingsFile(), JSON.stringify(settings), { mode: 0o600 })
    expect('keys' in readProviderState()).toBe(false)
  })
})
