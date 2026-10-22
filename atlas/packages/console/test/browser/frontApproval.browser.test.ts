// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The front's approval cards in a real browser (P40 §6, §8): a request for
 * the conversation on screen is a card at the end of the thread; 批准 goes
 * straight out on the login session (no credential step since 2026-10-22),
 * continues the work when the agent's turn has ended (批准并继续) and is
 * allow-once while the turn still runs or for a tool the node approves fresh
 * every time; 拒绝 sends deny; a refused decision says why in the card; a
 * decided card goes on the next poll; a request elsewhere is one line above
 * the composer that switches to its conversation; and a member sees a change
 * that needs ops without buttons.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChatTranscript, ConsoleResult } from '../../src/deps.js'
import type { ApprovalItem, ApprovalPort } from '../../src/governance.js'
import {
  ADDRESS,
  accountsHarness,
  asSession,
  CountingChat,
  person,
  START,
} from '../accountsHarness.js'
import { Browser, skipReason, type Tab } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[front approval browser] skipped: ${SKIP}`)

interface Decision {
  readonly requestId: string
  readonly digest: string
  readonly decision: string
  readonly credential: string
}

/** What the hub answers for a request in `refuse`. */
const REFUSED = '审批请求已变化或失效'

/**
 * Requests that wait on whoever asks, and the decisions they get. A request
 * in `refuse` is refused the way the hub refuses one, and is not counted.
 */
function approvals(
  items: ApprovalItem[],
  refuse: ReadonlySet<string> = new Set(),
): {
  readonly port: ApprovalPort
  readonly decisions: Decision[]
} {
  const decisions: Decision[] = []
  const refused = {
    ok: false,
    failure: { code: 'refused', message: REFUSED },
  } as const
  const port: ApprovalPort = {
    async list(principal) {
      return {
        ok: true,
        value: items.map(one => ({ ...one, owner: principal.subject })),
      }
    },
    async decide(principal, input) {
      if (refuse.has(input.requestId)) return refused
      decisions.push({
        requestId: input.requestId,
        digest: input.digest,
        decision: input.decision,
        credential: principal.credential,
      })
      const at = items.findIndex(one => one.requestId === input.requestId)
      const found = items[at]
      if (found !== undefined)
        items[at] = {
          ...found,
          status: input.decision === 'deny' ? 'denied' : 'allowed',
        }
      return { ok: true, value: { delivered: true } }
    },
    async continue(principal, input) {
      if (refuse.has(input.requestId)) return refused
      decisions.push({
        requestId: input.requestId,
        digest: input.digest,
        decision: 'continue',
        credential: principal.credential,
      })
      const at = items.findIndex(one => one.requestId === input.requestId)
      const found = items[at]
      if (found !== undefined)
        items[at] = { ...found, status: 'allowed', continuation: 'sent' }
      return {
        ok: true,
        value: { sessionId: found?.contextId ?? '', taskId: 'continued' },
      }
    },
    async revoke() {
      return { ok: true, value: { delivered: true } }
    },
  }
  return { port, decisions }
}

/** A chat whose listed sessions have the person's line still unanswered. */
class RunningChat extends CountingChat {
  readonly running = new Set<string>()

  override async transcript(
    sessionId: string,
  ): Promise<ConsoleResult<ChatTranscript>> {
    const read = await super.transcript(sessionId)
    if (!read.ok || !this.running.has(sessionId)) return read
    return {
      ok: true,
      value: {
        ...read.value,
        turns: [
          {
            id: `asked-${sessionId}`,
            sessionId,
            author: 'operator',
            at: START,
            text: '把默认模型服务换成 Claude 网关',
            state: 'read',
            taskId: 'task-running',
          },
        ],
      },
    }
  }
}

function request(
  requestId: string,
  contextId: string,
  toolName: string,
  input: Record<string, unknown>,
  at = 0,
): ApprovalItem {
  return {
    requestId,
    node: 'tokyo-1',
    agent: ADDRESS,
    contextId,
    owner: null,
    toolName,
    input,
    digest: `digest-${requestId}`,
    createdAt: START + at,
    expiresAt: START + 600_000,
    status: 'pending',
  }
}

function change(role: 'ops' | 'member'): Record<string, unknown> {
  return {
    id: 'providers.default',
    target: null,
    input: { profileId: 'claude-gateway' },
    card: {
      area: '模型',
      label: '默认模型服务',
      title: '把默认模型服务改成 Claude 网关',
      current: 'DeepSeek',
      next: 'Claude 网关',
      role,
      page: '/admin/providers#routing',
    },
  }
}

describe.skipIf(SKIP !== null)('approval cards on the front', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await Browser.launch()
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
  }, 30_000)

  async function open(tab: Tab, base: string, sid: string, path: string) {
    await tab.send('Network.setCookie', {
      name: 'qianmo_session',
      value: sid,
      url: base,
      httpOnly: true,
      sameSite: 'Strict',
    })
    await tab.goto(`${base}${path}`)
  }

  test('the card is in the thread; on an idle conversation 批准 continues at once, 拒绝 sends deny; the line leads to the other conversation', async () => {
    const items: ApprovalItem[] = []
    const { port, decisions } = approvals(items)
    const h = accountsHarness({ deps: { approvals: port } })
    const ops = await person(h.handle, 'ops')
    const ids: string[] = []
    for (let i = 0; i < 2; i++) {
      const opened = await h.handle(
        asSession('POST', '/v0/chat/sessions', ops.sid, {
          body: { target: ADDRESS },
        }),
      )
      ids.push(((await opened.json()) as { id: string }).id)
    }
    const [a = '', b = ''] = ids
    items.push(
      request('set-1', a, 'qianmo_settings_change', change('ops')),
      request(
        'cal-1',
        a,
        'qianmo_calendar_create',
        {
          connectorId: 'c1',
          title: '发版评审',
          start: '2026-10-22T10:00:00+08:00',
          end: '2026-10-22T11:00:00+08:00',
        },
        5,
      ),
      request(
        'mail-1',
        b,
        'qianmo_mail_send',
        { connectorId: 'c1', to: 'a@example.com', subject: '周报', body: 'x' },
        10,
      ),
    )
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: req => h.handle(req),
    })
    const base = `http://127.0.0.1:${server.port}`
    const tab = await browser.tab()
    try {
      await open(tab, base, ops.sid, `/?session=${a}`)
      await tab.waitFor(
        `document.querySelectorAll('#fx-asks .fx-ask').length === 2`,
      )
      const first = await tab.evaluate<{
        afterThread: boolean
        title: string
        what: string
        rows: string[]
        link: string | null
        tag: string
        face: boolean
        buttons: string[]
        focused: boolean
      }>(`(() => {
        const card = document.querySelector('#fx-asks .fx-ask[data-request="set-1"]');
        return {
          afterThread: document.getElementById('fx-thread').nextElementSibling === document.getElementById('fx-asks'),
          title: card.querySelector('.fx-ask-title').textContent,
          what: card.querySelector('.fx-ask-what').textContent,
          rows: [...card.querySelectorAll('.fx-ask-rows dt, .fx-ask-rows dd')].map(el => el.textContent),
          link: card.querySelector('.fx-ask-link') && card.querySelector('.fx-ask-link').getAttribute('href'),
          tag: card.querySelector('.fx-ask-tag').textContent,
          face: !!card.querySelector('.fx-ask-face svg.avatar'),
          buttons: [...card.querySelectorAll('[data-ask-choice]')].map(el => el.getAttribute('data-ask-choice') + ':' + el.textContent),
          focused: !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('#fx-asks')),
        };
      })()`)
      expect(first).toEqual({
        afterThread: true,
        title: 'planner 想更改设置',
        what: '模型 · 默认模型服务',
        rows: ['现在', 'DeepSeek', '改为', 'Claude 网关'],
        link: '/admin/providers#routing',
        tag: '需要运维',
        face: true,
        buttons: ['deny:拒绝', 'allow-once:批准'],
        focused: false,
      })
      expect(
        await tab.evaluate<string>(
          `document.getElementById('fx-asks').textContent`,
        ),
      ).not.toContain('claude-gateway')
      // The other conversation's request: one line, leading there.
      await tab.waitFor(`!document.getElementById('fx-ask-bar').hidden`)
      expect(
        await tab.evaluate<string[]>(`(() => {
          const go = document.getElementById('fx-ask-bar-go');
          return [document.getElementById('fx-ask-bar-text').textContent, go.getAttribute('href'), go.getAttribute('data-session')];
        })()`),
      ).toEqual(['另一个对话有 1 项待你批准', `/?session=${b}`, b])

      // A redraw of the thread leaves the card alone.
      await tab.evaluate(`(() => {
        window.__card = document.querySelector('.fx-ask[data-request="set-1"]');
        window.__viewed = false;
        document.addEventListener('qianmo:front-view', () => { window.__viewed = true; }, { once: true });
      })()`)
      h.chat.emit(a)
      await tab.waitFor(`window.__viewed === true`)
      expect(
        await tab.evaluate<boolean>(
          `document.querySelector('.fx-ask[data-request="set-1"]') === window.__card && window.__card.querySelector('input, form') === null`,
        ),
      ).toBe(true)
      // 批准 goes straight out on the login session: nothing asks first.
      await tab.evaluate(
        `document.querySelector('.fx-ask[data-request="set-1"] [data-ask-choice="allow-once"]').click()`,
      )
      await tab.waitFor(
        `document.querySelector('.fx-ask[data-request="set-1"]').classList.contains('is-done')`,
      )
      // The agent's turn here has ended (nothing unanswered): 批准 is
      // 批准并继续, with the digest and nothing else.
      expect(decisions).toEqual([
        {
          requestId: 'set-1',
          digest: 'digest-set-1',
          decision: 'continue',
          credential: 'session',
        },
      ])
      expect(
        await tab.evaluate<string[]>(`(() => {
          const card = document.querySelector('.fx-ask[data-request="set-1"]');
          return [card.querySelector('.fx-ask-status').textContent, String(card.querySelectorAll('[data-ask-choice]').length)];
        })()`),
      ).toEqual(['已批准 · 正在继续', '0'])
      // Gone on the next poll.
      await tab.waitFor(
        `document.querySelector('.fx-ask[data-request="set-1"]') === null`,
        8_000,
      )

      // 拒绝 on the next card, the same way.
      await tab.evaluate(
        `document.querySelector('.fx-ask[data-request="cal-1"] [data-ask-choice="deny"]').click()`,
      )
      await tab.waitFor(
        `document.querySelector('.fx-ask[data-request="cal-1"] .fx-ask-status').textContent === '已拒绝'`,
      )
      expect(decisions[1]).toEqual({
        requestId: 'cal-1',
        digest: 'digest-cal-1',
        decision: 'deny',
        credential: 'session',
      })
      await tab.waitFor(
        `document.querySelector('#fx-asks .fx-ask') === null && document.getElementById('fx-asks').hidden`,
        8_000,
      )

      // The line opens the other conversation in place; its card is there.
      await tab.evaluate(`document.getElementById('fx-ask-bar-go').click()`)
      await tab.waitFor(
        `document.getElementById('fx-thread').getAttribute('data-session') === ${JSON.stringify(b)} && document.querySelector('.fx-ask[data-request="mail-1"]') !== null`,
      )
      expect(
        await tab.evaluate<boolean>(
          `document.getElementById('fx-ask-bar').hidden`,
        ),
      ).toBe(true)
      expect(
        await tab.evaluate<string>(
          `document.querySelector('.fx-ask[data-request="mail-1"] .fx-ask-title').textContent`,
        ),
      ).toBe('planner 想发送邮件')
      // Enter approves only on a focused 批准. Mail is approved fresh on
      // every call, so on this idle conversation it stays allow-once.
      await tab.evaluate(
        `document.querySelector('.fx-ask[data-request="mail-1"] [data-ask-choice="allow-once"]').focus()`,
      )
      for (const type of ['keyDown', 'keyUp'])
        await tab.send('Input.dispatchKeyEvent', {
          type,
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          ...(type === 'keyDown' ? { text: '\r' } : {}),
        })
      await tab.waitFor(
        `document.querySelector('.fx-ask[data-request="mail-1"]').classList.contains('is-done')`,
      )
      expect(decisions[2]).toEqual({
        requestId: 'mail-1',
        digest: 'digest-mail-1',
        decision: 'allow-once',
        credential: 'session',
      })
      expect(decisions).toHaveLength(3)
    } finally {
      await tab.close()
      server.stop(true)
    }
  }, 40_000)

  test('while the agent turn runs 批准 is allow-once; once it has ended the next 批准 continues', async () => {
    const items: ApprovalItem[] = []
    const { port, decisions } = approvals(items)
    const chat = new RunningChat()
    const h = accountsHarness({ deps: { approvals: port, chat } })
    const ops = await person(h.handle, 'ops')
    const opened = await h.handle(
      asSession('POST', '/v0/chat/sessions', ops.sid, {
        body: { target: ADDRESS },
      }),
    )
    const { id: a } = (await opened.json()) as { id: string }
    chat.running.add(a)
    items.push(
      request('run-1', a, 'qianmo_settings_change', change('ops')),
      request('run-2', a, 'qianmo_settings_change', change('ops'), 5),
    )
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: req => h.handle(req),
    })
    const base = `http://127.0.0.1:${server.port}`
    const tab = await browser.tab()
    try {
      await open(tab, base, ops.sid, `/?session=${a}`)
      await tab.waitFor(
        `document.querySelectorAll('#fx-asks .fx-ask').length === 2 && document.getElementById('fx-thread').getAttribute('data-running') === '1'`,
      )
      await tab.evaluate(
        `document.querySelector('.fx-ask[data-request="run-1"] [data-ask-choice="allow-once"]').click()`,
      )
      await tab.waitFor(
        `document.querySelector('.fx-ask[data-request="run-1"] .fx-ask-status').textContent === '已批准'`,
      )
      expect(decisions).toEqual([
        {
          requestId: 'run-1',
          digest: 'digest-run-1',
          decision: 'allow-once',
          credential: 'session',
        },
      ])
      // The node stopped waiting and the turn ended: the thread says so.
      chat.running.delete(a)
      chat.emit(a)
      await tab.waitFor(
        `document.getElementById('fx-thread').getAttribute('data-running') === null`,
      )
      await tab.evaluate(
        `document.querySelector('.fx-ask[data-request="run-2"] [data-ask-choice="allow-once"]').click()`,
      )
      await tab.waitFor(
        `document.querySelector('.fx-ask[data-request="run-2"] .fx-ask-status').textContent === '已批准 · 正在继续'`,
      )
      expect(decisions[1]).toEqual({
        requestId: 'run-2',
        digest: 'digest-run-2',
        decision: 'continue',
        credential: 'session',
      })
      expect(decisions).toHaveLength(2)
    } finally {
      await tab.close()
      server.stop(true)
    }
  }, 30_000)

  test('a member sees a change that needs ops without buttons, and it is not counted as waiting on them; a refused decision says why in the card', async () => {
    const items: ApprovalItem[] = []
    const { port, decisions } = approvals(items, new Set(['mine-1']))
    const h = accountsHarness({ deps: { approvals: port } })
    const member = await person(h.handle, 'member')
    const ids: string[] = []
    for (let i = 0; i < 2; i++) {
      const opened = await h.handle(
        asSession('POST', '/v0/chat/sessions', member.sid, {
          body: { target: ADDRESS },
        }),
      )
      ids.push(((await opened.json()) as { id: string }).id)
    }
    const [a = '', b = ''] = ids
    items.push(
      request('ops-1', a, 'qianmo_settings_change', change('ops')),
      request('mine-1', a, 'qianmo_settings_change', change('member'), 5),
      request('ops-2', b, 'qianmo_settings_change', change('ops'), 10),
    )
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: req => h.handle(req),
    })
    const base = `http://127.0.0.1:${server.port}`
    const tab = await browser.tab()
    try {
      await open(tab, base, member.sid, `/?session=${a}`)
      await tab.waitFor(
        `document.querySelectorAll('#fx-asks .fx-ask').length === 2`,
      )
      expect(
        await tab.evaluate<{
          ops: string[]
          note: string
          tag: boolean
          mine: string[]
          bar: boolean
        }>(`(() => {
          const ops = document.querySelector('.fx-ask[data-request="ops-1"]');
          const mine = document.querySelector('.fx-ask[data-request="mine-1"]');
          const buttons = card => [...card.querySelectorAll('[data-ask-choice]')].map(el => el.getAttribute('data-ask-choice'));
          return {
            ops: buttons(ops),
            note: ops.querySelector('.fx-ask-note').textContent,
            tag: !!ops.querySelector('.fx-ask-tag'),
            mine: buttons(mine),
            bar: document.getElementById('fx-ask-bar').hidden,
          };
        })()`),
      ).toEqual({
        ops: [],
        note: '需要运维批准',
        tag: false,
        mine: ['deny', 'allow-once'],
        bar: true,
      })
      // The hub refuses: the card says why, asks for nothing, and can be
      // tried again.
      await tab.evaluate(
        `document.querySelector('.fx-ask[data-request="mine-1"] [data-ask-choice="allow-once"]').click()`,
      )
      await tab.waitFor(
        `document.querySelector('.fx-ask[data-request="mine-1"] .fx-ask-status').textContent !== ''`,
      )
      expect(
        await tab.evaluate<{
          status: string
          fields: number
          done: boolean
          enabled: boolean
        }>(`(() => {
          const card = document.querySelector('.fx-ask[data-request="mine-1"]');
          return {
            status: card.querySelector('.fx-ask-status').textContent,
            fields: card.querySelectorAll('input, form').length,
            done: card.classList.contains('is-done'),
            enabled: [...card.querySelectorAll('[data-ask-choice]')].every(el => !el.disabled),
          };
        })()`),
      ).toEqual({
        status: `没有完成 · 稍后再试 · ${REFUSED}`,
        fields: 0,
        done: false,
        enabled: true,
      })
      expect(decisions).toEqual([])
    } finally {
      await tab.close()
      server.stop(true)
    }
  }, 30_000)
})
