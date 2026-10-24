// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The main window's two modes and the settings card, in a real browser
 * (P37.13, `docs/dev/qmo-local.md` §3.6):
 *
 * 1. **Work | Code.** The switch under the brand moves between the two
 *    faces; Work is `/` in a browser and `/app` in the desktop app.
 * 2. **Code.** In a browser, and in an app without `qmo_local_agents`, one
 *    line and nothing to start; in an app with it, the agents it found, the
 *    ready ones to pick and 开始 held shut; an app whose qmo cannot answer
 *    says why in the status line.
 * 3. **The card.** The slider, the ⋯ menu's 设置, ⌘, and the app's
 *    `window.__qmoOpenSettings` open it where it was last; already open,
 *    they only take the focus. Esc, the ×, and a press on the scrim close
 *    it, the address goes back and the focus returns to what opened it;
 *    while it is up the focus stays inside; the search narrows the list.
 *
 * The desktop app is a stub in the page (`window.__QMO_SHELL__` and a Tauri
 * `invoke` that records its calls) and the app's cookie; no app window is
 * started. Skipped, with the reason printed, on a machine without Chrome.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createConsoleHandler } from '../../src/http.js'
import { ADMIN, TOKENS, pageHarness } from '../pageHarness.js'
import { Browser, skipReason, type Tab } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[modes browser tests] skipped: ${SKIP}`)

function serve(): { base: string; stop(): void } {
  const harness = pageHarness({ chat: true })
  const handle = createConsoleHandler(harness.deps, TOKENS)
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      // Polling stands in for the revision stream, as in the other suites.
      if (new URL(request.url).pathname === '/v0/events') {
        return new Response(null, { status: 503 })
      }
      return handle(request)
    },
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true)
    },
  }
}

const AGENTS = {
  agents: [
    {
      id: 'claude-code',
      name: 'Claude Code',
      version: '2.1.4',
      path: '/usr/local/bin/claude',
      protocol: 'claude-stream',
      available: true,
    },
    {
      id: 'codex',
      name: 'Codex',
      version: '0.48.0',
      path: '/opt/homebrew/bin/codex',
      protocol: 'codex-app-server',
      available: true,
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      version: '0.9.0',
      path: '/usr/local/bin/gemini',
      protocol: 'acp',
      available: false,
      reason: '版本太旧 · 需要 0.12 以上',
    },
  ],
}

/**
 * The desktop app as the page sees it. `agents` is what `qmo_local_agents`
 * answers, or the string it refuses with; every other command but the
 * settings window is refused the way an app without it does.
 */
function shellStub(agents: object | string): string {
  return `
    window.__QMO_SHELL__ = Object.freeze({ platform: 'macos', window: 'main', version: '3.2.0' });
    window.__calls = [];
    window.__TAURI__ = { core: { invoke: function (command, args) {
      window.__calls.push([command, args === undefined ? null : args]);
      const agents = ${JSON.stringify(agents)};
      if (command === 'qmo_local_agents') {
        return typeof agents === 'string' ? Promise.reject(agents) : Promise.resolve(agents);
      }
      if (command === 'qmo_open_local_settings') return Promise.resolve(null);
      return Promise.reject('Command ' + command + ' not found');
    } } };
  `
}

/** Opens `path` signed in, inside the app when `shell` is given. */
async function open(
  tab: Tab,
  base: string,
  path: string,
  shell?: object | string,
): Promise<void> {
  await tab.send('Network.enable')
  await tab.send('Network.clearBrowserCookies')
  if (shell !== undefined) {
    await tab.send('Network.setCookie', {
      name: 'qianmo_shell',
      value: 'macos',
      url: base,
    })
    await tab.send('Page.addScriptToEvaluateOnNewDocument', {
      source: shellStub(shell),
    })
  }
  await tab.goto(
    `${base}${path}${path.includes('?') ? '&' : '?'}token=${ADMIN}`,
  )
  await tab.waitFor('window.qianmoConsole !== undefined')
}

const q = (selector: string) =>
  `document.querySelector(${JSON.stringify(selector)})`

async function key(
  tab: Tab,
  name: string,
  code: string,
  keyCode: number,
  modifiers = 0,
): Promise<void> {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await tab.send('Input.dispatchKeyEvent', {
      type,
      key: name,
      code,
      windowsVirtualKeyCode: keyCode,
      modifiers,
    })
  }
}

/** The card is up with the area at `path` in it, settled. */
async function cardOn(tab: Tab, path: string): Promise<void> {
  await tab.waitFor(
    `${q('#settings')}.open && location.pathname === ${JSON.stringify(path)} && ` +
      `${q('#page-title')}.textContent !== '' && !${q('#settings')}.hasAttribute('data-busy') && ` +
      `${q('#settings')}.hasAttribute('data-shown')`,
  )
}

/** The card is down, and the address is `path`. */
async function cardClosed(tab: Tab, path: string): Promise<void> {
  await tab.waitFor(
    `!${q('#settings')}.open && location.pathname === ${JSON.stringify(path)}`,
  )
}

describe.skipIf(SKIP !== null)('Work and Code', () => {
  let browser: Browser
  let served: ReturnType<typeof serve>

  beforeAll(async () => {
    browser = await Browser.launch()
    served = serve()
  }, 30_000)

  afterAll(async () => {
    served?.stop()
    await browser?.close()
  }, 30_000)

  test('the switch moves between the two faces; Work is / in a browser and /app in the app', async () => {
    const tab = await browser.tab()
    try {
      await open(tab, served.base, '/')
      const switchOn = `[...document.querySelectorAll('.fx-switch-item')].map(a => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')])`
      expect(await tab.evaluate<unknown[]>(switchOn)).toEqual([
        ['Work', '/', 'page'],
        ['Code', '/code', null],
      ])
      // One switch the width of the side list, its two halves equal.
      const halves = await tab.evaluate<number[]>(
        `[...document.querySelectorAll('.fx-switch-item')].map(a => Math.round(a.getBoundingClientRect().width))`,
      )
      expect(halves[0]).toBe(halves[1])
      await tab.evaluate(`${q('.fx-switch-item[data-to="code"]')}.click()`)
      await tab.waitFor(
        `location.pathname === '/code' && window.qianmoConsole !== undefined && ${q('#code-web')} !== null`,
      )
      expect(await tab.evaluate<unknown[]>(switchOn)).toEqual([
        ['Work', '/', null],
        ['Code', '/code', 'page'],
      ])
    } finally {
      await tab.close()
    }
    const app = await browser.tab()
    try {
      await open(app, served.base, '/code', AGENTS)
      expect(
        await app.evaluate<string>(
          `${q('.fx-switch-item[data-to="work"]')}.getAttribute('href')`,
        ),
      ).toBe('/app')
      await app.evaluate(`${q('.fx-switch-item[data-to="work"]')}.click()`)
      await app.waitFor(
        `location.pathname === '/app' && ${q('#fx')} !== null && ${q('#fx')}.getAttribute('data-layout') === 'chat'`,
      )
    } finally {
      await app.close()
    }
  }, 60_000)

  test('Code in a browser: one line, nothing to start, no link', async () => {
    const tab = await browser.tab()
    try {
      await open(tab, served.base, '/code')
      expect(
        await tab.evaluate<unknown>(`({
          web: ${q('#code-web')}.hidden,
          local: ${q('#code-local')}.hidden,
          line: ${q('#code-web')}.textContent,
          start: ${q('#code-new')}.disabled,
          links: document.querySelectorAll('#fx-main a').length,
        })`),
      ).toEqual({
        web: false,
        local: true,
        line: 'Code 在 Qmo 桌面版里用',
        start: true,
        links: 0,
      })
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('Code in the app: the agents it found, the ready ones to pick, 开始 held shut; 重新检测 asks again', async () => {
    const tab = await browser.tab()
    try {
      await open(tab, served.base, '/code', AGENTS)
      await tab.waitFor(
        `document.querySelectorAll('#code-agents li').length === 3`,
      )
      expect(
        await tab.evaluate<unknown>(`({
          web: ${q('#code-web')}.hidden,
          rows: [...document.querySelectorAll('#code-agents li')].map(li => li.textContent),
          off: [...document.querySelectorAll('#code-agents li.is-off .fx-code-name')].map(el => el.textContent),
          picks: [...${q('#code-agent')}.options].map(o => o.value),
          go: ${q('#code-go')}.disabled,
          closed: ${q('.fx-code-closed')}.textContent,
          state: ${q('#code-state')}.textContent,
        })`),
      ).toEqual({
        web: true,
        rows: [
          'Claude Code2.1.4可用',
          'Codex0.48.0可用',
          'Gemini CLI0.9.0版本太旧 · 需要 0.12 以上',
        ],
        off: ['Gemini CLI'],
        picks: ['claude-code', 'codex'],
        go: true,
        closed: '本机会话未开放',
        state: '',
      })
      await tab.evaluate(`${q('#code-rescan')}.click()`)
      await tab.waitFor(
        `window.__calls.filter(c => c[0] === 'qmo_local_agents').length === 2`,
      )
      expect(
        await tab.evaluate<unknown[]>(
          `window.__calls.filter(c => c[0] === 'qmo_local_agents').map(c => c[1])`,
        ),
      ).toEqual([{ rescan: false }, { rescan: true }])
      // The answer is drawn as text, never as markup.
      expect(
        await tab.evaluate<number>(
          `document.querySelectorAll('#code-agents li *').length`,
        ),
      ).toBeLessThanOrEqual(3 * 5)
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('an app older than the command gets the one line; an app whose qmo cannot answer says why', async () => {
    const old = await browser.tab()
    try {
      await open(
        old,
        served.base,
        '/code',
        'Command qmo_local_agents not found',
      )
      await old.waitFor(
        `!${q('#code-web')}.hidden && ${q('#code-local')}.hidden`,
      )
      expect(await old.evaluate<boolean>(`${q('#code-new')}.disabled`)).toBe(
        true,
      )
    } finally {
      await old.close()
    }
    const failing = await browser.tab()
    try {
      // The app has the command; its qmo has no `agents` (§3.6).
      await open(
        failing,
        served.base,
        '/code',
        'qmo agents: unknown command "agents"',
      )
      await failing.waitFor(
        `${q('#code-state')}.textContent === 'qmo agents: unknown command "agents"'`,
      )
      expect(
        await failing.evaluate<unknown>(`({
          web: ${q('#code-web')}.hidden,
          local: ${q('#code-local')}.hidden,
          again: ${q('#code-rescan')}.disabled,
        })`),
      ).toEqual({ web: true, local: false, again: false })
    } finally {
      await failing.close()
    }
  }, 30_000)
})

describe.skipIf(SKIP !== null)('the settings card', () => {
  let browser: Browser
  let served: ReturnType<typeof serve>

  beforeAll(async () => {
    browser = await Browser.launch()
    served = serve()
  }, 30_000)

  afterAll(async () => {
    served?.stop()
    await browser?.close()
  }, 30_000)

  test('the slider opens it on its search, Esc closes it back to the page, and the focus returns', async () => {
    const tab = await browser.tab()
    try {
      await open(tab, served.base, '/')
      const before = await tab.evaluate<number>('history.length')
      await tab.evaluate(
        `${q('.fx-side-foot a[data-settings]')}.focus(); ${q('.fx-side-foot a[data-settings]')}.click()`,
      )
      await tab.waitFor(
        `${q('#settings')}.open && location.pathname.indexOf('/admin/') === 0`,
      )
      const first = await tab.evaluate<string>('location.pathname')
      await cardOn(tab, first)
      // The 200 ms way in, over.
      await tab.waitFor(
        `getComputedStyle(${q('.set-card')}).transform === 'none' && getComputedStyle(${q('#settings')}).backgroundColor === 'rgba(0, 0, 0, 0.4)'`,
      )
      expect(
        await tab.evaluate<unknown>(`({
          modal: ${q('#settings')}.matches(':modal'),
          focus: document.activeElement.id,
          pushed: history.length,
          card: (() => { const r = ${q('.set-card')}.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
          scrim: getComputedStyle(${q('#settings')}).backgroundColor,
        })`),
      ).toEqual({
        modal: true,
        focus: 'set-search',
        pushed: before + 1,
        // min(1080, 1280 - 64) × min(800, 900 - 64)
        card: [1080, 800],
        scrim: 'rgba(0, 0, 0, 0.4)',
      })
      await key(tab, 'Escape', 'Escape', 27)
      await cardClosed(tab, '/')
      expect(
        await tab.evaluate<boolean>(
          `document.activeElement === ${q('.fx-side-foot a[data-settings]')}`,
        ),
      ).toBe(true)
      expect(await tab.evaluate<string>('document.title')).not.toContain(
        '阡陌控制台',
      )
    } finally {
      await tab.close()
    }
  }, 30_000)

  test("the ⋯ menu, ⌘, and the app's __qmoOpenSettings open it where it was last; already open, they only take the focus", async () => {
    const tab = await browser.tab()
    try {
      await open(tab, served.base, '/')
      expect(
        await tab.evaluate<string>('typeof window.__qmoOpenSettings'),
      ).toBe('function')
      // To 消息链 and closed with the ×.
      await tab.evaluate(`${q('.fx-side-foot a[data-settings]')}.click()`)
      await tab.waitFor(`${q('#settings')}.open`)
      await tab.evaluate(`${q('#nav-audit')}.click()`)
      await cardOn(tab, '/admin/audit')
      await tab.evaluate(`${q('.set-close')}.click()`)
      await cardClosed(tab, '/')

      // ⌘,: where it was.
      await key(tab, ',', 'Comma', 188, 4)
      await cardOn(tab, '/admin/audit')
      // Again, and the app's menu, while it is up: the focus, nothing else.
      const length = await tab.evaluate<number>('history.length')
      await tab.evaluate(`${q('#nav-nodes')}.focus()`)
      await key(tab, ',', 'Comma', 188, 4)
      await tab.evaluate('window.__qmoOpenSettings()')
      expect(
        await tab.evaluate<unknown>(`({
          open: ${q('#settings')}.open,
          path: location.pathname,
          length: history.length,
          inside: ${q('#settings')}.contains(document.activeElement),
        })`),
      ).toEqual({
        open: true,
        path: '/admin/audit',
        length,
        inside: true,
      })

      // A press on the scrim closes it.
      for (const type of ['mousePressed', 'mouseReleased']) {
        await tab.send('Input.dispatchMouseEvent', {
          type,
          x: 8,
          y: 8,
          button: 'left',
          clickCount: 1,
        })
      }
      await cardClosed(tab, '/')

      // The ⋯ menu's 设置.
      await tab.evaluate(
        `${q('.fx-side-foot details')}.open = true; ${q('.fx-side-foot .fx-menu-item[data-settings]')}.click()`,
      )
      await cardOn(tab, '/admin/audit')
      expect(
        await tab.evaluate<boolean>(`${q('.fx-side-foot details')}.open`),
      ).toBe(false)
      await tab.evaluate(`${q('.set-close')}.click()`)
      await cardClosed(tab, '/')

      // The app's menu, from the Code face.
      await tab.evaluate(`${q('.fx-switch-item[data-to="code"]')}.click()`)
      await tab.waitFor(
        `location.pathname === '/code' && typeof window.__qmoOpenSettings === 'function'`,
      )
      await tab.evaluate('window.__qmoOpenSettings()')
      await cardOn(tab, '/admin/audit')
      await tab.evaluate(`${q('.set-close')}.click()`)
      await cardClosed(tab, '/code')
    } finally {
      await tab.close()
    }
  }, 60_000)

  test('while it is up the focus stays inside it', async () => {
    const tab = await browser.tab()
    try {
      await open(tab, served.base, '/admin/nodes')
      await cardOn(tab, '/admin/nodes')
      const outside: string[] = []
      for (let i = 0; i < 60; i += 1) {
        await key(tab, 'Tab', 'Tab', 9, i % 2 === 0 ? 0 : 8)
        await key(tab, 'Tab', 'Tab', 9)
        const where = await tab.evaluate<string>(
          `${q('#settings')}.contains(document.activeElement) ? '' : (document.activeElement.id || document.activeElement.tagName)`,
        )
        if (where !== '') outside.push(where)
      }
      expect(outside).toEqual([])
    } finally {
      await tab.close()
    }
  }, 60_000)

  test('the search narrows the list to the names that match, and Enter opens the first left', async () => {
    const tab = await browser.tab()
    try {
      await open(tab, served.base, '/admin/nodes')
      await cardOn(tab, '/admin/nodes')
      const type = (text: string) =>
        tab.evaluate(
          `(() => { const s = ${q('#set-search')}; s.value = ${JSON.stringify(text)}; s.dispatchEvent(new Event('input', { bubbles: true })); })()`,
        )
      const shown = `[...document.querySelectorAll('#set-nav .nav-item')].filter(a => a.getClientRects().length > 0).map(a => a.textContent)`
      await type('消息')
      expect(await tab.evaluate<string[]>(shown)).toEqual(['消息链'])
      await type('没有这一项')
      expect(await tab.evaluate<string[]>(shown)).toEqual([])
      expect(await tab.evaluate<boolean>(`${q('#set-none')}.hidden`)).toBe(
        false,
      )
      await type('消息')
      await tab.evaluate(`${q('#set-search')}.focus()`)
      await key(tab, 'Enter', 'Enter', 13)
      await cardOn(tab, '/admin/audit')
    } finally {
      await tab.close()
    }
  }, 30_000)

  test("an area's address: the card is up from the first paint, and closing it lands on the Work face", async () => {
    const tab = await browser.tab()
    try {
      await tab.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      })
      await open(tab, served.base, '/admin/nodes')
      expect(
        await tab.evaluate<unknown>(`({
          modal: ${q('#settings')}.matches(':modal'),
          shown: ${q('#settings')}.hasAttribute('data-shown'),
          title: ${q('#page-title')}.textContent,
          opacity: getComputedStyle(${q('.set-card')}).opacity,
        })`),
      ).toEqual({ modal: true, shown: true, title: '节点', opacity: '1' })
      await tab.evaluate(`${q('.set-close')}.click()`)
      // Reduced motion: no wait for an animation.
      expect(await tab.evaluate<boolean>(`${q('#settings')}.open`)).toBe(false)
      await cardClosed(tab, '/')
      expect(await tab.evaluate<boolean>(`${q('#fx-composer')} !== null`)).toBe(
        true,
      )
      expect(await tab.evaluate<string>('document.title')).toContain('对话')
    } finally {
      await tab.close()
    }
  }, 30_000)

  test("inside the app the card offers the app's own settings window", async () => {
    const tab = await browser.tab()
    try {
      await open(tab, served.base, '/app', AGENTS)
      expect(await tab.evaluate<boolean>(`${q('#set-desktop')}.hidden`)).toBe(
        false,
      )
      await tab.evaluate('window.__qmoOpenSettings()')
      await tab.waitFor(`${q('#settings')}.open`)
      await tab.evaluate(`${q('#set-desktop')}.click()`)
      await tab.waitFor(
        `window.__calls.some(c => c[0] === 'qmo_open_local_settings')`,
      )
      await tab.evaluate(`${q('.set-close')}.click()`)
      await cardClosed(tab, '/app')
    } finally {
      await tab.close()
    }
    const browserTab = await browser.tab()
    try {
      await open(browserTab, served.base, '/')
      expect(
        await browserTab.evaluate<boolean>(`${q('#set-desktop')}.hidden`),
      ).toBe(true)
    } finally {
      await browserTab.close()
    }
  }, 30_000)
})
