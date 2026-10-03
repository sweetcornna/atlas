// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Presenting by role (C7): a credential that may not write is shown no write
 * control, anywhere, and is told once that the page is read-only.
 *
 * A scan rather than a list of known buttons, so a page added later is
 * covered the day it lands: every document and fragment a read-only caller
 * can reach is searched for the marks a write control carries — `data-write`
 * (the convention, `routes/shared.ts` `canWrite`), the write `data-action`s
 * that predate it, a dialog to submit, a form that is not a plain GET. The
 * same scan run as a writer must find them, or the scan has gone blind.
 */

import { describe, expect, test } from 'bun:test'
import { ROUTES } from '../src/routes/index.js'
import { accountsHarness, asSession, person } from './accountsHarness.js'
import {
  ADMIN,
  PageNotes,
  TRACE,
  VIEW,
  browse,
  pageHarness,
} from './pageHarness.js'

/** The write `data-action`s that were written before `data-write` existed. */
const WRITE_ACTIONS = [
  'heartbeat',
  'deregister',
  'server-note',
  'confirm-deregister',
  'confirm-wake',
  'chat-new',
]

/** Everything in a document that would let its reader change something. */
function writeMarks(html: string): readonly string[] {
  const markup = html.replace(/<script>[\s\S]*?<\/script>/g, '')
  const found: string[] = []
  if (/\sdata-write[\s>=]/.test(markup)) found.push('data-write')
  for (const action of WRITE_ACTIONS) {
    if (markup.includes(`data-action="${action}"`)) found.push(action)
  }
  for (const dialog of ['register-dialog', 'wake-dialog']) {
    if (markup.includes(dialog)) found.push(dialog)
  }
  for (const form of markup.match(/<form[^>]*>/g) ?? []) {
    const plainGet = /method="get"/i.test(form)
    const logout = form.includes('id="logout-form"')
    if (!plainGet && !logout) found.push(form)
  }
  return found
}

/** Every path a caller can read: the pages, two sub-pages, the fragments. */
const READABLE = [
  ...ROUTES.map(module => module.area.href),
  '/nodes/tokyo-1',
  `/audit/trace/${TRACE}`,
  '/fragments/roster',
  '/fragments/roster?node=tokyo-1',
  '/fragments/audit',
  '/fragments/limits',
  `/fragments/chain/${TRACE}`,
]

function harness() {
  return pageHarness({
    chat: true,
    nodeServers: [{ node: 'tokyo-1', server: 'p11' }],
    serverNotes: new PageNotes(),
  })
}

describe('a read-only token', () => {
  test('is shown no write control on any page or fragment', async () => {
    const h = harness()
    let read = 0
    for (const path of READABLE) {
      const response = await h.handle(browse(path, VIEW))
      // The conversation is not readable at all with a view token.
      if (path === '/chat') {
        expect(response.status).toBe(403)
        continue
      }
      expect(`${path} ${response.status}`).toBe(`${path} 200`)
      expect(`${path} ${writeMarks(await response.text()).join(',')}`).toBe(
        `${path} `,
      )
      read += 1
    }
    expect(read).toBe(READABLE.length - 1)
  })

  test('is told, once, in the top bar of the page that would have had them', async () => {
    const h = harness()
    const page = await (await h.handle(browse('/nodes', VIEW))).text()
    expect(page).toContain(
      '<span class="note" id="read-only">只读 · 写操作需要管理令牌</span>',
    )
    expect(page.match(/id="read-only"/g)).toHaveLength(1)
    // And still sees everything there is to read.
    expect(page).toContain('qianmo://tokyo-1/')
    expect(page).toContain('<div class="row-panel">')
    const servers = await (await h.handle(browse('/servers', VIEW))).text()
    expect(servers).toContain('只读令牌不能改备注')
  })

  test('the admin token, scanned the same way, finds them — the scan is not blind', async () => {
    const h = harness()
    const nodes = writeMarks(
      await (await h.handle(browse('/nodes', ADMIN))).text(),
    )
    for (const mark of [
      'data-write',
      'heartbeat',
      'deregister',
      'confirm-deregister',
      'confirm-wake',
      'register-dialog',
      'wake-dialog',
    ]) {
      expect(nodes).toContain(mark)
    }
    const servers = writeMarks(
      await (await h.handle(browse('/servers', ADMIN))).text(),
    )
    expect(servers).toContain('server-note')
    const chat = writeMarks(
      await (await h.handle(browse('/chat', ADMIN))).text(),
    )
    expect(chat).toContain('chat-new')
    expect(chat).toContain('data-write')
    const admin = await (await h.handle(browse('/nodes', ADMIN))).text()
    expect(admin).not.toContain('id="read-only"')
  })
})

describe('personal accounts', () => {
  async function scan(role: 'viewer' | 'member' | 'ops') {
    const h = accountsHarness()
    const who = await person(h.handle, role)
    const marks: Record<string, readonly string[]> = {}
    for (const path of READABLE) {
      const response = await h.handle(
        asSession('GET', path, who.sid, {
          // A fragment is a guarded route: a cookie needs the console
          // header there, the way the page script sends it.
          header: path.startsWith('/fragments'),
          accept: 'text/html',
        }),
      )
      if (response.status !== 200) continue
      marks[path] = writeMarks(await response.text())
    }
    return { marks, h, who }
  }

  test('a viewer and a member see no write control outside the conversation', async () => {
    for (const role of ['viewer', 'member'] as const) {
      const { marks } = await scan(role)
      expect(Object.keys(marks).length).toBeGreaterThan(10)
      for (const [path, found] of Object.entries(marks)) {
        // The conversation is a member's own (`routes/chat.ts`); its
        // controls are theirs to use.
        if (path === '/chat') continue
        expect(`${role} ${path} ${found.join(',')}`).toBe(`${role} ${path} `)
      }
    }
  })

  test('the read-only line names the role that may write', async () => {
    const { h, who } = await scan('viewer')
    const page = await (
      await h.handle(asSession('GET', '/nodes', who.sid, { header: false }))
    ).text()
    expect(page).toContain('只读 · 写操作需要运维角色')
  })

  test('an ops account gets the controls', async () => {
    const { marks } = await scan('ops')
    expect(marks['/nodes']).toContain('register-dialog')
    expect(marks['/nodes']).toContain('data-write')
  })
})
