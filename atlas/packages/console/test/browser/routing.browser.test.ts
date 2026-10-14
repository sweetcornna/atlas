// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 任务分工 (P22) in a real browser: saving a split says it is saved and not
 * shipped, 下发 ships it under the revision the card was drawn with and the
 * card says how that went, and a split saved again in between is refused
 * rather than shipped unseen. The HTTP half is `routingCard.test.ts`.
 *
 * Skipped, with the reason, where no Chrome is installed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  accountsHarness,
  person,
  START,
  type Person,
} from '../accountsHarness.js'
import { FakeRouting } from '../directionFakes.js'
import { MemoryActionLedger } from '../memoryActions.js'
import { FakeProviders } from '../providersFake.js'
import { Browser, type Tab, skipReason } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[routing browser tests] skipped: ${SKIP}`)

async function serve() {
  const actions = new MemoryActionLedger()
  const routing = new FakeRouting(() => START)
  const providers = new FakeProviders()
  providers.routingRevision = () => routing.revision
  const h = accountsHarness({ deps: { actions, providers, routing } })
  const ops = await person(h.handle, 'ops')
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: request => h.handle(request),
  })
  return {
    routing,
    providers,
    ops,
    base: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true)
    },
  }
}

async function signIn(tab: Tab, base: string, who: Person): Promise<void> {
  await tab.send('Network.setCookie', {
    name: 'qianmo_session',
    value: who.sid,
    url: base,
    httpOnly: true,
    sameSite: 'Strict',
  })
}

function click(selector: string): string {
  return `document.querySelector(${JSON.stringify(selector)}).click()`
}

const STATUS = `(document.getElementById('routing-status') || {}).textContent || ''`

describe.skipIf(SKIP !== null)('任务分工 in a browser', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await Browser.launch()
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
  }, 30_000)

  test('保存 says 尚未下发, 下发 ships that revision and the card says how it went', async () => {
    const s = await serve()
    const tab = await browser.tab()
    try {
      await tab.send('Network.enable')
      await signIn(tab, s.base, s.ops)
      await tab.goto(`${s.base}/admin/providers`)
      await tab.waitFor(`document.getElementById('routing-form')`)
      await tab.evaluate(click('#routing-form button[type="submit"]'))
      await tab.waitFor(`(${STATUS}).includes('尚未下发')`)
      expect(await tab.evaluate<string>(STATUS)).toBe(
        '分工已保存 · 尚未下发 · 节点仍按之前的分工派活 · 点下发到 2 台节点后生效',
      )
      // The redrawn card carries the revision the save produced.
      expect(
        await tab.evaluate<string>(
          `document.getElementById('routing-ship').getAttribute('data-revision')`,
        ),
      ).toBe('4')
      expect(s.providers.writes).toEqual([])

      await tab.evaluate(click('#routing-ship'))
      await tab.waitFor(`(${STATUS}).includes('下发成功')`)
      expect(s.providers.writes).toEqual([
        {
          method: 'apply',
          input: { nodes: ['node-a', 'node-b'], routingRevision: 4 },
        },
      ])
      // FakeProviders refuses node-b (drift on the node): the card names it,
      // 切换进度 has both rows.
      expect(await tab.evaluate<string>(STATUS)).toBe(
        '这几台没有下发成功 · node-b · 原因看上方切换进度',
      )
      expect(
        await tab.evaluate<string[]>(
          `Array.from(document.querySelectorAll('#prov-progress-list li')).map(li => li.getAttribute('data-node'))`,
        ),
      ).toEqual(['node-a', 'node-b'])
    } finally {
      await tab.close()
      s.stop()
    }
  }, 30_000)

  test('a split saved again since the card was drawn is not shipped, and the card is redrawn', async () => {
    const s = await serve()
    const tab = await browser.tab()
    try {
      await tab.send('Network.enable')
      await signIn(tab, s.base, s.ops)
      await tab.goto(`${s.base}/admin/providers`)
      await tab.waitFor(`document.getElementById('routing-ship')`)
      // Somebody else saves: the book is at 4, the card still says 3.
      await s.routing.save(
        { node: null, auto: false, routes: [], revision: 3 },
        { subject: 'u:other', role: 'ops', requestId: 'r' },
      )
      await tab.evaluate(click('#routing-ship'))
      await tab.waitFor(`(${STATUS}).includes('没有下发')`)
      expect(await tab.evaluate<string>(STATUS)).toContain(
        '卡片已换成最新的分工',
      )
      expect(
        await tab.evaluate<string>(
          `document.getElementById('routing-ship').getAttribute('data-revision')`,
        ),
      ).toBe('4')
      expect(s.providers.writes).toEqual([])
      // No 重试: it would ship the newer split unseen.
      expect(
        await tab.evaluate<number>(
          `document.querySelectorAll('#prov-progress-list [data-action="prov-retry"]').length`,
        ),
      ).toBe(0)
    } finally {
      await tab.close()
      s.stop()
    }
  }, 30_000)
})
