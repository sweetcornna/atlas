// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 告警 in a real browser: pressing 确认 changes the badge on the page in
 * front of the operator, and the inbox refreshes without the row.
 *
 * The HTTP suites (`alerts.test.ts`) prove the server's half — the next
 * render counts one fewer. This proves the page script's half, which no
 * request-level test can see: the click reaches `/v0/alerts/<id>/ack` with
 * the console header, the badge is repainted from the answer, and the polled
 * region is reloaded. Skipped, with the reason, where no Chrome is installed
 * (`cdp.ts`).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createConsoleHandler } from '../../src/http.js'
import { ADMIN, AGENTS, TOKENS, pageHarness } from '../pageHarness.js'
import { LOST_OSAKA, MemoryNotify, notice } from '../watchFakes.js'
import { Browser, skipReason } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[alerts browser tests] skipped: ${SKIP}`)

function serve() {
  const harness = pageHarness({ chat: true })
  harness.registry.listResult = {
    ok: true,
    value: [...AGENTS.slice(0, 2), LOST_OSAKA],
  }
  const notify = new MemoryNotify([
    notice('n:disk', 'error', '根分区使用率 95%'),
    notice('n:done', 'info', '巡检完成'),
  ])
  const handle = createConsoleHandler({ ...harness.deps, notify }, TOKENS)
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: request => handle(request),
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    notify,
    stop: () => {
      server.stop(true)
    },
  }
}

describe.skipIf(SKIP !== null)('the alert inbox in a browser', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await Browser.launch()
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
  }, 30_000)

  test('确认 repaints the badge and the refreshed inbox no longer holds the row', async () => {
    const served = serve()
    const tab = await browser.tab()
    try {
      await tab.goto(`${served.base}/alerts?token=${ADMIN}`)
      await tab.waitFor('window.qianmoConsole !== undefined')
      // The control: three unread before anything is pressed.
      expect(
        await tab.evaluate<string>(
          `document.getElementById('alerts-unread').textContent`,
        ),
      ).toBe('未确认 3')

      await tab.evaluate(
        `document.querySelector('[data-alert="n:disk"]').click()`,
      )
      await tab.waitFor(
        `document.getElementById('alerts').getAttribute('data-refreshed') !== null`,
      )
      expect(
        await tab.evaluate<string>(
          `document.getElementById('alerts-unread').textContent`,
        ),
      ).toBe('未确认 2')
      expect(
        await tab.evaluate<boolean>(
          `document.querySelector('[data-key="n:disk"]') === null`,
        ),
      ).toBe(true)
      expect(
        await tab.evaluate<string>(
          `document.getElementById('toasts').textContent`,
        ),
      ).toContain('已确认')
      expect(served.notify.stored.get('n:disk')?.by).toBe('legacy:admin')
    } finally {
      await tab.close()
      served.stop()
    }
  }, 30_000)
})
