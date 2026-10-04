// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The console at 375 px, in a real Chrome (P18.14, `console-audit.md` E1 and
 * K1): no page scrolls sideways, the page's own state is on the first screen
 * rather than under the sidebar, nothing is cut off at the right edge, and a
 * conversation can be read and answered without scrolling to find the
 * composer.
 *
 * Before E1 the sidebar sat above every page at this width — the roster
 * started at y≈792 and the composer at y≈1514 on an 812-tall screen — and the
 * delivery chain ran off the right edge with its last fact clipped.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChatTranscript, ChatTurn, ConsoleResult } from '../../src/deps.js'
import { createConsoleHandler } from '../../src/http.js'
import { CountingChat } from '../accountsHarness.js'
import { ADMIN, NOW, TOKENS, pageHarness } from '../pageHarness.js'
import { Browser, skipReason, type Tab } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[console narrow tests] skipped: ${SKIP}`)

const WIDTH = 375
const HEIGHT = 812

/** A long conversation: more turns than one screen holds, every chain drawn. */
class LongChat extends CountingChat {
  override async transcript(
    sessionId: string,
  ): Promise<ConsoleResult<ChatTranscript>> {
    const read = await super.transcript(sessionId)
    if (!read.ok) return read
    const turns: ChatTurn[] = []
    for (let i = 0; i < 6; i += 1) {
      turns.push(
        {
          id: `op-${i}`,
          sessionId,
          author: 'operator',
          at: NOW - (12 - 2 * i) * 60_000,
          text: `把第 ${i + 1} 组告警整理一下 · 按节点分开列`,
          state: 'read',
          receipt: 'accepted',
          receiptMs: 42,
          readMs: 900,
          taskId: `task-${i}aaaaaaa`,
          traceId: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
        {
          id: `ag-${i}`,
          sessionId,
          author: 'agent',
          at: NOW - (11 - 2 * i) * 60_000,
          text: '整理好了 · tokyo-1 三条 · osaka-1 一条 · 其余已自行恢复',
          state: 'done',
          elapsedMs: 4_000,
        },
      )
    }
    turns.push({
      id: 'failed',
      sessionId,
      author: 'operator',
      at: NOW - 60_000,
      text: '节点离线时再发一次',
      state: 'failed',
      code: 'E_UNDELIVERABLE',
    })
    return { ok: true, value: { session: read.value.session, turns } }
  }
}

/** Every page there is, as the admin sees it. */
const PAGES = [
  '/',
  '/nodes',
  '/nodes/tokyo-1',
  '/chat?session=session-1',
  '/audit',
  '/alerts',
  '/jobs',
  '/approvals',
  '/providers',
  '/servers',
  '/access',
  '/usage',
  '/settings',
] as const

function serve() {
  const harness = pageHarness({
    chat: true,
    nodeServers: [
      { node: 'tokyo-1', server: 'p11' },
      { node: 'osaka-1', server: 'p12' },
    ],
  })
  const chat = new LongChat()
  void chat.open('qianmo://tokyo-1/planner')
  void chat.open('qianmo://tokyo-1/planner')
  const handle = createConsoleHandler({ ...harness.deps, chat }, TOKENS)
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: request => handle(request),
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    chat,
    stop: () => {
      server.stop(true)
    },
  }
}

/** A phone: 375 wide, the viewport meta honoured, a 2x screen. */
async function phone(browser: Browser): Promise<Tab> {
  const tab = await browser.tab({ width: WIDTH, height: HEIGHT })
  await tab.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 2,
    mobile: true,
  })
  return tab
}

async function open(tab: Tab, base: string, path: string): Promise<void> {
  await tab.goto(
    `${base}${path}${path.includes('?') ? '&' : '?'}token=${ADMIN}`,
  )
  await tab.waitFor('window.qianmoConsole !== undefined')
}

interface Layout {
  readonly scrollWidth: number
  readonly clientWidth: number
  readonly titleBottom: number
  readonly role: { top: number; bottom: number; right: number } | null
  readonly mainTop: number
  readonly sideShown: boolean
  readonly menuShown: boolean
  /** Text boxes past either edge with no horizontal scroller to reach them. */
  readonly cut: readonly string[]
  /** Boxes in the page that scroll sideways. */
  readonly scrollers: readonly string[]
}

const LAYOUT = `(() => {
  const rect = el => el.getBoundingClientRect();
  const shown = el => !!el && getComputedStyle(el).display !== 'none' && rect(el).width > 0;
  function reachable(el) {
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const x = getComputedStyle(e).overflowX;
      if (x === 'auto' || x === 'scroll') return true;
    }
    return false;
  }
  const cut = [];
  const all = document.querySelectorAll('main *, .top *, #conn');
  for (const el of all) {
    if (!shown(el) || el.closest('[hidden], dialog:not([open]), details:not([open]) > :not(summary)')) continue;
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim() !== '');
    if (!own) continue;
    const r = rect(el);
    if (r.width <= 1 || r.height <= 1) continue;
    if ((r.right > innerWidth + 0.5 || r.left < -0.5) && !reachable(el)) {
      cut.push(el.tagName.toLowerCase() + '.' + el.className + ' "' + el.textContent.trim().slice(0, 16) + '" ' + Math.round(r.left) + '..' + Math.round(r.right));
    }
  }
  // What scrolls sideways inside the page, and why: a wide table in its own
  // scroller is a choice; a transcript that does is the chain overflowing.
  const scrollers = [];
  for (const el of document.querySelectorAll('main *')) {
    if (el.classList.contains('scroll') && el.querySelector(':scope > table')) continue;
    const x = getComputedStyle(el).overflowX;
    if ((x === 'auto' || x === 'scroll') && el.scrollWidth > el.clientWidth + 1) {
      scrollers.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + el.className);
    }
  }
  const role = document.getElementById('role');
  const r = role ? rect(role) : null;
  return {
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    titleBottom: rect(document.getElementById('page-title')).bottom,
    role: r ? { top: r.top, bottom: r.bottom, right: r.right } : null,
    mainTop: rect(document.getElementById('main')).top,
    sideShown: shown(document.getElementById('side')),
    menuShown: shown(document.querySelector('.top .drawer-open')),
    cut,
    scrollers,
  };
})()`

describe.skipIf(SKIP !== null)('the console at 375 px (E1)', () => {
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

  test('every page: no sideways scroll, nothing cut off, the title, the role and the page on the first screen', async () => {
    const tab = await phone(browser)
    const found: string[] = []
    try {
      for (const path of PAGES) {
        await open(tab, served.base, path)
        const layout = await tab.evaluate<Layout>(LAYOUT)
        const say = (what: string) => found.push(`${path}: ${what}`)
        if (layout.clientWidth !== WIDTH) say(`viewport ${layout.clientWidth}`)
        if (layout.scrollWidth > layout.clientWidth) {
          say(`scrolls sideways ${layout.scrollWidth} > ${layout.clientWidth}`)
        }
        if (layout.sideShown) say('sidebar drawn above the page')
        if (!layout.menuShown) say('no menu button')
        if (layout.titleBottom > HEIGHT / 4)
          say(`title at ${layout.titleBottom}`)
        if (
          layout.role === null ||
          layout.role.top < 0 ||
          layout.role.bottom > HEIGHT / 3 ||
          layout.role.right > WIDTH
        ) {
          say(`role chip ${JSON.stringify(layout.role)}`)
        }
        if (layout.mainTop > HEIGHT / 3) say(`page starts at ${layout.mainTop}`)
        for (const one of layout.cut) say(`cut ${one}`)
        for (const one of layout.scrollers) say(`scrolls ${one}`)
      }
    } finally {
      await tab.close()
    }
    expect(found).toEqual([])
  }, 120_000)

  test('the key state of the two busiest pages is on the first screen', async () => {
    const tab = await phone(browser)
    try {
      await open(tab, served.base, '/')
      // The four health cards' first one, whole.
      const card = await tab.evaluate<{ top: number; bottom: number }>(
        `(() => { const r = document.querySelector('main .card').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })()`,
      )
      expect(card.top).toBeGreaterThanOrEqual(0)
      expect(card.bottom).toBeLessThanOrEqual(HEIGHT)

      await open(tab, served.base, '/nodes')
      // The roster's head: how many agents, how many live.
      const head = await tab.evaluate<{
        bottom: number
        text: string
      }>(
        `(() => { const h = document.querySelector('#roster .total').closest('div'); const r = h.getBoundingClientRect(); return { bottom: r.bottom, text: h.textContent }; })()`,
      )
      expect(head.bottom).toBeLessThanOrEqual(HEIGHT)
      expect(head.text).toContain('3')
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('the menu opens the navigation as a drawer, Esc closes it, and focus goes back to the menu', async () => {
    const tab = await phone(browser)
    try {
      await open(tab, served.base, '/nodes')
      await tab.evaluate(`document.querySelector('.top .drawer-open').focus()`)
      await tab.evaluate(`document.querySelector('.top .drawer-open').click()`)
      await tab.waitFor(
        `document.getElementById('side').matches(':popover-open')`,
      )
      const drawer = await tab.evaluate<{
        left: number
        right: number
        nav: number
        current: string
      }>(`(() => {
        const r = document.getElementById('side').getBoundingClientRect();
        const link = document.getElementById('nav-audit').getBoundingClientRect();
        return { left: r.left, right: r.right, nav: link.bottom,
          current: document.querySelector('#side [aria-current="page"]').textContent };
      })()`)
      expect(drawer.left).toBe(0)
      expect(drawer.right).toBeLessThanOrEqual(WIDTH)
      expect(drawer.nav).toBeLessThanOrEqual(HEIGHT)
      expect(drawer.current).toContain('节点')
      // The refresh switch went with it.
      expect(
        await tab.evaluate<boolean>(
          `(() => { const r = document.getElementById('refresh-interval').getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`,
        ),
      ).toBe(true)
      await tab.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      })
      await tab.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      })
      await tab.waitFor(
        `!document.getElementById('side').matches(':popover-open')`,
      )
      expect(
        await tab.evaluate<boolean>(
          `document.activeElement === document.querySelector('.top .drawer-open')`,
        ),
      ).toBe(true)
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('the drawer opens with scripts disabled', async () => {
    const tab = await phone(browser)
    try {
      // Signed in first: the cookie is what a script-less page rides on.
      await open(tab, served.base, '/nodes')
      await tab.send('Emulation.setScriptExecutionDisabled', { value: true })
      await tab.goto(`${served.base}/nodes`)
      expect(
        await tab.evaluate<boolean>(`window.qianmoConsole === undefined`),
      ).toBe(true)
      const at = await tab.evaluate<{ x: number; y: number }>(`(() => {
        const r = document.querySelector('.top .drawer-open').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`)
      for (const type of ['mousePressed', 'mouseReleased']) {
        await tab.send('Input.dispatchMouseEvent', {
          type,
          x: at.x,
          y: at.y,
          button: 'left',
          clickCount: 1,
        })
      }
      await tab.waitFor(
        `document.getElementById('side').matches(':popover-open')`,
      )
    } finally {
      await tab.close()
    }
  }, 30_000)

  test('the conversation: composer and connection on the first screen, the list in a drawer, and a message goes out', async () => {
    const tab = await phone(browser)
    try {
      await open(tab, served.base, '/chat?session=session-1')
      await tab.waitFor(
        `(document.getElementById('stream-state') || {}).textContent === '实时'`,
        10_000,
      )
      const first = await tab.evaluate<{
        composerTop: number
        composerBottom: number
        stream: number
        turns: number
        transcriptScrolls: boolean
        lastTurnBottom: number
        threadBottom: number
      }>(`(() => {
        const composer = document.getElementById('composer').getBoundingClientRect();
        const mount = document.getElementById('thread-mount');
        const turns = mount.querySelectorAll('article.turn');
        return {
          composerTop: composer.top, composerBottom: composer.bottom,
          stream: document.getElementById('stream-state').getBoundingClientRect().bottom,
          turns: turns.length,
          transcriptScrolls: mount.scrollHeight > mount.clientHeight,
          lastTurnBottom: turns[turns.length - 1].getBoundingClientRect().bottom,
          threadBottom: mount.getBoundingClientRect().bottom,
        };
      })()`)
      expect(first.turns).toBe(13)
      expect(first.composerTop).toBeGreaterThan(0)
      expect(first.composerBottom).toBeLessThanOrEqual(HEIGHT)
      expect(first.stream).toBeLessThanOrEqual(HEIGHT / 3)
      // The transcript scrolls inside the screen, held at its newest turn.
      expect(first.transcriptScrolls).toBe(true)
      expect(first.lastTurnBottom).toBeLessThanOrEqual(first.threadBottom + 1)
      expect(
        await tab.evaluate<number>(`document.documentElement.scrollHeight`),
      ).toBeLessThanOrEqual(HEIGHT)
      // Every delivery chain fits the width.
      const chains = await tab.evaluate<number[]>(
        `[...document.querySelectorAll('#thread-mount .chain')].map(c => c.getBoundingClientRect().right)`,
      )
      expect(chains.length).toBeGreaterThanOrEqual(6)
      expect(chains.filter(right => right > WIDTH)).toEqual([])

      // The session list is a drawer; choosing in it closes it.
      expect(
        await tab.evaluate<boolean>(
          `getComputedStyle(document.getElementById('chat-rail-list')).display === 'none'`,
        ),
      ).toBe(true)
      await tab.evaluate(
        `document.querySelector('[popovertarget="chat-rail-list"].drawer-open').click()`,
      )
      await tab.waitFor(
        `document.getElementById('chat-rail-list').matches(':popover-open')`,
      )
      await tab.evaluate(
        `document.querySelector('#chat-rail-list [data-session="session-2"]').click()`,
      )
      await tab.waitFor(
        `!document.getElementById('chat-rail-list').matches(':popover-open') && location.search === '?session=session-2'`,
      )
      await tab.waitFor(`document.activeElement.id === 'chat-text'`)

      // Typed and sent with Enter, as on a phone keyboard.
      await tab.send('Input.insertText', { text: '窄屏上发一条' })
      for (const type of ['rawKeyDown', 'keyUp']) {
        await tab.send('Input.dispatchKeyEvent', {
          type,
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
        })
      }
      await tab.waitFor(`document.getElementById('chat-text').value === ''`)
      expect(served.chat.sent.map(one => [one.sessionId, one.text])).toEqual([
        ['session-2', '窄屏上发一条'],
      ])
    } finally {
      await tab.close()
    }
  }, 30_000)
})
