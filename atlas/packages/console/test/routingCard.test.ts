// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 任务分工 (P22) on the 模型 page: the card, its scope fragment, and who
 * may change it — the 模型服务 rule, a personal ops account.
 */

import { describe, expect, test } from 'bun:test'
import { renderRoutingCard } from '../src/view/routing.js'
import {
  ADMIN,
  accountsHarness,
  asSession,
  person,
  START,
  VIEW,
} from './accountsHarness.js'
import { FakeRouting } from './directionFakes.js'
import { MemoryActionLedger } from './memoryActions.js'
import { browse, visibleText } from './pageHarness.js'
import { FakeProviders } from './providersFake.js'

async function snapshotOf(routing: FakeRouting) {
  const result = await routing.snapshot()
  if (!result.ok) throw new Error('snapshot failed')
  return result.value
}

function wired() {
  const routing = new FakeRouting(() => START)
  const h = accountsHarness({
    deps: { providers: new FakeProviders(), routing },
  })
  return { h, routing }
}

describe('任务分工 · the card', () => {
  test('a reader sees every direction and what takes it, and nothing to change', async () => {
    const routing = new FakeRouting(() => START)
    const html = renderRoutingCard({
      snapshot: await snapshotOf(routing),
      node: null,
      nodes: ['node-a', 'node-b'],
      managed: ['node-a', 'node-b'],
      writer: false,
      now: START,
    })
    const text = visibleText(html)
    for (const word of [
      '复杂任务',
      '一般任务',
      '简单任务',
      '生图',
      '语音',
      '视频',
    ]) {
      expect(text).toContain(word)
    }
    expect(text).toContain('deepseek-coder · DeepSeek')
    expect(text).toContain('跟随主模型')
    // An image model nobody has evaluated says so; media left unpicked is off.
    expect(text).toContain('gpt-image-1 · OpenAI Images')
    expect(text).toContain('未评估')
    expect(text).toContain('不开')
    expect(html).not.toContain('data-write')
    expect(html).not.toContain('<select class="input" id="route-')
    expect(text).toContain('最近 3 次分派')
  })

  test('a writer picks per direction, among the models of the right kind only', async () => {
    const routing = new FakeRouting(() => START)
    const html = renderRoutingCard({
      snapshot: await snapshotOf(routing),
      node: null,
      nodes: [],
      managed: [],
      writer: true,
      now: START,
    })
    const code = html.slice(
      html.indexOf('id="route-medium"'),
      html.indexOf('</select>', html.indexOf('id="route-medium"')),
    )
    expect(code).toContain('value="deepseek/deepseek-coder"')
    expect(code).toContain(' selected>deepseek-coder')
    expect(code).not.toContain('gpt-image-1')
    const image = html.slice(
      html.indexOf('id="route-image"'),
      html.indexOf('</select>', html.indexOf('id="route-image"')),
    )
    expect(image).toContain('>不开</option>')
    expect(image).not.toContain('deepseek')
    // No speech model: no select to save, a line saying so.
    expect(html).not.toContain('id="route-speech"')
    expect(visibleText(html)).toContain('还没有这类模型')
    expect(html).toContain('id="routing-form"')
    expect(html).toContain('data-revision="3"')
    // No node list: no scope select.
    expect(html).not.toContain('id="routing-node"')
  })

  test('a node scope says whether that node has its own split', async () => {
    const routing = new FakeRouting(() => START)
    const first = renderRoutingCard({
      snapshot: await snapshotOf(routing),
      node: 'node-a',
      nodes: ['node-a', 'node-b'],
      managed: ['node-a', 'node-b'],
      writer: true,
      now: START,
    })
    expect(visibleText(first)).toContain('node-a 现在跟随所有节点的分工')
    expect(first).not.toContain('data-action="routing-clear"')
    await routing.save(
      { node: 'node-a', auto: false, routes: [], revision: 3 },
      { subject: 'u:ops', role: 'ops', requestId: 'r' },
    )
    const own = renderRoutingCard({
      snapshot: await snapshotOf(routing),
      node: 'node-a',
      nodes: ['node-a', 'node-b'],
      managed: ['node-a', 'node-b'],
      writer: true,
      now: START,
    })
    expect(visibleText(own)).toContain('node-a 用自己的分工')
    expect(own).toContain('data-action="routing-clear"')
    expect(own).toContain('node-a · 单独设置')
  })
})

describe('任务分工 · on the 模型 page', () => {
  test('a personal ops account gets the form; the admin and view tokens read it', async () => {
    const { h } = wired()
    const ops = await person(h.handle, 'ops')
    const mine = await (
      await h.handle(
        asSession('GET', '/admin/providers', ops.sid, { header: false }),
      )
    ).text()
    expect(mine).toContain('id="routing-form"')
    for (const token of [ADMIN, VIEW]) {
      const page = await (
        await h.handle(browse('/admin/providers', token))
      ).text()
      expect(page).toContain('id="routing"')
      expect(page).not.toContain('id="routing-form"')
    }
  })

  test('the scope is the address, and the fragment answers the same card', async () => {
    const { h, routing } = wired()
    const page = await (
      await h.handle(browse('/admin/providers?routing=node-b', ADMIN))
    ).text()
    expect(page).toContain('node-b 现在跟随所有节点的分工')
    // A node the 模型 service does not know is every node.
    const stray = await (
      await h.handle(browse('/admin/providers?routing=nowhere', ADMIN))
    ).text()
    expect(stray).toContain('不同方向的任务交给不同模型')
    const fragment = await h.handle(
      browse('/fragments/routing?node=node-a', ADMIN),
    )
    expect(fragment.status).toBe(200)
    const html = await fragment.text()
    expect(
      html.startsWith(
        '<section class="card elev-sm route-card" id="routing" data-node="node-a">',
      ),
    ).toBe(true)
    expect((await h.handle(browse('/fragments/routing/x', ADMIN))).status).toBe(
      404,
    )
    routing.failSnapshot = true
    const broken = await (
      await h.handle(browse('/fragments/routing', ADMIN))
    ).text()
    expect(broken).toContain('任务分工')
    expect(broken).not.toContain('route-grid')
  })

  test('without a routing book there is no card, and the API says 501', async () => {
    const h = accountsHarness({ deps: { providers: new FakeProviders() } })
    const page = await (
      await h.handle(browse('/admin/providers', ADMIN))
    ).text()
    expect(page).not.toContain('id="routing"')
    expect(
      await (await h.handle(browse('/fragments/routing', ADMIN))).text(),
    ).toBe('')
    const api = await h.handle(
      new Request('http://console.test/v0/routing', {
        headers: { authorization: `Bearer ${ADMIN}` },
      }),
    )
    expect(api.status).toBe(501)
  })
})

describe('任务分工 · saved is not shipped', () => {
  test('a writer gets 下发 for exactly the managed nodes the split reaches, under the revision drawn', async () => {
    const routing = new FakeRouting(() => START)
    await routing.save(
      { node: 'node-b', auto: false, routes: [], revision: 3 },
      { subject: 'u:ops', role: 'ops', requestId: 'r' },
    )
    const snapshot = await snapshotOf(routing)
    const everyone = renderRoutingCard({
      snapshot,
      node: null,
      nodes: ['node-a', 'node-b', 'node-c', 'node-d'],
      // node-c is not managed; node-b has a split of its own.
      managed: ['node-a', 'node-b', 'node-d'],
      writer: true,
      now: START,
    })
    expect(everyone).toContain('data-action="prov-apply-routing"')
    expect(everyone).toContain('data-nodes="node-a node-d"')
    expect(everyone).toContain('data-revision="4"')
    const text = visibleText(everyone)
    expect(text).toContain('下发到 2 台节点')
    expect(text).toContain('保存只改中枢上的分工 · 下发之后节点才按它派活')
    // The button's revision is the form's: what is shipped is what was saved.
    expect(everyone).toContain(
      '<form id="routing-form" novalidate data-revision="4">',
    )

    const own = renderRoutingCard({
      snapshot,
      node: 'node-b',
      nodes: ['node-a', 'node-b', 'node-c'],
      managed: ['node-a', 'node-b'],
      writer: true,
      now: START,
    })
    expect(own).toContain('data-nodes="node-b"')
    expect(visibleText(own)).toContain('下发到 1 台节点')
  })

  test('nothing to ship says why instead of drawing a button', async () => {
    const routing = new FakeRouting(() => START)
    const snapshot = await snapshotOf(routing)
    const unmanaged = renderRoutingCard({
      snapshot,
      node: 'node-c',
      nodes: ['node-a', 'node-c'],
      managed: ['node-a'],
      writer: true,
      now: START,
    })
    expect(unmanaged).not.toContain('prov-apply-routing')
    expect(visibleText(unmanaged)).toContain(
      'node-c 不受托管 · 先给它指派模型服务',
    )
    const none = renderRoutingCard({
      snapshot,
      node: null,
      nodes: ['node-c'],
      managed: [],
      writer: true,
      now: START,
    })
    expect(none).not.toContain('prov-apply-routing')
    expect(visibleText(none)).toContain('没有跟随这份分工的托管节点 · 无需下发')
  })

  test('on the page the button names the managed nodes the 模型 service reports', async () => {
    const { h } = wired()
    const ops = await person(h.handle, 'ops')
    const page = await (
      await h.handle(
        asSession('GET', '/admin/providers', ops.sid, { header: false }),
      )
    ).text()
    // FakeProviders: node-a and node-b are managed, node-c is not.
    expect(page).toContain('data-nodes="node-a node-b"')
    expect(page).toContain('data-revision="3"')
    const fragment = await (
      await h.handle(
        asSession('GET', '/fragments/routing?node=node-c', ops.sid),
      )
    ).text()
    expect(fragment).not.toContain('prov-apply-routing')
    expect(visibleText(fragment)).toContain('node-c 不受托管')
  })
})

describe('任务分工 · 下发 under a routing revision', () => {
  function shipping() {
    const routing = new FakeRouting(() => START)
    const providers = new FakeProviders()
    providers.routingRevision = () => routing.revision
    const actions = new MemoryActionLedger()
    const h = accountsHarness({ deps: { providers, routing, actions } })
    return { h, routing, providers, actions }
  }

  test('the revision the card was drawn with ships, to the nodes named', async () => {
    const { h, providers } = shipping()
    const ops = await person(h.handle, 'ops')
    const response = await h.handle(
      asSession('POST', '/v0/providers/apply', ops.sid, {
        body: { nodes: ['node-a'], routingRevision: 3 },
      }),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      results: { node: string; outcome: string }[]
    }
    expect(body.results.map(r => [r.node, r.outcome])).toEqual([
      ['node-a', 'ok'],
    ])
    expect(providers.writes).toEqual([
      {
        method: 'apply',
        input: { nodes: ['node-a'], routingRevision: 3 },
      },
    ])
  })

  test('a split saved again since is refused whole: 409, nothing applied, a refusal per node on record', async () => {
    const { h, routing, providers, actions } = shipping()
    const ops = await person(h.handle, 'ops')
    // Somebody else saves after this card was drawn at revision 3.
    await routing.save(
      { node: null, auto: false, routes: [], revision: 3 },
      { subject: 'u:other', role: 'ops', requestId: 'r' },
    )
    const response = await h.handle(
      asSession('POST', '/v0/providers/apply', ops.sid, {
        body: { nodes: ['node-a', 'node-b'], routingRevision: 3 },
      }),
    )
    expect(response.status).toBe(409)
    const failure = (await response.json()) as {
      error: { code: string; message: string }
    }
    expect(failure.error.code).toBe('conflict')
    expect(failure.error.message).toContain('任务分工')
    expect(providers.writes).toEqual([])
    expect(
      actions.lines().filter(line => line.startsWith('provider.apply')),
    ).toEqual([
      'provider.apply node:node-a refused conflict',
      'provider.apply node:node-b refused conflict',
    ])
  })

  test('a revision that is not a non-negative integer is a 400 before anything else', async () => {
    const { h, providers, actions } = shipping()
    const ops = await person(h.handle, 'ops')
    for (const routingRevision of ['3', -1, 1.5, null]) {
      const response = await h.handle(
        asSession('POST', '/v0/providers/apply', ops.sid, {
          body: { nodes: ['node-a'], routingRevision },
        }),
      )
      expect(response.status).toBe(400)
    }
    expect(providers.writes).toEqual([])
    expect(
      actions.lines().filter(line => line.startsWith('provider.')),
    ).toEqual([])
  })
})
