// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 值守作业 (J6): last and next fire, the emergency stop, and the scheduler's
 * heartbeat — P18.15's second completion criterion. The heartbeat's absence
 * is the case this page exists for, so each of its three states is asserted
 * by the words on the page, and the fresh case is the control that shows the
 * words are not simply always there.
 */

import { describe, expect, test } from 'bun:test'
import { jobsRoute } from '../src/routes/jobs.js'
import type { ConsoleResult, SchedulerSnapshot } from '../src/deps.js'
import { formatDateTime } from '../src/view/format.js'
import { ADMIN, NOW, VIEW, browse, call } from './pageHarness.js'
import { FixedScheduler, snapshotOf, watchConsole } from './watchFakes.js'

const UNWIRED_TICK = '调度器心跳未接入'

async function jobsPage(snapshot: SchedulerSnapshot | null): Promise<string> {
  const c =
    snapshot === null
      ? watchConsole()
      : watchConsole({ scheduler: new FixedScheduler(snapshot) })
  const response = await c.handle(browse('/jobs', ADMIN))
  expect(response.status).toBe(200)
  return await response.text()
}

/** The text of one row of the scheduler card. */
function cardRow(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`)
  if (start === -1) throw new Error(`no row ${id}`)
  return html
    .slice(start, html.indexOf('</div>', start))
    .replace(/<[^>]*>/g, '')
}

describe('each job, its last and its next fire', () => {
  test('the scheduled instant it last retired, how that ended, and when it fires next', async () => {
    const html = await jobsPage(snapshotOf())
    const row = html.slice(html.indexOf('<tr data-key="disk-watch">'))
    expect(row).toContain('每十分钟看一次磁盘')
    expect(row).toContain('qianmo://tokyo-1/<b>reviewer</b>')
    expect(row).toContain('10 分')
    // 上次触发: the retired slot, and that the node took it.
    expect(row).toContain(formatDateTime(NOW - 300_000))
    expect(row).toContain('5 分钟前')
    expect(row).toContain('已投递')
    // 下次触发: the next slot, and how far off it is.
    expect(row).toContain(formatDateTime(NOW + 300_000))
    expect(row).toContain('5 分钟后')
    // 最近结果 is the node's answer, a different fact from 已投递.
    expect(row).toContain('完成')
  })

  test('a slot already due, a job held by its backoff, and a job no longer in the file', async () => {
    const base = snapshotOf().jobs[0]
    if (base === undefined) throw new Error('fixture')
    const html = await jobsPage(
      snapshotOf({
        jobs: [
          { ...base, id: 'due', next: NOW - 120_000 },
          {
            ...base,
            id: 'held',
            consecutiveFailures: 3,
            holdUntil: NOW + 240_000,
            last: { at: NOW - 600_000, outcome: 'failed' },
          },
          {
            id: 'gone',
            listed: false,
            consecutiveFailures: 0,
            last: { at: NOW - 3_600_000, outcome: 'completed' },
          },
        ],
      }),
    )
    const due = html.slice(html.indexOf('data-key="due"'))
    expect(due).toContain('已到期 · 2 分钟前')
    const held = html.slice(html.indexOf('data-key="held"'))
    expect(held).toContain(`退避至 ${formatDateTime(NOW + 240_000)}`)
    expect(held).toContain('投递失败')
    expect(held).toContain('<span class="tone-bad">3</span>')
    const gone = html.slice(html.indexOf('data-key="gone"'))
    expect(gone).toContain('不在作业文件中')
    expect(gone).toContain('不再调度')
    expect(html).toContain('连续失败 1')
  })

  test('a job that has never fired says so', async () => {
    const base = snapshotOf().jobs[0]
    if (base === undefined) throw new Error('fixture')
    const { last: _last, result: _result, ...fresh } = base
    const html = await jobsPage(snapshotOf({ jobs: [{ ...fresh, next: NOW }] }))
    expect(html).toContain('尚未触发')
  })

  test('without job definitions, period and next fire are 未接入 rather than blank', async () => {
    const html = await jobsPage(
      snapshotOf({
        definitions: {
          state: 'unwired',
          reason: '控制台没有读取 qm watch 的作业文件',
        },
        jobs: [
          {
            id: 'disk-watch',
            target: 'qianmo://tokyo-1/reviewer',
            listed: false,
            consecutiveFailures: 0,
            last: { at: NOW - 300_000, outcome: 'completed' },
          },
        ],
      }),
    )
    expect(html).toContain(
      '作业定义未接入 · 控制台没有读取 qm watch 的作业文件 · 周期与下次触发无从计算',
    )
    const row = html.slice(html.indexOf('<tr data-key="disk-watch">'))
    expect(row.match(/data-unwired>未接入/g)).toHaveLength(2)
    // Not "no longer in the file": there is no file to be missing from.
    expect(row).not.toContain('不在作业文件中')
    expect(cardRow(html, 'sched-defs')).toContain('未接入')
  })
})

describe('the emergency stop', () => {
  test('released, engaged with its instant, and unreadable are three different lines', async () => {
    expect(cardRow(await jobsPage(snapshotOf()), 'sched-estop')).toContain(
      '未拉下',
    )

    const engaged = await jobsPage(
      snapshotOf({ estop: { state: 'engaged', since: NOW - 600_000 } }),
    )
    expect(cardRow(engaged, 'sched-estop')).toContain(
      `已拉下 · 自 ${formatDateTime(NOW - 600_000)}`,
    )
    expect(engaged).toContain(
      '急停已拉下 · 不再发起新的触发 · 进行中的作业不受影响',
    )
    // And every next fire on the page says it will not happen.
    expect(engaged).toContain('急停中 · 不会触发')

    const unknown = await jobsPage(
      snapshotOf({ estop: { state: 'unknown', reason: 'EACCES' } }),
    )
    expect(cardRow(unknown, 'sched-estop')).toContain('读不出来')
    expect(unknown).toContain('急停状态读不出来 · 调度器按未拉下处理 · EACCES')
  })
})

describe('the scheduler heartbeat is never a blank', () => {
  test('not wired: stated, with the reason, above the table', async () => {
    const html = await jobsPage(snapshotOf())
    expect(cardRow(html, 'sched-tick')).toContain('未接入')
    expect(html).toContain(
      `${UNWIRED_TICK} · qm watch 是独立进程 · 最后一次运行只在它的内存里 · 无法判断调度器是否在运行`,
    )
    // The weaker sign of life that is available is shown under it.
    expect(cardRow(html, 'sched-activity')).toContain('4 分钟前')
  })

  test('never run: stated as a failure', async () => {
    const html = await jobsPage(snapshotOf({ tick: { state: 'never' } }))
    expect(cardRow(html, 'sched-tick')).toContain('从未运行')
    expect(html).toContain('调度器从未运行 · 作业不会触发')
  })

  test('seen too long ago: possibly stopped', async () => {
    const html = await jobsPage(
      snapshotOf({ tick: { state: 'seen', at: NOW - 600_000 } }),
    )
    expect(cardRow(html, 'sched-tick')).toContain('10 分钟前 · 可能已停止')
    expect(html).toContain('调度器可能已停止 · 最后一次运行 10 分钟前')
  })

  test('seen just now: no strip — the control for the three above', async () => {
    const html = await jobsPage(
      snapshotOf({ tick: { state: 'seen', at: NOW - 20_000 } }),
    )
    expect(cardRow(html, 'sched-tick')).toContain('20 秒前')
    expect(html).not.toContain(UNWIRED_TICK)
    expect(html).not.toContain('可能已停止')
    expect(html).not.toContain('从未运行')
  })

  test('no scheduler port at all: the same words, and the page says why', async () => {
    const html = await jobsPage(null)
    expect(html).toContain('值守作业未接入 · 控制台没有读取调度器状态')
    expect(html).toContain(`${UNWIRED_TICK} · 无法判断调度器是否在运行`)
    expect(cardRow(html, 'sched-tick')).toContain('未接入')
    expect(cardRow(html, 'sched-estop')).toContain('未接入')
  })

  test('a port that fails: its failure, and the heartbeat still stated absent', async () => {
    const scheduler = new FixedScheduler(snapshotOf())
    scheduler.result = {
      ok: false,
      failure: { code: 'unreachable', message: 'state unreadable' },
    } satisfies ConsoleResult<SchedulerSnapshot>
    const c = watchConsole({ scheduler })
    const html = await (await c.handle(browse('/jobs', ADMIN))).text()
    expect(html).toContain('调度器状态不可达 · state unreadable')
    expect(html).toContain(UNWIRED_TICK)
  })
})

describe('the JSON face and the fragment', () => {
  test('GET /v0/jobs is the snapshot; 501 without a port; nothing but GET', async () => {
    const snapshot = snapshotOf()
    const c = watchConsole({ scheduler: new FixedScheduler(snapshot) })
    const response = await c.handle(call('GET', '/v0/jobs', VIEW))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(snapshot)))
    expect((await c.handle(call('POST', '/v0/jobs', ADMIN))).status).toBe(405)
    expect((await c.handle(call('GET', '/v0/jobs/x', VIEW))).status).toBe(404)
    const bare = watchConsole()
    expect((await bare.handle(call('GET', '/v0/jobs', VIEW))).status).toBe(501)
  })

  test('the page polls the fragment, and the fragment is the same card and table', async () => {
    const scheduler = new FixedScheduler(snapshotOf())
    const c = watchConsole({ scheduler })
    const pageHtml = await (await c.handle(browse('/jobs', VIEW))).text()
    expect(pageHtml).toContain('data-poll="/fragments/jobs"')
    const fragment = await (
      await c.handle(call('GET', '/fragments/jobs', VIEW))
    ).text()
    expect(fragment).toContain('<tr data-key="disk-watch">')
    expect(fragment).toContain(UNWIRED_TICK)
    expect(pageHtml).toContain(fragment)
  })

  test("the area's API heads are one table, so a second head is one more entry", () => {
    expect(jobsRoute.api?.heads).toEqual(['jobs'])
  })
})
