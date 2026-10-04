// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The P1 "state and feedback" group in a real browser (P18.14,
 * `console-audit.md` §4): what a page does when the network goes away (C2),
 * while a write is in flight (C4), when a field is wrong (D3), when a confirm
 * closes (D4), what a failure toast says (C5), how a token in the address bar
 * becomes a session (H5) and which clock a time is read in.
 *
 * Driven over the DevTools protocol by `cdp.ts`, with no dependency. Skipped,
 * with the reason printed, on a machine without Chrome.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createConsoleHandler } from '../../src/http.js'
import { ADMIN, TOKENS, pageHarness, type PageHarness } from '../pageHarness.js'
import { Browser, skipReason, type Tab } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[console P1 browser tests] skipped: ${SKIP}`)

/** What the wrapper in front of the console does to each request. */
interface Wrapper {
  /** Answer every fragment with a 503: the console is there, its reads fail. */
  down: boolean
  /** Hold every matching request this long before answering. */
  delay: { readonly path: string; readonly ms: number } | null
  /** Requests seen: path and instant. */
  readonly seen: { readonly path: string; readonly at: number }[]
}

interface Served {
  readonly base: string
  readonly wrapper: Wrapper
  readonly harness: PageHarness
  stop(): void
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function serveConsole(options: Parameters<typeof pageHarness>[0] = {}): Served {
  const harness = pageHarness({ chat: true, ...options })
  const handle = createConsoleHandler(harness.deps, TOKENS)
  const wrapper: Wrapper = { down: false, delay: null, seen: [] }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      wrapper.seen.push({ path: url.pathname, at: Date.now() })
      if (wrapper.down && url.pathname.startsWith('/fragments/')) {
        return new Response('{"error":{"code":"unavailable","message":"x"}}', {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      }
      const delay = wrapper.delay
      if (delay !== null && url.pathname.startsWith(delay.path)) {
        await pause(delay.ms)
      }
      return await handle(request)
    },
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    wrapper,
    harness,
    stop: () => {
      server.stop(true)
    },
  }
}

async function openConsole(tab: Tab, served: Served, path: string) {
  await tab.goto(
    `${served.base}${path}${path.includes('?') ? '&' : '?'}token=${ADMIN}`,
  )
  await tab.waitFor('window.qianmoConsole !== undefined')
}

/** Poll every 400 ms instead of the select's shortest 2 s. */
async function fastPolling(tab: Tab): Promise<void> {
  await tab.evaluate(`(() => {
    const picker = document.getElementById('refresh-interval');
    picker.add(new Option('0.4s', '400'));
    picker.value = '400';
    picker.dispatchEvent(new Event('change'));
  })()`)
}

describe.skipIf(SKIP !== null)(
  'the P1 state and feedback group in a browser',
  () => {
    let browser: Browser

    beforeAll(async () => {
      browser = await Browser.launch()
    }, 30_000)

    afterAll(async () => {
      await browser?.close()
    }, 30_000)

    test('a failing refresh lights the connection line, stamps the region, backs off, and clears on recovery (C2)', async () => {
      const served = serveConsole()
      const tab = await browser.tab()
      try {
        await openConsole(tab, served, '/nodes')
        expect(
          await tab.evaluate<boolean>(`document.getElementById('conn').hidden`),
        ).toBe(true)
        await fastPolling(tab)
        await tab.waitFor(
          `document.getElementById('roster').getAttribute('data-refreshed') !== null`,
        )

        served.wrapper.down = true
        const downAt = Date.now()
        await tab.waitFor(`!document.getElementById('conn').hidden`, 5_000)
        const line = await tab.evaluate<string>(
          `document.getElementById('conn').textContent`,
        )
        expect(line).toMatch(
          /^连接中断 · 正在重试 · 数据截至 \d\d:\d\d:\d\d · \d+ 秒后再试$/,
        )
        expect(
          await tab.evaluate<string>(
            `document.querySelector('#roster > [data-asof]').textContent`,
          ),
        ).toMatch(/^数据截至 \d\d:\d\d:\d\d$/)
        // The old roster is still there under the stamp.
        expect(
          await tab.evaluate<number>(
            `document.querySelectorAll('#roster details[data-key]').length`,
          ),
        ).toBe(3)

        // Back off: 0.4 s, then 0.8, 1.6, 3.2 … between failed reads.
        await pause(6_500)
        const failed = served.wrapper.seen
          .filter(
            seen => seen.path === '/fragments/roster' && seen.at >= downAt,
          )
          .map(seen => seen.at)
        const gaps = failed.slice(1).map((at, i) => at - (failed[i] ?? at))
        // Steady 400 ms polling would have asked about sixteen times.
        expect(failed.length).toBeLessThanOrEqual(6)
        expect(gaps.length).toBeGreaterThanOrEqual(2)
        const last = gaps.at(-1) ?? 0
        const first = gaps[0] ?? 0
        expect(last).toBeGreaterThan(first * 1.8)

        served.wrapper.down = false
        await tab.waitFor(`document.getElementById('conn').hidden`, 10_000)
        expect(
          await tab.evaluate<number>(
            `document.querySelectorAll('#roster [data-asof]').length`,
          ),
        ).toBe(0)
      } finally {
        await tab.close()
        served.stop()
      }
    }, 40_000)

    test('a browser that goes offline says so, with the age of the page (C2)', async () => {
      const served = serveConsole()
      const tab = await browser.tab()
      try {
        await openConsole(tab, served, '/nodes')
        await tab.send('Network.enable')
        await tab.send('Network.emulateNetworkConditions', {
          offline: true,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        })
        await fastPolling(tab)
        await tab.waitFor(`!document.getElementById('conn').hidden`, 5_000)
        expect(
          await tab.evaluate<string>(
            `document.getElementById('conn').textContent`,
          ),
        ).toMatch(/^浏览器离线 · 数据截至 \d\d:\d\d:\d\d$/)
        await tab.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        })
        await tab.waitFor(`document.getElementById('conn').hidden`, 10_000)
      } finally {
        await tab.close()
        served.stop()
      }
    }, 30_000)
  },
)
