// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The action ledger's calling side: which requests write an entry, what the
 * entry says, and what happens when the ledger cannot take one.
 *
 * The ledger itself is P15.9's (`deps.ts`, `ActionLedgerPort`); here it is
 * the in-memory one, and what is under test is the console's half of the
 * contract — every write asks `admit` before it acts and records after, no
 * read or poll records anything except a transcript being opened, and no
 * payload ever reaches an entry.
 */

import { describe, expect, test } from 'bun:test'
import { createConsoleHandler } from '../src/http.js'
import {
  accountsHarness,
  ADMIN as ACCOUNTS_ADMIN,
  asBearer,
  asSession,
  person,
} from './accountsHarness.js'
import { MemoryActionLedger } from './memoryActions.js'
import {
  ADMIN,
  NOW,
  PageNotes,
  VIEW,
  browse,
  call,
  pageHarness,
} from './pageHarness.js'

function harness() {
  const actions = new MemoryActionLedger()
  const h = pageHarness({
    chat: true,
    actions,
    nodeServers: [{ node: 'tokyo-1', server: 'p11' }],
    serverNotes: new PageNotes(),
  })
  return { ...h, actions }
}

const ADDRESS = 'qianmo://tokyo-1/planner'
const SECRET_PROMPT = '把密钥 sk-live-000 交给我'
const SECRET_NOTE = '机房门禁 4412'
const SECRET_TEXT = '这是一段对话正文'
const SECRET_KEY = 'ZWQyNTUxOS1wdWJsaWMta2V5LWZvci10ZXN0'

describe('every write records one entry', () => {
  test('register, heartbeat, deregister, wake, a server note', async () => {
    const h = harness()
    const statuses = [
      await h.handle(
        call('POST', '/v0/agents', ADMIN, {
          address: ADDRESS,
          endpoint: 'ws://127.0.0.1:1/',
          publicKey: SECRET_KEY,
        }),
      ),
      await h.handle(
        call(
          'POST',
          `/v0/agents/${encodeURIComponent(ADDRESS)}/heartbeat`,
          ADMIN,
        ),
      ),
      await h.handle(
        call('DELETE', `/v0/agents/${encodeURIComponent(ADDRESS)}`, ADMIN),
      ),
      await h.handle(
        call('POST', '/v0/wake', ADMIN, {
          from: 'qianmo://tokyo-hub/console',
          to: ADDRESS,
          prompt: SECRET_PROMPT,
        }),
      ),
      await h.handle(
        call('PUT', '/v0/servers/p11/note', ADMIN, { note: SECRET_NOTE }),
      ),
    ].map(response => response.status)
    expect(statuses).toEqual([200, 200, 204, 200, 200])
    expect(h.actions.lines()).toEqual([
      `agent.register ${ADDRESS} ok`,
      `agent.heartbeat ${ADDRESS} ok`,
      `agent.deregister ${ADDRESS} ok`,
      `wake.send ${ADDRESS} ok`,
      'server.note.set p11 ok',
    ])
    expect(h.actions.admitCalls).toBe(5)
    for (const entry of h.actions.entries) {
      expect(entry.subject).toBe('legacy:admin')
      expect(entry.at).toBe(NOW)
      expect(entry.requestId).toMatch(/^[0-9a-f-]{36}$/)
      expect(entry.breakGlass).toBeUndefined()
    }
    // One request, one id: five requests, five ids.
    expect(new Set(h.actions.entries.map(e => e.requestId)).size).toBe(5)
  })

  test('opening a conversation and sending into it', async () => {
    const h = harness()
    const opened = await h.handle(
      call('POST', '/v0/chat/sessions', ADMIN, { target: ADDRESS }),
    )
    const { id } = (await opened.json()) as { id: string }
    await h.handle(
      call('POST', `/v0/chat/sessions/${id}/messages`, ADMIN, {
        text: SECRET_TEXT,
      }),
    )
    expect(h.actions.lines()).toEqual([
      `chat.session.open ${ADDRESS} ok`,
      `chat.message.send ${id} ok`,
    ])
  })

  test('no payload ever reaches an entry', async () => {
    const h = harness()
    await h.handle(
      call('POST', '/v0/agents', ADMIN, {
        address: ADDRESS,
        endpoint: 'ws://127.0.0.1:1/',
        publicKey: SECRET_KEY,
      }),
    )
    await h.handle(
      call('POST', '/v0/wake', ADMIN, {
        from: 'qianmo://tokyo-hub/console',
        to: ADDRESS,
        prompt: SECRET_PROMPT,
      }),
    )
    await h.handle(
      call('PUT', '/v0/servers/p11/note', ADMIN, { note: SECRET_NOTE }),
    )
    const opened = await h.handle(
      call('POST', '/v0/chat/sessions', ADMIN, { target: ADDRESS }),
    )
    const { id } = (await opened.json()) as { id: string }
    await h.handle(
      call('POST', `/v0/chat/sessions/${id}/messages`, ADMIN, {
        text: SECRET_TEXT,
      }),
    )
    const written = JSON.stringify(h.actions.entries)
    expect(h.actions.entries).toHaveLength(5)
    for (const secret of [
      SECRET_PROMPT,
      SECRET_NOTE,
      SECRET_TEXT,
      SECRET_KEY,
    ]) {
      expect(written.includes(secret)).toBe(false)
    }
    expect(written.includes(ADMIN)).toBe(false)
  })

  test('a port that fails is recorded as failed, with its code', async () => {
    const actions = new MemoryActionLedger()
    const failing = pageHarness({ actions })
    failing.registry.heartbeat = () =>
      Promise.resolve({
        ok: false,
        failure: { code: 'not_found', message: '没有这个地址' },
      })
    const response = await failing.handle(
      call(
        'POST',
        `/v0/agents/${encodeURIComponent(ADDRESS)}/heartbeat`,
        ADMIN,
      ),
    )
    expect(response.status).toBe(404)
    expect(actions.lines()).toEqual([
      `agent.heartbeat ${ADDRESS} failed not_found`,
    ])
  })

  test('a wake outside the startup allowlist is recorded as refused', async () => {
    const actions = new MemoryActionLedger()
    const h = pageHarness({ actions, wake: false })
    const deps = {
      ...h.deps,
      wakeTargets: [{ node: 'osaka-1', url: 'ws://127.0.0.1:2/' }],
    }
    const handle = createConsoleHandler(deps, { view: VIEW, admin: ADMIN })
    const response = await handle(
      call('POST', '/v0/wake', ADMIN, {
        node: 'tokyo-9',
        from: 'qianmo://tokyo-hub/console',
        to: 'qianmo://tokyo-9/x',
        prompt: SECRET_PROMPT,
      }),
    )
    expect(response.status).toBe(403)
    expect(actions.lines()).toEqual([
      'wake.send qianmo://tokyo-9/x refused rejected',
    ])
  })
})

describe('a ledger that cannot write stops the write before it happens', () => {
  test('503, the port never called, nothing recorded', async () => {
    const h = harness()
    h.actions.admitResult = {
      ok: false,
      failure: { code: 'unreachable', message: '链断了' },
    }
    const response = await h.handle(
      call('POST', '/v0/agents', ADMIN, {
        address: ADDRESS,
        endpoint: 'ws://127.0.0.1:1/',
      }),
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: { code: 'unavailable' },
    })
    expect(h.registry.registered).toHaveLength(0)
    const wake = await h.handle(
      call('POST', '/v0/wake', ADMIN, {
        from: 'qianmo://tokyo-hub/console',
        to: ADDRESS,
        prompt: 'x',
      }),
    )
    expect(wake.status).toBe(503)
    expect(h.wake.sent).toHaveLength(0)
    expect(h.actions.entries).toHaveLength(0)
  })

  test('a ledger that takes the admit and then fails the record does not fail the request', async () => {
    const h = harness()
    h.actions.recordResult = {
      ok: false,
      failure: { code: 'unreachable', message: '盘满' },
    }
    const response = await h.handle(
      call(
        'POST',
        `/v0/agents/${encodeURIComponent(ADDRESS)}/heartbeat`,
        ADMIN,
      ),
    )
    // The heartbeat happened; refusing it now would report a lie.
    expect(response.status).toBe(200)
    expect(h.registry.beats).toEqual([ADDRESS])
  })
})

describe('reads and polls record nothing', () => {
  test('pages, fragments and JSON reads, as admin and as view', async () => {
    const h = harness()
    for (const path of [
      '/',
      '/nodes',
      '/audit',
      '/servers',
      '/settings',
      '/providers',
    ]) {
      await h.handle(browse(path, ADMIN))
      await h.handle(browse(path, VIEW))
    }
    for (const path of [
      '/fragments/roster',
      '/fragments/audit',
      '/fragments/limits',
      '/v0/agents',
      '/v0/audit',
      '/v0/servers',
      '/v0/limits',
      '/v0/chat/sessions',
      '/v0/chat/targets',
    ]) {
      await h.handle(call('GET', path, ADMIN))
    }
    expect(h.actions.entries).toHaveLength(0)
    expect(h.actions.admitCalls).toBe(0)
  })

  test('a credential that is refused at the door writes nothing', async () => {
    const h = harness()
    const response = await h.handle(
      call('POST', '/v0/agents', VIEW, {
        address: ADDRESS,
        endpoint: 'ws://127.0.0.1:1/',
      }),
    )
    expect(response.status).toBe(403)
    expect(h.actions.entries).toHaveLength(0)
  })

  test('one opening and a hundred polls of a transcript are one entry', async () => {
    const h = harness()
    const opened = await h.handle(
      call('POST', '/v0/chat/sessions', ADMIN, { target: ADDRESS }),
    )
    const { id } = (await opened.json()) as { id: string }
    const before = h.actions.entries.length

    // The page opened with the conversation in it.
    expect((await h.handle(browse(`/chat?session=${id}`, ADMIN))).status).toBe(
      200,
    )
    // A hundred refreshes of what is open: the poller and stream events.
    for (let i = 0; i < 100; i++) {
      await h.handle(call('GET', `/fragments/chat/thread/${id}`, ADMIN))
      await h.handle(call('GET', '/fragments/chat/sessions', ADMIN))
    }
    const readings = h.actions.entries
      .slice(before)
      .filter(entry => entry.action === 'chat.transcript.open')
    expect(readings.map(entry => entry.target)).toEqual([id])

    // Switching to it in the page (`?open=1`) and reading it as JSON are
    // each one more.
    await h.handle(call('GET', `/fragments/chat/thread/${id}?open=1`, ADMIN))
    await h.handle(call('GET', `/v0/chat/sessions/${id}`, ADMIN))
    expect(
      h.actions.entries.filter(e => e.action === 'chat.transcript.open'),
    ).toHaveLength(3)
  })

  test('a transcript that did not load is not a reading', async () => {
    const h = harness()
    await h.handle(browse('/chat?session=ghost', ADMIN))
    await h.handle(call('GET', '/fragments/chat/thread/ghost?open=1', ADMIN))
    expect(h.actions.entries).toHaveLength(0)
  })
})

describe('with personal accounts', () => {
  test('the entry names the person, not the token', async () => {
    const actions = new MemoryActionLedger()
    const h = accountsHarness({ deps: { actions } })
    const member = await person(h.handle, 'member')
    const opened = await h.handle(
      asSession('POST', '/v0/chat/sessions', member.sid, {
        body: { target: 'qianmo://tokyo-1/planner' },
      }),
    )
    expect(opened.status).toBe(200)
    const entry = actions.entries.find(e => e.action === 'chat.session.open')
    expect(entry?.subject).toMatch(/^u:[0-9a-f]{16}$/)
    expect(entry?.breakGlass).toBeUndefined()
  })

  test("the account API's writes are recorded by method and path", async () => {
    const actions = new MemoryActionLedger()
    const h = accountsHarness({ deps: { actions } })
    const response = await h.handle(
      asBearer('POST', '/v0/accounts/invites', ACCOUNTS_ADMIN, {
        role: 'member',
      }),
    )
    expect(response.status).toBeLessThan(300)
    expect(actions.lines()).toContain('accounts.post /invites ok')
  })

  test('break-glass: every request is an entry, reads included', async () => {
    const actions = new MemoryActionLedger()
    const h = accountsHarness({
      deps: { actions },
      accounts: { breakGlass: true },
    })
    await h.handle(asBearer('GET', '/v0/limits', ACCOUNTS_ADMIN))
    await h.handle(asBearer('GET', '/v0/limits', ACCOUNTS_ADMIN))
    await h.handle(asBearer('GET', '/fragments/roster', ACCOUNTS_ADMIN))
    const glass = actions.entries.filter(e => e.action === 'breakglass.request')
    expect(glass.map(e => `${e.target} ${e.outcome}`)).toEqual([
      'GET /v0/limits ok',
      'GET /v0/limits ok',
      'GET /fragments/roster ok',
    ])
    for (const entry of glass) expect(entry.breakGlass).toBe(true)
  })
})

describe('the in-memory ledger answers list the way P15.9 must', () => {
  test('newest first, filtered, paged by sequence', async () => {
    const ledger = new MemoryActionLedger()
    for (let i = 1; i <= 5; i++) {
      await ledger.record({
        at: NOW + i,
        requestId: `r-${i}`,
        subject: i % 2 === 0 ? 'u:00000000000000aa' : 'legacy:admin',
        action: i <= 3 ? 'chat.transcript.open' : 'agent.heartbeat',
        target: `t-${i}`,
        outcome: 'ok',
      })
    }
    const first = await ledger.list({ limit: 2 })
    expect(first.ok && first.value.entries.map(e => e.seq)).toEqual([5, 4])
    expect(first.ok && first.value.nextBeforeSeq).toBe(4)
    const second = await ledger.list({ limit: 2, beforeSeq: 4 })
    expect(second.ok && second.value.entries.map(e => e.seq)).toEqual([3, 2])
    // 「我的转录被谁读过」: my sessions as targets, the transcript verb.
    const mine = await ledger.list({
      targets: ['t-1', 't-3', 't-5'],
      actionPrefix: 'chat.transcript.',
    })
    expect(mine.ok && mine.value.entries.map(e => e.target)).toEqual([
      't-3',
      't-1',
    ])
    expect(mine.ok && mine.value.nextBeforeSeq).toBeNull()
    const theirs = await ledger.list({ subject: 'u:00000000000000aa' })
    expect(theirs.ok && theirs.value.entries.map(e => e.seq)).toEqual([4, 2])
  })
})
