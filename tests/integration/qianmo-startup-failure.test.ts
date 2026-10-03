// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A failure while the CLI starts is printed and exits non-zero (P18.12,
 * follow-up F5; `src/services/qianmo/startupFailure.ts`).
 *
 * The case is the one that was found: `CI=1`, no Anthropic credential, `-p`.
 * The `/login` command's availability check reads the Anthropic key, and
 * under `CI` that lookup throws when there is none. Before: the rejection out
 * of the top-level `await main()` was swallowed by the global handler, and
 * the process printed nothing and never exited (measured: still alive at
 * 45 s, SIGKILLed). The watchdog below turns a hang into `exitCode: null`.
 *
 * Run from source the way `cli-golden.test.ts` runs it: the shipped `MACRO`
 * defines, no `feature()` flags, the repository root as cwd, a throwaway
 * config root and HOME. No network: the run fails before any request.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { macroDefineArgs } from '../../scripts/defines.js'
import { startupFailureMessage } from '../../src/services/qianmo/startupFailure.js'
import { isCredentialEnvName } from '../support/credentialEnv.js'

const PROJECT_ROOT = resolve(import.meta.dir, '../..')
const CLI_ENTRYPOINT = 'src/entrypoints/cli.tsx'
/** A cold boot from source on a loaded machine; a hang is far longer. */
const SPAWN_TIMEOUT_MS = 90_000

const root = mkdtempSync(join(tmpdir(), 'qianmo-startup-failure-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

type Run = { exitCode: number | null; stdout: string; stderr: string }

async function runCli(args: string[]): Promise<Run> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !isCredentialEnvName(key)) env[key] = value
  }
  delete env.USER_TYPE
  delete env.CLAUDE_CODE_FORCE_INTERACTIVE
  Object.assign(env, {
    OCC_CONFIG_DIR: root,
    CLAUDE_CONFIG_DIR: root,
    HOME: root,
    USERPROFILE: root,
    NO_COLOR: '1',
    CI: '1',
    NODE_ENV: '',
  })
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      'run',
      ...macroDefineArgs(),
      CLI_ENTRYPOINT,
      ...args,
    ],
    cwd: PROJECT_ROOT,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  })
  const watchdog = setTimeout(() => child.kill(9), SPAWN_TIMEOUT_MS)
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await child.exited
    return {
      exitCode: child.signalCode === null ? child.exitCode : null,
      stdout,
      stderr,
    }
  } finally {
    clearTimeout(watchdog)
  }
}

describe('startup failure', () => {
  test(
    '-p with CI=1 and no Anthropic key: the message on stderr, exit 1',
    async () => {
      const run = await runCli(['-p', 'hello'])
      expect({ exitCode: run.exitCode }).toEqual({ exitCode: 1 })
      expect(run.stderr).toContain(
        'Error: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN env var is required',
      )
      expect(run.stdout).toBe('')
    },
    SPAWN_TIMEOUT_MS + 10_000,
  )

  test('the message is the error’s own, never a stack', () => {
    expect(startupFailureMessage(new Error('no key'))).toBe('Error: no key')
    expect(startupFailureMessage('plain')).toBe('Error: plain')
    expect(startupFailureMessage(undefined)).toBe('Error: unknown error')
  })
})
