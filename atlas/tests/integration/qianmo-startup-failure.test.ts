// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A failure while qm starts is printed and exits non-zero (P18.12, follow-up
 * F5; `atlas/packages/node/src/host/startupFailure.ts`).
 *
 * The failure that was found: a rejection out of the entry's top-level await
 * was swallowed by the global handler, so the process printed nothing and
 * never exited. A supervisor reads that silence as a run that has not
 * finished. Here the real entry (`atlas/packages/node/src/cli.ts`) is started
 * from source with arguments that make a command refuse; each run must print
 * `Error: <message>` on stderr — the error's own message, never a stack — and
 * end by itself. The watchdog turns a hang into `exitCode: null`.
 *
 * Throwaway config root and HOME; no network: every run fails before any
 * request.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startupFailureMessage } from '@qianmo/node/host/startupFailure.ts'
import { isCredentialEnvName } from '../support/credentialEnv.js'

const CLI_ENTRYPOINT = resolve(
  import.meta.dir,
  '../../packages/node/src/cli.ts',
)
/** A cold boot from source on a loaded machine; a hang is far longer. */
const SPAWN_TIMEOUT_MS = 90_000

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

async function runCli(args: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), 'qm-startup-failure-'))
  roots.push(root)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !isCredentialEnvName(key)) env[key] = value
  }
  Object.assign(env, {
    QIANMO_CONFIG_DIR: root,
    HOME: root,
    USERPROFILE: root,
    NO_COLOR: '1',
    CI: '1',
  })
  const child = Bun.spawn({
    cmd: [process.execPath, 'run', CLI_ENTRYPOINT, ...args],
    cwd: root,
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
    'a command that refuses its arguments: the message on stderr, exit 1',
    async () => {
      const run = await runCli(['watch'])
      expect({ exitCode: run.exitCode }).toEqual({ exitCode: 1 })
      expect(run.stderr).toBe('Error: watch requires --jobs\n')
      expect(run.stdout).toBe('')
    },
    SPAWN_TIMEOUT_MS + 10_000,
  )

  test(
    'an unknown command: the message points at --help, exit 2',
    async () => {
      const run = await runCli(['no-such-command'])
      expect({ exitCode: run.exitCode }).toEqual({ exitCode: 2 })
      expect(run.stderr).toContain('Error: unknown command: no-such-command')
      expect(run.stderr).toContain('qm --help')
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
