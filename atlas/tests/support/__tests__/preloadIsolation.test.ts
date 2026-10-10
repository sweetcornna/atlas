// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `atlas/tests/preload.ts` against a developer shell that carries credentials
 * and state-root overrides.
 *
 * The shell is constructed: a child `bun test` gets an env with an API key, a
 * subscription switch, a real-looking `QIANMO_CONFIG_DIR`, omp profile/agent
 * dir overrides and an XDG home. The probe test asserts what the preload must
 * leave behind. Each run is a separate process, because the preload acts once
 * per process before any test file loads.
 *
 * Positive control: the same probe without `--preload` goes red, so the green
 * is the preload's doing, not the probe's.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../../../..')
const PRELOAD = './atlas/tests/preload.ts'
const SPAWN_TIMEOUT_MS = 60_000

const PROBE = `
import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'

test('preload isolated the shell', () => {
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_AUTH_MODE', 'PI_CODING_AGENT_DIR', 'PI_CONFIG_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'QIANMO_MEMORY_DIR', 'QIANMO_OMP_ENTRY']) {
    expect({ name, value: process.env[name] }).toEqual({ name, value: undefined })
  }
  expect(process.env.QIANMO_TEST_QMCODE_BIN).toBe('/test/bin/qmcode')
  expect(process.env.QIANMO_TEST_COMPILED_QM).toBe('/test/bin/qm')
  expect(process.env.PI_TEST_RUNTIME).toBe('1')
  const root = process.env.QIANMO_CONFIG_DIR ?? ''
  expect(root.startsWith(tmpdir())).toBe(true)
  expect(root).toContain('qianmo-test-' + process.pid)
  expect((process.env.QIANMO_CA_DIR ?? '').startsWith(tmpdir())).toBe(true)
})
`

let root: string
let probe: string
let realHome: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-preload-'))
  realHome = join(root, 'home')
  probe = join(root, 'probe.test.ts')
  writeFileSync(probe, PROBE)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

async function runProbe(
  preload: boolean,
): Promise<{ exitCode: number; output: string }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  Object.assign(env, {
    QIANMO_TEST_QMCODE_BIN: '/test/bin/qmcode',
    QIANMO_TEST_COMPILED_QM: '/test/bin/qm',
    OPENAI_API_KEY: 'sk-placeholder-not-a-key',
    ANTHROPIC_API_KEY: 'sk-ant-placeholder',
    OPENAI_AUTH_MODE: 'chatgpt',
    QIANMO_CONFIG_DIR: join(realHome, '.qianmo'),
    QIANMO_MEMORY_DIR: join(realHome, '.qianmo'),
    QIANMO_OMP_ENTRY: 'self',
    PI_CODING_AGENT_DIR: join(realHome, '.omp', 'agent'),
    PI_CONFIG_DIR: '.omp',
    OMP_PROFILE: 'dev',
    PI_PROFILE: 'dev',
    XDG_CONFIG_HOME: join(realHome, '.config'),
    CLAUDE_CONFIG_DIR: join(realHome, '.claude'),
  })
  delete env.PI_TEST_RUNTIME
  const args = preload ? ['test', '--preload', PRELOAD, probe] : ['test', probe]
  const proc = Bun.spawn([process.execPath, ...args], {
    cwd: REPO_ROOT,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, output: stdout + stderr }
}

describe('atlas test preload', () => {
  test(
    'clears credentials and state roots, sets a temp config root',
    async () => {
      const result = await runProbe(true)
      expect(result.output).toContain('1 pass')
      expect(result.exitCode).toBe(0)
    },
    SPAWN_TIMEOUT_MS,
  )

  test(
    'positive control: without the preload the probe fails',
    async () => {
      const result = await runProbe(false)
      expect(result.exitCode).not.toBe(0)
    },
    SPAWN_TIMEOUT_MS,
  )
})
