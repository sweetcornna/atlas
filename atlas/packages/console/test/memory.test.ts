// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 记忆 (P23): the page, `/v0/memory` and `/fragments/memory` over a fake
 * memory port that keeps each person's memory apart (D18).
 */

import { describe, expect, test } from 'bun:test'
import { createConsoleHandler } from '../src/http.js'
import type { MemoryEntryView } from '../src/directionPorts.js'
import { accountsHarness, asSession, person } from './accountsHarness.js'
import { FakeMemory } from './directionFakes.js'
import { MemoryActionLedger } from './memoryActions.js'
import {
  ADMIN,
  browse,
  call,
  NOW,
  pageHarness,
  TOKENS,
  VIEW,
  visibleText,
} from './pageHarness.js'

const AGENT = 'qianmo://tokyo-1/planner'
const DRAFT = {
  agent: AGENT,
  kind: 'plan',
  title: '周五前补窄屏检查',
  summary: '周五 18:00 前把记忆页的窄屏检查补上',
  body: '',
}

interface ListBody {
  readonly agent: { readonly node: string; readonly agent: string } | null
  readonly entries: readonly MemoryEntryView[]
  readonly total: number
  readonly counts: Readonly<Record<string, number>>
}

async function listOf(response: Response): Promise<ListBody> {
  expect(response.status).toBe(200)
  return (await response.json()) as ListBody
}

function wired(memory?: FakeMemory) {
  const base = pageHarness({ chat: true })
  const actions = new MemoryActionLedger()
  const handle = createConsoleHandler(
    {
      ...base.deps,
      actions,
      ...(memory === undefined ? {} : { memory }),
    },
    TOKENS,
  )
  return { handle, actions }
}

describe('记忆 · the page', () => {
  test('lists the reader’s own memory, newest first, with the counts per kind', async () => {
    const memory = new FakeMemory(() => NOW)
    const { handle } = wired(memory)
    const response = await handle(browse('/admin/memory', ADMIN))
    expect(response.status).toBe(200)
    const page = await response.text()
    const text = visibleText(page)
    expect(text).toContain('简报控制在 300 字以内')
    expect(text).toContain('周三下午不排会')
    expect(text.indexOf('简报控制在 300 字以内')).toBeLessThan(
      text.indexOf('周三下午不排会'),
    )
    expect(page).toContain('id="memory-n-all">5<')
    expect(page).toContain('id="memory-n-preference">2<')
    // The polled region swaps the list and the counts, never the search box.
    expect(page).toContain('data-swap="memory-list memory-n-all')
    expect(page).toContain('data-action="memory-new"')
    expect(page).toContain('id="memory-dialog"')
    expect(memory.calls).toEqual([`list tokyo-1/planner legacy:admin`])
  })

  test('the filter is the address: kind, words, forgotten ones', async () => {
    const memory = new FakeMemory(() => NOW)
    const { handle } = wired(memory)
    const plans = visibleText(
      await (await handle(browse('/admin/memory?kind=plan', ADMIN))).text(),
    )
    expect(plans).toContain('本周把接力插件交评审')
    expect(plans).not.toContain('简报控制在 300 字以内')
    const found = visibleText(
      await (
        await handle(
          browse(`/admin/memory?q=${encodeURIComponent('周三')}`, ADMIN),
        )
      ).text(),
    )
    expect(found).toContain('周三下午不排会')
    expect(found).not.toContain('回复先给结论')
    const none = visibleText(
      await (
        await handle(browse('/admin/memory?q=nothing-here', ADMIN))
      ).text(),
    )
    expect(none).toContain('没有符合条件的记忆')
    // An agent that is not on the roster falls back to the first one.
    const fallback = await handle(
      browse(
        `/admin/memory?agent=${encodeURIComponent('qianmo://x/y')}`,
        ADMIN,
      ),
    )
    expect(fallback.status).toBe(200)
  })

  test('a view token has nobody’s memory: no area, no page, no API', async () => {
    const memory = new FakeMemory(() => NOW)
    const { handle } = wired(memory)
    const home = await (await handle(browse('/admin/overview', VIEW))).text()
    expect(home).not.toContain('href="/admin/memory"')
    expect((await handle(browse('/admin/memory', VIEW))).status).toBe(403)
    expect((await handle(call('GET', '/v0/memory', VIEW))).status).toBe(403)
    expect((await handle(call('POST', '/v0/memory', VIEW, DRAFT))).status).toBe(
      403,
    )
    expect(memory.calls).toEqual([])
  })

  test('without a memory port the area is not offered and writes answer 501', async () => {
    const { handle } = wired()
    const home = await (await handle(browse('/admin/overview', ADMIN))).text()
    expect(home).not.toContain('href="/admin/memory"')
    expect((await handle(browse('/admin/memory', ADMIN))).status).toBe(404)
    expect((await handle(call('GET', '/v0/memory', ADMIN))).status).toBe(501)
    expect(
      (await handle(call('POST', '/v0/memory', ADMIN, DRAFT))).status,
    ).toBe(501)
    const fragment = await handle(browse('/fragments/memory', ADMIN))
    expect(fragment.status).toBe(200)
    expect(await fragment.text()).toContain('--memory')
  })
})

describe('/v0/memory', () => {
  test('add, correct, forget: each is one ledger line and the list follows', async () => {
    const memory = new FakeMemory(() => NOW)
    const { handle, actions } = wired(memory)
    const added = await handle(call('POST', '/v0/memory', ADMIN, DRAFT))
    expect(added.status).toBe(200)
    const made = (await added.json()) as MemoryEntryView
    expect(made).toMatchObject({ title: DRAFT.title, owner: 'legacy:admin' })

    const edited = await handle(
      call('PUT', `/v0/memory/${made.id}`, ADMIN, {
        ...DRAFT,
        title: '周四前补窄屏检查',
      }),
    )
    expect(edited.status).toBe(200)
    const next = (await edited.json()) as MemoryEntryView
    expect(next.supersedes).toBe(made.id)

    const forgot = await handle(
      call('POST', `/v0/memory/${next.id}/forget`, ADMIN, {
        agent: AGENT,
        reason: '已经做完',
      }),
    )
    expect(forgot.status).toBe(200)
    expect(
      actions.entries.map(entry => `${entry.action} ${entry.outcome}`),
    ).toEqual(['memory.add ok', 'memory.edit ok', 'memory.forget ok'])

    const live = await listOf(await handle(call('GET', '/v0/memory', ADMIN)))
    expect(live.entries.map(entry => entry.title)).not.toContain(
      '周四前补窄屏检查',
    )
    expect(live.counts.plan).toBe(1)
    const all = await listOf(
      await handle(call('GET', '/v0/memory?retired=1', ADMIN)),
    )
    expect(all.entries.find(entry => entry.id === next.id)?.retired).toEqual({
      kind: 'revoked',
      reason: '已经做完',
      by: 'legacy:admin',
    })
  })

  test('refused before the port: bad agent, bad kind, empty title, wrong method, unknown path', async () => {
    const memory = new FakeMemory(() => NOW)
    const { handle } = wired(memory)
    const status = async (method: string, path: string, body?: unknown) =>
      (await handle(call(method, path, ADMIN, body))).status
    expect(
      await status('POST', '/v0/memory', { ...DRAFT, agent: 'tokyo' }),
    ).toBe(400)
    expect(
      await status('POST', '/v0/memory', { ...DRAFT, kind: 'secret' }),
    ).toBe(400)
    expect(await status('POST', '/v0/memory', { ...DRAFT, title: ' ' })).toBe(
      400,
    )
    expect(await status('POST', '/v0/memory', { ...DRAFT, summary: '' })).toBe(
      400,
    )
    expect(
      await status('POST', '/v0/memory', { ...DRAFT, body: 'x'.repeat(4001) }),
    ).toBe(400)
    expect(await status('DELETE', '/v0/memory')).toBe(405)
    expect(await status('POST', '/v0/memory/mem-1', DRAFT)).toBe(405)
    expect(await status('PUT', '/v0/memory/mem-1/forget', DRAFT)).toBe(405)
    expect(await status('POST', '/v0/memory/mem-1/erase', DRAFT)).toBe(404)
    expect(await status('POST', '/v0/memory/mem-1/forget/x', DRAFT)).toBe(404)
    expect(memory.calls).toEqual([])
    // The port's own refusal keeps its status.
    expect(await status('PUT', '/v0/memory/mem-nope', DRAFT)).toBe(404)
  })

  test('two members never see each other’s memory (D18)', async () => {
    const memory = new FakeMemory(() => NOW, 'u:nobody')
    const h = accountsHarness({ deps: { memory } })
    const alice = await person(h.handle, 'member')
    const bob = await person(h.handle, 'member')
    const added = await h.handle(
      asSession('POST', '/v0/memory', alice.sid, { body: DRAFT }),
    )
    expect(added.status).toBe(200)
    const made = (await added.json()) as MemoryEntryView

    const hers = await listOf(
      await h.handle(asSession('GET', '/v0/memory', alice.sid)),
    )
    expect(hers.entries.map(entry => entry.id)).toEqual([made.id])
    const his = await listOf(
      await h.handle(asSession('GET', '/v0/memory', bob.sid)),
    )
    expect(his.entries).toEqual([])
    // Nor change it: to Bob's port view the entry is not there.
    const stolen = await h.handle(
      asSession('POST', `/v0/memory/${made.id}/forget`, bob.sid, {
        body: { agent: AGENT, reason: 'x' },
      }),
    )
    expect(stolen.status).toBe(404)
    expect(memory.entries.find(entry => entry.id === made.id)?.retired).toBe(
      null,
    )
  })

  test('a viewer account reads nothing and writes nothing', async () => {
    const memory = new FakeMemory(() => NOW)
    const h = accountsHarness({ deps: { memory } })
    const viewer = await person(h.handle, 'viewer')
    expect(
      (await h.handle(asSession('GET', '/v0/memory', viewer.sid))).status,
    ).toBe(403)
    expect(
      (
        await h.handle(
          asSession('POST', '/v0/memory', viewer.sid, { body: DRAFT }),
        )
      ).status,
    ).toBe(403)
    expect(memory.calls).toEqual([])
  })
})

describe('/fragments/memory', () => {
  test('the list and fresh counts; a failing store is a failure bar in the list', async () => {
    const memory = new FakeMemory(() => NOW)
    const { handle } = wired(memory)
    const fresh = await (
      await handle(browse('/fragments/memory?kind=daily', ADMIN))
    ).text()
    expect(fresh.startsWith('<div id="memory-list">')).toBe(true)
    expect(fresh).toContain('周三下午不排会')
    expect(fresh).toContain(
      '<span class="mem-n" id="memory-n-all">5</span></div>',
    )
    memory.failList = true
    const broken = await (
      await handle(browse('/fragments/memory', ADMIN))
    ).text()
    expect(broken.startsWith('<div id="memory-list">')).toBe(true)
    expect(broken).not.toContain('memory-n-all')
    expect((await handle(browse('/fragments/memory/x', ADMIN))).status).toBe(
      404,
    )
  })
})
