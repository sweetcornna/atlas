// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.10 — 账号与访问 (H3) and 操作记录 (H4): the account book's two new
 * readings and the forced sign-out behind the 会话 tab.
 *
 * "After a forced sign-out the person holds no event stream" is judged by the
 * book's own stream count, with the control taken first: the person holds
 * two streams — one on the session cookie, one on the credential as a bearer —
 * before the button is pressed, and somebody else's stream is still open
 * after it.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { resolveAccess } from '../src/access.js'
import type { ConsoleAction } from '../src/deps.js'
import {
  ADDRESS,
  ADMIN,
  BASE,
  HOUR,
  TOKENS,
  MemoryLedger,
  accountsHarness,
  asAdmin,
  asBearer,
  asSession,
  type AccountsHarness,
  type Person,
  person,
} from './accountsHarness.js'
import { MemoryActionLedger } from './memoryActions.js'

const decoder = new TextDecoder()
const readers: ReadableStreamDefaultReader<Uint8Array>[] = []

afterEach(async () => {
  for (const reader of readers.splice(0)) {
    await reader.cancel().catch(() => {})
  }
})

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

/** Open the event stream and read past its opening comment. */
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

async function next(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string | null> {
  const chunk = await reader.read()
  return chunk.done ? null : decoder.decode(chunk.value)
}

/** The account list as `GET /v0/accounts` answers it. */
async function listed(h: AccountsHarness, request: Request) {
  const response = await h.handle(request)
  expect(response.status).toBe(200)
  return (await response.json()) as {
    accounts: {
      subject: string
      sessions: number
      lastLoginAt: number | null
      lastSeenAt: number | null
      streams: number
    }[]
  }
}

function rowOf(
  list: Awaited<ReturnType<typeof listed>>,
  subject: string,
): Awaited<ReturnType<typeof listed>>['accounts'][number] {
  const row = list.accounts.find(account => account.subject === subject)
  if (row === undefined) throw new Error(`no row for ${subject}`)
  return row
}

/**
 * Two members and an ops account, with an action ledger behind the console.
 * `actions.entries` starts empty: the invitations that made the three are
 * cleared, so a test reads only what it did.
 */
async function scene() {
  const actions = new MemoryActionLedger()
  const h = accountsHarness({ deps: { actions } })
  const a = await person(h.handle, 'member')
  const b = await person(h.handle, 'member')
  const ops = await person(h.handle, 'ops')
  actions.entries.splice(0)
  return { h, actions, a, b, ops }
}

/** Open a conversation as `who`; its id. */
async function converse(h: AccountsHarness, who: Person): Promise<string> {
  const response = await h.handle(
    asSession('POST', '/v0/chat/sessions', who.sid, {
      body: { target: ADDRESS },
    }),
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { id: string }).id
}

function accountLines(entries: readonly ConsoleAction[]): string[] {
  return entries
    .filter(entry => entry.action.startsWith('accounts.'))
    .map(
      entry =>
        `${entry.subject} ${entry.action} ${entry.target} ${entry.outcome}`,
    )
}

describe('the account list says when, and how many (成员 · 会话)', () => {
  test('last sign-in, last activity and live streams per account', async () => {
    const { h, a, b, ops } = await scene()
    const sa = subjectOf(h, a)
    const sb = subjectOf(h, b)
    const signedInAt = h.clock.now()
    h.clock.advance(5 * 60 * 1000)
    // A's session is used now; B's is not touched again.
    expect((await h.handle(asSession('GET', '/v0/limits', a.sid))).status).toBe(
      200,
    )
    const usedAt = h.clock.now()
    await stream(
      h,
      asSession('GET', '/v0/chat/stream', a.sid, { header: false }),
    )
    await stream(h, asBearer('GET', '/v0/chat/stream', a.credential))

    const list = await listed(h, asSession('GET', '/v0/accounts', ops.sid))
    expect(rowOf(list, sa)).toMatchObject({
      sessions: 1,
      lastLoginAt: signedInAt,
      lastSeenAt: usedAt,
      streams: 2,
    })
    expect(rowOf(list, sb)).toMatchObject({
      sessions: 1,
      lastLoginAt: signedInAt,
      lastSeenAt: signedInAt,
      streams: 0,
    })
  })

  test('a closed session still counts as the last sign-in; an idle one stops being live', async () => {
    const { h, a, ops } = await scene()
    const sa = subjectOf(h, a)
    const signedInAt = h.clock.now()
    h.clock.advance(3 * HOUR)
    // The ops session idled out too; a bearer reads the list.
    const list = await listed(
      h,
      asBearer('GET', '/v0/accounts', ops.credential),
    )
    expect(rowOf(list, sa)).toMatchObject({
      sessions: 0,
      lastLoginAt: signedInAt,
      lastSeenAt: null,
      streams: 0,
    })
  })

  test('the last sign-in survives a restart: it is read back from the session table', async () => {
    const { h, a, ops } = await scene()
    const sa = subjectOf(h, a)
    const signedInAt = h.clock.now()
    const again = accountsHarness({
      ledger: new MemoryLedger('memory://accounts.ndjson', h.ledger.text),
      sessions: new MemoryLedger('memory://sessions.ndjson', h.sessions.text),
      clock: h.clock,
    })
    expect(again.book.problem).toBeNull()
    const list = await listed(
      again,
      asBearer('GET', '/v0/accounts', ops.credential),
    )
    expect(rowOf(list, sa).lastLoginAt).toBe(signedInAt)
  })
})

describe('强制下线: POST /v0/accounts/<subject>/logout', () => {
  test('ends every session and every stream of the person; after it they hold none', async () => {
    const { h, actions, a, b, ops } = await scene()
    const sa = subjectOf(h, a)
    const bs = await converse(h, b)
    actions.entries.splice(0)
    const listeners = h.chat.listeners.size
    const viaCookie = await stream(
      h,
      asSession('GET', '/v0/chat/stream', a.sid, { header: false }),
    )
    const viaBearer = await stream(
      h,
      asBearer('GET', '/v0/chat/stream', a.credential),
    )
    const other = await stream(
      h,
      asSession('GET', '/v0/chat/stream', b.sid, { header: false }),
    )
    // The control: two streams are there to be ended.
    expect(h.book.openStreams(sa)).toBe(2)
    expect(h.chat.listeners.size).toBe(listeners + 3)

    const response = await h.handle(
      asSession('POST', `/v0/accounts/${sa}/logout`, ops.sid),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      subject: sa,
      sessions: 1,
      streams: 2,
    })

    expect(h.book.openStreams(sa)).toBe(0)
    expect(await next(viaCookie)).toBeNull()
    expect(await next(viaBearer)).toBeNull()
    expect(h.chat.listeners.size).toBe(listeners + 1)
    // The session is over; the credential is not.
    expect((await h.handle(asSession('GET', '/v0/limits', a.sid))).status).toBe(
      401,
    )
    expect(
      (await h.handle(asBearer('GET', '/v0/limits', a.credential))).status,
    ).toBe(200)
    // Nobody else's stream noticed.
    h.chat.emit(bs)
    expect(await next(other)).toContain(bs)
    // One ledger line, by the person who pressed it — `http.ts` writes it,
    // and nothing writes a second one.
    expect(accountLines(actions.entries)).toEqual([
      `${subjectOf(h, ops)} accounts.post /${sa}/logout ok`,
    ])
  })

  test('the session table takes it as a logout, and a restarted console reads it back', async () => {
    const { h, a, ops } = await scene()
    const sa = subjectOf(h, a)
    expect(
      (await h.handle(asSession('POST', `/v0/accounts/${sa}/logout`, ops.sid)))
        .status,
    ).toBe(200)
    const closed = h.sessions
      .lines()
      .filter(line => line.kind === 'session.closed')
    expect(closed.map(line => line.data['reason'])).toEqual(['logout'])
    // A reason older builds know: the table replays, and the session stays closed.
    const again = accountsHarness({
      ledger: new MemoryLedger('memory://accounts.ndjson', h.ledger.text),
      sessions: new MemoryLedger('memory://sessions.ndjson', h.sessions.text),
      clock: h.clock,
    })
    expect(again.book.problem).toBeNull()
    expect(
      (await again.handle(asSession('GET', '/v0/limits', a.sid))).status,
    ).toBe(401)
    expect(
      (await again.handle(asSession('GET', '/v0/limits', ops.sid))).status,
    ).toBe(200)
  })

  test('a session already past its limits is closed as expired and not counted', async () => {
    const { h, a } = await scene()
    const sa = subjectOf(h, a)
    h.clock.advance(3 * HOUR)
    const response = await h.handle(
      asAdmin('POST', `/v0/accounts/${sa}/logout`),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      subject: sa,
      sessions: 0,
      streams: 0,
    })
    const reasons = h.sessions
      .lines()
      .filter(line => line.kind === 'session.closed')
      .map(line => line.data['reason'])
    expect(reasons).toEqual(['expired'])
  })

  test('only ops and the admin token may; the book is untouched otherwise', async () => {
    const { h, actions, a, b } = await scene()
    const sa = subjectOf(h, a)
    const viewer = await person(h.handle, 'viewer')
    actions.entries.splice(0)
    const appends = h.sessions.appends
    for (const request of [
      asSession('POST', `/v0/accounts/${sa}/logout`, b.sid),
      asSession('POST', `/v0/accounts/${sa}/logout`, viewer.sid),
      asSession('POST', `/v0/accounts/${sa}/logout`, a.sid),
      asBearer('POST', `/v0/accounts/${sa}/logout`, 'view-token-000000000001'),
    ]) {
      expect((await h.handle(request)).status).toBe(403)
    }
    expect(h.sessions.appends).toBe(appends)
    expect(accountLines(actions.entries)).toEqual([])
    // A cookie needs the console header here, like every write.
    const ops = await person(h.handle, 'ops')
    expect(
      (
        await h.handle(
          asSession('POST', `/v0/accounts/${sa}/logout`, ops.sid, {
            header: false,
          }),
        )
      ).status,
    ).toBe(403)
    expect(
      (await h.handle(asSession('GET', `/v0/accounts/${sa}/logout`, ops.sid)))
        .status,
    ).toBe(405)
  })

  test('a ledger that cannot write stops it before anything is ended', async () => {
    const { h, actions, a, ops } = await scene()
    const sa = subjectOf(h, a)
    await stream(h, asBearer('GET', '/v0/chat/stream', a.credential))
    actions.admitResult = {
      ok: false,
      failure: { code: 'unreachable', message: 'ledger closed' },
    }
    const appends = h.sessions.appends
    const response = await h.handle(
      asSession('POST', `/v0/accounts/${sa}/logout`, ops.sid),
    )
    expect(response.status).toBe(503)
    // Nothing happened: the session, the stream and the session table are as they were.
    expect(h.book.openStreams(sa)).toBe(1)
    expect(h.sessions.appends).toBe(appends)
    expect((await h.handle(asSession('GET', '/v0/limits', a.sid))).status).toBe(
      200,
    )
    expect(accountLines(actions.entries)).toEqual([])
  })

  test('an unknown or revoked account is 404 and recorded as refused', async () => {
    const { h, actions, a } = await scene()
    const sa = subjectOf(h, a)
    expect(
      (await h.handle(asAdmin('POST', `/v0/accounts/${sa}/revoke`))).status,
    ).toBe(204)
    for (const subject of [sa, 'u:0000000000000000', 'nobody']) {
      const response = await h.handle(
        asAdmin('POST', `/v0/accounts/${subject}/logout`),
      )
      expect(response.status).toBe(404)
      expect(await response.text()).toContain('没有这个在用的账号')
    }
    expect(accountLines(actions.entries).slice(1)).toEqual([
      `legacy:admin accounts.post /${sa}/logout refused`,
      'legacy:admin accounts.post /u:0000000000000000/logout refused',
      'legacy:admin accounts.post /nobody/logout refused',
    ])
  })

  test('the admin token is named as the actor when it is the one that pressed it', async () => {
    const { h, actions, a } = await scene()
    const sa = subjectOf(h, a)
    const response = await h.handle(
      new Request(`${BASE}/v0/accounts/${sa}/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN}` },
      }),
    )
    expect(response.status).toBe(200)
    expect(accountLines(actions.entries)).toEqual([
      `legacy:admin accounts.post /${sa}/logout ok`,
    ])
  })
})
