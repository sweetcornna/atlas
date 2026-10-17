// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The private browser and computer for agents on Claude Code or Codex
 * (runtimes-channels.md §6.1), host side: `RuntimeDesktopTools` against a
 * stand-in for `qm desktop-exec` that speaks its wire (commands/desktopExec.ts).
 * The host's gate decides every phase the child asks about, results reach MCP
 * as text and image parts, and a child that dies mid-call leaves the call's
 * outcome unknown. Real Chrome and the real child run in
 * runtimeDesktop.integration.test.ts.
 */

import { afterEach, expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import {
  DESKTOP_LEASE_REFUSED,
  type DesktopResource,
} from '@qianmo/extension/desktopPolicy'
import type { ResidentPermission } from '../../src/host/residentOmp.js'
import {
  RuntimeDesktopTools,
  type RuntimeDesktopSpawn,
} from '../../src/host/runtimes/desktopTools.js'

type Message = Record<string, unknown>
type CallHandler = (call: Message, child: FakeDesktopExec) => unknown

/** One `qm desktop-exec` child: the wire of commands/desktopExec.ts. */
class FakeDesktopExec extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  exitCode: number | null = null
  killed = false
  /** Every line the host wrote, in order. */
  readonly received: Message[] = []
  readonly #pending = new Map<number, (answer: unknown) => void>()
  #sequence = 0

  constructor(onCall: CallHandler) {
    super()
    const lines = createInterface({ input: this.stdin, crlfDelay: Infinity })
    lines.on('line', line => {
      const message = JSON.parse(line) as Message
      this.received.push(message)
      if (message.type === 'gate' && typeof message.id === 'number') {
        const settle = this.#pending.get(message.id)
        this.#pending.delete(message.id)
        settle?.(message.answer)
      } else if (message.type === 'call') void onCall(message, this)
    })
    // The host closes stdin when the session ends.
    lines.on('close', () => this.exit(0))
    this.send({ type: 'ready' })
  }

  send(message: Message): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }
  /** One gate phase, asked the way the real child asks it. */
  ask(
    kind: 'reserve' | 'confirm' | 'query',
    request: unknown,
  ): Promise<unknown> {
    const id = ++this.#sequence
    return new Promise(resolve => {
      this.#pending.set(id, resolve)
      this.send({ type: 'gate', id, kind, request, timeoutMs: 60_000 })
    })
  }
  exit(code: number): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.emit('exit', code, null)
  }
  kill(): boolean {
    this.killed = true
    this.exit(137)
    return true
  }
}

/** What the real executor does with a call: reserve, confirm, run. */
const gated: CallHandler = async (call, child) => {
  const phase = (name: string) => ({
    toolName: call.name,
    input: { invocationId: call.invocationId, phase: name },
  })
  const lease = (await child.ask('reserve', phase('reserve'))) as
    | { ok?: unknown; reason?: unknown }
    | undefined
  if (lease?.ok !== true) {
    child.send({
      type: 'error',
      id: call.id,
      message: `${DESKTOP_LEASE_REFUSED}: ${String(lease?.reason)}`,
    })
    return
  }
  if ((await child.ask('confirm', phase('execute'))) !== true) {
    child.send({ type: 'error', id: call.id, message: 'Desktop call denied' })
    return
  }
  child.send({
    type: 'result',
    id: call.id,
    result: { content: [{ type: 'text', text: 'clicked' }] },
  })
}

const SESSION = { agent: 'coder', sessionId: 's-1' }
const BROWSER: DesktopResource = {
  resourceId: 'r-1',
  resourceEpoch: 1,
  browser: true,
  computer: false,
  cdpUrl: 'http://127.0.0.1:9222',
  display: null,
  xauthority: null,
  downloads: '/srv/desktop/coder/downloads',
  tab: 'tab-1',
}

const tools: RuntimeDesktopTools[] = []
const restoreEnv: (() => void)[] = []
afterEach(() => {
  for (const tool of tools.splice(0)) tool.stop()
  for (const restore of restoreEnv.splice(0)) restore()
})

function setup(
  options: {
    resource?: DesktopResource
    permission?: (call: {
      toolName: string
      input: Readonly<Record<string, unknown>>
    }) => ResidentPermission
    onCall?: CallHandler
  } = {},
) {
  const spawned: RuntimeDesktopSpawn[] = []
  const children: FakeDesktopExec[] = []
  const asked: { sessionId: string; toolName: string; input: unknown }[] = []
  const desktop = new RuntimeDesktopTools({
    desktop: {
      resource: agent => (agent === 'coder' ? options.resource : undefined),
      resourcePath: agent => `/srv/desktop/${agent}/resource.json`,
    },
    permission: async (sessionId, call) => {
      asked.push({ sessionId, ...call })
      return options.permission?.(call) ?? false
    },
    argv: args => ['qm', ...args],
    spawn: input => {
      spawned.push(input)
      const child = new FakeDesktopExec(options.onCall ?? gated)
      children.push(child)
      return child as unknown as ChildProcess
    },
  })
  tools.push(desktop)
  return { desktop, spawned, children, asked }
}

test('lists the tools the resource has and claims only desktop tool names', () => {
  const { desktop } = setup({ resource: BROWSER })
  const names = desktop.specs('coder').map(spec => spec.name)
  expect(names).toContain('qianmo_browser_click')
  expect(names.some(name => name.startsWith('qianmo_computer_'))).toBe(false)
  expect(desktop.specs('reviewer')).toEqual([])
  expect(desktop.handles('qianmo_browser_click')).toBe(true)
  expect(desktop.handles('qianmo_notify')).toBe(false)
  expect(desktop.handles('Bash')).toBe(false)
})

test('a call the host refuses comes back as the tool’s error, with the host’s reason', async () => {
  const { desktop, children, asked } = setup({
    resource: BROWSER,
    permission: () => ({ ok: false, reason: 'ESTOP 已按下' }),
  })
  const args = { tab: 'tab-1', selector: '#send' }
  expect(
    await desktop.call(SESSION, '/work', 'qianmo_browser_click', args),
  ).toEqual({ ok: false, text: `${DESKTOP_LEASE_REFUSED}: ESTOP 已按下` })
  const [call, answer] = children[0]!.received
  expect(call).toMatchObject({
    type: 'call',
    id: 1,
    name: 'qianmo_browser_click',
    args,
  })
  expect(typeof call!.invocationId).toBe('string')
  expect(answer).toEqual({
    type: 'gate',
    id: 1,
    answer: { ok: false, reason: 'ESTOP 已按下' },
  })
  // The host was asked once, for this session, and nothing ran.
  expect(asked).toEqual([
    {
      sessionId: 's-1',
      toolName: 'qianmo_browser_click',
      input: { invocationId: call!.invocationId, phase: 'reserve' },
    },
  ])
})

test('every gate phase gets the host’s answer in the shape the child reads', async () => {
  const { desktop, children } = setup({
    resource: BROWSER,
    permission: call =>
      call.input.phase === 'reserve'
        ? { ok: true, value: 'lease-1' }
        : { ok: false, reason: 'not approved' },
  })
  expect(
    await desktop.call(SESSION, '/work', 'qianmo_browser_click', {
      tab: 'tab-1',
      selector: '#send',
    }),
  ).toEqual({ ok: false, text: 'Desktop call denied' })
  const answers = children[0]!.received.filter(line => line.type === 'gate')
  // A reservation carries the host's decision; a confirmation is yes or no.
  expect(answers.map(line => line.answer)).toEqual([
    { ok: true, value: 'lease-1' },
    false,
  ])

  const allowed = setup({ resource: BROWSER, permission: () => true })
  expect(
    await allowed.desktop.call(SESSION, '/work', 'qianmo_browser_click', {
      tab: 'tab-1',
      selector: '#send',
    }),
  ).toEqual({
    ok: true,
    text: 'clicked',
    content: [{ type: 'text', text: 'clicked' }],
  })
  expect(
    allowed.children[0]!.received.filter(line => line.type === 'gate').map(
      line => line.answer,
    ),
  ).toEqual([{ ok: true }, true])
})

test('the gate refuses a phase for anything but a desktop tool, without asking the host', async () => {
  const refused: unknown[] = []
  const { desktop, asked } = setup({
    resource: BROWSER,
    permission: () => true,
    onCall: async (call, child) => {
      for (const [kind, request] of [
        ['reserve', { toolName: 'Bash', input: { command: 'id' } }],
        ['confirm', { toolName: 'qianmo_notify', input: { summary: 'x' } }],
        ['query', { toolName: 'mcp__docs__search', input: {} }],
        ['reserve', { toolName: 'qianmo_browser_click', input: ['#send'] }],
        ['confirm', { toolName: 'qianmo_browser_click' }],
        ['reserve', undefined],
      ] as const)
        refused.push(await child.ask(kind, request))
      child.send({
        type: 'result',
        id: call.id,
        result: { content: [{ type: 'text', text: 'asked' }] },
      })
    },
  })
  expect(
    (await desktop.call(SESSION, '/work', 'qianmo_browser_tabs', {})).ok,
  ).toBe(true)
  const no = { ok: false, reason: '宿主拒绝了这次请求' }
  expect(refused).toEqual([no, false, no, no, false, no])
  expect(asked).toEqual([])
})

test('a host check that throws refuses the phase and is reported', async () => {
  const errors: unknown[] = []
  const desktop = new RuntimeDesktopTools({
    desktop: {
      resource: () => BROWSER,
      resourcePath: () => '/srv/desktop/coder/resource.json',
    },
    permission: async () => {
      throw new Error('ledger unavailable')
    },
    spawn: () => new FakeDesktopExec(gated) as unknown as ChildProcess,
    onError: error => errors.push(error),
  })
  tools.push(desktop)
  expect(
    await desktop.call(SESSION, '/work', 'qianmo_browser_click', {
      tab: 'tab-1',
      selector: '#send',
    }),
  ).toEqual({ ok: false, text: `${DESKTOP_LEASE_REFUSED}: 宿主授权检查出错` })
  expect(String(errors[0])).toContain('ledger unavailable')
})

test('screenshots come back as image parts; unknown or malformed parts are dropped', async () => {
  const { desktop } = setup({
    resource: BROWSER,
    onCall: (call, child) =>
      child.send({
        type: 'result',
        id: call.id,
        result: {
          content: [
            { type: 'text', text: 'Screenshot of tab-1' },
            { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
            { type: 'image', data: 'no-mime' },
            { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
            { type: 'text', text: 'saved' },
          ],
        },
      }),
  })
  expect(
    await desktop.call(SESSION, '/work', 'qianmo_browser_screenshot', {
      tab: 'tab-1',
    }),
  ).toEqual({
    ok: true,
    text: 'Screenshot of tab-1\nsaved',
    content: [
      { type: 'text', text: 'Screenshot of tab-1' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      { type: 'text', text: 'saved' },
    ],
  })
})

test('a child that exits mid-call leaves the outcome unknown and is not reused', async () => {
  const { desktop, children, spawned } = setup({
    resource: BROWSER,
    onCall: () => {},
  })
  const first = desktop.call(SESSION, '/work', 'qianmo_browser_click', {
    tab: 'tab-1',
    selector: '#send',
  })
  const second = desktop.call(SESSION, '/work', 'qianmo_browser_tabs', {})
  while (children[0]!.received.length < 2) await Bun.sleep(5)
  children[0]!.exit(1)
  const unknown = {
    ok: false,
    text: '专属电脑的执行进程已退出；这次操作的结果未知，不要自动重试',
  }
  expect(await first).toEqual(unknown)
  expect(await second).toEqual(unknown)
  // Two calls, one child; the next call starts a new one.
  expect(spawned).toHaveLength(1)
  const next = desktop.call(SESSION, '/work', 'qianmo_browser_tabs', {})
  expect(spawned).toHaveLength(2)
  children[1]!.exit(1)
  expect(await next).toEqual(unknown)
})

test('closing the session ends the child through its stdin', async () => {
  const { desktop, children } = setup({ resource: BROWSER })
  const call = desktop.call(SESSION, '/work', 'qianmo_browser_tabs', {})
  desktop.close('s-1')
  expect(await call).toMatchObject({ ok: false })
  expect(children[0]!.exitCode).toBe(0)
  expect(children[0]!.killed).toBe(false)
})

/** Sets `name` in the host's environment for one test. */
function hostEnv(name: string, value: string): void {
  const previous = process.env[name]
  process.env[name] = value
  restoreEnv.push(() => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  })
}

test('the child gets the private display, Xauthority and D-Bus from the resource, never the host’s', async () => {
  hostEnv('DISPLAY', ':0')
  hostEnv('XAUTHORITY', '/home/node/.Xauthority')
  hostEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/run/user/1000/bus')
  hostEnv('WAYLAND_DISPLAY', 'wayland-0')
  const computer: DesktopResource = {
    ...BROWSER,
    computer: true,
    display: ':42',
    xauthority: '/srv/desktop/coder/Xauthority',
    bus: 'unix:path=/srv/desktop/coder/bus',
  }
  const run = async (resource: DesktopResource) => {
    const { desktop, spawned } = setup({
      resource,
      onCall: (call, child) =>
        child.send({ type: 'result', id: call.id, result: { content: [] } }),
    })
    await desktop.call(SESSION, '/work', 'qianmo_browser_tabs', {})
    return spawned[0]!
  }

  const display = await run(computer)
  expect(display.argv).toEqual([
    'qm',
    'desktop-exec',
    '--resource',
    '/srv/desktop/coder/resource.json',
    '--cwd',
    '/work',
  ])
  expect(display.cwd).toBe('/work')
  expect(display.env.DISPLAY).toBe(':42')
  expect(display.env.XAUTHORITY).toBe('/srv/desktop/coder/Xauthority')
  expect(display.env.DBUS_SESSION_BUS_ADDRESS).toBe(
    'unix:path=/srv/desktop/coder/bus',
  )
  expect(display.env.WAYLAND_DISPLAY).toBeUndefined()
  // Screenshots land next to the downloads, inside the resource.
  expect(display.env.TMPDIR).toBe('/srv/desktop/coder/screenshots')

  // A private display without a bus: the host's bus does not leak in.
  const busless = await run({ ...computer, bus: null })
  expect(busless.env.DISPLAY).toBe(':42')
  expect(busless.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()

  // The browser alone: no display at all.
  const browser = await run(BROWSER)
  expect(browser.env.DISPLAY).toBeUndefined()
  expect(browser.env.XAUTHORITY).toBeUndefined()
  expect(browser.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
  expect(browser.env.WAYLAND_DISPLAY).toBeUndefined()
  expect(browser.env.TMPDIR).toBe('/srv/desktop/coder/screenshots')
})
