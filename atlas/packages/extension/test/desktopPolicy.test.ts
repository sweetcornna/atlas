// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import {
  DESKTOP_INTENT_FIELD,
  desktopArgs,
  desktopTools,
  desktopObservation,
} from '../src/desktopPolicy.js'
import {
  residentActiveTools,
  residentToolVerdict,
  residentConfigOverlay,
  type ResidentExtensionConfig,
} from '../src/policy.js'

test('closed desktop arguments reject code, function markers, CDP, arbitrary files and unknown operations', () => {
  expect(
    desktopArgs('qianmo_browser_navigate', {
      tab: 'minted',
      url: 'https://example.test',
    }),
  ).toEqual({ tab: 'minted', url: 'https://example.test/' })
  for (const extra of [
    { code: 'process.exit()' },
    { app: { cdp_url: 'http://other' } },
    { path: '/tmp/export' },
    { cookie: 'secret' },
    { __omp_fn: '() => 1' },
  ])
    expect(() =>
      desktopArgs('qianmo_browser_click', {
        tab: 'minted',
        selector: '#send',
        ...extra,
      }),
    ).toThrow()
  expect(() =>
    desktopArgs('qianmo_browser_click', {
      tab: 'minted',
      selector: { __omp_fn: '() => 1' },
    }),
  ).toThrow()
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://user:password@example.test',
  ])
    expect(() =>
      desktopArgs('qianmo_browser_navigate', { tab: 'minted', url }),
    ).toThrow()
  expect(() => desktopArgs('qianmo_computer_key', { key: 'Super+R' })).toThrow()
  expect(() =>
    desktopArgs('qianmo_computer_click', { x: Infinity, y: 0 }),
  ).toThrow()
})
test('the base intent field is accepted as bounded text and left out of the canonical arguments', async () => {
  // Every tool call from the base carries the intent field; rejecting it made
  // each browser and computer call fail with "Unknown or missing desktop argument".
  expect(
    desktopArgs('qianmo_browser_tabs', {
      [DESKTOP_INTENT_FIELD]: '查看专属浏览器标签页',
    }),
  ).toEqual({})
  expect(
    desktopArgs('qianmo_browser_click', {
      [DESKTOP_INTENT_FIELD]: '点击发送',
      tab: 'minted',
      selector: '#send',
    }),
  ).toEqual({ tab: 'minted', selector: '#send' })
  const raw = { [DESKTOP_INTENT_FIELD]: 'scroll', x: 1, y: 2, dx: 0, dy: 3 }
  desktopArgs('qianmo_computer_scroll', raw)
  expect(raw[DESKTOP_INTENT_FIELD]).toBe('scroll')
  for (const intent of [{ text: 'x' }, 7, 'x'.repeat(2001), 'a\0b'])
    expect(() =>
      desktopArgs('qianmo_browser_tabs', { [DESKTOP_INTENT_FIELD]: intent }),
    ).toThrow('Invalid desktop argument')
  // The intent field does not stand in for a missing argument or admit others.
  expect(() =>
    desktopArgs('qianmo_browser_click', {
      [DESKTOP_INTENT_FIELD]: 'x',
      tab: 'minted',
    }),
  ).toThrow('Unknown or missing desktop argument')
  expect(() =>
    desktopArgs('qianmo_browser_tabs', {
      [DESKTOP_INTENT_FIELD]: 'x',
      code: '1',
    }),
  ).toThrow('Unknown or missing desktop argument')
  // Guard against the pinned base renaming the field.
  const wire = await Bun.file(
    new URL('../../../../packages/wire/src/index.ts', import.meta.url),
  ).text()
  expect(wire).toContain(
    `export const INTENT_FIELD = "${DESKTOP_INTENT_FIELD}";`,
  )
})
test('enabled resources activate only structured tools for main; eval remains denied', () => {
  const desktop = {
    resourceId: 'r',
    resourceEpoch: 1,
    browser: true,
    computer: false,
    cdpUrl: 'http://127.0.0.1:1',
    display: null,
    xauthority: null,
    downloads: '/tmp/owned',
    tab: 'r:1:main',
  }
  const config: ResidentExtensionConfig = {
    v: 1,
    agent: 'main',
    workspace: '/tmp/work',
    edits: 'none',
    protectedRoots: [],
    hostTools: [],
    desktop,
  }
  expect(desktopTools()).toEqual([])
  const tools = residentActiveTools('none', [], undefined, desktop)
  expect(tools).toContain('qianmo_browser_click')
  expect(tools).not.toContain('qianmo_computer_click')
  expect(tools).not.toContain('eval')
  expect(
    residentToolVerdict(
      { toolName: 'qianmo_browser_click', input: {} },
      config,
      { agentKind: 'main' },
    ),
  ).toBeUndefined()
  expect(
    residentToolVerdict(
      { toolName: 'qianmo_browser_click', input: {} },
      config,
      { agentKind: 'sub' },
    )?.block,
  ).toBe(true)
  expect(
    residentToolVerdict(
      { toolName: 'qianmo_browser_click', input: {} },
      { ...config, desktop: undefined },
      { agentKind: 'main' },
    )?.block,
  ).toBe(true)
  expect(
    residentToolVerdict({ toolName: 'eval', input: { code: '1' } }, config, {
      agentKind: 'main',
    })?.block,
  ).toBe(true)
  const overlay = Bun.YAML.parse(residentConfigOverlay(config)) as {
    tools: { approval: Record<string, string> }
  }
  expect(overlay.tools.approval.eval).toBe('deny')
  expect(desktopObservation('qianmo_browser_read_page')).toBe(true)
  expect(desktopObservation('qianmo_browser_scroll')).toBe(false)
})
