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
import { type Probe, probe, type Shortfall } from './contrastProbe.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[console contrast tests] skipped: ${SKIP}`)

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
  '/admin',
  '/admin/nodes',
  '/admin/nodes/tokyo-1',
  '/',
  '/?session=session-1',
  '/app',
  '/app?session=session-1',
  '/admin/audit',
  '/admin/alerts',
  '/admin/jobs',
  '/admin/approvals',
  '/admin/providers',
  '/admin/servers',
  '/admin/access',
  '/admin/usage',
  '/admin/settings',
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
      const seen = new Map<string, number>()
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
                `document.querySelectorAll('#fx-thread .fx-msg, #fx-thread .fx-steps').length`,
              ),
            ).toBeGreaterThanOrEqual(4)
          }
          if (path.includes('session=')) {
            await tab.evaluate(`document.querySelector('.fx-mini').focus()`)
            await tab.waitFor(
              `getComputedStyle(document.querySelector('.fx-mini')).opacity === '1'`,
            )
          }
          const result = await tab.evaluate<Probe>(probe('document.body'))
          total += result.total
          seen.set(path, result.total)
          for (const one of result.short) found.push({ ...one, page: path })
        }
        // The two dialogs a writer opens most, and a failure toast.
        await tab.goto(`${served.base}/admin/nodes`)
        await tab.waitFor('window.qianmoConsole !== undefined')
        for (const id of ['register-dialog', 'wake-dialog']) {
          await tab.evaluate(`document.getElementById('${id}').showModal()`)
          const result = await tab.evaluate<Probe>(
            probe(`document.getElementById('${id}')`),
          )
          total += result.total
          seen.set(`#${id}`, result.total)
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
        seen.set('toasts', toasts.total)
        for (const one of toasts.short) found.push({ ...one, page: 'toasts' })

        // Quick entry: the card and its roster, open.
        await tab.goto(`${served.base}/app/quick`)
        await tab.waitFor('window.qianmoConsole !== undefined')
        await tab.evaluate(`document.getElementById('fx-quick-agent').click()`)
        await tab.waitFor(`!document.getElementById('fx-quick-menu').hidden`)
        const quick = await tab.evaluate<Probe>(probe('document.body'))
        total += quick.total
        seen.set('#quick-entry', quick.total)
        for (const one of quick.short)
          found.push({ ...one, page: '/app/quick' })

        // Signed out: the login door.
        const door = await browser.tab()
        try {
          await scheme(door, theme)
          await door.goto(`${served.base}/login`)
          const result = await door.evaluate<Probe>(probe('document.body'))
          total += result.total
          seen.set('/login', result.total)
          for (const one of result.short) found.push({ ...one, page: '/login' })
        } finally {
          await door.close()
        }
      } finally {
        await tab.close()
      }
      // The probe saw every page, not a blank document: a floor per page
      // rather than one total, so a page that drew nothing is named and a
      // quieter design elsewhere cannot hide it (the front's `/` is about a
      // dozen texts; the admin pages are dozens).
      const thin = [...seen].filter(
        ([where, count]) => count < (where.startsWith('/') ? 8 : 2),
      )
      expect(thin).toEqual([])
      expect(seen.size).toBe(PAGES.length + 5)
      expect(total).toBeGreaterThan(400)
      expect(report(found)).toEqual([])
    }, 120_000)
  }
})
