// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The front's session panel in a real browser (`view/frontPanel.ts`,
 * `assets/frontPanel.ts`): it opens by itself on a wide window when a
 * background task is still open, the bar's button closes it and the choice
 * holds across a reload, and 停止 goes through the same cancel as the
 * 主动执行 page, after which the row reads 已停止.
 *
 * Skipped, with the reason, where no Chrome is installed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ConsoleResult } from '../../src/deps.js'
import type {
  BackgroundTaskReader,
  BackgroundTasksPort,
  BackgroundTaskView,
  DirectionActor,
} from '../../src/directionPorts.js'
import {
  ADDRESS,
  accountsHarness,
  asSession,
  person,
} from '../accountsHarness.js'
import { MemoryActionLedger } from '../memoryActions.js'
import { Browser, skipReason } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[front panel browser tests] skipped: ${SKIP}`)

/** Every reader sees every task; a cancel is recorded and lands. */
class PanelTasks implements BackgroundTasksPort {
  readonly cancelled: string[] = []
  rows: BackgroundTaskView[] = [
    {
      id: 'task-run',
      title: '整理周报',
      owner: 'anyone',
      target: ADDRESS,
      status: 'running',
      phase: '执行中',
      progress: '已读 3 个仓库',
      lastError: '',
      turns: 2,
      workerSession: null,
      nextAt: null,
      everyMinutes: null,
      runsLeft: null,
      createdAt: Date.now() - 90_000,
      updatedAt: Date.now(),
    },
  ]
  list(_actor: BackgroundTaskReader) {
    return this.rows
  }
  visible(id: string) {
    return this.rows.some(row => row.id === id)
  }
  async cancel(
    id: string,
    _actor: DirectionActor,
  ): Promise<ConsoleResult<BackgroundTaskView>> {
    this.cancelled.push(id)
    this.rows = this.rows.map(row =>
      row.id === id ? { ...row, status: 'cancelled', phase: '已取消' } : row,
    )
    const row = this.rows.find(one => one.id === id)!
    return { ok: true, value: row }
  }
}

describe.skipIf(SKIP !== null)('the session panel', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await Browser.launch()
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
  }, 30_000)

  test('opens by itself for an open task, closes on the button, and 停止 cancels', async () => {
    const tasks = new PanelTasks()
    const h = accountsHarness({
      deps: { tasks, actions: new MemoryActionLedger() },
    })
    const member = await person(h.handle, 'member')
    const opened = await h.handle(
      asSession('POST', '/v0/chat/sessions', member.sid, {
        body: { target: ADDRESS },
      }),
    )
    const { id } = (await opened.json()) as { id: string }
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: request => h.handle(request),
    })
    const base = `http://127.0.0.1:${server.port}`
    const tab = await browser.tab()
    try {
      await tab.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await tab.send('Network.setCookie', {
        name: 'qianmo_session',
        value: member.sid,
        url: base,
        httpOnly: true,
        sameSite: 'Strict',
      })
      await tab.goto(`${base}/?session=${id}`)
      await tab.waitFor(
        `document.getElementById('fx').getAttribute('data-panel') === 'open'`,
      )
      expect(
        await tab.evaluate<string>(
          `document.querySelector('#fx-panel .fx-panel-count').textContent`,
        ),
      ).toBe('1 个运行中')
      expect(
        await tab.evaluate<boolean>(
          `document.getElementById('fx-panel').getBoundingClientRect().width > 200`,
        ),
      ).toBe(true)

      await tab.evaluate(
        `document.querySelector('[data-task-stop="task-run"]').click()`,
      )
      await tab.waitFor(
        `!document.querySelector('[data-task-stop="task-run"]') && !!document.querySelector('.fx-task-quiet')`,
      )
      expect(tasks.cancelled).toEqual(['task-run'])

      await tab.evaluate(`document.getElementById('fx-panel-toggle').click()`)
      await tab.waitFor(`document.getElementById('fx-panel').hidden`)
      await tab.goto(`${base}/?session=${id}`)
      await tab.waitFor(`!!document.getElementById('fx-panel-body')`)
      await Bun.sleep(300)
      expect(
        await tab.evaluate<boolean>(
          `document.getElementById('fx-panel').hidden`,
        ),
      ).toBe(true)
    } finally {
      await tab.close()
      server.stop(true)
    }
  }, 60_000)
})
