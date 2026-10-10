// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, spyOn, test } from 'bun:test'
import { resolve } from 'node:path'
import { compileCodingAgent } from '../../../packages/coding-agent/scripts/compile-binary'

test('an explicit runtime template must retain the cross-compilation target', async () => {
  const reachedCompiler = new Error('compiler options captured')
  let config: Bun.BuildConfig | undefined
  const build = spyOn(Bun, 'build').mockImplementation(async options => {
    config = options
    throw reachedCompiler
  })
  try {
    await expect(
      compileCodingAgent({
        repoRoot: resolve(import.meta.dir, '../../..'),
        entrypoint: import.meta.filename,
        outfile: '/unused-cross-target-probe',
        transformersVersion: '0.0.0-probe',
        native: null,
        target: 'bun-linux-x64-baseline',
        executablePath: '/private/runtime/bun-linux-x64',
      }),
    ).rejects.toBe(reachedCompiler)
    expect(config?.compile).toMatchObject({
      target: 'bun-linux-x64-baseline',
      executablePath: '/private/runtime/bun-linux-x64',
      autoloadBunfig: false,
      autoloadDotenv: false,
    })
  } finally {
    build.mockRestore()
  }
})
