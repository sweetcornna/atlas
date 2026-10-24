// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The composer's 模型 and 权限模式 pickers in a real browser
 * (`view/frontTools.ts`, `assets/frontTools.ts`): a pick of 推理强度 goes out
 * as the conversation's own `/effort` line; 权限模式 reads and writes
 * `/v0/elevation` in the shape P39 answers (stubbed in the page, since this
 * hub has no such port), asks before 跳过权限确认, and says 未接入 where the
 * hub answers 404. A pick shows before the hub answers, and a refusal puts
 * the mode the hub still has back with the reason (P37.13, 先改后同步).
 *
 * Skipped, with the reason, where no Chrome is installed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  ADDRESS,
  accountsHarness,
  asSession,
  person,
} from '../accountsHarness.js'
import { Browser, observeChatStream, skipReason, type Tab } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[front tools browser tests] skipped: ${SKIP}`)

/** `/v0/elevation` as P39 answers it, kept in the page. */
const ELEVATION_STUB = `
  window.__elevation = { tier: 'off', puts: [], refuse: false };
  const realFetch = window.fetch;
  window.fetch = function (url, options) {
    const path = String(url);
    const method = (options && options.method) || 'GET';
    const reply = body => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    if (path === '/v0/elevation' && method === 'GET') {
      return reply([{ node: 'tokyo-1', agent: 'planner', reachable: true, tier: window.__elevation.tier }]);
    }
    if (path === '/v0/elevation/tokyo-1/planner' && method === 'PUT') {
      const body = JSON.parse(options.body);
      if (window.__elevation.refuse) {
        window.__elevation.puts.push('refused ' + body.tier);
        return new Promise(resolve => setTimeout(resolve, 400)).then(() => new Response(
          JSON.stringify({ error: { code: 'conflict', message: '节点拒绝了这次切换' } }),
          { status: 409, headers: { 'content-type': 'application/json' } }));
      }
      window.__elevation.puts.push(body.tier);
      window.__elevation.tier = body.tier;
      return reply({ node: 'tokyo-1', agent: 'planner', reachable: true, tier: body.tier });
    }
    return realFetch.apply(this, arguments);
  };
`

async function opened(
  browser: Browser,
  stub: boolean,
): Promise<{
  tab: Tab
  sent: () => string[]
  stop: () => void
}> {
  const h = accountsHarness()
  const ops = await person(h.handle, 'ops')
  const response = await h.handle(
    asSession('POST', '/v0/chat/sessions', ops.sid, {
      body: { target: ADDRESS },
    }),
  )
  const { id } = (await response.json()) as { id: string }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: request => h.handle(request),
  })
  const base = `http://127.0.0.1:${server.port}`
  const tab = await browser.tab()
  await tab.send('Network.setCookie', {
    name: 'qianmo_session',
    value: ops.sid,
    url: base,
    httpOnly: true,
    sameSite: 'Strict',
  })
  if (stub)
    await tab.send('Page.addScriptToEvaluateOnNewDocument', {
      source: ELEVATION_STUB,
    })
  await observeChatStream(tab)
  await tab.goto(`${base}/?session=${id}`)
  await tab.waitFor(`window.__chatStreamOpen === true`)
  await tab.waitFor(`!document.getElementById('fx-model-btn').disabled`)
  return {
    tab,
    sent: () => h.chat.sent.map(input => input.text),
    stop: () => server.stop(true),
  }
}

describe.skipIf(SKIP !== null)('the composer pickers', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await Browser.launch()
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
  }, 30_000)

  test('推理强度 goes out as the conversation’s own /effort line', async () => {
    const { tab, sent, stop } = await opened(browser, false)
    try {
      await tab.evaluate(`document.getElementById('fx-model-btn').click()`)
      expect(
        await tab.evaluate<boolean>(
          `!document.getElementById('fx-model-menu').hidden`,
        ),
      ).toBe(true)
      // No model service here: the list of models is not offered.
      expect(
        await tab.evaluate<boolean>(
          `document.getElementById('fx-model-group').hidden`,
        ),
      ).toBe(true)
      await tab.evaluate(
        `document.querySelector('#fx-model-menu [data-effort="high"]').click()`,
      )
      await tab.waitFor(`document.getElementById('fx-model-menu').hidden`)
      const deadline = Date.now() + 5_000
      while (!sent().includes('/effort high') && Date.now() < deadline)
        await Bun.sleep(50)
      expect(sent()).toEqual(['/effort high'])
      // Nothing to read the node's level back from: the menu ticks the pick.
      await tab.evaluate(`document.getElementById('fx-model-btn').click()`)
      expect(
        await tab.evaluate<string[]>(
          `[...document.querySelectorAll('#fx-model-menu [data-effort][aria-checked="true"]')].map(b => b.getAttribute('data-effort'))`,
        ),
      ).toEqual(['high'])
    } finally {
      await tab.close()
      stop()
    }
  }, 60_000)

  test('权限模式 reads the agent’s mode, switches it, and asks before skipping', async () => {
    const { tab, stop } = await opened(browser, true)
    try {
      await tab.waitFor(
        `document.getElementById('fx-perm-word').textContent === '人工确认'`,
      )
      await tab.evaluate(`document.getElementById('fx-perm-btn').click()`)
      await tab.waitFor(
        `!document.querySelector('#fx-perm-menu [data-perm="auto"]').disabled`,
      )
      // The mode on now is checked and not offered again.
      expect(
        await tab.evaluate<string>(
          `document.querySelector('#fx-perm-menu [data-perm="off"]').getAttribute('aria-checked') + ' ' + document.querySelector('#fx-perm-menu [data-perm="off"]').disabled`,
        ),
      ).toBe('true true')
      await tab.evaluate(
        `document.querySelector('#fx-perm-menu [data-perm="auto"]').click()`,
      )
      await tab.waitFor(
        `document.getElementById('fx-perm-word').textContent === '自动审批'`,
      )
      expect(
        await tab.evaluate<string>(
          `document.getElementById('fx-perm-pick').getAttribute('data-tier')`,
        ),
      ).toBe('auto')
      await tab.evaluate(`document.getElementById('fx-perm-btn').click()`)
      await tab.waitFor(
        `!document.querySelector('#fx-perm-menu [data-perm="full-access"]').disabled`,
      )
      await tab.evaluate(
        `document.querySelector('#fx-perm-menu [data-perm="full-access"]').click()`,
      )
      await tab.waitFor(`document.getElementById('fx-perm-confirm').open`)
      expect(await tab.evaluate<string[]>(`window.__elevation.puts`)).toEqual([
        'auto',
      ])
      await tab.evaluate(
        `document.querySelector('#fx-perm-confirm [data-action="confirm-fx-perm"]').click()`,
      )
      await tab.waitFor(
        `document.getElementById('fx-perm-word').textContent === '跳过权限确认'`,
      )
      expect(await tab.evaluate<string[]>(`window.__elevation.puts`)).toEqual([
        'auto',
        'full-access',
      ])
    } finally {
      await tab.close()
      stop()
    }
  }, 60_000)

  test('权限模式 shows the pick at once and puts the mode back when the hub refuses', async () => {
    const { tab, stop } = await opened(browser, true)
    try {
      await tab.waitFor(
        `document.getElementById('fx-perm-word').textContent === '人工确认'`,
      )
      await tab.evaluate(`window.__elevation.refuse = true`)
      await tab.evaluate(`document.getElementById('fx-perm-btn').click()`)
      await tab.waitFor(
        `!document.querySelector('#fx-perm-menu [data-perm="auto"]').disabled`,
      )
      // Before any answer: the menu and the button say the new mode.
      const shown = await tab.evaluate<{ word: string; tier: string }>(
        `(() => { document.querySelector('#fx-perm-menu [data-perm="auto"]').click(); ` +
          `return { word: document.getElementById('fx-perm-word').textContent, ` +
          `tier: document.getElementById('fx-perm-pick').getAttribute('data-tier') }; })()`,
      )
      expect(shown).toEqual({ word: '自动审批', tier: 'auto' })
      await tab.waitFor(
        `document.getElementById('fx-perm-word').textContent === '人工确认'`,
      )
      expect(
        await tab.evaluate<string>(
          `document.getElementById('fx-perm-pick').getAttribute('data-tier')`,
        ),
      ).toBe('off')
      expect(
        await tab.evaluate<string>(
          `document.getElementById('fx-status').textContent`,
        ),
      ).toStartWith('切换失败')
      expect(await tab.evaluate<string[]>(`window.__elevation.puts`)).toEqual([
        'refused auto',
      ])
    } finally {
      await tab.close()
      stop()
    }
  }, 60_000)

  test('a hub without the port says 未接入 and stays at 人工确认', async () => {
    const { tab, stop } = await opened(browser, false)
    try {
      await tab.evaluate(`document.getElementById('fx-perm-btn').click()`)
      await tab.waitFor(
        `document.getElementById('fx-perm-note').textContent === '未接入 · 一直是人工确认'`,
      )
      expect(
        await tab.evaluate<number>(
          `document.querySelectorAll('#fx-perm-menu [data-perm]:not(:disabled)').length`,
        ),
      ).toBe(0)
      await tab.evaluate(
        `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
      )
      expect(
        await tab.evaluate<boolean>(
          `document.getElementById('fx-perm-menu').hidden`,
        ),
      ).toBe(true)
    } finally {
      await tab.close()
      stop()
    }
  }, 60_000)
})
