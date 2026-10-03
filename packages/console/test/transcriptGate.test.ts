// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P15.9 — opening a transcript asks the action ledger first (D6).
 *
 * Every opening of a conversation is a line in the ledger, and the person it
 * belongs to can look it up. A ledger that cannot take the line therefore
 * cannot let the opening happen: the three places a transcript is opened —
 * the JSON read, the thread fragment with `?open=1`, and the page with
 * `?session=` — ask `admit` before the transcript is read, and the proof is
 * the port: `ChatPort.transcript` is called zero times while the ledger is
 * closed.
 *
 * The poll (no `?open=1`) is the fourth path, and the one a script could have
 * used to read without a trace. It is covered by the reading before it: the
 * same person's same conversation recorded in the last thirty minutes, and it
 * goes ahead unrecorded; otherwise it is an opening like the others — asked
 * first, written down once.
 */

import { describe, expect, test } from 'bun:test'
import { ActionLedger } from '../src/actionLedger.js'
import {
  ADDRESS,
  accountsHarness,
  asAdmin,
  asSession,
  person,
} from './accountsHarness.js'
import { MemoryActionStore } from './actionStore.js'
import { MemoryActionLedger } from './memoryActions.js'
import { ADMIN, browse, call, pageHarness } from './pageHarness.js'

const CLOSED_TEXT = '动作账本停用，暂时不能打开对话'

/** A console with one conversation in it, then its ledger closed. */
async function closedAfterOpening() {
  const actions = new MemoryActionLedger()
  const h = pageHarness({ chat: true, actions })
  const opened = await h.handle(
    call('POST', '/v0/chat/sessions', ADMIN, { target: ADDRESS }),
  )
  expect(opened.status).toBe(200)
  const { id } = (await opened.json()) as { id: string }
  actions.admitResult = {
    ok: false,
    failure: { code: 'unreachable', message: '链断了' },
  }
  h.chat.transcripts = 0
  const before = actions.entries.length
  return { h, actions, id, before }
}

describe('a closed ledger: no transcript is opened', () => {
  test('JSON: GET /v0/chat/sessions/<id> is a 503 and the port is never asked', async () => {
    const { h, actions, id, before } = await closedAfterOpening()
    const response = await h.handle(
      call('GET', `/v0/chat/sessions/${id}`, ADMIN),
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: { code: 'unavailable' },
    })
    expect(h.chat.transcripts).toBe(0)
    expect(actions.entries.length).toBe(before)
  })

  test('fragment: ?open=1 is a 503 fragment saying why; the port is never asked', async () => {
    const { h, actions, id, before } = await closedAfterOpening()
    const response = await h.handle(
      call('GET', `/fragments/chat/thread/${id}?open=1`, ADMIN),
    )
    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toContain('text/html')
    const body = await response.text()
    expect(body).toContain(CLOSED_TEXT)
    expect(body).toContain('id="chat-thread"')
    expect(h.chat.transcripts).toBe(0)
    expect(actions.entries.length).toBe(before)
  })

  test('fragment: a poll with no reading before it is an opening, so it is a 503 too', async () => {
    const { h, actions, id, before } = await closedAfterOpening()
    const response = await h.handle(
      call('GET', `/fragments/chat/thread/${id}`, ADMIN),
    )
    expect(response.status).toBe(503)
    expect(await response.text()).toContain(CLOSED_TEXT)
    expect(h.chat.transcripts).toBe(0)
    expect(actions.entries.length).toBe(before)
  })

  test('page: /chat?session= still draws the page, with the reason in place of the thread, as a 503', async () => {
    const { h, actions, id, before } = await closedAfterOpening()
    const response = await h.handle(browse(`/chat?session=${id}`, ADMIN))
    expect(response.status).toBe(503)
    const page = await response.text()
    expect(page).toContain(CLOSED_TEXT)
    // The rest of the page is there: the conversation list with this one in it.
    expect(page).toContain('id="chat-sessions"')
    expect(page).toContain(id)
    expect(h.chat.transcripts).toBe(0)
    expect(actions.entries.length).toBe(before)
    // Without a conversation named, nothing is opened and nothing is asked.
    const plain = await h.handle(browse('/chat', ADMIN))
    expect(plain.status).toBe(200)
    expect(h.chat.transcripts).toBe(0)
  })

  test('an open ledger is asked once per opening and the opening goes ahead', async () => {
    const actions = new MemoryActionLedger()
    const h = pageHarness({ chat: true, actions })
    const opened = await h.handle(
      call('POST', '/v0/chat/sessions', ADMIN, { target: ADDRESS }),
    )
    const { id } = (await opened.json()) as { id: string }
    const asked = actions.admitCalls
    expect((await h.handle(browse(`/chat?session=${id}`, ADMIN))).status).toBe(
      200,
    )
    expect(
      (
        await h.handle(
          call('GET', `/fragments/chat/thread/${id}?open=1`, ADMIN),
        )
      ).status,
    ).toBe(200)
    expect(
      (await h.handle(call('GET', `/v0/chat/sessions/${id}`, ADMIN))).status,
    ).toBe(200)
    // A poll asks nothing.
    await h.handle(call('GET', `/fragments/chat/thread/${id}`, ADMIN))
    expect(actions.admitCalls - asked).toBe(3)
    expect(
      actions.entries.filter(e => e.action === 'chat.transcript.open'),
    ).toHaveLength(3)
  })
})

describe('with personal accounts and the hash-chained ledger', () => {
  test('ops cannot open a member’s conversation once the ledger file is damaged', async () => {
    const store = new MemoryActionStore()
    const ledger = new ActionLedger({ store })
    const h = accountsHarness({ deps: { actions: ledger } })
    const member = await person(h.handle, 'member')
    const ops = await person(h.handle, 'ops')
    const opened = await h.handle(
      asSession('POST', '/v0/chat/sessions', member.sid, {
        body: { target: ADDRESS },
      }),
    )
    const { id } = (await opened.json()) as { id: string }
    // The session-open line rewritten: the chain breaks from there.
    expect(store.text ?? '').toContain('chat.session.open')
    store.text = (store.text ?? '').replace(
      'chat.session.open',
      'chat.session.shut',
    )
    h.chat.transcripts = 0

    const api = await h.handle(
      asSession('GET', `/v0/chat/sessions/${id}`, ops.sid),
    )
    const fragment = await h.handle(
      asSession('GET', `/fragments/chat/thread/${id}?open=1`, ops.sid),
    )
    const page = await h.handle(
      asSession('GET', `/chat?session=${id}`, ops.sid, {
        header: false,
        accept: 'text/html',
      }),
    )
    expect([api.status, fragment.status, page.status]).toEqual([503, 503, 503])
    expect(h.chat.transcripts).toBe(0)
  })

  test('a conversation the caller may not see is still the plain 404, ledger or not', async () => {
    const actions = new MemoryActionLedger()
    const h = accountsHarness({ deps: { actions } })
    const a = await person(h.handle, 'member')
    const b = await person(h.handle, 'member')
    const opened = await h.handle(
      asSession('POST', '/v0/chat/sessions', a.sid, {
        body: { target: ADDRESS },
      }),
    )
    const { id } = (await opened.json()) as { id: string }
    const open = await h.handle(
      asSession('GET', `/v0/chat/sessions/${id}`, b.sid),
    )
    actions.admitResult = {
      ok: false,
      failure: { code: 'unreachable', message: '链断了' },
    }
    const closed = await h.handle(
      asSession('GET', `/v0/chat/sessions/${id}`, b.sid),
    )
    expect([open.status, closed.status]).toEqual([404, 404])
    expect(await closed.text()).toBe(await open.text())
  })
})

// --- the poll: covered by the reading before it -------------------------------

const MINUTE = 60 * 1000

/** An admin-token console on a manual clock, one conversation, nothing read. */
async function polling() {
  const actions = new MemoryActionLedger()
  const h = accountsHarness({ deps: { actions } })
  const opened = await h.handle(
    asAdmin('POST', '/v0/chat/sessions', { target: ADDRESS }),
  )
  const { id } = (await opened.json()) as { id: string }
  const poll = () => h.handle(asAdmin('GET', `/fragments/chat/thread/${id}`))
  const readings = () =>
    actions.entries.filter(e => e.action === 'chat.transcript.open')
  return { h, actions, id, poll, readings }
}

describe('polls: the first read in a window is a reading', () => {
  test('never opened, polled a hundred times: the first poll is one line, the other 99 none', async () => {
    const { h, actions, id, poll, readings } = await polling()
    const asked = actions.admitCalls
    for (let i = 0; i < 100; i++) {
      expect((await poll()).status).toBe(200)
    }
    expect(readings().map(e => `${e.target} ${e.subject}`)).toEqual([
      `${id} legacy:admin`,
    ])
    // Asked once, for the one that was recorded; the rest were covered.
    expect(actions.admitCalls - asked).toBe(1)
    expect(h.chat.transcripts).toBe(100)
  })

  test('the window runs out: the next poll is another line', async () => {
    const { h, poll, readings } = await polling()
    await poll()
    h.clock.advance(29 * MINUTE)
    await poll()
    expect(readings()).toHaveLength(1)
    // Polls do not stretch the window: thirty minutes after the line, not
    // after the last poll.
    h.clock.advance(2 * MINUTE)
    await poll()
    expect(readings()).toHaveLength(2)
    await poll()
    expect(readings()).toHaveLength(2)
  })

  test('an explicit opening restarts the window', async () => {
    const { h, id, poll, readings } = await polling()
    await poll()
    h.clock.advance(20 * MINUTE)
    await h.handle(asAdmin('GET', `/fragments/chat/thread/${id}?open=1`))
    expect(readings()).toHaveLength(2)
    h.clock.advance(20 * MINUTE)
    await poll()
    expect(readings()).toHaveLength(2)
  })

  test('each person has their own window', async () => {
    const actions = new MemoryActionLedger()
    const h = accountsHarness({ deps: { actions } })
    const member = await person(h.handle, 'member')
    const ops = await person(h.handle, 'ops')
    const opened = await h.handle(
      asSession('POST', '/v0/chat/sessions', member.sid, {
        body: { target: ADDRESS },
      }),
    )
    const { id } = (await opened.json()) as { id: string }
    const path = `/fragments/chat/thread/${id}`
    await h.handle(asSession('GET', `${path}?open=1`, member.sid))
    // The owner's opening does not cover anybody else's first poll.
    await h.handle(asSession('GET', path, ops.sid))
    await h.handle(asSession('GET', path, ops.sid))
    await h.handle(asSession('GET', path, member.sid))
    const subjects = actions.entries
      .filter(e => e.action === 'chat.transcript.open')
      .map(e => e.subject)
    expect(subjects).toHaveLength(2)
    expect(new Set(subjects).size).toBe(2)
  })

  test('a closed ledger: an unrecorded poll is a 503 and reads nothing; one inside its window still reads', async () => {
    const { h, actions, id, poll, readings } = await polling()
    // Recorded once while the ledger was open: that reading covers the window.
    await poll()
    actions.admitResult = {
      ok: false,
      failure: { code: 'unreachable', message: '链断了' },
    }
    h.chat.transcripts = 0
    expect((await poll()).status).toBe(200)
    expect(h.chat.transcripts).toBe(1)
    // Past the window it is an opening again, and the ledger cannot take it.
    h.clock.advance(31 * MINUTE)
    const refused = await poll()
    expect(refused.status).toBe(503)
    expect(await refused.text()).toContain(CLOSED_TEXT)
    expect(h.chat.transcripts).toBe(1)
    expect(readings()).toHaveLength(1)
    expect(id).not.toBe('')
  })

  test('a pair pushed out of the window by 4096 others is recorded again', async () => {
    const { h, id, poll, readings } = await polling()
    await poll()
    const others: string[] = []
    for (let i = 0; i < 4096; i++) {
      const opened = await h.chat.open(ADDRESS)
      if (opened.ok) others.push(opened.value.id)
    }
    for (const other of others) {
      await h.handle(asAdmin('GET', `/fragments/chat/thread/${other}`))
    }
    expect(readings()).toHaveLength(4097)
    await poll()
    expect(readings().filter(e => e.target === id)).toHaveLength(2)
  })
})
