// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Thin spawner for `credentialPoolSessions.runner.ts` (P18.18 X-1 across
 * sessions). It switches sessions for real, which a whole-repo `bun test`
 * cannot guarantee once a base suite has mocked `src/bootstrap/state.ts` —
 * the reason is spelled out in
 * `src/services/qianmo/promptCache/__tests__/sessionSwitching.isolated.test.ts`.
 */
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..', '..')
const RUNNER = 'credentialPoolSessions.runner.ts'

describe('P18.18 key pool across sessions (isolated)', () => {
  test(`${RUNNER} passes in its own process`, async () => {
    const proc = Bun.spawn(
      ['bun', 'test', '--timeout', '60000', resolve(import.meta.dir, RUNNER)],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, NODE_ENV: 'test' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    if (code !== 0) {
      throw new Error(
        `${RUNNER} failed in its own process (exit ${code}).\n\n` +
          `${stderr}\n${stdout}`.slice(-6000),
      )
    }
    // bun test prints its summary on stderr; guard against a vacuous run.
    expect(`${stderr}${stdout}`).toMatch(/\b[1-9]\d* pass\b/)
    expect(`${stderr}${stdout}`).toMatch(/\b0 fail\b/)
  }, 120_000)
})
