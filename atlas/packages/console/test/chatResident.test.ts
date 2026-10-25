// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 常驻会话 (P37.17, `src/chatResident.ts`): one conversation per person and
 * agent. `POST /v0/chat/sessions` answers with the one the reader has, and
 * opens one only when they have none; sessions opened any other way are
 * never it.
 */

import { describe, expect, test } from 'bun:test'
import type { Access, ConsoleAccounts } from '../src/access.js'
import { residentOwnerOf, residentSessions } from '../src/chatResident.js'
import type { ChatSession } from '../src/deps.js'
import {
  ADDRESS,
  asAdmin,
  asBearer,
  asSession,
  accountsHarness,
  person,
  START,
} from './accountsHarness.js'
import { MemoryActionLedger } from './memoryActions.js'

const REVIEWER = 'qianmo://tokyo-1/reviewer'

async function idOf(response: Response): Promise<string> {
  expect(response.status).toBe(200)
  const body = (await response.json()) as { id: string; resident?: true }
  expect(body.resident).toBe(true)
  return body.id
}

describe('POST /v0/chat/sessions answers with the reader’s one conversation', () => {
  test('the same agent again is the same session: nothing opened, no ledger line, no admission asked', async () => {
    const actions = new MemoryActionLedger()
    const h = accountsHarness({ deps: { actions } })
    const member = await person(h.handle, 'member')
    const open = () =>
      h.handle(
        asSession('POST', '/v0/chat/sessions', member.sid, {
          body: { target: ADDRESS },
        }),
      )
    const first = await idOf(await open())
    const opens = () =>
      actions.entries.filter(entry => entry.action === 'chat.session.open')
    expect(opens()).toHaveLength(1)
    // A closed ledger refuses writes; answering with the conversation the
    // reader already has is not one.
    actions.admitResult = {
      ok: false,
      failure: { code: 'unreachable', message: '账本停用' },
    }
    expect(await idOf(await open())).toBe(first)
    expect(await idOf(await open())).toBe(first)
    expect(h.chat.opened).toBe(1)
    expect(opens()).toHaveLength(1)
    // Another agent is another conversation, and that is a write.
    const other = await h.handle(
      asSession('POST', '/v0/chat/sessions', member.sid, {
        body: { target: REVIEWER },
      }),
    )
    expect(other.status).toBe(503)
    expect(h.chat.opened).toBe(1)
  })

  test('each person has their own, ops included; the admin token has the one without an owner', async () => {
    const h = accountsHarness()
    const a = await person(h.handle, 'member')
    const b = await person(h.handle, 'member')
    const ops = await person(h.handle, 'ops')
    const post = (request: Request) => h.handle(request)
    const ids = {
      a: await idOf(
        await post(
          asSession('POST', '/v0/chat/sessions', a.sid, {
            body: { target: ADDRESS },
          }),
        ),
      ),
      b: await idOf(
        await post(
          asBearer('POST', '/v0/chat/sessions', b.credential, {
            target: ADDRESS,
          }),
        ),
      ),
      // ops sees every session, and still gets its own, not a member's.
      ops: await idOf(
        await post(
          asSession('POST', '/v0/chat/sessions', ops.sid, {
            body: { target: ADDRESS },
          }),
        ),
      ),
      admin: await idOf(
        await post(asAdmin('POST', '/v0/chat/sessions', { target: ADDRESS })),
      ),
    }
    expect(new Set(Object.values(ids)).size).toBe(4)
    expect(
      await idOf(
        await post(asAdmin('POST', '/v0/chat/sessions', { target: ADDRESS })),
      ),
    ).toBe(ids.admin)
    expect(
      await idOf(
        await post(
          asSession('POST', '/v0/chat/sessions', ops.sid, {
            body: { target: ADDRESS },
          }),
        ),
      ),
    ).toBe(ids.ops)
    expect(h.chat.opened).toBe(4)
  })

  test('two at once open one', async () => {
    const h = accountsHarness()
    const member = await person(h.handle, 'member')
    const answers = await Promise.all(
      Array.from({ length: 5 }, () =>
        h.handle(
          asSession('POST', '/v0/chat/sessions', member.sid, {
            body: { target: ADDRESS },
          }),
        ),
      ),
    )
    const ids = await Promise.all(answers.map(idOf))
    expect(new Set(ids).size).toBe(1)
    expect(h.chat.opened).toBe(1)
  })

  test('a session opened any other way is never the one: schedules, channels and tasks open their own', async () => {
    const h = accountsHarness()
    // What `ChatDispatch.open` opens for a schedule or a channel: no mark.
    const machine = await h.chat.open(ADDRESS)
    if (!machine.ok) throw new Error(machine.failure.message)
    const id = await idOf(
      await h.handle(asAdmin('POST', '/v0/chat/sessions', { target: ADDRESS })),
    )
    expect(id).not.toBe(machine.value.id)
    const listed = (await (
      await h.handle(asAdmin('GET', '/v0/chat/sessions'))
    ).json()) as { sessions: ChatSession[] }
    expect(
      listed.sessions.map(one => [one.id, one.resident === true]).sort(),
    ).toEqual(
      [
        [machine.value.id, false],
        [id, true],
      ].sort(),
    )
  })
})

describe('which marked session is whose', () => {
  const session = (
    id: string,
    target: string,
    createdAt: number,
    resident = true,
  ): ChatSession => ({
    id,
    target,
    node: 'tokyo-1',
    agent: target.slice(target.lastIndexOf('/') + 1),
    createdAt,
    updatedAt: createdAt,
    turnCount: 0,
    preview: '',
    ...(resident ? { resident: true as const } : {}),
  })

  test('the first opened of the reader’s marked sessions, per agent; unmarked and other people’s never', () => {
    const owners: Record<string, `u:${string}` | null> = {
      early: 'u:aaaa',
      late: 'u:aaaa',
      theirs: 'u:bbbb',
      plain: 'u:aaaa',
      review: 'u:aaaa',
      legacy: null,
    }
    const found = residentSessions(
      [
        session('late', ADDRESS, START + 10),
        session('early', ADDRESS, START),
        session('theirs', ADDRESS, START - 10),
        session('plain', REVIEWER, START - 20, false),
        session('review', REVIEWER, START + 30),
        session('legacy', ADDRESS, START - 30),
      ],
      { opener: 'u:aaaa', ownerOf: id => owners[id] ?? null },
    )
    expect([...found].map(([target, one]) => [target, one.id])).toEqual([
      [ADDRESS, 'early'],
      [REVIEWER, 'review'],
    ])
  })

  test('with the account book unavailable nobody has one, so nobody is handed somebody else’s', () => {
    const access: Access = {
      principal: {
        kind: 'user',
        subject: 'u:aaaa',
        role: 'ops',
        credential: 'session',
        authenticatedAt: START,
      },
      sid: null,
      refusal: null,
      breakGlass: false,
      credential: {
        role: 'admin',
        source: 'cookie',
        header: true,
        crossOrigin: false,
      },
    }
    const closed = {
      book: { problem: '账本坏了', ownerOf: () => null },
    } as unknown as ConsoleAccounts
    expect(residentOwnerOf(access, closed)).toBeNull()
    expect(residentSessions([session('any', ADDRESS, START)], null).size).toBe(
      0,
    )
    // Without accounts every session is the one operator's.
    const legacy = residentOwnerOf(access, undefined)
    expect(legacy?.opener).toBeNull()
    expect(
      residentSessions([session('any', ADDRESS, START)], legacy).get(ADDRESS)
        ?.id,
    ).toBe('any')
  })
})
