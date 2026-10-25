// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The setting row (`view/settingRow.ts`) and the runtime that writes it
 * (`assets/client.ts`, 设置行) in a real browser: a change is written at
 * once, a refused one puts the control back and says why under the row, a
 * text box saves on Enter or blur but never on the Enter that ends an input
 * method's composition, and 恢复默认 writes the default. The rows here are
 * drawn by the module itself and dropped into a real console page, so the
 * page's own CSP and runtime are what run them.
 *
 * Skipped, with the reason, where no Chrome is installed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { settingRow, settingsGroup } from '../../src/view/settingRow.js'
import { ADMIN, pageHarness } from '../pageHarness.js'
import { Browser, skipReason, type Tab } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[setting row browser tests] skipped: ${SKIP}`)

function serve() {
  const h = pageHarness()
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: request => h.handle(request),
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true)
    },
  }
}

const ROWS = settingsGroup('测试', [
  settingRow({
    id: 'flag',
    label: '开关',
    description: '一行说明',
    control: { kind: 'switch', value: false, default: false },
    handler: 'probe',
  }),
  settingRow({
    id: 'name',
    label: '名字',
    control: { kind: 'text', value: 'alpha', default: 'alpha' },
    handler: 'probe',
  }),
  settingRow({
    id: 'size',
    label: '档位',
    control: {
      kind: 'segmented',
      value: 'm',
      default: 'm',
      options: [
        ['s', '小'],
        ['m', '中'],
        ['l', '大'],
      ],
    },
    handler: 'probe',
  }),
])

/** Put the rows on the page and a handler that records and refuses `bad`. */
async function mount(tab: Tab): Promise<void> {
  await tab.evaluate(`(() => {
    document.getElementById('main').insertAdjacentHTML('afterbegin', ${JSON.stringify(ROWS)});
    window.__calls = [];
    window.qianmoConsole.onSetting('probe', function (value, row) {
      window.__calls.push(row.getAttribute('data-setting') + '=' + String(value));
      if (value === 'bad' || value === 'l') throw { human: '不接受这个值' };
    });
  })()`)
}

const calls = (tab: Tab) => tab.evaluate<string[]>('window.__calls')

function key(
  tab: Tab,
  selector: string,
  name: string,
  composing = false,
): Promise<unknown> {
  return tab.evaluate(
    `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(
      name,
    )}, bubbles: true, isComposing: ${composing} }))`,
  )
}

describe.skipIf(SKIP !== null)('setting rows in a browser', () => {
  let browser: Browser
  let tab: Tab
  let site: ReturnType<typeof serve>

  beforeAll(async () => {
    browser = await Browser.launch()
    site = serve()
    tab = await browser.tab()
    await tab.goto(`${site.base}/admin/settings?token=${ADMIN}`)
    await tab.waitFor(`window.qianmoConsole && document.getElementById('main')`)
    await mount(tab)
  }, 30_000)

  afterAll(async () => {
    await tab?.close()
    site?.stop()
    await browser?.close()
  }, 30_000)

  test('a switch writes at once and marks the row as changed', async () => {
    await tab.evaluate(`document.querySelector('#set-flag').click()`)
    await tab.waitFor(`window.__calls.length === 1`)
    expect(await calls(tab)).toEqual(['flag=true'])
    await tab.waitFor(
      `document.querySelector('[data-setting="flag"]').hasAttribute('data-changed')`,
    )
    expect(
      await tab.evaluate<string>(
        `document.querySelector('[data-setting="flag"]').getAttribute('data-setting-value')`,
      ),
    ).toBe('true')
  })

  test('Enter that ends a composition does not save; a plain Enter does, once', async () => {
    await tab.evaluate(
      `document.querySelector('#set-name').focus(); document.querySelector('#set-name').value = '阡陌'`,
    )
    await key(tab, '#set-name', 'Enter', true)
    expect(await calls(tab)).toEqual(['flag=true'])
    await key(tab, '#set-name', 'Enter')
    await tab.waitFor(`window.__calls.length === 2`)
    // Blurring after the save sends nothing more: the value is unchanged.
    await tab.evaluate(`document.querySelector('#set-name').blur()`)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(await calls(tab)).toEqual(['flag=true', 'name=阡陌'])
  })

  test('a refused change goes back and says why under the row', async () => {
    await tab.evaluate(
      `document.querySelector('#set-name').focus(); document.querySelector('#set-name').value = 'bad'`,
    )
    await tab.evaluate(`document.querySelector('#set-name').blur()`)
    await tab.waitFor(
      `!document.querySelector('#set-name-err').hidden && document.querySelector('#set-name').value === '阡陌'`,
    )
    expect(
      await tab.evaluate<string>(
        `document.querySelector('#set-name-err').textContent`,
      ),
    ).toContain('不接受这个值')
    await tab.evaluate(
      `document.querySelector('#set-size input[value="l"]').click()`,
    )
    await tab.waitFor(`!document.querySelector('#set-size-err').hidden`)
    expect(
      await tab.evaluate<string>(
        `document.querySelector('#set-size input:checked').value`,
      ),
    ).toBe('m')
  })

  test('恢复默认 writes the default and clears the mark', async () => {
    await tab.evaluate(
      `document.querySelector('[data-setting="flag"] [data-setting-reset]').click()`,
    )
    await tab.waitFor(
      `!document.querySelector('[data-setting="flag"]').hasAttribute('data-changed')`,
    )
    expect((await calls(tab)).at(-1)).toBe('flag=false')
    expect(
      await tab.evaluate<boolean>(
        `document.querySelector('#set-flag').checked`,
      ),
    ).toBe(false)
  })

  test('the theme row and the menu are one preference', async () => {
    await tab.evaluate(
      `document.querySelector('#set-theme input[value="dark"]').click()`,
    )
    await tab.waitFor(
      `document.documentElement.getAttribute('data-theme') === 'dark'`,
    )
    expect(
      await tab.evaluate<string>(
        `document.querySelector('#theme-choice').value`,
      ),
    ).toBe('dark')
    expect(await tab.evaluate<string>('document.cookie')).toContain(
      'qianmo_theme=dark',
    )
  })
})
