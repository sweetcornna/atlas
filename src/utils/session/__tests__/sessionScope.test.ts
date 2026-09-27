// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Work an ACP session leaves behind stays with that session (review E-8): its
 * task notifications, and the directory its task output files go to. The
 * end-to-end cases — a real `--acp` child, a background command in one
 * session, another session's turn — are in
 * `tests/integration/qianmo-resident-bypass-corpus.test.ts`; this file pins the
 * two rules themselves, including the shapes one child cannot easily stage.
 */

import { describe, expect, test } from 'bun:test'
import { relative, resolve } from 'node:path'
import { currentSessionScope, runInSessionScope } from '../sessionScope.js'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'sessionScope.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('session scope', () => {
  test('entering a scope always opens a new boundary', () => {
    // A turn woken by the previous turn's release starts in that turn's
    // context; the scope it enters must replace it, not nest under it.
    const seen = runInSessionScope('session-a', () =>
      runInSessionScope('session-b', () => currentSessionScope()),
    )
    expect(seen).toBe('session-b')
    expect(currentSessionScope()).toBeUndefined()
  })

  test('the queue and the task output directory honour it', async () => {
    // The command queue and bootstrap state carry process-global mock.module
    // registrations in this suite, so the behaviour checks load the real
    // modules in a fresh module registry.
    const proc = Bun.spawn([process.execPath, 'test', RUNNER_REL], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      const output = `${stderr}\n${stdout}`.slice(-3000)
      throw new Error(
        `sessionScope subprocess failed (exit ${code}):\n${output}`,
      )
    }
  }, 60_000)
})
