// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A row's 更多 menu (`view/kit.ts` moreMenu, MORE_MENU_JS) in a real browser:
 * it opens under its button with the right edges lined up, a pick closes it,
 * runs the page's action and leaves the focus on the button, a dialog that
 * pick opens gives the focus back there, and a refresh of the region waits
 * while the menu is open. The table is drawn by the module itself and
 * dropped into the 主动执行 page, whose script carries the menu's.
 *
 * Skipped, with the reason, where no Chrome is installed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { moreMenu } from '../../src/view/kit.js'
import { ADMIN, pageHarness } from '../pageHarness.js'
import { Browser, skipReason, type Tab } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[more menu browser tests] skipped: ${SKIP}`)

function serve() {
  const h = pageHarness()
  // How long the schedules fragment takes to answer, when a test wants it slow.
  const delay = { ms: 0 }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const path = new URL(request.url).pathname
      // Polling stands in for the revision stream, as in the other suites:
      // the stream's first refresh would put the fragment's own markup over
      // the probe table this suite mounts.
      if (path === '/v0/events') return new Response(null, { status: 503 })
      if (path === '/fragments/schedules' && delay.ms > 0) {
        await new Promise(resolve => setTimeout(resolve, delay.ms))
      }
      return h.handle(request)
    },
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    delay,
    stop: () => {
      server.stop(true)
    },
  }
}

const TABLE =
  `<div id="more-probe" data-poll="/fragments/schedules"><div class="scroll">` +
  `<table class="trail"><tbody><tr data-key="a"><td>甲</td><td class="acts"><span class="kit-acts">` +
  moreMenu('probe:a', '甲', [
    { action: 'probe-edit', label: '编辑', data: { id: 'a' } },
    { action: 'probe-remove', label: '删除', data: { id: 'a' }, danger: true },
  ]) +
  `</span></td></tr></tbody></table></div></div>` +
  `<dialog id="probe-dialog"><button type="button" data-action="confirm-cancel">返回</button></dialog>`

async function mount(tab: Tab): Promise<void> {
  await tab.evaluate(`(() => {
    document.getElementById('main').insertAdjacentHTML('afterbegin', ${JSON.stringify(TABLE)});
    window.__calls = [];
    window.qianmoConsole.onAction('probe-edit', function (el) {
      window.__calls.push('edit ' + el.getAttribute('data-id'));
    });
    window.qianmoConsole.onAction('probe-remove', function (el) {
      window.__calls.push('remove ' + el.getAttribute('data-id'));
      window.qianmoConsole.openDialog('probe-dialog', null);
    });
  })()`)
}

const BUTTON = `document.querySelector('#more-probe .row-more-btn')`
const MENU = `document.getElementById(${BUTTON}.getAttribute('popovertarget'))`

describe.skipIf(SKIP !== null)('a row’s 更多 menu in a browser', () => {
  let browser: Browser
  let tab: Tab
  let site: ReturnType<typeof serve>

  beforeAll(async () => {
    browser = await Browser.launch()
    site = serve()
    tab = await browser.tab()
    await tab.goto(`${site.base}/admin/jobs?token=${ADMIN}`)
    await tab.waitFor(`window.qianmoConsole && document.getElementById('main')`)
    await mount(tab)
  }, 30_000)

  afterAll(async () => {
    await tab?.close()
    site?.stop()
    await browser?.close()
  }, 30_000)

  test('stays out of sight until opened, then opens under its button, right edges lined up', async () => {
    expect(
      await tab.evaluate<string>(`getComputedStyle(${MENU}).display`),
    ).toBe('none')
    await tab.evaluate(`${BUTTON}.click()`)
    await tab.waitFor(`${MENU}.matches(':popover-open')`)
    const [button, menu] = await tab.evaluate<[number[], number[]]>(
      `[${BUTTON}, ${MENU}].map(el => { const r = el.getBoundingClientRect(); return [Math.round(r.right), Math.round(r.top), Math.round(r.bottom)] })`,
    )
    expect(menu[0]).toBe(button[0])
    expect(menu[1]).toBeGreaterThanOrEqual(button[2])
  })

  test('a refresh of the region waits while the menu is open', async () => {
    const before = await tab.evaluate<string>(
      `document.getElementById('more-probe').innerHTML`,
    )
    await tab.evaluate(
      `window.qianmoConsole.refreshRegion(document.getElementById('more-probe'))`,
    )
    expect(
      await tab.evaluate<string>(
        `document.getElementById('more-probe').innerHTML`,
      ),
    ).toBe(before)
    expect(
      await tab.evaluate<boolean>(`${MENU}.matches(':popover-open')`),
    ).toBe(true)
  })

  test('a refresh already on its way when the menu opens waits too', async () => {
    await tab.evaluate(`${MENU}.hidePopover()`)
    const before = await tab.evaluate<string>(
      `document.getElementById('more-probe').innerHTML`,
    )
    site.delay.ms = 400
    try {
      await tab.evaluate(
        `window.__refresh = window.qianmoConsole.refreshRegion(document.getElementById('more-probe')); 1`,
      )
      await tab.evaluate(`${BUTTON}.click()`)
      await tab.waitFor(`${MENU}.matches(':popover-open')`)
      await tab.evaluate('window.__refresh')
    } finally {
      site.delay.ms = 0
    }
    expect(
      await tab.evaluate<string>(
        `document.getElementById('more-probe').innerHTML`,
      ),
    ).toBe(before)
    expect(
      await tab.evaluate<boolean>(`${MENU}.matches(':popover-open')`),
    ).toBe(true)
  })

  test('a pick closes it, runs the action and leaves the focus on the button', async () => {
    await tab.evaluate(
      `${MENU}.querySelector('[data-action="probe-edit"]').click()`,
    )
    await tab.waitFor(`window.__calls.length === 1`)
    expect(await tab.evaluate<string[]>('window.__calls')).toEqual(['edit a'])
    expect(
      await tab.evaluate<boolean>(`${MENU}.matches(':popover-open')`),
    ).toBe(false)
    expect(
      await tab.evaluate<boolean>(`document.activeElement === ${BUTTON}`),
    ).toBe(true)
  })

  test('a dialog a pick opens gives the focus back to the button', async () => {
    await tab.evaluate(`${BUTTON}.click()`)
    await tab.waitFor(`${MENU}.matches(':popover-open')`)
    await tab.evaluate(
      `${MENU}.querySelector('[data-action="probe-remove"]').click()`,
    )
    await tab.waitFor(`document.getElementById('probe-dialog').open`)
    await tab.evaluate(
      `document.querySelector('#probe-dialog [data-action="confirm-cancel"]').click()`,
    )
    await tab.waitFor(`!document.getElementById('probe-dialog').open`)
    await tab.waitFor(`document.activeElement === ${BUTTON}`)
    expect(await tab.evaluate<string[]>('window.__calls')).toEqual([
      'edit a',
      'remove a',
    ])
  })
})
