// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm provider autocompact` (D-9) from source: the base `/autocompact` write
 * into this node's `settings.json`, what `status` then reports in
 * `effective`, the two refusals, and that the value stays the node's own — an
 * `apply` of the same profile neither reports it as a conflict nor touches it.
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
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyRequest,
  CANARY_KEY,
} from '../../../services/qianmo/providers/__tests__/helpers.js'
import { AUTO_COMPACT_LIMITS } from '@qianmo/providers'
import {
  AUTO_COMPACT_WINDOW_MAX_TOKENS,
  AUTO_COMPACT_WINDOW_MIN_TOKENS,
} from '../../../services/compact/autoCompactWindowValue.js'
import { runQmProvider, type SourceRun } from './providerSource.js'

const CLI_TIMEOUT_MS = 120_000
const ENV_WINDOW = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' }

let root: string
let config: string

function qmProvider(
  args: string[],
  env: Record<string, string> = {},
  stdin: string | null = null,
): Promise<SourceRun> {
  return runQmProvider({ args, stdin, config, cwd: root, env })
}

function jsonOf(run: SourceRun): Record<string, unknown> {
  const lines = run.stdout.split('\n').filter(line => line !== '')
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0] as string) as Record<string, unknown>
}

const settingsPath = () => join(config, 'settings.json')
const settingsText = () =>
  existsSync(settingsPath()) ? readFileSync(settingsPath(), 'utf8') : null
const settings = () =>
  JSON.parse(readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>

async function status(env: Record<string, string> = {}) {
  const run = await qmProvider(['status'], env)
  expect(run.code).toBe(0)
  return jsonOf(run) as {
    state: { appliedHash: string | null; onDiskHash: string; managed: boolean }
    effective: {
      contextTokens: number
      autoCompactWindow: number
      autoCompactSource: string
    }
  }
}

beforeAll(() => {
  root = realpathSync(
    mkdtempSync(join(tmpdir(), 'qianmo-provider-autocompact-')),
  )
  config = join(root, 'config')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(config, { recursive: true, force: true })
  mkdirSync(config, { mode: 0o700 })
  chmodSync(config, 0o700)
  writeFileSync(settingsPath(), '{"env":{"MY_TOOL_FLAG":"on"}}\n', {
    mode: 0o600,
  })
})

describe('qm provider autocompact', () => {
  test(
    '150k: written to this node’s settings as 150000; status reports settings / 150000',
    async () => {
      const set = await qmProvider(['autocompact', '150k'])
      expect(set.code).toBe(0)
      expect(set.stdout).toBe('Auto-compact window set to 150k tokens\n')
      expect(settings().autoCompactWindow).toBe(150_000)
      expect(settings().env).toEqual({ MY_TOOL_FLAG: 'on' })

      const { effective } = await status()
      expect(effective.autoCompactSource).toBe('settings')
      expect(effective.autoCompactWindow).toBe(
        Math.min(150_000, effective.contextTokens),
      )
      expect(effective.contextTokens).toBeGreaterThanOrEqual(150_000)
      expect(effective.autoCompactWindow).toBe(150_000)

      const shown = await qmProvider(['autocompact', '--json'])
      expect(shown.code).toBe(0)
      expect(jsonOf(shown)).toEqual({
        ok: true,
        autoCompactWindow: 150_000,
        configured: 150_000,
        source: 'settings',
      })
      // Without --json: the base `/autocompact` panel.
      const panel = await qmProvider(['autocompact'])
      expect(panel.stdout).toContain(
        'Auto-compact window: 150k tokens (from settings)',
      )
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'auto: the key is removed; status reports auto, the model window',
    async () => {
      await qmProvider(['autocompact', '150k'])
      const reset = await qmProvider(['autocompact', 'auto', '--json'])
      expect(reset.code).toBe(0)
      expect(jsonOf(reset)).toMatchObject({ ok: true, source: 'auto' })
      expect('autoCompactWindow' in settings()).toBe(false)
      expect(settings().env).toEqual({ MY_TOOL_FLAG: 'on' })

      const { effective } = await status()
      expect(effective.autoCompactSource).toBe('auto')
      expect(effective.autoCompactWindow).toBe(effective.contextTokens)
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'values outside auto / 100k–1M are refused, exit 1, nothing written',
    async () => {
      const before = settingsText()
      for (const value of ['5k', '2m', 'lots']) {
        const json = await qmProvider(['autocompact', value, '--json'])
        expect(json.code).toBe(1)
        expect(jsonOf(json)).toMatchObject({
          ok: false,
          code: 'bad-value',
          source: 'auto',
        })
        const text = await qmProvider(['autocompact', value])
        expect(text.code).toBe(1)
        expect(text.stdout).toBe('')
        expect(text.stderr).toContain(`Couldn't parse '${value}'`)
      }
      expect(settingsText()).toBe(before)
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW set: refused, exit 1, nothing written; status reports env',
    async () => {
      const before = settingsText()
      const json = await qmProvider(
        ['autocompact', '150k', '--json'],
        ENV_WINDOW,
      )
      expect(json.code).toBe(1)
      expect(jsonOf(json)).toMatchObject({
        ok: false,
        code: 'env-override',
        configured: 300_000,
        source: 'env',
      })
      const text = await qmProvider(['autocompact', 'auto'], ENV_WINDOW)
      expect(text.code).toBe(1)
      expect(text.stderr).toContain(
        'CLAUDE_CODE_AUTO_COMPACT_WINDOW is set and takes precedence',
      )
      expect(settingsText()).toBe(before)

      const { effective } = await status(ENV_WINDOW)
      expect(effective.autoCompactSource).toBe('env')
      expect(effective.autoCompactWindow).toBe(
        Math.min(300_000, effective.contextTokens),
      )
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'usage errors exit 2 without touching settings',
    async () => {
      const before = settingsText()
      for (const args of [
        ['autocompact', '150k', '200k'],
        ['autocompact', '--force'],
      ]) {
        const run = await qmProvider(args)
        expect(run.code).toBe(2)
        expect(run.stdout).toBe('')
      }
      expect(settingsText()).toBe(before)
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'node-owned: after autocompact, an apply of the same profile is no conflict and leaves the value alone',
    async () => {
      const first = applyRequest()
      const applied = await qmProvider(
        ['serve-stdin', '--node', 'beta-1'],
        {},
        `${JSON.stringify(first)}\n`,
      )
      expect(applied.code).toBe(0)
      const appliedHash = (jsonOf(applied).state as { appliedHash: string })
        .appliedHash

      expect((await qmProvider(['autocompact', '150k'])).code).toBe(0)
      // Not drift: the managed keys hash the same.
      const drift = await status()
      expect(drift.state.managed).toBe(true)
      expect(drift.state.onDiskHash).toBe(appliedHash)

      const again = await qmProvider(
        ['serve-stdin', '--node', 'beta-1'],
        {},
        `${JSON.stringify(applyRequest({ expect: { ownedHash: appliedHash } }))}\n`,
      )
      expect(again.code).toBe(0)
      expect(jsonOf(again)).toMatchObject({ ok: true })
      expect(settings().autoCompactWindow).toBe(150_000)
      expect(
        (settings().env as Record<string, string>).ANTHROPIC_AUTH_TOKEN,
      ).toBe(CANARY_KEY)

      const { effective } = await status()
      expect(effective.autoCompactSource).toBe('settings')
      expect(effective.autoCompactWindow).toBe(
        Math.min(150_000, effective.contextTokens),
      )
      for (const run of [applied, again]) {
        expect(run.stdout).not.toContain(CANARY_KEY)
      }
    },
    CLI_TIMEOUT_MS,
  )
})

describe('the autocompact op through serve-stdin (what the hub sends over ssh)', () => {
  let sequence = 0
  function request(value?: unknown): string {
    sequence += 1
    return `${JSON.stringify({
      v: 1,
      op: 'autocompact',
      requestId: `01JBAUTOCOMPACT${String(sequence).padStart(11, '0')}`,
      node: 'beta-1',
      ...(value === undefined ? {} : { value }),
    })}\n`
  }
  const serve = (line: string, env: Record<string, string> = {}) =>
    qmProvider(['serve-stdin', '--node', 'beta-1'], env, line)

  test('the protocol’s bounds are the base’s', () => {
    expect(AUTO_COMPACT_LIMITS.minTokens).toBe(AUTO_COMPACT_WINDOW_MIN_TOKENS)
    expect(AUTO_COMPACT_LIMITS.maxTokens).toBe(AUTO_COMPACT_WINDOW_MAX_TOKENS)
  })

  test(
    'write: 150000 lands in settings.json; the response and status report settings / 150000',
    async () => {
      const run = await serve(request(150_000))
      expect(run.code).toBe(0)
      expect(jsonOf(run)).toEqual({
        v: 1,
        requestId: expect.any(String),
        ok: true,
        autoCompactWindow: 150_000,
        configured: 150_000,
        source: 'settings',
        message: 'Auto-compact window set to 150k tokens',
      })
      expect(settings().autoCompactWindow).toBe(150_000)
      expect(settings().env).toEqual({ MY_TOOL_FLAG: 'on' })
      const { effective } = await status()
      expect(effective).toMatchObject({
        autoCompactWindow: 150_000,
        autoCompactSource: 'settings',
      })

      const reset = await serve(request('auto'))
      expect(reset.code).toBe(0)
      expect(jsonOf(reset)).toMatchObject({ ok: true, source: 'auto' })
      expect('autoCompactWindow' in settings()).toBe(false)
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'read only (no value): the window and its source, settings.json byte for byte unchanged',
    async () => {
      await qmProvider(['autocompact', '150k'])
      const before = settingsText()
      const run = await serve(request())
      expect(run.code).toBe(0)
      expect(jsonOf(run)).toEqual({
        v: 1,
        requestId: expect.any(String),
        ok: true,
        autoCompactWindow: 150_000,
        configured: 150_000,
        source: 'settings',
      })
      expect(settingsText()).toBe(before)
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW set: env-override, exit 1, nothing written',
    async () => {
      const before = settingsText()
      const run = await serve(request(150_000), ENV_WINDOW)
      expect(run.code).toBe(1)
      expect(jsonOf(run)).toMatchObject({
        ok: false,
        code: 'env-override',
        configured: 300_000,
        source: 'env',
      })
      expect(settingsText()).toBe(before)
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'values the protocol does not take are refused before anything runs: 200 is not 200k here',
    async () => {
      const before = settingsText()
      for (const value of [200, '150k', 2_000_000]) {
        const run = await serve(request(value))
        expect(run.code).toBe(1)
        expect(jsonOf(run)).toMatchObject({ ok: false, code: 'bad-value' })
      }
      expect(settingsText()).toBe(before)
    },
    CLI_TIMEOUT_MS,
  )
})
