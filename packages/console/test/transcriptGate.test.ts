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
 * closed. The poll (no `?open=1`) records nothing and is left alone.
 */

import { describe, expect, test } from 'bun:test'
import { ActionLedger } from '../src/actionLedger.js'
import {
  ADDRESS,
  accountsHarness,
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

  test('fragment: the poll (no ?open=1) is not an opening and is left alone', async () => {
    const { h, actions, id, before } = await closedAfterOpening()
    const response = await h.handle(
      call('GET', `/fragments/chat/thread/${id}`, ADMIN),
    )
    expect(response.status).toBe(200)
    expect(h.chat.transcripts).toBe(1)
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
