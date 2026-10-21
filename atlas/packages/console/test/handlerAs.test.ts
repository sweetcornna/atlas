// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `handler.as` (P40 §5): a `/v0` request run in-process in a person's name,
 * the way the hub carries out a change an agent asked for once that person
 * approved it. It goes through the same route, the same role gates and the
 * same ledger as the person's own Bearer would, and with `via` every line it
 * writes names the agent and the approval too, which the access page shows.
 */

import { describe, expect, test } from 'bun:test'
import { ActionLedger, verifyActionLedger } from '../src/actionLedger.js'
import type { ConsolePrincipal } from '../src/contracts.js'
import type { ConsoleResult, ServerNote, ServerNotesPort } from '../src/deps.js'
import {
  type AccountsHarness,
  BASE,
  ManualClock,
  type Person,
  accountsHarness,
  asSession,
  person,
} from './accountsHarness.js'
import { MemoryActionStore } from './actionStore.js'

const AGENT = 'qianmo://tokyo-1/main'
const APPROVAL = `0123abcd${'0'.repeat(24)}`

class Notes implements ServerNotesPort {
  readonly stored = new Map<string, ServerNote>()
  constructor(private readonly now: () => number) {}
  list(): Promise<ConsoleResult<readonly ServerNote[]>> {
    return Promise.resolve({ ok: true, value: [...this.stored.values()] })
  }
  set(server: string, note: string): Promise<ConsoleResult<ServerNote>> {
    const record: ServerNote = { server, note, updatedAt: this.now() }
    this.stored.set(server, record)
    return Promise.resolve({ ok: true, value: record })
  }
}

function setup(): {
  readonly h: AccountsHarness
  readonly notes: Notes
  readonly store: MemoryActionStore
} {
  const clock = new ManualClock()
  const store = new MemoryActionStore()
  const notes = new Notes(clock.now)
  const h = accountsHarness({
    clock,
    deps: {
      actions: new ActionLedger({ store, now: clock.now }),
      nodeServers: [{ node: 'tokyo-1', server: 'p11' }],
      serverNotes: notes,
    },
  })
  return { h, notes, store }
}

function principalOf(
  h: AccountsHarness,
  who: Person,
): Extract<ConsolePrincipal, { kind: 'user' }> {
  const found = h.book.bearerPrincipal(who.credential)
  if (!found.ok || found.value.kind !== 'user') throw new Error('not a person')
  return found.value
}

function putNote(note: string): Request {
  return new Request(`${BASE}/v0/servers/p11/note`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note }),
  })
}

/** The action lines after the header, as data. */
function lines(store: MemoryActionStore): Record<string, unknown>[] {
  return store
    .lines()
    .slice(1)
    .map(line => ({ kind: line.kind, ...(line.data as object) }))
}

describe('handler.as (P40 §5)', () => {
  test('runs the route as the person, and the ledger names agent and approval', async () => {
    const { h, notes, store } = setup()
    const ops = await person(h.handle, 'ops')
    const approver = principalOf(h, ops)
    const response = await h.handle.as(
      { ...approver, credential: 'approval-session' },
      putNote('换过硬盘'),
      { agent: AGENT, approval: APPROVAL },
    )
    expect(response.status).toBe(200)
    expect(notes.stored.get('p11')?.note).toBe('换过硬盘')

    const written = lines(store).filter(line => line['target'] === 'p11')
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({
      subject: approver.subject,
      outcome: 'ok',
      agent: AGENT,
      approval: APPROVAL,
    })
    expect(verifyActionLedger(store.text).chain).toBe('intact')

    const page = await h.handle(
      asSession('GET', '/admin/access/actions', ops.sid, {
        header: false,
        accept: 'text/html',
      }),
    )
    const html = await page.text()
    expect(html).toContain(`经 ${AGENT} · 审批`)
    expect(html).toContain('<span class="mono">0123abcd</span>')
    expect(html).not.toContain(APPROVAL)
  })

  test('without via it is the person alone, and a read changes nothing', async () => {
    const { h, notes, store } = setup()
    const ops = await person(h.handle, 'ops')
    const approver = principalOf(h, ops)
    expect((await h.handle.as(approver, putNote('a'))).status).toBe(200)
    const read = await h.handle.as(approver, new Request(`${BASE}/v0/servers`))
    expect(read.status).toBe(200)
    expect(JSON.stringify(await read.json())).toContain('"note":"a"')
    expect(notes.stored.get('p11')?.note).toBe('a')
    for (const line of lines(store)) {
      expect(line['agent']).toBeUndefined()
      expect(line['approval']).toBeUndefined()
    }
  })

  test('refuses what is not /v0, what is not a person, and a person no longer there', async () => {
    const { h, notes, store } = setup()
    const ops = await person(h.handle, 'ops')
    const approver = principalOf(h, ops)
    const before = store.lines().length

    expect(
      (await h.handle.as(approver, new Request(`${BASE}/admin/servers`)))
        .status,
    ).toBe(404)
    expect(
      (await h.handle.as(approver, new Request(`${BASE}/invite`))).status,
    ).toBe(404)
    const legacy = await h.handle.as(
      { kind: 'legacy', subject: 'legacy:admin', credential: 'bearer' },
      putNote('x'),
    )
    expect(legacy.status).toBe(403)
    expect(await legacy.text()).toContain('只有个人账号能在进程内代为执行')

    const member = principalOf(h, await person(h.handle, 'member'))
    expect((await h.handle.as(member, putNote('x'))).status).toBe(403)
    // A role the book does not hold any more is not a role.
    expect(
      (await h.handle.as({ ...member, role: 'ops' }, putNote('x'))).status,
    ).toBe(403)

    expect(h.book.revoke(approver.subject, 'legacy:admin').ok).toBe(true)
    const revoked = await h.handle.as(approver, putNote('x'), {
      agent: AGENT,
      approval: APPROVAL,
    })
    expect(revoked.status).toBe(403)
    expect(await revoked.text()).toContain('账号已不可用或角色已变化')

    expect(notes.stored.size).toBe(0)
    expect(
      lines(store)
        .slice(before - 1)
        .filter(line => line['outcome'] === 'ok' && line['target'] === 'p11'),
    ).toEqual([])
  })
})
