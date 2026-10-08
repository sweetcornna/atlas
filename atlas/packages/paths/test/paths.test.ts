// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ompChildEnv, ompConfigRoot, qianmoConfigDir } from '../src/index.ts'

const saved = process.env.QIANMO_CONFIG_DIR

afterEach(() => {
  if (saved === undefined) delete process.env.QIANMO_CONFIG_DIR
  else process.env.QIANMO_CONFIG_DIR = saved
})

describe('qianmoConfigDir', () => {
  test('defaults to ~/.qianmo and follows QIANMO_CONFIG_DIR on every call', () => {
    delete process.env.QIANMO_CONFIG_DIR
    expect(qianmoConfigDir()).toBe(join(homedir(), '.qianmo'))
    process.env.QIANMO_CONFIG_DIR = '/srv/node-a'
    expect(qianmoConfigDir()).toBe('/srv/node-a')
  })
})

describe('ompChildEnv', () => {
  test('PI_CONFIG_DIR joined onto homedir lands on the omp root, even outside home', () => {
    process.env.QIANMO_CONFIG_DIR = '/tmp/qianmo-node-x'
    const env = ompChildEnv({ PATH: '/bin' })
    // omp resolves PI_CONFIG_DIR as path.join(homedir(), value).
    expect(join(homedir(), env.PI_CONFIG_DIR as string)).toBe(ompConfigRoot())
    expect(env.PI_NATIVES_DIR).toBe('/tmp/qianmo-node-x/omp/natives')
    expect(env.PATH).toBe('/bin')
  })

  test('strips variables that would move omp state out of the root', () => {
    const env = ompChildEnv({
      OMP_PROFILE: 'work',
      PI_PROFILE: 'work',
      PI_CODING_AGENT_DIR: '/elsewhere',
      XDG_DATA_HOME: '/xdg',
      CLAUDE_CONFIG_DIR: '/claude',
      KEEP: '1',
    })
    expect(Object.keys(env).sort()).toEqual(['KEEP', 'PI_CONFIG_DIR', 'PI_NATIVES_DIR'])
  })
})
