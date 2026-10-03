// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Thin spawner for the P18.19 suites that switch sessions for real
 * (`sessionPromptContext.runner.ts`: CH-1, T-4's compaction case;
 * `stickyRouting.runner.ts`: T-5).
 *
 * Several base suites install `mock.module('src/bootstrap/state.ts',
 * stateMockWith({ getSessionId: … }))` and never reset it (the landmine note
 * in tests/mocks/state.ts). Bun runs a whole-repo `bun test` in one process,
 * so once such a file has run, `getSessionId()` no longer follows
 * `switchSession()` and these suites fail — while each passes alone and in
 * CI's per-directory shards. Re-installing the shared state mock does not
 * undo it (its delegates read the already-mocked namespace). A process of
 * their own does, the same way `queryModelOpenAI.isolated.test.ts` contains
 * its mocks.
 */
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..', '..')
const RUNNERS = ['sessionPromptContext.runner.ts', 'stickyRouting.runner.ts']

describe('P18.19 session-switching suites (isolated)', () => {
  for (const runner of RUNNERS) {
    test(`${runner} passes in its own process`, async () => {
      const proc = Bun.spawn(
        ['bun', 'test', '--timeout', '60000', resolve(import.meta.dir, runner)],
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
          `${runner} failed in its own process (exit ${code}).\n\n` +
            `${stderr}\n${stdout}`.slice(-6000),
        )
      }
      // bun test prints its summary on stderr; guard against a vacuous run.
      expect(`${stderr}${stdout}`).toMatch(/\b[1-9]\d* pass\b/)
      expect(`${stderr}${stdout}`).toMatch(/\b0 fail\b/)
    }, 120_000)
  }
})
