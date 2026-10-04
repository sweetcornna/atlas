// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The P1 items of `console-audit.md` §4 that can be shown without a browser
 * (P18.14): what a whole page says once the handler has drawn it. The browser
 * half is `browser/p1.browser.test.ts`; the copy rules are `copyGate.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { ADMIN, VIEW, browse, pageHarness, visibleText } from './pageHarness.js'

describe('C6 · an empty trail offers a wake only where one can happen', () => {
  async function emptyTrail(token: string, wake: boolean): Promise<string> {
    const h = pageHarness({ wake })
    h.audit.readResult = {
      ok: true,
      value: {
        records: [],
        chain: 'empty',
        intact: true,
        issueCount: 0,
        total: 0,
      },
    }
    const response = await h.handle(browse('/audit', token))
    expect(response.status).toBe(200)
    return await response.text()
  }

  test('a writer on a console that can wake is sent to the page that wakes', async () => {
    const html = await emptyTrail(ADMIN, true)
    expect(html).toContain('还没有业务消息经过这条链 · 唤醒一个智能体后')
    expect(html).toContain('href="/nodes" data-nav data-write')
    expect(visibleText(html)).not.toContain('连通')
  })

  test('a reader, or a console that cannot wake, is offered nothing', async () => {
    for (const html of [
      await emptyTrail(VIEW, true),
      await emptyTrail(ADMIN, false),
    ]) {
      expect(html).toContain('还没有业务消息经过这条链')
      expect(html).not.toContain('去节点页唤醒')
      expect(html).not.toContain('唤醒一个智能体后')
    }
  })

  test('the nodes page says why waking is off, by its real cause', async () => {
    const h = pageHarness({ wake: false })
    const html = await (await h.handle(browse('/nodes', ADMIN))).text()
    expect(html).toContain('唤醒不可用 · 启动时没有配置唤醒目标')
    expect(html).not.toContain('QIANMO_TRANSPORT_PSK')
  })
})
