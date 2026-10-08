// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.18 completion standard 1, compile and write half: a single-key profile
 * compiles, stages and commits to the same bytes it did when P18.12 merged
 * (`df8531dc`). The request half is
 * `modelCompat/__tests__/singleKeyRequestRegression.test.ts`.
 *
 * The golden (`fixtures/single-key-golden.df8531dc.json`) was written by this
 * file running on `df8531dc` itself, before any P18.18 change, with
 * `P18_18_WRITE_GOLDEN=1`. Every later run compares against it byte for byte:
 * every preset's compiled patch, and for three apply scenarios the exact text
 * of `pending.json`, `settings.json`, `state.json` and the first-write backup,
 * plus what stage and commit returned (the compiled patches are stored as the
 * SHA-256 of their JSON text). Anything P18.18 changes on the
 * single-key path turns this red; that is the positive control.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ApplyRequest,
  type NodeCapabilities,
  PRESETS,
  secretFingerprint,
} from '@qianmo/providers'
import { resetSettingsCache } from '../../../../utils/settings/settingsCache.js'
import { compileProfile } from '../compile.js'
import { commitPendingProviderConfig, stageProviderApply } from '../node.js'
import { providerPaths } from '../store.js'
import { CANARY_KEY, CANARY_KEY_2, model, presetProfile } from './helpers.js'

const GOLDEN = join(
  import.meta.dir,
  'fixtures',
  'single-key-golden.df8531dc.json',
)
const WRITE = process.env.P18_18_WRITE_GOLDEN === '1'

/** Both capability sets a node of this line has reported; compile reads two flags. */
const CAPABILITY_SETS: Record<string, NodeCapabilities> = {
  v1: {
    protocol: 1,
    chatEffortHonorsOverride: false,
    replayFilter: false,
    multiKey: false,
  },
  current: {
    protocol: 1,
    chatEffortHonorsOverride: true,
    replayFilter: true,
    multiKey: false,
  },
}

/** `undefined` (a deletion in a patch) as `null`, so it survives JSON. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry === undefined ? null : entry,
  )
}

/**
 * Each compiled result as the SHA-256 of its exact JSON text: byte-exact like
 * the text itself, without carrying ~100 deletions per preset in the fixture.
 */
function compileGolden(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const preset of PRESETS) {
    for (const [label, capabilities] of Object.entries(CAPABILITY_SETS)) {
      const compiled = stable(
        compileProfile(presetProfile(preset), {
          secret: CANARY_KEY,
          capabilities,
        }),
      )
      out[`${preset.id}@${label}`] =
        `sha256:${createHash('sha256').update(compiled, 'utf8').digest('hex')}`
    }
  }
  return out
}

// ─── apply scenarios ─────────────────────────────────────────────────────────

const STAGED_AT = new Date('2026-10-03T08:00:00Z')
const COMMITTED_AT = new Date('2026-10-03T08:00:05Z')

function request(
  requestId: string,
  profile: Record<string, unknown>,
  ownedHash: string | null,
): ApplyRequest {
  return {
    v: 1,
    op: 'apply',
    requestId,
    node: 'beta-1',
    expect: { ownedHash },
    recycle: { sessions: 'reset' },
    dryRun: false,
    force: false,
    profile: profile as unknown as ApplyRequest['profile'],
  }
}

/** The fleet's profile today (design §0.2): gpt-6-luna on Responses, max. */
const FLEET = {
  id: 'luna',
  revision: 4,
  lane: 'openai-responses',
  baseUrl: 'https://gateway.vendor.example/v1',
  auth: { scheme: 'bearer', keys: [{ id: 'k1', value: CANARY_KEY }] },
  models: [
    model({
      id: 'gpt-6-luna',
      capabilities: {
        mode: 'explicit',
        thinking: false,
        adaptive_thinking: false,
        interleaved_thinking: false,
      },
      effort: {
        send: 'always',
        levels: ['low', 'medium', 'high', 'max'],
        level: 'max',
      },
    }),
  ],
  effortLock: 'max',
}

const ANTHROPIC = {
  id: 'vendor-paygo',
  revision: 3,
  lane: 'anthropic',
  baseUrl: 'https://api.vendor.example/anthropic',
  auth: { scheme: 'bearer', keys: [{ id: 'k1', value: CANARY_KEY_2 }] },
  models: [
    model(),
    model({ id: 'vendor-model-flash', role: 'fast', tiers: ['haiku'] }),
  ],
  compat: {
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    API_TIMEOUT_MS: '600000',
  },
}

let root: string
let config: string
let previousConfigDir: string | undefined
let previousUmask: number

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-single-key-golden-'))
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

const text = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Stage then commit one request; every file and result, as text. */
function applyOnce(req: ApplyRequest): Record<string, string | null> {
  const staged = stageProviderApply(req, { node: 'beta-1', now: STAGED_AT })
  const pending = text(providerPaths.pending())
  const committed = commitPendingProviderConfig({ now: COMMITTED_AT })
  return {
    staged: stable(staged),
    pending,
    committed: stable(committed),
    settings: text(join(config, 'settings.json')),
    state: text(providerPaths.state()),
    firstWrite: text(providerPaths.firstWrite()),
  }
}

function writeGolden(): Record<string, Record<string, string | null>> {
  const out: Record<string, Record<string, string | null>> = {}
  // 1. A fresh node: no settings.json at all.
  out.fleetFresh = applyOnce(request('01JBGOLDEN000000000000001', FLEET, null))
  return out
}

function seededGolden(): Record<string, Record<string, string | null>> {
  // 2. A node somebody already uses, then 3. a second apply that keeps the
  // key by fingerprint and changes the model.
  writeFileSync(
    join(config, 'settings.json'),
    `${JSON.stringify(
      {
        permissions: { allow: ['Bash(ls:*)'] },
        env: { MY_TOOL_FLAG: 'on', OPENAI_BASE_URL: 'https://old.example/v1' },
      },
      null,
      2,
    )}\n`,
    { mode: 0o644 },
  )
  const first = applyOnce(request('01JBGOLDEN000000000000002', ANTHROPIC, null))
  const state = JSON.parse(first.state ?? '{}') as { appliedHash?: string }
  const second = applyOnce(
    request(
      '01JBGOLDEN000000000000003',
      {
        ...ANTHROPIC,
        revision: 4,
        auth: {
          scheme: 'bearer',
          keys: [{ id: 'k1', keep: secretFingerprint(CANARY_KEY_2) }],
        },
        models: [model({ id: 'vendor-model-max' })],
      },
      state.appliedHash ?? null,
    ),
  )
  return { anthropicSeeded: first, anthropicKeep: second }
}

type Golden = {
  generatedOn: string
  compile: Record<string, string>
  apply: Record<string, Record<string, string | null>>
}

function loadGolden(): Golden {
  return JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden
}

describe('single-key profiles: byte-identical to df8531dc (compile and write)', () => {
  if (WRITE) {
    test('write the golden (P18_18_WRITE_GOLDEN=1, on df8531dc only)', () => {
      const apply = { ...writeGolden() }
      // The seeded scenarios need a clean config root of their own.
      rmSync(config, { recursive: true, force: true })
      mkdirSync(config, { mode: 0o700 })
      chmodSync(config, 0o700)
      resetSettingsCache()
      Object.assign(apply, seededGolden())
      const golden: Golden = {
        generatedOn: 'df8531dc',
        compile: compileGolden(),
        apply,
      }
      writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 2)}\n`)
    })
    return
  }

  test('every preset compiles to the golden patch, under both capability sets', () => {
    const golden = loadGolden()
    const now = compileGolden()
    expect(Object.keys(now).sort()).toEqual(Object.keys(golden.compile).sort())
    for (const [key, value] of Object.entries(now)) {
      expect({ key, value }).toEqual({ key, value: golden.compile[key] })
    }
  })

  test('a fresh node: pending, settings, state and first-write are the golden bytes', () => {
    const golden = loadGolden()
    const now = writeGolden()
    for (const [file, value] of Object.entries(now.fleetFresh ?? {})) {
      expect({ file, value }).toEqual({
        file,
        value: golden.apply.fleetFresh?.[file] ?? null,
      })
    }
  })

  test('a used node, then a keep-by-fingerprint re-apply: the golden bytes', () => {
    const golden = loadGolden()
    const now = seededGolden()
    for (const scenario of ['anthropicSeeded', 'anthropicKeep'] as const) {
      for (const [file, value] of Object.entries(now[scenario] ?? {})) {
        expect({ scenario, file, value }).toEqual({
          scenario,
          file,
          value: golden.apply[scenario]?.[file] ?? null,
        })
      }
    }
  })
})
