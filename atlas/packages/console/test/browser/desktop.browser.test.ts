// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 云端电脑 (P21, runtimes-channels.md §6) in a real browser: the latest
 * screenshot arrives as a `data:` image under the console's own CSP, stays
 * on the page through a refresh of the region, and opens large; a node too
 * old for screens says so; the applications dialog writes what was chosen; a
 * macOS host desktop asks for its list before it turns on. The HTTP half is
 * `desktop.test.ts` and `desktopApi.test.ts`.
 *
 * Skipped, with the reason, where no Chrome is installed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  accountsHarness,
  person,
  START,
  type Person,
} from '../accountsHarness.js'
import { FakeDesktop } from '../directionFakes.js'
import { MemoryActionLedger } from '../memoryActions.js'
import { Browser, type Tab, skipReason } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[desktop browser tests] skipped: ${SKIP}`)

async function serve() {
  const desktop = new FakeDesktop(() => START)
  const h = accountsHarness({
    deps: { actions: new MemoryActionLedger(), desktop },
  })
  const ops = await person(h.handle, 'ops')
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: request => h.handle(request),
  })
  return {
    desktop,
    ops,
    base: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true)
    },
  }
}

async function signIn(tab: Tab, base: string, who: Person): Promise<void> {
  await tab.send('Network.setCookie', {
    name: 'qianmo_session',
    value: who.sid,
    url: base,
    httpOnly: true,
    sameSite: 'Strict',
  })
}

const q = (selector: string) =>
  `document.querySelector(${JSON.stringify(selector)})`
const click = (selector: string) => `${q(selector)}.click()`
const SHOT = '[data-key="tokyo-1/planner"] .dk-shot'

describe.skipIf(SKIP !== null)('云端电脑 in a browser', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await Browser.launch()
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
  }, 30_000)

  test('the screenshot loads under the CSP, survives a refresh and opens large', async () => {
    const s = await serve()
    const tab = await browser.tab()
    try {
      await signIn(tab, s.base, s.ops)
      await tab.goto(`${s.base}/admin/desktop`)
      // naturalWidth is 0 for an image the CSP refused.
      await tab.waitFor(`${q(`${SHOT} img`)}.naturalWidth === 1`)
      expect(
        await tab.evaluate<string>(`${q(`${SHOT} img`)}.getAttribute('src')`),
      ).toStartWith('data:image/png;base64,')
      expect(
        await tab.evaluate<boolean>(`${q(`${SHOT} .dk-shot-empty`)}.hidden`),
      ).toBe(true)
      expect(
        await tab.evaluate<string>(
          `${q('[data-key="tokyo-1/planner"] .dk-shot-at')}.textContent`,
        ),
      ).toMatch(/^\d\d:\d\d:\d\d$/)
      // The region is replaced: the picture is back before anybody sees a blank.
      const kept = await tab.evaluate<boolean>(
        `(function () {
          var mount = document.getElementById('desktop');
          return window.qianmoConsole.refreshRegion(mount).then(function () {
            var img = ${q(`${SHOT} img`)};
            return !!img.getAttribute('src') && !img.hidden;
          });
        })()`,
      )
      expect(kept).toBe(true)
      expect(
        s.desktop.calls.filter(c => c === 'view tokyo-1/planner').length,
      ).toBeGreaterThanOrEqual(1)
      await tab.evaluate(click(SHOT))
      await tab.waitFor(`${q('#desktop-screen')}.open`)
      expect(
        await tab.evaluate<string>(
          `${q('#desktop-screen-img')}.getAttribute('src')`,
        ),
      ).toStartWith('data:image/png;base64,')
      expect(
        await tab.evaluate<string>(`${q('#desktop-screen-title')}.textContent`),
      ).toBe('画面 · planner · tokyo-1')
      await tab.evaluate(
        click('#desktop-screen [data-action="confirm-cancel"]'),
      )
      await tab.waitFor(`!${q('#desktop-screen')}.open`)
      // Closing lets go of the large copy (the close event comes a task later).
      await tab.waitFor(`!${q('#desktop-screen-img')}.hasAttribute('src')`)
      // 查看画面 on the card opens the same picture, with how old it is.
      await tab.evaluate(
        click('[data-key="tokyo-1/planner"] [data-action="desktop-view"]'),
      )
      await tab.waitFor(`${q('#desktop-screen')}.open`)
      expect(
        await tab.evaluate<string>(`${q('#desktop-screen-at')}.textContent`),
      ).toMatch(/^截于 \d\d:\d\d:\d\d · 不是实时画面$/)
      await tab.evaluate(
        click('#desktop-screen [data-action="confirm-cancel"]'),
      )
      await tab.waitFor(`!${q('#desktop-screen')}.open`)
      // 打开浏览器 turns the browser on in one step.
      await tab.evaluate(
        click('[data-key="osaka-1/writer"] [data-action="desktop-open"]'),
      )
      const deadline = Date.now() + 5_000
      while (
        !s.desktop.calls.some(c => c.startsWith('set osaka-1/writer')) &&
        Date.now() < deadline
      )
        await Bun.sleep(50)
      expect(
        s.desktop.calls.find(c => c.startsWith('set osaka-1/writer')),
      ).toContain('"browser":true')
    } finally {
      await tab.close()
      s.stop()
    }
  }, 30_000)

  test('no screenshot yet reads 还没有截图; a node too old for screens says so', async () => {
    const s = await serve()
    s.desktop.screens.clear()
    const tab = await browser.tab()
    try {
      await signIn(tab, s.base, s.ops)
      await tab.goto(`${s.base}/admin/desktop`)
      await tab.waitFor(`${q(SHOT)}.isConnected`)
      const deadline = Date.now() + 5_000
      while (!s.desktop.calls.includes('view tokyo-1/planner')) {
        if (Date.now() > deadline) throw new Error('the page never asked')
        await Bun.sleep(25)
      }
      expect(
        await tab.evaluate<string>(
          `${q(`${SHOT} .dk-shot-empty`)}.textContent`,
        ),
      ).toBe('还没有截图')
      expect(await tab.evaluate<boolean>(`${q(`${SHOT} img`)}.hidden`)).toBe(
        true,
      )

      s.desktop.failView = {
        code: 'unsupported',
        message: '节点版本过旧 · 不能查看画面',
      }
      await tab.goto(`${s.base}/admin/desktop`)
      await tab.waitFor(
        `${q(`${SHOT} .dk-shot-empty`)}.textContent === '节点版本过旧 · 不能查看画面'`,
      )
    } finally {
      await tab.close()
      s.stop()
    }
  }, 30_000)

  test('the applications dialog: filled from the card, checked before it sends, written as chosen', async () => {
    const s = await serve()
    const tab = await browser.tab()
    try {
      await signIn(tab, s.base, s.ops)
      await tab.goto(`${s.base}/admin/desktop`)
      await tab.evaluate(
        click('[data-key="tokyo-1/planner"] [data-action="desktop-apps"]'),
      )
      await tab.waitFor(`${q('#desktop-apps')}.open`)
      const form = q('#desktop-apps-form')
      expect(
        await tab.evaluate<string>(`${form}.elements.appsList.value`),
      ).toBe('org.gnome.TextEditor\norg.gnome.Calculator\nfirefox-esr')
      expect(
        await tab.evaluate<string>(
          `${form}.querySelector('input[name="appsMode"]:checked').value`,
        ),
      ).toBe('list')
      expect(
        await tab.evaluate<string>(`${q('#desktop-apps-name')}.textContent`),
      ).toBe('planner · tokyo-1')
      // A list the node could not take is marked, and nothing is sent.
      await tab.evaluate(`${form}.elements.appsList.value = 'gedit 文本'`)
      await tab.evaluate(click('#desktop-apps-form button[type="submit"]'))
      await tab.waitFor(`${q('#f-desktop-apps-appsList-error')}`)
      expect(
        await tab.evaluate<string>(
          `${q('#f-desktop-apps-appsList-error')}.textContent`,
        ),
      ).toBe('编号只能是可见字符 · 每个至多 200 个')
      expect(s.desktop.calls.some(c => c.startsWith('set '))).toBe(false)
      // 不给: the list is set aside, and the change is the one word.
      await tab.evaluate(
        click('#desktop-apps-form input[name="appsMode"][value="none"]'),
      )
      expect(
        await tab.evaluate<boolean>(`${form}.elements.appsList.disabled`),
      ).toBe(true)
      await tab.evaluate(click('#desktop-apps-form button[type="submit"]'))
      await tab.waitFor(`!${q('#desktop-apps')}.open`)
      const saved = s.desktop.calls.filter(c => c.startsWith('set '))
      expect(saved).toHaveLength(1)
      expect(saved[0]).toStartWith('set tokyo-1/planner {"apps":"none"} u:')
      await tab.waitFor(
        `${q('[data-key="tokyo-1/planner"] .dk-apps')}.textContent === '不给'`,
      )
      // The terminal and the confirmation are one switch each, on the card.
      await tab.evaluate(click('#dk-terminal-tokyo-1-planner'))
      await tab.evaluate(
        click(
          '[data-key="tokyo-1/planner"] input[data-desktop-confirm][value="autonomous"]',
        ),
      )
      const deadline = Date.now() + 5_000
      while (s.desktop.calls.filter(c => c.startsWith('set ')).length < 3) {
        if (Date.now() > deadline) throw new Error('the switches never sent')
        await Bun.sleep(25)
      }
      const sets = s.desktop.calls.filter(c => c.startsWith('set '))
      expect(sets.some(c => c.includes('{"terminal":true}'))).toBe(true)
      expect(sets.some(c => c.includes('{"confirm":"autonomous"}'))).toBe(true)
    } finally {
      await tab.close()
      s.stop()
    }
  }, 30_000)

  test('a macOS host desktop asks for its list first, offers nothing but a list, and turns on with it', async () => {
    const s = await serve()
    const tab = await browser.tab()
    try {
      await signIn(tab, s.base, s.ops)
      await tab.goto(`${s.base}/admin/desktop`)
      await tab.evaluate(click('#dk-computer-kyoto-1-designer'))
      await tab.waitFor(`${q('#desktop-apps')}.open`)
      // The switch waits for the list.
      expect(
        await tab.evaluate<boolean>(
          `${q('#dk-computer-kyoto-1-designer')}.checked`,
        ),
      ).toBe(false)
      expect(s.desktop.calls.some(c => c.startsWith('set '))).toBe(false)
      expect(
        await tab.evaluate<string[]>(
          `Array.from(document.querySelectorAll('#desktop-apps-form .seg-opt')).filter(function (o) { return o.offsetParent !== null; }).map(function (o) { return o.textContent; })`,
        ),
      ).toEqual(['列表'])
      expect(
        await tab.evaluate<string>(`${q('#desktop-apps-note')}.textContent`),
      ).toContain('本机桌面只能操作列表里的应用')
      // Twenty-one ids are one too many for a host desktop.
      await tab.evaluate(
        `${q('#desktop-apps-form')}.elements.appsList.value = Array.from({ length: 21 }, function (_, i) { return 'com.example.app' + i; }).join('\\n')`,
      )
      await tab.evaluate(click('#desktop-apps-form button[type="submit"]'))
      await tab.waitFor(`${q('#f-desktop-apps-appsList-error')}`)
      expect(
        await tab.evaluate<string>(
          `${q('#f-desktop-apps-appsList-error')}.textContent`,
        ),
      ).toBe('至多 20 个')
      await tab.evaluate(
        `${q('#desktop-apps-form')}.elements.appsList.value = 'com.apple.Safari\\ncom.apple.TextEdit\\ncom.apple.Safari'`,
      )
      await tab.evaluate(click('#desktop-apps-form button[type="submit"]'))
      await tab.waitFor(`!${q('#desktop-apps')}.open`)
      const sets = s.desktop.calls.filter(c => c.startsWith('set '))
      expect(sets).toHaveLength(1)
      expect(sets[0]).toContain('set kyoto-1/designer ')
      expect(sets[0]).toContain('"computer":true')
      expect(sets[0]).toContain(
        '"apps":["com.apple.Safari","com.apple.TextEdit"]',
      )
      await tab.waitFor(`${q('#dk-computer-kyoto-1-designer')}.checked`)
      expect(
        await tab.evaluate<string>(
          `${q('[data-key="kyoto-1/designer"] .dk-apps')}.textContent`,
        ),
      ).toBe('com.apple.Safaricom.apple.TextEdit')
    } finally {
      await tab.close()
      s.stop()
    }
  }, 30_000)
})
