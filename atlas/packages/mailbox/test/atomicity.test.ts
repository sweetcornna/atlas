// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, spyOn, test, vi } from 'bun:test'
import * as fs from 'node:fs/promises'
import { getInboxPath, readMailbox, writeToMailbox } from '../src/index.js'
import { message, useTempConfigDir } from './helpers.js'

useTempConfigDir()
afterEach(() => vi.restoreAllMocks())

test('readers never see a partially initialized inbox', async () => {
  const path = getInboxPath('worker', 'alpha')
  const opened = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const writeFile = fs.writeFile
  let paused = false
  spyOn(fs, 'writeFile').mockImplementation(async (target, data, options) => {
    if (
      !paused &&
      typeof target === 'string' &&
      (target === path || target.startsWith(`${path}.`))
    ) {
      paused = true
      const flag = typeof options === 'object' ? (options?.flag ?? 'w') : 'w'
      const file = await fs.open(target, flag)
      try {
        // Stop after file creation but before the first byte is written.
        opened.resolve()
        await finish.promise
        await file.writeFile(data, options)
      } finally {
        await file.close()
      }
    } else {
      await writeFile(target, data, options)
    }
  })

  const pending = writeToMailbox('worker', message('first', false), 'alpha')
  try {
    await opened.promise
    expect(await readMailbox('worker', 'alpha')).toEqual([])
  } finally {
    finish.resolve()
    await pending
  }
  expect(await readMailbox('worker', 'alpha')).toEqual([
    message('first', false),
  ])
})
