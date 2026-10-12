// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import type {
  ChatTarget,
  ChatTranscript,
  ChatTurn,
  ConsoleResult,
} from '../src/deps.js'
import { createConsoleHandler } from '../src/http.js'
import { documentCspFor, inlineScripts } from '../src/respond.js'
import {
  ADDRESS,
  CountingChat,
  accountsHarness,
  asSession,
  person,
} from './accountsHarness.js'
import { MemoryActionLedger } from './memoryActions.js'
import { ADMIN, VIEW, TOKENS, NOW, browse, pageHarness } from './pageHarness.js'

const DAY = 86_400_000
const MAIN: ChatTarget = {
  address: ADDRESS,
  node: 'tokyo-1',
  agent: 'planner',
  endpoint: 'ws://127.0.0.1:38611/',
  status: 'online',
  dialable: true,
}
const REVIEWER: ChatTarget = {
  ...MAIN,
  address: 'qianmo://tokyo-1/reviewer',
  agent: 'reviewer',
}
const WRITER: ChatTarget = {
  ...MAIN,
  address: 'qianmo://osaka-1/writer',
  node: 'osaka-1',
  agent: 'writer',
}

class FrontChat extends CountingChat {
  roster: readonly ChatTarget[] = [MAIN, REVIEWER, WRITER]
  body = ''
  transcriptTurns: readonly ChatTurn[] | undefined
  override async targets(): Promise<ConsoleResult<readonly ChatTarget[]>> {
    return { ok: true, value: this.roster }
  }
  override async transcript(
    id: string,
  ): Promise<ConsoleResult<ChatTranscript>> {
    const result = await super.transcript(id)
    if (!result.ok || (this.body === '' && this.transcriptTurns === undefined))
      return result
    return {
      ok: true,
      value: {
        ...result.value,
        turns: this.transcriptTurns ?? [
          {
            id: 'reply',
            sessionId: id,
            author: 'agent',
            at: NOW,
            text: this.body,
            state: 'done',
          },
        ],
      },
    }
  }
  seed(
    id: string,
    target: ChatTarget,
    age = 0,
    running = false,
    title = id,
  ): void {
    this.sessionsById.set(id, {
      id,
      target: target.address,
      node: target.node,
      agent: target.agent,
      createdAt: NOW - age,
      updatedAt: NOW - age,
      preview: '',
      turnCount: 0,
      title,
      ...(running ? { running: true } : {}),
    })
  }
}

function front(chat = new FrontChat(), preferred?: string) {
  const h = pageHarness({
    chat: true,
    ports: {
      chat,
      ...(preferred === undefined ? {} : { chatDefault: preferred }),
    },
  })
  return { ...h, chat }
}

/** A rendered region, including its opening tag. */
function region(html: string, id: string, end: string): string {
  const at = html.indexOf(`id="${id}"`)
  expect(at).toBeGreaterThanOrEqual(0)
  const start = html.lastIndexOf('<', at)
  const stop = html.indexOf(end, at)
  expect(stop).toBeGreaterThan(at)
  return html.slice(start, stop + end.length)
}

function historyTag(html: string, id: string): string {
  return (
    html.match(
      new RegExp(`<button[^>]*class="fx-hitem[^>]*data-session="${id}"[^>]*>`),
    )?.[0] ?? ''
  )
}

describe('front door and management routes', () => {
  test('admin and members converse; viewer, read token and missing channel redirect; anonymous returns through login', async () => {
    const h = accountsHarness()
    const member = await person(h.handle, 'member')
    const viewer = await person(h.handle, 'viewer')
    for (const [request, status, location] of [
      [browse('/', ADMIN), 200, null],
      [asSession('GET', '/', member.sid, { header: false }), 200, null],
      [asSession('GET', '/', viewer.sid, { header: false }), 303, '/admin'],
      [browse('/', VIEW), 303, '/admin'],
      [browse('/'), 303, '/login'],
      [browse('/', ADMIN, 'POST'), 405, null],
    ] as const) {
      const response = await h.handle(request)
      expect([response.status, response.headers.get('location')]).toEqual([
        status,
        location,
      ])
      if (status === 200)
        expect(await response.text()).toContain('id="fx-thread"')
      if (status === 405) expect(response.headers.get('allow')).toBe('GET')
    }
    const off = pageHarness()
    const response = await off.handle(browse('/', ADMIN))
    expect([response.status, response.headers.get('location')]).toEqual([
      303,
      '/admin',
    ])
    expect(off.chat.transcripts + off.chat.opened + off.chat.sends).toBe(0)
  })

  test('old document addresses preserve queries in permanent redirects', async () => {
    const h = front()
    for (const [path, destination] of [
      ['/chat?session=x&agent=a%2Fb', '/?session=x&agent=a%2Fb'],
      ['/nodes?q=tokyo%201&state=live', '/admin/nodes?q=tokyo%201&state=live'],
      [
        '/providers/nodes/tokyo-1?tab=keys',
        '/admin/providers/nodes/tokyo-1?tab=keys',
      ],
      ['/overview?window=1h', '/admin/overview?window=1h'],
    ]) {
      const response = await h.handle(browse(path ?? ''))
      expect([response.status, response.headers.get('location')]).toEqual([
        308,
        destination,
      ])
    }
    expect(h.chat.transcripts).toBe(0)
  })

  test('management home, area and missing area keep their status and navigation', async () => {
    const h = front()
    for (const [path, heading] of [
      ['/admin', '总览'],
      ['/admin/nodes', '节点'],
    ]) {
      const response = await h.handle(browse(path ?? '', ADMIN))
      expect(response.status).toBe(200)
      const page = await response.text()
      expect(page).toContain(`id="page-title">${heading}</h1>`)
      expect(page).toContain('class="brand-cn" href="/admin"')
      expect(page).toContain('id="nav-chat" href="/"')
    }
    expect((await h.handle(browse('/admin/unknown', ADMIN))).status).toBe(404)
    expect(await (await h.handle(browse('/admin', VIEW))).text()).not.toContain(
      'id="nav-chat"',
    )
  })

  test('front fragments keep the chat guard and GET-only contract', async () => {
    const h = front()
    for (const path of [
      '/fragments/chat/front/side',
      '/fragments/chat/front/view',
      '/fragments/chat/front/view/unknown',
    ]) {
      expect((await h.handle(browse(path))).status).toBe(401)
      expect((await h.handle(browse(path, VIEW))).status).toBe(403)
      const post = await h.handle(browse(path, ADMIN, 'POST'))
      expect([post.status, post.headers.get('allow')]).toEqual([405, 'GET'])
    }
    expect(h.chat.transcripts).toBe(0)
  })
})

describe('agents and session history', () => {
  test('preferred roster entry wins; missing preference uses first dialable; none dialable uses first', async () => {
    for (const [roster, preferred, expected] of [
      [
        [MAIN, REVIEWER, { ...WRITER, dialable: false }],
        WRITER.address,
        WRITER,
      ],
      [
        [{ ...MAIN, dialable: false }, REVIEWER, WRITER],
        'qianmo://unknown/main',
        REVIEWER,
      ],
      [
        [
          { ...MAIN, dialable: false },
          { ...REVIEWER, dialable: false },
        ],
        undefined,
        MAIN,
      ],
    ] as const) {
      const chat = new FrontChat()
      chat.roster = roster
      const h = front(chat, preferred)
      const page = await (await h.handle(browse('/', ADMIN))).text()
      const main =
        /class="fx-agent-row fx-agent-main[^>]*data-address="([^"]+)"/.exec(
          page,
        )?.[1]
      expect(main).toBe(expected.address)
      expect(region(page, 'fx-head', '</div>')).toContain(
        `data-target="${expected.address}"`,
      )
    }
  })

  test('sub-agents group by node and never repeat the main agent', async () => {
    const h = front()
    const fragment = await (
      await h.handle(browse('/fragments/chat/front/side', ADMIN))
    ).text()
    const agents = region(fragment, 'fx-agents', '</section>')
    expect(agents).toContain('子智能体')
    expect(agents.match(/class="fx-agent-row/g)).toHaveLength(3)
    expect(agents.match(/class="fx-agent-row fx-agent-main/g)).toHaveLength(1)
    expect(agents.match(/class="fx-server"/g)).toHaveLength(2)
    const subs = agents.slice(agents.indexOf('class="fx-server"'))
    expect(subs).not.toContain(`data-address="${MAIN.address}"`)
    expect(subs).toContain('data-key="server:tokyo-1"')
    expect(subs).toContain('data-key="server:osaka-1"')
  })

  test('an undialable agent is marked and cannot start from the welcome', async () => {
    const chat = new FrontChat()
    chat.roster = [{ ...MAIN, dialable: false }]
    const h = front(chat)
    const page = await (await h.handle(browse('/', ADMIN))).text()
    expect(page).toContain('is-off')
    expect(page).toContain('端点不在允许名单')
    expect(page).not.toContain('data-action="fx-suggest"')
    expect(page).toContain('Shift Enter 换行" disabled')
    expect(page).toContain('aria-label="发送" disabled')
    const welcome = await (
      await h.handle(browse('/fragments/chat/front/view', ADMIN))
    ).text()
    expect(welcome).not.toContain('data-start="1"')
    expect(welcome).not.toContain('data-action="fx-suggest"')
    expect(chat.opened).toBe(0)
  })

  test('running badges and strip exclude the active conversation and completed work', async () => {
    const h = front()
    h.chat.seed('current', MAIN, 0, true)
    h.chat.seed('sub-work', REVIEWER, 1, true)
    h.chat.seed('finished', WRITER, 2)
    const side = await (
      await h.handle(browse('/fragments/chat/front/side?active=current', ADMIN))
    ).text()
    expect(region(side, 'fx-agents', '</section>')).toContain('1 执行中')
    const stack = side.slice(side.indexOf('id="fx-stack"'))
    expect(stack).toContain('子智能体执行中 · 1')
    expect(stack).toContain('data-session="sub-work"')
    expect(stack).not.toContain('data-session="current"')
    expect(stack).not.toContain('data-session="finished"')
  })

  test('rolling history windows include their boundaries; current-agent filtering starts hidden for others', async () => {
    const h = front()
    for (const [id, age] of [
      ['today', DAY],
      ['week', 7 * DAY],
      ['month', 30 * DAY],
      ['older', 30 * DAY + 1],
    ] as const) {
      h.chat.seed(id, MAIN, age)
    }
    h.chat.seed('other', WRITER, 2 * DAY)
    const page = await (await h.handle(browse('/', ADMIN))).text()
    const history = region(page, 'fx-history', '</section>')
    const groups = history.split('<div class="fx-hgroup"').slice(1)
    expect(
      groups.map(group => /fx-hgroup-name">([^<]+)/.exec(group)?.[1]),
    ).toEqual(['24 小时内', '7 天内', '30 天内', '更早'])
    for (const [index, id] of ['today', 'week', 'month', 'older'].entries()) {
      expect(groups[index]).toContain(`data-session="${id}"`)
      expect(historyTag(history, id)).not.toContain(' hidden')
    }
    expect(history).toContain('data-scope="agent" aria-pressed="true"')
    expect(historyTag(history, 'other')).toContain(' hidden')
  })
})

describe('front process steps', () => {
  const ask: ChatTurn = {
    id: 'ask-a',
    sessionId: 'work',
    author: 'operator',
    at: NOW - 3_000,
    text: '任务 A',
    state: 'delivered',
    taskId: 'task-a',
  }
  const answer: ChatTurn = {
    ...ask,
    id: 'answer-a',
    author: 'agent',
    at: NOW - 1_000,
    text: 'A 已完成',
    state: 'done',
  }
  const step: ChatTurn = {
    ...answer,
    id: 'step',
    variant: 'notice',
    severity: 'info',
    text: '读取资料',
  }
  async function render(turns: readonly ChatTurn[]): Promise<string> {
    const h = front()
    h.chat.seed('work', MAIN)
    h.chat.transcriptTurns = turns
    const response = await h.handle(
      browse('/fragments/chat/front/view/work?open=1', ADMIN),
    )
    expect(response.status).toBe(200)
    return response.text()
  }

  test('after task A answers, task B keeps both the waiting hint and trailing process group running', async () => {
    const b = {
      ...ask,
      id: 'ask-b',
      taskId: 'task-b',
      text: '任务 B',
      at: NOW - 2_000,
    }
    const turns = [ask, b, answer, { ...step, taskId: 'task-b' }]
    const running = await render(turns)
    expect(running).toContain('fx-pending')
    expect(running).toContain('planner 正在处理')
    expect(running).toContain('fx-steps-muted is-running')
    expect(running).toContain('执行中 · 1 步')
    const done = await render([
      ...turns,
      { ...answer, id: 'answer-b', taskId: 'task-b', text: 'B 已完成' },
    ])
    expect(done).not.toContain('fx-pending')
    expect(done).not.toContain('is-running')
    expect(done).toContain('执行过程 · 1 步')
  })
})

describe('front transcript ledger and ownership', () => {
  test('page, explicit front fragment and JSON each record once; refresh shares the window and expiry starts another', async () => {
    const actions = new MemoryActionLedger()
    const h = accountsHarness({ deps: { actions } })
    const opened = await h.chat.open(ADDRESS)
    if (!opened.ok) throw new Error(opened.failure.message)
    const id = opened.value.id
    const reads = () =>
      actions.entries.filter(entry => entry.action === 'chat.transcript.open')
    for (const path of [
      `/?session=${id}`,
      `/fragments/chat/front/view/${id}?open=1`,
      `/v0/chat/sessions/${id}`,
    ]) {
      expect((await h.handle(browse(path, ADMIN))).status).toBe(200)
    }
    expect(
      reads().map(entry => [entry.target, entry.subject, entry.outcome]),
    ).toEqual(Array.from({ length: 3 }, () => [id, 'legacy:admin', 'ok']))
    for (let i = 0; i < 100; i++) {
      expect(
        (await h.handle(browse(`/fragments/chat/front/view/${id}`, ADMIN)))
          .status,
      ).toBe(200)
    }
    expect(reads()).toHaveLength(3)
    h.clock.advance(31 * 60_000)
    expect(
      (await h.handle(browse(`/fragments/chat/front/view/${id}`, ADMIN)))
        .status,
    ).toBe(200)
    expect(reads()).toHaveLength(4)
    expect(h.chat.transcripts).toBe(104)
  })

  test('closed ledger refuses page and front fragment before reading the transcript', async () => {
    const actions = new MemoryActionLedger()
    const h = front()
    h.chat.seed('blocked', MAIN)
    const handle = createConsoleHandler({ ...h.deps, actions }, TOKENS)
    actions.admitResult = {
      ok: false,
      failure: { code: 'unreachable', message: '账本停用' },
    }
    for (const path of [
      '/?session=blocked',
      '/fragments/chat/front/view/blocked?open=1',
      '/fragments/chat/front/view/blocked',
    ]) {
      const response = await handle(browse(path, ADMIN))
      expect(response.status).toBe(503)
      expect(await response.text()).toContain('动作账本停用')
    }
    expect(h.chat.transcripts).toBe(0)
    expect(actions.entries).toEqual([])
  })

  test('members see only their sessions; hidden and nonexistent views have the same answer without reads or ledger entries', async () => {
    const actions = new MemoryActionLedger()
    const h = accountsHarness({ deps: { actions } })
    const a = await person(h.handle, 'member')
    const b = await person(h.handle, 'member')
    const ids: string[] = []
    for (const who of [a, b]) {
      const response = await h.handle(
        asSession('POST', '/v0/chat/sessions', who.sid, {
          body: { target: ADDRESS },
        }),
      )
      ids.push(((await response.json()) as { id: string }).id)
    }
    const side = await (
      await h.handle(asSession('GET', '/fragments/chat/front/side', a.sid))
    ).text()
    expect(side).toContain(`data-session="${ids[0]}"`)
    expect(side).not.toContain(`data-session="${ids[1]}"`)
    const before = actions.entries.length
    for (const prefix of ['/fragments/chat/front/view/', '/?session=']) {
      const hidden = await h.handle(
        asSession('GET', `${prefix}${ids[1]}`, a.sid),
      )
      const missing = await h.handle(
        asSession('GET', `${prefix}missing`, a.sid),
      )
      expect(hidden.status).toBe(missing.status)
      const hiddenHtml = await hidden.text()
      const missingHtml = await missing.text()
      // The re-login link echoes the caller's query; it says nothing about existence.
      if (prefix === '/?session=') {
        expect(region(hiddenHtml, 'fx-thread', '</div>')).toBe(
          region(missingHtml, 'fx-thread', '</div>'),
        )
        expect(region(hiddenHtml, 'fx-history', '</section>')).toBe(
          region(missingHtml, 'fx-history', '</section>'),
        )
      } else expect(hiddenHtml).toBe(missingHtml)
    }
    expect(h.chat.transcripts).toBe(0)
    expect(actions.entries).toHaveLength(before)
  })
})

test('front document and fragments escape remote names, titles and body; CSP admits only inline hashes and local connections', async () => {
  const h = front()
  const hostile = '<script>"x"</script>'
  const target = { ...MAIN, agent: hostile, node: hostile }
  h.chat.roster = [target]
  h.chat.seed('escaped', target, 0, false, hostile)
  h.chat.body = hostile
  for (const path of [
    '/?session=escaped',
    '/fragments/chat/front/side',
    '/fragments/chat/front/view/escaped?open=1',
  ]) {
    const response = await h.handle(browse(path, ADMIN))
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).not.toContain(hostile)
    expect(html).toContain('&lt;script&gt;&quot;x&quot;&lt;/script&gt;')
    if (path.startsWith('/?')) {
      const policy = response.headers.get('content-security-policy') ?? ''
      expect(policy).toBe(documentCspFor(inlineScripts(html)))
      expect(policy).toContain("'sha256-")
      expect(policy).not.toContain("script-src 'unsafe-inline'")
      expect(policy).toContain("connect-src 'self'")
      const markup = html
        .replace(/<script>[\s\S]*?<\/script>/g, '')
        .replace(/<style>[\s\S]*?<\/style>/g, '')
      expect(markup).not.toMatch(
        /<(?:script|img|link)[^>]+(?:src|href)="https?:/,
      )
    }
  }
})
