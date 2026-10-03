// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `qmcodeHome()`: the fork's state root rule, derived here (P17.4). */

import { afterEach, describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { qmcodeHome } from '../paths.js'

const saved = process.env.QMCODE_HOME

afterEach(() => {
  if (saved === undefined) delete process.env.QMCODE_HOME
  else process.env.QMCODE_HOME = saved
})

describe('qmcodeHome', () => {
  test('defaults to ~/.qmcode, like the fork', () => {
    delete process.env.QMCODE_HOME
    expect(qmcodeHome()).toBe(join(homedir(), '.qmcode'))
  })

  test('QMCODE_HOME wins, read on every call, resolved to an absolute path', () => {
    process.env.QMCODE_HOME = '/srv/qmcode-state'
    expect(qmcodeHome()).toBe('/srv/qmcode-state')
    process.env.QMCODE_HOME = 'relative/state'
    expect(qmcodeHome()).toBe(resolve('relative/state'))
  })

  test('an empty QMCODE_HOME counts as unset', () => {
    process.env.QMCODE_HOME = ''
    expect(qmcodeHome()).toBe(join(homedir(), '.qmcode'))
  })
})
