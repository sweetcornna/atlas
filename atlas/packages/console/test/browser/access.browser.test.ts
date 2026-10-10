// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 账号与访问 in a real browser: the page script's half of the two acts that
 * matter most on it.
 *
 * The HTTP suites (`accessPage.test.ts`, `access.test.ts`) prove the server
 * answers right. This proves what no request-level test can see: 签发 shows
 * the minted link once, in the one field made for it, and the list refreshes
 * with the new row; 强制下线 goes through its confirmation, the person's
 * streams drop to zero, and the region refreshes without them. Skipped, with
 * the reason, where no Chrome is installed (`cdp.ts`).
 */

import type { ReadableStreamDefaultReader } from 'node:stream/web'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { resolveAccess } from '../../src/access.js'
import {
  ADMIN,
  TOKENS,
  accountsHarness,
  asBearer,
  asSession,
  person,
} from '../accountsHarness.js'
import { MemoryActionLedger } from '../memoryActions.js'
import { Browser, skipReason } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[access browser tests] skipped: ${SKIP}`)

function serve() {
  const actions = new MemoryActionLedger()
  const h = accountsHarness({ deps: { actions } })
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: request => h.handle(request),
  })
  return {
    h,
    actions,
    base: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true)
    },
  }
}

describe.skipIf(SKIP !== null)('账号与访问 in a browser', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await Browser.launch()
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
  }, 30_000)

  test('签发 shows the link once and the list refreshes with the new invitation', async () => {
    const served = serve()
    const tab = await browser.tab()
    try {
      await tab.goto(`${served.base}/access/invites?token=${ADMIN}`)
      await tab.waitFor('window.qianmoConsole !== undefined')
      // The control: the panel is hidden and empty, nothing is listed yet.
      expect(
        await tab.evaluate<boolean>(
          `document.getElementById('invite-link').hidden`,
        ),
      ).toBe(true)
      expect(
        await tab.evaluate<number>(
          `document.querySelectorAll('#access-invites tr[data-key]').length`,
        ),
      ).toBe(0)

      await tab.evaluate(
        `(function () {
          document.getElementById('invite-label').value = '实验室新人';
          document.querySelector('input[name="role"][value="viewer"]').checked = true;
          document.querySelector('#invite-form button[type="submit"]').click();
        })()`,
      )
      // The answer's toast and the new row, not `data-refreshed`: the region
      // is polled, so a tick can bump that before the invitation is minted.
      await tab.waitFor(
        `document.getElementById('toasts').textContent.indexOf('已签发') !== -1 && ` +
          `document.querySelector('#access-invites tr[data-key]') !== null`,
      )
      const link = await tab.evaluate<string>(
        `document.getElementById('invite-link-value').value`,
      )
      expect(link.startsWith(`${served.base}/invite#qmi_`)).toBe(true)
      expect(
        await tab.evaluate<boolean>(
          `document.getElementById('invite-link').hidden`,
        ),
      ).toBe(false)
      const row = await tab.evaluate<string>(
        `document.querySelector('#access-invites tr[data-key]').textContent`,
      )
      expect(row).toContain('实验室新人')
      expect(row).toContain('只读')
      expect(row).toContain('未用')
      // The token is in that one field and nowhere else on the page.
      const token = link.slice(link.indexOf('#') + 1)
      expect(
        await tab.evaluate<number>(
          `document.documentElement.outerHTML.split(${JSON.stringify(
            token,
          )}).length - 1`,
        ),
      ).toBe(0)
      expect(
        await tab.evaluate<string>(
          `document.getElementById('toasts').textContent`,
        ),
      ).toContain('已签发')
      // Closing the panel forgets it.
      await tab.evaluate(
        `document.querySelector('[data-action="invite-link-close"]').click()`,
      )
      expect(
        await tab.evaluate<string>(
          `document.getElementById('invite-link-value').value`,
        ),
      ).toBe('')
      expect(served.actions.lines()).toContain('accounts.post /invites ok')
    } finally {
      await tab.close()
      served.stop()
    }
  }, 30_000)

  test('强制下线 goes through its confirmation and the person holds no stream after', async () => {
    const served = serve()
    const { h } = served
    const member = await person(h.handle, 'member')
    const access = resolveAccess(
      asSession('GET', '/v0/limits', member.sid),
      TOKENS,
      { book: h.book },
      false,
    )
    if (access.principal?.kind !== 'user') throw new Error('not a person')
    const subject = access.principal.subject
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
    for (const request of [
      asSession('GET', '/v0/chat/stream', member.sid, { header: false }),
      asBearer('GET', '/v0/chat/stream', member.credential),
    ]) {
      const response = await h.handle(request)
      const reader = response.body?.getReader()
      if (reader === undefined) throw new Error('no stream')
      await reader.read()
      readers.push(reader)
    }
    expect(h.book.openStreams(subject)).toBe(2)

    const tab = await browser.tab()
    try {
      await tab.goto(`${served.base}/access/sessions?token=${ADMIN}`)
      await tab.waitFor('window.qianmoConsole !== undefined')
      await tab.evaluate(
        `document.querySelector('[data-action="account-logout"][data-subject="${subject}"]').click()`,
      )
      await tab.waitFor(
        `document.getElementById('confirm-account-logout').open === true`,
      )
      expect(
        await tab.evaluate<string>(
          `document.getElementById('confirm-account-logout-name').textContent`,
        ),
      ).toBe(subject)
      await tab.evaluate(
        `document.querySelector('[data-action="confirm-account-logout"]').click()`,
      )
      // The answer's toast and the row gone, not `data-refreshed`: the region
      // is polled, so a tick can bump that before the sessions are ended.
      await tab.waitFor(
        `document.getElementById('toasts').textContent.indexOf('已强制下线') !== -1 && ` +
          `document.querySelector('#access-sessions tr[data-key="${subject}"]') === null`,
      )
      expect(h.book.openStreams(subject)).toBe(0)
      expect(
        await tab.evaluate<boolean>(
          `document.querySelector('#access-sessions tr[data-key="${subject}"]') === null`,
        ),
      ).toBe(true)
      expect(
        await tab.evaluate<string>(
          `document.getElementById('toasts').textContent`,
        ),
      ).toContain('已强制下线 · 结束 1 个会话')
      for (const reader of readers) {
        expect((await reader.read()).done).toBe(true)
      }
    } finally {
      for (const reader of readers) await reader.cancel().catch(() => {})
      await tab.close()
      served.stop()
    }
  }, 30_000)
})
