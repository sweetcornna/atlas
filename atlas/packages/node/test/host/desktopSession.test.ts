// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { deflateSync } from 'node:zlib'
import type { DesktopNodeView, DesktopScreenView } from '@qianmo/console'
import { desktopArgs, isDesktopTool } from '@qianmo/extension/desktopPolicy'
import { NodeDesktop, type DesktopLauncher } from '../../src/host/desktop.js'
import {
  DESKTOP_BWRAP_PROBE,
  DESKTOP_WINDOW_MANAGERS,
  desktopScopeArgv,
  OPENBOX_CONFIG,
} from '../../src/host/desktopSandbox.js'
import type { ScreenEncoder } from '../../src/host/desktopScreen.js'

/**
 * The Linux private desktop (runtimes-channels.md §6.3) on a fake launcher:
 * which processes start, in what order, with which bubblewrap and systemd
 * argv, and what the host does when a piece is missing. Real Xvfb, bwrap
 * and Chromium run only in the Linux container check (§6.7).
 */
const ctx = { peer: 'hub', actor: 'ops', taskId: 'control' }
const LIMIT = 512 * 1024 * 1024
const ATSPI = '/usr/libexec/at-spi-bus-launcher'
const FULL = ['systemd-run', 'bwrap', 'dbus-daemon', ATSPI, 'openbox', 'xfwm4']
// The tool surface for qianmo_computer_apps / open_app lands with the
// executor change; until then the decide()-level cases cannot reserve.
const hostTools =
  isDesktopTool('qianmo_computer_apps') &&
  isDesktopTool('qianmo_computer_open_app')
const hash = (args: unknown) =>
  createHash('sha256').update(JSON.stringify(args)).digest('hex')
const real = (file: string) => fs.realpathSync(file)

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  mock.restore()
})

interface Call {
  readonly program: string
  readonly argv: readonly string[]
  readonly env: Record<string, string | undefined>
  readonly pid: number
}
async function session(
  opts: {
    tools?: readonly string[]
    exit?: Readonly<Record<string, number>>
    headed?: 'dies'
    bus?: false
    memory?: () => number | null
    entries?: Readonly<Record<string, string>>
    workspaceWritable?: boolean
    screenEncoders?: readonly ScreenEncoder[]
    platform?: NodeJS.Platform
  } = {},
) {
  const previous = process.env.QIANMO_CONFIG_DIR
  // Short: the private bus socket lives under it, and a Unix socket path
  // holds at most 107 bytes (macOS's per-user temp directory is too deep).
  const base = fs.mkdtempSync('/tmp/p21-s-')
  const root = path.join(base, 'config')
  process.env.QIANMO_CONFIG_DIR = root
  const workspace = path.join(base, 'workspace')
  const otherWorkspace = path.join(base, 'other-workspace')
  const protectedRoot = path.join(base, 'protected')
  const memoryRoot = path.join(base, 'memory')
  const appsDir = path.join(base, 'applications')
  for (const dir of [
    root,
    workspace,
    otherWorkspace,
    path.join(workspace, 'vault'),
    protectedRoot,
    memoryRoot,
    appsDir,
  ])
    fs.mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(opts.entries ?? {}))
    fs.writeFileSync(path.join(appsDir, name), text)
  spyOn(Bun, 'which').mockReturnValue(null)
  spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url === 'http://127.0.0.1:9222/json/version')
          return Response.json({})
        if (url === 'http://127.0.0.1:9222/json/list')
          return Response.json([{ type: 'page' }])
        throw new Error(`Unexpected fixture fetch: ${url}`)
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  const tools = new Set(opts.tools ?? [])
  const calls: Call[] = []
  const runs: Call[] = []
  const stops: number[] = []
  const reaped: { pid: number; marker: string }[] = []
  const dead = new Set<number>()
  let pid = 500
  const launcher: DesktopLauncher = {
    available: name =>
      ['Xvfb', 'xauth', 'chromium'].includes(name) || tools.has(name),
    async run(program, argv, env) {
      runs.push({ program, argv, env, pid: 0 })
      if (program !== 'xauth') return opts.exit?.[program] ?? 0
      fs.writeFileSync(argv[1]!, 'fixture-cookie', { mode: 0o600 })
      return 0
    },
    async start(program, argv, env) {
      const own = pid++
      calls.push({ program, argv, env: { ...env }, pid: own })
      if (argv.includes('qianmo-xvfb')) fs.writeFileSync(argv.at(-1)!, '27\n')
      const address = argv.find(a => a.startsWith('--address=unix:path='))
      if (address && opts.bus === false) dead.add(own)
      else if (address)
        fs.writeFileSync(address.slice('--address=unix:path='.length), '')
      const profile = argv
        .find(a => a.startsWith('--user-data-dir='))
        ?.slice('--user-data-dir='.length)
      const headless = argv.includes('--headless=new')
      if (profile && !headless && opts.headed === 'dies') dead.add(own)
      else if (profile)
        fs.writeFileSync(
          path.join(profile, 'DevToolsActivePort'),
          '9222\n/ws\n',
        )
      return {
        pid: own,
        alive: () => !dead.has(own),
        async stop() {
          dead.add(own)
          stops.push(own)
        },
      }
    },
    async reap(id, marker) {
      reaped.push({ pid: id, marker })
    },
    ...(opts.memory ? { memory: () => opts.memory!() } : {}),
  }
  let estop = false
  const make = () =>
    new NodeDesktop({
      node: 'worker',
      agents: ['main', 'other'],
      estop: () => estop,
      platform: opts.platform ?? 'linux',
      launcher,
      idleMs: 3_600_000,
      memoryBytes: LIMIT,
      workspace: agent =>
        agent === 'main'
          ? workspace
          : agent === 'other'
            ? otherWorkspace
            : undefined,
      workspaceWritable: opts.workspaceWritable === true,
      protectedRoots: [
        memoryRoot,
        protectedRoot,
        path.join(workspace, 'vault'),
      ],
      applicationDirs: [appsDir],
      ...(opts.screenEncoders ? { screenEncoders: opts.screenEncoders } : {}),
    })
  const node = make()
  const desktop = path.join(root, 'qianmo/desktop/main')
  const f = {
    node,
    make,
    launcher,
    calls,
    runs,
    stops,
    reaped,
    workspace,
    otherWorkspace,
    protectedRoot,
    memoryRoot,
    desktop,
    home: path.join(desktop, 'home'),
    kill: (id: number) => dead.add(id),
    setEstop: () => {
      estop = true
    },
    enable: (operationId: string, change: Record<string, unknown>) =>
      node.control(
        'desktop.enable',
        { agent: 'main', operationId, ...change },
        ctx,
      ),
    view: async () =>
      (
        (await node.control('desktop.status', {}, ctx)) as {
          value: DesktopNodeView[]
        }
      ).value[0]!,
    pids: () =>
      (
        JSON.parse(
          fs.readFileSync(
            path.join(root, 'qianmo/desktop-ledger.json'),
            'utf8',
          ),
        ) as {
          states: {
            agent: string
            pids: { pid: number; marker: string; app?: true }[]
          }[]
        }
      ).states.find(s => s.agent === 'main')!.pids,
  }
  cleanups.push(async () => {
    await node.close()
    process.env.QIANMO_CONFIG_DIR = previous
    fs.rmSync(base, { recursive: true, force: true })
  })
  return f
}
/** What one started process is, wrapped in systemd-run and bwrap or not. */
function role(call: Call): string {
  const argv = [call.program, ...call.argv]
  if (argv.includes('qianmo-xvfb')) return 'xvfb'
  if (argv.some(a => a.startsWith('--user-data-dir=')))
    return argv.includes('--headless=new') ? 'chrome-headless' : 'chrome-headed'
  if (argv.includes('dbus-daemon')) return 'bus'
  if (argv.includes(ATSPI)) return 'a11y'
  const manager = DESKTOP_WINDOW_MANAGERS.find(wm => argv.includes(wm))
  if (manager) return `app:${manager}`
  return `app:${argv.at(-1)}`
}
/** The command bubblewrap runs, and its own arguments. */
function bwrapOf(call: Call): { args: string[]; command: string[] } {
  const argv = [call.program, ...call.argv]
  const at = argv.indexOf('bwrap')
  expect(at).toBeGreaterThanOrEqual(0)
  const dash = argv.indexOf('--', at)
  return { args: argv.slice(at + 1, dash), command: argv.slice(dash + 1) }
}
function setenv(args: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (let i = 0; i < args.length; i++)
    if (args[i] === '--setenv') env[args[i + 1]!] = args[(i += 2)]!
  return env
}
/** Index of the first `--tmpfs X` whose X covers `file`. */
function hiddenAt(args: readonly string[], file: string): number {
  return args.findIndex(
    (a, i) =>
      a === '--tmpfs' &&
      (file === args[i + 1] || file.startsWith(`${args[i + 1]}/`)),
  )
}
function mountAt(args: readonly string[], flag: string, file: string): number {
  return args.findIndex(
    (a, i) => a === flag && args[i + 1] === file && args[i + 2] === file,
  )
}
function decider(
  node: NodeDesktop,
  tool: string,
  args: Record<string, unknown>,
  invocationId: string,
  approve: () => void = () => {},
) {
  const resource = node.resource('main')!
  // The digest is over the canonical arguments, the way the executor sends it.
  const input = {
    invocationId,
    resourceId: resource.resourceId,
    resourceEpoch: resource.resourceEpoch,
    args,
    canonicalArgsDigest: hash(
      isDesktopTool(tool) ? desktopArgs(tool, args) : args,
    ),
  }
  return (phase: string, extra: Record<string, unknown> = {}) =>
    node.decide(
      'main',
      's',
      't',
      'c',
      { toolName: tool, input: { ...input, phase, ...extra } },
      () => true,
      async (_call, before) => {
        approve()
        return before(undefined, 'fixture-request', () => true)
      },
    )
}
const observed = { observedTargetDigest: 'a'.repeat(64) }
async function committed(step: ReturnType<typeof decider>) {
  expect(await step('reserve')).toEqual({ ok: true })
  expect(await step('authorize', observed)).toEqual({ ok: true })
  expect(await step('commit', observed)).toEqual({ ok: true })
}
const entry = (fields: Record<string, string>) =>
  `[Desktop Entry]\nType=Application\n${Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`
const ENTRIES = {
  'gedit.desktop': entry({ Name: 'Text Editor', Exec: 'gedit %U' }),
  'debian-xterm.desktop': entry({
    Name: 'XTerm',
    Exec: 'xterm',
    Categories: 'System;TerminalEmulator;',
  }),
  'vim.desktop': entry({ Name: 'Vim', Exec: 'vim %F', Terminal: 'true' }),
}

test('private desktop: Xvfb, bus, accessibility, first window manager, headed Chromium — each in its own capped scope', async () => {
  const f = await session({ tools: FULL })
  expect((await f.enable('on', { browser: true, computer: true })).ok).toBe(
    true,
  )
  // Probed once each: a scope with the node limit, bubblewrap's namespaces.
  expect(
    f.runs
      .filter(r => r.program !== 'xauth')
      .map(r => [r.program, r.argv, r.program === 'bwrap' ? r.env : null]),
  ).toEqual([
    ['systemd-run', [...desktopScopeArgv(LIMIT), 'true'], null],
    ['bwrap', [...DESKTOP_BWRAP_PROBE], { PATH: process.env.PATH }],
  ])
  expect(f.calls.map(role)).toEqual([
    'xvfb',
    'bus',
    'a11y',
    'app:openbox',
    'chrome-headed',
  ])
  for (const call of f.calls) {
    expect(call.program).toBe('systemd-run')
    expect(call.argv.slice(0, 8)).toEqual(desktopScopeArgv(LIMIT))
  }
  // Everything but Xvfb is sandboxed.
  expect(f.calls[0]!.argv[8]).toBe('/bin/sh')
  for (const call of f.calls.slice(1)) expect(call.argv[8]).toBe('bwrap')
  const bus = `unix:path=${path.join(f.home, '.run', 'bus')}`
  expect(bwrapOf(f.calls[1]!).command).toEqual([
    'dbus-daemon',
    '--session',
    '--nofork',
    '--nopidfile',
    `--address=${bus}`,
  ])
  expect(bwrapOf(f.calls[2]!).command).toEqual([ATSPI, '--launch-immediately'])
  // openbox with the node's configuration: no menu, no binding that runs
  // a program, outside the private home and mounted read-only.
  const openbox = path.join(f.desktop, 'openbox.xml')
  expect(bwrapOf(f.calls[3]!).command).toEqual([
    'openbox',
    '--config-file',
    openbox,
  ])
  expect(fs.readFileSync(openbox, 'utf8')).toBe(OPENBOX_CONFIG)
  for (const launcher of ['ShowMenu', 'Execute', 'root-menu'])
    expect(OPENBOX_CONFIG).not.toContain(launcher)
  expect(bwrapOf(f.calls[3]!).args.join(' ')).toContain(
    `--ro-bind ${real(openbox)} ${real(openbox)}`,
  )
  const headed = bwrapOf(f.calls[4]!).command
  expect(headed).not.toContain('--headless=new')
  expect(headed).not.toContain('--no-sandbox')
  expect(headed).toContain('--remote-debugging-address=127.0.0.1')
  expect(setenv(bwrapOf(f.calls[4]!).args)).toMatchObject({
    DISPLAY: ':27',
    DBUS_SESSION_BUS_ADDRESS: bus,
  })
  expect(f.node.resource('main')).toMatchObject({
    browser: true,
    computer: true,
    display: ':27',
    cdpUrl: 'http://127.0.0.1:9222',
    bus,
  })
  const view = await f.view()
  expect(view.computer).toMatchObject({
    state: 'running',
    reason: null,
    mode: 'private',
    windowManager: 'openbox',
    accessibility: true,
    confined: true,
    apps: 'all',
    terminal: false,
    memoryBytes: null,
    memoryLimitBytes: LIMIT,
  })
  expect(view.browser.reason).toBeNull()
  // The process table holds all five, each with a marker its argv carries.
  expect(f.pids()).toEqual(
    f.calls.map((call, i) => ({
      pid: call.pid,
      marker:
        i === 0
          ? path.join(f.desktop, 'Xauthority')
          : i === 4
            ? path.join(f.desktop, 'browser')
            : f.home,
    })),
  )
  for (const [i, call] of f.calls.entries())
    expect(call.argv.some(a => a.includes(f.pids()[i]!.marker))).toBe(true)
  for (const dir of ['.config', '.local/share', '.cache', '.run'])
    expect(fs.statSync(path.join(f.home, dir)).mode & 0o777).toBe(0o700)
  expect(fs.readlinkSync(path.join(f.home, 'Downloads'))).toBe(
    path.join(f.desktop, 'downloads'),
  )
})

test('bubblewrap hides the node home, config root and guarded roots, then mounts the desktop and workspace back', async () => {
  process.env.QIANMO_TEST_LEAK = 'must-not-reach-the-sandbox'
  cleanups.push(async () => {
    delete process.env.QIANMO_TEST_LEAK
  })
  const f = await session({ tools: ['bwrap', 'dbus-daemon', 'openbox'] })
  expect((await f.enable('on', { computer: true })).ok).toBe(true)
  const wm = f.calls.find(c => role(c) === 'app:openbox')!
  expect(wm.program).toBe('bwrap')
  const { args } = bwrapOf(wm)
  for (const flag of [
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--die-with-parent',
    '--new-session',
    '--clearenv',
  ])
    expect(args).toContain(flag)
  expect(args).not.toContain('--unshare-net')
  expect(
    args.slice(args.indexOf('--ro-bind'), args.indexOf('--ro-bind') + 3),
  ).toEqual(['--ro-bind', '/', '/'])
  expect(args.join(' ')).toContain(
    '--dev /dev --proc /proc --tmpfs /tmp --ro-bind-try /tmp/.X11-unix /tmp/.X11-unix',
  )
  const config = real(process.env.QIANMO_CONFIG_DIR!)
  const desktop = real(f.desktop)
  const covering = [
    real(os.homedir()),
    config,
    real(f.protectedRoot),
    real(f.memoryRoot),
  ].map(file => hiddenAt(args, file))
  for (const at of covering) expect(at).toBeGreaterThanOrEqual(0)
  const backs = [
    mountAt(args, '--bind', path.join(desktop, 'home')),
    mountAt(args, '--bind', path.join(desktop, 'downloads')),
    mountAt(args, '--bind', path.join(desktop, 'browser')),
    mountAt(args, '--ro-bind', path.join(desktop, 'Xauthority')),
    mountAt(args, '--ro-bind', path.join(desktop, 'openbox.xml')),
  ]
  for (const at of backs) expect(at).toBeGreaterThan(Math.max(...covering))
  // Another agent's workspace is hidden; this agent's is not.
  expect(hiddenAt(args, real(f.otherWorkspace))).toBeGreaterThanOrEqual(0)
  expect(hiddenAt(args, real(f.workspace))).toBe(-1)
  // The workspace comes back read-only; a guarded root inside is hidden again.
  const workspace = mountAt(args, '--ro-bind', real(f.workspace))
  expect(workspace).toBeGreaterThan(Math.max(...covering))
  expect(mountAt(args, '--bind', real(f.workspace))).toBe(-1)
  const vault = path.join(real(f.workspace), 'vault')
  expect(
    args.findIndex(
      (a, i) => i > workspace && a === '--tmpfs' && args[i + 1] === vault,
    ),
  ).toBeGreaterThan(workspace)
  const env = setenv(args)
  expect(env).toMatchObject({
    HOME: f.home,
    DISPLAY: ':27',
    XAUTHORITY: path.join(f.desktop, 'Xauthority'),
    XDG_CONFIG_HOME: path.join(f.home, '.config'),
    XDG_DATA_HOME: path.join(f.home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(f.home, '.cache'),
    XDG_RUNTIME_DIR: path.join(f.home, '.run'),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(f.home, '.run', 'bus')}`,
    GTK_MODULES: 'gail:atk-bridge',
    QT_ACCESSIBILITY: '1',
  })
  expect(Object.keys(env).some(k => k.startsWith('QIANMO_'))).toBe(false)
  expect(args.join(' ')).not.toContain('must-not-reach-the-sandbox')
  // No at-spi launcher installed: a bus, but no accessibility.
  expect((await f.view()).computer.accessibility).toBe(false)

  const editable = await session({
    tools: ['bwrap', 'openbox'],
    workspaceWritable: true,
  })
  expect((await editable.enable('on', { computer: true })).ok).toBe(true)
  const writable = bwrapOf(
    editable.calls.find(c => role(c) === 'app:openbox')!,
  ).args
  expect(mountAt(writable, '--bind', real(editable.workspace))).toBeGreaterThan(
    0,
  )
  // Without dbus-daemon there is no private bus at all.
  expect(editable.calls.some(c => role(c) === 'bus')).toBe(false)
  expect(editable.node.resource('main')?.bus).toBeNull()
})

for (const [label, opts] of [
  ['bubblewrap is not installed', { tools: ['dbus-daemon', 'openbox'] }],
  [
    'bubblewrap cannot create a user namespace',
    { tools: ['bwrap', 'dbus-daemon', 'openbox'], exit: { bwrap: 1 } },
  ],
] as const) {
  test(`${label}: the computer still opens unconfined, without a window manager; apps are refused, Chromium stays headless`, async () => {
    const f = await session(opts)
    expect((await f.enable('on', { browser: true, computer: true })).ok).toBe(
      true,
    )
    // Nothing starts outside the sandbox but Xvfb: a window manager there
    // could start programs, and nothing would open on the display anyway.
    expect(f.calls.map(role)).toEqual(['xvfb', 'chrome-headless'])
    expect(f.calls[1]!.program).toBe('chromium')
    const view = await f.view()
    expect(view.computer).toMatchObject({
      state: 'running',
      confined: false,
      accessibility: false,
      windowManager: null,
    })
    expect(view.computer.reason).toContain('需要 bubblewrap')
    expect(view.browser.reason).toContain('浏览器保持无头')
    expect(f.node.resource('main')?.bus).toBeNull()
    if (hostTools) {
      const open = decider(
        f.node,
        'qianmo_computer_open_app',
        { app: 'gedit' },
        'open',
      )
      const refused = await open('reserve')
      expect(refused.ok).toBe(false)
      expect(!refused.ok && refused.reason).toContain('需要 bubblewrap')
    }
  })
}

test('window manager: the first one installed in the documented order; none is fine', async () => {
  const f = await session({
    tools: ['bwrap', 'matchbox-window-manager', 'xfwm4'],
  })
  expect((await f.enable('on', { computer: true })).ok).toBe(true)
  expect(f.calls.map(role)).toEqual(['xvfb', 'app:xfwm4'])
  expect(bwrapOf(f.calls[1]!).command).toEqual(['xfwm4'])
  expect((await f.view()).computer.windowManager).toBe('xfwm4')
  // fluxbox and icewm start a terminal from their menus: never used.
  const launchers = await session({ tools: ['bwrap', 'icewm', 'fluxbox'] })
  expect((await launchers.enable('on', { computer: true })).ok).toBe(true)
  expect(launchers.calls.map(role)).toEqual(['xvfb'])
  const bare = await session({ tools: ['bwrap'] })
  expect((await bare.enable('on', { computer: true })).ok).toBe(true)
  expect(bare.calls.map(role)).toEqual(['xvfb'])
  expect((await bare.view()).computer).toMatchObject({
    state: 'running',
    windowManager: null,
    confined: true,
  })
})

test('browser alone stays headless; a headed Chromium that dies is dropped and the browser falls back with a reason', async () => {
  const f = await session({ tools: FULL })
  expect((await f.enable('on', { browser: true })).ok).toBe(true)
  expect(f.calls.map(role)).toEqual(['chrome-headless'])
  expect(f.calls[0]!.argv.slice(8, 9)).toEqual(['chromium'])
  expect(f.calls[0]!.argv).not.toContain('bwrap')

  const g = await session({ tools: FULL, headed: 'dies' })
  expect((await g.enable('on', { browser: true, computer: true })).ok).toBe(
    true,
  )
  expect(g.calls.map(role)).toEqual([
    'xvfb',
    'bus',
    'a11y',
    'app:openbox',
    'chrome-headed',
    'chrome-headless',
  ])
  const headed = g.calls[4]!.pid
  expect(g.stops).toContain(headed)
  expect(g.pids().map(p => p.pid)).not.toContain(headed)
  expect(g.node.resource('main')?.cdpUrl).toBe('http://127.0.0.1:9222')
  const view = await g.view()
  expect(view.browser.state).toBe('running')
  expect(view.browser.reason).toContain('已退回无头')
  // The sweep does not take the dropped process for a crashed desktop.
  await g.node.sweep()
  expect((await g.view()).computer.state).toBe('running')
})

test('a private bus that does not come up is dropped; the computer runs without accessibility', async () => {
  const f = await session({ tools: FULL, bus: false })
  expect((await f.enable('on', { computer: true })).ok).toBe(true)
  expect(f.calls.map(role)).toEqual(['xvfb', 'bus', 'app:openbox'])
  expect(f.stops).toContain(f.calls[1]!.pid)
  expect(f.node.resource('main')?.bus).toBeNull()
  const wm = setenv(bwrapOf(f.calls[2]!).args)
  expect(wm.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
  const view = await f.view()
  expect(view.computer).toMatchObject({
    state: 'running',
    accessibility: false,
  })
  expect(view.computer.reason).toContain('D-Bus')
})

test('apps and terminal are validated, stored and restart a running computer when changed', async () => {
  const f = await session({ tools: ['bwrap'] })
  const invalid = async (op: string, change: Record<string, unknown>) =>
    expect(
      (
        await f.node.control(
          op,
          { agent: 'main', operationId: `bad-${Math.random()}`, ...change },
          ctx,
        )
      ).ok,
    ).toBe(false)
  await invalid('desktop.enable', { apps: 'some' })
  await invalid('desktop.enable', { apps: [''] })
  await invalid('desktop.enable', {
    apps: Array.from({ length: 51 }, (_, i) => `app${i}`),
  })
  await invalid('desktop.enable', { terminal: 'yes' })
  await invalid('desktop.disable', { apps: 'none' })
  await invalid('desktop.recycle', { terminal: true })
  expect((await f.enable('on', { computer: true })).ok).toBe(true)
  const xvfb = () => f.calls.filter(c => role(c) === 'xvfb').length
  const epoch = () => f.node.resource('main')!.resourceEpoch
  const first = epoch()
  const changed = await f.enable('apps', { apps: ['gedit', 'gedit', 'kate'] })
  expect(changed.ok).toBe(true)
  expect(xvfb()).toBe(2)
  expect(epoch()).toBeGreaterThan(first)
  expect((await f.view()).computer.apps).toEqual(['gedit', 'kate'])
  expect((await f.enable('same', { apps: ['gedit', 'kate'] })).ok).toBe(true)
  expect(xvfb()).toBe(2)
  expect(
    (await f.enable('term', { terminal: true, confirm: 'autonomous' })).ok,
  ).toBe(true)
  expect(xvfb()).toBe(3)
  const view = await f.view()
  expect(view.computer).toMatchObject({ terminal: true, state: 'running' })
  expect(view.confirm).toBe('autonomous')
  // Off resources store the policy without starting anything.
  expect(
    (
      await f.node.control(
        'desktop.enable',
        { agent: 'other', operationId: 'other', apps: 'none' },
        ctx,
      )
    ).ok,
  ).toBe(true)
  expect(xvfb()).toBe(3)
})

test.skipIf(!hostTools)(
  'apps and launch: only after commit, once, from the allowed list, in the sandbox; terminals always ask',
  async () => {
    const f = await session({
      tools: ['bwrap', 'openbox', 'gedit', 'xterm', 'vim'],
      entries: ENTRIES,
    })
    expect((await f.enable('on', { computer: true })).ok).toBe(true)
    let asks = 0
    const ask = () => {
      asks++
    }
    const apps = decider(f.node, 'qianmo_computer_apps', {}, 'apps', ask)
    expect(await apps('reserve')).toEqual({ ok: true })
    const early = await apps('apps')
    expect(early.ok).toBe(false)
    expect(!early.ok && early.reason).toContain('提交之后')
    expect(await apps('authorize', observed)).toEqual({ ok: true })
    expect(await apps('commit', observed)).toEqual({ ok: true })
    expect((await apps('launch')).ok).toBe(false)
    const listed = await apps('apps')
    expect(listed.ok).toBe(true)
    expect(JSON.parse((listed as { value: string }).value)).toEqual([
      { id: 'gedit', name: 'Text Editor', terminal: false },
    ])
    expect((await apps('apps')).ok).toBe(false)
    expect(await apps('completed')).toEqual({ ok: true })

    const terminal = decider(
      f.node,
      'qianmo_computer_open_app',
      { app: 'debian-xterm' },
      'xterm',
      ask,
    )
    // Refused before anyone is asked: terminals are off, the id is unknown.
    const shut = await terminal('reserve')
    expect(!shut.ok && shut.reason).toContain('没有开放终端类应用')
    const unknown = await decider(
      f.node,
      'qianmo_computer_open_app',
      { app: 'not-installed' },
      'unknown',
      ask,
    )('reserve')
    expect(!unknown.ok && unknown.reason).toContain('不在')

    const before = f.calls.length
    const open = decider(
      f.node,
      'qianmo_computer_open_app',
      { app: 'gedit' },
      'gedit',
      ask,
    )
    await committed(open)
    const launched = await open('launch')
    expect(launched.ok).toBe(true)
    const value = JSON.parse((launched as { value: string }).value) as {
      app: string
      pid: number
    }
    const call = f.calls[before]!
    expect(value).toEqual({ app: 'gedit', pid: call.pid })
    expect(call.program).toBe('bwrap')
    expect(bwrapOf(call).command).toEqual(['gedit'])
    expect(f.pids().at(-1)).toEqual({
      pid: call.pid,
      marker: f.home,
      app: true,
    })
    expect((await open('launch')).ok).toBe(false)
    expect(await open('completed')).toEqual({ ok: true })
    // The agent closed the window: pruned, the desktop keeps running.
    f.kill(call.pid)
    await f.node.sweep()
    expect((await f.view()).computer.state).toBe('running')
    expect(f.pids().map(p => p.pid)).not.toContain(call.pid)

    // autonomous: ordinary launches run directly, a terminal still asks.
    expect(
      (await f.enable('auto', { confirm: 'autonomous', terminal: true })).ok,
    ).toBe(true)
    asks = 0
    const quiet = decider(
      f.node,
      'qianmo_computer_open_app',
      { app: 'gedit' },
      'quiet',
      ask,
    )
    await committed(quiet)
    expect((await quiet('launch')).ok).toBe(true)
    expect(await quiet('completed')).toEqual({ ok: true })
    expect(asks).toBe(0)
    for (const [id, app] of [
      ['shell', 'debian-xterm'],
      ['vim', 'vim'],
    ] as const) {
      const shell = decider(
        f.node,
        'qianmo_computer_open_app',
        { app },
        id,
        ask,
      )
      await committed(shell)
      expect(await shell('launch')).toMatchObject({ ok: true })
      expect(await shell('completed')).toEqual({ ok: true })
    }
    expect(asks).toBe(2)
    expect(bwrapOf(f.calls.at(-1)!).command).toEqual(['xterm', '-e', 'vim'])
    const actions = (await f.node.control('desktop.actions', {}, ctx)) as {
      value: { op: string; outcome: string }[]
    }
    expect(actions.value.slice(0, 2).map(a => a.outcome)).toEqual([
      'confirmed',
      'confirmed',
    ])
  },
)

test('typed text naming a protected root is refused at reserve, in every confirmation mode', async () => {
  const f = await session({ tools: ['bwrap', 'openbox'] })
  expect(
    (await f.enable('on', { computer: true, confirm: 'autonomous' })).ok,
  ).toBe(true)
  for (const [id, text] of [
    ['memory', `cat ${f.memoryRoot}/notes.md`],
    ['guarded', `${f.protectedRoot}/token`],
    ['identity', 'less ~/x/qianmo/identity/node.key'],
  ] as const) {
    const refused = await decider(
      f.node,
      'qianmo_computer_type',
      { text },
      id,
    )('reserve')
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.reason).toContain('受保护的路径')
    // The reason never repeats what was typed.
    expect(!refused.ok && refused.reason).not.toContain(text)
  }
  const plain = decider(
    f.node,
    'qianmo_computer_type',
    { text: 'hello world' },
    'plain',
  )
  expect(await plain('reserve')).toEqual({ ok: true })
  expect(await plain('failed')).toMatchObject({ ok: false })
  if (hostTools) {
    // Nested strings count too: a batch's typed text.
    const batch = await decider(
      f.node,
      'qianmo_computer_actions',
      { actions: [{ type: 'type', text: `${f.memoryRoot}/x` }] },
      'batch',
    )('reserve')
    expect(!batch.ok && batch.reason).toContain('受保护的路径')
  }
})

/** A noisy RGB PNG: barely compressible, so it is big for its size. */
function png(width: number, height: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff
    for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const rows = Buffer.concat(
    Array.from({ length: height }, () =>
      Buffer.concat([Buffer.from([0]), randomBytes(width * 3)]),
    ),
  )
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('desktop.view: the newest picture, scaled to JPEG within the reply budget; explicit refusals', async () => {
  const f = await session()
  const view = (
    args: Record<string, unknown>,
    fits?: (o: unknown) => boolean,
    node = f.node,
  ) =>
    node.control('desktop.view', args, {
      ...ctx,
      ...(fits ? { resultFits: fits } : {}),
    })
  const refusal = async (args: Record<string, unknown>, words: string) => {
    const answer = await view(args)
    expect(answer).toMatchObject({ ok: false, code: 'rejected' })
    // Never the generic sentence the hub reads as an old node.
    expect(JSON.stringify(answer)).not.toContain('Invalid desktop operation')
    expect(JSON.stringify(answer)).toContain(words)
  }
  await refusal({ agent: 'main' }, '没有开启')
  await refusal({ agent: 'main', limit: 1 }, '只接受 agent')
  await refusal({ agent: 'nobody' }, 'nobody')
  expect((await f.enable('on', { browser: true })).ok).toBe(true)
  expect(await view({ agent: 'main' })).toEqual({ ok: true, value: null })
  const dir = path.join(f.desktop, 'screenshots')
  const at = (name: string, seconds: number) =>
    fs.utimesSync(path.join(dir, name), seconds, seconds)
  fs.writeFileSync(path.join(dir, 'a.png'), png(8, 8))
  at('a.png', 1_000)
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
  fs.writeFileSync(path.join(dir, 'b.jpg'), jpeg)
  at('b.jpg', 2_000)
  // Newer, but not what its name says, too big, a symlink, or not a picture.
  fs.writeFileSync(path.join(dir, 'c.webp'), Buffer.from('RIFFxxxxWAVE'))
  at('c.webp', 3_000)
  fs.writeFileSync(path.join(dir, 'd.png'), Buffer.alloc(4 * 1024 * 1024 + 1))
  at('d.png', 4_000)
  fs.symlinkSync(path.join(dir, 'a.png'), path.join(dir, 'e.png'))
  fs.writeFileSync(path.join(dir, 'f.txt'), 'notes')
  at('f.txt', 6_000)
  // Small enough already: sent as it is.
  expect(await view({ agent: 'main' })).toEqual({
    ok: true,
    value: {
      at: 2_000_000,
      mimeType: 'image/jpeg',
      data: jpeg.toString('base64'),
    } satisfies DesktopScreenView,
  })
  // A real screenshot is larger than a control reply can carry.
  const big = png(640, 400)
  expect(big.toString('base64').length).toBeGreaterThan(180 * 1024)
  fs.writeFileSync(path.join(dir, 'g.png'), big)
  at('g.png', 7_000)
  const scaled = (await view({ agent: 'main' })) as {
    ok: true
    value: DesktopScreenView
  }
  expect(scaled.ok).toBe(true)
  expect(scaled.value.mimeType).toBe('image/jpeg')
  expect(scaled.value.at).toBe(7_000_000)
  expect(scaled.value.data.length).toBeLessThanOrEqual(180 * 1024)
  expect(Buffer.from(scaled.value.data, 'base64').subarray(0, 3)).toEqual(
    Buffer.from([0xff, 0xd8, 0xff]),
  )
  // The host's exact envelope check has the last word.
  const unsent = await view({ agent: 'main' }, () => false)
  expect(unsent).toMatchObject({ ok: false, code: 'rejected' })

  // The runtime cannot encode: ImageMagick is next.
  const calls: number[] = []
  const magick = await session({
    screenEncoders: [
      async () => null,
      async (_picture, width) => {
        calls.push(width)
        return width > 1024
          ? Buffer.concat([jpeg, Buffer.alloc(200 * 1024)])
          : jpeg
      },
    ],
  })
  expect((await magick.enable('on', { browser: true })).ok).toBe(true)
  fs.writeFileSync(path.join(magick.desktop, 'screenshots', 'g.png'), big)
  const viaMagick = (await view({ agent: 'main' }, undefined, magick.node)) as {
    value: DesktopScreenView
  }
  expect(viaMagick.value.data).toBe(jpeg.toString('base64'))
  expect(calls).toEqual([1440, 1280, 1024])

  // Nothing can encode: no picture, and the status says why.
  const none = await session({ screenEncoders: [async () => null] })
  expect((await none.enable('on', { browser: true })).ok).toBe(true)
  fs.writeFileSync(path.join(none.desktop, 'screenshots', 'g.png'), big)
  fs.utimesSync(path.join(none.desktop, 'screenshots', 'g.png'), 7_000, 7_000)
  expect(await view({ agent: 'main' }, undefined, none.node)).toEqual({
    ok: true,
    value: null,
  })
  expect((await none.view()).browser.reason).toContain('节点缺少图像压缩能力')
  // A picture that fits again clears it.
  fs.writeFileSync(path.join(none.desktop, 'screenshots', 'h.jpg'), jpeg)
  fs.utimesSync(path.join(none.desktop, 'screenshots', 'h.jpg'), 9_000, 9_000)
  expect(
    (
      (await view({ agent: 'main' }, undefined, none.node)) as {
        value: DesktopScreenView
      }
    ).value.at,
  ).toBe(9_000_000)
  expect((await none.view()).browser.reason).toBeNull()
})

test('memory watch: the sum over all process trees is shown, and above the cap the resource stops', async () => {
  let bytes: number | null = 100 * 1024 * 1024
  const seen: number[][] = []
  const f = await session({
    tools: ['bwrap', 'openbox'],
    memory: () => bytes,
  })
  const memory = f.launcher.memory!
  f.launcher.memory = pids => {
    seen.push([...pids])
    return memory(pids)
  }
  expect((await f.enable('on', { browser: true, computer: true })).ok).toBe(
    true,
  )
  await f.node.sweep()
  expect(seen.at(-1)).toEqual(f.pids().map(p => p.pid))
  expect((await f.view()).computer).toMatchObject({
    state: 'running',
    memoryBytes: 100 * 1024 * 1024,
    memoryLimitBytes: LIMIT,
  })
  bytes = LIMIT + 1
  await f.node.sweep()
  const view = await f.view()
  expect(view.computer.enabled).toBe(false)
  expect(view.computer.reason).toBe('内存超过上限，已停用')
  expect(view.computer.memoryBytes).toBeNull()
  expect(f.stops.length).toBe(f.calls.length)
  bytes = null
})

test('recycle ends every session process, applications included, and deletes the desktop with its home', async () => {
  const f = await session({
    tools: [...FULL, 'gedit'],
    entries: ENTRIES,
  })
  expect((await f.enable('on', { browser: true, computer: true })).ok).toBe(
    true,
  )
  if (hostTools) {
    const open = decider(
      f.node,
      'qianmo_computer_open_app',
      { app: 'gedit' },
      'g',
    )
    await committed(open)
    expect((await open('launch')).ok).toBe(true)
    expect(await open('completed')).toEqual({ ok: true })
  }
  expect(fs.existsSync(f.home)).toBe(true)
  expect(
    (
      await f.node.control(
        'desktop.recycle',
        { agent: 'main', operationId: 'recycle' },
        ctx,
      )
    ).ok,
  ).toBe(true)
  // Last started, first stopped: applications, Chromium, … Xvfb.
  expect(f.stops).toEqual(f.calls.map(c => c.pid).reverse())
  expect(fs.existsSync(f.desktop)).toBe(false)
  expect(f.pids()).toEqual([])
  expect(f.node.resource('main')).toMatchObject({
    computer: false,
    bus: null,
    display: null,
  })
  expect((await f.view()).computer).toMatchObject({
    windowManager: null,
    accessibility: false,
  })
})

test('a restarted host reaps every recorded session process by its marker before anything opens', async () => {
  const f = await session({ tools: FULL })
  expect((await f.enable('on', { browser: true, computer: true })).ok).toBe(
    true,
  )
  const recorded = f.pids()
  expect(recorded.length).toBe(5)
  const restarted = f.make()
  cleanups.push(() => restarted.close())
  const status = (await restarted.control('desktop.status', {}, ctx)) as {
    value: DesktopNodeView[]
  }
  expect(status.value[0]?.computer).toMatchObject({
    enabled: false,
    windowManager: null,
  })
  expect(f.reaped).toEqual(recorded.map(({ pid, marker }) => ({ pid, marker })))
  expect(new Set(f.reaped.map(r => r.marker))).toEqual(
    new Set([
      path.join(f.desktop, 'Xauthority'),
      f.home,
      path.join(f.desktop, 'browser'),
    ]),
  )
})

test.skipIf(!hostTools)(
  "this Mac's own desktop: listed bundle ids only, nothing started, apps opened in the background and never stopped",
  async () => {
    const f = await session({ platform: 'darwin' })
    // A list is required, and it is short.
    const all = await f.enable('all', { computer: true, apps: 'all' })
    expect(all.ok).toBe(false)
    expect(!all.ok && all.message).toContain('bundle id')
    const many = Array.from({ length: 21 }, (_, i) => `com.example.app${i}`)
    expect((await f.enable('many', { computer: true, apps: many })).ok).toBe(
      false,
    )
    const on = await f.enable('on', {
      computer: true,
      apps: ['com.apple.TextEdit', 'com.apple.Terminal'],
      confirm: 'autonomous',
    })
    expect(on.ok).toBe(true)
    // No Xvfb, no window manager, no sandbox: the owner's desktop.
    expect(f.calls).toEqual([])
    const view = await f.view()
    expect(view.computer.state).toBe('running')
    expect(view.computer.mode).toBe('host')
    expect(view.computer.supported).toBe(true)
    const resource = f.node.resource('main')!
    expect(resource.display).toBeNull()
    expect(resource.xauthority).toBeNull()
    // A listed terminal is not the agent's: its windows take no input.
    expect(resource.hostApps).toEqual(['com.apple.TextEdit'])
    // And it cannot be allowed here: the owner's shell, nothing around it.
    const shell = await f.enable('shell', {
      computer: true,
      apps: ['com.apple.TextEdit', 'com.apple.Terminal'],
      terminal: true,
    })
    expect(shell.ok).toBe(false)
    expect(!shell.ok && shell.message).toContain('终端')
    expect(f.node.resource('main')!.hostApps).toEqual(['com.apple.TextEdit'])

    // The list holds the operator's ids; a terminal is withheld.
    const list = decider(f.node, 'qianmo_computer_apps', {}, 'apps-1')
    await committed(list)
    const listed = await list('apps')
    expect(listed.ok && JSON.parse(listed.value!)).toEqual([
      { id: 'com.apple.TextEdit', name: 'TextEdit', terminal: false },
    ])
    await list('completed')

    const term = decider(
      f.node,
      'qianmo_computer_open_app',
      { app: 'com.apple.Terminal' },
      'term-1',
    )
    const refused = await term('reserve')
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.reason).toContain('终端')

    // Opening goes through `open -g -b`, not a tracked process.
    const open = decider(
      f.node,
      'qianmo_computer_open_app',
      { app: 'com.apple.TextEdit' },
      'open-1',
    )
    await committed(open)
    expect(await open('launch')).toEqual({
      ok: true,
      value: JSON.stringify({ app: 'com.apple.TextEdit' }),
    })
    await open('completed')
    expect(f.runs.filter(r => r.program === 'open').map(r => r.argv)).toEqual([
      ['-g', '-b', 'com.apple.TextEdit'],
    ])
    expect(f.pids()).toEqual([])

    // Recycling never stops the owner's applications.
    const recycled = await f.node.control(
      'desktop.recycle',
      { agent: 'main', operationId: 'recycle' },
      ctx,
    )
    expect(recycled.ok).toBe(true)
    expect(f.stops).toEqual([])
    expect(f.reaped).toEqual([])
  },
)

test('a node gives a terminal to a lone agent only: agents share its network', async () => {
  const f = await session({ tools: FULL })
  const other = (operationId: string, change: Record<string, unknown>) =>
    f.node.control(
      'desktop.enable',
      { agent: 'other', operationId, ...change },
      ctx,
    )
  expect((await other('other-on', { browser: true })).ok).toBe(true)
  const refused = await f.enable('term', { computer: true, terminal: true })
  expect(refused.ok).toBe(false)
  expect(!refused.ok && refused.message).toContain('other')
  // Without a terminal the same agent's computer opens.
  expect((await f.enable('plain', { computer: true })).ok).toBe(true)
  await f.node.control(
    'desktop.disable',
    { agent: 'other', operationId: 'other-off' },
    ctx,
  )
  expect((await f.enable('term-2', { terminal: true })).ok).toBe(true)
  const blocked = await other('other-again', { browser: true })
  expect(blocked.ok).toBe(false)
  expect(!blocked.ok && blocked.message).toContain('main')
})
