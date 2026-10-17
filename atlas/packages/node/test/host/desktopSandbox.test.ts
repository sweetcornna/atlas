// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  DESKTOP_BWRAP_PROBE,
  desktopMemory,
  desktopSandboxArgv,
  desktopSandboxEnv,
  desktopScopeArgv,
} from '../../src/host/desktopSandbox.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
/** macOS resolves /var to /private/var; Linux leaves it. */
function real(file: string): string {
  try {
    return fs.realpathSync(file)
  } catch {
    return file
  }
}
/** The `--flag a b` triples / pairs of an argv, in order. */
function mounts(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length && argv[i] !== '--'; i++) {
    const flag = argv[i]!
    if (['--bind', '--ro-bind', '--ro-bind-try'].includes(flag))
      out.push(`${flag} ${argv[++i]} ${argv[++i]}`)
    else if (['--tmpfs', '--dev', '--proc'].includes(flag))
      out.push(`${flag} ${argv[++i]}`)
  }
  return out
}

test('sandbox argv: read-only root, private /tmp, hidden roots before the desktop comes back', () => {
  // Paths need not exist: `exists` decides, and realpath falls back to resolve.
  const present = new Set([
    '/home/node',
    '/home/node/.qianmo',
    '/srv/qianmo-ca',
    '/srv/protected',
    '/srv/work',
    '/srv/work/secrets',
    '/var/tmp',
    '/run/user',
    '/run/docker.sock',
  ])
  const home = '/home/node/.qianmo/qianmo/desktop/main/home'
  const argv = desktopSandboxArgv(
    {
      home,
      writable: [home, '/home/node/.qianmo/qianmo/desktop/main/downloads'],
      readOnly: ['/home/node/.qianmo/qianmo/desktop/main/Xauthority'],
      hidden: [
        '/home/node/.qianmo',
        '/home/node',
        '/home/node/.claude',
        '/srv/qianmo-ca',
        '/srv/protected',
        '/srv/work/secrets',
        '/srv/absent',
      ],
      workspace: { path: '/srv/work', writable: false },
      env: { HOME: home, DISPLAY: ':27' },
    },
    ['openbox'],
    file => present.has(file),
  )
  expect(argv.slice(0, 5)).toEqual([
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--die-with-parent',
    '--new-session',
  ])
  expect(argv).not.toContain('--unshare-net')
  expect(mounts(argv)).toEqual([
    '--ro-bind / /',
    '--dev /dev',
    '--proc /proc',
    '--tmpfs /tmp',
    '--ro-bind-try /tmp/.X11-unix /tmp/.X11-unix',
    `--tmpfs ${real('/var/tmp')}`,
    '--tmpfs /run/user',
    // The node home covers everything under it; absent roots are skipped.
    '--tmpfs /home/node',
    '--tmpfs /srv/protected',
    '--tmpfs /srv/qianmo-ca',
    '--tmpfs /srv/work/secrets',
    '--ro-bind /dev/null /run/docker.sock',
    '--ro-bind /srv/work /srv/work',
    // A hidden root inside the workspace is hidden again after it.
    '--tmpfs /srv/work/secrets',
    `--bind ${home} ${home}`,
    '--bind /home/node/.qianmo/qianmo/desktop/main/downloads /home/node/.qianmo/qianmo/desktop/main/downloads',
    '--ro-bind /home/node/.qianmo/qianmo/desktop/main/Xauthority /home/node/.qianmo/qianmo/desktop/main/Xauthority',
  ])
  const tail = argv.slice(argv.indexOf('--clearenv'))
  expect(tail).toEqual([
    '--clearenv',
    '--setenv',
    'HOME',
    home,
    '--setenv',
    'DISPLAY',
    ':27',
    '--chdir',
    home,
    '--',
    'openbox',
  ])
  const writable = desktopSandboxArgv(
    {
      home,
      writable: [],
      readOnly: [],
      hidden: [],
      workspace: { path: '/srv/work', writable: true },
      env: {},
    },
    ['x'],
    file => file === '/srv/work',
  )
  expect(mounts(writable)).toContain('--bind /srv/work /srv/work')
  // A home of `/` (some service users) is not hidden: that would hide everything.
  const rooted = desktopSandboxArgv(
    { home, writable: [], readOnly: [], hidden: ['/'], env: {} },
    ['x'],
    () => true,
  )
  expect(mounts(rooted)).not.toContain('--tmpfs /')
  // The probe takes the same namespaces and clears the environment.
  expect(DESKTOP_BWRAP_PROBE).toEqual(
    expect.arrayContaining(['--unshare-user', '--unshare-pid', '--clearenv']),
  )
  expect(DESKTOP_BWRAP_PROBE).not.toContain('--unshare-net')
  expect(desktopScopeArgv(1024)).toEqual([
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    '-p',
    'MemoryMax=1024',
    '-p',
    'TasksMax=256',
  ])
})

test('sandbox environment is an allowlist plus the private desktop', () => {
  const base = {
    PATH: '/usr/bin:/bin',
    LANG: 'zh_CN.UTF-8',
    HOME: '/home/node',
    XDG_RUNTIME_DIR: '/run/user/1000',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    QIANMO_PSK: 'secret',
    OPENAI_API_KEY: 'sk-secret',
    https_proxy: 'http://proxy:3128',
  }
  const desktop = {
    home: '/d/home',
    display: ':27',
    xauthority: '/d/Xauthority',
    bus: null,
  }
  expect(desktopSandboxEnv(desktop, base)).toEqual({
    PATH: '/usr/bin:/bin',
    LANG: 'zh_CN.UTF-8',
    HOME: '/d/home',
    DISPLAY: ':27',
    XAUTHORITY: '/d/Xauthority',
    XDG_CONFIG_HOME: '/d/home/.config',
    XDG_DATA_HOME: '/d/home/.local/share',
    XDG_CACHE_HOME: '/d/home/.cache',
    XDG_RUNTIME_DIR: '/d/home/.run',
  })
  const browser = desktopSandboxEnv(
    { ...desktop, bus: 'unix:path=/d/home/.run/bus', proxy: true },
    base,
  )
  expect(browser).toMatchObject({
    https_proxy: 'http://proxy:3128',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/d/home/.run/bus',
    GTK_MODULES: 'gail:atk-bridge',
    QT_ACCESSIBILITY: '1',
    QT_LINUX_ACCESSIBILITY_ALWAYS_ON: '1',
    ACCESSIBILITY_ENABLED: '1',
  })
  expect(JSON.stringify(browser)).not.toContain('secret')
  expect(desktopSandboxEnv(desktop, {}).PATH).toBe(
    '/usr/local/bin:/usr/bin:/bin',
  )
})

test('memory sums RssAnon of every descendant, not the supervising roots', () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-proc-'))
  roots.push(proc)
  const ps = (pid: number, ppid: number, kb: number, comm = 'x') => {
    fs.mkdirSync(path.join(proc, String(pid)))
    fs.writeFileSync(
      path.join(proc, String(pid), 'stat'),
      `${pid} (${comm}) S ${ppid} 1 1 0`,
    )
    fs.writeFileSync(
      path.join(proc, String(pid), 'status'),
      `Name:\t${comm}\nVmRSS:\t${kb * 3} kB\nRssAnon:\t${kb} kB\n`,
    )
  }
  ps(10, 1, 30_000, 'bun') // subreaper root: left out
  ps(11, 10, 100, 'bwrap')
  ps(12, 11, 200, 'Web Content (x)')
  ps(13, 12, 300)
  ps(20, 1, 30_000, 'bun')
  ps(21, 20, 400, 'Xvfb')
  ps(30, 1, 999) // unrelated
  fs.writeFileSync(path.join(proc, 'self'), '')
  expect(desktopMemory([10, 20], proc)).toBe((100 + 200 + 300 + 400) * 1024)
  expect(desktopMemory([99], proc)).toBe(0)
  expect(desktopMemory([10], path.join(proc, 'missing'))).toBeNull()
})
