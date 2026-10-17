// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Window managers the private desktop starts; the first installed wins (§6.3).
 * None of them may start a program: one launched from a menu or a key binding
 * would get past the allowed list and the terminal rule. openbox runs with
 * {@link OPENBOX_CONFIG}; xfwm4 and matchbox have no launcher of their own.
 * fluxbox and icewm are not used: their root menu and task bar start a
 * terminal.
 */
export const DESKTOP_WINDOW_MANAGERS: readonly string[] = [
  'openbox',
  'xfwm4',
  'matchbox-window-manager',
]

/**
 * openbox with no menu and no binding that runs a program: a window can be
 * focused, raised, moved, maximized and closed, nothing else. Its default
 * configuration opens the root menu (with a terminal in it) on a right or
 * middle click on the desktop, and runs a file manager on Super+E.
 */
export const OPENBOX_CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <keyboard/>
  <mouse>
    <context name="Titlebar">
      <mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
      <mousebind button="Left" action="Drag"><action name="Move"/></mousebind>
      <mousebind button="Left" action="DoubleClick"><action name="ToggleMaximize"/></mousebind>
    </context>
    <context name="Client">
      <mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
      <mousebind button="Middle" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
      <mousebind button="Right" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
    </context>
    <context name="Close">
      <mousebind button="Left" action="Click"><action name="Close"/></mousebind>
    </context>
    <context name="Maximize">
      <mousebind button="Left" action="Click"><action name="ToggleMaximize"/></mousebind>
    </context>
  </mouse>
</openbox_config>
`

/** Where distributions put the AT-SPI bus launcher; it is rarely on PATH. */
export const AT_SPI_BUS_LAUNCHERS: readonly string[] = [
  '/usr/libexec/at-spi-bus-launcher',
  '/usr/lib/at-spi2-core/at-spi-bus-launcher',
  '/usr/lib/at-spi-bus-launcher',
  'at-spi-bus-launcher',
]

/** The private home's XDG directories (config, data, cache, runtime). */
export const DESKTOP_HOME_DIRS: readonly string[] = [
  '.config',
  path.join('.local', 'share'),
  '.cache',
  '.run',
]

const NAMESPACES = [
  '--unshare-user',
  '--unshare-pid',
  '--unshare-ipc',
  '--die-with-parent',
  '--new-session',
]

/**
 * One bubblewrap run with the namespaces and the environment handling every
 * sandboxed desktop process gets, so a pass means the real launch can work:
 * a user namespace, a fresh pid namespace, and `--clearenv`.
 */
export const DESKTOP_BWRAP_PROBE: readonly string[] = [
  ...NAMESPACES,
  '--ro-bind',
  '/',
  '/',
  '--dev',
  '/dev',
  '--proc',
  '/proc',
  '--tmpfs',
  '/tmp',
  '--clearenv',
  '--setenv',
  'PATH',
  '/usr/bin:/bin',
  'true',
]

/** `systemd-run` arguments that put one process in its own capped scope. */
export function desktopScopeArgv(memoryBytes: number): string[] {
  return [
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    '-p',
    `MemoryMax=${memoryBytes}`,
    '-p',
    'TasksMax=256',
  ]
}

/** What one sandboxed desktop process sees of the node. */
export interface DesktopSandbox {
  /** The private home: the working directory and `$HOME`. */
  readonly home: string
  /** Mounted back writable at their own paths (home, downloads, profile). */
  readonly writable: readonly string[]
  /** Mounted back read-only at their own paths (the Xauthority file). */
  readonly readOnly: readonly string[]
  /** Node-owned roots replaced by empty directories. */
  readonly hidden: readonly string[]
  readonly workspace?: { readonly path: string; readonly writable: boolean }
  readonly env: Readonly<Record<string, string>>
}

const within = (child: string, parent: string) =>
  child === parent ||
  child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`)

function real(file: string): string {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

/**
 * The bubblewrap arguments for one command. The root is read-only; `/tmp`
 * is private with only the X socket directory mounted back; every hidden root
 * that exists becomes an empty tmpfs (a root covered by another is skipped);
 * the workspace comes back next, with the hidden roots inside it covered again;
 * the agent's own desktop directories come back last. The node user's runtime
 * directory goes too: its sockets (the user's own session bus, the systemd
 * user manager) would let a process start commands outside the sandbox.
 */
export function desktopSandboxArgv(
  box: DesktopSandbox,
  command: readonly string[],
  exists: (file: string) => boolean = fs.existsSync,
): string[] {
  const base = ['/tmp', ...['/var/tmp', '/run/user'].filter(exists).map(real)]
  // A service user whose home is `/` must not blank the whole sandbox.
  const hidden = [
    ...new Set(
      box.hidden
        .filter(exists)
        .map(real)
        .filter(root => root !== path.parse(root).root),
    ),
  ].sort((a, b) => a.length - b.length || a.localeCompare(b))
  const covered: string[] = [...base]
  const tops: string[] = []
  for (const root of hidden)
    if (!covered.some(top => within(root, top))) {
      covered.push(root)
      tops.push(root)
    }
  const argv = [
    ...NAMESPACES,
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--ro-bind-try',
    '/tmp/.X11-unix',
    '/tmp/.X11-unix',
  ]
  for (const root of [...base.slice(1), ...tops]) argv.push('--tmpfs', root)
  for (const socket of new Set(
    ['/run/docker.sock', '/var/run/docker.sock'].filter(exists).map(real),
  ))
    argv.push('--ro-bind', '/dev/null', socket)
  if (box.workspace && exists(box.workspace.path)) {
    const workspace = real(box.workspace.path)
    argv.push(
      box.workspace.writable ? '--bind' : '--ro-bind',
      workspace,
      workspace,
    )
    for (const root of hidden)
      if (root !== workspace && within(root, workspace))
        argv.push('--tmpfs', root)
  }
  for (const dir of box.writable) argv.push('--bind', real(dir), real(dir))
  for (const file of box.readOnly)
    argv.push('--ro-bind', real(file), real(file))
  argv.push('--clearenv')
  for (const [key, value] of Object.entries(box.env))
    argv.push('--setenv', key, value)
  argv.push('--chdir', box.home, '--', ...command)
  return argv
}

const PASSED = [
  'PATH',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'USER',
  'LOGNAME',
]
const PROXY = [
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
]

/**
 * The whole environment of a private desktop process: a short allowlist from
 * the node, the private display and home, XDG directories inside that home,
 * the private session bus with the GTK/Qt accessibility switches when there
 * is one. Proxy settings go only to the browser, never to applications (a
 * terminal could print them).
 */
export function desktopSandboxEnv(
  desktop: {
    readonly home: string
    readonly display: string
    readonly xauthority: string
    readonly bus: string | null
    readonly proxy?: boolean
  },
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of [...PASSED, ...(desktop.proxy ? PROXY : [])]) {
    const value = base[key]
    if (value) env[key] = value
  }
  env.PATH ??= '/usr/local/bin:/usr/bin:/bin'
  Object.assign(env, {
    HOME: desktop.home,
    DISPLAY: desktop.display,
    XAUTHORITY: desktop.xauthority,
    XDG_CONFIG_HOME: path.join(desktop.home, '.config'),
    XDG_DATA_HOME: path.join(desktop.home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(desktop.home, '.cache'),
    XDG_RUNTIME_DIR: path.join(desktop.home, '.run'),
  })
  if (desktop.bus)
    Object.assign(env, {
      DBUS_SESSION_BUS_ADDRESS: desktop.bus,
      GTK_MODULES: 'gail:atk-bridge',
      GNOME_ACCESSIBILITY: '1',
      QT_ACCESSIBILITY: '1',
      QT_LINUX_ACCESSIBILITY_ALWAYS_ON: '1',
      ACCESSIBILITY_ENABLED: '1',
    })
  return env
}

/**
 * Anonymous resident memory of everything under `roots`, in bytes, read from
 * `/proc` (`RssAnon`, the figure the handoff node judges too: shared library
 * pages are not counted once per process). The roots themselves are the
 * host's supervising subreapers and are left out. `null` without `/proc`.
 */
export function desktopMemory(
  roots: readonly number[],
  procRoot = '/proc',
): number | null {
  let entries: string[]
  try {
    entries = fs.readdirSync(procRoot)
  } catch {
    return null
  }
  const children = new Map<number, number[]>()
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let stat: string
    try {
      stat = fs.readFileSync(path.join(procRoot, entry, 'stat'), 'utf8')
    } catch {
      continue
    }
    // "<pid> (<comm>) <state> <ppid> …"; the comm may hold spaces and parens.
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    if (Number.isInteger(ppid))
      children.set(ppid, [...(children.get(ppid) ?? []), Number(entry)])
  }
  const seen = new Set(roots)
  const pending = roots.flatMap(root => children.get(root) ?? [])
  let kb = 0
  while (pending.length) {
    const pid = pending.pop()!
    if (seen.has(pid)) continue
    seen.add(pid)
    pending.push(...(children.get(pid) ?? []))
    try {
      const status = fs.readFileSync(
        path.join(procRoot, String(pid), 'status'),
        'utf8',
      )
      kb += Number(/^RssAnon:\s+(\d+)\s+kB/m.exec(status)?.[1] ?? 0)
    } catch {
      /* Exited while walking. */
    }
  }
  return kb * 1024
}
