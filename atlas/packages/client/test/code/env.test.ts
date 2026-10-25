// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The agent's environment (qmo-local.md §4.3.4): the login shell's over the
 * runner's, without 阡陌's, the shell app's or the nesting markers; the login
 * shell asked at most once per ten minutes, kept in memory only, never on
 * Windows. The login shell here is a script in a temporary folder.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loginEnvAsker, parseEnvProbe } from '../../src/computer.ts'
import {
  agentEnv,
  LOGIN_ENV_KEEP_MS,
  LoginEnvironment,
  loginEnvFor,
} from '../../src/code/env.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

const posix = process.platform !== 'win32'

describe('the agent’s environment', () => {
  test('the login shell’s over the runner’s; 阡陌’s, the app’s and the nesting markers dropped', () => {
    const env = agentEnv(
      {
        PATH: '/usr/bin',
        HOME: '/h',
        QMO_CLIENT_DIR: '/c',
        qianmo_token: 'x',
        TAURI_ENV_PLATFORM: 'darwin',
        __CFBundleIdentifier: 'app.qmo',
        XPC_SERVICE_NAME: 'app',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        KEPT: 'own',
        UNSET: undefined,
      },
      {
        PATH: '/opt/bin:/usr/bin',
        PWD: '/probe',
        SHLVL: '2',
        _: '/usr/bin/env',
        ANTHROPIC_BASE_URL: 'https://x',
      },
    )
    expect(env).toEqual({
      PATH: '/opt/bin:/usr/bin',
      HOME: '/h',
      KEPT: 'own',
      ANTHROPIC_BASE_URL: 'https://x',
    })
    expect(agentEnv({ PATH: '/usr/bin' }, null)).toEqual({ PATH: '/usr/bin' })
  })

  test('what `qmo agents` takes from it: absolute PATH folders once, the named variables set', () => {
    expect(
      loginEnvFor(
        { PATH: '/a:rel:/b:/a', CLAUDE_CONFIG_DIR: '/c', EMPTY: '' },
        ['CLAUDE_CONFIG_DIR', 'EMPTY', 'MISSING'],
      ),
    ).toEqual({ path: ['/a', '/b'], vars: { CLAUDE_CONFIG_DIR: '/c' } })
    expect(loginEnvFor(null, [])).toBeNull()
  })

  test('the probe’s answer: between the marks, NUL-separated, newlines and `=` in values kept', () => {
    expect(
      parseEnvProbe('motd\n__qmo_env__A=1\0B=x=y\nz\0__qmo_env__'),
    ).toEqual({
      A: '1',
      B: 'x=y\nz',
    })
    expect(parseEnvProbe('no marks')).toBeNull()
    expect(parseEnvProbe('__qmo_env__A=1\0')).toBeNull()
  })

  test('asked once per ten minutes, shared while asking; again after, or for another shell', async () => {
    let now = 1_000
    let asked = 0
    const env: NodeJS.ProcessEnv = { SHELL: '/bin/zsh' }
    const login = new LoginEnvironment({
      env,
      now: () => now,
      ask: async () => {
        asked++
        await Bun.sleep(5)
        return { N: String(asked) }
      },
    })
    const [first, second] = await Promise.all([login.get(), login.get()])
    expect([first, second, asked]).toEqual([{ N: '1' }, { N: '1' }, 1])
    now += LOGIN_ENV_KEEP_MS - 1
    expect(await login.get()).toEqual({ N: '1' })
    now += 1
    expect(await login.get()).toEqual({ N: '2' })
    // A failure is kept as none, for as long.
    const failing = new LoginEnvironment({
      env,
      now: () => now,
      ask: async () => Promise.reject(new Error('x')),
    })
    expect(await failing.get()).toBeNull()
  })

  test('never asked on Windows', async () => {
    const login = new LoginEnvironment({
      env: { SHELL: '/bin/sh' },
      platform: 'win32',
    })
    expect(await login.get()).toBeNull()
  })

  test.skipIf(!posix)(
    'a real probe: what the profile exports, nothing written anywhere',
    async () => {
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-env-')),
      )
      roots.push(root)
      const shell = path.join(root, 'login-shell')
      // A "login shell" whose profile exports two variables and prints a banner.
      fs.writeFileSync(
        shell,
        '#!/bin/sh\necho "welcome"\nexport FROM_PROFILE=yes\nexport MULTI="a\nb"\nexec /bin/sh -c "$2"\n',
      )
      fs.chmodSync(shell, 0o755)
      const before = fs.readdirSync(root)
      const vars = await loginEnvAsker({
        SHELL: shell,
        PATH: '/usr/bin:/bin',
        HOME: root,
      })(2_000)
      expect(vars).toMatchObject({
        FROM_PROFILE: 'yes',
        MULTI: 'a\nb',
        QMO_SHELL_PROBE: '1',
      })
      expect(fs.readdirSync(root)).toEqual(before)
    },
  )
})
