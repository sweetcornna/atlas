// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  DesktopExecutor,
  type DesktopCall,
  type DesktopGateRequest,
  type DesktopGateway,
  type DesktopPrelude,
  type DesktopPreludes,
  type DesktopResult,
} from '../src/desktopExec.js'
import {
  desktopArgs,
  type DesktopDecision,
  type DesktopTool,
} from '../src/desktopPolicy.js'

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

interface Step {
  readonly method: string
  readonly args: readonly unknown[]
}
const WINDOWS = [
  {
    id: '0x2',
    app: 'xterm',
    title: 'b',
    pid: 7,
    x: 10,
    y: 10,
    width: 300,
    height: 200,
    focused: false,
  },
  {
    id: '0x1',
    app: 'chromium',
    title: 'a',
    pid: 5,
    x: 0,
    y: 0,
    width: 1440,
    height: 900,
    focused: true,
  },
]
const IMAGE = { type: 'image' as const, data: 'AAAA', mimeType: 'image/png' }

/**
 * A computer prelude that answers like the base: `windows()` returns its
 * list in `details.value`, screenshots emit a text line and an image, input
 * returns nothing. Every screenshot differs, as on a live desktop.
 */
function fakeComputer(
  opts: {
    windows?: () => unknown
    fail?: (chain: readonly Step[]) => Error | undefined
    control?: (method: string) => Error | undefined
  } = {},
) {
  const chains: Step[][] = []
  /** Input control around a private display's input, kept apart (see below). */
  const controls: string[] = []
  let frame = 0
  const prelude: DesktopPrelude = {
    async invoke(parameters, context) {
      const p = parameters as { action: string; chain?: Step[] }
      if (p.action !== 'call') return { content: [] }
      const chain = p.chain!
      const method = chain[0]!.method
      if (
        method.startsWith('control.') ||
        context.toolCallId.endsWith(':warm')
      ) {
        controls.push(
          method === 'control.acquire'
            ? `acquire:${context.context?.ui ? 'ui' : 'headless'}`
            : method.startsWith('control.')
              ? method.slice('control.'.length)
              : `warm:${JSON.stringify(chain)}`,
        )
        const error = opts.control?.(method)
        if (error) throw error
        return { content: [], details: { value: { active: true } } }
      }
      chains.push(chain)
      context.signal?.throwIfAborted()
      const error = opts.fail?.(chain)
      if (error) throw error
      const last = chain.at(-1)!.method
      if (last === 'windows')
        return {
          content: [],
          details: {
            screenshots: [],
            value: (opts.windows ?? (() => WINDOWS))(),
          },
        }
      if (last === 'screenshot' || last === 'zoom' || last === 'observe')
        return {
          content: [
            { type: 'text', text: `${last} ${chain[0]!.method}` },
            { ...IMAGE, data: `frame-${frame++}` },
          ],
          details: { screenshots: [{ path: '/tmp/x.png' }] },
        }
      if (last === 'clipboard.read')
        return { content: [], details: { screenshots: [], value: 'clipped' } }
      return { content: [], details: { screenshots: [] } }
    },
  }
  return { prelude, chains, controls, inputs: () => chains.filter(isInput) }
}
const isInput = (chain: readonly Step[]) =>
  !['windows', 'screenshot'].includes(chain.at(-1)!.method) || chain.length > 1

function fakeGateway(
  opts: {
    reserve?: DesktopDecision
    confirm?: (phase: string) => boolean
    query?: (request: DesktopGateRequest) => DesktopDecision
  } = {},
) {
  const seen: { kind: string; request: DesktopGateRequest }[] = []
  const gateway: DesktopGateway = {
    async reserve(request) {
      seen.push({ kind: 'reserve', request })
      return opts.reserve ?? { ok: true }
    },
    async confirm(request) {
      seen.push({ kind: 'confirm', request })
      return opts.confirm?.(String(request.input.phase)) ?? true
    },
    async query(request) {
      seen.push({ kind: 'query', request })
      return opts.query?.(request) ?? { ok: true, value: '[{"id":"xterm"}]' }
    },
  }
  return {
    gateway,
    seen,
    phases: () => seen.map(s => String(s.request.input.phase)),
  }
}

function resourceFile(change: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-exec-'))
  roots.push(root)
  const file = path.join(root, 'resource.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      resourceId: 'res-1',
      resourceEpoch: 3,
      browser: false,
      computer: true,
      cdpUrl: null,
      display: ':99',
      xauthority: null,
      downloads: path.join(root, 'downloads'),
      tab: 'res-1:3:main',
      ...change,
    }),
  )
  return file
}

function setup(
  computer = fakeComputer(),
  browser?: DesktopPrelude,
  resource: Record<string, unknown> = {},
) {
  const preludes: DesktopPreludes = {
    computer: () => computer.prelude,
    ...(browser ? { browser: () => browser } : {}),
  }
  const executor = new DesktopExecutor(
    resourceFile(resource),
    os.tmpdir(),
    preludes,
  )
  const run = (
    name: DesktopTool,
    args: unknown,
    gateway: DesktopGateway,
    extra: { original?: unknown; signal?: AbortSignal } = {},
  ) => {
    const call: DesktopCall = {
      name,
      invocationId: 'call_1|fc_1',
      original: 'original' in extra ? extra.original : args,
      args,
      agentKind: 'main',
      ...(extra.signal ? { signal: extra.signal } : {}),
    }
    return executor.run(call, gateway)
  }
  return { executor, computer, run }
}
const texts = (result: DesktopResult) =>
  result.content.flatMap(part => (part.type === 'text' ? [part.text] : []))

test('each computer tool maps to one fixed base call chain, with the window hop when asked', async () => {
  const cases: [DesktopTool, Record<string, unknown>, Step[]][] = [
    ['qianmo_computer_screenshot', {}, [{ method: 'screenshot', args: [] }]],
    [
      'qianmo_computer_screenshot',
      { window: '0x2' },
      [
        { method: 'window', args: ['0x2'] },
        { method: 'screenshot', args: [] },
      ],
    ],
    [
      'qianmo_computer_zoom',
      { x: 1, y: 2, width: 30, height: 40 },
      [{ method: 'zoom', args: [{ x: 1, y: 2, width: 30, height: 40 }] }],
    ],
    ['qianmo_computer_windows', {}, [{ method: 'windows', args: [] }]],
    [
      'qianmo_computer_observe',
      { window: '0x1' },
      [
        { method: 'window', args: ['0x1'] },
        { method: 'observe', args: [] },
      ],
    ],
    [
      'qianmo_computer_clipboard_read',
      {},
      [{ method: 'clipboard.read', args: [] }],
    ],
    [
      'qianmo_computer_clipboard_write',
      { text: 'hi' },
      [{ method: 'clipboard.write', args: ['hi'] }],
    ],
    [
      'qianmo_computer_click',
      { x: 3, y: 4 },
      [{ method: 'click', args: [3, 4] }],
    ],
    [
      'qianmo_computer_click',
      {
        x: 3,
        y: 4,
        button: 'right',
        count: 2,
        keys: 'Ctrl',
        window: '0x2',
        confirm: 'why',
      },
      [
        { method: 'window', args: ['0x2'] },
        {
          method: 'click',
          args: [3, 4, { button: 'right', count: 2, modifiers: ['ctrl'] }],
        },
      ],
    ],
    [
      'qianmo_computer_type',
      { text: 'abc' },
      [{ method: 'type', args: ['abc'] }],
    ],
    [
      'qianmo_computer_key',
      { key: 'Ctrl+Shift+T' },
      [{ method: 'press', args: ['ctrl+shift+t'] }],
    ],
    [
      'qianmo_computer_scroll',
      { x: 1, y: 2, dx: 0, dy: -5 },
      [{ method: 'scroll', args: [1, 2, { dx: 0, dy: -5 }] }],
    ],
    [
      'qianmo_computer_focus',
      { window: '0x2' },
      [
        { method: 'window', args: ['0x2'] },
        { method: 'raise', args: [] },
      ],
    ],
    [
      'qianmo_computer_element',
      { ref: 'e12', action: 'set_value', value: 'v' },
      [
        { method: 'ref', args: ['e12'] },
        { method: 'setValue', args: ['v'] },
      ],
    ],
    [
      'qianmo_computer_element',
      { ref: 'e3', action: 'press' },
      [
        { method: 'ref', args: ['e3'] },
        { method: 'press', args: [] },
      ],
    ],
    [
      'qianmo_computer_menu',
      { window: '0x1', path: ['File', 'Save'] },
      [
        { method: 'window', args: ['0x1'] },
        { method: 'menu.select', args: [['File', 'Save']] },
      ],
    ],
  ]
  for (const [name, args, chain] of cases) {
    const { run, computer } = setup()
    const gate = fakeGateway()
    const result = await run(name, args, gate.gateway)
    // Two layout observations around the approval, then the call itself.
    expect(computer.chains.slice(0, 2), name).toEqual([
      [{ method: 'windows', args: [] }],
      [{ method: 'windows', args: [] }],
    ])
    expect(computer.chains.slice(2), name).toEqual([chain])
    expect(gate.phases(), name).toEqual([
      'reserve',
      'authorize',
      'commit',
      'completed',
    ])
    expect(result.content.length, name).toBeGreaterThan(0)
  }
})

test('the gate sees the canonical binding and the window layout, not pixels', async () => {
  const { run } = setup()
  const gate = fakeGateway()
  const raw = { y: 4, x: 3, keys: ['CMD'], confirm: '删除' }
  await run('qianmo_computer_click', raw, gate.gateway)
  const args = desktopArgs('qianmo_computer_click', raw)
  const layout = [...WINDOWS]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map(w => ({
      id: w.id,
      app: w.app,
      title: w.title,
      bounds: { x: w.x, y: w.y, width: w.width, height: w.height },
      focused: w.focused,
    }))
  for (const { request } of gate.seen) {
    expect(request.toolName).toBe('qianmo_computer_click')
    expect(request.input).toMatchObject({
      invocationId: 'call_1|fc_1',
      resourceId: 'res-1',
      resourceEpoch: 3,
      args,
      canonicalArgsDigest: digest(args),
    })
  }
  const authorize = gate.seen.find(s => s.request.input.phase === 'authorize')!
  expect(authorize.request.input.observedTargetDigest).toBe(digest(layout))
  expect(authorize.request.input.host).toBeNull()
})

test('a window list that cannot be read falls back to the screenshot digest for both observations', async () => {
  const computer = fakeComputer({
    fail: chain =>
      chain.at(-1)!.method === 'windows'
        ? new Error('no window manager')
        : undefined,
    // Same pixels both times: no caret on this fake desktop.
  })
  let shots = 0
  const stable: DesktopPrelude = {
    async invoke(parameters, context) {
      const chain = (parameters as { chain: Step[] }).chain
      if (chain.at(-1)!.method === 'screenshot' && chain.length === 1) {
        computer.chains.push(chain)
        shots++
        return { content: [IMAGE], details: {} }
      }
      return computer.prelude.invoke(parameters, context)
    },
  }
  const executor = new DesktopExecutor(resourceFile(), os.tmpdir(), {
    computer: () => stable,
  })
  const gate = fakeGateway()
  await executor.run(
    {
      name: 'qianmo_computer_type',
      invocationId: 'i',
      original: { text: 'a' },
      args: { text: 'a' },
      agentKind: 'main',
    },
    gate.gateway,
  )
  expect(shots).toBe(2)
  const authorize = gate.seen.find(s => s.request.input.phase === 'authorize')!
  expect(authorize.request.input.observedTargetDigest).toBe(digest([IMAGE]))
  expect(computer.chains.at(-1)).toEqual([{ method: 'type', args: ['a'] }])
})

test('a desktop that changes during approval is not touched', async () => {
  let calls = 0
  const computer = fakeComputer({
    windows: () =>
      calls++ === 0
        ? WINDOWS
        : WINDOWS.map(w => ({ ...w, focused: w.id === '0x2' })),
  })
  const { run } = setup(computer)
  const gate = fakeGateway()
  await expect(
    run('qianmo_computer_click', { x: 1, y: 1 }, gate.gateway),
  ).rejects.toThrow('Desktop target changed during approval')
  expect(computer.inputs()).toEqual([])
  expect(gate.phases()).toEqual(['reserve', 'authorize', 'failed'])
})

test('a batch runs step by step on one target, sleeps its waits, and ends with a screenshot', async () => {
  const { run, computer } = setup()
  const gate = fakeGateway()
  const started = Date.now()
  const result = await run(
    'qianmo_computer_actions',
    {
      window: '0x1',
      actions: [
        { type: 'click', x: 1, y: 2, keys: 'shift' },
        { type: 'double_click', x: 3, y: 4 },
        { type: 'move', x: 5, y: 6 },
        {
          type: 'drag',
          path: [
            [0, 0],
            [9, 9],
          ],
          keys: 'alt',
        },
        { type: 'scroll', x: 1, y: 1, dx: 2, dy: 3 },
        { type: 'type', text: 'hello' },
        { type: 'keypress', keys: 'ctrl+s' },
        { type: 'wait', ms: 60 },
        { type: 'hold_keys', keys: ['shift'], seconds: 0.5 },
        { type: 'hold_mouse', x: 7, y: 8, button: 'middle', seconds: 1 },
      ],
    },
    gate.gateway,
  )
  expect(Date.now() - started).toBeGreaterThanOrEqual(55)
  const hop = { method: 'window', args: ['0x1'] }
  expect(computer.chains.slice(2)).toEqual([
    [hop, { method: 'click', args: [1, 2, { modifiers: ['shift'] }] }],
    [hop, { method: 'doubleClick', args: [3, 4] }],
    [hop, { method: 'move', args: [5, 6] }],
    [
      hop,
      {
        method: 'drag',
        args: [
          [
            [0, 0],
            [9, 9],
          ],
          { keys: ['alt'] },
        ],
      },
    ],
    [hop, { method: 'scroll', args: [1, 1, { dx: 2, dy: 3 }] }],
    [hop, { method: 'type', args: ['hello'] }],
    [hop, { method: 'press', args: [['ctrl', 's']] }],
    [hop, { method: 'holdKeys', args: [['shift'], { duration: 0.5 }] }],
    [
      hop,
      { method: 'holdMouse', args: [7, 8, { duration: 1, button: 'middle' }] },
    ],
    [hop, { method: 'screenshot', args: [] }],
  ])
  expect(texts(result)[0]).toBe(
    'Completed 10 of 10 actions: 1 click, 2 double_click, 3 move, 4 drag, 5 scroll, 6 type, 7 keypress, 8 wait 60 ms, 9 hold_keys, 10 hold_mouse.',
  )
  expect(result.content.some(part => part.type === 'image')).toBe(true)
  expect(gate.phases()).toEqual(['reserve', 'authorize', 'commit', 'completed'])
})

test('a batch stops at the first failing step and says which one', async () => {
  const computer = fakeComputer({
    fail: chain =>
      chain.at(-1)!.method === 'type'
        ? new Error('keyboard unavailable')
        : undefined,
  })
  const { run } = setup(computer)
  const gate = fakeGateway()
  const error = await run(
    'qianmo_computer_actions',
    {
      actions: [
        { type: 'click', x: 1, y: 2 },
        { type: 'type', text: 'x' },
        { type: 'keypress', keys: 'enter' },
      ],
    },
    gate.gateway,
  ).catch((e: Error) => e)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe(
    'Desktop actions stopped at step 2 of 3 (type): 前 1 步已执行，后面的没有执行；keyboard unavailable',
  )
  expect(computer.inputs().map(chain => chain.at(-1)!.method)).toEqual([
    'click',
    'type',
  ])
  // Something may have happened on screen: the host records it as unknown.
  expect(gate.phases()).toEqual(['reserve', 'authorize', 'commit', 'unknown'])

  const first = setup(
    fakeComputer({
      fail: chain =>
        chain.at(-1)!.method === 'click' ? new Error('no pointer') : undefined,
    }),
  )
  await expect(
    first.run(
      'qianmo_computer_actions',
      {
        actions: [
          { type: 'click', x: 1, y: 2 },
          { type: 'wait', ms: 1 },
        ],
      },
      fakeGateway().gateway,
    ),
  ).rejects.toThrow('step 1 of 2 (click): 后面的步骤都没有执行；no pointer')
})

test('a wait ends at once when the call is aborted', async () => {
  const { run, computer } = setup()
  const gate = fakeGateway()
  const abort = new AbortController()
  const started = Date.now()
  const pending = run(
    'qianmo_computer_actions',
    {
      actions: [
        { type: 'wait', ms: 25000 },
        { type: 'click', x: 1, y: 1 },
      ],
    },
    gate.gateway,
    { signal: abort.signal },
  )
  setTimeout(() => abort.abort(new Error('stopped by the operator')), 30)
  await expect(pending).rejects.toThrow('stopped by the operator')
  expect(Date.now() - started).toBeLessThan(5000)
  expect(computer.inputs()).toEqual([])
  expect(gate.phases()).toEqual(['reserve', 'authorize', 'commit', 'unknown'])
})

test('apps and open_app go to the host after commit and return its value as text', async () => {
  const { run, computer } = setup()
  const gate = fakeGateway({
    query: request =>
      request.input.phase === 'apps'
        ? {
            ok: true,
            value: JSON.stringify([
              { id: 'xterm', name: 'XTerm', terminal: true },
            ]),
          }
        : { ok: true, value: JSON.stringify({ app: 'xterm', pid: 41 }) },
  })
  const apps = await run('qianmo_computer_apps', {}, gate.gateway)
  expect(texts(apps)).toEqual([
    '[{"id":"xterm","name":"XTerm","terminal":true}]',
  ])
  const opened = await run(
    'qianmo_computer_open_app',
    { app: 'xterm', confirm: '打开终端' },
    gate.gateway,
  )
  expect(texts(opened)).toEqual(['{"app":"xterm","pid":41}'])
  expect(computer.inputs()).toEqual([])
  const queries = gate.seen.filter(s => s.kind === 'query')
  expect(queries.map(q => q.request.input.phase)).toEqual(['apps', 'launch'])
  const launch = queries[1]!.request
  const args = desktopArgs('qianmo_computer_open_app', {
    app: 'xterm',
    confirm: '打开终端',
  })
  expect(launch).toEqual({
    toolName: 'qianmo_computer_open_app',
    input: {
      invocationId: 'call_1|fc_1',
      resourceId: 'res-1',
      resourceEpoch: 3,
      args,
      canonicalArgsDigest: digest(args),
      phase: 'launch',
    },
  })
  // The query comes after commit and before the receipt.
  expect(gate.phases().slice(5)).toEqual([
    'reserve',
    'authorize',
    'commit',
    'launch',
    'completed',
  ])
})

test('a refused launch carries the host reason and leaves no success receipt', async () => {
  const { run } = setup()
  const gate = fakeGateway({
    query: () => ({ ok: false, reason: '打开应用需要 bubblewrap' }),
  })
  await expect(
    run('qianmo_computer_open_app', { app: 'xterm' }, gate.gateway),
  ).rejects.toThrow('Desktop lease refused: 打开应用需要 bubblewrap')
  expect(gate.phases()).toEqual([
    'reserve',
    'authorize',
    'commit',
    'launch',
    'unknown',
  ])
  const empty = fakeGateway({ query: () => ({ ok: true }) })
  await expect(
    setup().run('qianmo_computer_apps', {}, empty.gateway),
  ).rejects.toThrow('without a result')
})

test('malformed, repaired or unoriginal calls are refused before any lease, and the refusal is still reported', async () => {
  for (const [args, original, message] of [
    [
      { x: 1, y: 2, code: '1' },
      undefined,
      'Unknown or missing desktop argument',
    ],
    [
      { x: 1, y: 2 },
      { x: 1, y: 2, button: 'side' },
      'Invalid desktop argument',
    ],
    [
      { x: 1, y: 2 },
      { x: 1, y: 3 },
      'Desktop arguments changed before execution',
    ],
    [{ x: 1, y: 2 }, null, 'Missing original desktop invocation'],
  ] as const) {
    const { run, computer } = setup()
    const gate = fakeGateway()
    await expect(
      run('qianmo_computer_click', args, gate.gateway, {
        original: original === null ? undefined : (original ?? args),
      }),
    ).rejects.toThrow(message)
    expect(computer.chains).toEqual([])
    expect(gate.seen).toEqual([
      {
        kind: 'confirm',
        request: {
          toolName: 'qianmo_computer_click',
          input: {
            phase: 'refused',
            invocationId: 'call_1|fc_1',
            canonicalArgsDigest: digest(
              original === null ? args : (original ?? args),
            ),
          },
        },
      },
    ])
  }
  // A computer tool on a browser-only resource says how to switch it on.
  const off = setup(fakeComputer(), undefined, { computer: false })
  const gate = fakeGateway()
  await expect(
    off.run('qianmo_computer_windows', {}, gate.gateway),
  ).rejects.toThrow('Desktop unavailable')
  expect(gate.phases()).toEqual(['refused'])
})

test('a refused lease stops before the desktop is observed', async () => {
  const { run, computer } = setup()
  const gate = fakeGateway({
    reserve: { ok: false, reason: '急停已开启' },
  })
  await expect(
    run(
      'qianmo_computer_actions',
      { actions: [{ type: 'wait', ms: 1 }] },
      gate.gateway,
    ),
  ).rejects.toThrow('Desktop lease refused: 急停已开启')
  expect(computer.chains).toEqual([])
  expect(gate.phases()).toEqual(['reserve'])
})

test('a denied approval runs nothing', async () => {
  const { run, computer } = setup()
  const gate = fakeGateway({ confirm: phase => phase !== 'authorize' })
  await expect(
    run('qianmo_computer_type', { text: 'a' }, gate.gateway),
  ).rejects.toThrow('Operator approval denied')
  expect(computer.inputs()).toEqual([])
  expect(gate.phases()).toEqual(['reserve', 'authorize', 'failed'])
})

test('browser tools keep their path: attach, url plus page snapshot as target, host on authorize', async () => {
  const calls: unknown[] = []
  const browser: DesktopPrelude = {
    async invoke(parameters) {
      calls.push(parameters)
      const p = parameters as { action: string; chain?: Step[] }
      if (p.action !== 'call') return { content: [] }
      const method = p.chain![0]!.method
      if (method === 'url')
        return { content: [], details: { value: 'https://before.test/' } }
      if (method === 'ariaSnapshot')
        return { content: [], details: { value: '- heading "x"' } }
      return { content: [], details: { value: 'ok' } }
    },
  }
  const { run, computer } = setup(fakeComputer(), browser, {
    browser: true,
    cdpUrl: 'http://127.0.0.1:9222',
  })
  const gate = fakeGateway()
  const tab = 'res-1:3:main'
  const result = await run(
    'qianmo_browser_navigate',
    { tab, url: 'https://example.test/path' },
    gate.gateway,
  )
  expect(computer.chains).toEqual([])
  expect(calls.slice(0, 2)).toMatchObject([
    { action: 'close', all: true },
    { action: 'open', name: tab },
  ])
  expect(calls.slice(2).map(c => (c as { chain: Step[] }).chain[0])).toEqual([
    { method: 'url', args: [] },
    { method: 'ariaSnapshot', args: [] },
    { method: 'url', args: [] },
    { method: 'ariaSnapshot', args: [] },
    { method: 'goto', args: ['https://example.test/path'] },
  ])
  const authorize = gate.seen.find(s => s.request.input.phase === 'authorize')!
  expect(authorize.request.input.host).toBe('example.test')
  expect(authorize.request.input.observedTargetDigest).toBe(
    digest({
      url: { value: 'https://before.test/' },
      page: { value: '- heading "x"' },
    }),
  )
  expect(texts(result)).toEqual(['ok'])
})

test('a strict-mode call with null optionals runs as the repaired call omp hands over', async () => {
  const { run, computer } = setup()
  const gate = fakeGateway()
  await run('qianmo_computer_click', { x: 1, y: 2 }, gate.gateway, {
    original: { x: 1, y: 2, button: null, window: null, confirm: null },
  })
  expect(computer.chains.at(-1)).toEqual([{ method: 'click', args: [1, 2] }])
  expect(gate.phases()).toEqual(['reserve', 'authorize', 'commit', 'completed'])
})

test("this Mac's own desktop: only the listed applications' windows, input in the background, the rest of the screen never captured", async () => {
  const HOST_WINDOWS = [
    { ...WINDOWS[0]!, id: '41', app: 'TextEdit', pid: 70 },
    { ...WINDOWS[1]!, id: '42', app: 'Mail', pid: 80 },
  ]
  const computer = fakeComputer({ windows: () => HOST_WINDOWS })
  const base = computer.prelude
  // The base answers `apps.list` with bundle ids and running pids.
  computer.prelude = {
    invoke(parameters, context) {
      const chain = (parameters as { chain?: Step[] }).chain
      if (chain?.at(-1)?.method === 'apps.list') {
        computer.chains.push(chain)
        return Promise.resolve({
          content: [],
          details: {
            value: [
              { id: 'com.apple.TextEdit', name: 'TextEdit', pid: 70 },
              { id: 'com.apple.mail', name: 'Mail', pid: 80 },
            ],
          },
        })
      }
      return base.invoke(parameters, context)
    },
  }
  const { run } = setup(computer, undefined, {
    display: null,
    hostApps: ['com.apple.TextEdit'],
  })

  // The window list holds only the listed application's windows.
  const listed = await run('qianmo_computer_windows', {}, fakeGateway().gateway)
  const windows = JSON.parse(texts(listed).join('')) as { id: string }[]
  expect(windows.map(w => w.id)).toEqual(['41'])

  // Every input says takeover: false.
  computer.chains.length = 0
  await run(
    'qianmo_computer_actions',
    {
      window: '41',
      actions: [
        { type: 'click', x: 5, y: 6 },
        { type: 'type', text: 'hi' },
        { type: 'keypress', keys: ['super', 's'] },
        { type: 'scroll', x: 1, y: 2, dx: 0, dy: 3 },
      ],
    },
    fakeGateway().gateway,
  )
  const inputs = computer.chains.filter(
    c => c[0]!.method === 'window' && c[1]!.method !== 'screenshot',
  )
  expect(inputs.map(c => c[1])).toEqual([
    { method: 'click', args: [5, 6, { takeover: false }] },
    { method: 'type', args: ['hi', { takeover: false }] },
    { method: 'press', args: [['super', 's'], { takeover: false }] },
    { method: 'scroll', args: [1, 2, { dx: 0, dy: 3, takeover: false }] },
  ])
  // Captures are of the window, never the whole screen.
  expect(
    computer.chains.some(c => c.length === 1 && c[0]!.method === 'screenshot'),
  ).toBe(false)

  // A window of another application is refused before any input.
  computer.chains.length = 0
  const other = fakeGateway()
  await expect(
    run('qianmo_computer_click', { window: '42', x: 1, y: 1 }, other.gateway),
  ).rejects.toThrow('Desktop window not allowed')
  expect(computer.inputs().filter(c => c.length > 1)).toEqual([])
  expect(other.phases()).toEqual(['reserve', 'failed'])

  // Input without a window is refused before the lease.
  const bare = fakeGateway()
  await expect(
    run('qianmo_computer_screenshot', {}, bare.gateway),
  ).rejects.toThrow('Desktop window required')
  expect(bare.phases()).toEqual(['refused'])

  // The owner's clipboard and foreground are not offered.
  await expect(
    run('qianmo_computer_clipboard_read', {}, fakeGateway().gateway),
  ).rejects.toThrow('不提供剪贴板')
  await expect(
    run('qianmo_computer_focus', { window: '41' }, fakeGateway().gateway),
  ).rejects.toThrow('不切换主人的前台窗口')
})

test('a private display takes input control for each input call: the keyboard warmed once, released after, a busy lock waited out', async () => {
  let busy = 2
  const computer = fakeComputer({
    control: method =>
      method === 'control.acquire' && busy-- > 0
        ? new Error(
            'InputBusy: another desktop operation owns input/focus control; no input was sent',
          )
        : undefined,
  })
  const { run } = setup(computer)
  await run('qianmo_computer_screenshot', {}, fakeGateway().gateway)
  expect(computer.controls).toEqual([])
  await run('qianmo_computer_type', { text: 'hi' }, fakeGateway().gateway)
  await run(
    'qianmo_computer_key',
    { key: 'ctrl+s', window: '0x1' },
    fakeGateway().gateway,
  )
  expect(computer.controls).toEqual([
    `warm:${JSON.stringify([{ method: 'press', args: ['shift'] }])}`,
    'acquire:ui',
    'acquire:ui',
    'acquire:ui',
    'release',
    'acquire:ui',
    'release',
  ])
  // A failed call still gives control back.
  computer.controls.length = 0
  const failing = setup(
    fakeComputer({
      fail: chain =>
        chain.at(-1)!.method === 'click' ? new Error('no click') : undefined,
    }),
  )
  await expect(
    failing.run('qianmo_computer_click', { x: 1, y: 2 }, fakeGateway().gateway),
  ).rejects.toThrow('no click')
  expect(failing.computer.controls.at(-1)).toBe('release')
})

test("this Mac's own desktop never takes input control", async () => {
  const computer = fakeComputer({
    windows: () => [{ ...WINDOWS[0]!, id: '41', app: 'TextEdit', pid: 70 }],
  })
  const base = computer.prelude
  computer.prelude = {
    invoke(parameters, context) {
      const chain = (parameters as { chain?: Step[] }).chain
      if (chain?.at(-1)?.method === 'apps.list')
        return Promise.resolve({
          content: [],
          details: { value: [{ id: 'com.apple.TextEdit', pid: 70 }] },
        })
      return base.invoke(parameters, context)
    },
  }
  const { run } = setup(computer, undefined, {
    display: null,
    hostApps: ['com.apple.TextEdit'],
  })
  await run(
    'qianmo_computer_type',
    { text: 'hi', window: '41' },
    fakeGateway().gateway,
  )
  expect(computer.controls).toEqual([])
})
