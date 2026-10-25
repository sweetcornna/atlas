// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import type {
  ChatTarget,
  ChatTranscript,
  ChatTurn,
  ConsoleResult,
} from '../src/deps.js'
import { FRONT_JS } from '../src/assets/frontClient.js'
import { defaultAvatar } from '../src/avatar.js'
import { createConsoleHandler } from '../src/http.js'
import { documentCspFor, inlineScripts, scriptHash } from '../src/respond.js'
import { ROUTES } from '../src/routes/index.js'
import { renderFrontSide } from '../src/view/front.js'
import {
  ADDRESS,
  CountingChat,
  accountsHarness,
  asSession,
  person,
} from './accountsHarness.js'
import { FakeAvatars } from './directionFakes.js'
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
    background = false,
    resident = false,
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
      ...(background ? { background: true } : {}),
      ...(resident ? { resident: true } : {}),
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

/**
 * A document's policy: its own scripts by hash, and beyond them only the page
 * scripts of areas the settings card can open in place (`assets/nav.ts`);
 * every other directive is a scriptless document's.
 */
function expectOwnPolicy(policy: string, html: string): void {
  const own = inlineScripts(html)
  const sources =
    policy
      .split('; ')
      .find(one => one.startsWith('script-src '))
      ?.split(' ')
      .slice(1) ?? []
  const pages = ROUTES.flatMap(module =>
    module.page?.script === undefined ? [] : [scriptHash(module.page.script)],
  )
  for (const script of own) expect(sources).toContain(scriptHash(script))
  for (const hash of sources)
    expect([...own.map(scriptHash), ...pages]).toContain(hash)
  const rest = (text: string): string =>
    text
      .split('; ')
      .filter(one => !one.startsWith('script-src '))
      .join('; ')
  expect(rest(policy)).toBe(rest(documentCspFor(own)))
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
      // The card is drawn open with the area in it, over the Work face.
      expect(page).toContain('<dialog class="set" id="settings"')
      expect(page).toMatch(
        /<dialog class="set" id="settings"[^>]* open data-shown>/,
      )
      expect(page).toContain(`id="page-title">${heading}</h2>`)
      expect(page).toMatch(
        /<a class="fx-switch-item" href="\/" data-to="work" aria-current="page">/,
      )
      // 对话 is the face under the card, not one of its areas.
      expect(page).not.toContain('id="nav-chat"')
    }
    const unknown = await h.handle(browse('/admin/unknown', ADMIN))
    expect(unknown.status).toBe(404)
    expect(await unknown.text()).toMatch(
      /<dialog class="set" id="settings"[^>]* open data-shown>/,
    )
    // Opening an area reads no conversation.
    expect(h.chat.transcripts).toBe(0)
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

  test('one list: the main agent first and once, every sub-agent after it', async () => {
    const h = front()
    const fragment = await (
      await h.handle(browse('/fragments/chat/front/side', ADMIN))
    ).text()
    const agents = region(fragment, 'fx-agents', '</section>')
    expect(agents.match(/class="fx-agent-row/g)).toHaveLength(3)
    expect(agents.match(/class="fx-agent-row fx-agent-main/g)).toHaveLength(1)
    expect(/class="fx-agent-row[^"]*"/.exec(agents)?.[0]).toContain(
      'fx-agent-main',
    )
    const subs = agents.slice(
      agents.indexOf('class="fx-agent-row', agents.indexOf('fx-agent-main')),
    )
    expect(subs).not.toContain(`data-address="${MAIN.address}"`)
    expect(subs).toContain(`data-address="${REVIEWER.address}"`)
    expect(subs).toContain(`data-address="${WRITER.address}"`)
  })

  test('an undialable agent is marked and cannot start from the welcome', async () => {
    const chat = new FrontChat()
    chat.roster = [{ ...MAIN, dialable: false }]
    const h = front(chat)
    const page = await (await h.handle(browse('/', ADMIN))).text()
    expect(page).toContain('is-off')
    expect(page).toContain('未接入')
    expect(page).not.toContain('data-action="fx-suggest"')
    expect(page).toContain('placeholder="发消息" disabled')
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
    const agents = region(side, 'fx-agents', '</section>')
    // Only the reviewer works out of sight: the open conversation and the
    // finished one are not counted.
    expect(agents.match(/ is-busy/g)).toHaveLength(1)
    expect(agents).toMatch(
      new RegExp(`is-busy"[^>]*data-address="${REVIEWER.address}"`),
    )
    const stack = side.slice(side.indexOf('id="fx-stack"'))
    expect(stack).toContain('子智能体执行中 · 1')
    expect(stack).toContain('data-session="sub-work"')
    expect(stack).not.toContain('data-session="current"')
    expect(stack).not.toContain('data-session="finished"')
  })

  test("an agent's row is the reader's resident conversation, never the latest or a worker; the rest are its 其他对话", async () => {
    const h = front()
    h.chat.seed('talk', REVIEWER, 60_000, false, 'talk', false, true)
    // Newer, and not resident: an older conversation from before P37.17.
    h.chat.seed('older', REVIEWER, 1_000, false, '旧的')
    h.chat.seed('worker', REVIEWER, 0, true, '后台任务：周报（task-1）', true)
    h.chat.seed('only-worker', WRITER, 0, true, '后台任务：x（task-2）', true)
    const side = await (
      await h.handle(browse('/fragments/chat/front/side?active=talk', ADMIN))
    ).text()
    const agents = region(side, 'fx-agents', '</section>')
    const row = (address: string) =>
      new RegExp(
        `<div class="fx-agent-row[^"]*" data-address="${address}"[^>]*>`,
      ).exec(agents)?.[0] ?? ''
    const menu = (address: string) =>
      new RegExp(
        `data-action="fx-others" data-address="${address}">[\\s\\S]*?</button>`,
      ).exec(agents)?.[0] ?? ''
    expect(row(REVIEWER.address)).toContain('data-latest="talk"')
    // An agent with only a worker session opens on its welcome.
    expect(row(WRITER.address)).not.toContain('data-latest')
    // Nobody opens a second conversation from a row.
    expect(agents).not.toContain('fx-agent-new')
    // Their work still shows: busy rows and the strip.
    expect(row(WRITER.address)).toContain(' is-busy')
    expect(row(REVIEWER.address)).toContain(' is-busy')
    const stack = side.slice(side.indexOf('id="fx-stack"'))
    expect(stack).toContain('data-session="worker"')
    // ⋯ counts the others; an agent with none has no such item.
    expect(menu(REVIEWER.address)).toContain(
      '其他对话<span class="fx-menu-count">2</span>',
    )
    expect(menu(WRITER.address)).toContain(
      '<span class="fx-menu-count">1</span>',
    )
    expect(menu(MAIN.address)).toBe('')
    // The dialog's list: everything but the resident one.
    const others = region(side, 'fx-history', '</section>')
    for (const id of ['older', 'worker', 'only-worker']) {
      expect(others).toContain(`data-session="${id}"`)
    }
    expect(others).not.toContain('data-session="talk"')
  })

  test("the row's time and last line are the resident conversation's; a dot says the roster's verdict", async () => {
    const h = front()
    h.chat.roster = [MAIN, { ...REVIEWER, dialable: false }]
    h.chat.seed('mine', MAIN, 2 * 3_600_000, false, 'mine', false, true)
    h.chat.seed('later', MAIN, 60_000, false, 'later')
    for (const [id, preview] of [
      ['mine', '常驻会话的最后一句'],
      ['later', '旧会话的最后一句'],
    ] as const) {
      const session = h.chat.sessionsById.get(id)
      if (session === undefined) throw new Error('seed missing')
      h.chat.sessionsById.set(id, { ...session, preview })
    }
    const side = await (
      await h.handle(browse('/fragments/chat/front/side', ADMIN))
    ).text()
    const agents = region(side, 'fx-agents', '</section>')
    const main = agents.slice(0, agents.indexOf(REVIEWER.address))
    expect(main).toContain('>常驻会话的最后一句<')
    expect(main).not.toContain('旧会话的最后一句')
    expect(main).toContain('class="fx-agent-when">2 小时前<')
    expect(main).toContain(
      '<span class="fx-presence" data-tone="ok"><span class="sr-only">在线</span></span>',
    )
    const off = agents.slice(agents.indexOf(REVIEWER.address))
    expect(off).toContain('data-tone="bad"><span class="sr-only">未接入</span>')
  })

  test('an agent the roster no longer lists keeps its row while the reader has a conversation with it', async () => {
    const h = front()
    const gone: ChatTarget = {
      ...MAIN,
      address: 'qianmo://old-1/gone',
      node: 'old-1',
      agent: 'gone',
    }
    h.chat.seed('kept', gone, 0, false, 'kept', false, true)
    h.chat.seed('orphan', {
      ...gone,
      address: 'qianmo://old-1/other',
      agent: 'other',
    })
    const side = await (
      await h.handle(browse('/fragments/chat/front/side', ADMIN))
    ).text()
    const agents = region(side, 'fx-agents', '</section>')
    expect(agents).toMatch(
      /class="fx-agent-row is-off" data-address="qianmo:\/\/old-1\/gone" data-latest="kept"/,
    )
    expect(agents).toContain('old-1 · 不在名册')
    // Without a conversation of the reader's, no row: its sessions are 其他对话.
    expect(agents).not.toContain('qianmo://old-1/other')
    expect(region(side, 'fx-history', '</section>')).toContain(
      'data-session="orphan"',
    )
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
    // The list lives in the 其他对话 dialog, not in the bar.
    expect(page).toContain(
      '<dialog class="dialog fx-others" id="fx-others" aria-labelledby="fx-others-title">',
    )
    expect(page).not.toContain('fx-hist-menu')
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
    expect(running).toContain('aria-label="planner · 读取资料"')
    expect(running).toContain('fx-steps-muted is-running')
    expect(running).toContain('进行中 · 1 步')
    const done = await render([
      ...turns,
      { ...answer, id: 'answer-b', taskId: 'task-b', text: 'B 已完成' },
    ])
    expect(done).not.toContain('fx-pending')
    expect(done).not.toContain('is-running')
    expect(done).toContain('已执行 · 1 步')
  })

  test('a line sent while the agent is on an earlier one reads 排队中 until the node reads it', async () => {
    const b = {
      ...ask,
      id: 'ask-b',
      taskId: 'task-b',
      text: '任务 B',
      at: NOW - 2_000,
    }
    const waiting = await render([ask, b])
    const article = (id: string, html: string) => {
      const at = html.indexOf(id)
      return html.slice(
        html.lastIndexOf('<article', at),
        html.indexOf('</article>', at),
      )
    }
    expect(article('任务 B', waiting)).toContain('is-queued')
    expect(article('任务 B', waiting)).toContain('排队中 · 下一步时送达')
    // The line the agent is on is never the queued one.
    expect(article('任务 A', waiting)).not.toContain('排队中')
    const read = await render([ask, { ...b, readMs: 400 }])
    expect(article('任务 B', read)).not.toContain('排队中')
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
    expect(side).toContain(`data-latest="${ids[0]}"`)
    expect(side).not.toContain(`"${ids[1]}"`)
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
      expectOwnPolicy(policy, html)
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

describe("the reader's own choices: theme colour and language", () => {
  function withCookie(path: string, cookie: string): Request {
    const plain = browse(path, ADMIN)
    return new Request(plain.url, {
      headers: { ...Object.fromEntries(plain.headers), cookie },
    })
  }
  async function head(cookie: string): Promise<string> {
    const page = await (await front().handle(withCookie('/', cookie))).text()
    return /<html[^>]*>/.exec(page)?.[0] ?? ''
  }

  test('a picked colour carries a text colour that reads on it at 4.5:1 or better', async () => {
    // Mid greys are where a fixed luminance cut-off picks white at 2.85:1.
    expect(await head('qianmo_accent=%23999999')).toContain(
      '--qm-accent-ink:#111110',
    )
    expect(await head('qianmo_accent=%23808080')).toContain(
      '--qm-accent-ink:#111110',
    )
    // Between the two, neither the ink nor white reaches 4.5:1: pure black does.
    expect(await head('qianmo_accent=%23787878')).toContain(
      '--qm-accent-ink:#000000',
    )
    expect(await head('qianmo_accent=%23202020')).toContain(
      '--qm-accent-ink:#ffffff',
    )
    expect(await head('qianmo_accent=sage')).toContain('data-accent="sage"')
  })

  test('anything off the lists is ignored, never written into the page', async () => {
    for (const cookie of [
      'qianmo_accent=%23zzzzzz',
      'qianmo_accent=%22%3E%3Cscript%3E',
      'qianmo_accent=neon',
      'qianmo_lang=xx',
      'qianmo_lang=%22%3E',
    ]) {
      const tag = await head(cookie)
      expect(tag).toBe('<html lang="zh-CN" data-theme="system">')
    }
    expect(await head('qianmo_lang=en')).toStartWith('<html lang="en" ')
    expect(await head('qianmo_lang=ja')).toStartWith('<html lang="ja" ')
  })

  test('voice input joins after whitespace, and typing ends the listening', () => {
    // A template-literal script: the class must survive as \\s, not as "s".
    expect(FRONT_JS).toContain('!/\\s$/.test(base)')
    expect(FRONT_JS).not.toContain('!/s$/.test(base)')
    expect(FRONT_JS).toContain('if (voice !== rec) return;')
    expect(FRONT_JS).toContain(
      "if (target.id === 'fx-text') { if (voice) stopVoice();",
    )
  })
})

describe("the front in the reader's language reaches its shared pieces", () => {
  function withLang(path: string, lang: string): Request {
    const plain = browse(path, ADMIN)
    return new Request(plain.url, {
      headers: {
        ...Object.fromEntries(plain.headers),
        cookie: `qianmo_lang=${lang}`,
      },
    })
  }

  test('the expire dialog, the avatar dialog and the theme colours speak English', async () => {
    // The figure editor is drawn for a reader who may dress a figure.
    const h = pageHarness({
      chat: true,
      ports: { chat: new FrontChat(), avatars: new FakeAvatars(() => NOW) },
    })
    const page = await (await h.handle(withLang('/', 'en'))).text()
    const expired = region(page, 'session-expired', '</dialog>')
    expect(expired).toContain('Session expired')
    expect(expired).toContain('Sign in again')
    expect(expired).not.toContain('会话已失效')
    expect(page).toContain('data-lang="en"')
    expect(page).toContain('>Avatar<')
    expect(page).toContain('aria-label="Sage"')
    expect(page).not.toContain('aria-label="青"')
    // The head figure's name is in English too.
    expect(page).toMatch(/aria-label="planner · [A-Z][a-z]+ [a-z]+"/)
  })

  test("the editor fragment follows ?lang=, and the settings card's areas keep 简体中文", async () => {
    const h = front()
    const key = encodeURIComponent('agent:qianmo://tokyo-1/planner')
    const en = await (
      await h.handle(browse(`/fragments/avatar?key=${key}&lang=en`, ADMIN))
    ).text()
    expect(en).toContain('>Shape<')
    expect(en).toContain('>Thinking<')
    const ja = await (
      await h.handle(browse(`/fragments/avatar?key=${key}&lang=ja`, ADMIN))
    ).text()
    expect(ja).toContain('>形<')
    const plain = await (
      await h.handle(browse(`/fragments/avatar?key=${key}`, ADMIN))
    ).text()
    expect(plain).toContain('>形态<')
    const odd = await (
      await h.handle(browse(`/fragments/avatar?key=${key}&lang=%22%3E`, ADMIN))
    ).text()
    expect(odd).toContain('>形态<')
    // An area's address is the Work face in the reader's language with the
    // card open over it; the area in the card is in 简体中文.
    const admin = await (await h.handle(withLang('/admin', 'en'))).text()
    expect(admin).toContain('Session expired')
    expect(admin).toContain('placeholder="Search settings"')
    expect(admin).toContain('id="page-title">总览</h2>')
  })
})

describe('the 对话 face at /app and quick entry at /app/quick', () => {
  test('both addresses keep the front door: admin and members in, viewer and read token to /admin, anonymous to login, GET only, nothing else under /app', async () => {
    const h = accountsHarness()
    const member = await person(h.handle, 'member')
    const viewer = await person(h.handle, 'viewer')
    for (const [path, mount] of [
      ['/app', 'id="fx-recents"'],
      ['/app/quick', 'id="fx-quick-form"'],
    ] as const) {
      for (const [request, status, location] of [
        [browse(path, ADMIN), 200, null],
        [asSession('GET', path, member.sid, { header: false }), 200, null],
        [asSession('GET', path, viewer.sid, { header: false }), 303, '/admin'],
        [browse(path, VIEW), 303, '/admin'],
        [browse(path, ADMIN, 'POST'), 405, null],
      ] as const) {
        const response = await h.handle(request)
        expect([response.status, response.headers.get('location')]).toEqual([
          status,
          location,
        ])
        if (status === 200) expect(await response.text()).toContain(mount)
      }
      const anonymous = await h.handle(browse(path))
      expect(anonymous.status).toBe(303)
      expect(anonymous.headers.get('location')).toStartWith('/login')
    }
    for (const path of ['/app/x', '/app/quick/x', '/app/admin']) {
      expect((await h.handle(browse(path, ADMIN))).status).toBe(404)
    }
    const off = pageHarness()
    for (const path of ['/app', '/app/quick']) {
      const response = await off.handle(browse(path, ADMIN))
      expect([response.status, response.headers.get('location')]).toEqual([
        303,
        '/admin',
      ])
    }
    expect(off.chat.transcripts + off.chat.opened + off.chat.sends).toBe(0)
  })

  test('the two faces share the switch, the sidebar head and the bar; each marks itself current', async () => {
    const h = front()
    const agents = await (await h.handle(browse('/', ADMIN))).text()
    const chat = await (await h.handle(browse('/app', ADMIN))).text()
    for (const [page, layout, current] of [
      [agents, 'agents', '/'],
      [chat, 'chat', '/app'],
    ] as const) {
      expect(page).toContain(`id="fx" data-layout="${layout}"`)
      const modes = /<nav class="fx-mode"[\s\S]*?<\/nav>/.exec(page)?.[0] ?? ''
      expect(modes.match(/class="fx-mode-item/g)).toHaveLength(2)
      expect(modes).toMatch(
        new RegExp(`href="${current}"[^>]*aria-current="page"`),
      )
      expect(page).toContain('class="fx-side-top" data-tauri-drag-region')
      expect(page).toContain('id="fx-search"')
      expect(page).toContain('class="fx-top" data-tauri-drag-region')
      expect(page).toContain('id="fx-computer"')
      expect(page).toContain('id="fx-offline"')
      expect(page).toContain('id="keyboard-help"')
      // P37.17: the same side list on both faces — the agents, then the
      // conversations that are not with one agent, and 其他对话 behind ⋯.
      // Nothing opens a second conversation with an agent.
      const side = region(page, 'fx-side', '</aside>')
      expect(side.indexOf('id="fx-agents"')).toBeGreaterThan(
        side.indexOf('id="fx-search"'),
      )
      expect(side.indexOf('id="fx-recents"')).toBeGreaterThan(
        side.indexOf('id="fx-agents"'),
      )
      expect(page).toContain('id="fx-others"')
      expect(page).not.toContain('data-action="fx-new"')
      expect(page).not.toContain('fx-top-new')
      expect(page).not.toContain('fx-hist-menu')
    }
    // `/app` picks the agent in the composer.
    expect(agents).not.toContain('id="fx-agent-menu"')
    expect(chat).toContain('id="fx-agent-menu"')
    expect(chat).toContain('id="fx-agent-btn"')
    expect(chat).not.toContain('data-action="fx-suggest"')
  })

  test('the list by day under the agents is empty before 广泛性工作: nothing drawn for it, every conversation with an agent elsewhere', async () => {
    const h = front()
    h.chat.seed('now', MAIN, 0, true, '现在', false, true)
    h.chat.seed('yesterday', REVIEWER, DAY, false, '昨天的')
    h.chat.seed('worker', REVIEWER, 0, true, '后台任务：周报（task-1）', true)
    for (const layout of ['', '&layout=chat']) {
      const side = await (
        await h.handle(
          browse(`/fragments/chat/front/side?active=yesterday${layout}`, ADMIN),
        )
      ).text()
      const recents = region(side, 'fx-recents', '</section>')
      expect(
        recents.match(/class="fx-rgroup" data-group="[a-z]+" hidden>/g),
      ).toHaveLength(4)
      expect(recents).not.toContain('fx-ritem-row')
      // No line saying it is empty: nothing at all.
      expect(recents).not.toContain('fx-none')
      expect(region(side, 'fx-agents', '</section>')).toContain(
        'data-latest="now"',
      )
      expect(region(side, 'fx-history', '</section>')).toContain(
        'data-session="yesterday"',
      )
    }
  })

  test('the list by day, given conversations (P37.17 B): its days, no worker, a figure only for sub-agents, plain previews', () => {
    const at = (age: number, id: string, target: ChatTarget, extra = {}) => ({
      id,
      target: target.address,
      node: target.node,
      agent: target.agent,
      createdAt: NOW - age,
      updatedAt: NOW - age,
      turnCount: 1,
      preview: '**完** `x`',
      title: id,
      ...extra,
    })
    const works = [
      at(0, 'now', MAIN, { running: true as const }),
      at(DAY, 'yesterday', REVIEWER),
      at(2 * DAY, 'week', WRITER),
      at(10 * DAY, 'old', MAIN),
      at(0, 'worker', REVIEWER, { background: true as const }),
    ]
    const side = renderFrontSide({
      faces: {
        agent: address => defaultAvatar(address),
        self: defaultAvatar('me'),
        selfKey: 'user:me',
        editable: false,
      },
      targets: [MAIN, REVIEWER, WRITER],
      sessions: [],
      residents: new Map(),
      works,
      sessionsFailure: null,
      main: MAIN.address,
      selected: REVIEWER.address,
      activeId: 'yesterday',
      admin: true,
      now: NOW,
      lang: 'zh-CN',
      layout: 'chat',
    })
    const recents = region(side, 'fx-recents', '</section>')
    const groups = recents.split('<div class="fx-rgroup"').slice(1)
    expect(
      groups.map(group => /fx-rgroup-name">([^<]+)/.exec(group)?.[1]),
    ).toEqual(['今天', '昨天', '过去 7 天', '更早'])
    for (const [index, id] of ['now', 'yesterday', 'week', 'old'].entries()) {
      expect(groups[index]).toContain(`data-session="${id}"`)
      expect(groups[index]).not.toMatch(/^[^>]* hidden>/)
    }
    expect(recents).not.toContain('data-session="worker"')
    const row = (id: string) =>
      new RegExp(
        `<div class="fx-ritem-row[^"]*" data-session="${id}"[\\s\\S]*?</button>`,
      ).exec(recents)?.[0] ?? ''
    expect(row('now')).toContain('data-running="1"')
    expect(row('now')).toContain('class="fx-ritem-live"')
    expect(row('now')).not.toContain('fx-ritem-face')
    expect(row('yesterday')).toContain('fx-ritem-face')
    expect(row('yesterday')).toContain('is-current')
    expect(row('yesterday')).toContain('aria-current="true"')
    expect(row('yesterday')).toContain('data-preview="完 x"')
    expect(recents).not.toContain('fx-agent-new')
  })

  test('members see only their own conversations with the agents on /app', async () => {
    const h = accountsHarness()
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
    expect(ids[0]).not.toBe(ids[1])
    for (const path of ['/app', '/fragments/chat/front/side?layout=chat']) {
      const html = await (await h.handle(asSession('GET', path, a.sid))).text()
      const agents = region(html, 'fx-agents', '</section>')
      expect(agents).toContain(`data-latest="${ids[0]}"`)
      expect(html).not.toContain(`"${ids[1]}"`)
    }
    // Somebody else's conversation reads as one that is not there.
    const before = h.chat.transcripts
    const hidden = await h.handle(
      asSession('GET', `/app?session=${ids[1]}`, a.sid),
    )
    const missing = await h.handle(
      asSession('GET', '/app?session=missing', a.sid),
    )
    expect(hidden.status).toBe(missing.status)
    expect(region(await hidden.text(), 'fx-thread', '</div>')).toBe(
      region(await missing.text(), 'fx-thread', '</div>'),
    )
    expect(h.chat.transcripts).toBe(before)
  })

  test('/app?session= reads through the ledger once, and a closed ledger refuses before reading', async () => {
    const actions = new MemoryActionLedger()
    const h = accountsHarness({ deps: { actions } })
    const opened = await h.chat.open(ADDRESS)
    if (!opened.ok) throw new Error(opened.failure.message)
    const id = opened.value.id
    const response = await h.handle(browse(`/app?session=${id}`, ADMIN))
    expect(response.status).toBe(200)
    const page = await response.text()
    expect(page).toContain('class="fx-head fx-head-chat"')
    expect(
      actions.entries.filter(entry => entry.action === 'chat.transcript.open'),
    ).toHaveLength(1)
    const closed = new MemoryActionLedger()
    const f = front()
    f.chat.seed('blocked', MAIN)
    closed.admitResult = {
      ok: false,
      failure: { code: 'unreachable', message: '账本停用' },
    }
    const handle = createConsoleHandler({ ...f.deps, actions: closed }, TOKENS)
    for (const path of [
      '/app?session=blocked',
      '/fragments/chat/front/view/blocked?open=1&layout=chat',
    ]) {
      const refused = await handle(browse(path, ADMIN))
      expect(refused.status).toBe(503)
    }
    expect(f.chat.transcripts).toBe(0)
  })

  test('a new conversation on /app greets with the main agent and picks it in the composer; ?agent= picks another', async () => {
    const h = front()
    const page = await (await h.handle(browse('/app', ADMIN))).text()
    expect(page).toContain('class="fx-welcome fx-greet"')
    expect(page).toMatch(
      /<h2 class="fx-greet-title" data-greet>(早上好|下午好|晚上好)<\/h2>/,
    )
    const menu = region(page, 'fx-agent-menu', '</div>')
    expect(menu).toMatch(
      new RegExp(
        `aria-checked="true" data-agent-pick="${MAIN.address}"[^>]*data-main="1"`,
      ),
    )
    const other = await (
      await h.handle(
        browse(`/app?agent=${encodeURIComponent(REVIEWER.address)}`, ADMIN),
      )
    ).text()
    expect(region(other, 'fx-agent-menu', '</div>')).toMatch(
      new RegExp(`aria-checked="true" data-agent-pick="${REVIEWER.address}"`),
    )
    const welcome = await (
      await h.handle(browse('/fragments/chat/front/view?layout=chat', ADMIN))
    ).text()
    expect(welcome).toContain('fx-greet')
  })

  test('quick entry draws the main agent first, an undialable main leaves the line closed, and nothing reads a transcript', async () => {
    const h = front()
    h.chat.seed('talk', MAIN)
    const page = await (await h.handle(browse('/app/quick', ADMIN))).text()
    expect(page).toContain(`data-main="${MAIN.address}"`)
    const menu = region(page, 'fx-quick-menu', '</div>')
    const picks = [...menu.matchAll(/data-agent-pick="([^"]+)"/g)].map(
      m => m[1],
    )
    expect(picks).toEqual([MAIN.address, REVIEWER.address, WRITER.address])
    expect(page).not.toMatch(/id="fx-quick-text"[^>]* disabled/)
    expect(page).not.toContain('data-session="talk"')
    expect(page).toContain(
      'class="fx-quick-card" id="fx-quick-form" novalidate data-tauri-drag-region',
    )
    const chat = new FrontChat()
    chat.roster = [{ ...MAIN, dialable: false }]
    const off = await (
      await front(chat).handle(browse('/app/quick', ADMIN))
    ).text()
    expect(off).toMatch(/id="fx-quick-text"[^>]* disabled/)
    expect(h.chat.transcripts + chat.transcripts + h.chat.opened).toBe(0)
  })

  test('/app, a conversation and quick entry escape remote strings; CSP admits only inline hashes', async () => {
    const h = front()
    const hostile = '<script>"x"</script>'
    const target = { ...MAIN, agent: hostile, node: hostile }
    h.chat.roster = [target, REVIEWER]
    h.chat.seed('escaped', target, 0, false, hostile)
    h.chat.seed('other', REVIEWER, 0, false, hostile)
    h.chat.body = hostile
    for (const path of [
      '/app',
      '/app?session=escaped',
      '/app/quick',
      '/fragments/chat/front/side?layout=chat',
      '/fragments/chat/front/view/escaped?open=1&layout=chat',
    ]) {
      const response = await h.handle(browse(path, ADMIN))
      expect(response.status).toBe(200)
      const html = await response.text()
      expect(html).not.toContain(hostile)
      expect(html).toContain('&lt;script&gt;&quot;x&quot;&lt;/script&gt;')
      if (!path.startsWith('/fragments/')) {
        const policy = response.headers.get('content-security-policy') ?? ''
        expectOwnPolicy(policy, html)
        expect(policy).not.toContain("script-src 'unsafe-inline'")
      }
    }
  })

  test('the faces speak the reader language', async () => {
    for (const [lang, words] of [
      ['en', ['Chat', 'Agents', 'Recent chats', 'Quick entry']],
      ['ja', ['チャット', 'エージェント', '最近のチャット', 'クイック入力']],
    ] as const) {
      const h = front()
      h.chat.seed('today', REVIEWER)
      const withLang = (path: string) => {
        const plain = browse(path, ADMIN)
        return new Request(plain.url, {
          headers: {
            ...Object.fromEntries(plain.headers),
            cookie: `qianmo_lang=${lang}`,
          },
        })
      }
      const app = await (await h.handle(withLang('/app'))).text()
      const quick = await (await h.handle(withLang('/app/quick'))).text()
      expect(app).toContain(`<html lang="${lang}"`)
      expect(app).toContain(`>${words[0]}<`)
      expect(app).toContain(`>${words[1]}<`)
      expect(app).toContain(`aria-label="${words[2]}"`)
      expect(app).not.toContain('>今天<')
      expect(quick).toContain(`<html lang="${lang}"`)
      expect(quick).toContain(words[3])
      expect(quick).not.toContain('快速输入')
    }
  })

  test('an agent’s ⋯, 其他对话 and a read-only conversation speak the reader language (P37.17)', async () => {
    for (const [lang, words] of [
      ['zh-CN', ['其他对话', '只读', '回到 planner', '主智能体']],
      [
        'en',
        ['Other conversations', 'Read only', 'Back to planner', 'Main agent'],
      ],
      [
        'ja',
        ['ほかの会話', '閲覧のみ', 'planner に戻る', 'メインエージェント'],
      ],
    ] as const) {
      const h = front()
      h.chat.seed('mine', MAIN, 0, false, 'mine', false, true)
      h.chat.seed('older', MAIN, DAY)
      const withLang = (path: string) => {
        const plain = browse(path, ADMIN)
        return new Request(plain.url, {
          headers: {
            ...Object.fromEntries(plain.headers),
            cookie: `qianmo_lang=${lang}`,
          },
        })
      }
      for (const face of ['/', '/app']) {
        const page = await (await h.handle(withLang(face))).text()
        expect(page).toContain(`<html lang="${lang}"`)
        // The agent's own conversation is on screen, the older one under ⋯.
        expect(page).toContain('data-session="mine"')
        expect(page).toContain('data-resident="1"')
        const menu = region(page, 'fx-agents', '</section>')
        expect(menu).toContain(
          `data-action="fx-others" data-address="${ADDRESS}">`,
        )
        expect(menu).toContain(`${words[0]}<span class="fx-menu-count">1<`)
        expect(region(page, 'fx-others', '</dialog>')).toContain(
          `>${words[0]}<`,
        )
        expect(page).toContain(`>${words[3]}<`)
        const older = await (
          await h.handle(withLang(`${face}?session=older`))
        ).text()
        expect(
          /<div class="fx-thread" id="fx-thread"[^>]*>/.exec(older)?.[0],
        ).toContain('data-readonly="1"')
        expect(older).toContain(`>${words[1]}<`)
        expect(older).toContain(`${words[2]}</button>`)
      }
    }
  })
})

test('previews are plain text on every face: agent rows, the running strip and the notification body', async () => {
  const h = front()
  const answer =
    '## 路由\n- 补了 `GET /app`\n\n```ts\nGET /app/quick\n```\n见 [文档](https://example.com) **完**'
  h.chat.seed('talk', MAIN, 0, false, 'talk', false, true)
  h.chat.seed('sub', REVIEWER, 1, true, '看下 `bun test` **为啥** 红')
  for (const [id, preview] of [
    ['talk', answer],
    ['sub', answer],
  ] as const) {
    const session = h.chat.sessionsById.get(id)
    if (session === undefined) throw new Error('seed missing')
    h.chat.sessionsById.set(id, { ...session, preview })
  }
  const plain = '路由 补了 GET /app GET /app/quick 见 文档 完'
  const agents = await (await h.handle(browse('/', ADMIN))).text()
  const main = region(agents, 'fx-agents', '</section>')
  expect(main).toContain(`>${plain}<`)
  const stack = region(agents, 'fx-stack', '</details>')
  expect(stack).toContain('>看下 bun test 为啥 红<')
  const app = await (await h.handle(browse('/app', ADMIN))).text()
  // The desktop app's notification body is the row's second line.
  const rows = region(app, 'fx-agents', '</section>')
  expect(rows).toContain(`<span class="fx-agent-sub">${plain}</span>`)
  for (const html of [main, stack, rows]) {
    expect(html).not.toContain('```')
    expect(html).not.toContain('**')
    expect(html).not.toContain('](')
  }
})

describe("the desktop app's platform on the page", () => {
  async function tag(path: string, cookie: string): Promise<string> {
    const plain = browse(path, ADMIN)
    const page = await (
      await front().handle(
        new Request(plain.url, {
          headers: { ...Object.fromEntries(plain.headers), cookie },
        }),
      )
    ).text()
    return /<html[^>]*>/.exec(page)?.[0] ?? ''
  }

  test('only macos, windows and linux reach <html data-shell>; a browser page is unchanged', async () => {
    for (const path of ['/', '/app', '/app/quick']) {
      for (const shell of ['macos', 'windows', 'linux']) {
        expect(await tag(path, `qianmo_shell=${shell}`)).toBe(
          `<html lang="zh-CN" data-theme="system" data-shell="${shell}">`,
        )
      }
      for (const cookie of [
        '',
        'qianmo_shell=ios',
        'qianmo_shell=%22%3E%3Cscript%3E',
        'qianmo_shell=MACOS',
        'qianmo_shellx=macos',
      ]) {
        expect(await tag(path, cookie)).toBe(
          '<html lang="zh-CN" data-theme="system">',
        )
      }
    }
    expect(
      await tag(
        '/app',
        'qianmo_theme=dark; qianmo_shell=macos; qianmo_lang=en',
      ),
    ).toBe('<html lang="en" data-theme="dark" data-shell="macos">')
  })
})
