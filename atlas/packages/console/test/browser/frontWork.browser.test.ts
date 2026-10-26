// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 广泛性工作 in a real browser (P37.17 B, `docs/dev/work-tasks.md` §9): the
 * new work page's cards and `/` menu set the workflow, the first line opens
 * the work in one request with who does it, the work is listed by day with
 * its state, the activity panel opens on its own with its three parts, the
 * outputs come from the folder, and a preview runs nothing.
 *
 * The hub's `/v0/work/*` is the node branch's; here `WorkRoutes` answers
 * them in the documented shapes in front of the real console handler.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ApprovalItem, ApprovalPort } from '../../src/governance.js'
import {
  ADDRESS,
  accountsHarness,
  type Person,
  person,
  START,
} from '../accountsHarness.js'
import { type FakeOutput, fileRef, WorkChat, WorkRoutes } from '../workFake.js'
import { Browser, skipReason, type Tab } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[front work browser] skipped: ${SKIP}`)

const REVIEWER = 'qianmo://tokyo-1/reviewer'

/**
 * What a preview gives: a heading, and a script that must not run. Were it
 * to run it would say so to the page: a message crosses even the opaque
 * origin a sandbox gives the frame.
 */
const PREVIEW =
  '<!doctype html><meta charset="utf-8"><title>季度汇报</title>' +
  '<h1>季度汇报</h1>' +
  '<script>parent.postMessage("ran " + window.name, "*")</script>'

/** Until the composer has finished with the line it sent. */
const SETTLED = `!document.getElementById('fx-composer').hasAttribute('aria-busy')`

function output(
  name: string,
  kind: FakeOutput['kind'],
  size: number,
  preview: boolean,
  more: Partial<FakeOutput> = {},
): FakeOutput {
  return {
    name,
    size,
    kind,
    mime: 'application/octet-stream',
    mtime: START,
    preview,
    ...more,
  }
}

/** Approvals whose items wait on whoever lists them. */
function approvals(items: ApprovalItem[]): ApprovalPort {
  const none = {
    ok: false,
    failure: { code: 'refused', message: '不在' },
  } as const
  return {
    async list(principal) {
      return {
        ok: true,
        value: items.map(one => ({ ...one, owner: principal.subject })),
      }
    },
    async decide() {
      return none
    },
    async continue() {
      return none
    },
    async revoke() {
      return { ok: true, value: { delivered: true } }
    },
  }
}

/** A hub with planner (the main agent) and reviewer, and the work routes. */
async function hub(items: ApprovalItem[] = []) {
  const chat = new WorkChat()
  chat.moreTargets.push({
    address: REVIEWER,
    node: 'tokyo-1',
    agent: 'reviewer',
    endpoint: 'ws://127.0.0.1:38612/',
    status: 'online',
    dialable: true,
  })
  const h = accountsHarness({ deps: { chat, approvals: approvals(items) } })
  const ops = await person(h.handle, 'ops')
  const work = new WorkRoutes({
    chat,
    handle: h.handle,
    book: h.book,
    main: ADDRESS,
  })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => work.fetch(request),
  })
  return {
    h,
    chat,
    ops,
    work,
    base: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true)
    },
  }
}

async function signIn(tab: Tab, base: string, who: Person): Promise<void> {
  await tab.send('Network.setCookie', {
    name: 'qianmo_session',
    value: who.sid,
    url: base,
    httpOnly: true,
    sameSite: 'Strict',
  })
}

async function press(
  tab: Tab,
  key: string,
  code: string,
  vk: number,
  modifiers = 0,
): Promise<void> {
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

/** The session the page shows, once it shows one. */
async function shownSession(tab: Tab): Promise<string> {
  await tab.waitFor(
    `location.search.startsWith('?session=') && document.getElementById('fx-thread').getAttribute('data-work') === '1'`,
  )
  return await tab.evaluate<string>(
    `document.getElementById('fx-thread').getAttribute('data-session')`,
  )
}

describe.skipIf(SKIP !== null)('广泛性工作 on the front', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await Browser.launch()
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
  }, 30_000)

  test('a card or / sets the workflow, the first line opens the work with the main agent, and it is listed by day', async () => {
    const served = await hub()
    const tab = await browser.tab()
    try {
      await signIn(tab, served.base, served.ops)
      await tab.goto(`${served.base}/?work=new`)
      await tab.waitFor(
        `document.getElementById('fx-thread').getAttribute('data-new-work') === '1'`,
      )
      expect(
        await tab.evaluate<[number, boolean, string]>(`[
          document.querySelectorAll('#fx-thread .fx-flow').length,
          document.getElementById('fx-agent-pick').hidden,
          document.getElementById('fx-text').getAttribute('placeholder'),
        ]`),
      ).toEqual([6, false, '描述要做的事'])
      // A card is the chip; the card again takes it off.
      const chip = `[document.getElementById('fx-flow-chip').hidden, document.getElementById('fx-flow-chip-name').textContent, document.querySelector('.fx-flow[data-workflow="slides"]').getAttribute('aria-pressed')]`
      await tab.evaluate(
        `document.querySelector('.fx-flow[data-workflow="slides"]').click()`,
      )
      expect(await tab.evaluate<unknown[]>(chip)).toEqual([
        false,
        '演示文稿',
        'true',
      ])
      await tab.evaluate(
        `document.querySelector('.fx-flow[data-workflow="slides"]').click()`,
      )
      expect(await tab.evaluate<unknown[]>(chip)).toEqual([true, '', 'false'])
      // `/` lists the workflows only, matched by either name.
      await tab.evaluate(`document.getElementById('fx-text').focus()`)
      await tab.send('Input.insertText', { text: '/调研' })
      await tab.waitFor(`!document.getElementById('fx-cmds').hidden`)
      expect(
        await tab.evaluate<string[]>(
          `[...document.querySelectorAll('#fx-cmds .fx-cmd:not([hidden])')].map(el => el.getAttribute('data-flow'))`,
        ),
      ).toEqual(['research'])
      await press(tab, 'Enter', 'Enter', 13)
      expect(
        await tab.evaluate<[string, boolean, string]>(
          `[document.getElementById('fx-text').value, document.getElementById('fx-flow-chip').hidden, document.getElementById('fx-flow-chip-name').textContent]`,
        ),
      ).toEqual(['', false, '调研报告'])
      await tab.send('Input.insertText', { text: '调研三家同类产品的定价' })
      await press(tab, 'Enter', 'Enter', 13)
      const id = await shownSession(tab)
      await tab.waitFor(SETTLED)
      // One request opened it and carried the line; the main agent is not named.
      expect(served.work.opens).toEqual([
        { text: '调研三家同类产品的定价', workflow: 'research' },
      ])
      expect(served.chat.sessionsById.get(id)?.target).toBe(ADDRESS)
      expect(
        await tab.evaluate<boolean>(
          `document.getElementById('fx-flow-chip').hidden`,
        ),
      ).toBe(true)
      // Listed by day, working, and the side's new-task row is not current.
      const row = `#fx-recents .fx-ritem-row[data-session="${id}"]`
      await tab.waitFor(`document.querySelector('${row}') !== null`)
      expect(
        await tab.evaluate<[string, string, boolean]>(
          `[document.querySelector('${row}').getAttribute('data-work'), document.querySelector('${row}').getAttribute('data-state'), document.getElementById('fx-new-work').getAttribute('aria-current') === 'true']`,
        ),
      ).toEqual(['1', 'running', false])
      // The panel opened by itself on the work, with no outputs yet.
      await tab.waitFor(
        `document.getElementById('fx').getAttribute('data-panel') === 'open' && !document.getElementById('fx-activity').hidden`,
      )
      // A second line in the open work, with another workflow.
      await tab.evaluate(
        `document.querySelector('#fx-cmds [data-flow="document"]').click()`,
      )
      await tab.send('Input.insertText', { text: '再出一份文档版' })
      await press(tab, 'Enter', 'Enter', 13)
      await tab.waitFor(
        `document.getElementById('fx-text').value === '' && document.getElementById('fx-flow-chip').hidden`,
      )
      await tab.waitFor(SETTLED)
      // A local command never goes with a workflow.
      await tab.evaluate(
        `document.querySelector('#fx-cmds [data-flow="sheet"]').click()`,
      )
      await tab.send('Input.insertText', { text: '/compact' })
      await press(tab, 'Escape', 'Escape', 27)
      await press(tab, 'Enter', 'Enter', 13)
      await tab.waitFor(`document.getElementById('fx-text').value === ''`)
      await tab.waitFor(SETTLED)
      expect(served.work.messages.map(body => body['workflow'])).toEqual([
        'document',
        undefined,
      ])
      // ⌘⇧O comes back to a new task.
      await tab.evaluate(`window.__sameDocument = true`)
      await press(tab, 'O', 'KeyO', 79, 10)
      await tab.waitFor(
        `location.search === '?work=new' && document.getElementById('fx-new-work').getAttribute('aria-current') === 'true'`,
      )
      // The list's row goes back to the work, the side's row to a new one,
      // both without loading another document.
      await tab.evaluate(
        `document.querySelector('${row} [data-action="fx-open"]').click()`,
      )
      await tab.waitFor(
        `location.search === '?session=${id}' && document.getElementById('fx-thread').getAttribute('data-work') === '1'`,
      )
      await tab.evaluate(`document.getElementById('fx-new-work').click()`)
      await tab.waitFor(
        `location.search === '?work=new' && document.getElementById('fx-thread').getAttribute('data-new-work') === '1'`,
      )
      expect(
        await tab.evaluate<boolean>(`window.__sameDocument === true`),
      ).toBe(true)
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)

  test('who does it: another agent is picked on the page; a first line that did not go still enters the work', async () => {
    const served = await hub()
    served.work.firstLineFails = true
    const tab = await browser.tab()
    try {
      await signIn(tab, served.base, served.ops)
      await tab.goto(`${served.base}/app?work=new`)
      await tab.waitFor(
        `document.getElementById('fx-thread').getAttribute('data-new-work') === '1'`,
      )
      await tab.evaluate(`document.getElementById('fx-agent-btn').click()`)
      await tab.waitFor(
        `document.querySelector('#fx-agent-menu [data-agent-pick="${REVIEWER}"]') !== null`,
      )
      await tab.evaluate(
        `document.querySelector('#fx-agent-menu [data-agent-pick="${REVIEWER}"]').click()`,
      )
      await tab.waitFor(
        `document.getElementById('fx-agent-name').textContent === 'reviewer'`,
      )
      expect(
        await tab.evaluate<[string, string]>(
          `[location.search, document.getElementById('fx-thread').getAttribute('data-new-work')]`,
        ),
      ).toEqual(['?work=new', '1'])
      await tab.evaluate(`document.getElementById('fx-text').focus()`)
      await tab.send('Input.insertText', { text: '复核这份合同' })
      await press(tab, 'Enter', 'Enter', 13)
      const id = await shownSession(tab)
      expect(served.work.opens).toEqual([
        { text: '复核这份合同', agent: REVIEWER },
      ])
      expect(served.chat.sessionsById.get(id)?.target).toBe(REVIEWER)
      await tab.waitFor(
        `document.getElementById('fx-text').value === '复核这份合同' && document.getElementById('fx-status').textContent !== ''`,
      )
      expect(
        await tab.evaluate<boolean>(
          `document.getElementById('fx-text').disabled`,
        ),
      ).toBe(false)
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)

  test('progress, the outputs folder over the deliveries, and a preview that runs nothing', async () => {
    const served = await hub()
    const opened = await served.chat.open(ADDRESS, {
      work: true,
      workflow: 'slides',
    })
    if (!opened.ok) throw new Error('no session')
    const id = opened.value.id
    const principal = served.h.book.bearerPrincipal(served.ops.credential)
    if (!principal.ok || principal.value.kind !== 'user')
      throw new Error('no principal')
    served.h.book.recordOwner(id, principal.value.subject)
    served.chat.add(id, {
      id: 'asked',
      sessionId: id,
      author: 'operator',
      at: START,
      text: '做一份季度汇报',
      state: 'read',
      workflow: 'slides',
    })
    served.chat.deliver(
      id,
      [fileRef('季度汇报.pptx', 'presentation', 812_000, true, '季度汇报')],
      START + 1,
    )
    served.work.outputs.set(id, [
      output('notes/大纲.md', 'text', 2_300, true),
      output('季度汇报.pptx', 'presentation', 812_000, true, { body: PREVIEW }),
      output('素材.mov', 'other', 60 * 1024 * 1024, false, { tooLarge: true }),
    ])
    const tab = await browser.tab()
    try {
      await signIn(tab, served.base, served.ops)
      await tab.goto(`${served.base}/?session=${id}`)
      await tab.waitFor(
        `document.getElementById('fx').getAttribute('data-panel') === 'open'`,
      )
      // The folder's list replaces what was delivered, newest first.
      await tab.waitFor(
        `document.getElementById('fx-outputs').getAttribute('data-from') === 'outputs'`,
      )
      expect(
        await tab.evaluate<string[]>(
          `[...document.querySelectorAll('#fx-outputs .fx-file')].map(el => [el.getAttribute('data-name'), el.getAttribute('data-kind'), el.querySelectorAll('.fx-file-mark svg').length, el.querySelector('.fx-file-meta').textContent, el.querySelectorAll('[data-action="fx-preview"], a[download]').length, !!el.querySelector('.fx-file-note:not([hidden])')].join(' '))`,
        ),
      ).toEqual([
        'notes/大纲.md text 1 文本 · 2.2 KiB 2 false',
        '季度汇报.pptx presentation 1 演示文稿 · 793 KiB 2 false',
        '素材.mov other 1 文件 · 60 MiB 0 true',
      ])
      expect(served.work.reads).toEqual([`outputs ${id}`])
      // No progress until the node reports a todo list.
      expect(
        await tab.evaluate<boolean>(
          `document.querySelector('#fx-activity .fx-act-progress') === null`,
        ),
      ).toBe(true)
      served.chat.report(id, {
        progress: {
          taskId: 't1',
          at: START,
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
        context: null,
      })
      await tab.waitFor(
        `document.querySelector('#fx-activity .fx-act-progress') !== null`,
      )
      expect(
        await tab.evaluate<string>(
          `document.querySelector('#fx-activity .fx-act-progress').textContent`,
        ),
      ).toContain('第 2 / 3 步')

      // 预览: an empty sandbox, its address only now. The preview is served
      // here without its own policy, so what holds its script back is the
      // page's frame alone.
      served.work.previewPolicy = null
      await tab.evaluate(`(() => {
        window.__said = [];
        window.addEventListener('message', event => { window.__said.push(String(event.data)); });
      })()`)
      await tab.evaluate(
        `document.querySelector('#fx-thread [data-action="fx-preview"]').click()`,
      )
      await tab.waitFor(`document.getElementById('fx-preview').open`)
      expect(
        await tab.evaluate<
          [string | null, string, string, string, string]
        >(`(() => {
          const frame = document.querySelector('#fx-preview-body iframe');
          const down = document.getElementById('fx-preview-download');
          return [frame.getAttribute('sandbox'), frame.getAttribute('src'), document.getElementById('fx-preview-title').textContent, down.getAttribute('href'), down.getAttribute('download')];
        })()`),
      ).toEqual([
        '',
        `/v0/work/sessions/${id}/preview?name=${encodeURIComponent('季度汇报.pptx')}`,
        '季度汇报',
        `/v0/work/sessions/${id}/file?name=${encodeURIComponent('季度汇报.pptx')}`,
        '季度汇报.pptx',
      ])
      const asked = `preview ${'季度汇报.pptx'}`
      const deadline = Date.now() + 5_000
      while (!served.work.reads.includes(asked) && Date.now() < deadline)
        await Bun.sleep(50)
      expect(served.work.reads).toContain(asked)
      // The same file in a frame that may run scripts does say so: the
      // silence above is the sandbox, not a script that could not speak.
      await tab.evaluate(`(() => {
        const control = document.createElement('iframe');
        control.name = 'control';
        control.setAttribute('sandbox', 'allow-scripts');
        control.src = document.querySelector('#fx-preview-body iframe').getAttribute('src');
        document.body.appendChild(control);
      })()`)
      await tab.waitFor(`window.__said.includes('ran control')`)
      await Bun.sleep(300)
      expect(await tab.evaluate<string[]>(`window.__said`)).toEqual([
        'ran control',
      ])
      // The download is the file itself, on the login cookie.
      expect(
        await tab.evaluate<[number, string]>(
          `fetch(document.getElementById('fx-preview-download').href).then(r => [r.status, r.headers.get('content-disposition') || ''])`,
        ),
      ).toEqual([
        200,
        `attachment; filename*=UTF-8''${encodeURIComponent('季度汇报.pptx')}`,
      ])
      // Closed, nothing stays behind.
      await tab.evaluate(
        `document.querySelector('#fx-preview [data-action="confirm-cancel"]').click()`,
      )
      await tab.waitFor(
        `!document.getElementById('fx-preview').open && document.querySelector('#fx-preview-body iframe') === null`,
      )
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)

  test('a folder that cannot be listed keeps the deliveries', async () => {
    const served = await hub()
    served.work.listing = 501
    const opened = await served.chat.open(ADDRESS, { work: true })
    if (!opened.ok) throw new Error('no session')
    const id = opened.value.id
    const principal = served.h.book.bearerPrincipal(served.ops.credential)
    if (!principal.ok || principal.value.kind !== 'user')
      throw new Error('no principal')
    served.h.book.recordOwner(id, principal.value.subject)
    served.chat.deliver(
      id,
      [fileRef('报告.docx', 'document', 40_000, false)],
      START,
    )
    const tab = await browser.tab()
    try {
      await signIn(tab, served.base, served.ops)
      await tab.goto(`${served.base}/?session=${id}`)
      await tab.waitFor(
        `document.getElementById('fx').getAttribute('data-panel') === 'open'`,
      )
      const deadline = Date.now() + 5_000
      while (served.work.reads.length === 0 && Date.now() < deadline)
        await Bun.sleep(50)
      expect(served.work.reads).toEqual([`outputs ${id}`])
      expect(
        await tab.evaluate<[string, string[]]>(
          `[document.getElementById('fx-outputs').getAttribute('data-from'), [...document.querySelectorAll('#fx-outputs .fx-file')].map(el => el.getAttribute('data-name'))]`,
        ),
      ).toEqual(['delivered', ['报告.docx']])
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)

  test('等你: a request waiting on the reader marks the work in the list until it is decided', async () => {
    const items: ApprovalItem[] = []
    const served = await hub(items)
    const opened = await served.chat.open(ADDRESS, { work: true })
    if (!opened.ok) throw new Error('no session')
    const id = opened.value.id
    const principal = served.h.book.bearerPrincipal(served.ops.credential)
    if (!principal.ok || principal.value.kind !== 'user')
      throw new Error('no principal')
    served.h.book.recordOwner(id, principal.value.subject)
    served.chat.add(
      id,
      {
        id: 'asked',
        sessionId: id,
        author: 'operator',
        at: START,
        text: '把周报发给团队',
        state: 'read',
      },
      true,
    )
    items.push({
      requestId: 'mail-1',
      node: 'tokyo-1',
      agent: ADDRESS,
      contextId: id,
      owner: null,
      toolName: 'qianmo_mail_send',
      input: {
        connectorId: 'c1',
        to: 'a@example.com',
        subject: '周报',
        body: 'x',
      },
      digest: 'digest-mail-1',
      createdAt: START,
      expiresAt: START + 600_000,
      status: 'pending',
    })
    const tab = await browser.tab()
    try {
      await signIn(tab, served.base, served.ops)
      await tab.goto(`${served.base}/?work=new`)
      const row = `#fx-recents .fx-ritem-row[data-session="${id}"]`
      await tab.waitFor(
        `document.querySelector('${row}') && document.querySelector('${row}').getAttribute('data-asking') === '1'`,
      )
      const shown = `[...document.querySelectorAll('${row} .fx-wstate')].filter(el => getComputedStyle(el).display !== 'none').map(el => el.className.replace('fx-wstate ', ''))`
      expect(await tab.evaluate<string[]>(shown)).toEqual(['fx-wstate-waiting'])
      const first = items[0]
      if (first !== undefined) items[0] = { ...first, status: 'allowed' }
      await tab.waitFor(
        `!document.querySelector('${row}').hasAttribute('data-asking')`,
        8_000,
      )
      expect(await tab.evaluate<string[]>(shown)).toEqual(['fx-wstate-running'])
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)

  test('on a phone: cards two across, the panel stays shut, the preview fills the screen, nothing scrolls sideways', async () => {
    const served = await hub()
    const opened = await served.chat.open(ADDRESS, { work: true })
    if (!opened.ok) throw new Error('no session')
    const id = opened.value.id
    const principal = served.h.book.bearerPrincipal(served.ops.credential)
    if (!principal.ok || principal.value.kind !== 'user')
      throw new Error('no principal')
    served.h.book.recordOwner(id, principal.value.subject)
    served.chat.deliver(
      id,
      [
        fileRef(
          '一份名字很长很长的季度经营汇报终稿.pptx',
          'presentation',
          812_000,
          true,
        ),
      ],
      START,
    )
    const tab = await browser.tab({ width: 375, height: 812 })
    await tab.send('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true,
    })
    try {
      await signIn(tab, served.base, served.ops)
      await tab.goto(`${served.base}/?work=new`)
      await tab.waitFor('window.qianmoConsole !== undefined')
      expect(
        await tab.evaluate<[number, number, number]>(`(() => {
          const cards = [...document.querySelectorAll('#fx-thread .fx-flow')];
          const tops = new Set(cards.map(el => Math.round(el.getBoundingClientRect().top)));
          return [tops.size, document.documentElement.scrollWidth, document.documentElement.clientWidth];
        })()`),
      ).toEqual([3, 375, 375])
      await tab.goto(`${served.base}/?session=${id}`)
      await tab.waitFor('window.qianmoConsole !== undefined')
      expect(
        await tab.evaluate<[boolean, number]>(
          `[document.getElementById('fx').getAttribute('data-panel') === 'open', document.documentElement.scrollWidth]`,
        ),
      ).toEqual([false, 375])
      await tab.evaluate(
        `document.querySelector('#fx-thread [data-action="fx-preview"]').click()`,
      )
      await tab.waitFor(`document.getElementById('fx-preview').open`)
      expect(
        await tab.evaluate<[number, number]>(`(() => {
          const r = document.getElementById('fx-preview').getBoundingClientRect();
          return [Math.round(r.width), Math.round(r.height)];
        })()`),
      ).toEqual([375, 812])
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)
})
