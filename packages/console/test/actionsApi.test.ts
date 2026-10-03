// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P15.9 — the action ledger's read API (`routes/access.ts`), over HTTP only,
 * with the hash-chained ledger behind it.
 *
 * The DoD row this file answers: the person whose conversation it is can ask
 * "who read my transcript, and when" (`tenancy-m1.md` §6, D6) — and get one
 * answer per opening however many polls and stream events followed it. The
 * rest is the fence around it: a member sees their own and nobody else's, a
 * conversation they may not see answers like one that does not exist, the
 * shared view token sees nothing, and a closed ledger says so.
 */

import { describe, expect, test } from 'bun:test'
import { resolveAccess } from '../src/access.js'
import { ActionLedger } from '../src/actionLedger.js'
import type { ActionPage, ActionRecord } from '../src/deps.js'
import {
  ADDRESS,
  ADMIN,
  TOKENS,
  VIEW,
  accountsHarness,
  asAdmin,
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
import { browse, call, pageHarness } from './pageHarness.js'

/** Less than the two-hour idle limit, so nobody's session ends mid-scene. */
const MINUTES_10 = 10 * 60 * 1000

function ledgerOn(store = new MemoryActionStore()) {
  return { store, ledger: new ActionLedger({ store }) }
}

function subjectOf(h: AccountsHarness, who: Person): string {
  const access = resolveAccess(
    asSession('GET', '/v0/limits', who.sid),
    TOKENS,
    { book: h.book },
    false,
  )
  if (access.principal?.kind !== 'user') throw new Error('not a person')
  return access.principal.subject
}

async function page(h: AccountsHarness, request: Request): Promise<ActionPage> {
  const response = await h.handle(request)
  expect(response.status).toBe(200)
  return (await response.json()) as ActionPage
}

function lines(entries: readonly ActionRecord[]): string[] {
  return entries.map(e => `${e.action} ${e.target} ${e.subject}`)
}

/**
 * Two members with a conversation each, and an ops account that has opened
 * A's once — then let the page poll it a hundred times and the stream tell it
 * about a hundred changes.
 */
async function scene() {
  const { store, ledger } = ledgerOn()
  const h = accountsHarness({ deps: { actions: ledger } })
  const a = await person(h.handle, 'member')
  const b = await person(h.handle, 'member')
  const ops = await person(h.handle, 'ops')
  const open = async (who: Person) => {
    const response = await h.handle(
      asSession('POST', '/v0/chat/sessions', who.sid, {
        body: { target: ADDRESS },
      }),
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as { id: string }).id
  }
  const sa = await open(a)
  const sb = await open(b)

  h.clock.advance(MINUTES_10)
  const readAt = h.clock.now()
  const stream = await h.handle(
    asSession('GET', '/v0/chat/stream', ops.sid, { header: false }),
  )
  const reader = stream.body?.getReader()
  if (reader === undefined) throw new Error('no stream')
  await reader.read()
  const opened = await h.handle(
    asSession('GET', `/chat?session=${sa}`, ops.sid, {
      header: false,
      accept: 'text/html',
    }),
  )
  expect(opened.status).toBe(200)
  for (let i = 0; i < 100; i++) {
    h.chat.emit(sa)
    await reader.read()
    const poll = await h.handle(
      asSession('GET', `/fragments/chat/thread/${sa}`, ops.sid),
    )
    expect(poll.status).toBe(200)
  }
  await reader.cancel()
  h.clock.advance(MINUTES_10)
  return { h, store, ledger, a, b, ops, sa, sb, readAt }
}

describe('who read my transcript, and when (D6)', () => {
  test('one opening, a hundred polls and a stream: the owner sees one reading, by ops, at the time it happened', async () => {
    const { h, a, ops, sa, readAt } = await scene()
    const mine = await page(h, asSession('GET', '/v0/actions/reads', a.sid))
    expect(mine.entries).toHaveLength(1)
    expect(mine.entries[0]).toMatchObject({
      action: 'chat.transcript.open',
      target: sa,
      subject: subjectOf(h, ops),
      at: readAt,
      outcome: 'ok',
    })
    expect(mine.nextBeforeSeq).toBeNull()
    // The same answer for that one conversation, and over a bearer.
    const one = await page(
      h,
      asSession('GET', `/v0/actions/reads?session=${sa}`, a.sid),
    )
    expect(one).toEqual(mine)
    expect(
      await page(h, asBearer('GET', '/v0/actions/reads', a.credential)),
    ).toEqual(mine)
  })

  test("another member's conversation answers exactly like one that does not exist", async () => {
    const { h, b, sa, sb } = await scene()
    const theirs = await h.handle(
      asSession('GET', `/v0/actions/reads?session=${sa}`, b.sid),
    )
    const ghost = await h.handle(
      asSession('GET', '/v0/actions/reads?session=no-such-session', b.sid),
    )
    expect(theirs.status).toBe(200)
    expect(await theirs.text()).toBe(await ghost.text())
    // B's own conversations were read by nobody.
    const own = await page(h, asSession('GET', '/v0/actions/reads', b.sid))
    expect(own.entries).toEqual([])
    const named = await page(
      h,
      asSession('GET', `/v0/actions/reads?session=${sb}`, b.sid),
    )
    expect(named.entries).toEqual([])
  })

  test('ops may ask about any conversation; a viewer owns none', async () => {
    const { h, ops, sa } = await scene()
    const any = await page(
      h,
      asSession('GET', `/v0/actions/reads?session=${sa}`, ops.sid),
    )
    expect(any.entries.map(e => e.target)).toEqual([sa])
    // Ops's own conversations: none, so nothing.
    expect(
      (await page(h, asSession('GET', '/v0/actions/reads', ops.sid))).entries,
    ).toEqual([])
    const viewer = await person(h.handle, 'viewer')
    expect(
      (
        await page(
          h,
          asSession('GET', `/v0/actions/reads?session=${sa}`, viewer.sid),
        )
      ).entries,
    ).toEqual([])
  })

  test('asking records nothing', async () => {
    const { h, store, a, ops } = await scene()
    const before = store.text
    for (let i = 0; i < 10; i++) {
      await h.handle(asSession('GET', '/v0/actions/reads', a.sid))
      await h.handle(asSession('GET', '/v0/actions', ops.sid))
    }
    expect(store.text).toBe(before)
  })
})

/** {@link person}, with the label `ops` gives the account at invitation. */
async function labelled(
  h: AccountsHarness,
  role: 'member' | 'ops',
  label: string,
): Promise<Person> {
  const { token } = await invite(h.handle, role, { label })
  const response = await h.handle(formPost('/invite', { invite: token }))
  expect(response.status).toBe(200)
  const credential = credentialOn(await response.text())
  const sid = cookieFrom(response, 'qianmo_session') ?? ''
  return { credential, sid }
}

type Named = ActionRecord & { readonly subjectName?: string }

describe('readers have names (reads only)', () => {
  async function namedScene() {
    const { ledger } = ledgerOn()
    const h = accountsHarness({ deps: { actions: ledger } })
    const member = await labelled(h, 'member', '李四')
    const ops = await labelled(h, 'ops', '运维 张三')
    const quiet = await person(h.handle, 'ops')
    const opened = await h.handle(
      asSession('POST', '/v0/chat/sessions', member.sid, {
        body: { target: ADDRESS },
      }),
    )
    const { id } = (await opened.json()) as { id: string }
    for (const reader of [ops, quiet]) {
      const page = await h.handle(
        asSession('GET', `/chat?session=${id}`, reader.sid, {
          header: false,
          accept: 'text/html',
        }),
      )
      expect(page.status).toBe(200)
    }
    // And once more over the admin token, which is nobody's name.
    await h.handle(asAdmin('GET', `/v0/chat/sessions/${id}`))
    return { h, member, ops, quiet, id }
  }

  test("the member sees ops's display name beside the subject", async () => {
    const { h, member, ops, quiet } = await namedScene()
    const response = await h.handle(
      asSession('GET', '/v0/actions/reads', member.sid),
    )
    expect(response.status).toBe(200)
    const { entries } = (await response.json()) as { entries: Named[] }
    expect(entries.map(e => [e.subject, e.subjectName])).toEqual([
      ['legacy:admin', undefined],
      [subjectOf(h, quiet), undefined],
      [subjectOf(h, ops), '运维 张三'],
    ])
    // Absent, not empty, where there is no name.
    expect('subjectName' in (entries[0] ?? {})).toBe(false)
    expect('subjectName' in (entries[1] ?? {})).toBe(false)
  })

  test('/v0/actions stays ids only', async () => {
    const { h, ops } = await namedScene()
    const response = await h.handle(asSession('GET', '/v0/actions', ops.sid))
    const { entries } = (await response.json()) as { entries: Named[] }
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.some(e => 'subjectName' in e)).toBe(false)
  })

  test('a closed account book names nobody, and the reads still answer', async () => {
    const { h, id } = await namedScene()
    // A write the book cannot land closes it — what a full disk does.
    h.ledger.failAppends = true
    await h.handle(asAdmin('POST', '/v0/accounts/invites', { role: 'viewer' }))
    expect(h.book.problem).not.toBeNull()
    const response = await h.handle(
      asBearer('GET', `/v0/actions/reads?session=${id}`, ADMIN),
    )
    expect(response.status).toBe(200)
    const { entries } = (await response.json()) as { entries: Named[] }
    expect(entries).toHaveLength(3)
    expect(entries.some(e => 'subjectName' in e)).toBe(false)
  })
})

describe('what was done', () => {
  test('a member sees only what they did; somebody else’s subject is filtered to nothing', async () => {
    const { h, a, ops, sa } = await scene()
    const own = await page(h, asSession('GET', '/v0/actions', a.sid))
    expect(lines(own.entries)).toEqual([
      `chat.session.open ${ADDRESS} ${subjectOf(h, a)}`,
    ])
    const prying = await page(
      h,
      asSession(
        'GET',
        `/v0/actions?subject=${encodeURIComponent(subjectOf(h, ops))}`,
        a.sid,
      ),
    )
    expect(prying.entries).toEqual([])
    const byTarget = await page(
      h,
      asSession('GET', `/v0/actions?target=${sa}`, a.sid),
    )
    expect(byTarget.entries).toEqual([])
  })

  test('ops sees everything and filters by subject, verb prefix and target, newest first', async () => {
    const { h, a, b, ops, sa } = await scene()
    const all = await page(h, asSession('GET', '/v0/actions', ops.sid))
    const subjects = new Set(all.entries.map(e => e.subject))
    for (const who of [a, b, ops]) {
      expect(subjects.has(subjectOf(h, who))).toBe(true)
    }
    const seqs = all.entries.map(e => e.seq)
    expect(seqs).toEqual([...seqs].sort((x, y) => y - x))
    const hers = await page(
      h,
      asSession(
        'GET',
        `/v0/actions?subject=${encodeURIComponent(subjectOf(h, a))}`,
        ops.sid,
      ),
    )
    expect(new Set(hers.entries.map(e => e.subject))).toEqual(
      new Set([subjectOf(h, a)]),
    )
    const reads = await page(
      h,
      asSession(
        'GET',
        `/v0/actions?action=chat.transcript.&target=${sa}`,
        ops.sid,
      ),
    )
    expect(lines(reads.entries)).toEqual([
      `chat.transcript.open ${sa} ${subjectOf(h, ops)}`,
    ])
  })

  test('pages by sequence with before and limit', async () => {
    const { h, ops } = await scene()
    const all = await page(h, asSession('GET', '/v0/actions', ops.sid))
    expect(all.entries.length).toBeGreaterThan(2)
    const first = await page(
      h,
      asSession('GET', '/v0/actions?limit=2', ops.sid),
    )
    expect(first.entries).toEqual(all.entries.slice(0, 2))
    expect(first.nextBeforeSeq).toBe(all.entries[1]?.seq ?? -1)
    const second = await page(
      h,
      asSession(
        'GET',
        `/v0/actions?limit=2&before=${first.nextBeforeSeq}`,
        ops.sid,
      ),
    )
    expect(second.entries).toEqual(all.entries.slice(2, 4))
  })

  test('the admin token sees everything; the account API it used is in there', async () => {
    const { h } = await scene()
    const all = await page(h, asAdmin('GET', '/v0/actions'))
    expect(
      all.entries.some(
        e => e.action === 'accounts.post' && e.subject === 'legacy:admin',
      ),
    ).toBe(true)
  })
})

describe('the fence', () => {
  test('nobody: 401; the shared view token: 403; a cookie without the header: 403', async () => {
    const { h, a } = await scene()
    const anonymous = await h.handle(
      new Request('http://console.test/v0/actions'),
    )
    expect(anonymous.status).toBe(401)
    for (const path of ['/v0/actions', '/v0/actions/reads']) {
      const view = await h.handle(asBearer('GET', path, VIEW))
      expect(view.status).toBe(403)
      expect((await view.text()).includes('共用的只读令牌')).toBe(true)
    }
    const bare = await h.handle(
      asSession('GET', '/v0/actions', a.sid, { header: false }),
    )
    expect(bare.status).toBe(403)
  })

  test('GET only, two paths only, bad paging refused', async () => {
    const { h, ops } = await scene()
    const post = await h.handle(
      asSession('POST', '/v0/actions', ops.sid, { body: {} }),
    )
    expect(post.status).toBe(405)
    expect(
      (await h.handle(asSession('GET', '/v0/actions/elsewhere', ops.sid)))
        .status,
    ).toBe(404)
    for (const query of ['before=0', 'limit=abc', 'limit=-1', 'before=1.5']) {
      const response = await h.handle(
        asSession('GET', `/v0/actions?${query}`, ops.sid),
      )
      expect(response.status).toBe(400)
    }
  })

  test('no ledger wired: 501 after the role check', async () => {
    const h = accountsHarness()
    const ops = await person(h.handle, 'ops')
    expect(
      (await h.handle(asSession('GET', '/v0/actions', ops.sid))).status,
    ).toBe(501)
    expect((await h.handle(asBearer('GET', '/v0/actions', VIEW))).status).toBe(
      403,
    )
  })

  test('a closed ledger: 503 on both routes, for everybody, never the lines that still parse', async () => {
    const { h, store, a, ops } = await scene()
    store.text = (store.text ?? '').replace(
      'chat.session.open',
      'chat.session.shut',
    )
    for (const [who, path] of [
      [a, '/v0/actions/reads'],
      [a, '/v0/actions'],
      [ops, '/v0/actions'],
    ] as const) {
      const response = await h.handle(asSession('GET', path, who.sid))
      expect(response.status).toBe(503)
      expect((await response.text()).includes('动作账本校验没有通过')).toBe(
        true,
      )
    }
    // Including a member asking for somebody else's subject.
    const prying = await h.handle(
      asSession('GET', '/v0/actions?subject=u:0000000000000000', a.sid),
    )
    expect(prying.status).toBe(503)
  })

  test('break-glass reading the ledger is itself one break-glass line, and nothing more', async () => {
    const { store, ledger } = ledgerOn()
    const h = accountsHarness({
      deps: { actions: ledger },
      accounts: { breakGlass: true },
    })
    const response = await h.handle(asBearer('GET', '/v0/actions', ADMIN))
    expect(response.status).toBe(200)
    expect(store.lines().map(line => line.kind)).toEqual([
      'ledger.header',
      'breakglass.request',
    ])
  })
})

describe('without personal accounts', () => {
  test('the admin token reads the ledger; it owns no conversation, but may name one', async () => {
    const { ledger } = ledgerOn()
    const h = pageHarness({ chat: true, actions: ledger })
    const opened = await h.handle(
      call('POST', '/v0/chat/sessions', ADMIN, { target: ADDRESS }),
    )
    const { id } = (await opened.json()) as { id: string }
    await h.handle(browse(`/chat?session=${id}`, ADMIN))
    const all = await h.handle(call('GET', '/v0/actions', ADMIN))
    expect(
      ((await all.json()) as ActionPage).entries.map(e => e.action),
    ).toEqual(['chat.transcript.open', 'chat.session.open'])
    const mine = await h.handle(call('GET', '/v0/actions/reads', ADMIN))
    expect(((await mine.json()) as ActionPage).entries).toEqual([])
    const named = await h.handle(
      call('GET', `/v0/actions/reads?session=${id}`, ADMIN),
    )
    expect(
      ((await named.json()) as ActionPage).entries.map(e => e.subject),
    ).toEqual(['legacy:admin'])
    expect(
      (await h.handle(call('GET', '/v0/actions', 'view-token-000000000001')))
        .status,
    ).toBe(403)
  })
})
