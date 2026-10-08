// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The parent half of the `effective` entry (`effectiveProcess.ts`): which
 * environment the child gets, how its line is read back, and what happens
 * when it does not come.
 *
 * The child here is P18.2's runner (it prints the same marked line the CLI's
 * `provider __effective` prints), so this file does not depend on the CLI;
 * `qm provider status` from source covers the real child.
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
import type { CliLaunchSpec } from '../../../../utils/process/cliLaunch.js'
import { resetSettingsCache } from '../../../../utils/settings/settingsCache.js'
import { computeEffectiveInChild } from '../effectiveProcess.js'
import { CANARY_KEY } from './helpers.js'

const RUNNER = join(import.meta.dir, 'fixtures', 'effective-state.runner.ts')
const PROCESS_KEY = 'sk-test-canary-effective-process-8Jt4'

let root: string
let config: string
let previousConfigDir: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-effective-process-'))
  config = join(root, 'config')
  mkdirSync(config, { mode: 0o700 })
  chmodSync(config, 0o700)
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  resetSettingsCache()
  // An Anthropic-lane node: what the managed settings say.
  writeFileSync(
    join(config, 'settings.json'),
    `${JSON.stringify({
      modelType: 'anthropic',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.vendor.example/anthropic',
        ANTHROPIC_AUTH_TOKEN: CANARY_KEY,
        ANTHROPIC_MODEL: 'vendor-model-pro',
      },
    })}\n`,
    { mode: 0o600 },
  )
})

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  resetSettingsCache()
  rmSync(root, { recursive: true, force: true })
})

/** The environment `qm provider` might have been started with. */
function callerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  delete env.OCC_CONFIG_DIR
  env.CLAUDE_CONFIG_DIR = config
  env.HOME = root
  // The fleet's way of naming a model, which settings must win over.
  env.CLAUDE_CODE_USE_OPENAI = '1'
  env.OPENAI_BASE_URL = 'https://process-env.example/v1'
  env.OPENAI_API_KEY = PROCESS_KEY
  env.OPENAI_MODEL = 'process-env-model'
  return env
}

/** P18.2's runner in place of `provider __effective`. */
function runnerLaunch(
  cliArgs: string[],
  env: NodeJS.ProcessEnv,
): CliLaunchSpec {
  expect(cliArgs).toEqual(['provider', '__effective'])
  return {
    execPath: process.execPath,
    args: ['run', RUNNER],
    env,
    windowsHide: false,
  }
}

describe('computeEffectiveInChild', () => {
  test('the child starts without the caller’s provider keys, so settings decide', async () => {
    const outcome = await computeEffectiveInChild({
      timeoutMs: 60_000,
      env: callerEnv(),
      launch: runnerLaunch,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.effective.apiProvider).toBe('firstParty')
    expect(outcome.effective.model).toBe('vendor-model-pro')
    expect(JSON.stringify(outcome)).not.toContain(CANARY_KEY)
    expect(JSON.stringify(outcome)).not.toContain(PROCESS_KEY)
  }, 90_000)

  test('positive control: the same child with the caller’s env unstripped follows the env', async () => {
    const child = Bun.spawnSync([process.execPath, 'run', RUNNER], {
      cwd: root,
      env: callerEnv() as Record<string, string>,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const line = child.stdout
      .toString()
      .split('\n')
      .find(text => text.startsWith('QIANMO_EFFECTIVE '))
    expect(line).toBeDefined()
    const state = JSON.parse(
      (line as string).slice('QIANMO_EFFECTIVE '.length),
    ) as { apiProvider: string }
    expect(state.apiProvider).toBe('openai')
  }, 90_000)

  test('a child that overruns the deadline is killed and reported', async () => {
    const started = Date.now()
    const outcome = await computeEffectiveInChild({
      timeoutMs: 300,
      launch: (_args, env) => ({
        execPath: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 30000)'],
        env,
        windowsHide: false,
      }),
    })
    expect(outcome).toEqual({ ok: false, reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test('a child that prints no marked line is reported, not guessed', async () => {
    const outcome = await computeEffectiveInChild({
      timeoutMs: 30_000,
      launch: (_args, env) => ({
        execPath: process.execPath,
        args: [
          '-e',
          'console.log("QIANMO_EFFECTIVE {not json"); process.exit(3)',
        ],
        env,
        windowsHide: false,
      }),
    })
    expect(outcome).toEqual({ ok: false, reason: 'no-result' })
  })

  test('a child that cannot be started is reported', async () => {
    const outcome = await computeEffectiveInChild({
      timeoutMs: 30_000,
      launch: (_args, env) => ({
        execPath: join(root, 'no-such-runtime'),
        args: [],
        env,
        windowsHide: false,
      }),
    })
    expect(outcome).toEqual({ ok: false, reason: 'spawn-failed' })
  })
})
