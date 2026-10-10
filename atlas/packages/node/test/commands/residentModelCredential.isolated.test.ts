// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { resolve } from 'path'

const RUNNER = resolve(__dirname, 'residentModelCredential.runner.ts')

/** Exercise the real resolver in a separate process, independent of module mocks. */
describe('resident model-credential probe (isolated)', () => {
  test('runs against the real committed native configuration', async () => {
    const proc = Bun.spawn(['bun', 'test', '--timeout', '60000', RUNNER], {
      cwd: resolve(__dirname, '..', '..', '..', '..'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      throw new Error(
        `resident credential subprocess failed (exit ${code}).\n\n` +
          `${stderr}\n${stdout}`.slice(-6000),
      )
    }
    expect(code).toBe(0)
  }, 120_000)
})
