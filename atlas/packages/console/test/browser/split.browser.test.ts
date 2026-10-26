// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 分栏与侧栏 in a real browser (P37.18, `docs/dev/qmo-app.md` §11), against
 * a hub on loopback whose agents answer by themselves (the previews'
 * `PreviewChat`, with its approvals):
 *
 * 1. **Panes on Work.** A row's ⋯ opens one to the right, the unsent line
 *    going with the window's conversation into the first pane; ⌃⌘\ and ⌃⌘-
 *    up to four with a lower split, and no fifth; the dividers drag no
 *    smaller than 320 × 200, even out on a double-click or Enter, step by
 *    the arrows; under that only the focused pane shows. ⌃] / ⌃[ move the
 *    focus, from inside a pane too; ⌃⌘W closes, and down to one the window
 *    is itself again, the line carried back. A row picked opens in the
 *    focused pane without loading it again; one open already takes the
 *    focus. A row dragged onto the content and a right-click open one too.
 * 2. **Kept.** The layout comes back after a reload; one out of shape is
 *    dropped for one pane. A conversation that cannot be opened is one line
 *    and 关闭.
 * 3. **The side list's peek.** ⌘B and the button collapse it, kept; a rest
 *    on the button floats it out over the content, which does not move;
 *    leaving folds it after the grace, coming back keeps it; a menu open in
 *    it keeps it out; a click opens it for good; Esc folds it and gives the
 *    button back the focus; the keyboard floats it at once; without hover it
 *    is a drawer; with reduced motion nothing slides.
 * 4. **Code** in the fake app (`./codeShell.ts`): two local sessions side by
 *    side on the window's one runner channel, whether the app's globals are
 *    in the top frame only (WKWebView, WebKitGTK) or in every frame
 *    (WebView2); a session the runner no longer has is one line and 关闭.
 * 5. **One connection.** Four panes streaming answers, a fifth line sent and
 *    approvals read meanwhile: one `/v0/chat/stream` for the window, and no
 *    request waits. Against it, six streams of a page's own hold the next
 *    request back — the limit the relay is for.
 * 6. **Three languages, light and dark contrast, 375 px.**
 *
 * No app window, runner or agent is started. Skipped, with the reason
 * printed, on a machine without Chrome.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PEEK_CLOSE_MS, PEEK_OPEN_MS } from '../../src/assets/frontSplit.js'
import { LANGS } from '../../src/i18n.js'
import { html } from '../../src/respond.js'
import { SPLIT_TEXT } from '../../src/view/frontSplit.js'
import { accountsHarness, type Person, person } from '../accountsHarness.js'
import { PreviewApprovals } from '../preview/approvals.js'
import { ownResidents, PreviewChat } from '../preview/chat.js'
import { WorkRoutes } from '../workFake.js'
import { Browser, skipReason, type Tab } from './cdp.js'
import { type FakeShellOptions, fakeShell } from './codeShell.js'
import { type Probe, probe } from './contrastProbe.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[split browser tests] skipped: ${SKIP}`)

const OPS = 'qianmo://hub/ops'
const REVIEWER = 'qianmo://beta-5/reviewer'
const CODER = 'qianmo://beta-5/coder'
const PLANNER = 'qianmo://beta-1/planner'
const agent = (address: string) => `agent=${encodeURIComponent(address)}`
/** A session id the hub answers with a gateway's error page (framing refused). */
const BROKEN = 'session=broken'

interface Served {
  readonly base: string
  readonly ops: Person
  /** `/v0/chat/stream` responses open now, and asked for in all. */
  streams(): { readonly open: number; readonly asked: number }
  stop(): void
}

async function serve(): Promise<Served> {
  const chat = new PreviewChat()
  const h = accountsHarness({
    deps: {
      chat,
      approvals: new PreviewApprovals(Date.now()),
      chatDefault: OPS,
    },
  })
  const ops = await person(h.handle, 'ops')
  ownResidents(chat, h.book, ops.credential)
  const work = new WorkRoutes({
    chat,
    handle: h.handle,
    book: h.book,
    main: OPS,
    outputs: chat.outputs,
  })
  let open = 0
  let asked = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.searchParams.get('session') === 'broken') {
        return html('<!DOCTYPE html><title>502</title><p>bad gateway</p>', 502)
      }
      if (url.pathname !== '/v0/chat/stream') return work.fetch(request)
      asked += 1
      open += 1
      let gone = false
      request.signal.addEventListener('abort', () => {
        if (!gone) open -= 1
        gone = true
      })
      return work.fetch(request)
    },
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    ops,
    streams: () => ({ open, asked }),
    stop: () => {
      server.stop(true)
    },
  }
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const q = (selector: string) =>
  `document.querySelector(${JSON.stringify(selector)})`
const FRAMES = `[...document.querySelectorAll('.fx-pane-frame')]`
/** `js` run with `this` the `i`-th pane's window. */
const inPane = (i: number, js: string) =>
  `(function () { ${js} }).call(document.querySelectorAll('.fx-pane-frame')[${i}].contentWindow)`
/** Every pane's address, `pane=1` and all. */
const ADDRESSES = `${FRAMES}.map(f => f.contentWindow.location.pathname + f.contentWindow.location.search)`
/** Which pane has the focus, by its place. */
const FOCUSED = `[...document.querySelectorAll('.fx-pane')].findIndex(p => p.hasAttribute('data-focus'))`
/** The side list collapsed and done sliding: its button at the top left. */
const SETTLED_OPENER = `(() => { const r = document.querySelector('.fx-top .fx-side-open').getBoundingClientRect();
  return r.width > 0 && r.left < 40 && getComputedStyle(document.getElementById('fx')).gridTemplateColumns.split(' ')[0] === '0px'; })()`

/** `n` panes, the first `ready` of them drawn and their script up. */
const READY = (n: number, ready = n) =>
  `document.querySelectorAll('.fx-pane-frame').length === ${n} && ${FRAMES}.slice(0, ${ready}).every(f => {
    try { return f.contentDocument.readyState === 'complete' && !!f.contentDocument.querySelector('#fx[data-pane="1"]') && !!f.contentWindow.qianmoSplit; }
    catch (e) { return false; }
  })`
const KEPT = (face: 'work' | 'code') =>
  `JSON.parse(localStorage.getItem('qianmo.split.${face}') || 'null')`

interface OpenOptions {
  readonly width?: number
  readonly height?: number
  readonly lang?: string
  readonly scheme?: 'light' | 'dark'
  readonly motion?: 'reduce' | 'no-preference'
  readonly shell?: FakeShellOptions
  /** Set before the page loads: the layout, the side list's state. */
  readonly store?: Readonly<Record<string, string>>
}

/** `path` signed in as ops, with the page's script up. */
async function open(
  browser: Browser,
  served: Served,
  path: string,
  options: OpenOptions = {},
): Promise<Tab> {
  const tab = await browser.tab({
    width: options.width ?? 1440,
    height: options.height ?? 900,
  })
  await tab.send('Network.enable')
  await tab.send('Network.setCookie', {
    name: 'qianmo_session',
    value: served.ops.sid,
    url: served.base,
    httpOnly: true,
    sameSite: 'Strict',
  })
  if (options.lang !== undefined) {
    await tab.send('Network.setCookie', {
      name: 'qianmo_lang',
      value: options.lang,
      url: served.base,
    })
  }
  if (options.shell !== undefined) {
    await tab.send('Network.setCookie', {
      name: 'qianmo_shell',
      value: 'macos',
      url: served.base,
    })
    await tab.send('Page.addScriptToEvaluateOnNewDocument', {
      source: fakeShell(options.shell),
    })
  }
  await tab.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: options.scheme ?? 'light' },
      {
        name: 'prefers-reduced-motion',
        value: options.motion ?? 'no-preference',
      },
    ],
  })
  // The origin's storage, shared by the browser's tabs: emptied, then the
  // test's own, before the page that reads it.
  await tab.goto(`${served.base}/v0/none`)
  await tab.evaluate(
    `(() => { localStorage.clear(); const s = ${JSON.stringify(options.store ?? {})}; for (const k in s) localStorage.setItem(k, s[k]); })()`,
  )
  await tab.goto(`${served.base}${path}`)
  await tab.waitFor('window.qianmoSplit !== undefined')
  return tab
}

/** The modifiers of ⌃⌘ (Ctrl+Alt off a Mac) and of ⌘ (Ctrl), as the page reads the platform. */
async function mods(tab: Tab): Promise<{ both: number; mod: number }> {
  const mac = await tab.evaluate<boolean>(
    `/Mac|iPhone|iPad/.test(navigator.platform || '')`,
  )
  // CDP: Alt 1, Ctrl 2, Meta 4, Shift 8.
  return mac ? { both: 2 | 4, mod: 4 } : { both: 2 | 1, mod: 2 }
}

const KEYS: Record<string, readonly [string, string, number]> = {
  right: ['\\', 'Backslash', 220],
  below: ['-', 'Minus', 189],
  close: ['w', 'KeyW', 87],
  next: [']', 'BracketRight', 221],
  prev: ['[', 'BracketLeft', 219],
  side: ['b', 'KeyB', 66],
  esc: ['Escape', 'Escape', 27],
  tab: ['Tab', 'Tab', 9],
  enter: ['Enter', 'Enter', 13],
  left: ['ArrowLeft', 'ArrowLeft', 37],
  rightArrow: ['ArrowRight', 'ArrowRight', 39],
  down: ['ArrowDown', 'ArrowDown', 40],
}

async function key(tab: Tab, name: string, modifiers = 0): Promise<void> {
  const [k, code, vk] = KEYS[name] ?? ['', '', 0]
  for (const type of ['rawKeyDown', 'keyUp']) {
    await tab.send('Input.dispatchKeyEvent', {
      type,
      key: k,
      code,
      windowsVirtualKeyCode: vk,
      modifiers,
    })
  }
}

/** A pane key, as the platform writes it. */
async function paneKey(tab: Tab, name: string): Promise<void> {
  const { both } = await mods(tab)
  await key(tab, name, name === 'next' || name === 'prev' ? 2 : both)
}

async function mouse(
  tab: Tab,
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
  x: number,
  y: number,
  more: Record<string, unknown> = {},
): Promise<void> {
  await tab.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }),
    ...more,
  })
}

/** The middle of the first element `selector` names, in the window. */
async function centre(tab: Tab, selector: string): Promise<[number, number]> {
  return await tab.evaluate<[number, number]>(
    `(() => { const r = ${q(selector)}.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`,
  )
}

/** Each pane's box in the window, rounded. */
async function boxes(tab: Tab): Promise<number[][]> {
  return await tab.evaluate<number[][]>(
    `[...document.querySelectorAll('.fx-pane')].filter(p => !p.hidden).map(p => { const r = p.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })`,
  )
}

/** Opens a row's ⋯ and picks 在右侧打开 or 在下方打开 in it. */
async function besideFrom(
  tab: Tab,
  row: string,
  to: 'right' | 'below',
): Promise<void> {
  const more = `${q(row)}.querySelector('details.fx-more')`
  await tab.evaluate(`${more}.open = true`)
  // The two are copied in as it opens, after the row's own items.
  await tab.waitFor(
    `${more}.querySelector('.fx-menu > .fx-split-item[data-split-to="${to}"]') !== null`,
  )
  await tab.evaluate(
    `${more}.querySelector('.fx-split-item[data-split-to="${to}"]').click()`,
  )
}

const ROW = (address: string) =>
  `#fx-agents .fx-agent-row[data-address="${address}"]`

/** A kept layout of panes in one column each, or as given. */
function layout(
  cols: readonly (readonly string[])[],
  focus = 0,
): Record<string, string> {
  return {
    'qianmo.split.work': JSON.stringify({
      v: 1,
      cols: cols.map(rows => ({
        w: 1 / cols.length,
        rows: rows.map(row => ({ h: 1 / rows.length, q: row })),
      })),
      focus,
    }),
  }
}

describe.skipIf(SKIP !== null)('分栏 on Work', () => {
  let browser: Browser
  let served: Served
  beforeAll(async () => {
    browser = await Browser.launch()
    served = await serve()
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
    served?.stop()
  }, 30_000)

  test('a row’s ⋯ opens one to the right; the line goes with the first pane, the address and the row follow the focus', async () => {
    const tab = await open(browser, served, '/')
    try {
      await tab.evaluate(
        `(() => { const b = ${q('#fx-text')}; b.value = '还没发的一行'; b.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      )
      await besideFrom(tab, ROW(REVIEWER), 'right')
      await tab.waitFor(READY(2), 10_000)
      expect(
        await tab.evaluate<string>(`${q('#fx')}.getAttribute('data-split')`),
      ).toBe('2')
      expect(await tab.evaluate<string[]>(ADDRESSES)).toEqual([
        '/?pane=1',
        `/?${agent(REVIEWER)}&pane=1`,
      ])
      // The window's line is the first pane's now.
      await tab.waitFor(
        inPane(
          0,
          `return this.document.getElementById('fx-text').value === '还没发的一行'`,
        ),
      )
      expect(await tab.evaluate<string>(`${q('#fx-text')}.value`)).toBe('')
      // The new pane has the focus, its box the keyboard's; the address and the row follow.
      expect(await tab.evaluate<number>(FOCUSED)).toBe(1)
      await tab.waitFor(
        inPane(
          1,
          `return this.document.activeElement === this.document.getElementById('fx-text')`,
        ),
      )
      expect(await tab.evaluate<string>('location.search')).toBe(
        `?${agent(REVIEWER)}`,
      )
      expect(
        await tab.evaluate<string[]>(
          `[...document.querySelectorAll('#fx-side [data-split-current]')].map(r => r.getAttribute('data-address'))`,
        ),
      ).toEqual([REVIEWER])
      // Two panes side by side, half each, under the window's bar.
      const [a, b] = await boxes(tab)
      expect(a?.[2]).toBe(b?.[2] ?? -1)
      expect((a?.[0] ?? 0) + (a?.[2] ?? 0)).toBe(b?.[0] ?? -1)
      // A pane's bar: its title, ⌄ and ×; the side list's button floats over the first.
      expect(
        await tab.evaluate<boolean[]>(
          `[0, 1].map(i => { const d = document.querySelectorAll('.fx-pane-frame')[i].contentDocument;
            return !!d.querySelector('#fx-pane-more summary') && d.querySelector('.fx-pane-close').offsetWidth > 0 && getComputedStyle(d.querySelector('.fx-side')).display === 'none'; })`,
        ),
      ).toEqual([true, true])
      expect(await tab.evaluate<unknown>(KEPT('work'))).toEqual({
        v: 1,
        cols: [
          { w: 0.5, rows: [{ h: 1, q: '' }] },
          { w: 0.5, rows: [{ h: 1, q: agent(REVIEWER) }] },
        ],
        focus: 1,
      })
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('⌃] / ⌃[ move the focus from inside a pane; ⌃⌘W closes, and at one the window is itself, the line carried back', async () => {
    const tab = await open(browser, served, '/', {
      store: layout([[''], [agent(REVIEWER)], [agent(PLANNER)]], 1),
    })
    try {
      await tab.waitFor(READY(3), 10_000)
      expect(await tab.evaluate<number>(FOCUSED)).toBe(1)
      await tab.evaluate(
        inPane(1, `this.document.getElementById('fx-text').focus()`),
      )
      await paneKey(tab, 'next')
      expect(await tab.evaluate<number>(FOCUSED)).toBe(2)
      await tab.waitFor(
        inPane(
          2,
          `return this.document.hasFocus() && this.document.activeElement === this.document.getElementById('fx-text')`,
        ),
      )
      await paneKey(tab, 'next')
      expect(await tab.evaluate<number>(FOCUSED)).toBe(0)
      await paneKey(tab, 'prev')
      expect(await tab.evaluate<number>(FOCUSED)).toBe(2)
      expect(await tab.evaluate<string>('location.search')).toBe(
        `?${agent(PLANNER)}`,
      )
      // A click in a pane gives it the focus.
      const [x, y] = await centre(tab, '.fx-pane:first-child')
      await mouse(tab, 'mousePressed', x, y)
      await mouse(tab, 'mouseReleased', x, y)
      await tab.waitFor(`${FOCUSED} === 0`)
      // ⌘B from inside a pane is the window's side list.
      const { mod } = await mods(tab)
      await tab.evaluate(
        inPane(0, `this.document.getElementById('fx-text').focus()`),
      )
      await key(tab, 'side', mod)
      await tab.waitFor(`${q('#fx')}.getAttribute('data-side') === 'closed'`)
      await key(tab, 'side', mod)
      await tab.waitFor(`${q('#fx')}.getAttribute('data-side') === 'open'`)
      // Close two of three: planner's pane, then ops's; reviewer's stays, its line with it.
      await tab.evaluate(
        inPane(
          1,
          `const b = this.document.getElementById('fx-text'); b.value = '带回来的一行'; b.dispatchEvent(new this.Event('input', { bubbles: true }));`,
        ),
      )
      await tab.evaluate(
        inPane(2, `this.document.getElementById('fx-text').focus()`),
      )
      await tab.waitFor(`${FOCUSED} === 2`)
      await paneKey(tab, 'close')
      await tab.waitFor(READY(2))
      expect(await tab.evaluate<number>(FOCUSED)).toBe(1)
      await tab.evaluate(
        inPane(0, `this.document.getElementById('fx-text').focus()`),
      )
      await tab.waitFor(`${FOCUSED} === 0`)
      await paneKey(tab, 'close')
      await tab.waitFor(
        `document.querySelectorAll('.fx-pane').length === 0 && !${q('#fx')}.hasAttribute('data-split')`,
      )
      await tab.waitFor(
        `location.search === '?${agent(REVIEWER)}' && ${q('#fx-thread')}.getAttribute('data-target') === '${REVIEWER}'`,
        10_000,
      )
      expect(await tab.evaluate<string>(`${q('#fx-text')}.value`)).toBe(
        '带回来的一行',
      )
      expect(await tab.evaluate<unknown>(KEPT('work'))).toBe(null)
      expect(
        await tab.evaluate<number>(
          `document.querySelectorAll('#fx-side [data-split-current]').length`,
        ),
      ).toBe(0)
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('up to four with a lower split and no fifth; dividers drag no smaller than 320 × 200, even out, step by the arrows', async () => {
    const tab = await open(browser, served, '/', {
      store: { 'qianmo.front.side': 'closed' },
    })
    try {
      await paneKey(tab, 'right')
      await tab.waitFor(READY(2), 10_000)
      await paneKey(tab, 'right')
      await tab.waitFor(READY(3), 10_000)
      await paneKey(tab, 'below')
      await tab.waitFor(READY(4), 10_000)
      // Three columns, the focused (third) one split; each new one is 开始一项工作.
      expect(await tab.evaluate<string[]>(ADDRESSES)).toEqual([
        '/?pane=1',
        '/?work=new&pane=1',
        '/?work=new&pane=1',
        '/?work=new&pane=1',
      ])
      expect(await tab.evaluate<number>(FOCUSED)).toBe(3)
      const four = await boxes(tab)
      expect(four.map(b => b[0])).toEqual([0, 720, 1080, 1080])
      expect(four[2]?.[1]).toBe(0)
      expect(four[3]?.[1]).toBe(four[2]?.[3] ?? -1)
      expect(
        await tab.evaluate<number>(
          `document.querySelectorAll('.fx-split-bar').length`,
        ),
      ).toBe(3)
      // No fifth, and no third row in a column.
      await paneKey(tab, 'right')
      await tab.waitFor(
        `[...document.querySelectorAll('#toasts .toast')].some(t => t.textContent.includes('放不下更多分栏'))`,
      )
      await paneKey(tab, 'below')
      expect(
        await tab.evaluate<number>(
          `document.querySelectorAll('.fx-pane').length`,
        ),
      ).toBe(4)
      // The first divider: dragged left 200 px, then as far as it goes.
      const [bx, by] = await centre(
        tab,
        '.fx-split-bar[data-kind="v"][data-index="0"]',
      )
      await mouse(tab, 'mousePressed', bx, by)
      await mouse(tab, 'mouseMoved', bx - 100, by, {
        button: 'left',
        buttons: 1,
      })
      // The frames let go of the pointer meanwhile.
      expect(
        await tab.evaluate<string>(
          `getComputedStyle(document.querySelector('.fx-pane-frame')).pointerEvents`,
        ),
      ).toBe('none')
      await mouse(tab, 'mouseMoved', bx - 200, by, {
        button: 'left',
        buttons: 1,
      })
      await mouse(tab, 'mouseReleased', bx - 200, by)
      expect((await boxes(tab))[1]?.[0]).toBe(520)
      await mouse(tab, 'mousePressed', bx - 200, by)
      await mouse(tab, 'mouseMoved', bx - 900, by, {
        button: 'left',
        buttons: 1,
      })
      await mouse(tab, 'mouseReleased', bx - 900, by)
      expect((await boxes(tab))[0]?.[2]).toBe(320)
      expect(
        await tab.evaluate<string>(
          `getComputedStyle(document.querySelector('.fx-pane-frame')).pointerEvents`,
        ),
      ).toBe('auto')
      // A double-click evens the columns out.
      const [ex, ey] = await centre(
        tab,
        '.fx-split-bar[data-kind="v"][data-index="0"]',
      )
      await mouse(tab, 'mousePressed', ex, ey)
      await mouse(tab, 'mouseReleased', ex, ey)
      await mouse(tab, 'mousePressed', ex, ey, { clickCount: 2 })
      await mouse(tab, 'mouseReleased', ex, ey, { clickCount: 2 })
      expect((await boxes(tab)).map(b => b[2])).toEqual([480, 480, 480, 480])
      // The lower split's divider: by the keyboard, 24 px a step, Enter to even out.
      const rows = async () => (await boxes(tab)).slice(2).map(b => b[3])
      const [top0 = 0, low0 = 0] = await rows()
      await tab.evaluate(`${q('.fx-split-bar[data-kind="h"]')}.focus()`)
      await key(tab, 'down')
      expect(await rows()).toEqual([top0 + 24, low0 - 24])
      await key(tab, 'enter')
      expect(await rows()).toEqual([top0, low0])
      expect(
        await tab.evaluate<string>(
          `${q('.fx-split-bar[data-kind="h"]')}.getAttribute('aria-valuenow')`,
        ),
      ).toBe('50')
      for (const b of await boxes(tab)) {
        expect(b[2]).toBeGreaterThanOrEqual(320)
        expect(b[3]).toBeGreaterThanOrEqual(200)
      }
      // Narrower than three columns of 320: the focused pane alone, the others kept.
      await tab.send('Emulation.setDeviceMetricsOverride', {
        width: 900,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await tab.waitFor(
        `document.querySelectorAll('.fx-pane:not([hidden])').length === 1`,
      )
      expect(await boxes(tab)).toEqual([[0, 0, 900, 900]])
      expect(
        await tab.evaluate<number>(
          `document.querySelectorAll('.fx-pane-frame').length`,
        ),
      ).toBe(4)
      await tab.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await tab.waitFor(
        `document.querySelectorAll('.fx-pane:not([hidden])').length === 4`,
      )
    } finally {
      await tab.close()
    }
  }, 60_000)

  test('a row picked opens in the focused pane without loading it again; one open already takes the focus', async () => {
    const tab = await open(browser, served, '/', {
      store: layout([[''], [agent(REVIEWER)]], 0),
    })
    try {
      await tab.waitFor(READY(2), 10_000)
      await tab.evaluate(inPane(0, `this.__same = true`))
      const entries = await tab.evaluate<number>('history.length')
      await tab.evaluate(`${q(`${ROW(PLANNER)} .fx-agent`)}.click()`)
      await tab.waitFor(
        inPane(
          0,
          `return this.document.getElementById('fx-thread').getAttribute('data-target') === '${PLANNER}'`,
        ),
        10_000,
      )
      expect(
        await tab.evaluate<boolean>(inPane(0, 'return this.__same === true')),
      ).toBe(true)
      expect(await tab.evaluate<string[]>(ADDRESSES)).toEqual([
        `/?${agent(PLANNER)}&pane=1`,
        `/?${agent(REVIEWER)}&pane=1`,
      ])
      expect(await tab.evaluate<string>('location.search')).toBe(
        `?${agent(PLANNER)}`,
      )
      // The window did not move: one entry, no Back between panes.
      expect(await tab.evaluate<number>('history.length')).toBe(entries)
      await tab.evaluate(`${q(`${ROW(REVIEWER)} .fx-agent`)}.click()`)
      await tab.waitFor(`${FOCUSED} === 1`)
      expect(
        await tab.evaluate<number>(
          `document.querySelectorAll('.fx-pane').length`,
        ),
      ).toBe(2)
      expect(
        await tab.evaluate<string[]>(
          `[...document.querySelectorAll('#fx-side [data-split-current]')].map(r => r.getAttribute('data-address'))`,
        ),
      ).toEqual([REVIEWER])
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('a row dragged onto the content: the drop is drawn where it goes; a right-click opens the row’s menu with both', async () => {
    const tab = await open(browser, served, '/')
    try {
      const drag = (to: string, x: string, y: string) => `(() => {
        const row = ${q(`${ROW(CODER)} .fx-agent`)};
        row.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
        const data = new DataTransfer();
        row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
        const main = ${q(to)};
        const r = main.getBoundingClientRect();
        const at = { bubbles: true, cancelable: true, dataTransfer: data, clientX: ${x}, clientY: ${y} };
        main.dispatchEvent(new DragEvent('dragover', at));
        const hint = ${q('.fx-drop')};
        const shown = [hint.hidden, hint.getAttribute('data-where'), Math.round(hint.getBoundingClientRect().left - r.left)];
        main.dispatchEvent(new DragEvent('drop', at));
        row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
        return [row.getAttribute('draggable'), ...shown];
      })()`
      // Onto the right third of the window's own conversation.
      const right = await tab.evaluate<unknown[]>(
        drag('#fx-main', 'r.left + r.width * 0.9', 'r.top + r.height / 2'),
      )
      const width = await tab.evaluate<number>(
        `${q('#fx-main')}.getBoundingClientRect().width`,
      )
      expect(right).toEqual(['true', false, 'right', Math.round(width / 2) + 6])
      await tab.waitFor(READY(2), 10_000)
      expect((await tab.evaluate<string[]>(ADDRESSES))[1]).toBe(
        `/?${agent(CODER)}&pane=1`,
      )
      expect(await tab.evaluate<boolean>(`${q('.fx-drop')}.hidden`)).toBe(true)
      // A right-click on planner's row: its own items, then where it opens.
      const [x, y] = await centre(tab, `${ROW(PLANNER)} .fx-agent`)
      await tab.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'right',
        clickCount: 1,
      })
      await tab.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'right',
        clickCount: 1,
      })
      await tab.waitFor(`!${q('#fx-split-ctx')}.hidden`)
      const menu = await tab.evaluate<[number, string[], number[]]>(`(() => {
        const m = ${q('#fx-split-ctx')};
        const r = m.getBoundingClientRect();
        return [m.querySelectorAll('#fx-split-ctx-items .fx-menu-item').length,
          [...m.querySelectorAll('.fx-split-item')].map(b => b.getAttribute('data-split-q')),
          [Math.round(r.left), Math.round(r.top)]];
      })()`)
      expect(menu[0]).toBeGreaterThan(0)
      expect(menu[1]).toEqual([agent(PLANNER), agent(PLANNER)])
      expect(Math.abs((menu[2][0] ?? 0) - x)).toBeLessThanOrEqual(1)
      expect(Math.abs((menu[2][1] ?? 0) - y)).toBeLessThanOrEqual(1)
      await key(tab, 'esc')
      expect(await tab.evaluate<boolean>(`${q('#fx-split-ctx')}.hidden`)).toBe(
        true,
      )
      await tab.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'right',
        clickCount: 1,
      })
      await tab.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'right',
        clickCount: 1,
      })
      await tab.waitFor(`!${q('#fx-split-ctx')}.hidden`)
      await tab.evaluate(
        `${q('#fx-split-ctx .fx-split-item[data-split-to="below"]')}.click()`,
      )
      await tab.waitFor(READY(3), 10_000)
      expect(await tab.evaluate<boolean>(`${q('#fx-split-ctx')}.hidden`)).toBe(
        true,
      )
      const [, , low] = await boxes(tab)
      const [, upper] = await boxes(tab)
      expect(low?.[0]).toBe(upper?.[0] ?? -1)
      expect(low?.[1]).toBe(upper?.[3] ?? -1)
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('kept across a reload; a layout out of shape is dropped for one pane', async () => {
    const tab = await open(browser, served, '/', {
      store: layout([['', agent(PLANNER)], [agent(REVIEWER)]], 2),
    })
    try {
      await tab.waitFor(READY(3), 10_000)
      expect(await tab.evaluate<number>(FOCUSED)).toBe(2)
      // An address that names a conversation puts it in the focused pane.
      await tab.goto(`${served.base}/?${agent(CODER)}`)
      await tab.waitFor(READY(3), 10_000)
      expect(await tab.evaluate<string[]>(ADDRESSES)).toEqual([
        '/?pane=1',
        `/?${agent(PLANNER)}&pane=1`,
        `/?${agent(CODER)}&pane=1`,
      ])
      // One the layout has takes the focus instead.
      await tab.goto(`${served.base}/?${agent(PLANNER)}`)
      await tab.waitFor(READY(3), 10_000)
      expect(await tab.evaluate<number>(FOCUSED)).toBe(1)
      for (const bad of [
        '{',
        '{"v":2,"cols":[{"w":1,"rows":[{"h":1,"q":""},{"h":1,"q":"work=new"}]}],"focus":0}',
        '{"v":1,"cols":[{"w":0,"rows":[{"h":1,"q":""}]},{"w":1,"rows":[{"h":1,"q":""}]}],"focus":0}',
        '{"v":1,"cols":[{"w":1,"rows":[{"h":1,"q":"https://x.example/"},{"h":1,"q":""}]}],"focus":0}',
        '{"v":1,"cols":[{"w":1,"rows":[{"h":1,"q":"pane=1"},{"h":1,"q":""}]}],"focus":0}',
        '{"v":1,"cols":[{"w":1,"rows":[{"h":1,"q":""}]}],"focus":0}',
        JSON.stringify({
          v: 1,
          cols: [1, 2, 3, 4, 5].map(() => ({
            w: 0.2,
            rows: [{ h: 1, q: '' }],
          })),
          focus: 0,
        }),
        JSON.stringify({
          v: 1,
          cols: [{ w: 1, rows: [1, 2, 3].map(() => ({ h: 0.3, q: '' })) }],
          focus: 0,
        }),
      ]) {
        await tab.evaluate(
          `localStorage.setItem('qianmo.split.work', ${JSON.stringify(bad)})`,
        )
        await tab.goto(`${served.base}/`)
        await tab.waitFor('window.qianmoSplit !== undefined')
        expect(
          `${bad} ${await tab.evaluate<number>(`document.querySelectorAll('.fx-pane').length`)}`,
        ).toBe(`${bad} 0`)
        expect(
          await tab.evaluate<unknown>(
            `localStorage.getItem('qianmo.split.work')`,
          ),
        ).toBe(null)
        expect(
          await tab.evaluate<string>(
            `${q('#fx-thread')}.getAttribute('data-target')`,
          ),
        ).toBe(OPS)
      }
      // Storage that throws: one pane, and nothing breaks.
      await tab.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } });`,
      })
      await tab.goto(`${served.base}/`)
      await tab.waitFor('window.qianmoSplit !== undefined')
      await paneKey(tab, 'right')
      await tab.waitFor(READY(2), 10_000)
    } finally {
      await tab.close()
    }
  }, 60_000)

  test('a conversation that cannot be opened: one line and 关闭, or the front’s own line with ×', async () => {
    const tab = await open(browser, served, '/', {
      store: layout([[''], [BROKEN], ['session=nope']], 0),
    })
    try {
      await tab.waitFor(
        `${q('.fx-pane:nth-child(2) .fx-pane-fail')} !== null`,
        10_000,
      )
      expect(
        await tab.evaluate<[string, string, boolean]>(`(() => {
          const cover = ${q('.fx-pane:nth-child(2) .fx-pane-fail')};
          return [cover.querySelector('p').textContent, cover.querySelector('button').textContent, cover.parentNode.querySelector('iframe').hidden];
        })()`),
      ).toEqual([SPLIT_TEXT['zh-CN'].paneFailed, '关闭', true])
      // Not the hub's: the session the hub does not know is the front's own line, and × closes it.
      await tab.waitFor(
        inPane(
          2,
          `return !!this.document.querySelector('#fx[data-pane="1"]') && this.document.getElementById('fx-text') !== null`,
        ),
        10_000,
      )
      expect(
        await tab.evaluate<string>(
          inPane(
            2,
            `return this.document.getElementById('fx-thread').textContent`,
          ),
        ),
      ).toContain('不在')
      await tab.evaluate(
        `${q('.fx-pane:nth-child(2) .fx-pane-fail button')}.click()`,
      )
      await tab.waitFor(`document.querySelectorAll('.fx-pane').length === 2`)
      await tab.evaluate(
        inPane(1, `this.document.querySelector('.fx-pane-close').click()`),
      )
      await tab.waitFor(`document.querySelectorAll('.fx-pane').length === 0`)
      expect(
        await tab.evaluate<string>(
          `${q('#fx-thread')}.getAttribute('data-target')`,
        ),
      ).toBe(OPS)
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('/app, the desktop app’s face: the same panes on the same kept layout', async () => {
    const tab = await open(browser, served, '/app')
    try {
      await paneKey(tab, 'right')
      await tab.waitFor(READY(2), 10_000)
      expect(await tab.evaluate<string[]>(ADDRESSES)).toEqual([
        '/app?pane=1',
        '/app?work=new&pane=1',
      ])
      expect(await tab.evaluate<string>('location.search')).toBe('?work=new')
      // A conversation from the list opens in the focused pane.
      const id = await tab.evaluate<string>(
        `${q('#fx-recents [data-action="fx-open"]')}.getAttribute('data-session')`,
      )
      await tab.evaluate(`${q('#fx-recents [data-action="fx-open"]')}.click()`)
      await tab.waitFor(
        inPane(
          1,
          `return this.document.getElementById('fx-thread').getAttribute('data-session') === ${JSON.stringify(id)}`,
        ),
        10_000,
      )
      expect(await tab.evaluate<string>('location.search')).toBe(
        `?session=${id}`,
      )
      expect(await tab.evaluate<unknown>(KEPT('work'))).toEqual({
        v: 1,
        cols: [
          { w: 0.5, rows: [{ h: 1, q: '' }] },
          { w: 0.5, rows: [{ h: 1, q: `session=${id}` }] },
        ],
        focus: 1,
      })
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('⌄ lists the row’s own items, then 只留这一栏 and 关闭分栏', async () => {
    const tab = await open(browser, served, '/', {
      store: layout([[''], [agent(REVIEWER)], [agent(PLANNER)]], 0),
    })
    try {
      await tab.waitFor(READY(3), 10_000)
      await tab.evaluate(
        inPane(1, `this.document.getElementById('fx-pane-more').open = true`),
      )
      await tab.waitFor(
        inPane(
          1,
          `return this.document.querySelectorAll('#fx-pane-items .fx-menu-item').length > 0`,
        ),
      )
      const items = await tab.evaluate<string[]>(
        inPane(
          1,
          `return [...this.document.querySelectorAll('#fx-pane-more .fx-menu-item')].map(b => b.textContent.trim());`,
        ),
      )
      expect(items.slice(-2)).toEqual(['只留这一栏', '关闭分栏'])
      expect(items.length).toBeGreaterThan(2)
      expect(items).not.toContain('在右侧打开')
      await tab.evaluate(
        inPane(
          1,
          `this.document.querySelector('[data-action="fx-pane-solo"]').click()`,
        ),
      )
      await tab.waitFor(`document.querySelectorAll('.fx-pane').length === 0`)
      await tab.waitFor(
        `${q('#fx-thread')}.getAttribute('data-target') === '${REVIEWER}'`,
        10_000,
      )
    } finally {
      await tab.close()
    }
  }, 30_000)
})

describe.skipIf(SKIP !== null)('the side list’s peek', () => {
  let browser: Browser
  let served: Served
  beforeAll(async () => {
    browser = await Browser.launch()
    served = await serve()
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
    served?.stop()
  }, 30_000)

  const PEEK = `${q('#fx')}.getAttribute('data-peek')`
  const OPENER = '.fx-top .fx-side-open'
  const SETTLED = SETTLED_OPENER

  /** The side list's box and whether it shows. */
  const SIDE = `(() => { const s = ${q('#fx-side')}; const r = s.getBoundingClientRect(); const c = getComputedStyle(s);
    return [Math.round(r.left), c.visibility, c.boxShadow !== 'none', c.borderTopLeftRadius]; })()`

  test('⌘B and the button collapse it, kept per device; the button sits top left', async () => {
    const tab = await open(browser, served, '/')
    try {
      const { mod } = await mods(tab)
      await tab.evaluate(`${q('#fx-text')}.focus()`)
      await key(tab, 'side', mod)
      expect(
        await tab.evaluate<string>(`${q('#fx')}.getAttribute('data-side')`),
      ).toBe('closed')
      expect(
        await tab.evaluate<string>(`localStorage.getItem('qianmo.front.side')`),
      ).toBe('closed')
      // Top left once the list has slid away.
      await tab.waitFor(SETTLED)
      const [left, top] = await tab.evaluate<number[]>(
        `(() => { const r = ${q(OPENER)}.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })()`,
      )
      expect(left).toBeLessThan(24)
      expect(top).toBeLessThan(24)
      await tab.goto(`${served.base}/`)
      await tab.waitFor('window.qianmoSplit !== undefined')
      expect(
        await tab.evaluate<string>(`${q('#fx')}.getAttribute('data-side')`),
      ).toBe('closed')
      await tab.evaluate(`${q(OPENER)}.click()`)
      expect(
        await tab.evaluate<string>(`${q('#fx')}.getAttribute('data-side')`),
      ).toBe('open')
      expect(
        await tab.evaluate<string>(`localStorage.getItem('qianmo.front.side')`),
      ).toBe('open')
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('a rest on the button floats it out over the content; leaving folds it after the grace, coming back keeps it', async () => {
    const tab = await open(browser, served, '/', {
      store: { 'qianmo.front.side': 'closed' },
    })
    try {
      const main = `(() => { const r = ${q('#fx-main')}.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; })()`
      await tab.waitFor(`${SIDE}[1] === 'hidden'`)
      await tab.waitFor(SETTLED)
      const before = await tab.evaluate<number[]>(main)
      const [x, y] = await centre(tab, OPENER)
      await mouse(tab, 'mouseMoved', x, y)
      await pause(PEEK_OPEN_MS / 2)
      expect(await tab.evaluate<string | null>(PEEK)).toBe(null)
      await tab.waitFor(`${PEEK} === 'hover'`, PEEK_OPEN_MS * 2)
      await pause(250)
      const out = await tab.evaluate<unknown[]>(SIDE)
      expect(out[0]).toBe(8)
      expect(out[1]).toBe('visible')
      expect(out[2]).toBe(true)
      expect(out[3]).toBe('12px')
      // The content did not move.
      expect(await tab.evaluate<number[]>(main)).toEqual(before)
      expect(
        await tab.evaluate<string>(
          `${q(OPENER)}.getAttribute('aria-expanded')`,
        ),
      ).toBe('true')
      // Into the list, and out to the content: folds after the grace.
      const [sx, sy] = await centre(tab, '#fx-search')
      await mouse(tab, 'mouseMoved', sx, sy)
      await pause(PEEK_CLOSE_MS + 100)
      expect(await tab.evaluate<string | null>(PEEK)).toBe('hover')
      await mouse(tab, 'mouseMoved', 900, 500)
      await pause(PEEK_CLOSE_MS / 2)
      expect(await tab.evaluate<string | null>(PEEK)).toBe('hover')
      // Back before the grace is up: it stays.
      await mouse(tab, 'mouseMoved', sx, sy)
      await pause(PEEK_CLOSE_MS + 100)
      expect(await tab.evaluate<string | null>(PEEK)).toBe('hover')
      await mouse(tab, 'mouseMoved', 900, 500)
      await tab.waitFor(`${PEEK} === null`, PEEK_CLOSE_MS * 3)
      // A pass over the button shorter than the rest floats nothing.
      await mouse(tab, 'mouseMoved', x, y)
      await pause(PEEK_OPEN_MS / 3)
      await mouse(tab, 'mouseMoved', 900, 500)
      await pause(PEEK_OPEN_MS + 100)
      expect(await tab.evaluate<string | null>(PEEK)).toBe(null)
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('a menu open in it keeps it out; a click on the button opens it for good; Esc folds it to the button', async () => {
    const tab = await open(browser, served, '/', {
      store: { 'qianmo.front.side': 'closed' },
    })
    try {
      await tab.waitFor(SETTLED)
      const [x, y] = await centre(tab, OPENER)
      await mouse(tab, 'mouseMoved', x, y)
      await tab.waitFor(`${PEEK} === 'hover'`, 2_000)
      await tab.evaluate(`${q(`${ROW(REVIEWER)} details.fx-more`)}.open = true`)
      await mouse(tab, 'mouseMoved', 900, 500)
      await pause(PEEK_CLOSE_MS * 3)
      expect(await tab.evaluate<string | null>(PEEK)).toBe('hover')
      await tab.evaluate(
        `${q(`${ROW(REVIEWER)} details.fx-more`)}.open = false`,
      )
      await tab.waitFor(`${PEEK} === null`, PEEK_CLOSE_MS * 4)
      // Esc while it is out: folded, the focus on the button.
      await mouse(tab, 'mouseMoved', x, y)
      await tab.waitFor(`${PEEK} === 'hover'`, 2_000)
      await key(tab, 'esc')
      expect(await tab.evaluate<string | null>(PEEK)).toBe(null)
      expect(
        await tab.evaluate<boolean>(`document.activeElement === ${q(OPENER)}`),
      ).toBe(true)
      // A click while it is out: open for good.
      await mouse(tab, 'mouseMoved', 900, 500)
      await mouse(tab, 'mouseMoved', x, y)
      await tab.waitFor(`${PEEK} === 'hover'`, 2_000)
      await mouse(tab, 'mousePressed', x, y)
      await mouse(tab, 'mouseReleased', x, y)
      expect(
        await tab.evaluate<[string, string | null]>(
          `[${q('#fx')}.getAttribute('data-side'), ${PEEK}]`,
        ),
      ).toEqual(['open', null])
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('the keyboard floats it at once and keeps it while inside; with reduced motion nothing slides', async () => {
    const tab = await open(browser, served, '/', {
      store: { 'qianmo.front.side': 'closed' },
      motion: 'reduce',
    })
    try {
      // From the page's start (its skip link) Tab reaches the button: out at
      // once. First the list is put away: under reduced motion every
      // transition is 0.01 ms, so its rows are hidden from the next frame.
      await tab.waitFor(SETTLED)
      await tab.waitFor(
        `[...document.querySelectorAll('#fx-side button, #fx-side a, #fx-side input')].every(e => getComputedStyle(e).visibility === 'hidden')`,
      )
      // The page puts the focus in its box once it is up; after that, the start.
      await tab.waitFor(`document.activeElement === ${q('#fx-text')}`)
      await tab.evaluate(`${q('.skip-link')}.focus()`)
      expect(
        await tab.evaluate<boolean>(
          `document.activeElement === ${q('.skip-link')}`,
        ),
      ).toBe(true)
      await key(tab, 'tab')
      expect(
        await tab.evaluate<string>(
          `document.activeElement === ${q(OPENER)} ? 'opener' : document.activeElement.outerHTML.slice(0, 120)`,
        ),
      ).toBe('opener')
      expect(await tab.evaluate<string | null>(PEEK)).toBe('key')
      // Shift+Tab goes into the list, out over the content: it stays. (Under
      // reduced motion every transition is 0.01 ms, so the list is focusable
      // from the next frame: a person is slower than that.)
      await pause(100)
      await key(tab, 'tab', 8)
      expect(
        await tab.evaluate<boolean>(
          `${q('#fx-side')}.contains(document.activeElement)`,
        ),
      ).toBe(true)
      await pause(PEEK_CLOSE_MS + 100)
      expect(await tab.evaluate<string | null>(PEEK)).toBe('key')
      // Reduced motion: no slide, only the fade.
      expect(
        await tab.evaluate<string>(
          `getComputedStyle(${q('#fx-side')}).transform`,
        ),
      ).toBe('none')
      // Out of it: folded.
      await tab.evaluate(`${q('#fx-text')}.focus()`)
      await tab.waitFor(`${PEEK} === null`, PEEK_CLOSE_MS * 4)
      expect(
        await tab.evaluate<string>(
          `getComputedStyle(${q('#fx-side')}).transform`,
        ),
      ).toBe('none')
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('without hover the button is a drawer’s, with a scrim; at 375 px the drawer is the front’s own', async () => {
    const tab = await open(browser, served, '/', {
      store: { 'qianmo.front.side': 'closed' },
    })
    try {
      await tab.send('Emulation.setTouchEmulationEnabled', {
        enabled: true,
        maxTouchPoints: 1,
      })
      await tab.goto(`${served.base}/`)
      await tab.waitFor('window.qianmoSplit !== undefined')
      expect(
        await tab.evaluate<boolean>(`matchMedia('(hover: hover)').matches`),
      ).toBe(false)
      await tab.evaluate(`${q(OPENER)}.click()`)
      expect(
        await tab.evaluate<[string, string | null]>(
          `[${q('#fx')}.getAttribute('data-side'), ${PEEK}]`,
        ),
      ).toEqual(['closed', 'drawer'])
      expect(
        await tab.evaluate<string>(
          `getComputedStyle(${q('.fx-scrim')}).display`,
        ),
      ).toBe('block')
      await tab.evaluate(`${q('.fx-scrim')}.click()`)
      expect(await tab.evaluate<string | null>(PEEK)).toBe(null)
      await tab.send('Emulation.setTouchEmulationEnabled', { enabled: false })
      await tab.send('Emulation.setDeviceMetricsOverride', {
        width: 375,
        height: 812,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await tab.goto(`${served.base}/`)
      await tab.waitFor('window.qianmoSplit !== undefined')
      await tab.evaluate(`${q(OPENER)}.click()`)
      expect(
        await tab.evaluate<[string | null, string | null]>(
          `[${q('#fx')}.getAttribute('data-drawer'), ${PEEK}]`,
        ),
      ).toEqual(['open', null])
      // Beside is for a wide window: no pane items in a row's menu there.
      expect(
        await tab.evaluate<number>(
          `[...document.querySelectorAll('.fx-split-item')].filter(b => b.offsetParent !== null).length`,
        ),
      ).toBe(0)
      expect(
        await tab.evaluate<number>(`document.documentElement.scrollWidth`),
      ).toBe(375)
    } finally {
      await tab.close()
    }
  }, 30_000)
})

describe.skipIf(SKIP !== null)('分栏 on Code', () => {
  let browser: Browser
  let served: Served
  beforeAll(async () => {
    browser = await Browser.launch()
    served = await serve()
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
    served?.stop()
  }, 30_000)

  for (const inFrames of [false, true]) {
    test(`two local sessions side by side on the window’s one runner channel (${inFrames ? 'globals in every frame' : 'the top frame only'})`, async () => {
      const tab = await open(browser, served, '/code', { shell: { inFrames } })
      try {
        await tab.waitFor(
          `window.__calls.filter(c => c[0] === 'qmo_local_list').length === 1`,
        )
        const start = (
          where: string,
          text: string,
        ) => `(() => { const b = ${where}.getElementById('code-text'); b.focus(); b.value = ${JSON.stringify(text)};
          b.dispatchEvent(new Event('input')); b.form.requestSubmit(); })()`
        await tab.evaluate(start('document', '第一条'))
        await tab.waitFor(`/[?&]session=cs_/.test(location.search)`)
        await paneKey(tab, 'right')
        await tab.waitFor(READY(2), 10_000)
        await tab.evaluate(
          start(
            `document.querySelectorAll('.fx-pane-frame')[1].contentDocument`,
            '第二条',
          ),
        )
        await tab.waitFor(
          `${FRAMES}.every(f => /[?&]session=cs_/.test(f.contentWindow.location.search))`,
          10_000,
        )
        const ids = await tab.evaluate<string[]>('window.__fake.sessions()')
        expect(ids).toHaveLength(2)
        expect(await tab.evaluate<string>('location.search')).toBe(
          `?session=${ids[1]}`,
        )
        // The runner's answers stream into each pane from the window's one channel.
        await tab.evaluate(
          `window.__fake.live(${JSON.stringify(ids[0])}, 't_a', '左边的回答'); window.__fake.live(${JSON.stringify(ids[1])}, 't_b', '右边的回答')`,
        )
        await tab.waitFor(
          inPane(
            0,
            `return this.document.getElementById('code-msgs').textContent.includes('左边的回答')`,
          ),
        )
        await tab.waitFor(
          inPane(
            1,
            `return this.document.getElementById('code-msgs').textContent.includes('右边的回答')`,
          ),
        )
        expect(
          await tab.evaluate<string>(
            inPane(
              0,
              `return this.document.getElementById('code-msgs').textContent`,
            ),
          ),
        ).not.toContain('右边的回答')
        expect(
          await tab.evaluate<number>(
            `window.__calls.filter(c => c[0] === 'qmo_local_watch').length`,
          ),
        ).toBe(1)
        // Every call went to the window's shell, none to a frame's own.
        if (inFrames) {
          expect(
            await tab.evaluate<number>(inPane(1, 'return this.__calls.length')),
          ).toBe(0)
        }
        expect(
          await tab.evaluate<string[]>(
            `window.__calls.filter(c => !/^qmo_(local_|shell_info|boot_layout)/.test(c[0])).map(c => c[0])`,
          ),
        ).toEqual([])
        // The side list marks the focused pane's session.
        expect(
          await tab.evaluate<string[]>(
            `[...document.querySelectorAll('#fx-side [data-split-current]')].map(r => r.getAttribute('data-session') || r.querySelector('[data-session]')?.getAttribute('data-session'))`,
          ),
        ).toEqual([ids[1]])
        // A row's own ⋯ (改名, 删除) gains the two as it opens, once.
        const row = `#code-sessions .fx-code-row:has([data-session="${ids[0]}"]) details.fx-more`
        for (const _ of [1, 2]) {
          await tab.evaluate(`${q(row)}.open = true`)
          await tab.waitFor(
            `${q(row)}.querySelectorAll('.fx-split-item').length > 0`,
          )
          await tab.evaluate(`${q(row)}.open = false`)
        }
        expect(
          await tab.evaluate<(string | null)[]>(
            `[...${q(row)}.querySelectorAll('.fx-menu > *')].map(b => b.getAttribute('data-action') + ' ' + b.getAttribute('data-split-q'))`,
          ),
        ).toEqual([
          'code-rename null',
          'code-delete null',
          'null null',
          `fx-split session=${ids[0]}`,
          `fx-split session=${ids[0]}`,
        ])
        expect(await tab.evaluate<unknown>('window.__badArgs')).toEqual([])
      } finally {
        await tab.close()
      }
    }, 30_000)
  }

  test('a session the runner no longer has is one line and 关闭', async () => {
    const tab = await open(browser, served, '/code', {
      shell: {},
      store: {
        'qianmo.split.code': JSON.stringify({
          v: 1,
          cols: [
            { w: 0.5, rows: [{ h: 1, q: '' }] },
            { w: 0.5, rows: [{ h: 1, q: 'session=cs_gone' }] },
          ],
          focus: 0,
        }),
      },
    })
    try {
      await tab.waitFor(
        `${q('.fx-pane:nth-child(2) .fx-pane-fail')} !== null`,
        10_000,
      )
      expect(
        await tab.evaluate<string>(
          `${q('.fx-pane:nth-child(2) .fx-pane-fail p')}.textContent`,
        ),
      ).toBe(SPLIT_TEXT['zh-CN'].paneFailed)
      await tab.evaluate(
        `${q('.fx-pane:nth-child(2) .fx-pane-fail button')}.click()`,
      )
      await tab.waitFor(`document.querySelectorAll('.fx-pane').length === 0`)
    } finally {
      await tab.close()
    }
  }, 30_000)
})

describe.skipIf(SKIP !== null)('one connection for the window', () => {
  let browser: Browser
  let served: Served
  beforeAll(async () => {
    browser = await Browser.launch()
    served = await serve()
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
    served?.stop()
  }, 30_000)

  test('four panes streaming, a fifth line and the approvals meanwhile: one stream, and no request waits', async () => {
    const tab = await open(browser, served, '/', {
      store: layout(
        [['', agent(CODER)], [agent(REVIEWER)], [agent(PLANNER)]],
        0,
      ),
    })
    try {
      await tab.waitFor(READY(4), 15_000)
      // Every request from here on: when it went, when it was answered.
      const went = new Map<string, { url: string; at: number }>()
      const waits: { url: string; ms: number }[] = []
      const connections = new Set<string>()
      browser.on(
        'Network.requestWillBeSent',
        params => {
          const request = params['request'] as { url?: string }
          went.set(String(params['requestId']), {
            url: String(request?.url ?? ''),
            at: Date.now(),
          })
        },
        tab.sessionId,
      )
      browser.on(
        'Network.responseReceived',
        params => {
          const sent = went.get(String(params['requestId']))
          const response = params['response'] as { connectionId?: number }
          if (response?.connectionId !== undefined)
            connections.add(String(response.connectionId))
          if (sent !== undefined)
            waits.push({ url: sent.url, ms: Date.now() - sent.at })
        },
        tab.sessionId,
      )
      const before = served.streams()
      expect(before.open).toBe(1)
      // A line in each pane: four answers streaming at once.
      for (const i of [0, 1, 2, 3]) {
        await tab.evaluate(
          inPane(
            i,
            `const b = this.document.getElementById('fx-text'); b.value = '第 ${i + 1} 格的一行';
          b.dispatchEvent(new this.Event('input', { bubbles: true })); b.form.requestSubmit();`,
          ),
        )
      }
      // While they stream: one more line, and the approvals the panes read.
      await pause(2_500)
      await tab.evaluate(
        inPane(
          0,
          `const b = this.document.getElementById('fx-text'); b.value = '流式进行中再发一行';
        b.dispatchEvent(new this.Event('input', { bubbles: true })); b.form.requestSubmit();`,
        ),
      )
      // And an approval in reviewer's pane, decided while the answers stream.
      const ask = `[...this.document.querySelectorAll('#fx-asks .fx-ask')].find(a => [...a.querySelectorAll('button')].some(b => b.textContent.trim() === '批准'))`
      await tab.waitFor(inPane(2, `return !!${ask}`), 10_000)
      await tab.evaluate(
        inPane(
          2,
          `const a = ${ask}; this.__ask = a.getAttribute('data-request'); [...a.querySelectorAll('button')].find(b => b.textContent.trim() === '批准').click();`,
        ),
      )
      await tab.waitFor(
        inPane(
          2,
          `const a = this.document.querySelector('.fx-ask[data-request="' + this.__ask + '"]'); return !a || /已批准/.test(a.textContent);`,
        ),
        10_000,
      )
      for (const i of [0, 1, 2, 3]) {
        await tab.waitFor(
          inPane(
            i,
            `return this.document.getElementById('fx-thread').textContent.includes('已处理「第 ${i + 1} 格的一行」')`,
          ),
          20_000,
        )
      }
      await tab.waitFor(
        inPane(
          0,
          `return this.document.getElementById('fx-thread').textContent.includes('已处理「流式进行中再发一行」')`,
        ),
        20_000,
      )
      const after = served.streams()
      expect(after).toEqual({ open: 1, asked: before.asked })
      const streamed = waits.filter(w => w.url.includes('/v0/chat/stream'))
      expect(streamed).toEqual([])
      const sends = waits.filter(w =>
        /\/v0\/chat\/sessions\/[^/]+\/messages/.test(w.url),
      )
      expect(sends.length).toBe(5)
      const approvals = waits.filter(w => w.url.includes('/v0/approvals'))
      expect(
        waits.filter(w => /\/v0\/approvals\/.+/.test(w.url)).length,
      ).toBeGreaterThan(0)
      expect(approvals.length).toBeGreaterThan(0)
      const slowest = waits.reduce((max, w) => Math.max(max, w.ms), 0)
      console.log(
        `[split connections] ${waits.length} requests answered, slowest ${slowest} ms, ` +
          `${sends.length} sends, ${approvals.length} approvals requests (reads and a decision), ${connections.size} connections used in turn, ` +
          `streams open ${after.open}, asked ${after.asked}`,
      )
      expect(slowest).toBeLessThan(1_500)
    } finally {
      await tab.close()
    }
  }, 90_000)

  test('against it: six streams of a page’s own hold the next request back', async () => {
    const tab = await browser.tab()
    try {
      await tab.send('Network.setCookie', {
        name: 'qianmo_session',
        value: served.ops.sid,
        url: served.base,
        httpOnly: true,
        sameSite: 'Strict',
      })
      await tab.goto(`${served.base}/v0/none`)
      const held = await tab.evaluate<[number, boolean]>(`(async () => {
        const streams = [];
        for (let i = 0; i < 6; i++) streams.push(new EventSource('/v0/chat/stream'));
        await new Promise(r => setTimeout(r, 800));
        const at = Date.now();
        const answered = await Promise.race([
          fetch('/v0/none').then(() => true),
          new Promise(r => setTimeout(() => r(false), 2000)),
        ]);
        streams.forEach(s => s.close());
        return [Date.now() - at, answered];
      })()`)
      console.log(
        `[split connections] six streams of its own: the seventh request answered ${held[1]} after ${held[0]} ms`,
      )
      expect(held[1]).toBe(false)
    } finally {
      await tab.close()
    }
  }, 30_000)
})

describe.skipIf(SKIP !== null)('three languages, contrast, 375 px', () => {
  let browser: Browser
  let served: Served
  beforeAll(async () => {
    browser = await Browser.launch()
    served = await serve()
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
    served?.stop()
  }, 30_000)

  for (const lang of LANGS) {
    test(`the panes’ words in ${lang}`, async () => {
      const t = SPLIT_TEXT[lang]
      const tab = await open(browser, served, '/', {
        lang,
        store: layout([[''], [BROKEN]], 0),
      })
      try {
        await tab.waitFor(READY(2, 1), 10_000)
        await tab.waitFor(`${q('.fx-pane-fail')} !== null`)
        expect(
          await tab.evaluate<string[]>(
            `[${q('.fx-pane-fail p')}.textContent, ${q('.fx-pane-fail button')}.textContent, ${q('.fx-split-bar')}.getAttribute('aria-label'), ${q('.fx-pane-frame')}.title]`,
          ),
        ).toEqual([t.paneFailed, t.close, t.resize, t.pane])
        expect(
          await tab.evaluate<string[]>(
            inPane(
              0,
              `return [this.document.querySelector('#fx-pane-more summary').getAttribute('aria-label'), this.document.querySelector('.fx-pane-close').getAttribute('aria-label')]`,
            ),
          ),
        ).toEqual([t.paneMenu, t.closePane])
        expect(
          await tab.evaluate<string[]>(
            `[...document.querySelectorAll('#fx-split-ctx .fx-split-item')].map(b => b.textContent)`,
          ),
        ).toEqual([t.openRight, t.openBelow])
      } finally {
        await tab.close()
      }
    }, 30_000)
  }

  for (const scheme of ['light', 'dark'] as const) {
    test(`contrast in ${scheme}: the panes, the focused one and the others, the cover, the peek`, async () => {
      const tab = await open(browser, served, '/', {
        scheme,
        store: {
          ...layout([[''], [agent(REVIEWER)], [BROKEN]], 0),
          'qianmo.front.side': 'closed',
        },
      })
      try {
        await tab.waitFor(`${q('.fx-pane-fail')} !== null`, 10_000)
        const frames = (await tab.childFrames()).filter(
          f => f.url.includes('pane=1') && !f.url.includes('broken'),
        )
        expect(frames).toHaveLength(2)
        await tab.waitFor(READY(3, 2), 10_000)
        for (const frame of frames) {
          const result = await tab.evaluateInFrame<Probe>(
            frame.id,
            probe(`document.querySelector('.fx-top')`),
          )
          expect(result.total).toBeGreaterThan(0)
          expect(result.short).toEqual([])
        }
        const cover = await tab.evaluate<Probe>(
          probe(`document.querySelector('.fx-pane-fail')`),
        )
        expect(cover.total).toBe(2)
        expect(cover.short).toEqual([])
        await tab.waitFor(SETTLED_OPENER)
        const [x, y] = await centre(tab, '.fx-top .fx-side-open')
        await mouse(tab, 'mouseMoved', x, y)
        await tab.waitFor(
          `${q('#fx')}.getAttribute('data-peek') === 'hover'`,
          2_000,
        )
        await pause(300)
        // An agent that is off is dimmed on purpose, open or peeking (view/frontStyle.ts).
        await tab.evaluate(
          `document.querySelectorAll('.fx-agent-row.is-off .fx-agent-name, .fx-agent-row.is-off .fx-agent-face').forEach(e => { e.style.opacity = '1'; })`,
        )
        const peek = await tab.evaluate<Probe>(
          probe(`document.getElementById('fx-side')`),
        )
        expect(peek.total).toBeGreaterThan(5)
        expect(peek.short).toEqual([])
      } finally {
        await tab.close()
      }
    }, 30_000)
  }
})
