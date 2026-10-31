// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChatTranscript, ConsoleResult } from '../../src/deps.js'
import { createConsoleHandler } from '../../src/http.js'
import {
  ADDRESS,
  type AccountsHarness,
  CountingChat,
  type Person,
  accountsHarness,
  asSession,
  olderSession,
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

const REVIEWER = 'qianmo://tokyo-1/reviewer'
const REVIEWER_ROW = `document.querySelector('#fx-agents .fx-agent[data-address="${REVIEWER}"]')`

/** The harness with a second agent on the roster: planner is the main one. */
function twoAgents(): AccountsHarness {
  const h = accountsHarness()
  h.chat.moreTargets.push({
    address: REVIEWER,
    node: 'tokyo-1',
    agent: 'reviewer',
    endpoint: 'ws://127.0.0.1:38611/',
    status: 'online',
    dialable: true,
  })
  return h
}

/** `who`'s resident conversations with planner and with reviewer. */
async function residents(
  h: AccountsHarness,
  who: Person,
): Promise<[string, string]> {
  const ids: string[] = []
  for (const target of [ADDRESS, REVIEWER]) {
    const response = await h.handle(
      asSession('POST', '/v0/chat/sessions', who.sid, { body: { target } }),
    )
    expect(response.status).toBe(200)
    ids.push(((await response.json()) as { id: string }).id)
  }
  const [a = '', b = ''] = ids
  return [a, b]
}

/** The view fetch a click on reviewer's row makes. */
function viewsReviewer(request: Request): boolean {
  const url = new URL(request.url)
  return (
    url.pathname === '/fragments/chat/front/view' &&
    url.searchParams.get('agent') === REVIEWER
  )
}

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

    test('sending during a held switch to another agent cannot post into the conversation that is not yet on screen', async () => {
      const h = twoAgents()
      const member = await person(h.handle, 'member')
      const [a, b] = await residents(h, member)
      const gate = Promise.withResolvers<void>()
      const requested = Promise.withResolvers<void>()
      let hold = false
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(request) {
          if (hold && viewsReviewer(request)) {
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
        await tab.goto(`${base}/`)
        await tab.waitFor(`window.__chatStreamOpen === true`)
        hold = true
        await tab.evaluate(`${REVIEWER_ROW}.click()`)
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
      const h = twoAgents()
      const member = await person(h.handle, 'member')
      const [a, b] = await residents(h, member)
      let failB = false
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(request) {
          if (failB && viewsReviewer(request))
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
        await tab.goto(`${base}/`)
        await tab.waitFor(`window.__chatStreamOpen === true`)
        failB = true
        await tab.evaluate(`${REVIEWER_ROW}.click()`)
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
        await tab.evaluate(`${REVIEWER_ROW}.click()`)
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

    test('a burst of stream events reads the conversation once, and an answer that changed nothing is not swapped in', async () => {
      const h = accountsHarness()
      // The transcript is the lines sent, so the thread grows with them.
      const read = h.chat.transcript.bind(h.chat)
      h.chat.transcript = async (sessionId: string) => {
        const got = await read(sessionId)
        if (!got.ok) return got
        const turns = h.chat.sent
          .filter(input => input.sessionId === sessionId)
          .map((input, i) => ({
            id: `line-${i}`,
            sessionId,
            author: 'operator' as const,
            at: NOW - 60_000 + i * 1_000,
            text: input.text,
            state: 'read' as const,
          }))
        return { ok: true, value: { session: got.value.session, turns } }
      }
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
      const views = () =>
        seen.filter(path => path === '/fragments/chat/front/view/session-1')
          .length
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
        document.getElementById('fx-text').value = '检查节点运行状态';
        document.getElementById('fx-composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()`)
        await tab.waitFor(
          `document.getElementById('fx-thread').getAttribute('data-session') === 'session-1' && document.getElementById('fx-text').value === ''`,
        )
        // Whatever the send set going has settled.
        await new Promise(resolve => setTimeout(resolve, 800))
        await tab.evaluate(
          `window.__thread = document.getElementById('fx-thread'); window.__side = document.getElementById('fx-stack')`,
        )
        const before = views()
        for (let i = 0; i < 5; i++) h.chat.emit('session-1')
        await new Promise(resolve => setTimeout(resolve, 900))
        expect(views() - before).toBe(1)
        expect(
          await tab.evaluate<unknown>(`({
            thread: document.getElementById('fx-thread') === window.__thread,
            side: document.getElementById('fx-stack') === window.__side,
          })`),
        ).toEqual({ thread: true, side: true })
        // A second line: the thread is brought up to date in place, the
        // entries that were there left as they were.
        await tab.evaluate(
          `window.__first = document.querySelector('#fx-thread .fx-msgs > .fx-sep')`,
        )
        await tab.evaluate(`(() => {
        document.getElementById('fx-text').value = '再看一下磁盘';
        document.getElementById('fx-composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()`)
        await tab.waitFor(
          `document.querySelectorAll('#fx-thread .fx-msgs > .fx-msg-user').length === 2 && !document.querySelector('#fx-thread .fx-msg-user.is-sending')`,
        )
        expect(
          await tab.evaluate<unknown>(`({
            thread: document.getElementById('fx-thread') === window.__thread,
            first: !!window.__first && document.querySelector('#fx-thread .fx-msgs > .fx-sep') === window.__first,
            texts: [...document.querySelectorAll('#fx-thread .fx-msg-user .fx-bubble')].map(n => n.textContent),
          })`),
        ).toEqual({
          thread: true,
          first: true,
          texts: ['检查节点运行状态', '再看一下磁盘'],
        })
      } finally {
        await tab.close()
        server.stop(true)
      }
    }, 30_000)

    test('a stream event just before a move does not read over the conversation opened', async () => {
      const h = twoAgents()
      const member = await person(h.handle, 'member')
      const [planner] = await residents(h, member)
      const views: string[] = []
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        idleTimeout: 0,
        fetch(request) {
          const url = new URL(request.url)
          if (url.pathname.startsWith('/fragments/chat/front/view'))
            views.push(url.pathname + url.search)
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
        // The move comes 20 ms after the event: inside the 150 ms in which
        // the page gathers a step's events into one read.
        await tab.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `window.__moveOnChat = false;
            const Before = window.EventSource;
            window.EventSource = class extends Before {
              constructor(url, options) {
                super(url, options);
                this.addEventListener('chat', () => {
                  if (!window.__moveOnChat) return;
                  window.__moveOnChat = false;
                  setTimeout(() => ${REVIEWER_ROW}.click(), 20);
                });
              }
            };`,
        })
        await tab.goto(`${base}/?session=${planner}`)
        await tab.waitFor(
          `window.__chatStreamOpen === true && document.getElementById('fx-thread').getAttribute('data-session') === ${JSON.stringify(planner)}`,
        )
        await new Promise(resolve => setTimeout(resolve, 500))
        views.length = 0
        await tab.evaluate('window.__moveOnChat = true')
        h.chat.emit(planner)
        await tab.waitFor(
          `document.getElementById('fx-thread').getAttribute('data-target') === ${JSON.stringify(REVIEWER)}`,
        )
        await new Promise(resolve => setTimeout(resolve, 600))
        // The opening's read, and no read in the background after it.
        expect(views.filter(view => view.includes('open=1')).length).toBe(1)
        expect(views.filter(view => !view.includes('open=1'))).toEqual([])
      } finally {
        await tab.close()
        server.stop(true)
      }
    }, 30_000)

    test('a first line that did not go, and a redraw that failed with it, leave the welcome to come back', async () => {
      const h = accountsHarness()
      const member = await person(h.handle, 'member')
      let refuse = false
      let failViews = 0
      let views = 0
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        idleTimeout: 0,
        fetch(request) {
          const url = new URL(request.url)
          if (
            refuse &&
            request.method === 'POST' &&
            url.pathname.startsWith('/v0/chat/sessions')
          ) {
            return new Response('{"error":{"code":"down","message":"down"}}', {
              status: 503,
              headers: { 'content-type': 'application/json' },
            })
          }
          if (url.pathname.startsWith('/fragments/chat/front/view')) {
            views += 1
            if (failViews > 0) {
              failViews -= 1
              return new Response('', { status: 503 })
            }
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
        await observeChatStream(tab)
        await tab.goto(`${base}/`)
        await tab.waitFor(`window.__chatStreamOpen === true`)
        // A redraw in the background first: the page now knows this welcome.
        let before = views
        await tab.evaluate(
          `document.dispatchEvent(new CustomEvent('qianmo:faces'))`,
        )
        while (views === before)
          await new Promise(resolve => setTimeout(resolve, 20))
        await new Promise(resolve => setTimeout(resolve, 300))
        const welcome = await tab.evaluate<string>(
          `document.getElementById('fx-thread').innerHTML`,
        )
        expect(welcome.length).toBeGreaterThan(0)
        // The line does not go, and the redraw after it fails too.
        refuse = true
        failViews = 1
        await tab.evaluate(`(() => {
        document.getElementById('fx-text').value = '检查节点运行状态';
        document.getElementById('fx-composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()`)
        await tab.waitFor(
          `document.getElementById('fx-status').textContent !== ''`,
        )
        await tab.waitFor(
          `document.getElementById('fx-text').value === '检查节点运行状态'`,
        )
        while (failViews > 0)
          await new Promise(resolve => setTimeout(resolve, 20))
        refuse = false
        // The next redraw brings the welcome back, the same as before.
        before = views
        await tab.evaluate(
          `document.dispatchEvent(new CustomEvent('qianmo:faces'))`,
        )
        while (views === before)
          await new Promise(resolve => setTimeout(resolve, 20))
        await tab.waitFor(
          `document.getElementById('fx-thread').innerHTML === ${JSON.stringify(welcome)}`,
        )
      } finally {
        await tab.close()
        server.stop(true)
      }
    }, 30_000)

    test('a line that does not go stays as 未送达 even when the thread was brought up to date while it was on its way', async () => {
      const h = accountsHarness()
      // What the agent has said: the transcript.
      const said: string[] = []
      const read = h.chat.transcript.bind(h.chat)
      h.chat.transcript = async (sessionId: string) => {
        const got = await read(sessionId)
        if (!got.ok) return got
        const turns = said.map((text, i) => ({
          id: `agent-${i}`,
          sessionId,
          author: 'agent' as const,
          at: NOW - 30_000 + i * 1_000,
          text,
          state: 'done' as const,
        }))
        return { ok: true, value: { session: got.value.session, turns } }
      }
      const member = await person(h.handle, 'member')
      let slow = false
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        idleTimeout: 0,
        async fetch(request) {
          const url = new URL(request.url)
          if (
            slow &&
            request.method === 'POST' &&
            /\/messages$/.test(url.pathname)
          ) {
            await new Promise(resolve => setTimeout(resolve, 700))
            return new Response('{"error":{"code":"down","message":"down"}}', {
              status: 503,
              headers: { 'content-type': 'application/json' },
            })
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
        await observeChatStream(tab)
        await tab.goto(`${base}/`)
        await tab.waitFor(`window.__chatStreamOpen === true`)
        const say = (text: string) =>
          tab.evaluate(`(() => {
          document.getElementById('fx-text').value = ${JSON.stringify(text)};
          document.getElementById('fx-composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        })()`)
        await say('检查节点运行状态')
        await tab.waitFor(
          `document.getElementById('fx-thread').getAttribute('data-session') === 'session-1' && document.getElementById('fx-text').value === ''`,
        )
        await new Promise(resolve => setTimeout(resolve, 500))
        slow = true
        await say('再看一下磁盘')
        await tab.waitFor(
          `!!document.querySelector('#fx-thread .fx-msg-user.is-sending')`,
        )
        // While it is on its way, the agent says something: the thread is
        // read again and brought up to date, the line not yet in it.
        said.push('先看了一下')
        h.chat.emit('session-1')
        await tab.waitFor(
          `document.getElementById('fx-thread').textContent.includes('先看了一下')`,
        )
        await tab.waitFor(
          `[...document.querySelectorAll('#fx-thread .fx-msg-user.is-failed')].some(m => m.textContent.includes('再看一下磁盘') && m.textContent.includes('未送达'))`,
          5_000,
        )
      } finally {
        await tab.close()
        server.stop(true)
      }
    }, 30_000)

    test('a stream event for the conversation being opened waits for the opening, not read over it', async () => {
      const h = twoAgents()
      const member = await person(h.handle, 'member')
      const [planner, reviewer] = await residents(h, member)
      const reads: { open: boolean; start: number; end: number }[] = []
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        idleTimeout: 0,
        async fetch(request) {
          const url = new URL(request.url)
          if (url.pathname !== `/fragments/chat/front/view/${reviewer}`)
            return h.handle(request)
          const read = {
            open: url.searchParams.get('open') === '1',
            start: Date.now(),
            end: 0,
          }
          reads.push(read)
          // The opening takes a while: the stream's event lands meanwhile.
          if (read.open) await new Promise(resolve => setTimeout(resolve, 500))
          const answer = await h.handle(request)
          read.end = Date.now()
          return answer
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
        await tab.goto(`${base}/?session=${planner}`)
        await tab.waitFor(
          `window.__chatStreamOpen === true && document.getElementById('fx-thread').getAttribute('data-session') === ${JSON.stringify(planner)}`,
        )
        await new Promise(resolve => setTimeout(resolve, 400))
        // Opened as a row of the list opens it.
        await tab.evaluate(`(() => {
          const row = document.createElement('button');
          row.type = 'button';
          row.setAttribute('data-action', 'fx-open');
          row.setAttribute('data-session', ${JSON.stringify(reviewer)});
          document.body.appendChild(row);
          row.click();
          row.remove();
        })()`)
        await new Promise(resolve => setTimeout(resolve, 30))
        h.chat.emit(reviewer)
        await tab.waitFor(
          `document.getElementById('fx-thread').getAttribute('data-session') === ${JSON.stringify(reviewer)}`,
        )
        await new Promise(resolve => setTimeout(resolve, 700))
        const opening = reads.find(read => read.open)
        expect(opening?.end).toBeGreaterThan(0)
        // Every read in the background began once the opening was answered.
        expect(
          reads.filter(read => !read.open && read.start < (opening?.end ?? 0)),
        ).toEqual([])
      } finally {
        await tab.close()
        server.stop(true)
      }
    }, 30_000)

    test('a stream the hub refused is opened again, and the polling stops once it is', async () => {
      const h = accountsHarness()
      const member = await person(h.handle, 'member')
      let streams = 0
      const views: number[] = []
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        idleTimeout: 0,
        fetch(request) {
          const path = new URL(request.url).pathname
          if (path === '/v0/chat/stream') {
            streams += 1
            // A hub restarting behind a proxy: the first answer is the proxy's.
            if (streams === 1)
              return new Response('bad gateway', { status: 502 })
          }
          if (path.startsWith('/fragments/chat/front/view'))
            views.push(Date.now())
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
        await tab.goto(`${base}/`)
        // Refused: polling meanwhile, and after five seconds a new stream.
        await tab.waitFor(
          `document.getElementById('fx-live').textContent !== ''`,
        )
        await tab.waitFor(`window.__chatStreamOpen === true`, 9_000)
        expect(streams).toBe(2)
        await tab.waitFor(
          `document.getElementById('fx-live').textContent === ''`,
        )
        const at = Date.now()
        await new Promise(resolve => setTimeout(resolve, 3_000))
        // No poll after the stream opened (one catch-up read at most).
        expect(views.filter(t => t > at).length).toBe(0)
      } finally {
        await tab.close()
        server.stop(true)
      }
    }, 30_000)

    test('the box grows with its lines, shrinks back when they go, stops at 240 px and is one line empty', async () => {
      const h = accountsHarness()
      const member = await person(h.handle, 'member')
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: request => h.handle(request),
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
        await tab.goto(`${base}/`)
        await tab.waitFor(`!!document.getElementById('fx-text')`)
        const at = (value: string) =>
          tab.evaluate<number>(`(() => {
            const b = document.getElementById('fx-text');
            b.value = ${JSON.stringify(value)};
            b.dispatchEvent(new Event('input', { bubbles: true }));
            return Math.round(b.getBoundingClientRect().height);
          })()`)
        const one = await at('一')
        let text = '一'
        const heights: number[] = []
        for (let i = 2; i <= 4; i++) {
          text += `\n第 ${i} 行`
          heights.push(await at(text))
        }
        expect(heights[0]).toBeGreaterThan(one)
        expect(heights[1]).toBeGreaterThan(heights[0]!)
        expect(heights[2]).toBeGreaterThan(heights[1]!)
        // Deleted back to one line: one line high again.
        expect(await at('一')).toBe(one)
        // Four lines, then one longer line pasted over all of them.
        await at(text)
        expect(await at('x'.repeat(text.length + 4))).toBe(one)
        // Wrapped in a narrow box, then the box widened (a panel closed
        // beside it, no window resize): typing on fits it to one line again.
        await tab.evaluate(
          `document.getElementById('fx-text').style.width = '120px'`,
        )
        const long = '一句不换行但在窄框里会折行的话'
        expect(await at(long)).toBeGreaterThan(one)
        await tab.evaluate(
          `document.getElementById('fx-text').style.width = ''`,
        )
        expect(await at(`${long}。`)).toBe(one)
        expect(await at('一\n'.repeat(40))).toBeLessThanOrEqual(240 + 2)
        expect(await at('')).toBeLessThanOrEqual(one)
        expect(
          await tab.evaluate<string>(
            `document.getElementById('fx-text').style.height`,
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
        // The main agent's conversation is the page's own: no query.
        await tab.waitFor(
          `location.search === '' && document.getElementById('fx-thread').getAttribute('data-session') === 'session-1' && document.getElementById('fx-text').value === ''`,
        )
        expect(
          await tab.evaluate<string | null>(
            `document.getElementById('fx-thread').getAttribute('data-resident')`,
          ),
        ).toBe('1')
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

    test('/app: the welcome sends to the picked agent, an older conversation is under ⋯ and read only, the keys reach search, sidebar and panel, and quick entry lands on the conversation', async () => {
      const h = twoAgents()
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
      const row = `#fx-agents .fx-agent-row[data-address="${ADDRESS}"]`
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
        // No new-conversation entry: talking to a bot is picking it.
        expect(
          await tab.evaluate<number>(
            `document.querySelectorAll('[data-action="fx-new"], [data-action="fx-agent-new"], #fx-top-new').length`,
          ),
        ).toBe(0)
        await tab.evaluate(`(() => {
          document.getElementById('fx-text').value = '整理一下今天的告警';
          document.getElementById('fx-composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        })()`)
        await tab.waitFor(
          `location.pathname === '/app' && location.search === '' && document.getElementById('fx-thread').getAttribute('data-session') === 'session-1' && document.getElementById('fx-text').value === ''`,
        )
        expect(h.chat.sent.map(input => [input.sessionId, input.text])).toEqual(
          [['session-1', '整理一下今天的告警']],
        )
        // The agent's row is that conversation; the dated list under it
        // holds only work that is not with a bot, and there is none yet.
        await tab.waitFor(
          `!!document.querySelector('${row}.is-current[data-latest="session-1"]')`,
        )
        expect(
          await tab.evaluate<number>(
            `document.querySelectorAll('#fx-recents .fx-ritem-row:not([hidden])').length`,
          ),
        ).toBe(0)

        // A conversation from before: under the agent's ⋯, 其他对话, read
        // only, and one click back to the agent — all without a load.
        const older = await olderSession(h, member)
        const reviewers = await olderSession(h, member, REVIEWER)
        h.chat.emit(older)
        await tab.waitFor(
          `!!document.querySelector('${row} [data-action="fx-others"]')`,
        )
        await tab.evaluate(`window.__sameDocument = true`)
        await tab.evaluate(
          `document.querySelector('${row} .fx-more-btn').click()`,
        )
        await tab.evaluate(
          `document.querySelector('${row} [data-action="fx-others"]').click()`,
        )
        await tab.waitFor(`document.getElementById('fx-others').open`)
        expect(
          await tab.evaluate<string[]>(
            `[...document.querySelectorAll('#fx-others .fx-hitem')].filter(el => el.getClientRects().length > 0).map(el => el.getAttribute('data-session'))`,
          ),
        ).toEqual([older])
        // 全部: every other conversation, reviewer's too.
        await tab.evaluate(
          `document.querySelector('#fx-others [data-action="fx-scope"][data-scope="all"]').click()`,
        )
        expect(
          await tab.evaluate<string[]>(
            `[...document.querySelectorAll('#fx-others .fx-hitem')].filter(el => el.getClientRects().length > 0).map(el => el.getAttribute('data-session')).sort()`,
          ),
        ).toEqual([older, reviewers].sort())
        await tab.evaluate(
          `document.querySelector('#fx-others .fx-hitem[data-session="${older}"]').click()`,
        )
        await tab.waitFor(
          `location.search === '?session=${older}' && document.getElementById('fx-thread').getAttribute('data-readonly') === '1' && !document.getElementById('fx-others').open`,
        )
        expect(
          await tab.evaluate<[boolean, string, string]>(
            `[document.getElementById('fx-text').disabled, document.querySelector('.fx-readonly-word').textContent, document.querySelector('.fx-readonly [data-action="fx-agent"]').textContent]`,
          ),
        ).toEqual([true, '只读', '回到 planner'])
        await tab.evaluate(
          `document.querySelector('.fx-readonly [data-action="fx-agent"]').click()`,
        )
        await tab.waitFor(
          `location.search === '' && document.getElementById('fx-thread').getAttribute('data-session') === 'session-1' && !document.getElementById('fx-text').disabled`,
        )
        // ⌘⇧O / Ctrl Shift O (a browser keeps ⌘N): a new task, from
        // wherever the reader is (P37.17 B, work-tasks.md §9.1).
        await tab.evaluate(
          `document.querySelector('#fx-history .fx-hitem[data-session="${older}"]').click()`,
        )
        await tab.waitFor(
          `document.getElementById('fx-thread').getAttribute('data-readonly') === '1'`,
        )
        await press('O', 'KeyO', 79, 10)
        await tab.waitFor(
          `location.search === '?work=new' && document.getElementById('fx-thread').getAttribute('data-new-work') === '1' && !document.getElementById('fx-text').disabled`,
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
        // The agent's conversation again, not a new one.
        await tab.waitFor(
          `location.pathname === '/app' && location.search === '?session=session-1'`,
          10_000,
        )
        await tab.waitFor(
          `document.getElementById('fx-thread').getAttribute('data-resident') === '1' && !document.getElementById('fx-text').disabled`,
        )
        expect(h.chat.sent.map(input => [input.sessionId, input.text])).toEqual(
          [
            ['session-1', '整理一下今天的告警'],
            ['session-1', '查一下各节点的内存'],
          ],
        )
        // The resident one and the two older ones; quick entry opened none.
        expect(h.chat.opened).toBe(3)
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
