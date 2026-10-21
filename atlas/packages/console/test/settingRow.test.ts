// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a declared setting row draws (`view/settingRow.ts`): the label with
 * its line, the control wired to where it writes, the changed mark and
 * 恢复默认 only when the value is not the default, and a disabled control
 * that says why instead of disappearing. The browser half is
 * `browser/settingRow.browser.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { CONSOLE_CLIENT_JS } from '../src/assets/client.js'
import { CONSOLE_CSS } from '../src/assets/css.js'
import {
  SETTING_ROW_CSS,
  SETTING_ROW_JS,
  settingRow,
  settingsGroup,
} from '../src/view/settingRow.js'

describe('settingRow', () => {
  test('a switch row carries where it writes and its default', () => {
    const html = settingRow({
      id: 'ctx',
      label: '上下文',
      description: '一行说明',
      control: { kind: 'switch', value: true, default: false },
      endpoint: '/v0/things/a',
      field: 'enabled',
      extra: { node: 'n1' },
    })
    expect(html).toContain('data-setting="ctx"')
    expect(html).toContain('data-setting-kind="switch"')
    expect(html).toContain('data-setting-value="true"')
    expect(html).toContain('data-setting-default="false"')
    expect(html).toContain('data-setting-endpoint="/v0/things/a"')
    expect(html).toContain('data-setting-field="enabled"')
    expect(html).toContain('data-setting-method="PUT"')
    expect(html).toContain(
      'data-setting-extra="{&quot;node&quot;:&quot;n1&quot;}"',
    )
    expect(html).toContain(' data-changed')
    expect(html).toContain('恢复默认')
    expect(html).toContain('id="set-ctx" data-setting-input')
    expect(html).toContain('aria-describedby="set-ctx-desc set-ctx-err"')
    expect(html).toContain(
      '<p class="setting-desc" id="set-ctx-desc">一行说明</p>',
    )
    expect(html).toContain('role="alert" hidden')
  })

  test('a row at its default draws no mark; one without a default draws no reset', () => {
    const atDefault = settingRow({
      id: 'a',
      label: '甲',
      control: {
        kind: 'select',
        value: 'x',
        default: 'x',
        options: [
          ['x', '一'],
          ['y', '二'],
        ],
      },
      endpoint: '/v0/a',
    })
    expect(atDefault).not.toContain(' data-changed')
    expect(atDefault).toContain('<option value="x" selected>')
    expect(atDefault).toContain('class="sel setting-sel"')
    const noDefault = settingRow({
      id: 'b',
      label: '乙',
      control: { kind: 'text', value: 'v' },
      endpoint: '/v0/b',
    })
    expect(noDefault).not.toContain('data-setting-reset')
    expect(noDefault).not.toContain('data-setting-default')
  })

  test('a disabled row keeps its control and says why in place of the line', () => {
    const html = settingRow({
      id: 'pc',
      label: '电脑',
      description: '不会出现',
      control: { kind: 'switch', value: false, default: false },
      endpoint: '/v0/pc',
      disabled: '需要 Linux（装有 Xvfb 和 xauth）或 macOS',
    })
    expect(html).toContain('class="setting is-disabled"')
    expect(html).toContain('需要 Linux（装有 Xvfb 和 xauth）或 macOS')
    expect(html).not.toContain('不会出现')
    expect(html).toMatch(/id="set-pc"[^>]* disabled/)
  })

  test('a row with nowhere to write is read-only', () => {
    const html = settingRow({
      id: 'ro',
      label: '只读',
      control: { kind: 'switch', value: true, default: false },
    })
    expect(html).toMatch(/id="set-ro"[^>]* disabled/)
    expect(html).not.toContain('data-setting-reset')
  })

  test('a text row can ask for a number, a segmented row is a radio group', () => {
    const text = settingRow({
      id: 'n',
      label: '数',
      control: { kind: 'text', value: '200000', numeric: true, mono: true },
      handler: 'probe',
    })
    expect(text).toContain('inputmode="numeric" data-setting-numeric')
    expect(text).toContain('class="input setting-input mono"')
    expect(text).toContain('data-setting-handler="probe"')
    const seg = settingRow({
      id: 's',
      label: '档',
      control: {
        kind: 'segmented',
        value: 'b',
        options: [
          ['a', '一'],
          ['b', '二'],
        ],
      },
      handler: 'probe',
      write: false,
    })
    expect(seg).toContain('role="radiogroup" aria-labelledby="set-s-label"')
    expect(seg).toContain('value="b" data-setting-input checked')
    expect(seg).not.toContain('data-write')
  })

  test('labels and lines are escaped', () => {
    const html = settingRow({
      id: 'x',
      label: '<b>',
      description: '"q"',
      control: { kind: 'text', value: '<v>' },
      endpoint: '/v0/x',
    })
    expect(html).toContain('&lt;b&gt;')
    expect(html).toContain('value="&lt;v&gt;"')
    expect(html).not.toContain('<b>')
  })

  test('a group draws its rows on one card and nothing when empty', () => {
    expect(settingsGroup('空', [])).toBe('')
    const html = settingsGroup('外观', ['<div class="setting"></div>'], {
      id: 'look',
      note: '本机',
    })
    expect(html).toContain(
      '<section class="settings-group" id="look" aria-labelledby="look-title">',
    )
    expect(html).toContain(
      '<h2 class="settings-title" id="look-title">外观</h2>',
    )
    expect(html).toContain(
      '<div class="settings-card"><div class="setting"></div></div>',
    )
  })

  test('the rows are a page asset, not the shared sheet and runtime every page carries', () => {
    expect(SETTING_ROW_CSS).toContain('.setting-sel { width: 160px; }')
    expect(CONSOLE_CSS).not.toContain('.setting-reset')
    expect(CONSOLE_CLIENT_JS).not.toContain('data-setting-input')
    expect(SETTING_ROW_JS).toContain('qc.onSetting = function')
    expect(
      SETTING_ROW_JS.split('\n').filter(line => /^\s*\/\//.test(line)),
    ).toEqual([])
    expect(() => new Function(SETTING_ROW_JS)).not.toThrow()
  })
})
