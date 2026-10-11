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
      writer: false,
      now: START,
    })
    const text = visibleText(html)
    for (const word of [
      '编程',
      '对话与简报',
      '规划与推理',
      '快速小任务',
      '看图',
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
      writer: true,
      now: START,
    })
    const code = html.slice(
      html.indexOf('id="route-code"'),
      html.indexOf('</select>', html.indexOf('id="route-code"')),
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
      await h.handle(asSession('GET', '/providers', ops.sid, { header: false }))
    ).text()
    expect(mine).toContain('id="routing-form"')
    for (const token of [ADMIN, VIEW]) {
      const page = await (await h.handle(browse('/providers', token))).text()
      expect(page).toContain('id="routing"')
      expect(page).not.toContain('id="routing-form"')
    }
  })

  test('the scope is the address, and the fragment answers the same card', async () => {
    const { h, routing } = wired()
    const page = await (
      await h.handle(browse('/providers?routing=node-b', ADMIN))
    ).text()
    expect(page).toContain('node-b 现在跟随所有节点的分工')
    // A node the 模型 service does not know is every node.
    const stray = await (
      await h.handle(browse('/providers?routing=nowhere', ADMIN))
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
    const page = await (await h.handle(browse('/providers', ADMIN))).text()
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
