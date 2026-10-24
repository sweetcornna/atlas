// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Moving between management areas in place, in a real browser
 * (`assets/nav.ts`, `docs/dev/qmo-local.md` §3.2–§3.3, §3.6). The areas live
 * in the settings card over the main window's Work face; an area's address
 * opens the document with the card drawn open on it.
 *
 * 1. **No new document.** A link in the card's list swaps the area in the
 *    card: a mark left on `window` is still there, the request was the
 *    partial one, the swapped page's script ran under the document's hash
 *    policy, and no policy violation was reported.
 * 2. **Back and forward** move between the swapped pages the same way.
 * 3. **Nothing piles up.** Visiting the same pages again leaves the same
 *    listeners on `document` and `window`, and what a page script added to
 *    the runtime goes with it.
 * 4. **Prefetch.** Pressing the pointer asks for the page before the click,
 *    and the click uses that answer; a pointer crossing the list asks for
 *    nothing.
 * 5. **Failure.** No answer keeps the page with one line and one retry; a
 *    lapsed session and another release's parts load a whole document.
 * 6. **Leaving for the front.** A link out of `/admin` in the card closes
 *    the card first, and then the browser follows it.
 * 7. **先改后同步.** A `data-write` switch whose write is refused goes back,
 *    with the reason beside it; a failed send stays as 未送达 with 重试.
 *
 * Driven over the DevTools protocol by `cdp.ts`. Skipped, with the reason
 * printed, on a machine without Chrome.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ConsoleDeps } from '../../src/deps.js'
import { createConsoleHandler } from '../../src/http.js'
import {
  ADDRESS,
  accountsHarness,
  asSession,
  person,
} from '../accountsHarness.js'
import { FakeDesktop } from '../directionFakes.js'
import { ADMIN, NOW, TOKENS, pageHarness } from '../pageHarness.js'
import { Browser, observeChatStream, skipReason, type Tab } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[nav browser tests] skipped: ${SKIP}`)

interface Seen {
  readonly method: string
  readonly path: string
  readonly partial: boolean
}

/** What the wrapper in front of the console does to each request. */
interface Wrapper {
  readonly seen: Seen[]
  /** Answer every partial request with this status and no parts. */
  partialStatus: number
  /** Partial and document requests arrive with no credential. */
  revoked: boolean
  /** The parts name another release's frame. */
  otherShell: boolean
  /** Hold a path's answer this long first. */
  readonly delay: Map<string, number>
  /** Refuse writes to paths matching this, after 400 ms. */
  refuseWrites: RegExp | null
}

interface Served {
  readonly base: string
  readonly wrapper: Wrapper
  stop(): void
}

function serveConsole(ports: Partial<ConsoleDeps> = {}): Served {
  const harness = pageHarness({ chat: true, ports })
  const handle = createConsoleHandler(harness.deps, TOKENS)
  const wrapper: Wrapper = {
    seen: [],
    partialStatus: 0,
    revoked: false,
    otherShell: false,
    delay: new Map(),
    refuseWrites: null,
  }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      const partial = request.headers.get('x-qianmo-partial') === '1'
      wrapper.seen.push({
        method: request.method,
        path: url.pathname + url.search,
        partial,
      })
      // Polling stands in for the revision stream, as in the other suites.
      if (url.pathname === '/v0/events') {
        return new Response(null, { status: 503 })
      }
      const wait = wrapper.delay.get(url.pathname)
      if (wait !== undefined) await Bun.sleep(wait)
      if (partial && wrapper.partialStatus !== 0) {
        return Response.json(
          { error: { code: 'unavailable', message: 'down' } },
          { status: wrapper.partialStatus },
        )
      }
      if (
        request.method !== 'GET' &&
        wrapper.refuseWrites !== null &&
        wrapper.refuseWrites.test(url.pathname)
      ) {
        await Bun.sleep(400)
        return Response.json(
          { error: { code: 'conflict', message: '节点拒绝了这次切换' } },
          { status: 409 },
        )
      }
      let forwarded = request
      const document = (request.headers.get('accept') ?? '').includes(
        'text/html',
      )
      if (wrapper.revoked && (partial || document)) {
        url.searchParams.delete('token')
        const headers = new Headers(request.headers)
        headers.delete('authorization')
        headers.delete('cookie')
        forwarded = new Request(url.toString(), {
          method: request.method,
          headers,
        })
      }
      const response = await handle(forwarded)
      if (partial && wrapper.otherShell && response.status === 200) {
        const raw = new Uint8Array(await response.arrayBuffer())
        const text = new TextDecoder().decode(
          response.headers.get('content-encoding') === 'gzip'
            ? Bun.gunzipSync(raw)
            : raw,
        )
        const parts = JSON.parse(text) as Record<string, unknown>
        return Response.json({ ...parts, shell: 'another-release' })
      }
      return response
    },
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    wrapper,
    stop: () => {
      server.stop(true)
    },
  }
}

/** Notes every policy violation the page reports, from the first script on. */
const WATCH_CSP = `
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', function (e) {
    window.__csp.push(e.violatedDirective + ' ' + e.blockedURI);
  });
`

async function openConsole(tab: Tab, served: Served, path: string) {
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH_CSP })
  await tab.goto(`${served.base}${path}?token=${ADMIN}`)
  await tab.waitFor('window.qianmoNav !== undefined')
  await tab.evaluate(`window.__mark = 'this document'`)
}

const q = (selector: string) =>
  `document.querySelector(${JSON.stringify(selector)})`

/** The area in the card is `path`, swapped in and settled. */
async function onPage(tab: Tab, path: string, nav: string): Promise<void> {
  await tab.waitFor(
    `location.pathname === ${JSON.stringify(path)} && ` +
      `${q(`#${nav}`)}.getAttribute('aria-current') === 'page' && ` +
      `!${q('#settings')}.hasAttribute('data-busy') && ` +
      `!${q('#settings')}.hasAttribute('data-arriving')`,
  )
}

function partials(served: Served, path: string): number {
  return served.wrapper.seen.filter(
    one => one.partial && one.method === 'GET' && one.path === path,
  ).length
}

function documents(served: Served, path: string): number {
  return served.wrapper.seen.filter(
    one => !one.partial && one.method === 'GET' && one.path === path,
  ).length
}

/** Listeners on `document` and `window`, by type, as DevTools counts them. */
async function listeners(tab: Tab): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const target of ['document', 'window']) {
    const held = await tab.send('Runtime.evaluate', { expression: target })
    const objectId = (held['result'] as Record<string, unknown>)['objectId']
    const found = await tab.send('DOMDebugger.getEventListeners', { objectId })
    for (const one of found['listeners'] as { type: string }[]) {
      const key = `${target}:${one.type}`
      counts[key] = (counts[key] ?? 0) + 1
    }
  }
  return counts
}

async function centre(
  tab: Tab,
  selector: string,
): Promise<{ x: number; y: number }> {
  return await tab.evaluate(
    `(() => { const r = ${q(selector)}.getBoundingClientRect(); ` +
      `return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  )
}

async function mouse(
  tab: Tab,
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
  at: { x: number; y: number },
): Promise<void> {
  await tab.send('Input.dispatchMouseEvent', {
    type,
    x: at.x,
    y: at.y,
    button: type === 'mouseMoved' ? 'none' : 'left',
    clickCount: type === 'mouseMoved' ? 0 : 1,
  })
}

describe.skipIf(SKIP !== null)('moving between pages in place', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await Browser.launch()
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
  }, 30_000)

  test("a link in the card's list swaps the area and keeps the document", async () => {
    const served = serveConsole()
    const tab = await browser.tab()
    try {
      await openConsole(tab, served, '/admin/nodes')
      await tab.evaluate(`${q('#nav-audit')}.click()`)
      await onPage(tab, '/admin/audit', 'nav-audit')
      expect(await tab.evaluate<string>('window.__mark')).toBe('this document')
      expect(
        await tab.evaluate<string>(`${q('#page-title')}.textContent`),
      ).toBe('消息链')
      expect(await tab.evaluate<string>('document.title')).toContain('消息链')
      expect(
        await tab.evaluate<string | null>(
          `${q('#nav-nodes')}.getAttribute('aria-current')`,
        ),
      ).toBeNull()
      expect(partials(served, '/admin/audit')).toBe(1)
      expect(documents(served, '/admin/audit')).toBe(0)
      // The settings page's script runs under the hash policy, and what it
      // added to the runtime goes when the page does.
      await tab.evaluate(`${q('#nav-settings')}.click()`)
      await onPage(tab, '/admin/settings', 'nav-settings')
      expect(
        await tab.evaluate<string>('typeof window.qianmoConsole.onSetting'),
      ).toBe('function')
      await tab.evaluate(`${q('#nav-nodes')}.click()`)
      await onPage(tab, '/admin/nodes', 'nav-nodes')
      expect(
        await tab.evaluate<string>('typeof window.qianmoConsole.onSetting'),
      ).toBe('undefined')
      expect(await tab.evaluate<string>('window.__mark')).toBe('this document')
      expect(await tab.evaluate<string[]>('window.__csp')).toEqual([])
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)

  test('back and forward move between swapped pages in place', async () => {
    const served = serveConsole()
    const tab = await browser.tab()
    try {
      await openConsole(tab, served, '/admin/nodes')
      await tab.evaluate(`${q('#nav-audit')}.click()`)
      await onPage(tab, '/admin/audit', 'nav-audit')
      await tab.evaluate(`${q('#nav-settings')}.click()`)
      await onPage(tab, '/admin/settings', 'nav-settings')
      await tab.evaluate('history.back()')
      await onPage(tab, '/admin/audit', 'nav-audit')
      await tab.evaluate('history.back()')
      await onPage(tab, '/admin/nodes', 'nav-nodes')
      expect(
        await tab.evaluate<string>(`${q('#page-title')}.textContent`),
      ).toBe('节点')
      await tab.evaluate('history.forward()')
      await onPage(tab, '/admin/audit', 'nav-audit')
      expect(await tab.evaluate<string>('window.__mark')).toBe('this document')
      expect(documents(served, '/admin/audit')).toBe(0)
      expect(documents(served, '/admin/settings')).toBe(0)
      // Back within five seconds of the first visit: the kept copy, no ask.
      expect(partials(served, '/admin/audit')).toBe(1)
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)

  test('visiting pages again leaves the same listeners behind', async () => {
    const served = serveConsole()
    const tab = await browser.tab()
    try {
      await openConsole(tab, served, '/admin/nodes')
      const first = await listeners(tab)
      await tab.evaluate(`${q('#nav-settings')}.click()`)
      await onPage(tab, '/admin/settings', 'nav-settings')
      const atSettings = await listeners(tab)
      await tab.evaluate(`${q('#nav-nodes')}.click()`)
      await onPage(tab, '/admin/nodes', 'nav-nodes')
      const atNodes = await listeners(tab)
      // The settings rows listen on the document; the nodes page's do not.
      expect(atSettings['document:focusout'] ?? 0).toBeGreaterThan(
        atNodes['document:focusout'] ?? 0,
      )
      // The first visit's script also waited for DOMContentLoaded (the
      // node page's models): that one listener went with the page.
      expect(first).toEqual({
        ...atNodes,
        'document:DOMContentLoaded':
          (atNodes['document:DOMContentLoaded'] ?? 0) + 1,
      })
      for (let round = 0; round < 2; round += 1) {
        await tab.evaluate(`${q('#nav-settings')}.click()`)
        await onPage(tab, '/admin/settings', 'nav-settings')
        expect(await listeners(tab)).toEqual(atSettings)
        await tab.evaluate(`${q('#nav-nodes')}.click()`)
        await onPage(tab, '/admin/nodes', 'nav-nodes')
        expect(await listeners(tab)).toEqual(atNodes)
      }
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)

  test('pressing on a link asks for the page before the click; hovering asks nothing', async () => {
    const served = serveConsole()
    const tab = await browser.tab()
    try {
      await openConsole(tab, served, '/admin/nodes')
      const asked = () => served.wrapper.seen.filter(one => one.partial).length

      // A pointer crossing the card's list: every item in it, none asked.
      const items = await tab.evaluate<{ x: number; y: number }[]>(
        `[...document.querySelectorAll('.nav-item')].filter(a => a.getClientRects().length > 0)` +
          `.map(a => { const r = a.getBoundingClientRect(); ` +
          `return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })`,
      )
      expect(items.length).toBeGreaterThan(3)
      for (const at of items) await mouse(tab, 'mouseMoved', at)
      await mouse(tab, 'mouseMoved', await centre(tab, '#nav-audit'))
      await Bun.sleep(400)
      expect(asked()).toBe(0)

      const audit = await centre(tab, '#nav-audit')
      await mouse(tab, 'mousePressed', audit)
      const pressed = Date.now() + 3_000
      while (partials(served, '/admin/audit') === 0 && Date.now() < pressed) {
        await Bun.sleep(10)
      }
      expect(partials(served, '/admin/audit')).toBe(1)
      expect(await tab.evaluate<string>('location.pathname')).toBe(
        '/admin/nodes',
      )
      await mouse(tab, 'mouseReleased', audit)
      await onPage(tab, '/admin/audit', 'nav-audit')
      expect(partials(served, '/admin/audit')).toBe(1)
      expect(documents(served, '/admin/audit')).toBe(0)
      expect(asked()).toBe(1)
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)

  test('no answer keeps the page, says so once, retries once, and 重试 brings it', async () => {
    const served = serveConsole()
    const tab = await browser.tab()
    try {
      await openConsole(tab, served, '/admin/nodes')
      served.wrapper.partialStatus = 503
      await tab.evaluate(`${q('#nav-audit')}.click()`)
      await tab.waitFor(
        `${q('#nav-note')} && !${q('#nav-note')}.hidden && ` +
          `${q('#nav-note')}.textContent.indexOf('页面没有打开') === 0`,
      )
      // After the one automatic retry: the reason and a way to try again.
      await tab.waitFor(
        `${q('#nav-note')}.textContent.indexOf('HTTP 503') !== -1 && ${q('#nav-note button')} !== null`,
      )
      expect(partials(served, '/admin/audit')).toBe(2)
      expect(await tab.evaluate<string>('location.pathname')).toBe(
        '/admin/nodes',
      )
      expect(
        await tab.evaluate<string>(`${q('#page-title')}.textContent`),
      ).toBe('节点')
      expect(
        await tab.evaluate<boolean>(
          `${q('#settings')}.hasAttribute('data-busy')`,
        ),
      ).toBe(false)
      served.wrapper.partialStatus = 0
      await tab.evaluate(`${q('#nav-note button')}.click()`)
      await onPage(tab, '/admin/audit', 'nav-audit')
      expect(await tab.evaluate<boolean>(`${q('#nav-note')}.hidden`)).toBe(true)
      expect(await tab.evaluate<string>('window.__mark')).toBe('this document')
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)

  test('a lapsed session is a whole navigation, which lands on the door', async () => {
    const served = serveConsole()
    const tab = await browser.tab()
    try {
      await openConsole(tab, served, '/admin/nodes')
      served.wrapper.revoked = true
      const loaded = tab.next('Page.loadEventFired')
      await tab.evaluate(`${q('#nav-audit')}.click()`)
      await loaded
      await tab.waitFor(`location.pathname === '/login'`)
      expect(await tab.evaluate<string>('location.search')).toBe(
        '?redirect=%2Fadmin%2Faudit',
      )
      expect(await tab.evaluate<string>('typeof window.__mark')).toBe(
        'undefined',
      )
      expect(partials(served, '/admin/audit')).toBe(1)
      expect(documents(served, '/admin/audit')).toBe(1)
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)

  test("another release's parts load the page as a whole document", async () => {
    const served = serveConsole()
    const tab = await browser.tab()
    try {
      await openConsole(tab, served, '/admin/nodes')
      served.wrapper.otherShell = true
      const loaded = tab.next('Page.loadEventFired')
      await tab.evaluate(`${q('#nav-audit')}.click()`)
      await loaded
      await tab.waitFor(
        `location.pathname === '/admin/audit' && ${q('#page-title')}.textContent === '消息链'`,
      )
      expect(await tab.evaluate<string>('typeof window.__mark')).toBe(
        'undefined',
      )
      expect(documents(served, '/admin/audit')).toBe(1)
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)

  test('a link out of /admin in the card closes the card first, then is followed', async () => {
    const served = serveConsole()
    const tab = await browser.tab()
    try {
      await openConsole(tab, served, '/admin/nodes')
      served.wrapper.delay.set('/', 1_500)
      // Read in the same task as the click: the protocol's next command
      // already waits for the next document.
      const at = await tab.evaluate<{ open: boolean; prevented: boolean }>(
        `(() => {
          ${q('#main')}.insertAdjacentHTML('afterbegin', '<a id="probe-front" href="/?agent=qianmo%3A%2F%2Ftokyo-1%2Fplanner">planner</a>');
          const link = ${q('#probe-front')};
          let prevented = null;
          window.addEventListener('click', e => { prevented = e.defaultPrevented; });
          link.click();
          return { open: ${q('#settings')}.open, prevented };
        })()`,
      )
      expect(at).toEqual({ open: false, prevented: false })
      await tab.waitFor(
        `document.getElementById('fx') !== null && location.pathname === '/' && typeof window.__mark === 'undefined'`,
        10_000,
      )
      expect(await tab.evaluate<string>('location.search')).toBe(
        '?agent=qianmo%3A%2F%2Ftokyo-1%2Fplanner',
      )
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)

  test('a refused data-write switch goes back, with the reason beside it', async () => {
    const served = serveConsole({ desktop: new FakeDesktop(() => NOW) })
    const tab = await browser.tab()
    const box =
      '[data-key="tokyo-1/planner"] input[data-desktop-unit="browser"]'
    try {
      await openConsole(tab, served, '/admin/desktop')
      expect(await tab.evaluate<boolean>(`${q(box)}.checked`)).toBe(true)
      served.wrapper.refuseWrites = /^\/v0\/desktop\//
      await tab.evaluate(`${q(box)}.click()`)
      // At once: the switch is off and the line beside it says it is saving.
      expect(
        await tab.evaluate<{ checked: boolean; note: string }>(
          `({ checked: ${q(box)}.checked, note: ${q('[data-write-note]')}.textContent })`,
        ),
      ).toEqual({ checked: false, note: '保存中…' })
      await tab.waitFor(
        `${q('[data-write-note]')}.textContent.indexOf('保存失败') === 0`,
      )
      expect(
        await tab.evaluate<{ checked: boolean; role: string | null }>(
          `({ checked: ${q(box)}.checked, role: ${q('[data-write-note]')}.getAttribute('role') })`,
        ),
      ).toEqual({ checked: true, role: 'alert' })
      expect(await tab.evaluate<boolean>(`${q(box)}.disabled`)).toBe(false)
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)
})

/**
 * The desktop app as the page sees it, without the boot-layout command: its
 * `invoke` refuses every command the way a shell without it does, and the
 * page must stay quiet about it.
 */
const SHELL_WITHOUT_COMMAND = `
  window.__QMO_SHELL__ = { platform: 'macos', window: 'main', version: '0.0.0-test' };
  window.__layouts = [];
  window.__noise = [];
  window.__TAURI__ = { core: { invoke: function (command, args) {
    if (command === 'qmo_boot_layout') window.__layouts.push(args && args.layout);
    return Promise.reject(new Error('command ' + command + ' not found'));
  } } };
  window.addEventListener('unhandledrejection', function (e) { window.__noise.push(String(e.reason)); });
  window.addEventListener('error', function (e) { window.__noise.push(String(e.message)); });
`

interface Layout {
  readonly page: string
  readonly side: string
  readonly sideWidth: number
  readonly rows: number
  readonly labels: number
  readonly theme: string
  readonly colors: {
    readonly dark: boolean
    readonly page: string
    readonly sidebar: string
  }
}

describe.skipIf(SKIP !== null)('the first frame (§3.5)', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await Browser.launch()
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
  }, 30_000)

  test('under the card the face is what is reported, once per change, and a shell without the command is no error', async () => {
    const served = serveConsole()
    const tab = await browser.tab()
    try {
      await tab.send('Page.addScriptToEvaluateOnNewDocument', {
        source: SHELL_WITHOUT_COMMAND,
      })
      // An area's address: the card is up over the Work face (no app
      // cookie here, so the browser's face, 智能体).
      await openConsole(tab, served, '/admin/nodes')
      await tab.waitFor('window.__layouts.length === 1')
      const first = await tab.evaluate<Layout>('window.__layouts[0]')
      expect(first.page).toBe('agents')
      expect(first.side).toBe('open')
      expect(first.sideWidth).toBeGreaterThan(200)
      expect(first.sideWidth).toBeLessThanOrEqual(1000)
      expect(first.rows).toBeGreaterThanOrEqual(1)
      expect(first.theme).toBe('system')
      // The face's colours as #rrggbb, light here.
      expect(first.colors.dark).toBe(false)
      expect(first.colors.page).toMatch(/^#[0-9a-f]{6}$/)
      expect(first.colors.sidebar).toMatch(/^#[0-9a-f]{6}$/)
      expect(first.colors.page).not.toBe('#000000')
      // A move in the card, and closing it, change nothing on the side.
      await tab.evaluate(`${q('#nav-audit')}.click()`)
      await onPage(tab, '/admin/audit', 'nav-audit')
      await tab.evaluate(`${q('.set-close')}.click()`)
      await tab.waitFor(`!${q('#settings')}.open && location.pathname === '/'`)
      await Bun.sleep(600)
      expect(await tab.evaluate<number>('window.__layouts.length')).toBe(1)
      // Dark: the colours change, and are reported.
      await tab.evaluate(
        `document.documentElement.setAttribute('data-theme', 'dark'); document.dispatchEvent(new CustomEvent('qianmo:theme'))`,
      )
      await tab.waitFor('window.__layouts.length === 2')
      const dark = await tab.evaluate<Layout>('window.__layouts[1]')
      expect(dark.colors.dark).toBe(true)
      expect(dark.colors.page).not.toBe(first.colors.page)
      // Narrow (the front's 700 px): the side panel is a drawer.
      await tab.send('Emulation.setDeviceMetricsOverride', {
        width: 600,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await tab.waitFor(
        "window.__layouts.length === 3 && window.__layouts[2].side === 'closed'",
      )
      expect(await tab.evaluate<string[]>('window.__noise')).toEqual([])
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)

  test('the front reports its face, rows and side state the same way', async () => {
    const h = accountsHarness()
    const ops = await person(h.handle, 'ops')
    await h.handle(
      asSession('POST', '/v0/chat/sessions', ops.sid, {
        body: { target: ADDRESS },
      }),
    )
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: request => h.handle(request),
    })
    const base = `http://127.0.0.1:${server.port}`
    const tab = await browser.tab()
    try {
      await tab.send('Network.setCookie', {
        name: 'qianmo_session',
        value: ops.sid,
        url: base,
        httpOnly: true,
        sameSite: 'Strict',
      })
      await tab.send('Page.addScriptToEvaluateOnNewDocument', {
        source: SHELL_WITHOUT_COMMAND,
      })
      await tab.goto(`${base}/app`)
      await tab.waitFor('window.__layouts.length >= 1')
      const chat = await tab.evaluate<Layout>(
        'window.__layouts[window.__layouts.length - 1]',
      )
      expect(chat.page).toBe('chat')
      expect(chat.side).toBe('open')
      expect(chat.rows).toBeGreaterThanOrEqual(1)
      expect(chat.labels).toBeGreaterThanOrEqual(1)
      // Collapsing the side list is a change.
      const before = await tab.evaluate<number>('window.__layouts.length')
      await tab.evaluate(`${q('.fx-side-top [data-action="fx-side"]')}.click()`)
      await tab.waitFor(
        `window.__layouts.length > ${before} && window.__layouts[window.__layouts.length - 1].side === 'closed'`,
      )
      await tab.goto(`${base}/`)
      await tab.waitFor('window.__layouts.length >= 1')
      expect(
        await tab.evaluate<string>(
          'window.__layouts[window.__layouts.length - 1].page',
        ),
      ).toBe('agents')
      expect(await tab.evaluate<string[]>('window.__noise')).toEqual([])
    } finally {
      await tab.close()
      server.stop(true)
    }
  }, 60_000)
})

/** The front's send, refused once by a stub in the page. */
const REFUSE_SEND = `
  window.__sendRefusals = 1;
  const realFetch = window.fetch;
  window.fetch = function (url, options) {
    const path = String(url);
    const method = (options && options.method) || 'GET';
    if (method === 'POST' && /\\/messages$/.test(path) && window.__sendRefusals > 0) {
      window.__sendRefusals -= 1;
      return Promise.resolve(new Response(JSON.stringify({ error: { code: 'unavailable', message: 'node unreachable' } }),
        { status: 503, headers: { 'content-type': 'application/json' } }));
    }
    return realFetch.apply(this, arguments);
  };
`

describe.skipIf(SKIP !== null)('先改后同步 on the front', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await Browser.launch()
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
  }, 30_000)

  test('a refused send stays in the conversation as 未送达, and 重试 sends it', async () => {
    const h = accountsHarness()
    const ops = await person(h.handle, 'ops')
    const created = await h.handle(
      asSession('POST', '/v0/chat/sessions', ops.sid, {
        body: { target: ADDRESS },
      }),
    )
    const { id } = (await created.json()) as { id: string }
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: request => h.handle(request),
    })
    const base = `http://127.0.0.1:${server.port}`
    const tab = await browser.tab()
    try {
      await tab.send('Network.setCookie', {
        name: 'qianmo_session',
        value: ops.sid,
        url: base,
        httpOnly: true,
        sameSite: 'Strict',
      })
      await tab.send('Page.addScriptToEvaluateOnNewDocument', {
        source: REFUSE_SEND,
      })
      await observeChatStream(tab)
      await tab.goto(`${base}/?session=${id}`)
      await tab.waitFor(`window.__chatStreamOpen === true`)
      await tab.evaluate(`(() => {
        document.getElementById('fx-text').value = '没送到的一行';
        document.getElementById('fx-composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()`)
      await tab.waitFor(`${q('.fx-msg-user.is-failed .fx-retry')} !== null`)
      expect(
        await tab.evaluate<{ text: string; meta: string; box: string }>(
          `({ text: ${q('.fx-msg-user.is-failed .fx-bubble')}.textContent, ` +
            `meta: ${q('.fx-msg-user.is-failed .fx-meta')}.textContent, ` +
            `box: document.getElementById('fx-text').value })`,
        ),
      ).toEqual({ text: '没送到的一行', meta: '未送达重试', box: '' })
      expect(h.chat.sent).toHaveLength(0)
      await tab.evaluate(`${q('.fx-msg-user.is-failed .fx-retry')}.click()`)
      const deadline = Date.now() + 5_000
      while (h.chat.sent.length === 0 && Date.now() < deadline) {
        await Bun.sleep(50)
      }
      expect(h.chat.sent.map(input => input.text)).toEqual(['没送到的一行'])
      await tab.waitFor(`${q('.fx-msg-user.is-failed')} === null`)
    } finally {
      await tab.close()
      server.stop(true)
    }
  }, 60_000)
})
