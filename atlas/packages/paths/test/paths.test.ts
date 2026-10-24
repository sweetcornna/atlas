// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  claudeConfigDir,
  clientStateDir,
  codexHome,
  ompChildEnv,
  ompConfigRoot,
  qianmoConfigDir,
} from '../src/index.ts'

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

describe('clientStateDir', () => {
  test('Windows uses LOCALAPPDATA with backslashes, whatever the host', () => {
    expect(
      clientStateDir(
        'win32',
        { LOCALAPPDATA: 'C:\\Users\\ymy\\AppData\\Local' },
        'C:\\Users\\ymy',
      ),
    ).toBe('C:\\Users\\ymy\\AppData\\Local\\Qmo')
    // Without the variable, or with a relative one, the profile's own folder.
    for (const env of [{}, { LOCALAPPDATA: 'AppData' }]) {
      expect(clientStateDir('win32', env, 'C:\\Users\\ymy')).toBe(
        'C:\\Users\\ymy\\AppData\\Local\\Qmo',
      )
    }
  })

  test('Linux follows an absolute XDG_CONFIG_HOME and ignores a relative one', () => {
    expect(clientStateDir('linux', {}, '/home/ymy')).toBe(
      '/home/ymy/.config/qmo',
    )
    expect(
      clientStateDir('linux', { XDG_CONFIG_HOME: '/srv/cfg' }, '/home/ymy'),
    ).toBe('/srv/cfg/qmo')
    expect(
      clientStateDir('linux', { XDG_CONFIG_HOME: 'cfg' }, '/home/ymy'),
    ).toBe('/home/ymy/.config/qmo')
  })

  test('macOS uses Application Support', () => {
    expect(clientStateDir('darwin', {}, '/Users/ymy')).toBe(
      '/Users/ymy/Library/Application Support/Qmo',
    )
  })

  test('QMO_CLIENT_DIR wins on every platform and stays out of the node root', () => {
    expect(
      clientStateDir('linux', { QMO_CLIENT_DIR: '/tmp/qmo-a' }, '/home/ymy'),
    ).toBe('/tmp/qmo-a')
    expect(
      clientStateDir('win32', { QMO_CLIENT_DIR: 'D:\\qmo' }, 'C:\\Users\\ymy'),
    ).toBe('D:\\qmo')
    for (const platform of ['linux', 'darwin', 'win32'] as const)
      expect(clientStateDir(platform, {}, '/home/ymy')).not.toContain('.qianmo')
  })

  test('a relative QMO_CLIENT_DIR is refused, naming the variable', () => {
    for (const [platform, dir] of [
      ['linux', 'qmo-a'],
      ['darwin', './qmo-a'],
      ['win32', 'qmo'],
      // A drive without a root is relative to that drive's current directory.
      ['win32', 'D:qmo'],
    ] as const)
      expect(() =>
        clientStateDir(platform, { QMO_CLIENT_DIR: dir }, '/home/ymy'),
      ).toThrow(/QMO_CLIENT_DIR must be an absolute path/)
    // An empty value is the same as none.
    expect(clientStateDir('linux', { QMO_CLIENT_DIR: '' }, '/home/ymy')).toBe(
      '/home/ymy/.config/qmo',
    )
  })
})

describe('third-party agent roots, located for another environment', () => {
  test('CLAUDE_CONFIG_DIR and CODEX_HOME win over the home defaults', () => {
    expect(claudeConfigDir({}, '/home/ymy')).toBe('/home/ymy/.claude')
    expect(
      claudeConfigDir({ CLAUDE_CONFIG_DIR: '/srv/claude' }, '/home/ymy'),
    ).toBe('/srv/claude')
    expect(codexHome({}, '/home/ymy')).toBe('/home/ymy/.codex')
    expect(codexHome({ CODEX_HOME: '/srv/codex' }, '/home/ymy')).toBe(
      '/srv/codex',
    )
    // An empty value is the same as none.
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '' }, '/home/ymy')).toBe(
      '/home/ymy/.claude',
    )
  })
})

describe('ompChildEnv', () => {
  test('strips mixed-case redirects before setting canonical isolated paths', () => {
    const base = {
      HOME: '/tmp/child-home',
      QIANMO_CONFIG_DIR: '/srv/node-state',
      pi_config_dir: '.unrelated',
      Pi_Natives_Dir: '/unrelated/natives',
      pi_coding_agent_dir: '/unrelated/agent',
      Omp_Profile: 'unrelated',
      xdg_config_home: '/unrelated',
      Claude_Config_Dir: '/unrelated',
      Bun_Runtime_Transpiler_Cache_Path: '/unrelated/bun',
      KEEP: '1',
    }
    const child = ompChildEnv(base)
    expect(Object.keys(child).sort()).toEqual([
      'BUN_RUNTIME_TRANSPILER_CACHE_PATH',
      'HOME',
      'KEEP',
      'PI_CONFIG_DIR',
      'PI_NATIVES_DIR',
      'QIANMO_CONFIG_DIR',
    ])
    expect(join(base.HOME, child.PI_CONFIG_DIR!)).toBe('/srv/node-state/omp')
    expect(child.PI_NATIVES_DIR).toBe('/srv/node-state/omp/natives')
    // Bun's transpiler cache stays under the omp root, not the OS cache in HOME.
    expect(child.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe(
      '/srv/node-state/omp/cache/bun',
    )
    expect(base.pi_config_dir).toBe('.unrelated')
  })
  test('PI_CONFIG_DIR joined onto homedir lands on the omp root, even outside home', () => {
    process.env.QIANMO_CONFIG_DIR = '/tmp/qianmo-node-x'
    const env = ompChildEnv({ ...process.env, PATH: '/bin' })
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
    expect(Object.keys(env).sort()).toEqual([
      'BUN_RUNTIME_TRANSPILER_CACHE_PATH',
      'KEEP',
      'PI_CONFIG_DIR',
      'PI_NATIVES_DIR',
    ])
  })
})

test('ompChildEnv derives both isolation roots from its argument and overrides unsafe PI paths', () => {
  process.env.QIANMO_CONFIG_DIR = '/tmp/parent-qianmo'
  const base = {
    HOME: '/tmp/child-home',
    QIANMO_CONFIG_DIR: '/srv/child-state',
    PI_CONFIG_DIR: '.omp',
    PI_NATIVES_DIR: '/unrelated/natives',
    PI_CODING_AGENT_DIR: '/unrelated/agent',
  }
  const child = ompChildEnv(base)
  expect(join(base.HOME, child.PI_CONFIG_DIR!)).toBe('/srv/child-state/omp')
  expect(child.PI_NATIVES_DIR).toBe('/srv/child-state/omp/natives')
  expect(child.PI_CODING_AGENT_DIR).toBeUndefined()
  expect(base.PI_CONFIG_DIR).toBe('.omp')
  const defaults = ompChildEnv({ HOME: '/tmp/another-home' })
  expect(join('/tmp/another-home', defaults.PI_CONFIG_DIR!)).toBe(
    '/tmp/another-home/.qianmo/omp',
  )
})
