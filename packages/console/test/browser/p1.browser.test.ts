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
import {
  ADMIN,
  TOKENS,
  VIEW,
  pageHarness,
  type PageHarness,
} from '../pageHarness.js'
import { Browser, skipReason, type Tab } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[console P1 browser tests] skipped: ${SKIP}`)

/** What the wrapper in front of the console does to each request. */
interface Wrapper {
  /** Answer every fragment with a 503: the console is there, its reads fail. */
  down: boolean
  /** Hold every matching request this long before answering. */
  delay: { readonly path: string; readonly ms: number } | null
  /** Requests seen: method, path, query and instant. */
  readonly seen: {
    readonly method: string
    readonly path: string
    readonly search: string
    readonly at: number
  }[]
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
      wrapper.seen.push({
        method: request.method,
        path: url.pathname,
        search: url.search,
        at: Date.now(),
      })
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

/** One key, pressed and released, as the keyboard sends it. */
async function key(tab: Tab, name: string, code: number): Promise<void> {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await tab.send('Input.dispatchKeyEvent', {
      type,
      key: name,
      code: name,
      windowsVirtualKeyCode: code,
    })
  }
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

    test('a failure toast says the short line and folds the original under 详情, which a click opens without dismissing (C5)', async () => {
      const served = serveConsole()
      served.harness.registry.heartbeat = () =>
        Promise.resolve({
          ok: false,
          failure: {
            code: 'unreachable',
            message:
              'http://127.0.0.1:38610 · Unable to connect. Is the computer able to access the url?',
          },
        })
      const tab = await browser.tab()
      try {
        await openConsole(tab, served, '/nodes')
        await tab.evaluate(
          `document.querySelector('#roster button[data-action="heartbeat"]').click()`,
        )
        await tab.waitFor(
          `document.querySelector('#toasts .toast[data-tone="bad"]') !== null`,
          5_000,
        )
        const shown = await tab.evaluate<{
          text: string
          role: string | null
          summary: string
          raw: string
        }>(`(() => {
          const toast = document.querySelector('#toasts .toast[data-tone="bad"]');
          return {
            text: toast.querySelector('.toast-text').textContent,
            role: toast.getAttribute('role'),
            summary: toast.querySelector('.toast-detail > summary').textContent,
            raw: toast.querySelector('pre[data-raw]').textContent,
          };
        })()`)
        expect(shown).toEqual({
          text: '心跳失败 · 无法连接',
          role: 'alert',
          summary: '详情',
          raw: 'http://127.0.0.1:38610 · Unable to connect. Is the computer able to access the url?',
        })
        // Opening the fold is a click inside the toast, and the toast stays.
        await tab.evaluate(
          `document.querySelector('#toasts .toast-detail > summary').click()`,
        )
        await pause(200)
        expect(
          await tab.evaluate<[boolean, boolean]>(`[
            document.querySelector('#toasts .toast[data-tone="bad"]') !== null,
            document.querySelector('#toasts .toast-detail').open,
          ]`),
        ).toEqual([true, true])
      } finally {
        await tab.close()
        served.stop()
      }
    }, 30_000)

    test('a slow row action holds its button, counts the seconds, survives a refresh, and sends once (C4)', async () => {
      const served = serveConsole()
      const tab = await browser.tab()
      try {
        await openConsole(tab, served, '/nodes')
        await fastPolling(tab)
        served.wrapper.delay = { path: '/v0/agents/', ms: 3_000 }
        const address = 'qianmo://tokyo-1/planner'
        const button = `document.querySelector('#roster button[data-action="heartbeat"][data-address="${address}"]')`
        const state = await tab.evaluate<{
          disabled: boolean
          busy: string | null
          progress: number
        }>(`(() => {
          const b = ${button};
          window.__beat = b;
          b.click();
          b.click();
          return {
            disabled: b.disabled,
            busy: b.getAttribute('aria-busy'),
            progress: document.querySelectorAll('[data-progress]').length,
          };
        })()`)
        // Busy from the first click, so the second one never left the page;
        // nothing shown yet for work that may be over in a moment.
        expect(state).toEqual({ disabled: true, busy: 'true', progress: 0 })

        await tab.waitFor(
          `(document.querySelector('#toasts [data-progress] .toast-text') || {}).textContent === '心跳 · 进行中 · 已用 2 秒'`,
          5_000,
        )
        expect(
          await tab.evaluate<string>(
            `document.querySelector('#toasts [data-progress] [data-progress-stop]').textContent`,
          ),
        ).toBe('停止等待')
        // The roster refreshed under it: the old button is gone, and the one
        // that replaced it is busy too.
        expect(
          await tab.evaluate<boolean[]>(`(() => {
            const b = ${button};
            return [window.__beat.isConnected, b === window.__beat, b.disabled, b.getAttribute('aria-busy') === 'true'];
          })()`),
        ).toEqual([false, false, true, true])

        await tab.waitFor(
          `[...document.querySelectorAll('#toasts .toast-text')].some(t => t.textContent === '已心跳 ${address}')`,
          5_000,
        )
        expect(
          await tab.evaluate<[boolean, string | null, number]>(`(() => {
            const b = ${button};
            return [b.disabled, b.getAttribute('aria-busy'), document.querySelectorAll('[data-progress]').length];
          })()`),
        ).toEqual([false, null, 0])
        expect(
          served.wrapper.seen.filter(seen => seen.path.endsWith('/heartbeat'))
            .length,
        ).toBe(1)
        expect(served.harness.registry.beats).toEqual([address])
      } finally {
        await tab.close()
        served.stop()
      }
    }, 30_000)

    test('a confirmed wake runs as the dialog button, can be stopped from inside the dialog, and says what stopping means (C4)', async () => {
      const served = serveConsole()
      const tab = await browser.tab()
      try {
        await openConsole(tab, served, '/nodes')
        served.wrapper.delay = { path: '/v0/wake', ms: 20_000 }
        await tab.evaluate(
          `document.querySelector('[data-open-dialog="wake-dialog"]').click()`,
        )
        await tab.waitFor(`document.getElementById('wake-dialog').open`)
        await tab.evaluate(`(() => {
          const form = document.getElementById('wake-form');
          form.elements['to'].value = 'qianmo://osaka-1/writer';
          form.elements['prompt'].value = '整理今天的告警';
          const go = form.querySelector('[type="submit"]');
          go.focus();
          go.click();
        })()`)
        await tab.waitFor(`document.getElementById('confirm-wake').open`)
        await tab.evaluate(
          `document.querySelector('#confirm-wake [data-action="confirm-wake"]').click()`,
        )
        const submit = `document.querySelector('#wake-form [type="submit"]')`
        expect(
          await tab.evaluate<[boolean, string | null]>(
            `[${submit}.disabled, ${submit}.getAttribute('aria-busy')]`,
          ),
        ).toEqual([true, 'true'])

        // In the dialog, because the page behind a modal dialog is inert and
        // a stop button in the corner could not be pressed.
        await tab.waitFor(
          `/^唤醒 · 进行中 · 已用 \\d+ 秒$/.test((document.querySelector('#wake-dialog [data-progress] .toast-text') || {}).textContent || '')`,
          5_000,
        )
        expect(
          await tab.evaluate<number>(
            `document.querySelectorAll('#toasts [data-progress]').length`,
          ),
        ).toBe(0)
        await tab.evaluate(
          `document.querySelector('#wake-dialog [data-progress-stop]').click()`,
        )
        await tab.waitFor(
          `document.getElementById('wake-status').textContent === '唤醒 · 已停止等待 · 服务端可能仍在处理'`,
          5_000,
        )
        expect(
          await tab.evaluate<
            [
              string | null,
              boolean,
              string | null,
              boolean,
              number,
              string | null,
            ]
          >(`(() => {
            const b = ${submit};
            const toast = [...document.querySelectorAll('#toasts .toast')].find(
              t => t.textContent === '唤醒 · 已停止等待 · 服务端可能仍在处理');
            return [
              document.getElementById('wake-status').getAttribute('data-tone'),
              b.disabled,
              b.getAttribute('aria-busy'),
              document.activeElement === b,
              document.querySelectorAll('[data-progress]').length,
              toast ? toast.getAttribute('data-tone') : 'missing',
            ];
          })()`),
        ).toEqual(['warn', false, null, true, 0, 'warn'])
        expect(
          served.wrapper.seen.filter(seen => seen.path === '/v0/wake').length,
        ).toBe(1)
      } finally {
        await tab.close()
        served.stop()
      }
    }, 40_000)

    test('a wrong field is marked where it is, before anything is sent, and a refusal that names a field lands on it (D3)', async () => {
      const served = serveConsole()
      // The registry refuses the key, in its own words.
      served.harness.registry.register = input => {
        served.harness.registry.registered.push(input)
        return Promise.resolve({
          ok: false,
          failure: {
            code: 'invalid',
            message: 'publicKey must be a base64url Ed25519 key',
          },
        })
      }
      const tab = await browser.tab()
      try {
        await openConsole(tab, served, '/nodes')
        await tab.evaluate(
          `document.querySelector('[data-open-dialog="register-dialog"]').click()`,
        )
        await tab.waitFor(`document.getElementById('register-dialog').open`)
        const marked = await tab.evaluate<{
          address: [string | null, string | null, string]
          endpoint: [string | null, string | null, string]
          focus: string
          status: string
        }>(`(() => {
          const form = document.getElementById('register-form');
          form.elements['address'].value = 'Qianmo://Tokyo/planner';
          form.elements['endpoint'].value = '127.0.0.1:38611';
          form.querySelector('[type="submit"]').click();
          const of = name => {
            const el = form.elements[name];
            const id = el.getAttribute('aria-describedby');
            return [el.getAttribute('aria-invalid'), id, id ? document.getElementById(id).textContent : ''];
          };
          return {
            address: of('address'),
            endpoint: of('endpoint'),
            focus: document.activeElement.name,
            status: document.getElementById('register-status').textContent,
          };
        })()`)
        expect(marked).toEqual({
          address: [
            'true',
            'f-address-error',
            '格式应为 qianmo://节点/智能体 · 小写字母 数字 - _',
          ],
          endpoint: [
            'true',
            'f-endpoint-error',
            '格式应为 ws://主机:端口 或 qianmo:// 地址',
          ],
          focus: 'address',
          status: '有字段需要修改',
        })
        expect(served.harness.registry.registered).toEqual([])

        // Editing a marked field takes its mark away.
        expect(
          await tab.evaluate<[string | null, boolean]>(`(() => {
            const box = document.getElementById('f-address');
            box.value = 'qianmo://tokyo-1/scout';
            box.dispatchEvent(new Event('input', { bubbles: true }));
            return [box.getAttribute('aria-invalid'), document.getElementById('f-address-error') === null];
          })()`),
        ).toEqual([null, true])

        // Right format, refused by the registry for the key: the key's field,
        // opened out of 高级选项, says so, and has focus.
        await tab.evaluate(`(() => {
          const form = document.getElementById('register-form');
          form.elements['endpoint'].value = 'ws://127.0.0.1:38611';
          form.elements['publicKey'].value = 'not-a-key';
          form.querySelector('[type="submit"]').click();
        })()`)
        await tab.waitFor(
          `document.getElementById('f-publicKey').getAttribute('aria-invalid') === 'true'`,
          5_000,
        )
        expect(
          await tab.evaluate<[string, boolean, boolean, string, number]>(`[
            document.getElementById('f-publicKey-error').textContent,
            document.getElementById('f-publicKey').closest('details').open,
            document.activeElement === document.getElementById('f-publicKey'),
            document.getElementById('register-status').textContent,
            document.querySelectorAll('#toasts .toast').length,
          ]`),
        ).toEqual([
          '应为 base64url 编码的 Ed25519 公钥',
          true,
          true,
          '注册失败 · 请求内容不合法',
          0,
        ])
        expect(served.harness.registry.registered.length).toBe(1)
      } finally {
        await tab.close()
        served.stop()
      }
    }, 30_000)

    test('the wake form checks its delay against the field own limit (D3)', async () => {
      const served = serveConsole()
      const tab = await browser.tab()
      try {
        await openConsole(tab, served, '/nodes')
        await tab.evaluate(
          `document.querySelector('[data-open-dialog="wake-dialog"]').click()`,
        )
        await tab.waitFor(`document.getElementById('wake-dialog').open`)
        const result = await tab.evaluate<
          [string | null, string, boolean, boolean]
        >(`(() => {
          const form = document.getElementById('wake-form');
          form.elements['prompt'].value = '';
          form.elements['afterMs'].value = '70000';
          form.querySelector('[type="submit"]').click();
          return [
            form.elements['afterMs'].getAttribute('aria-invalid'),
            document.getElementById('wake-after-error').textContent,
            form.elements['afterMs'].closest('details').open,
            document.getElementById('confirm-wake').open,
          ];
        })()`)
        expect(result).toEqual([
          'true',
          '应为 0 到 60000 之间的整数毫秒',
          true,
          false,
        ])
        expect(
          await tab.evaluate<string>(
            `document.getElementById('wake-prompt-error').textContent`,
          ),
        ).toBe('必填')
        expect(served.harness.wake.sent).toEqual([])
      } finally {
        await tab.close()
        served.stop()
      }
    }, 30_000)

    test('a confirm keeps Tab inside it, and Escape gives focus to its opener even after a refresh replaced it (D4)', async () => {
      const served = serveConsole()
      const tab = await browser.tab()
      try {
        await openConsole(tab, served, '/nodes')
        const address = 'qianmo://tokyo-1/planner'
        const opener = `document.querySelector('#roster button[data-action="deregister"][data-address="${address}"]')`
        await tab.evaluate(`(() => {
          document.querySelector('#roster details[data-key="${address}"]').open = true;
          const b = ${opener};
          window.__opener = b;
          b.focus();
          b.click();
        })()`)
        await tab.waitFor(`document.getElementById('confirm-deregister').open`)

        // Tab cycles through the dialog's own controls. The one stop outside
        // it is the browser's own chrome (seen from the page as no element
        // focused, which is how a modal dialog lets you reach the address
        // bar); no control of the page behind is ever reached: it is inert.
        const stops: string[] = []
        for (let i = 0; i < 6; i += 1) {
          await key(tab, 'Tab', 9)
          stops.push(
            await tab.evaluate<string>(`(() => {
              const at = document.activeElement;
              if (at === null || at === document.body) return 'chrome';
              return document.getElementById('confirm-deregister').contains(at)
                ? at.textContent.trim()
                : 'page ' + at.tagName + ' ' + at.textContent.trim();
            })()`),
          )
        }
        expect(stops.filter(stop => stop.startsWith('page'))).toEqual([])
        expect(new Set(stops)).toEqual(new Set(['取消', '注销', 'chrome']))

        // A refresh replaces the roster, and the button that opened the
        // confirm with it.
        await fastPolling(tab)
        await tab.waitFor(
          `!window.__opener.isConnected && ${opener} !== null`,
          5_000,
        )

        await key(tab, 'Escape', 27)
        await tab.waitFor(`!document.getElementById('confirm-deregister').open`)
        // The browser's own restoration has nothing to restore to; the
        // runtime's, on the dialog's close event, does.
        await tab.waitFor(`document.activeElement === ${opener}`, 2_000)
        expect(
          await tab.evaluate<[boolean, string | null, string | null]>(`[
            document.activeElement === ${opener},
            document.activeElement.getAttribute('data-action'),
            document.activeElement.getAttribute('data-address'),
          ]`),
        ).toEqual([true, 'deregister', address])
        expect(served.harness.registry.deregistered).toEqual([])
      } finally {
        await tab.close()
        served.stop()
      }
    }, 30_000)

    test('the banner link becomes a session: the address, the links and every later request carry no token (H5)', async () => {
      const served = serveConsole()
      const tab = await browser.tab()
      try {
        await openConsole(tab, served, '/nodes')
        const first = served.wrapper.seen.length
        expect(
          await tab.evaluate<[string, string, string[]]>(`[
            location.pathname,
            location.search,
            [...document.querySelectorAll('a[data-nav]')]
              .map(a => a.getAttribute('href'))
              .filter(href => href.includes('token=')),
          ]`),
        ).toEqual(['/nodes', '', []])
        // The page itself never held it: the server answered the link with
        // the cookie before anything rendered.
        expect(
          await tab.evaluate<string | null>(
            `localStorage.getItem('qianmo.console.token')`,
          ),
        ).toBeNull()

        await tab.evaluate(
          `document.querySelector('a[data-nav][href="/audit"]').click()`,
        )
        await tab.waitFor(
          `location.pathname === '/audit' && window.qianmoConsole !== undefined`,
          10_000,
        )
        expect(
          await tab.evaluate<string>(
            `document.querySelector('h1').textContent`,
          ),
        ).toContain('消息链')
        const later = served.wrapper.seen.slice(first)
        expect(later.length).toBeGreaterThan(0)
        expect(later.filter(seen => seen.search.includes('token='))).toEqual([])
      } finally {
        await tab.close()
        served.stop()
      }
    }, 30_000)

    test('a token typed into the box is exchanged at the login door, and the session switches with it (H5)', async () => {
      const served = serveConsole()
      const tab = await browser.tab()
      try {
        await tab.goto(`${served.base}/nodes?token=${VIEW}`)
        await tab.waitFor('window.qianmoConsole !== undefined')
        expect(
          await tab.evaluate<number>(
            `document.querySelectorAll('[data-write]').length`,
          ),
        ).toBe(0)
        await tab.evaluate(`(() => {
          document.getElementById('token').value = '${ADMIN}';
          document.querySelector('[data-action="token-save"]').click();
        })()`)
        const posted = async () =>
          served.wrapper.seen.some(
            seen => seen.method === 'POST' && seen.path === '/login',
          )
        for (let i = 0; i < 50 && !(await posted()); i += 1) await pause(100)
        expect(await posted()).toBe(true)
        await pause(300)
        // A plain navigation now opens as the admin, on the cookie alone.
        await tab.goto(`${served.base}/nodes`)
        await tab.waitFor('window.qianmoConsole !== undefined')
        expect(
          await tab.evaluate<number>(
            `document.querySelectorAll('[data-write]').length`,
          ),
        ).toBeGreaterThan(0)
        expect(
          served.wrapper.seen.filter(
            seen => seen.path !== '/nodes' && seen.search.includes('token='),
          ),
        ).toEqual([])
      } finally {
        await tab.close()
        served.stop()
      }
    }, 30_000)

    test('the conversation stream opens on the cookie, with nothing in its URL (H5)', async () => {
      const served = serveConsole()
      const tab = await browser.tab()
      try {
        await openConsole(tab, served, '/chat')
        await tab.waitFor(
          `(document.getElementById('stream-state') || {}).textContent === '实时'`,
          10_000,
        )
        const streams = served.wrapper.seen.filter(
          seen => seen.path === '/v0/chat/stream',
        )
        expect(streams.length).toBeGreaterThan(0)
        expect(streams.map(seen => seen.search)).toEqual(streams.map(() => ''))
      } finally {
        await tab.close()
        served.stop()
      }
    }, 30_000)

    test('the roster filter submits as a plain GET and leaves only what was asked in the URL (D6)', async () => {
      const served = serveConsole()
      const tab = await browser.tab()
      try {
        await openConsole(tab, served, '/nodes')
        await tab.evaluate(`(() => {
          const form = document.getElementById('roster-filter');
          form.querySelector('input[name="q"]').value = 'osaka';
          form.requestSubmit();
        })()`)
        await tab.waitFor(`location.search === '?q=osaka'`, 10_000)
        await tab.waitFor('window.qianmoConsole !== undefined')
        const shown = await tab.evaluate<string[]>(
          `[...document.querySelectorAll('#roster details.row')].map(row => row.dataset.key)`,
        )
        expect(shown).toEqual(['qianmo://osaka-1/writer'])
        expect(
          await tab.evaluate<string>(
            `document.getElementById('roster-tally').textContent`,
          ),
        ).toContain('筛选后 1 · 共 3')
        // The search box still holds what was searched, and still works.
        expect(
          await tab.evaluate<boolean>(
            `document.querySelector('#roster-filter input[name="q"]').disabled`,
          ),
        ).toBe(false)
      } finally {
        await tab.close()
        served.stop()
      }
    }, 30_000)
  },
)
