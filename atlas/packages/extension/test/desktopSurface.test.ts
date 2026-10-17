// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { Type as OmpType } from '@oh-my-pi/omptype/typebox'
import { Type as HostType } from '@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox'
import {
  DESKTOP_INTENT_FIELD,
  desktopArgs,
  desktopNeedsApproval,
  desktopObservation,
  desktopSummary,
  desktopToolDescription,
  desktopToolSchema,
  desktopTools,
  type DesktopTool,
} from '../src/desktopPolicy.js'
import { desktopParameters } from '../src/desktop.js'

const ALL = desktopTools({ browser: true, computer: true })
const COMPUTER = desktopTools({ browser: false, computer: true })
// The host's Type.Unsafe validates with the base's JSON Schema validator.
const accepts = (name: DesktopTool, value: unknown) =>
  HostType.Unsafe(desktopToolSchema(name)).safeParse(value).success
const fails = (name: DesktopTool, raw: unknown, message: string) =>
  expect(() => desktopArgs(name, raw)).toThrow(message)

/** Every action kind of §6.2 once, keys deliberately out of order. */
const BATCH = {
  window: '0x1a00007',
  actions: [
    { y: 20, type: 'click', x: 10, keys: 'Control', count: 2, button: 'right' },
    { type: 'double_click', x: 1, y: 2 },
    { type: 'move', x: -5, y: 5.5 },
    {
      type: 'drag',
      path: [
        [0, 0],
        [10, 10],
        [20, 0],
      ],
      keys: ['Shift'],
    },
    { type: 'scroll', x: 1, y: 1, dx: 0, dy: -3 },
    { type: 'type', text: 'hello' },
    { type: 'keypress', keys: 'CTRL+Shift+t' },
    { type: 'hold_keys', keys: ['alt', 'TAB'], seconds: 1.5 },
    { type: 'hold_mouse', x: 3, y: 4, seconds: 2 },
    { type: 'wait', ms: 500 },
  ],
  confirm: '删除这些文件后不可恢复',
}

test('the tool surface is §6.2: nine browser tools unchanged, sixteen computer tools', () => {
  expect(ALL.filter(name => name.startsWith('qianmo_browser_'))).toEqual([
    'qianmo_browser_tabs',
    'qianmo_browser_screenshot',
    'qianmo_browser_read_page',
    'qianmo_browser_find',
    'qianmo_browser_navigate',
    'qianmo_browser_click',
    'qianmo_browser_type',
    'qianmo_browser_press',
    'qianmo_browser_scroll',
  ])
  expect<string[]>([...COMPUTER].sort()).toEqual(
    [
      'screenshot',
      'zoom',
      'windows',
      'observe',
      'apps',
      'clipboard_read',
      'actions',
      'click',
      'type',
      'key',
      'scroll',
      'focus',
      'element',
      'menu',
      'open_app',
      'clipboard_write',
    ]
      .map(op => `qianmo_computer_${op}`)
      .sort(),
  )
  expect<string[]>(COMPUTER.filter(desktopObservation).sort()).toEqual(
    ['apps', 'clipboard_read', 'observe', 'screenshot', 'windows', 'zoom']
      .map(op => `qianmo_computer_${op}`)
      .sort(),
  )
  // The browser schemas are the v1.4 flat ones, field for field.
  expect(desktopToolSchema('qianmo_browser_type')).toEqual({
    type: 'object',
    properties: {
      tab: { type: 'string', maxLength: 2000 },
      selector: { type: 'string', maxLength: 2000 },
      text: { type: 'string', maxLength: 16000 },
    },
    required: ['tab', 'selector', 'text'],
    additionalProperties: false,
  })
  expect(desktopToolSchema('qianmo_browser_scroll')).toEqual({
    type: 'object',
    properties: {
      tab: { type: 'string', maxLength: 2000 },
      x: { type: 'number', minimum: -10000, maximum: 10000 },
      y: { type: 'number', minimum: -10000, maximum: 10000 },
    },
    required: ['tab', 'x', 'y'],
    additionalProperties: false,
  })
  for (const name of ALL) {
    const schema = desktopToolSchema(name) as {
      properties: Record<string, unknown>
      required: string[]
      additionalProperties: boolean
    }
    expect(schema.additionalProperties).toBe(false)
    // confirm exists exactly on the computer's operation tools.
    expect(Object.hasOwn(schema.properties, 'confirm')).toBe(
      name.startsWith('qianmo_computer_') && !desktopObservation(name),
    )
    expect(schema.required).not.toContain('confirm')
    // window is optional except where the operation is on one window.
    expect(schema.required.includes('window')).toBe(
      [
        'qianmo_computer_observe',
        'qianmo_computer_focus',
        'qianmo_computer_menu',
      ].includes(name),
    )
  }
  // The old computer tools keep their names and required fields.
  expect(
    (desktopToolSchema('qianmo_computer_click') as { required: string[] })
      .required,
  ).toEqual(['x', 'y'])
  expect(
    (desktopToolSchema('qianmo_computer_scroll') as { required: string[] })
      .required,
  ).toEqual(['x', 'y', 'dx', 'dy'])
  expect(
    (desktopToolSchema('qianmo_computer_type') as { required: string[] })
      .required,
  ).toEqual(['text'])
  expect(
    (desktopToolSchema('qianmo_computer_key') as { required: string[] })
      .required,
  ).toEqual(['key'])
})

test('a batch canonicalizes: keys sorted at every level, key names normalized, nothing defaulted', () => {
  const args = desktopArgs('qianmo_computer_actions', BATCH)
  expect(Object.keys(args)).toEqual(['actions', 'confirm', 'window'])
  const steps = args.actions as Record<string, unknown>[]
  expect(steps[0]).toEqual({
    button: 'right',
    count: 2,
    keys: ['ctrl'],
    type: 'click',
    x: 10,
    y: 20,
  })
  expect(Object.keys(steps[0]!)).toEqual([
    'button',
    'count',
    'keys',
    'type',
    'x',
    'y',
  ])
  // Optional fields stay absent: no button, count or keys filled in.
  expect(steps[1]).toEqual({ type: 'double_click', x: 1, y: 2 })
  expect(steps[3]?.keys).toEqual(['shift'])
  expect(steps[6]?.keys).toEqual(['ctrl', 'shift', 't'])
  expect(steps[7]?.keys).toEqual(['alt', 'tab'])
  // Stable bytes whatever order the model wrote the fields in.
  const shuffled = {
    confirm: BATCH.confirm,
    actions: BATCH.actions.map(step =>
      Object.fromEntries(Object.entries(step).reverse()),
    ),
    window: BATCH.window,
  }
  expect(JSON.stringify(desktopArgs('qianmo_computer_actions', shuffled))).toBe(
    JSON.stringify(args),
  )
  // The host runs the check again on the canonical form and must get it back.
  for (const [name, raw] of [
    ['qianmo_computer_actions', BATCH],
    ['qianmo_computer_key', { key: ['Ctrl', 'shift+T'] }],
    ['qianmo_computer_click', { x: 1, y: 2, keys: 'cmd+Alt' }],
    ['qianmo_browser_navigate', { tab: 't', url: 'HTTPS://Example.test' }],
    ['qianmo_computer_menu', { window: '7', path: ['File', 'Save As…'] }],
  ] as const) {
    const once = desktopArgs(name, raw)
    expect(desktopArgs(name, once)).toEqual(once)
    expect(JSON.stringify(desktopArgs(name, once))).toBe(JSON.stringify(once))
    // The schema the model sees takes both the raw and the canonical form.
    expect(accepts(name, raw)).toBe(true)
    expect(accepts(name, once)).toBe(true)
  }
  expect(
    desktopArgs('qianmo_computer_key', { key: ['Ctrl', 'shift+T'] }),
  ).toEqual({ key: 'ctrl+shift+t' })
  expect(
    desktopArgs('qianmo_computer_click', { x: 1, y: 2, keys: 'cmd+Alt' }),
  ).toEqual({ keys: ['super', 'alt'], x: 1, y: 2 })
  // Every base alias, any case, one spelling.
  for (const [raw, key] of [
    ['RETURN', 'enter'],
    ['esc', 'escape'],
    ['Del', 'delete'],
    ['ArrowUp', 'up'],
    ['win', 'super'],
    ['Option', 'alt'],
    ['PrintScr', 'printscreen'],
    ['F24', 'f24'],
    ['A', 'a'],
    ['/', '/'],
  ])
    expect(desktopArgs('qianmo_computer_key', { key: raw })).toEqual({ key })
})

test('the base intent field is stripped at the top level only', () => {
  expect(
    desktopArgs('qianmo_computer_screenshot', {
      [DESKTOP_INTENT_FIELD]: '看一眼桌面',
    }),
  ).toEqual({})
  expect(
    desktopArgs('qianmo_computer_actions', {
      [DESKTOP_INTENT_FIELD]: '点一下',
      actions: [{ type: 'move', x: 1, y: 1 }],
    }),
  ).toEqual({ actions: [{ type: 'move', x: 1, y: 1 }] })
  fails(
    'qianmo_computer_actions',
    { actions: [{ type: 'move', x: 1, y: 1, [DESKTOP_INTENT_FIELD]: 'x' }] },
    'Unknown or missing desktop argument: 位置 actions[0]',
  )
})

test('a null optional field is "not given", as strict tool schemas send it; a null required field is not', () => {
  // OpenAI strict mode turns optional fields into required nullable ones; the
  // original call then carries nulls that omp strips before execute, and the
  // two must canonicalize alike or every such call reads as repaired.
  const strict = {
    x: 1,
    y: 2,
    button: null,
    count: null,
    keys: null,
    window: null,
    confirm: null,
  }
  expect(desktopArgs('qianmo_computer_click', strict)).toEqual({ x: 1, y: 2 })
  expect(
    desktopNeedsApproval(
      'qianmo_computer_click',
      desktopArgs('qianmo_computer_click', strict),
      'autonomous',
    ),
  ).toBe(false)
  expect(
    desktopArgs('qianmo_computer_actions', {
      window: null,
      confirm: null,
      actions: [{ type: 'click', x: 1, y: 2, button: null, keys: null }],
    }),
  ).toEqual({ actions: [{ type: 'click', x: 1, y: 2 }] })
  fails(
    'qianmo_computer_click',
    { x: null, y: 2 },
    'Invalid desktop argument: x',
  )
  fails(
    'qianmo_browser_click',
    { tab: 't', selector: null },
    'Invalid desktop argument: selector',
  )
})

test('closed arguments: unknown and missing fields, confirm only on operations', () => {
  fails(
    'qianmo_computer_click',
    { x: 1, y: 2, code: 'process.exit()' },
    'Unknown or missing desktop argument',
  )
  fails('qianmo_computer_click', { x: 1 }, '缺少字段 y')
  fails('qianmo_computer_observe', {}, '缺少字段 window')
  fails('qianmo_computer_menu', { window: '1' }, '缺少字段 path')
  // confirm belongs to operations; observations and the browser have none.
  for (const name of [
    'qianmo_computer_screenshot',
    'qianmo_computer_windows',
    'qianmo_computer_apps',
    'qianmo_browser_click',
  ] as const)
    expect(() =>
      desktopArgs(name, {
        ...(name === 'qianmo_browser_click'
          ? { tab: 't', selector: '#a' }
          : {}),
        confirm: 'why',
      }),
    ).toThrow('未知字段 confirm')
  fails(
    'qianmo_computer_actions',
    { actions: [{ type: 'move', x: 1, y: 1, confirm: 'why' }] },
    '未知字段 confirm',
  )
  for (const confirm of ['', 'x'.repeat(501), 'a\0b', 7])
    expect(() =>
      desktopArgs('qianmo_computer_type', { text: 'a', confirm }),
    ).toThrow('Invalid desktop argument: confirm')
  expect(
    desktopArgs('qianmo_computer_type', { text: 'a', confirm: 'x'.repeat(500) })
      .confirm,
  ).toHaveLength(500)
  // A function marker is not an argument shape anywhere.
  fails(
    'qianmo_computer_type',
    { text: { __omp_fn: '() => 1' } },
    'Invalid desktop argument: text',
  )
  fails(
    'qianmo_computer_actions',
    { actions: [{ type: 'type', text: { __omp_fn: '() => 1' } }] },
    'Invalid desktop argument: actions[0].text',
  )
})

test('bounded values: coordinates, text, windows, refs, apps, menus, buttons', () => {
  for (const x of [Infinity, Number.NaN, 10001, -10001, '1', null])
    fails('qianmo_computer_click', { x, y: 0 }, 'Invalid desktop argument: x')
  expect(desktopArgs('qianmo_computer_click', { x: -10000, y: 10000 })).toEqual(
    { x: -10000, y: 10000 },
  )
  fails(
    'qianmo_computer_type',
    { text: 'x'.repeat(16001) },
    'Invalid desktop argument: text',
  )
  fails('qianmo_computer_type', { text: 'a\0b' }, '不能含 NUL')
  for (const window of ['', 'a b', 'x'.repeat(65), '窗口', 12])
    fails(
      'qianmo_computer_screenshot',
      { window },
      'Invalid desktop argument: window',
    )
  expect(
    desktopArgs('qianmo_computer_screenshot', { window: 'x'.repeat(64) }),
  ).toEqual({ window: 'x'.repeat(64) })
  for (const ref of ['x12', 'e', 'e12 ', 'E3', `e${'1'.repeat(21)}`, 'e1a'])
    fails(
      'qianmo_computer_element',
      { ref, action: 'press' },
      'Invalid desktop argument: ref',
    )
  for (const app of ['', 'a b', 'x'.repeat(201), 'a\u0007b'])
    fails('qianmo_computer_open_app', { app }, 'Invalid desktop argument: app')
  expect(
    desktopArgs('qianmo_computer_open_app', { app: 'org.gnome.Terminal' }),
  ).toEqual({ app: 'org.gnome.Terminal' })
  fails(
    'qianmo_computer_element',
    { ref: 'e3', action: 'set_value' },
    'Invalid desktop argument: value',
  )
  fails(
    'qianmo_computer_element',
    { ref: 'e3', action: 'press', value: 'x' },
    'Invalid desktop argument: value',
  )
  fails(
    'qianmo_computer_element',
    { ref: 'e3', action: 'type' },
    'Invalid desktop argument: action',
  )
  for (const path of [[], [' '], Array.from({ length: 11 }, () => 'a'), 'File'])
    fails(
      'qianmo_computer_menu',
      { window: '1', path },
      'Invalid desktop argument: path',
    )
  fails(
    'qianmo_computer_click',
    { x: 1, y: 1, button: 'side' },
    'Invalid desktop argument: button',
  )
  for (const count of [0, 4, 1.5])
    fails(
      'qianmo_computer_click',
      { x: 1, y: 1, count },
      'Invalid desktop argument: count',
    )
  fails(
    'qianmo_computer_zoom',
    { x: 0, y: 0, width: 0, height: 10 },
    'Invalid desktop argument: width',
  )
})

test('keys: base names only, chords or arrays, at most five, modifiers where the base needs them', () => {
  for (const key of [
    'Super+Launch',
    'ctrl+',
    '+',
    'ctrl++',
    'ctrl+ctrl',
    'a+b+c+d+e+f',
    'Ⓐ',
    'F25',
    'ctrl+ſhift',
  ])
    fails('qianmo_computer_key', { key }, 'Invalid desktop argument: key')
  for (const key of [
    [],
    ['a', 'b', 'c', 'd', 'e', 'f'],
    [7],
    ['x'.repeat(101)],
  ])
    fails('qianmo_computer_key', { key }, 'Invalid desktop argument: key')
  // Mouse modifiers are modifier keys only (`parse_modifiers`).
  fails('qianmo_computer_click', { x: 1, y: 1, keys: 'ctrl+a' }, '只能是修饰键')
  fails(
    'qianmo_computer_actions',
    { actions: [{ type: 'double_click', x: 1, y: 1, keys: ['enter'] }] },
    'Invalid desktop argument: actions[0].keys',
  )
  // A drag holds any keys; a keypress takes up to five together.
  expect(
    desktopArgs('qianmo_computer_actions', {
      actions: [
        {
          type: 'drag',
          path: [
            [0, 0],
            [1, 1],
          ],
          keys: 'space',
        },
        { type: 'keypress', keys: ['ctrl', 'alt', 'shift', 'super', 'p'] },
      ],
    }).actions,
  ).toEqual([
    {
      keys: ['space'],
      path: [
        [0, 0],
        [1, 1],
      ],
      type: 'drag',
    },
    { keys: ['ctrl', 'alt', 'shift', 'super', 'p'], type: 'keypress' },
  ])
})

test('a batch is 1 to 20 known steps; drags, holds and waits stay within their budgets', () => {
  const batch = (actions: unknown) =>
    desktopArgs('qianmo_computer_actions', { actions })
  const move = { type: 'move', x: 0, y: 0 }
  expect(() => batch([])).toThrow('Invalid desktop argument: actions')
  expect(() => batch(Array.from({ length: 21 }, () => move))).toThrow(
    'Invalid desktop argument: actions',
  )
  expect(batch(Array.from({ length: 20 }, () => move)).actions).toHaveLength(20)
  expect(() => batch({ type: 'move' })).toThrow(
    'Invalid desktop argument: actions',
  )
  expect(() => batch([{ type: 'launch', app: 'xterm' }])).toThrow(
    'Invalid desktop argument: actions[0].type',
  )
  expect(() => batch([{ x: 1, y: 1 }])).toThrow(
    'Invalid desktop argument: actions[0].type',
  )
  expect(() => batch(['click'])).toThrow('actions[0].type')
  expect(() => batch([move, { type: 'click', x: 1 }])).toThrow(
    '位置 actions[1]；缺少字段 y',
  )
  expect(() => batch([{ ...move, button: 'left' }])).toThrow(
    '位置 actions[0]；未知字段 button',
  )
  for (const path of [
    [[0, 0]],
    Array.from({ length: 51 }, () => [0, 0]),
    [
      [0, 0],
      [1, 1, 1],
    ],
    [
      [0, 0],
      [1, Infinity],
    ],
    [[0, 0], 'a'],
  ])
    expect(() => batch([{ type: 'drag', path }])).toThrow(
      'Invalid desktop argument: actions[0].path',
    )
  expect(
    batch([{ type: 'drag', path: Array.from({ length: 50 }, () => [1, 2]) }])
      .actions,
  ).toHaveLength(1)
  expect(() =>
    batch([{ type: 'hold_keys', keys: 'shift', seconds: 10.5 }]),
  ).toThrow('Invalid desktop argument: actions[0].seconds')
  expect(() =>
    batch([{ type: 'hold_mouse', x: 0, y: 0, seconds: -1 }]),
  ).toThrow('actions[0].seconds')
  expect(() => batch([{ type: 'wait', ms: 30001 }])).toThrow('actions[0].ms')
  expect(() => batch([{ type: 'wait', ms: 1.5 }])).toThrow('actions[0].ms')
  // Waits and holds add up across the batch: 20 s + 10 s fits, a bit more not.
  expect(
    batch([
      { type: 'wait', ms: 20000 },
      { type: 'hold_keys', keys: 'shift', seconds: 10 },
    ]).actions,
  ).toHaveLength(2)
  expect(() =>
    batch([
      { type: 'wait', ms: 20000 },
      { type: 'hold_keys', keys: 'shift', seconds: 10 },
      { type: 'wait', ms: 1 },
    ]),
  ).toThrow('合计不能超过 30 秒')
  expect(() =>
    batch([
      { type: 'hold_mouse', x: 0, y: 0, seconds: 10 },
      { type: 'hold_mouse', x: 0, y: 0, seconds: 10 },
      { type: 'hold_keys', keys: 'a', seconds: 10 },
      { type: 'wait', ms: 1 },
    ]),
  ).toThrow('合计不能超过 30 秒')
  // Typed text is bounded per batch, not per step.
  expect(() =>
    batch([
      { type: 'type', text: 'x'.repeat(9000) },
      { type: 'type', text: 'x'.repeat(9000) },
    ]),
  ).toThrow('合计不能超过 16000')
})

test('the browser keeps v1.4: http(s) navigation, CSS selectors, navigation keys', () => {
  expect(
    desktopArgs('qianmo_browser_navigate', {
      tab: 'minted',
      url: 'https://example.test',
    }),
  ).toEqual({ tab: 'minted', url: 'https://example.test/' })
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://user:password@example.test',
    'not a url',
  ])
    expect(() =>
      desktopArgs('qianmo_browser_navigate', { tab: 'minted', url }),
    ).toThrow()
  for (const selector of ['', 'xpath//a', 'text/Send', 'aria/Send'])
    expect(() =>
      desktopArgs('qianmo_browser_click', { tab: 'minted', selector }),
    ).toThrow()
  expect(
    desktopArgs('qianmo_browser_press', {
      tab: 'minted',
      selector: '#q',
      key: 'Enter',
    }),
  ).toEqual({ key: 'Enter', selector: '#q', tab: 'minted' })
  expect(() =>
    desktopArgs('qianmo_browser_press', {
      tab: 'minted',
      selector: '#q',
      key: 'enter',
    }),
  ).toThrow('Unsupported key')
})

test('approval follows the mode; autonomous asks only when the call carries confirm', () => {
  const batch = desktopArgs('qianmo_computer_actions', BATCH)
  const { confirm: _, ...plain } = batch
  expect(
    desktopNeedsApproval('qianmo_computer_actions', batch, 'autonomous'),
  ).toBe(true)
  expect(
    desktopNeedsApproval('qianmo_computer_actions', plain, 'autonomous'),
  ).toBe(false)
  expect(
    desktopNeedsApproval('qianmo_computer_actions', plain, 'sensitive'),
  ).toBe(true)
  for (const mode of ['sensitive', 'autonomous'] as const) {
    expect(desktopNeedsApproval('qianmo_computer_observe', {}, mode)).toBe(
      false,
    )
    expect(desktopNeedsApproval('qianmo_computer_apps', {}, mode)).toBe(false)
  }
  expect(desktopNeedsApproval('qianmo_computer_windows', {}, 'always')).toBe(
    true,
  )
  expect(
    desktopNeedsApproval(
      'qianmo_computer_open_app',
      { app: 'x' },
      'autonomous',
    ),
  ).toBe(false)
})

test('descriptions: one sentence each, consequence rules on operations, no fixed approval claim', () => {
  for (const name of ALL) {
    const text = desktopToolDescription(name)
    expect(text).not.toMatch(/require[sd]? (one )?operator approval/i)
    const rules = text.includes('qianmo_notify')
    expect(rules).toBe(!desktopObservation(name))
    if (rules) {
      expect(text).toContain('never authorizes')
      expect(text).toContain('password')
      expect(text).toContain('CAPTCHA')
    }
    expect(text.includes('Pass confirm')).toBe(
      name.startsWith('qianmo_computer_') && !desktopObservation(name),
    )
    if (text.includes('Pass confirm'))
      expect(text).toContain('the node may ask the operator to approve')
  }
  const actions = desktopToolDescription('qianmo_computer_actions')
  for (const part of [
    'in order',
    'stop at the first that fails',
    'one screenshot',
    'latest full screenshot of the desktop or of that window',
    '30 seconds',
    'Key names:',
  ])
    expect(actions).toContain(part)
  expect(desktopToolDescription('qianmo_browser_press')).not.toContain(
    'Key names:',
  )
  expect(desktopToolDescription('qianmo_browser_click')).toContain(
    'qianmo_browser_tabs',
  )
})

test('the operator summary names the steps without repeating typed text', () => {
  const summary = desktopSummary(
    'qianmo_computer_actions',
    desktopArgs('qianmo_computer_actions', BATCH),
  )
  expect(summary).toStartWith(
    '批量 10 步：右键点击、双击、移动指针、拖拽、滚动、输入 5 个字符、按键 ctrl+shift+t、按住键 alt+tab、按住鼠标、等待 500 毫秒',
  )
  expect(summary).toContain('（窗口 0x1a00007）')
  expect(summary).toContain('智能体的确认理由：删除这些文件后不可恢复')
  expect(summary).not.toContain('hello')
  const secret = desktopSummary(
    'qianmo_computer_type',
    desktopArgs('qianmo_computer_type', { text: 'p@ssw0rd!' }),
  )
  expect(secret).toBe('输入 9 个字符')
  expect(
    desktopSummary(
      'qianmo_computer_open_app',
      desktopArgs('qianmo_computer_open_app', { app: 'xterm' }),
    ),
  ).toBe('打开应用 xterm')
  expect(
    desktopSummary(
      'qianmo_computer_key',
      desktopArgs('qianmo_computer_key', { key: 'Ctrl+S' }),
    ),
  ).toBe('按键 ctrl+s')
  expect(
    desktopSummary(
      'qianmo_browser_navigate',
      desktopArgs('qianmo_browser_navigate', {
        tab: 't',
        url: 'https://example.test/a?q=secret',
      }),
    ),
  ).toBe('打开网页 example.test')
  expect(
    desktopSummary(
      'qianmo_computer_clipboard_write',
      desktopArgs('qianmo_computer_clipboard_write', { text: '机密' }),
    ),
  ).toBe('写入剪贴板 2 个字符')
})

test('tool parameters: the host Type.Unsafe keeps the schema, a dropping Unsafe gets it rebuilt', () => {
  type Validating = {
    toJsonSchema(): Record<string, unknown>
    safeParse(input: unknown): { success: boolean }
  }
  const valid = { x: 1, y: 2, keys: ['ctrl'], window: 'w', confirm: 'why' }
  for (const [label, Type] of [
    ['host', HostType],
    ['omptype', OmpType],
  ] as const) {
    for (const name of ALL) {
      const schema = desktopParameters(
        Type,
        desktopToolSchema(name),
      ) as unknown as Validating
      const wire = schema.toJsonSchema() as {
        properties?: Record<string, unknown>
        additionalProperties?: unknown
      }
      expect(
        Object.keys(wire.properties ?? {}).sort(),
        `${label} ${name}`,
      ).toEqual(
        Object.keys(
          (desktopToolSchema(name) as { properties: object }).properties,
        ).sort(),
      )
      expect(wire.additionalProperties).toBe(false)
    }
    const click = desktopParameters(
      Type,
      desktopToolSchema('qianmo_computer_click'),
    ) as unknown as Validating
    expect(click.safeParse(valid).success, label).toBe(true)
    expect(click.safeParse({ ...valid, code: '1' }).success, label).toBe(false)
    expect(click.safeParse({ ...valid, x: 10001 }).success, label).toBe(false)
    expect(click.safeParse({ ...valid, button: 'side' }).success, label).toBe(
      false,
    )
    const actions = desktopParameters(
      Type,
      desktopToolSchema('qianmo_computer_actions'),
    ) as unknown as Validating
    expect(actions.safeParse(BATCH).success, label).toBe(true)
    expect(
      actions.safeParse({ actions: [{ type: 'launch', app: 'x' }] }).success,
      label,
    ).toBe(false)
    expect(
      actions.safeParse({ actions: [{ type: 'move', x: 1, y: 1, z: 1 }] })
        .success,
      label,
    ).toBe(false)
  }
  // The host builder emits the policy document verbatim.
  expect(
    (
      desktopParameters(
        HostType,
        desktopToolSchema('qianmo_computer_actions'),
      ) as unknown as Validating
    ).toJsonSchema(),
  ).toEqual(desktopToolSchema('qianmo_computer_actions'))
})
