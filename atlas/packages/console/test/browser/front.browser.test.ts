// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChatTranscript, ConsoleResult } from '../../src/deps.js'
import { createConsoleHandler } from '../../src/http.js'
import {
  ADDRESS,
  CountingChat,
  accountsHarness,
  asSession,
  person,
} from '../accountsHarness.js'
import { ADMIN, NOW, TOKENS, pageHarness } from '../pageHarness.js'
import { Browser, observeChatStream, skipReason } from './cdp.js'

/**
 * One answer with a list, the bold line after it and a short code block (the
 * one that would shrink to its text), then one whose line is longer than any
 * column.
 */
class CodeChat extends CountingChat {
  override async transcript(
    sessionId: string,
  ): Promise<ConsoleResult<ChatTranscript>> {
    const read = await super.transcript(sessionId)
    if (!read.ok) return read
    return {
      ok: true,
      value: {
        session: read.value.session,
        turns: [
          {
            id: 'ask',
            sessionId,
            author: 'operator',
            at: NOW - 60_000,
            text: '把路由列一下',
            state: 'read',
          },
          {
            id: 'answer',
            sessionId,
            author: 'agent',
            at: NOW - 30_000,
            text:
              '**macOS**\n\n- 本机构建\n- 走完配对\n\n**Windows 与 Linux**\n\n' +
              '```\nGET /app\n```\n\n已过',
            state: 'done',
          },
          {
            id: 'command',
            sessionId,
            author: 'agent',
            at: NOW - 20_000,
            text: `\`\`\`\ncurl -fsS ${'-H x '.repeat(60)}http://127.0.0.1:38700/app/quick\n\`\`\``,
            state: 'done',
          },
        ],
      },
    }
  }
}

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

    test('sending during a held session switch cannot post into the session that is not yet on screen', async () => {
      const h = accountsHarness()
      const member = await person(h.handle, 'member')
      const ids: string[] = []
      for (let i = 0; i < 2; i++) {
        const response = await h.handle(
          asSession('POST', '/v0/chat/sessions', member.sid, {
            body: { target: ADDRESS },
          }),
        )
        expect(response.status).toBe(200)
        ids.push(((await response.json()) as { id: string }).id)
      }
      const [a, b] = ids
      const gate = Promise.withResolvers<void>()
      const requested = Promise.withResolvers<void>()
      let hold = false
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(request) {
          if (
            hold &&
            new URL(request.url).pathname === `/fragments/chat/front/view/${b}`
          ) {
            requested.resolve()
            await gate.promise
          }
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
            window.__messagePosts = [];
            const originalFetch = window.fetch;
            window.fetch = function(url, options) {
              if (options && options.method === 'POST' && String(url).endsWith('/messages')) window.__messagePosts.push(String(url));
              return originalFetch.apply(this, arguments);
            };
          `,
        })
        await observeChatStream(tab)
        await tab.goto(`${base}/?session=${a}`)
        await tab.waitFor(`window.__chatStreamOpen === true`)
        hold = true
        await tab.evaluate(
          `document.querySelector('.fx-hitem[data-session="${b}"]').click()`,
        )
        await requested.promise
        expect(
          await tab.evaluate<string>(
            `document.getElementById('fx-thread').getAttribute('data-session')`,
          ),
        ).toBe(a)
        await tab.evaluate(`(() => {
          document.getElementById('fx-text').value = '切换时的草稿';
          document.getElementById('fx-composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        })()`)
        await tab.waitFor(
          `document.getElementById('fx-status').textContent.includes('正在打开会话') || window.__messagePosts.length > 0`,
        )
        expect(await tab.evaluate<string[]>(`window.__messagePosts`)).toEqual(
          [],
        )
        expect(h.chat.sent).toEqual([])
        expect(
          await tab.evaluate<boolean>(
            `document.getElementById('fx-text').disabled`,
          ),
        ).toBe(true)
        gate.resolve()
        await tab.waitFor(
          `document.getElementById('fx-thread').getAttribute('data-session') === '${b}' && !document.getElementById('fx-text').disabled`,
        )
        expect(
          await tab.evaluate<string>(
            `document.getElementById('fx-text').value`,
          ),
        ).toBe('切换时的草稿')
        await tab.evaluate(
          `document.getElementById('fx-composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))`,
        )
        await tab.waitFor(
          `document.getElementById('fx-composer').getAttribute('aria-busy') === null && document.getElementById('fx-text').value === ''`,
        )
        expect(h.chat.sent.map(input => [input.sessionId, input.text])).toEqual(
          [[b, '切换时的草稿']],
        )
      } finally {
        gate.resolve()
        await tab.close()
        server.stop(true)
      }
    }, 30_000)

    test('a switch whose view fails leaves the shown conversation unsendable until the target is opened', async () => {
      const h = accountsHarness()
      const member = await person(h.handle, 'member')
      const ids: string[] = []
      for (let i = 0; i < 2; i++) {
        const response = await h.handle(
          asSession('POST', '/v0/chat/sessions', member.sid, {
            body: { target: ADDRESS },
          }),
        )
        expect(response.status).toBe(200)
        ids.push(((await response.json()) as { id: string }).id)
      }
      const [a, b] = ids
      let failB = false
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(request) {
          if (
            failB &&
            new URL(request.url).pathname === `/fragments/chat/front/view/${b}`
          )
            return new Response('测试打开失败', { status: 503 })
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
        await observeChatStream(tab)
        await tab.goto(`${base}/?session=${a}`)
        await tab.waitFor(`window.__chatStreamOpen === true`)
        failB = true
        await tab.evaluate(
          `document.querySelector('.fx-hitem[data-session="${b}"]').click()`,
        )
        await tab.waitFor(
          `document.getElementById('fx-status').textContent.includes('打开')`,
        )
        expect(
          await tab.evaluate<string>(
            `document.getElementById('fx-thread').getAttribute('data-session')`,
          ),
        ).toBe(a)
        expect(
          await tab.evaluate<boolean>(
            `document.getElementById('fx-text').disabled`,
          ),
        ).toBe(true)
        await tab.evaluate(`(() => {
          const box = document.getElementById('fx-text');
          box.disabled = false;
          box.value = '打开失败后的草稿';
          document.getElementById('fx-composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        })()`)
        await tab.waitFor(
          `document.getElementById('fx-status').textContent.includes('正在打开会话')`,
        )
        expect(h.chat.sent).toEqual([])
        failB = false
        await tab.evaluate(
          `document.querySelector('.fx-hitem[data-session="${b}"]').click()`,
        )
        await tab.waitFor(
          `document.getElementById('fx-thread').getAttribute('data-session') === '${b}' && !document.getElementById('fx-text').disabled`,
        )
        await tab.evaluate(
          `document.getElementById('fx-composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))`,
        )
        await tab.waitFor(
          `document.getElementById('fx-composer').getAttribute('aria-busy') === null && document.getElementById('fx-text').value === ''`,
        )
        expect(h.chat.sent.map(input => [input.sessionId, input.text])).toEqual(
          [[b, '打开失败后的草稿']],
        )
      } finally {
        await tab.close()
        server.stop(true)
      }
    }, 30_000)

    test('a successful send followed by a failed refresh keeps the draft cleared and the message acknowledged', async () => {
      const h = accountsHarness()
      const member = await person(h.handle, 'member')
      let failRefresh = false
      let failedRefreshes = 0
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(request) {
          const path = new URL(request.url).pathname
          if (failRefresh && path.startsWith('/fragments/chat/front/view/')) {
            failedRefreshes++
            return new Response('测试刷新失败', { status: 503 })
          }
          const response = await h.handle(request)
          if (
            request.method === 'POST' &&
            path.endsWith('/messages') &&
            response.ok
          )
            failRefresh = true
          return response
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
        await observeChatStream(tab)
        await tab.goto(`${base}/`)
        await tab.waitFor(`window.__chatStreamOpen === true`)
        await tab.evaluate(`(() => {
          document.getElementById('fx-text').value = '已确认的消息';
          document.getElementById('fx-composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        })()`)
        await tab.waitFor(
          `document.getElementById('fx-status').textContent.includes('刷新失败') || document.getElementById('fx-status').textContent.includes('发送失败')`,
        )
        expect(h.chat.sent.map(input => input.text)).toEqual(['已确认的消息'])
        expect(failedRefreshes).toBeGreaterThan(0)
        expect(
          await tab.evaluate<string>(
            `document.getElementById('fx-text').value`,
          ),
        ).toBe('')
        expect(
          await tab.evaluate<string>(
            `document.getElementById('fx-status').textContent`,
          ),
        ).toContain('已发送')
        expect(
          await tab.evaluate<string>(
            `document.querySelector('.is-sending .fx-meta').textContent`,
          ),
        ).toBe('已发送')
        expect(
          await tab.evaluate<string>(
            `document.getElementById('fx-thread').textContent`,
          ),
        ).toContain('已确认的消息')
        await tab.evaluate(
          `document.getElementById('fx-composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))`,
        )
        expect(h.chat.sent).toHaveLength(1)
        await tab.evaluate(
          `window.__oldThread = document.getElementById('fx-thread')`,
        )
        // No event arrives: the client tries the refresh again by itself.
        failRefresh = false
        await tab.waitFor(`!document.contains(window.__oldThread)`)
        expect(
          await tab.evaluate<string>(
            `document.getElementById('fx-status').textContent`,
          ),
        ).toBe('')
        expect(
          await tab.evaluate<string>(
            `document.getElementById('fx-text').value`,
          ),
        ).toBe('')
      } finally {
        await tab.close()
        server.stop(true)
      }
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

    test('/app: the welcome sends to the picked agent, recents open in place, the keys reach search, sidebar and panel, and quick entry lands on the conversation', async () => {
      const h = accountsHarness()
      const member = await person(h.handle, 'member')
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: request => h.handle(request),
      })
      const base = `http://127.0.0.1:${server.port}`
      const tab = await browser.tab()
      const press = async (
        key: string,
        code: string,
        vk: number,
        modifiers: number,
      ) => {
        for (const type of ['rawKeyDown', 'keyUp']) {
          await tab.send('Input.dispatchKeyEvent', {
            type,
            key,
            code,
            windowsVirtualKeyCode: vk,
            modifiers,
          })
        }
      }
      try {
        await tab.send('Network.setCookie', {
          name: 'qianmo_session',
          value: member.sid,
          url: base,
          httpOnly: true,
          sameSite: 'Strict',
        })
        await observeChatStream(tab)
        await tab.goto(`${base}/app`)
        await tab.waitFor(`window.__chatStreamOpen === true`)
        expect(
          await tab.evaluate<string>(
            `document.querySelector('[data-greet]').textContent`,
          ),
        ).toMatch(/^(早上好|下午好|晚上好)$/)
        expect(
          await tab.evaluate<string>(
            `document.querySelector('#fx-agent-menu [aria-checked="true"]').getAttribute('data-agent-pick')`,
          ),
        ).toBe(ADDRESS)
        await tab.evaluate(`(() => {
          document.getElementById('fx-text').value = '整理一下今天的告警';
          document.getElementById('fx-composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        })()`)
        await tab.waitFor(
          `location.pathname === '/app' && location.search === '?session=session-1' && document.getElementById('fx-text').value === ''`,
        )
        expect(h.chat.sent.map(input => [input.sessionId, input.text])).toEqual(
          [['session-1', '整理一下今天的告警']],
        )
        await tab.waitFor(
          `!!document.querySelector('#fx-recents .fx-ritem-row.is-current[data-session="session-1"]')`,
        )

        // A new conversation, then back through the recents, without a load.
        await tab.evaluate(`window.__sameDocument = true`)
        await tab.evaluate(
          `document.querySelector('#fx-side [data-action="fx-new"]').click()`,
        )
        await tab.waitFor(`!!document.querySelector('#fx-thread .fx-greet')`)
        await tab.evaluate(
          `document.querySelector('#fx-recents .fx-ritem[data-session="session-1"]').click()`,
        )
        await tab.waitFor(
          `location.search === '?session=session-1' && !document.querySelector('#fx-thread .fx-greet')`,
        )
        expect(
          await tab.evaluate<boolean>(`window.__sameDocument === true`),
        ).toBe(true)

        // ⌘K / Ctrl K, ⌘⇧S / Ctrl Shift S, ⌘. / Ctrl .
        await press('k', 'KeyK', 75, 2)
        await tab.waitFor(
          `document.activeElement && document.activeElement.id === 'fx-search'`,
        )
        await tab.evaluate(`document.activeElement.blur()`)
        await press('S', 'KeyS', 83, 10)
        await tab.waitFor(
          `document.getElementById('fx').getAttribute('data-side') === 'closed'`,
        )
        await press('S', 'KeyS', 83, 10)
        await tab.waitFor(
          `document.getElementById('fx').getAttribute('data-side') === 'open'`,
        )
        const before = await tab.evaluate<string>(
          `document.getElementById('fx-panel-toggle').getAttribute('aria-expanded')`,
        )
        await press('.', 'Period', 190, 2)
        await tab.waitFor(
          `document.getElementById('fx-panel-toggle').getAttribute('aria-expanded') !== ${JSON.stringify(before)}`,
        )

        // Quick entry in a browser: Enter sends and the page goes to the
        // conversation on the 对话 face.
        await tab.goto(`${base}/app/quick`)
        await tab.waitFor(
          `document.activeElement && document.activeElement.id === 'fx-quick-text'`,
        )
        await tab.send('Input.insertText', { text: '查一下各节点的内存' })
        await press('Enter', 'Enter', 13, 0)
        await tab.waitFor(
          `location.pathname === '/app' && location.search === '?session=session-2'`,
          10_000,
        )
        expect(h.chat.sent.map(input => [input.sessionId, input.text])).toEqual(
          [
            ['session-1', '整理一下今天的告警'],
            ['session-2', '查一下各节点的内存'],
          ],
        )
        expect(h.chat.opened).toBe(2)
      } finally {
        await tab.close()
        server.stop(true)
      }
    }, 30_000)

    test('a code block is the reading column wide on /app and the bubble wide on /, and a line after a list stands apart', async () => {
      const harness = pageHarness({ chat: true })
      const chat = new CodeChat()
      void chat.open(ADDRESS)
      const handle = createConsoleHandler({ ...harness.deps, chat }, TOKENS)
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: request => handle(request),
      })
      const base = `http://127.0.0.1:${server.port}`
      const tab = await browser.tab()
      const measure = `(() => {
        const msgs = document.querySelectorAll('#fx-thread .fx-msg-agent');
        const msg = msgs[0];
        const bubble = msg.querySelector('.fx-bubble-agent');
        const pre = bubble.querySelector('.turn-code');
        const long = msgs[msgs.length - 1].querySelector('.turn-code');
        const after = bubble.querySelector('.turn-list + .turn-p');
        const pad = parseFloat(getComputedStyle(bubble).paddingLeft) + parseFloat(getComputedStyle(bubble).paddingRight);
        return {
          msg: msg.getBoundingClientRect().width,
          inner: bubble.getBoundingClientRect().width - pad,
          pre: pre.getBoundingClientRect().width,
          scrolls: long !== pre && long.scrollWidth > long.clientWidth,
          gap: parseFloat(getComputedStyle(after).marginTop),
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      })()`
      try {
        await tab.goto(`${base}/app?session=session-1&token=${ADMIN}`)
        await tab.waitFor(`!!document.querySelector('#fx-thread .turn-code')`)
        const chatFace = await tab.evaluate<{
          msg: number
          inner: number
          pre: number
          scrolls: boolean
          gap: number
          page: number
        }>(measure)
        // The column is 768 wide less its gutters; the block runs across it.
        expect(chatFace.msg).toBeGreaterThan(600)
        expect(Math.abs(chatFace.pre - chatFace.msg)).toBeLessThanOrEqual(1)
        expect(chatFace.scrolls).toBe(true)
        expect(chatFace.page).toBe(0)
        expect(chatFace.gap).toBeGreaterThanOrEqual(16)

        await tab.goto(`${base}/?session=session-1&token=${ADMIN}`)
        await tab.waitFor(`!!document.querySelector('#fx-thread .turn-code')`)
        const agentsFace = await tab.evaluate<typeof chatFace>(measure)
        expect(Math.abs(agentsFace.pre - agentsFace.inner)).toBeLessThanOrEqual(
          1,
        )
        expect(agentsFace.scrolls).toBe(true)
        expect(agentsFace.page).toBe(0)
        expect(agentsFace.gap).toBeGreaterThanOrEqual(12)
      } finally {
        await tab.close()
        server.stop(true)
      }
    }, 30_000)
  },
)
