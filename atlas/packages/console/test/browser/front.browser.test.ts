// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { accountsHarness, person } from '../accountsHarness.js'
import { Browser, observeChatStream, skipReason } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[front browser tests] skipped: ${SKIP}`)

describe.skipIf(SKIP !== null)(
  'front interaction with a personal session',
  () => {
    let browser: Browser
    beforeAll(async () => {
      browser = await Browser.launch()
    }, 30_000)
    afterAll(async () => {
      await browser?.close()
    }, 30_000)

    test('a welcome starts a conversation, filters survive refresh and preferences never persist credentials', async () => {
      const h = accountsHarness()
      const member = await person(h.handle, 'member')
      const seen: string[] = []
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(request) {
          seen.push(new URL(request.url).pathname)
          return h.handle(request)
        },
      })
      const base = `http://127.0.0.1:${server.port}`
      const tab = await browser.tab()
      try {
        await tab.send('Network.setCookie', {
          name: 'qianmo_session',
          value: member.sid,
          url: base,
          httpOnly: true,
          sameSite: 'Strict',
        })
        await tab.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `
        window.__stored = [];
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          window.__stored.push([key, String(value)]);
          return original.call(this, key, value);
        };
      `,
        })
        await observeChatStream(tab)
        await tab.goto(`${base}/`)
        await tab.waitFor(`window.__chatStreamOpen === true`)
        expect(
          await tab.evaluate<boolean>(
            `document.getElementById('fx-text').disabled`,
          ),
        ).toBe(false)
        await tab.evaluate(`(() => {
        document.getElementById('fx-text').value = '检查节点运行状态';
        document.getElementById('fx-composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()`)
        await tab.waitFor(
          `location.search === '?session=session-1' && document.getElementById('fx-text').value === ''`,
        )
        expect(h.chat.opened).toBe(1)
        expect(h.chat.sent.map(input => [input.sessionId, input.text])).toEqual(
          [['session-1', '检查节点运行状态']],
        )
        await tab.evaluate(
          `document.querySelector('[data-action="fx-scope"][data-scope="all"]').click()`,
        )
        await tab.waitFor(
          `document.querySelector('[data-action="fx-scope"][data-scope="all"]').getAttribute('aria-pressed') === 'true'`,
        )
        await tab.evaluate(
          `window.__oldHistory = document.getElementById('fx-history')`,
        )
        h.chat.emit('session-1')
        await tab.waitFor(
          `window.__oldHistory && !document.contains(window.__oldHistory)`,
        )
        expect(
          await tab.evaluate<string>(
            `document.querySelector('[data-action="fx-scope"][data-scope="all"]').getAttribute('aria-pressed')`,
          ),
        ).toBe('true')
        await tab.evaluate(
          `document.querySelector('.fx-side-top [data-action="fx-side"]').click()`,
        )
        const writes = await tab.evaluate<[string, string][]>(`window.__stored`)
        expect(writes).toContainEqual(['qianmo.front.scope', 'all'])
        expect(writes.some(([key]) => key === 'qianmo.front.side')).toBe(true)
        expect(JSON.stringify(writes)).not.toContain(member.credential)
        expect(JSON.stringify(writes)).not.toContain(member.sid)
        expect(
          writes.filter(([key]) => key === 'qianmo.console.token'),
        ).toEqual([])
        expect(seen).toContain('/fragments/chat/front/side')
        expect(seen).toContain('/fragments/chat/front/view/session-1')
      } finally {
        await tab.close()
        server.stop(true)
      }
    }, 30_000)
  },
)
