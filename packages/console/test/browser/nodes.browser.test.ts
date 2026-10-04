// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One node's page in a real browser: the page script's half of the lifecycle
 * tab and of the 「模型」 tab.
 *
 * `nodeDetail.test.ts` proves what the server draws and what the routes
 * record. This proves what only a browser can: a row's 暂停 opens its
 * confirmation and sends nothing; 取消 sends nothing either; the
 * confirmation's button sends once, the ledger gets its one line, and the
 * region comes back with the new state — then the same for 恢复. And the
 * 「模型」 tab against P18.9's real fragment: a node the model service knows
 * is loaded and kept polled; one it does not (404) leaves one calm line,
 * stops polling, and the next refresh of the page does not report a failure;
 * without `--providers` the fragment is that area's own one line.
 * Skipped, with the reason, where no Chrome is installed (`cdp.ts`).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ADMIN, accountsHarness } from '../accountsHarness.js'
import { PLANNER, REVIEWER, StatefulLifecycle } from '../lifecycleFake.js'
import { MemoryActionLedger } from '../memoryActions.js'
import { PageAudit, PageRegistry } from '../pageHarness.js'
import { FakeProviders } from '../providersFake.js'
import { Browser, type Tab, skipReason } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[nodes browser tests] skipped: ${SKIP}`)

/** A model service that knows tokyo-1: node-a's state under that name. */
function providersKnowingTokyo(): FakeProviders {
  const providers = new FakeProviders()
  const template = providers.nodes.get('node-a')
  if (template === undefined) throw new Error('the fake lost node-a')
  providers.nodes.set('tokyo-1', { ...template, node: 'tokyo-1' })
  return providers
}

/**
 * The console over a real socket. The 「模型」 fragment is P18.9's own route,
 * answered by the console; the wrapper only counts how often it is asked.
 */
function serve(options: { readonly providers?: FakeProviders } = {}) {
  const actions = new MemoryActionLedger()
  const lifecycle = new StatefulLifecycle()
  const h = accountsHarness({
    deps: {
      registry: new PageRegistry(),
      audit: new PageAudit(),
      lifecycle,
      actions,
      ...(options.providers === undefined
        ? {}
        : { providers: options.providers }),
    },
  })
  const modelsAsked: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: request => {
      const path = new URL(request.url).pathname
      if (path.startsWith('/fragments/providers/node/')) modelsAsked.push(path)
      return h.handle(request)
    },
  })
  return {
    actions,
    lifecycle,
    modelsAsked,
    base: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true)
    },
  }
}

function row(address: string): string {
  return `document.querySelector('#lifecycle tr[data-key="${address}"]')`
}

function button(verb: string, address: string): string {
  return `document.querySelector('#lifecycle [data-action="lifecycle"][data-verb="${verb}"][data-address="${address}"]')`
}

/** Make the runtime poll every 200 ms, so a test can watch one tick land. */
async function pollFast(tab: Tab): Promise<void> {
  await tab.evaluate(
    `(function () {
      var picker = document.getElementById('refresh-interval');
      var fast = document.createElement('option');
      fast.value = '200';
      fast.textContent = '200';
      picker.appendChild(fast);
      picker.value = '200';
      picker.dispatchEvent(new Event('change'));
    })()`,
  )
}

describe.skipIf(SKIP !== null)('one node in a browser', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await Browser.launch()
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
  }, 30_000)

  test('暂停 then 恢复: each only through its confirmation, one ledger line each', async () => {
    const served = serve()
    const tab = await browser.tab()
    try {
      await tab.goto(`${served.base}/nodes/tokyo-1/lifecycle?token=${ADMIN}`)
      await tab.waitFor('window.qianmoConsole !== undefined')
      expect(
        await tab.evaluate<string>(
          `${row(PLANNER)}.getAttribute('data-state')`,
        ),
      ).toBe('active')

      // 取消 sends nothing.
      await tab.evaluate(`${button('pause', REVIEWER)}.click()`)
      await tab.waitFor(
        `document.getElementById('confirm-pause').open === true`,
      )
      await tab.evaluate(
        `document.querySelector('#confirm-pause [data-action="confirm-cancel"]').click()`,
      )
      await tab.waitFor(
        `document.getElementById('confirm-pause').open === false`,
      )
      expect(served.actions.lines()).toEqual([])
      expect(served.lifecycle.calls).toEqual([])

      // 暂停: the click opens the dialog with the address in it, and sends nothing.
      await tab.evaluate(`${button('pause', PLANNER)}.click()`)
      await tab.waitFor(
        `document.getElementById('confirm-pause').open === true`,
      )
      expect(
        await tab.evaluate<string>(
          `document.getElementById('confirm-pause-addr').textContent`,
        ),
      ).toBe(PLANNER)
      expect(served.actions.lines()).toEqual([])
      expect(served.lifecycle.calls).toEqual([])

      // The confirmation sends once; the region comes back paused.
      await tab.evaluate(
        `document.querySelector('[data-action="confirm-pause"]').click()`,
      )
      await tab.waitFor(
        `document.getElementById('lifecycle').getAttribute('data-refreshed') !== null`,
      )
      expect(served.actions.lines()).toEqual([`agent.pause ${PLANNER} ok`])
      expect(served.lifecycle.calls).toEqual([`pause ${PLANNER} legacy:admin`])
      expect(
        await tab.evaluate<string>(
          `${row(PLANNER)}.getAttribute('data-state')`,
        ),
      ).toBe('paused')
      expect(
        await tab.evaluate<string>(`${row(PLANNER)}.textContent`),
      ).toContain('已暂停 · 恢复之前不拨')
      expect(
        await tab.evaluate<string>(
          `document.getElementById('toasts').textContent`,
        ),
      ).toContain(`已暂停 ${PLANNER}`)
      const refreshed = await tab.evaluate<string>(
        `document.getElementById('lifecycle').getAttribute('data-refreshed')`,
      )

      // 恢复: the same two steps, on the button the refresh drew.
      expect(
        await tab.evaluate<boolean>(`${button('pause', PLANNER)} === null`),
      ).toBe(true)
      await tab.evaluate(`${button('resume', PLANNER)}.click()`)
      await tab.waitFor(
        `document.getElementById('confirm-resume').open === true`,
      )
      expect(
        await tab.evaluate<string>(
          `document.getElementById('confirm-resume-addr').textContent`,
        ),
      ).toBe(PLANNER)
      expect(served.actions.lines()).toHaveLength(1)
      await tab.evaluate(
        `document.querySelector('[data-action="confirm-resume"]').click()`,
      )
      await tab.waitFor(
        `document.getElementById('lifecycle').getAttribute('data-refreshed') !== ${JSON.stringify(
          refreshed,
        )}`,
      )
      expect(served.actions.lines()).toEqual([
        `agent.pause ${PLANNER} ok`,
        `agent.resume ${PLANNER} ok`,
      ])
      expect(
        await tab.evaluate<string>(
          `${row(PLANNER)}.getAttribute('data-state')`,
        ),
      ).toBe('active')
      expect(
        await tab.evaluate<boolean>(`${button('pause', PLANNER)} !== null`),
      ).toBe(true)
    } finally {
      await tab.close()
      served.stop()
    }
  }, 30_000)

  test('「模型」 for a node the model service does not know (404): one calm line, no polling, no refresh failure', async () => {
    // node-a, node-b and node-c only.
    const served = serve({ providers: new FakeProviders() })
    const tab = await browser.tab()
    try {
      await tab.goto(`${served.base}/nodes/tokyo-1/models?token=${ADMIN}`)
      await tab.waitFor(
        `document.getElementById('node-models').getAttribute('data-state') === 'missing'`,
      )
      expect(served.modelsAsked).toEqual(['/fragments/providers/node/tokyo-1'])
      expect(
        await tab.evaluate<string>(
          `document.getElementById('node-models').textContent`,
        ),
      ).toBe('模型服务暂无这台节点的信息 · 可在模型服务页查看')
      expect(
        await tab.evaluate<boolean>(
          `document.getElementById('node-models').hasAttribute('data-poll')`,
        ),
      ).toBe(false)
      // In-console links are left as rendered: navigation rides the session
      // cookie (H5), so the link is the page's own address.
      const link = new URL(
        await tab.evaluate<string>(
          `document.getElementById('node-models-link').getAttribute('href')`,
        ),
        served.base,
      )
      expect(link.pathname).toBe('/providers')
      expect(link.searchParams.get('node')).toBe('tokyo-1')

      // A refresh of the page after that (the runtime ticks when the tab
      // comes back into view): it finishes, and asks nothing more.
      await tab.evaluate(
        `document.dispatchEvent(new Event('visibilitychange'))`,
      )
      await tab.waitFor(
        `(document.getElementById('refresh-state').textContent || '').indexOf('更新于') !== -1`,
      )
      const state = await tab.evaluate<string>(
        `document.getElementById('refresh-state').textContent`,
      )
      expect(state).not.toContain('刷新失败')
      expect(
        await tab.evaluate<string>(
          `document.getElementById('toasts').textContent`,
        ),
      ).toBe('')
      expect(served.modelsAsked).toHaveLength(1)
    } finally {
      await tab.close()
      served.stop()
    }
  }, 30_000)

  test("「模型」 loads P18.9's real fragment for a node it knows, and keeps it polled", async () => {
    const served = serve({ providers: providersKnowingTokyo() })
    const tab = await browser.tab()
    try {
      await tab.goto(`${served.base}/nodes/tokyo-1/models?token=${ADMIN}`)
      await tab.waitFor(
        `document.getElementById('node-models').getAttribute('data-state') === 'loaded'`,
      )
      // The model service's own panel, for this node, inside the tab.
      expect(
        await tab.evaluate<boolean>(
          `document.querySelector('#node-models .prov-node-in[data-node="tokyo-1"]') !== null`,
        ),
      ).toBe(true)
      expect(
        await tab.evaluate<boolean>(
          `document.getElementById('node-models').hasAttribute('data-poll')`,
        ),
      ).toBe(true)
      await pollFast(tab)
      await tab.waitFor(
        `document.getElementById('node-models').getAttribute('data-refreshed') !== null`,
      )
      expect(served.modelsAsked.length).toBeGreaterThan(1)
      expect(
        await tab.evaluate<boolean>(
          `document.querySelector('#node-models .prov-node-in[data-node="tokyo-1"]') !== null`,
        ),
      ).toBe(true)
      expect(
        await tab.evaluate<string>(
          `document.getElementById('refresh-state').textContent`,
        ),
      ).not.toContain('刷新失败')
    } finally {
      await tab.close()
      served.stop()
    }
  }, 30_000)

  test("「模型」 without --providers: the model service's own one line, loaded like any fragment", async () => {
    const served = serve()
    const tab = await browser.tab()
    try {
      await tab.goto(`${served.base}/nodes/tokyo-1/models?token=${ADMIN}`)
      await tab.waitFor(
        `document.getElementById('node-models').getAttribute('data-state') === 'loaded'`,
      )
      expect(
        await tab.evaluate<string>(
          `document.getElementById('node-models').textContent`,
        ),
      ).toContain('模型服务未开启')
    } finally {
      await tab.close()
      served.stop()
    }
  }, 30_000)
})
