// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 广泛性工作 on the front (P37.17 B, `docs/dev/work-tasks.md` §9): which list
 * a work session is in and its state, the new work page, the `/` menu's
 * workflows, file cards, the activity panel's three parts, and who may write
 * in a work session. The `/v0/work/*` routes are the node branch's; here the
 * hub's records carry the documented shapes (`workFake.ts`).
 */

import { describe, expect, test } from 'bun:test'
import type { ChatTarget, ChatTurn } from '../src/deps.js'
import { cspFor } from '../src/respond.js'
import { WORKFLOWS } from '../src/work.js'
import { WORK_TEXT } from '../src/view/frontWork.js'
import {
  ADDRESS,
  accountsHarness,
  asSession,
  person,
} from './accountsHarness.js'
import { ADMIN, NOW, browse, pageHarness, visibleText } from './pageHarness.js'
import { WorkChat, fileRef } from './workFake.js'

const MAIN: ChatTarget = {
  address: ADDRESS,
  node: 'tokyo-1',
  agent: 'planner',
  endpoint: 'ws://127.0.0.1:38611/',
  status: 'online',
  dialable: true,
}
const REVIEWER = 'qianmo://tokyo-1/reviewer'

/** A front over a chat port with one work session and a resident one. */
async function seeded() {
  const chat = new WorkChat()
  chat.moreTargets.push({ ...MAIN, address: REVIEWER, agent: 'reviewer' })
  const resident = await chat.open(ADDRESS, { resident: true })
  const work = await chat.open(REVIEWER, { work: true, workflow: 'slides' })
  if (!resident.ok || !work.ok) throw new Error('no sessions')
  const h = pageHarness({ chat: true, ports: { chat } })
  return { h, chat, resident: resident.value.id, work: work.value.id }
}

async function page(
  h: ReturnType<typeof pageHarness>,
  path: string,
  lang?: string,
): Promise<string> {
  const request = browse(path, ADMIN)
  if (lang !== undefined) request.headers.set('cookie', `qianmo_lang=${lang}`)
  const response = await h.handle(request)
  expect(response.status).toBe(200)
  return await response.text()
}

/** The opening tag of the element with `id`. */
function tagOf(html: string, id: string): string {
  return new RegExp(`<[a-z]+ [^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? ''
}

function rowOf(html: string, session: string): string {
  return (
    new RegExp(
      `<div class="fx-ritem-row[^"]*" data-session="${session}"[^>]*>`,
    ).exec(html)?.[0] ?? ''
  )
}

describe('a work session in the side list', () => {
  test('is listed by day under the agents with its workflow and state, not under its agent', async () => {
    const { h, chat, work } = await seeded()
    const html = await page(h, '/')
    const recents = html.slice(html.indexOf('id="fx-recents"'))
    expect(rowOf(recents, work)).toContain('data-work="1"')
    expect(rowOf(recents, work)).toContain('data-state="done"')
    // Not reviewer's row: no 其他对话 count and no busy mark for it.
    const agents = html.slice(
      html.indexOf('id="fx-agents"'),
      html.indexOf('id="fx-recents"'),
    )
    expect(agents).not.toContain('data-action="fx-others"')
    const history = html.slice(html.indexOf('id="fx-history"'))
    expect(history).not.toContain(`data-session="${work}"`)
    chat.add(
      work,
      {
        id: 'ask',
        sessionId: work,
        author: 'operator',
        at: NOW,
        text: '做一份季度汇报',
        state: 'read',
      },
      true,
    )
    const side = await (
      await h.handle(browse('/fragments/chat/front/side', ADMIN))
    ).text()
    expect(rowOf(side, work)).toContain('data-state="running"')
    expect(side).toContain('fx-wstate-waiting')
  })

  test('the side starts a task above search, on both faces', async () => {
    const { h } = await seeded()
    for (const [path, href] of [
      ['/', '/?work=new'],
      ['/app', '/app?work=new'],
    ] as const) {
      const html = await page(h, path)
      const row = tagOf(html, 'fx-new-work')
      expect(row).toContain(`href="${href}"`)
      expect(html.indexOf('id="fx-new-work"')).toBeLessThan(
        html.indexOf('id="fx-search"'),
      )
    }
  })
})

describe('the new work page', () => {
  test('six workflow cards in order over the composer, with who does it', async () => {
    const { h, chat } = await seeded()
    const reads = chat.transcripts
    for (const path of ['/?work=new', '/app?work=new']) {
      const html = await page(h, path)
      const thread = tagOf(html, 'fx-thread')
      expect(thread).toContain('data-new-work="1"')
      expect(thread).toContain('data-start="1"')
      expect(thread).not.toContain('data-session')
      const cards = [
        ...html.matchAll(
          /class="fx-flow" data-action="fx-flow" data-workflow="([a-z]+)"/g,
        ),
      ].map(match => match[1])
      expect(cards).toEqual(WORKFLOWS.map(flow => flow.id))
      expect(tagOf(html, 'fx-agent-pick')).not.toContain('hidden')
      expect(html).toContain('id="fx-agent-menu"')
      expect(html).toContain(
        `class="fx-pick-head fx-pick-head-work">${WORK_TEXT['zh-CN'].whoDoes}<`,
      )
    }
    // Nothing was read to draw it.
    expect(chat.transcripts).toBe(reads)
  })

  test('the page in each language', async () => {
    const { h } = await seeded()
    for (const lang of ['zh-CN', 'en', 'ja'] as const) {
      const w = WORK_TEXT[lang]
      const text = visibleText(await page(h, '/?work=new', lang))
      expect(text).toContain(w.newWork)
      for (const flow of WORKFLOWS) expect(text).toContain(w.flowNames[flow.id])
    }
  })

  test('the view fragment draws it without a reading', async () => {
    const { h, chat } = await seeded()
    const reads = chat.transcripts
    const response = await h.handle(
      browse(
        `/fragments/chat/front/view?work=new&agent=${encodeURIComponent(REVIEWER)}`,
        ADMIN,
      ),
    )
    const html = await response.text()
    expect(tagOf(html, 'fx-thread')).toContain(`data-target="${REVIEWER}"`)
    expect(tagOf(html, 'fx-thread')).toContain('data-new-work="1"')
    expect(chat.transcripts).toBe(reads)
  })

  test('the / menu lists the workflows before the local commands', async () => {
    const { h } = await seeded()
    const html = await page(h, '/?work=new')
    const menu = html.slice(
      html.indexOf('id="fx-cmds"'),
      html.indexOf('</div>', html.indexOf('id="fx-cmds"')),
    )
    const flows = [...menu.matchAll(/data-flow="([a-z]+)"/g)].map(
      match => match[1],
    )
    expect(flows).toEqual(WORKFLOWS.map(flow => flow.id))
    expect(menu.indexOf('data-flow="analysis"')).toBeLessThan(
      menu.indexOf('data-cmd="/compact"'),
    )
    expect(menu).toContain('data-alt="/演示文稿"')
  })
})

describe('files and the activity panel', () => {
  test('a delivery is a card in any conversation; the panel only in a work session', async () => {
    const { h, chat, resident, work } = await seeded()
    const files = [
      fileRef('季度 汇报.pptx', 'presentation', 81_234, true, '季度汇报'),
      fileRef('数据/原始.csv', 'spreadsheet', 2_048, false),
    ]
    chat.deliver(resident, files, NOW)
    chat.deliver(work, files, NOW)
    for (const id of [resident, work]) {
      const html = await page(h, `/?session=${id}`)
      const thread = html.slice(
        html.indexOf('id="fx-thread"'),
        html.indexOf('class="fx-dock"'),
      )
      expect(thread).toContain('class="fx-files"')
      expect(thread).toContain(
        `href="/v0/work/sessions/${id}/file?name=${encodeURIComponent('季度 汇报.pptx')}"`,
      )
      expect(thread).toContain(`download="${'原始.csv'}"`)
      expect(thread).toContain('data-action="fx-preview"')
      expect((thread.match(/data-action="fx-preview"/g) ?? []).length).toBe(1)
      expect(visibleText(thread)).toContain('演示文稿 · 79.3 KiB')
      const activity = tagOf(html, 'fx-activity')
      if (id === resident) expect(activity).toContain('hidden')
      else expect(activity).not.toContain('hidden')
    }
  })

  test('a line sent with a workflow carries its tag', async () => {
    const { h, chat, work } = await seeded()
    chat.add(work, {
      id: 'asked',
      sessionId: work,
      author: 'operator',
      at: NOW,
      text: '再出一版英文的',
      state: 'read',
      workflow: 'document',
    })
    chat.add(work, {
      id: 'plain',
      sessionId: work,
      author: 'operator',
      at: NOW + 1,
      text: '标题改短一点',
      state: 'read',
    })
    const html = await page(h, `/?session=${work}`)
    const thread = html.slice(
      html.indexOf('id="fx-thread"'),
      html.indexOf('class="fx-dock"'),
    )
    const tags = [
      ...thread.matchAll(/class="fx-flow-tag" data-workflow="([a-z]+)"/g),
    ]
    expect(tags.map(match => match[1])).toEqual(['document'])
    expect(visibleText(thread)).toContain(WORK_TEXT['zh-CN'].flowNames.document)
  })

  test('progress only with a todo list, outputs as delivered, context when there is some', async () => {
    const { h, chat, work } = await seeded()
    let html = await page(h, `/?session=${work}`)
    let panel = html.slice(
      html.indexOf('id="fx-activity"'),
      html.indexOf('id="fx-panel-body"'),
    )
    expect(panel).not.toContain('fx-act-progress')
    expect(visibleText(panel)).toContain('还没有产出')
    // The session's own workflow is context already.
    expect(visibleText(panel)).toContain('演示文稿')
    chat.report(work, {
      progress: {
        taskId: 't1',
        at: NOW,
        total: 3,
        done: 1,
        step: 2,
        current: '写大纲',
        items: [
          { phase: '准备', content: '读资料', status: 'completed' },
          { phase: '准备', content: '写大纲', status: 'in_progress' },
          { phase: '成稿', content: '出 pptx', status: 'pending' },
        ],
      },
      context: {
        taskId: 't1',
        at: NOW,
        workflows: ['slides'],
        skills: ['qmo-slides', 'pdf-notes'],
        tools: [{ name: 'read', count: 3 }],
        files: ['资料/年报.md'],
      },
    })
    html = await page(h, `/?session=${work}`)
    panel = html.slice(
      html.indexOf('id="fx-activity"'),
      html.indexOf('id="fx-panel-body"'),
    )
    const text = visibleText(panel)
    expect(text).toContain('第 2 / 3 步')
    expect(text).toContain('写大纲')
    expect(text).toContain('pdf-notes')
    expect(text).not.toContain('qmo-slides')
    expect(text).toContain('read')
    expect(text).toContain('×3')
    expect(text).toContain('资料/年报.md')
    chat.report(work, {
      progress: {
        taskId: 't2',
        at: NOW,
        total: 0,
        done: 0,
        step: 0,
        current: null,
        items: [],
      },
      context: null,
    })
    html = await page(h, `/?session=${work}`)
    expect(html).not.toContain('fx-act-progress')
  })

  test('the preview holds no frame until it opens, and the page may frame only itself', async () => {
    const { h, work } = await seeded()
    const html = await page(h, `/?session=${work}`)
    expect(tagOf(html, 'fx-preview')).toContain('<dialog')
    expect(html).not.toContain('<iframe')
    expect(tagOf(html, 'fx-preview-body')).toContain('data-frame-title="预览"')
    expect(cspFor([])).toContain("frame-src 'self'")
    expect(html).toContain('id="fx-file-tpl"')
  })
})

describe('who writes in a work session', () => {
  test('its owner writes; anyone else reads it', async () => {
    const chat = new WorkChat()
    const hub = accountsHarness({ deps: { chat } })
    const member = await person(hub.handle, 'member')
    const ops = await person(hub.handle, 'ops')
    const opened = await chat.open(ADDRESS, { work: true })
    if (!opened.ok) throw new Error('no session')
    const principal = hub.book.bearerPrincipal(member.credential)
    if (!principal.ok || principal.value.kind !== 'user')
      throw new Error('no principal')
    hub.book.recordOwner(opened.value.id, principal.value.subject)
    const view = async (sid: string): Promise<string> => {
      const response = await hub.handle(
        asSession('GET', `/?session=${opened.value.id}`, sid, {
          header: false,
        }),
      )
      return tagOf(await response.text(), 'fx-thread')
    }
    expect(await view(member.sid)).toContain('data-work="1"')
    expect(await view(member.sid)).not.toContain('data-readonly')
    expect(await view(ops.sid)).toContain('data-readonly="1"')
  })
})
