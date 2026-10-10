// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The console in a real browser (K1): the four behaviours that only exist
 * between the markup and the script, each checked the way an operator would
 * meet it.
 *
 * 1. **Framing (H1).** Another origin puts the console in an `<iframe>`; the
 *    browser must refuse to render it. Run three times with one header
 *    stripped each time, so each header is shown to work alone, and once
 *    with both stripped — the positive control that proves the probe can see
 *    a framed console at all.
 * 2. **A session that lapses (C1).** The credential stops working mid-page:
 *    the expiry dialog opens, the poller stops asking, and a dialog dismissed
 *    with Escape comes back on the next request instead of sending it.
 * 3. **A poll under an open row (D1).** The roster is replaced while a row is
 *    expanded and a button in it has focus: both survive.
 * 4. **Native dialogs.** The register form opens modal and Escape returns
 *    focus to the button that opened it.
 *
 * Driven over the DevTools protocol by `cdp.ts`, with no dependency. Skipped,
 * with the reason printed, on a machine without Chrome.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createConsoleHandler } from '../../src/http.js'
import {
  ADMIN,
  AGENTS,
  TOKENS,
  agentAt,
  pageHarness,
  type PageHarness,
} from '../pageHarness.js'
import { Browser, skipReason, type Tab } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[console browser tests] skipped: ${SKIP}`)

/** What the wrapper in front of the console does to each request. */
interface Wrapper {
  /** Answer as if no credential had been sent: the session lapsed. */
  revoked: boolean
  /** Response headers to drop, for the framing controls. */
  strip: readonly string[]
  /** Requests seen, by path. */
  readonly seen: string[]
}

interface Served {
  readonly base: string
  readonly wrapper: Wrapper
  readonly harness: PageHarness
  stop(): void
}

/** The console on a loopback port, behind a wrapper the test can steer. */
function serveConsole(): Served {
  const harness = pageHarness({ chat: true })
  const handle = createConsoleHandler(harness.deps, TOKENS)
  const wrapper: Wrapper = { revoked: false, strip: [], seen: [] }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      wrapper.seen.push(url.pathname)
      // Polling fallback revocation; P2 covers event delivery separately.
      if (url.pathname === '/v0/events')
        return new Response(null, { status: 503 })
      let forwarded = request
      if (wrapper.revoked) {
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
      for (const name of wrapper.strip) response.headers.delete(name)
      return response
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

/** A page on another origin that frames `target`. */
function serveFramer(target: string): { url: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () =>
      new Response(
        `<!DOCTYPE html><html><body><iframe id="victim" src="${target}" ` +
          `width="900" height="600"></iframe></body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      ),
  })
  return {
    url: `http://127.0.0.1:${server.port}/`,
    stop: () => {
      server.stop(true)
    },
  }
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Open a console page signed in with the admin token, runtime started. */
async function openConsole(tab: Tab, served: Served, path: string) {
  await tab.goto(`${served.base}${path}?token=${ADMIN}`)
  await tab.waitFor('window.qianmoConsole !== undefined')
}

/** Press and release Escape, the way a keyboard would. */
async function escape(tab: Tab): Promise<void> {
  for (const type of ['keyDown', 'keyUp']) {
    await tab.send('Input.dispatchKeyEvent', {
      type,
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    })
  }
}

/**
 * Poll every 400 ms instead of the select's shortest 2 s, by giving the
 * select one more option: the runtime reads whatever the select says.
 */
async function fastPolling(tab: Tab): Promise<void> {
  await tab.evaluate(`(() => {
    const picker = document.getElementById('refresh-interval');
    picker.add(new Option('0.4s', '400'));
    picker.value = '400';
    picker.dispatchEvent(new Event('change'));
  })()`)
}

describe.skipIf(SKIP !== null)('the console in a browser', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await Browser.launch()
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
  }, 30_000)

  describe('framing (H1)', () => {
    /** Load the framer and report what the frame ended up holding. */
    async function framed(strip: readonly string[]): Promise<string | null> {
      const served = serveConsole()
      served.wrapper.strip = strip
      const framer = serveFramer(`${served.base}/nodes?token=${ADMIN}`)
      const tab = await browser.tab()
      try {
        await tab.goto(framer.url)
        const frames = await tab.childFrames()
        expect(frames).toHaveLength(1)
        const frame = frames[0]
        if (frame === undefined) return null
        try {
          return await tab.evaluateInFrame<string | null>(
            frame.id,
            `(() => { const t = document.getElementById('page-title'); return t ? t.textContent : null })()`,
          )
        } catch {
          // An error page may not even offer a world to evaluate in.
          return null
        }
      } finally {
        await tab.close()
        framer.stop()
        served.stop()
      }
    }

    test('with both headers stripped the probe sees the console — the control', async () => {
      expect(await framed(['content-security-policy', 'x-frame-options'])).toBe(
        '节点',
      )
    }, 30_000)

    test('as served, a cross-origin frame renders nothing of it', async () => {
      expect(await framed([])).toBeNull()
    }, 30_000)

    test("frame-ancestors 'none' alone refuses it", async () => {
      expect(await framed(['x-frame-options'])).toBeNull()
    }, 30_000)

    test('X-Frame-Options: DENY alone refuses it', async () => {
      expect(await framed(['content-security-policy'])).toBeNull()
    }, 30_000)
  })

  test('a 401 opens the expiry dialog and the poller stops asking (C1)', async () => {
    const served = serveConsole()
    const tab = await browser.tab()
    try {
      await openConsole(tab, served, '/nodes')
      await fastPolling(tab)
      // One refresh that works, so the timer is known to be running.
      await tab.waitFor(
        `document.getElementById('roster').getAttribute('data-refreshed') !== null`,
      )
      expect(
        await tab.evaluate<boolean>(
          `document.getElementById('session-expired').open`,
        ),
      ).toBe(false)

      served.wrapper.revoked = true
      await tab.waitFor(`document.getElementById('session-expired').open`)
      const polls = () =>
        served.wrapper.seen.filter(path => path.startsWith('/fragments/'))
          .length
      const atExpiry = polls()
      // Ten intervals' worth of nothing.
      await pause(4_000)
      expect(polls()).toBe(atExpiry)

      // The way back is to this page, through the door.
      expect(
        await tab.evaluate<string>(
          `document.getElementById('session-expired-login').getAttribute('href')`,
        ),
      ).toBe('/login?redirect=%2Fnodes')
      expect(
        await tab.evaluate<string>(
          `document.getElementById('refresh-state').textContent`,
        ),
      ).toBe('已停止 · 会话已失效')
      // Escape closes it, as it closes any modal: Chrome honours a veto
      // only right after a click and never twice running (`client.ts`,
      // `refused`). The page stays stopped and readable behind it.
      await escape(tab)
      await tab.waitFor(`!document.getElementById('session-expired').open`)
      expect(polls()).toBe(atExpiry)
      // The next thing tried that needs the server never leaves the
      // browser, and brings the dialog back.
      const before = served.wrapper.seen.length
      const said = await tab.evaluate<string>(
        `window.qianmoConsole.sendJson('POST', '/v0/agents', {}).then(() => 'sent', e => e.message)`,
      )
      expect(said).toBe('会话已失效')
      expect(served.wrapper.seen.length).toBe(before)
      expect(
        await tab.evaluate<boolean>(
          `document.getElementById('session-expired').matches(':modal')`,
        ),
      ).toBe(true)
    } finally {
      await tab.close()
      served.stop()
    }
  }, 30_000)

  test('a poll replaces the roster under an open row and a focused button, and both survive (D1)', async () => {
    const served = serveConsole()
    const tab = await browser.tab()
    const key = 'qianmo://tokyo-1/reviewer'
    try {
      await openConsole(tab, served, '/nodes')
      await tab.evaluate(`(() => {
          const row = document.querySelector('details[data-key="${key}"]');
          row.open = true;
          row.querySelector('[data-action="deregister"]').focus();
          window.__before = row;
        })()`)
      expect(
        await tab.evaluate<string>(
          `document.activeElement.getAttribute('data-action')`,
        ),
      ).toBe('deregister')

      // The next read differs, so the refresh is visibly a new roster.
      served.harness.registry.listResult = {
        ok: true,
        value: [...AGENTS, agentAt('qianmo://osaka-1/late')],
      }
      await fastPolling(tab)
      await tab.waitFor(
        `document.querySelector('details[data-key="qianmo://osaka-1/late"]') !== null`,
      )

      const after = await tab.evaluate<{
        replaced: boolean
        open: boolean
        others: number
        action: string | null
        address: string | null
        inRow: boolean
      }>(`(() => {
          const row = document.querySelector('details[data-key="${key}"]');
          const active = document.activeElement;
          return {
            replaced: !document.contains(window.__before),
            open: row.open,
            others: document.querySelectorAll('details.row[open]').length,
            action: active.getAttribute('data-action'),
            address: active.getAttribute('data-address'),
            inRow: row.contains(active),
          };
        })()`)
      expect(after).toEqual({
        replaced: true,
        open: true,
        others: 1,
        action: 'deregister',
        address: key,
        inRow: true,
      })
    } finally {
      await tab.close()
      served.stop()
    }
  }, 30_000)

  test('the register form opens modal, and Escape gives focus back to its button', async () => {
    const served = serveConsole()
    const tab = await browser.tab()
    try {
      await openConsole(tab, served, '/nodes')
      await tab.evaluate(`(() => {
          const opener = document.querySelector('[data-open-dialog="register-dialog"]');
          opener.focus();
          opener.click();
        })()`)
      await tab.waitFor(`document.getElementById('register-dialog').open`)
      // Modal: the rest of the page is inert while it is open.
      expect(
        await tab.evaluate<boolean>(
          `document.getElementById('register-dialog').matches(':modal')`,
        ),
      ).toBe(true)
      await escape(tab)
      await tab.waitFor(`!document.getElementById('register-dialog').open`)
      expect(
        await tab.evaluate<string | null>(
          `document.activeElement.getAttribute('data-open-dialog')`,
        ),
      ).toBe('register-dialog')
    } finally {
      await tab.close()
      served.stop()
    }
  }, 30_000)
})
