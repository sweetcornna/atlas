// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createConsoleHandler } from '../../src/http.js'
import { ADMIN, TOKENS, pageHarness } from '../pageHarness.js'
import { Browser, skipReason } from './cdp.js'

const SKIP = skipReason()
if (SKIP) console.warn(`[console P2 browser] skipped: ${SKIP}`)
describe.skipIf(SKIP !== null)('P2 real browser', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await Browser.launch()
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
  }, 30_000)

  test('theme survives navigation, shortcuts preserve typed text and touch controls fit', async () => {
    const h = pageHarness()
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: createConsoleHandler(h.deps, TOKENS),
    })
    const tab = await browser.tab()
    try {
      await tab.goto(`http://127.0.0.1:${server.port}/nodes?token=${ADMIN}`)
      await tab.waitFor('window.qianmoConsole !== undefined')
      await tab.evaluate(
        `(() => { const s = document.getElementById('theme-choice'); s.value = 'dark'; s.dispatchEvent(new Event('change')); })()`,
      )
      await tab.goto(`http://127.0.0.1:${server.port}/audit`)
      await tab.waitFor('window.qianmoConsole !== undefined')
      expect(
        await tab.evaluate<string>(`document.documentElement.dataset.theme`),
      ).toBe('dark')
      expect(
        await tab.evaluate<string>(
          `getComputedStyle(document.documentElement).colorScheme`,
        ),
      ).toBe('dark')
      await tab.evaluate(
        `document.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }))`,
      )
      expect(
        await tab.evaluate<boolean>(
          `document.getElementById('keyboard-help').open`,
        ),
      ).toBe(true)
      await tab.evaluate(
        `document.getElementById('keyboard-help').close(); document.querySelector('input[name="q"]').dispatchEvent(new KeyboardEvent('keydown', {key:'?', bubbles:true}))`,
      )
      expect(
        await tab.evaluate<boolean>(
          `document.getElementById('keyboard-help').open`,
        ),
      ).toBe(false)
      await tab.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      })
      expect(
        await tab.evaluate<number>(
          `Math.min(...[...document.querySelectorAll('[data-action="audit-export"]')].map(e=>e.getBoundingClientRect().height))`,
        ),
      ).toBeGreaterThanOrEqual(44)
      expect(
        await tab.evaluate<boolean>(
          `document.documentElement.scrollWidth <= window.innerWidth`,
        ),
      ).toBe(true)
    } finally {
      await tab.close()
      server.stop(true)
    }
  }, 30_000)

  test('SSE refreshes changed roster and resuming refresh catches a missed revision', async () => {
    const h = pageHarness()
    const seen: string[] = []
    const handle = createConsoleHandler(h.deps, TOKENS)
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        seen.push(new URL(request.url).pathname)
        return handle(request)
      },
    })
    const tab = await browser.tab()
    try {
      await tab.goto(`http://127.0.0.1:${server.port}/nodes?token=${ADMIN}`)
      await tab.waitFor(
        `document.querySelector('#roster[data-refreshed]') !== null`,
      )
      expect(seen).toContain('/v0/events')
      h.registry.listResult = { ok: true, value: [] }
      await tab.waitFor(
        `document.querySelectorAll('#roster details[data-key]').length === 0`,
        8_000,
      )
      await tab.evaluate(
        `var t = document.getElementById('auto-refresh'); t.checked = false; t.dispatchEvent(new Event('change'))`,
      )
      const original = pageHarness().registry.listResult
      h.registry.listResult = original
      await tab.evaluate(
        `var t = document.getElementById('auto-refresh'); t.checked = true; t.dispatchEvent(new Event('change'))`,
      )
      await tab.waitFor(
        `document.querySelectorAll('#roster details[data-key]').length === 3`,
      )
      expect(
        await tab.evaluate<number>(
          `document.querySelectorAll('summary button').length`,
        ),
      ).toBe(0)
    } finally {
      await tab.close()
      server.stop(true)
    }
  }, 30_000)
})
