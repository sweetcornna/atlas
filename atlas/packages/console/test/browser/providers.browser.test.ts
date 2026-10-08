// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 模型服务 in a real browser: the page script's half of the area (P18.9).
 *
 * The HTTP suite (`providersPage.test.ts`) proves what the server answers.
 * This proves what only a browser can: a profile made from a preset with
 * nothing but a key typed in, checked with 测连, saved and switched to a node
 * through the switch dialog, with the progress line showing the node's
 * answer; the context window changed from a matrix row through its dialog;
 * a link from the node tab (`?do=`) opening the dialog it names; and the chat
 * page drawing the target's model and its switch into a transcript the chat
 * script keeps replacing; a key added to and one removed from a profile with
 * several (P18.18). The hub is the hand-written port; the real one is in
 * `tests/integration/qianmo-providers-page.test.ts` and
 * `tests/integration/qianmo-providers-keypool.test.ts`.
 *
 * `QIANMO_SCREENSHOT_DIR`, when set, receives a screenshot of the board and
 * of the form. Skipped, with the reason, where no Chrome is installed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatTranscript, ConsoleResult } from '../../src/deps.js'
import {
  CountingChat,
  ManualClock,
  accountsHarness,
  asSession,
  person,
  type Person,
} from '../accountsHarness.js'
import { MemoryActionLedger } from '../memoryActions.js'
import { FakeProviders, NOW } from '../providersFake.js'
import { Browser, type Tab, skipReason } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[providers browser tests] skipped: ${SKIP}`)

const SHOTS = process.env['QIANMO_SCREENSHOT_DIR'] ?? ''

/** A chat port whose one conversation has turns either side of the switch. */
class TurnsChat extends CountingChat {
  override transcript(
    sessionId: string,
  ): Promise<ConsoleResult<ChatTranscript>> {
    const session = this.sessionsById.get(sessionId)
    if (session === undefined) return super.transcript(sessionId)
    const turn = (n: number, at: number, author: 'operator' | 'agent') => ({
      id: `t-${n}`,
      sessionId,
      author,
      at,
      text: `第 ${n} 轮`,
      state: 'done' as const,
    })
    return Promise.resolve({
      ok: true,
      value: {
        session: { ...session, turnCount: 4 },
        turns: [
          turn(1, NOW - 7_200_000, 'operator'),
          turn(2, NOW - 7_100_000, 'agent'),
          turn(3, NOW - 1_800_000, 'operator'),
          turn(4, NOW - 1_700_000, 'agent'),
        ],
      },
    })
  }
}

async function serve(options: { readonly pool?: boolean } = {}) {
  const actions = new MemoryActionLedger()
  const providers = new FakeProviders({ pool: options.pool === true })
  const chat = new TurnsChat()
  const clock = new ManualClock(NOW)
  const h = accountsHarness({ clock, deps: { actions, providers, chat } })
  const ops = await person(h.handle, 'ops')
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: request => h.handle(request),
  })
  return {
    h,
    actions,
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

async function shoot(tab: Tab, name: string): Promise<void> {
  if (SHOTS === '') return
  mkdirSync(SHOTS, { recursive: true })
  const shot = await tab.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  })
  writeFileSync(join(SHOTS, name), Buffer.from(String(shot['data']), 'base64'))
}

function click(selector: string): string {
  return `document.querySelector(${JSON.stringify(selector)}).click()`
}

describe.skipIf(SKIP !== null)('模型服务 in a browser', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await Browser.launch()
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
  }, 30_000)

  test('a preset, a key, 测连, 保存并切换: the node is switched and the page says so', async () => {
    const served = await serve()
    const tab = await browser.tab()
    try {
      await tab.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await signIn(tab, served.base, served.ops)
      await tab.goto(`${served.base}/providers/new?preset=deepseek`)
      await tab.waitFor('window.qianmoConsole !== undefined')
      // The control: nothing has been asked of the port's writes yet.
      expect(served.providers.writes).toEqual([])

      // 保存并切换 before a probe is refused on the page, nothing sent.
      await tab.evaluate(
        `document.getElementById('prov-key').value = 'sk-test-canary-browser-0001'`,
      )
      // The rule is said once, before and after the press: the press turns
      // that same line into the warning instead of adding a second one.
      const ruleCount = `document.querySelector('main').innerText.split('保存并切换要求本页测连可用').length - 1`
      expect(await tab.evaluate<number>(ruleCount)).toBe(1)
      await tab.evaluate(click('[data-action="prov-save-switch"]'))
      expect(
        await tab.evaluate<string>(
          `document.getElementById('prov-switch-rule').textContent`,
        ),
      ).toBe('保存并切换要求本页测连可用 · 先测连或勾选跳过测连')
      expect(
        await tab.evaluate<string>(
          `document.getElementById('prov-switch-rule').getAttribute('data-tone')`,
        ),
      ).toBe('warn')
      expect(
        await tab.evaluate<string>(
          `document.getElementById('prov-result').textContent`,
        ),
      ).toBe('')
      expect(await tab.evaluate<number>(ruleCount)).toBe(1)
      expect(served.providers.writes).toEqual([])

      // 测连 on the default node: the line names the check, the node, the
      // answer and the time; the rule goes back to saying the rule.
      await tab.evaluate(click('[data-action="prov-check"][data-mode="auth"]'))
      await tab.waitFor(
        `document.getElementById('prov-probe-result').getAttribute('data-tone') === 'ok'`,
      )
      expect(
        await tab.evaluate<string>(
          `document.getElementById('prov-probe-result').textContent`,
        ),
      ).toMatch(/^测连 · node-a · 可用 · \d{2}:\d{2}:\d{2}$/)
      expect(
        await tab.evaluate<string>(
          `document.getElementById('prov-switch-rule').getAttribute('data-tone')`,
        ),
      ).toBe('muted')
      expect(await tab.evaluate<number>(ruleCount)).toBe(1)
      const probe = served.providers.writes.at(-1)
      expect(probe?.method).toBe('probe')
      const probed = probe?.input as {
        node: string
        mode: string
        candidate: { draft: Record<string, unknown>; secret: string }
      }
      expect(probed.node).toBe('node-a')
      expect(probed.mode).toBe('auth')
      expect(probed.candidate.secret).toBe('sk-test-canary-browser-0001')
      expect(probed.candidate.draft['presetId']).toBe('deepseek')
      await shoot(tab, 'p18-9-editor.png')

      // 保存并切换: saved, then the switch dialog, scoped to node-a.
      await tab.evaluate(click('[data-action="prov-save-switch"]'))
      await tab.waitFor(`document.getElementById('prov-switch-dialog').open`)
      expect(await tab.evaluate<string>(`location.pathname`)).toBe(
        '/providers/profiles/deepseek-2',
      )
      await tab.evaluate(
        `(function () {
          document.querySelector('input[name="prov-switch-scope"][value="nodes"]').click();
          document.querySelector('input[name="prov-switch-node"][value="node-a"]').click();
        })()`,
      )
      await tab.waitFor(
        `document.querySelector('#prov-switch-plan li[data-node="node-a"]') !== null`,
      )
      expect(
        await tab.evaluate<string>(
          `document.querySelector('#prov-switch-plan li[data-node="node-a"]').textContent`,
        ),
      ).toContain('当前 DeepSeek 到 DeepSeek')
      // node-a reports a replay filter: keeping sessions is on offer.
      expect(
        await tab.evaluate<boolean>(
          `document.querySelector('#prov-switch-sessions option[value="keep"]').disabled`,
        ),
      ).toBe(false)
      await tab.evaluate(click('[data-action="confirm-prov-switch-dialog"]'))
      await tab.waitFor(
        `document.querySelector('#prov-progress-list li[data-node="node-a"][data-tone="warn"]') !== null`,
      )
      expect(
        await tab.evaluate<string>(
          `document.querySelector('#prov-progress-list li[data-node="node-a"]').textContent`,
        ),
      ).toContain('已下发 · 等待空闲')
      // Dry runs (the plan in the dialog) aside, in this order.
      const done = served.providers.writes.filter(
        write =>
          !(
            write.method === 'apply' &&
            (write.input as { dryRun?: boolean }).dryRun === true
          ),
      )
      expect(done.map(write => write.method)).toEqual([
        'probe',
        'saveProfile',
        'assign',
        'apply',
      ])
      const saved = done[1]?.input as {
        profile: Record<string, unknown>
        secrets: Record<string, string>
      }
      expect(saved.profile['id']).toBe('deepseek-2')
      expect(saved.secrets).toEqual({ k1: 'sk-test-canary-browser-0001' })
      expect(done[2]?.input).toEqual({
        node: 'node-a',
        assignment: { mode: 'profile', profileId: 'deepseek-2' },
      })
      expect(done[3]?.input).toEqual({ nodes: ['node-a'] })
      // The key went in once, to the save, and is gone from the page.
      expect(
        await tab.evaluate<string>(`document.getElementById('prov-key').value`),
      ).toBe('')
      expect(
        await tab.evaluate<number>(
          `document.documentElement.outerHTML.split('sk-test-canary-browser').length - 1`,
        ),
      ).toBe(0)
      const recorded = served.actions.entries.map(entry => entry.action)
      expect(recorded).toEqual(
        expect.arrayContaining([
          'provider.probe.auth',
          'provider.save',
          'provider.assign',
          'provider.apply',
        ]),
      )
      // Probed on this page: nothing was skipped, nothing says so.
      expect(recorded).not.toContain('provider.probe.skip')
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)

  test('跳过测连: on record before the switch, and a skip the ledger will not take switches nothing', async () => {
    const served = await serve()
    const tab = await browser.tab()
    try {
      await signIn(tab, served.base, served.ops)
      await tab.goto(`${served.base}/providers/new?preset=deepseek`)
      await tab.waitFor('window.qianmoConsole !== undefined')
      await tab.evaluate(
        `document.getElementById('prov-key').value = 'sk-test-canary-browser-0002'`,
      )
      await tab.evaluate(`document.getElementById('prov-skip-probe').click()`)
      await tab.evaluate(click('[data-action="prov-save-switch"]'))
      await tab.waitFor(`document.getElementById('prov-switch-dialog').open`)
      await tab.evaluate(
        `(function () {
          document.querySelector('input[name="prov-switch-scope"][value="nodes"]').click();
          document.querySelector('input[name="prov-switch-node"][value="node-a"]').click();
        })()`,
      )
      await tab.evaluate(click('[data-action="confirm-prov-switch-dialog"]'))
      await tab.waitFor(
        `document.querySelector('#prov-progress-list li[data-node="node-a"][data-tone="warn"]') !== null`,
      )
      const done = served.providers.writes
        .filter(
          write =>
            !(
              write.method === 'apply' &&
              (write.input as { dryRun?: boolean }).dryRun === true
            ),
        )
        .map(write => write.method)
      expect(done).toEqual(['saveProfile', 'assign', 'apply'])
      // The skip is on record after the save (and its key, which the port
      // records as its own line) and before anything it allowed.
      const lines = served.actions.entries.filter(entry =>
        entry.action.startsWith('provider.'),
      )
      expect(lines.map(entry => entry.action)).toEqual([
        'provider.save',
        'provider.secret.set',
        'provider.probe.skip',
        'provider.assign',
        'provider.apply',
      ])
      expect(lines[2]?.target).toBe('deepseek-2')

      // Again, with a ledger that admits but will not take the line: the
      // switch stops at it, before the default or any node is touched.
      served.actions.recordResult = {
        ok: false,
        failure: { code: 'unreachable', message: 'disk full' },
      }
      const writes = served.providers.writes.length
      await tab.evaluate(click('[data-action="prov-save-switch"]'))
      await tab.waitFor(`document.getElementById('prov-switch-dialog').open`)
      await tab.evaluate(click('[data-action="confirm-prov-switch-dialog"]'))
      await tab.waitFor(
        `document.getElementById('toasts').textContent.indexOf('切换失败') !== -1`,
      )
      expect(
        await tab.evaluate<string>(
          `document.getElementById('toasts').textContent`,
        ),
      ).toContain('切换没有执行')
      const after = served.providers.writes
        .slice(writes)
        .map(write => write.method)
      expect(after).not.toContain('setDefault')
      expect(after).not.toContain('assign')
      expect(
        served.providers.writes
          .slice(writes)
          .filter(
            write =>
              write.method === 'apply' &&
              (write.input as { dryRun?: boolean }).dryRun !== true,
          ),
      ).toEqual([])
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)

  test('the matrix: a row changes the context window through its dialog', async () => {
    const served = await serve()
    const tab = await browser.tab()
    try {
      await tab.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await signIn(tab, served.base, served.ops)
      await tab.goto(`${served.base}/providers`)
      await tab.waitFor('window.qianmoConsole !== undefined')
      await tab.evaluate(
        `document.querySelector('details[data-key="node:node-a"]').open = true`,
      )
      await shoot(tab, 'p18-9-board.png')
      await tab.evaluate(
        click('details[data-key="node:node-a"] [data-action="prov-context"]'),
      )
      await tab.waitFor(`document.getElementById('prov-context-dialog').open`)
      await tab.evaluate(
        `document.getElementById('prov-context-value').value = '300k'`,
      )
      await tab.evaluate(click('[data-action="confirm-prov-context-dialog"]'))
      await tab.waitFor(
        `document.getElementById('toasts').textContent.indexOf('随下一次下发生效') !== -1`,
      )
      expect(served.providers.nodes.get('node-a')?.contextOverride).toBe(
        300_000,
      )
      // The row still shows what the node computed, and stays open across
      // the refresh that followed the write.
      await tab.waitFor(
        `document.getElementById('prov-board').getAttribute('data-refreshed') !== null`,
      )
      expect(
        await tab.evaluate<boolean>(
          `document.querySelector('details[data-key="node:node-a"]').open`,
        ),
      ).toBe(true)
      expect(
        await tab.evaluate<string>(
          `document.querySelector('details[data-key="node:node-a"] [data-cell="context"]').textContent`,
        ),
      ).toBe('200k')

      // 测连 from the row says the three-state answer in a toast.
      await tab.evaluate(
        click('details[data-key="node:node-a"] [data-action="prov-probe"]'),
      )
      await tab.waitFor(
        `document.getElementById('toasts').textContent.indexOf('node-a · 可用') !== -1`,
      )
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)

  test('a link from the node tab opens the dialog it names', async () => {
    const served = await serve()
    const tab = await browser.tab()
    try {
      await signIn(tab, served.base, served.ops)
      await tab.goto(`${served.base}/providers/nodes/node-a?do=autocompact`)
      await tab.waitFor(
        `document.getElementById('prov-autocompact-dialog').open`,
      )
      expect(await tab.evaluate<string>(`location.search`)).toBe('')
      await tab.waitFor(
        `document.getElementById('prov-autocompact-now').textContent.indexOf('180k') !== -1`,
      )
      await tab.evaluate(
        `document.getElementById('prov-autocompact-value').value = '150k'`,
      )
      await tab.evaluate(
        click('[data-action="confirm-prov-autocompact-dialog"]'),
      )
      await tab.waitFor(
        `document.getElementById('toasts').textContent.indexOf('已写到节点 · 生效 150k') !== -1`,
      )
      expect(served.providers.writes.at(-1)).toEqual({
        method: 'autocompact',
        input: { node: 'node-a', value: 150_000 },
      })
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)

  test('several keys: one added through its dialog, one removed through its dialog, the page reloaded from the hub each time', async () => {
    const served = await serve({ pool: true })
    const tab = await browser.tab()
    const CANARY = 'sk-test-canary-browser-pool-0004'
    try {
      await signIn(tab, served.base, served.ops)
      await tab.goto(`${served.base}/providers/profiles/pool`)
      await tab.waitFor('window.qianmoConsole !== undefined')
      const rows = `Array.prototype.map.call(document.querySelectorAll('#prov-pool [data-pool-key]'), function (li) { return li.getAttribute('data-pool-key'); }).join(' ')`
      expect(await tab.evaluate<string>(rows)).toBe('k1 k2 k3')

      // 加一把密钥: the next free id, a name and the key.
      await tab.evaluate(click('[data-action="prov-key-add"]'))
      await tab.waitFor(`document.getElementById('prov-key-add-dialog').open`)
      expect(
        await tab.evaluate<string>(
          `document.getElementById('prov-key-add-id').textContent`,
        ),
      ).toBe('k4')
      await tab.evaluate(
        `(function () {
          document.getElementById('prov-key-add-label').value = '新账号';
          document.getElementById('prov-key-add-value').value = '${CANARY}';
        })()`,
      )
      const added = tab.next('Page.loadEventFired')
      await tab.evaluate(click('[data-action="confirm-prov-key-add-dialog"]'))
      await added
      await tab.waitFor('window.qianmoConsole !== undefined')
      expect(await tab.evaluate<string>(rows)).toBe('k1 k2 k3 k4')
      expect(await tab.evaluate<string>(`location.pathname`)).toBe(
        '/providers/profiles/pool',
      )
      const add = served.providers.writes.at(-1)
      expect(add?.method).toBe('saveProfile')
      expect(add?.input).toMatchObject({
        ifMatch: 2,
        secrets: { k4: CANARY },
        profile: {
          id: 'pool',
          lane: 'openai-responses',
          keys: [
            { id: 'k1', label: '主账号' },
            { id: 'k2', label: '备用账号' },
            { id: 'k3' },
            { id: 'k4', label: '新账号' },
          ],
        },
      })
      // The page sent the list it was given: no fingerprint rode along.
      const sent = (add?.input as { profile: { keys: object[] } }).profile.keys
      expect(sent.some(key => 'fingerprint' in key)).toBe(false)

      // 删除 k2: the list without it, and nothing else.
      await tab.evaluate(
        click('[data-action="prov-key-remove"][data-key="k2"]'),
      )
      await tab.waitFor(
        `document.getElementById('prov-key-remove-dialog').open`,
      )
      expect(
        await tab.evaluate<string>(
          `document.getElementById('prov-key-remove-id').textContent`,
        ),
      ).toBe('k2')
      const removed = tab.next('Page.loadEventFired')
      await tab.evaluate(
        click('[data-action="confirm-prov-key-remove-dialog"]'),
      )
      await removed
      await tab.waitFor('window.qianmoConsole !== undefined')
      expect(await tab.evaluate<string>(rows)).toBe('k1 k3 k4')
      const remove = served.providers.writes.at(-1)
      expect(remove?.input).toMatchObject({
        ifMatch: 3,
        profile: {
          keys: [
            { id: 'k1', label: '主账号' },
            { id: 'k3' },
            { id: 'k4', label: '新账号' },
          ],
        },
      })
      expect('secrets' in (remove?.input as object)).toBe(false)

      expect(
        served.actions.entries
          .map(entry => entry.action)
          .filter(action => action.startsWith('provider.')),
      ).toEqual(['provider.save', 'provider.secret.set', 'provider.save'])
      expect(
        await tab.evaluate<number>(
          `document.documentElement.outerHTML.split('sk-test-canary').length - 1`,
        ),
      ).toBe(0)
      expect(JSON.stringify(served.actions.entries)).not.toContain(CANARY)
      await shoot(tab, 'p18-18-keys.png')
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)

  test('the chat page names the model and marks the switch in the transcript', async () => {
    const served = await serve()
    const node = served.providers.nodes.get('node-a')
    if (node === undefined) throw new Error('fixture')
    served.providers.nodes.set('tokyo-1', { ...node, node: 'tokyo-1' })
    const opened = await served.h.handle(
      asSession('POST', '/v0/chat/sessions', served.ops.sid, {
        body: { target: 'qianmo://tokyo-1/planner' },
      }),
    )
    const { id } = (await opened.json()) as { id: string }
    const tab = await browser.tab()
    try {
      await signIn(tab, served.base, served.ops)
      await tab.goto(`${served.base}/chat?session=${id}`)
      await tab.waitFor(`document.getElementById('prov-chat-label') !== null`)
      expect(
        await tab.evaluate<string>(
          `document.getElementById('prov-chat-label').textContent`,
        ),
      ).toBe('模型 · deepseek-v4-pro')
      await tab.waitFor(`document.getElementById('prov-chat-divider') !== null`)
      // Between the second and the third turn: the switch was an hour ago.
      const order = await tab.evaluate<string[]>(
        `Array.prototype.map.call(document.querySelectorAll('.transcript > *'), function (el) {
          return el.id === 'prov-chat-divider' ? 'divider' : (el.querySelector('time') || {}).textContent || el.className;
        })`,
      )
      expect(order.indexOf('divider')).toBe(2)
      expect(
        await tab.evaluate<string>(
          `document.getElementById('prov-chat-divider').textContent`,
        ),
      ).toBe('已切换到 DeepSeek · deepseek-v4-pro')
      // The chat script replaces the thread; the label and divider come back.
      await tab.evaluate(
        `window.qianmoConsole.refreshRegion(document.getElementById('thread-mount'))`,
      )
      await tab.evaluate(
        `(function () {
          var mount = document.getElementById('thread-mount');
          mount.innerHTML = mount.innerHTML;
        })()`,
      )
      await tab.waitFor(
        `document.querySelectorAll('#prov-chat-label').length === 1 &&
         document.querySelectorAll('#prov-chat-divider').length === 1`,
      )
    } finally {
      await tab.close()
      served.stop()
    }
  }, 60_000)
})
