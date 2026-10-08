// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every visible text on every page meets WCAG AA contrast, in the light theme
 * and the dark one (P18.14, `console-audit.md` B1).
 *
 * Measured, not asserted from the token table: each text node's computed
 * colour is composited over the stack of backgrounds behind it, with the
 * opacity of every ancestor applied, and the ratio is held to 4.5:1 — 3:1 for
 * large text (24px, or 18.66px bold). Text inside a disabled control is
 * exempt, as WCAG 1.4.3 exempts inactive components; so is text a screen
 * reader alone reads (a 1px box).
 *
 * The audit counted 1101 of 3266 visible text nodes under 4.5:1 in the light
 * theme. The fix is in the tokens (`assets/css.ts`); this is what holds it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChatTranscript, ChatTurn, ConsoleResult } from '../../src/deps.js'
import { createConsoleHandler } from '../../src/http.js'
import { CountingChat } from '../accountsHarness.js'
import { ADMIN, NOW, TOKENS, pageHarness } from '../pageHarness.js'
import { Browser, skipReason, type Tab } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[console contrast tests] skipped: ${SKIP}`)

/** One text that is under its threshold. */
interface Shortfall {
  readonly text: string
  readonly where: string
  readonly ratio: number
  readonly need: number
  readonly fg: string
  readonly bg: string
}

interface Probe {
  readonly total: number
  readonly short: readonly Shortfall[]
}

/** Contrast of every visible text node under `root`, against what is behind it. */
function probe(root: string): string {
  return `(() => {
  function parse(c) {
    let m = c.match(/^color\\(srgb ([^)]+)\\)/);
    if (m) {
      const p = m[1].split(/[ \\/]+/).filter(Boolean).map(Number);
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 };
    }
    m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function over(top, under) {
    const a = top.a;
    return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
  }
  function lum(c) {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function hex(c) {
    return '#' + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  }
  function backdrop(el) {
    const chain = [];
    for (let e = el; e; e = e.parentElement) chain.push(e);
    let c = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (!c || c.a === 0) c = parse(getComputedStyle(document.body).backgroundColor);
    c = { r: c.r, g: c.g, b: c.b, a: 1 };
    for (let i = chain.length - 1; i >= 0; i--) {
      const b = parse(getComputedStyle(chain[i]).backgroundColor);
      if (b && b.a > 0) c = over(b, c);
    }
    return c;
  }
  function opacityOf(el) {
    let o = 1;
    for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  }
  const scope = ${root};
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const short = [];
  let total = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent.trim();
    if (!text) continue;
    const el = n.parentElement;
    if (!el || el.closest('script,style,template')) continue;
    const box = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (box.width <= 1 || box.height <= 1 || s.visibility === 'hidden') continue;
    if (el.closest('[hidden],dialog:not([open]),details:not([open]) > :not(summary)')) continue;
    if (el.closest(':disabled,[aria-disabled="true"]')) continue;
    total += 1;
    const bg = backdrop(el);
    const ink = parse(s.color);
    if (!ink) continue;
    const fg = over({ ...over(ink, bg), a: opacityOf(el) }, bg);
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    if (ratio + 1e-9 < need) {
      const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
      short.push({ text: text.slice(0, 24), where: el.tagName.toLowerCase() + cls, ratio: Math.round(ratio * 100) / 100, need, fg: hex(fg), bg: hex(bg) });
    }
  }
  return { total, short };
})()`
}

/** A conversation with one of each kind of turn, so every mark is drawn. */
class TurnsChat extends CountingChat {
  override async transcript(
    sessionId: string,
  ): Promise<ConsoleResult<ChatTranscript>> {
    const read = await super.transcript(sessionId)
    if (!read.ok) return read
    const turn = (over: Partial<ChatTurn>): ChatTurn => ({
      id: `t-${over.id ?? 'x'}`,
      sessionId,
      author: 'operator',
      at: NOW - 60_000,
      text: '把告警整理一下',
      state: 'read',
      ...over,
    })
    return {
      ok: true,
      value: {
        session: read.value.session,
        turns: [
          turn({
            id: 'a',
            receipt: 'accepted',
            receiptMs: 42,
            readMs: 900,
            taskId: 'task-aaaaaaaa',
            traceId: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
          }),
          turn({
            id: 'n',
            author: 'agent',
            variant: 'notice',
            severity: 'warn',
            text: '读了三个文件',
            detail: '命中 3 处',
          }),
          turn({
            id: 'b',
            author: 'agent',
            state: 'done',
            text: '整理好了',
            elapsedMs: 4_000,
          }),
          turn({
            id: 'c',
            state: 'failed',
            code: 'E_UNDELIVERABLE',
            text: '再发一次',
          }),
        ],
      },
    }
  }
}

/** Every page there is, as the admin sees it: the most controls on screen. */
const PAGES = [
  '/',
  '/nodes',
  '/nodes/tokyo-1',
  '/chat',
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
  const chat = new TurnsChat()
  void chat.open('qianmo://tokyo-1/planner')
  const handle = createConsoleHandler({ ...harness.deps, chat }, TOKENS)
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: request => handle(request),
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true)
    },
  }
}

async function scheme(tab: Tab, value: 'light' | 'dark'): Promise<void> {
  await tab.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value }],
  })
}

function report(found: readonly (Shortfall & { page: string })[]): string[] {
  return found.map(
    one =>
      `${one.page} ${one.where} "${one.text}" ${one.ratio} < ${one.need} (${one.fg} on ${one.bg})`,
  )
}

describe.skipIf(SKIP !== null)('WCAG AA contrast, light and dark (B1)', () => {
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

  for (const theme of ['light', 'dark'] as const) {
    test(`every page, ${theme}`, async () => {
      const found: (Shortfall & { page: string })[] = []
      let total = 0
      const tab = await browser.tab()
      try {
        await scheme(tab, theme)
        for (const path of PAGES) {
          await tab.goto(
            `${served.base}${path}${path.includes('?') ? '&' : '?'}token=${ADMIN}`,
          )
          await tab.waitFor('window.qianmoConsole !== undefined')
          if (path.includes('session=')) {
            // The conversation drew its turns: receipts, a notice, a failure.
            expect(
              await tab.evaluate<number>(
                `document.querySelectorAll('#chat-thread .turn, #chat-thread .turn-notice').length`,
              ),
            ).toBeGreaterThanOrEqual(4)
          }
          const result = await tab.evaluate<Probe>(probe('document.body'))
          total += result.total
          for (const one of result.short) found.push({ ...one, page: path })
        }
        // The two dialogs a writer opens most, and a failure toast.
        await tab.goto(`${served.base}/nodes`)
        await tab.waitFor('window.qianmoConsole !== undefined')
        for (const id of ['register-dialog', 'wake-dialog']) {
          await tab.evaluate(`document.getElementById('${id}').showModal()`)
          const result = await tab.evaluate<Probe>(
            probe(`document.getElementById('${id}')`),
          )
          total += result.total
          for (const one of result.short) found.push({ ...one, page: `#${id}` })
          await tab.evaluate(`document.getElementById('${id}').close()`)
        }
        await tab.evaluate(`(() => {
          qianmoConsole.toast('心跳失败 · 无法连接', 'bad', 'connect ECONNREFUSED');
          qianmoConsole.toast('已心跳', 'ok');
          qianmoConsole.toast('已停止等待', 'warn');
        })()`)
        const toasts = await tab.evaluate<Probe>(
          probe(`document.getElementById('toasts')`),
        )
        total += toasts.total
        for (const one of toasts.short) found.push({ ...one, page: 'toasts' })

        // Signed out: the login door.
        const door = await browser.tab()
        try {
          await scheme(door, theme)
          await door.goto(`${served.base}/login`)
          const result = await door.evaluate<Probe>(probe('document.body'))
          total += result.total
          for (const one of result.short) found.push({ ...one, page: '/login' })
        } finally {
          await door.close()
        }
      } finally {
        await tab.close()
      }
      // The probe saw the pages: hundreds of texts, not a blank document.
      expect(total).toBeGreaterThan(600)
      expect(report(found)).toEqual([])
    }, 120_000)
  }
})
