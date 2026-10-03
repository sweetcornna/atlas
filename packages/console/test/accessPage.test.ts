// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.10 — the 账号与访问 page (H3, H4) over HTTP: its four tabs, who sees
 * which of them and which controls, what it says in every state, and that
 * it reads with script off.
 *
 * Every claim has its control beside it: the member who sees only their own
 * records is set against the ops account that sees the same entries of
 * somebody else; the reader who is shown no write control against the writer
 * whose same scan finds them; the 403 tab against the 200 one.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { resolveAccess } from '../src/access.js'
import { ActionLedger } from '../src/actionLedger.js'
import type { ActionLedgerPort } from '../src/deps.js'
import { accessRoute } from '../src/routes/access.js'
import {
  ADDRESS,
  ADMIN,
  BASE,
  HOUR,
  MemoryLedger,
  TOKENS,
  VIEW,
  accountsHarness,
  asBearer,
  asSession,
  cookieFrom,
  credentialOn,
  formPost,
  invite,
  type AccountsHarness,
  type Person,
  person,
} from './accountsHarness.js'
import { MemoryActionStore } from './actionStore.js'
import { MemoryActionLedger } from './memoryActions.js'
import {
  browse,
  pageHarness,
  visibleText,
  withoutScripts,
} from './pageHarness.js'

const decoder = new TextDecoder()
const readers: ReadableStreamDefaultReader<Uint8Array>[] = []

afterEach(async () => {
  for (const reader of readers.splice(0)) {
    await reader.cancel().catch(() => {})
  }
})

// --- helpers ---------------------------------------------------------------

function subjectOf(h: AccountsHarness, who: Person): `u:${string}` {
  const access = resolveAccess(
    asSession('GET', '/v0/limits', who.sid),
    TOKENS,
    { book: h.book },
    false,
  )
  if (access.principal?.kind !== 'user') throw new Error('not a person')
  return access.principal.subject
}

/** A person whose invitation carried a label: the name the page shows. */
async function labelled(
  h: AccountsHarness,
  role: 'viewer' | 'member' | 'ops',
  label: string,
): Promise<Person> {
  const { token } = await invite(h.handle, role, { label })
  const response = await h.handle(formPost('/invite', { invite: token }))
  expect(response.status).toBe(200)
  const sid = cookieFrom(response, 'qianmo_session')
  if (sid === null) throw new Error('not signed in')
  return { credential: credentialOn(await response.text()), sid }
}

/** A browser navigating as `who`: the session cookie, no console header. */
function navigate(path: string, who: Person): Request {
  return asSession('GET', path, who.sid, { header: false, accept: 'text/html' })
}

/** A polled fragment as the page script asks for it. */
function poll(path: string, who: Person): Request {
  return asSession('GET', path, who.sid)
}

async function read(
  h: { handle: (request: Request) => Promise<Response> },
  request: Request,
  status = 200,
): Promise<string> {
  const response = await h.handle(request)
  expect(`${request.url} ${response.status}`).toBe(`${request.url} ${status}`)
  return await response.text()
}

/** The page's own part: what is between `<main>` and `</main>`. */
function mainOf(html: string): string {
  return html.slice(html.indexOf('<main'), html.indexOf('</main>'))
}

/** The markup between two ids: one region of a page. */
function between(html: string, from: string, to?: string): string {
  const start = html.indexOf(`id="${from}"`)
  if (start < 0) throw new Error(`no ${from}`)
  const end = to === undefined ? -1 : html.indexOf(`id="${to}"`, start)
  return end < 0 ? html.slice(start) : html.slice(start, end)
}

/** Data rows of every table in `html`, by their `data-key`. */
function rowKeys(html: string): string[] {
  return [...html.matchAll(/<tr data-key="([^"]+)"/g)].map(m => m[1] ?? '')
}

/**
 * Everything in a document that would let its reader change something — the
 * scan `roles.test.ts` runs over every area, kept to the same rules: a
 * `data-write` mark, a confirmation to submit, a form that is not a plain GET.
 */
function writeMarks(html: string): readonly string[] {
  const markup = html.replace(/<script>[\s\S]*?<\/script>/g, '')
  const found: string[] = []
  if (/\sdata-write[\s>=]/.test(markup)) found.push('data-write')
  for (const action of markup.match(/data-action="confirm-[a-z-]+"/g) ?? []) {
    if (action !== 'data-action="confirm-cancel"') found.push(action)
  }
  for (const form of markup.match(/<form[^>]*>/g) ?? []) {
    const plainGet = /method="get"/i.test(form)
    const logout = form.includes('id="logout-form"')
    if (!plainGet && !logout) found.push(form)
  }
  return found
}

function assertCopy(label: string, html: string): void {
  const text = visibleText(html)
  for (const banned of ['。', '，', '、', '！', '!']) {
    expect(`${label} ${text.includes(banned)} ${banned}`).toBe(
      `${label} false ${banned}`,
    )
  }
  expect(text).not.toMatch(/\p{Extended_Pictographic}/u)
}

async function stream(
  h: AccountsHarness,
  request: Request,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await h.handle(request)
  expect(response.status).toBe(200)
  if (response.body === null) throw new Error('no body')
  const reader = response.body.getReader()
  readers.push(reader)
  const first = await reader.read()
  expect(decoder.decode(first.value)).toContain(': open')
  return reader
}

async function converse(h: AccountsHarness, who: Person): Promise<string> {
  const response = await h.handle(
    asSession('POST', '/v0/chat/sessions', who.sid, {
      body: { target: ADDRESS },
    }),
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { id: string }).id
}

/**
 * Two labelled members with a conversation each and a labelled ops account
 * that has opened A's once; the hash-chained ledger behind it all.
 */
async function scene(options: { readonly ledger?: ActionLedgerPort } = {}) {
  const store = new MemoryActionStore()
  const actions = options.ledger ?? new ActionLedger({ store })
  const h = accountsHarness({ deps: { actions } })
  const a = await labelled(h, 'member', '甲')
  const b = await labelled(h, 'member', '乙')
  const ops = await labelled(h, 'ops', '值班')
  const viewer = await labelled(h, 'viewer', '旁观')
  const sa = await converse(h, a)
  const sb = await converse(h, b)
  // ops opens A's conversation: the one reading A is owed an answer about.
  await read(h, navigate(`/chat?session=${sa}`, ops))
  return { h, store, a, b, ops, viewer, sa, sb }
}

// --- the four tabs ----------------------------------------------------------

describe('成员 (/access)', () => {
  test('each account with its role, state, last sign-in and live sessions', async () => {
    const { h, a, b, ops } = await scene()
    const signedIn = h.clock.now()
    h.clock.advance(10 * 60 * 1000)
    // B signs in a second time, in another browser.
    const again = await h.handle(
      formPost(
        '/login',
        { token: b.credential },
        { 'sec-fetch-site': 'same-origin' },
      ),
    )
    expect(again.status).toBe(303)
    const html = await read(h, navigate('/access', ops))
    const members = between(html, 'access-members')
    expect(html).toContain('data-poll="/fragments/access/members"')
    // 甲, 乙, 值班 and 旁观: every account, one row each.
    expect(rowKeys(members)).toHaveLength(4)
    for (const who of [a, b, ops]) {
      expect(rowKeys(members)).toContain(subjectOf(h, who))
    }
    const rowB = members.slice(members.indexOf(`data-key="${subjectOf(h, b)}"`))
    const cells = rowB.slice(0, rowB.indexOf('</tr>'))
    expect(cells).toContain('乙')
    expect(cells).toContain('成员')
    expect(cells).toContain('在用')
    expect(cells).toContain(
      `datetime="${new Date(signedIn + 10 * 60 * 1000).toISOString()}"`,
    )
    expect(cells).toContain('<td class="num">2</td>')
    // The reader's own row is named as such and carries no button.
    const own = members.slice(
      members.indexOf(`data-key="${subjectOf(h, ops)}"`),
    )
    const ownRow = own.slice(0, own.indexOf('</tr>'))
    expect(ownRow).toContain('你本人')
    expect(ownRow).not.toContain('data-write')
    expect(cells).toContain('data-action="account-revoke"')
    expect(cells).toContain('data-action="account-reset"')
    // The fragment the page polls is the same region.
    const fragment = await read(h, poll('/fragments/access/members', ops))
    expect(rowKeys(fragment)).toEqual(rowKeys(members))
  })

  test('a revoked account stays listed, marked, with nothing to press', async () => {
    const { h, a, ops } = await scene()
    const sa = subjectOf(h, a)
    expect(
      (await h.handle(asSession('POST', `/v0/accounts/${sa}/revoke`, ops.sid)))
        .status,
    ).toBe(204)
    const html = await read(h, poll('/fragments/access/members', ops))
    const row = html.slice(html.indexOf(`data-key="${sa}"`))
    const cells = row.slice(0, row.indexOf('</tr>'))
    expect(cells).toContain('data-state="revoked"')
    expect(cells).toContain('已吊销')
    expect(cells).not.toContain('data-write')
    expect(html).toContain('data-revoked="1"')
  })
})

describe('邀请 (/access/invites)', () => {
  test('issue, withdraw and uses left: one for an open invitation, none after', async () => {
    const { h, ops } = await scene()
    const issued = await h.handle(
      asSession('POST', '/v0/accounts/invites', ops.sid, {
        body: { role: 'viewer', ttlHours: 1, label: '临时' },
      }),
    )
    expect(issued.status).toBe(200)
    const { inviteId, link } = (await issued.json()) as {
      inviteId: string
      link: string
    }
    const token = link.slice(link.indexOf('#') + 1)

    const html = await read(h, navigate('/access/invites', ops))
    expect(html).toContain('id="invite-form"')
    expect(html).toContain('id="invite-link"')
    expect(html).toContain('data-poll="/fragments/access/invites"')
    // Never the token, here or anywhere on the page.
    expect(html.includes(token)).toBe(false)
    const row = html.slice(html.indexOf(`data-key="${inviteId}"`))
    const open = row.slice(0, row.indexOf('</tr>'))
    expect(open).toContain('data-state="open"')
    expect(open).toContain('临时')
    expect(open).toContain('未用')
    expect(open).toContain('<td class="num">1</td>')
    expect(open).toContain(
      `data-action="invite-withdraw" data-invite="${inviteId}"`,
    )
    // The four invitations of the scene are consumed: none left on any.
    expect(html.match(/data-state="consumed"/g)).toHaveLength(4)
    expect(html).toContain('data-open="1" data-left="19"')

    const withdrawn = await h.handle(
      asSession('DELETE', `/v0/accounts/invites/${inviteId}`, ops.sid),
    )
    expect(withdrawn.status).toBe(204)
    const after = await read(h, poll('/fragments/access/invites', ops))
    const gone = after.slice(after.indexOf(`data-key="${inviteId}"`))
    const cells = gone.slice(0, gone.indexOf('</tr>'))
    expect(cells).toContain('已作废')
    expect(cells).toContain('<td class="num">0</td>')
    expect(cells).not.toContain('data-write')
    expect(after).toContain('data-open="0" data-left="20"')
  })

  test('an expired invitation is marked so and has no uses left', async () => {
    const { h, ops } = await scene()
    const issued = await h.handle(
      asBearer('POST', '/v0/accounts/invites', ops.credential, {
        role: 'member',
        ttlHours: 1,
      }),
    )
    const { inviteId } = (await issued.json()) as { inviteId: string }
    h.clock.advance(HOUR + 1)
    const html = await read(
      h,
      asBearer('GET', '/fragments/access/invites', ops.credential),
    )
    const row = html.slice(html.indexOf(`data-key="${inviteId}"`))
    const cells = row.slice(0, row.indexOf('</tr>'))
    expect(cells).toContain('已过期')
    expect(cells).toContain('<td class="num">0</td>')
  })

  test('carries Referrer-Policy: no-referrer, as does the invitation door', async () => {
    const { h, ops } = await scene()
    const { token } = await invite(h.handle, 'member')
    for (const request of [
      navigate('/access/invites', ops),
      poll('/fragments/access/invites', ops),
      new Request(`${BASE}/invite`),
      formPost('/invite', { invite: token }),
    ]) {
      const response = await h.handle(request)
      expect(`${request.method} ${request.url} ${response.status}`).toBe(
        `${request.method} ${request.url} 200`,
      )
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    }
    const page = await read(h, navigate('/access/invites', ops))
    expect(page).toContain('<meta name="referrer" content="no-referrer">')
  })
})

describe('会话 (/access/sessions)', () => {
  test('lists who is signed in with their streams; 强制下线 brings the person to zero', async () => {
    const { h, a, b, ops } = await scene()
    const sa = subjectOf(h, a)
    await stream(
      h,
      asSession('GET', '/v0/chat/stream', a.sid, { header: false }),
    )
    await stream(h, asBearer('GET', '/v0/chat/stream', a.credential))
    const before = await read(h, navigate('/access/sessions', ops))
    expect(before).toContain('data-poll="/fragments/access/sessions"')
    const row = before.slice(before.indexOf(`data-key="${sa}"`))
    const cells = row.slice(0, row.indexOf('</tr>'))
    // 会话 1, 实时连接 2.
    expect(cells).toMatch(/<td class="num">1<\/td><td class="num">2<\/td>/)
    expect(cells).toContain(
      `data-action="account-logout" data-subject="${sa}" data-name="甲"`,
    )
    expect(before).toContain('id="confirm-account-logout"')
    expect(h.book.openStreams(sa)).toBe(2)

    // What the page script sends when the dialog is confirmed.
    const ended = await h.handle(
      asSession('POST', `/v0/accounts/${sa}/logout`, ops.sid),
    )
    expect(ended.status).toBe(200)
    expect(h.book.openStreams(sa)).toBe(0)

    const after = await read(h, poll('/fragments/access/sessions', ops))
    expect(rowKeys(after)).not.toContain(sa)
    expect(rowKeys(after)).toContain(subjectOf(h, b))
  })

  test('nobody signed in: says so in one line', async () => {
    const actions = new MemoryActionLedger()
    const h = accountsHarness({ deps: { actions } })
    const html = await read(h, asBearer('GET', '/access/sessions', ADMIN))
    expect(html).toContain('没有在线的成员')
    expect(rowKeys(between(html, 'access-sessions'))).toEqual([])
  })
})

describe('操作记录 (/access/actions)', () => {
  test('a member sees only what they did, and who read their conversation', async () => {
    const { h, a, b, ops, sa, sb } = await scene()
    const mine = subjectOf(h, a)
    const theirs = subjectOf(h, b)
    const html = await read(h, navigate('/access/actions', a))
    expect(between(html, 'actions-head', 'actions-body')).toContain(
      '只列出你本人的操作',
    )
    const list = between(html, 'actions-body', 'reads-section')
    // A's own 新建对话 is there, and nothing of B's or ops'.
    expect(list).toContain('新建对话')
    expect(list).toContain(mine)
    expect(list.includes(theirs)).toBe(false)
    expect(list.includes(subjectOf(h, ops))).toBe(false)
    expect(list.includes(sa)).toBe(false)
    expect(rowKeys(list)).toHaveLength(1)
    for (const row of list.split('<tr data-key=').slice(1)) {
      expect(row).toContain('你本人')
    }
    // Asking for B's by name finds nothing, rather than B's.
    const prying = await read(
      h,
      navigate(`/access/actions?subject=${theirs}`, a),
    )
    const pried = between(prying, 'actions-body', 'reads-section')
    expect(rowKeys(pried)).toEqual([])
    expect(pried).toContain('没有符合条件的记录')
    expect(prying.includes(sb)).toBe(false)
    // The member is offered no subject filter at all.
    expect(html).not.toContain('name="subject"')

    // 谁读了我的对话: ops' opening, under ops' name.
    const reads = between(html, 'reads-section')
    expect(reads).toContain('谁读了我的对话')
    expect(reads).toContain('值班')
    expect(reads).toContain(sa)
    expect(rowKeys(reads)).toHaveLength(1)

    // The control: ops, asking the same thing, does see B's entry.
    const all = await read(
      h,
      navigate(`/access/actions?subject=${theirs}`, ops),
    )
    const listed = between(all, 'actions-body', 'reads-section')
    expect(rowKeys(listed)).toHaveLength(1)
    expect(listed).toContain(theirs)
    expect(listed).toContain('乙')
    expect(listed).toContain('新建对话')
    expect(all).toContain('name="subject"')
    expect(all).toContain('全部主体')
  })

  test('filters by verb family and target; empty fields are no filter', async () => {
    const { h, ops, sa } = await scene()
    const byFamily = between(
      await read(
        h,
        navigate('/access/actions?subject=&action=chat.&target=', ops),
      ),
      'actions-body',
      'reads-section',
    )
    expect(rowKeys(byFamily).length).toBeGreaterThanOrEqual(3)
    expect(byFamily).not.toContain('签发邀请')
    expect(byFamily).toContain('打开转录')
    const byTarget = between(
      await read(h, navigate(`/access/actions?target=${sa}`, ops)),
      'actions-body',
      'reads-section',
    )
    // ops' reading of it: the opening that has the conversation as its target.
    expect(rowKeys(byTarget)).toHaveLength(1)
    expect(byTarget).toContain('打开转录')
    const accounts = between(
      await read(h, navigate('/access/actions?action=accounts.', ops)),
      'actions-body',
      'reads-section',
    )
    expect(accounts).toContain('签发邀请')
    expect(accounts).toContain('accounts.post')
  })

  test('pages with before=nextBeforeSeq: no entry twice, none missed', async () => {
    const actions = new MemoryActionLedger()
    const h = accountsHarness({ deps: { actions } })
    for (let i = 0; i < 60; i++) {
      await actions.record({
        at: h.clock.now() + i,
        requestId: `req-${i}`,
        subject: 'legacy:admin',
        action: 'agent.heartbeat',
        target: `qianmo://n-${i}/a`,
        outcome: 'ok',
      })
    }
    const first = await read(h, asBearer('GET', '/access/actions', ADMIN))
    const firstKeys = rowKeys(between(first, 'actions-body'))
    expect(firstKeys).toHaveLength(50)
    const older = /id="actions-older" href="([^"]+)"/.exec(first)?.[1]
    expect(older).toBe('/access/actions?before=11')
    const second = await read(
      h,
      asBearer('GET', (older ?? '').replace(/&amp;/g, '&'), ADMIN),
    )
    const secondKeys = rowKeys(between(second, 'actions-body'))
    expect(secondKeys).toHaveLength(10)
    expect(second).not.toContain('id="actions-older"')
    expect(second).toContain('回到最新')
    const seen = new Set([...firstKeys, ...secondKeys])
    expect(seen.size).toBe(60)
    // Filters ride along on the pager.
    const filtered = await read(
      h,
      asBearer('GET', '/access/actions?action=agent.', ADMIN),
    )
    expect(filtered).toContain(
      'id="actions-older" href="/access/actions?action=agent.&amp;before=11"',
    )
  })

  test('is never polled: it refreshes on request, with a plain link', async () => {
    const { h, ops } = await scene()
    const html = await read(h, navigate('/access/actions', ops))
    expect(html).not.toContain('data-poll=')
    expect(html).not.toContain('id="auto-refresh"')
    expect(html).toContain('id="actions-refresh"')
    expect(html).toContain('列表不自动刷新')
    // The administration tabs are polled, and offer the switch.
    const members = await read(h, navigate('/access', ops))
    expect(members).toContain('data-poll="/fragments/access/members"')
    expect(members).toContain('id="auto-refresh"')
  })

  test('a closed ledger reads 账本停用, and no write control is drawn anywhere', async () => {
    const { h, store, a, ops } = await scene()
    store.text = (store.text ?? '').replace('accounts.post', 'accounts.posx')
    for (const who of [a, ops]) {
      const html = await read(h, navigate('/access/actions', who))
      expect(html).toContain('<span id="ledger-state">')
      expect(html).toContain('账本停用')
      expect(rowKeys(between(html, 'actions-body'))).toEqual([])
    }
    // The API says the same in its own terms.
    expect(
      (await h.handle(asSession('GET', '/v0/actions', ops.sid))).status,
    ).toBe(503)
    for (const path of ['/access', '/access/invites', '/access/sessions']) {
      const html = await read(h, navigate(path, ops))
      expect(html).toContain('账本停用 · 写操作已暂停')
      expect(`${path} ${writeMarks(html).join(',')}`).toBe(`${path} `)
    }
  })

  test('a filter that is not one says so, rather than guessing', async () => {
    const { h, ops } = await scene()
    const html = await read(h, navigate('/access/actions?before=abc', ops))
    expect(html).toContain('筛选条件无效')
    expect(rowKeys(between(html, 'actions-body', 'reads-section'))).toEqual([])
  })
})

// --- who sees what -----------------------------------------------------------

describe('four principals, four pages (§7.3)', () => {
  test('viewer: 操作记录 only, own records, no write control; the other tabs are 403', async () => {
    const { h, viewer } = await scene()
    const html = await read(h, navigate('/access', viewer))
    expect(html).not.toContain('class="access-tabs"')
    expect(html).toContain('id="actions-filter"')
    expect(html).toContain('只列出你本人的操作')
    expect(html).toContain('谁读了我的对话')
    expect(html).toContain('还没有人打开过你的对话')
    expect(html).toContain('只读 · 写操作需要运维角色')
    expect(writeMarks(html)).toEqual([])
    for (const path of ['/access/invites', '/access/sessions']) {
      const denied = await read(h, navigate(path, viewer), 403)
      expect(denied).toContain('需要运维角色的个人账号')
      expect(writeMarks(denied)).toEqual([])
    }
    const fragment = await h.handle(poll('/fragments/access/members', viewer))
    expect(fragment.status).toBe(403)
  })

  test('member: the same page as a viewer, plus who read their conversation', async () => {
    const { h, a, sa } = await scene()
    const html = await read(h, navigate('/access', a))
    expect(html).not.toContain('class="access-tabs"')
    expect(between(html, 'reads-section')).toContain(sa)
    expect(writeMarks(html)).toEqual([])
    for (const path of ['/access/invites', '/access/sessions']) {
      expect(await read(h, navigate(path, a), 403)).toContain(
        '需要运维角色的个人账号',
      )
    }
    expect((await h.handle(poll('/fragments/access/sessions', a))).status).toBe(
      403,
    )
  })

  test('ops: four tabs, everything listed, and the write controls', async () => {
    const { h, ops } = await scene()
    for (const [path, marks] of [
      ['/access', ['data-write', 'data-action="confirm-account-revoke"']],
      [
        '/access/invites',
        ['data-write', 'data-action="confirm-invite-withdraw"'],
      ],
      [
        '/access/sessions',
        ['data-write', 'data-action="confirm-account-logout"'],
      ],
    ] as const) {
      const html = await read(h, navigate(path, ops))
      for (const tab of ['members', 'invites', 'sessions', 'actions']) {
        expect(html).toContain(`id="tab-${tab}"`)
      }
      const found = writeMarks(html)
      for (const mark of marks) expect(found).toContain(mark)
      expect(html).not.toContain('id="read-only"')
    }
    const invites = await read(h, navigate('/access/invites', ops))
    expect(writeMarks(invites).some(mark => mark.includes('invite-form'))).toBe(
      true,
    )
    const actions = await read(h, navigate('/access/actions', ops))
    expect(actions).toContain('全部主体')
  })

  test('legacy tokens: the view token gets one line; the admin token without accounts gets the tabs and why they are empty', async () => {
    // With accounts on, the shared view token is nobody in particular.
    const { h } = await scene()
    const shared = await read(h, browse('/access', VIEW))
    expect(shared).toContain('操作记录需要个人账号或管理令牌')
    expect(shared).not.toContain('class="access-tabs"')
    expect(writeMarks(shared)).toEqual([])
    expect(await read(h, browse('/access/invites', VIEW), 403)).toContain(
      '需要运维角色的个人账号',
    )

    // Without accounts there is no book and no ledger to show.
    const legacy = pageHarness({ chat: true })
    const admin = await read(legacy, browse('/access', ADMIN))
    for (const tab of ['members', 'invites', 'sessions', 'actions']) {
      expect(admin).toContain(`id="tab-${tab}"`)
    }
    expect(admin).toContain('这台控制台没有开启个人账号')
    expect(admin).not.toContain('data-poll=')
    expect(writeMarks(admin)).toEqual([])
    expect(await read(legacy, browse('/access/actions', ADMIN))).toContain(
      '这台控制台没有接动作账本',
    )
    const view = await read(legacy, browse('/access', VIEW))
    expect(view).toContain('操作记录需要个人账号或管理令牌')
    expect(writeMarks(view)).toEqual([])
    expect(await read(legacy, browse('/access/invites', VIEW), 403)).toContain(
      '这台控制台没有开启个人账号',
    )
    // And the fragments do not exist for it to poll.
    expect(
      (await legacy.handle(browse('/fragments/access/members', VIEW))).status,
    ).toBe(403)
  })

  test('the admin token on a console with accounts administers them, as the API lets it', async () => {
    const { h } = await scene()
    const html = await read(h, browse('/access/sessions', ADMIN))
    expect(writeMarks(html)).toContain('data-write')
    const actions = await read(h, browse('/access/actions', ADMIN))
    expect(actions).toContain('全部主体')
    // A legacy token owns no conversation: there is no reads block to show.
    expect(actions).not.toContain('id="reads-section"')
  })
})

// --- copy, script, the shape of the area --------------------------------------

describe('every state of the page keeps the console register', () => {
  test('no 。，、 no exclamation, no emoji, in any tab for anybody', async () => {
    const { h, store, a, b, ops, viewer, sa } = await scene()
    const pages: [string, string][] = []
    const collect = async (label: string, request: Request) => {
      pages.push([label, await (await h.handle(request)).text()])
    }
    await stream(
      h,
      asSession('GET', '/v0/chat/stream', b.sid, { header: false }),
    )
    for (const [name, who] of [
      ['ops', ops],
      ['member', a],
      ['viewer', viewer],
    ] as const) {
      for (const path of [
        '/access',
        '/access/invites',
        '/access/sessions',
        '/access/actions',
        `/access/actions?target=${sa}`,
        '/access/actions?subject=nobody',
        '/access/actions?before=abc',
        '/access/actions?readsBefore=0',
      ]) {
        await collect(`${name} ${path}`, navigate(path, who))
      }
    }
    for (const tab of ['members', 'invites', 'sessions']) {
      await collect(`fragment ${tab}`, poll(`/fragments/access/${tab}`, ops))
    }
    await collect('view token', browse('/access', VIEW))
    // Revoked and expired rows, then a closed ledger.
    await h.handle(
      asSession('POST', `/v0/accounts/${subjectOf(h, b)}/revoke`, ops.sid),
    )
    h.clock.advance(80 * HOUR)
    const fresh = await person(h.handle, 'ops')
    await collect('after', navigate('/access/invites', fresh))
    await collect('after members', navigate('/access', fresh))
    store.text = (store.text ?? '').replace('accounts.post', 'accounts.posx')
    for (const path of ['/access', '/access/actions']) {
      await collect(`closed ${path}`, navigate(path, fresh))
    }
    // A console without accounts, and a book that does not verify.
    const legacy = pageHarness({ chat: true })
    for (const token of [ADMIN, VIEW]) {
      for (const path of ['/access', '/access/invites', '/access/actions']) {
        pages.push([
          `legacy ${path}`,
          await (await legacy.handle(browse(path, token))).text(),
        ])
      }
    }
    const broken = accountsHarness({
      ledger: new MemoryLedger('memory://accounts.ndjson', 'garbage\n'),
    })
    pages.push([
      'book closed',
      await (await broken.handle(browse('/access', ADMIN))).text(),
    ])
    expect(pages.length).toBeGreaterThan(30)
    for (const [label, html] of pages) assertCopy(label, html)
    // And the lines the page script puts on screen itself.
    const said = [
      ...(accessRoute.page?.script ?? '').matchAll(
        /'([^'\n]*[一-鿿][^'\n]*)'/g,
      ),
    ].map(match => match[1] ?? '')
    expect(said.length).toBeGreaterThan(10)
    for (const line of said) {
      for (const banned of ['。', '，', '、', '！', '!']) {
        expect(`${line} ${line.includes(banned)}`).toBe(`${line} false`)
      }
    }
  })
})

describe('without script', () => {
  test('every tab reads: the content is in the markup and every way on is a link', async () => {
    const { h, ops, a, sa } = await scene()
    for (const [path, who, reads] of [
      ['/access', ops, ['甲', '乙', '旁观', '你本人', '最近登录']],
      ['/access/invites', ops, ['剩余次数', '已开通']],
      ['/access/sessions', ops, ['实时连接', '甲']],
      ['/access/actions', ops, ['打开转录', sa, 'id="actions-refresh"']],
      ['/access/actions', a, ['谁读了我的对话', '值班']],
    ] as const) {
      const bare = withoutScripts(await read(h, navigate(path, who)))
      expect(bare).not.toContain('<script')
      for (const text of reads) {
        expect(`${path} ${bare.includes(text)} ${text}`).toBe(
          `${path} true ${text}`,
        )
      }
      for (const href of ['/access', '/access/invites', '/access/actions']) {
        if (who === ops) expect(bare).toContain(`href="${href}" data-nav`)
      }
    }
    // The filter is a GET form: it works with script off.
    const actions = await read(h, navigate('/access/actions', ops))
    expect(actions).toMatch(
      /<form id="actions-filter" class="actions-filter" method="get" action="\/access\/actions">/,
    )
  })

  test('a writer is told where the buttons are that script is needed; a reader is not', async () => {
    const { h, ops, a } = await scene()
    const writer = await read(h, navigate('/access/invites', ops))
    expect(writer).toContain('<noscript>')
    const reader = await read(h, navigate('/access', a))
    expect(reader).not.toContain('<noscript>')
  })
})

describe('the area and its paths', () => {
  test('/access/<anything else> is the console 404, and a fragment needs the console header', async () => {
    const { h, ops } = await scene()
    expect((await h.handle(navigate('/access/members', ops))).status).toBe(404)
    expect((await h.handle(navigate('/access/x/y', ops))).status).toBe(404)
    expect(
      (await h.handle(poll('/fragments/access/actions', ops))).status,
    ).toBe(404)
    // A cookie without the console header: the guarded-route rule.
    expect(
      (
        await h.handle(
          asSession('GET', '/fragments/access/members', ops.sid, {
            header: false,
          }),
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await h.handle(
          new Request(`${BASE}/fragments/access/members`, { method: 'GET' }),
        )
      ).status,
    ).toBe(401)
  })

  test('the API keeps answering under the page: /v0/actions is still this module’s', async () => {
    const { h, ops } = await scene()
    const response = await h.handle(asSession('GET', '/v0/actions', ops.sid))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { entries: unknown[] }
    expect(body.entries.length).toBeGreaterThan(0)
  })
})
