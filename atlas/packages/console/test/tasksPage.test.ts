// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 后台任务 on the 主动执行 page (P29): who sees which tasks, who may cancel,
 * the phases including 排队中, the worker session link, and the page without
 * the port — through the real router, guards and personal accounts.
 */

import { describe, expect, test } from 'bun:test'
import type { ConsoleResult } from '../src/deps.js'
import type {
  BackgroundTaskReader,
  BackgroundTasksPort,
  BackgroundTaskView,
  DirectionActor,
} from '../src/directionPorts.js'
import {
  ADMIN,
  accountsHarness,
  asBearer,
  asSession,
  person,
} from './accountsHarness.js'
import { MemoryActionLedger } from './memoryActions.js'

function task(fields: Partial<BackgroundTaskView>): BackgroundTaskView {
  return {
    id: 'task-1',
    title: '周报',
    owner: 'legacy:admin',
    target: 'qianmo://tokyo-1/planner',
    status: 'running',
    state: 'running',
    phase: '执行中',
    progress: '',
    lastError: '',
    turns: 1,
    parentSession: 'main-1',
    workerSession: null,
    nextAt: null,
    everyMinutes: null,
    runsLeft: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...fields,
  }
}

/** The host's rule: the owner sees a task, ops and the legacy tokens all. */
class FakeTasks implements BackgroundTasksPort {
  rows: BackgroundTaskView[] = []
  readonly readers: BackgroundTaskReader[] = []
  readonly cancelled: { id: string; actor: DirectionActor }[] = []
  #sees(row: BackgroundTaskView, actor: BackgroundTaskReader): boolean {
    return (
      actor.role === 'ops' ||
      (actor.role == null && actor.subject.startsWith('legacy:')) ||
      row.owner === actor.subject
    )
  }
  list(actor: BackgroundTaskReader) {
    this.readers.push(actor)
    return this.rows.filter(row => this.#sees(row, actor))
  }
  visible(id: string, actor: BackgroundTaskReader) {
    return this.rows.some(row => row.id === id && this.#sees(row, actor))
  }
  async cancel(
    id: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<BackgroundTaskView>> {
    this.cancelled.push({ id, actor })
    const row = this.rows.find(one => one.id === id)!
    if (row.status === 'completed')
      return { ok: false, failure: { code: 'rejected', message: '任务已结束' } }
    const next = {
      ...row,
      status: 'cancelled' as const,
      state: 'cancelled' as const,
      phase: '已取消',
    }
    this.rows = this.rows.map(one => (one.id === id ? next : one))
    return { ok: true, value: next }
  }
}

/** A member and an ops account, and the member's subject as the port saw it. */
async function setup() {
  const tasks = new FakeTasks()
  const actions = new MemoryActionLedger()
  const h = accountsHarness({ deps: { tasks, actions } })
  const member = await person(h.handle, 'member')
  const other = await person(h.handle, 'member')
  const ops = await person(h.handle, 'ops')
  const viewer = await person(h.handle, 'viewer')
  const subject = async (who: { sid: string }) => {
    await h.handle(asSession('GET', '/v0/tasks', who.sid))
    return tasks.readers.at(-1)!.subject
  }
  const mine = await subject(member)
  const theirs = await subject(other)
  tasks.rows = [
    task({
      id: 'task-mine',
      owner: mine,
      progress: '已汇总 12 个提交',
      workerSession: 'worker-1',
      turns: 3,
    }),
    task({
      id: 'task-waiting',
      owner: mine,
      status: 'queued',
      state: 'queued',
      phase: '排队中',
      lastError: '模型服务不可用',
    }),
    task({
      id: 'task-done',
      owner: mine,
      status: 'completed',
      state: 'completed',
      phase: '已完成',
    }),
    task({ id: 'task-theirs', owner: theirs, title: '别人的' }),
  ]
  return { h, tasks, actions, member, other, ops, viewer }
}

async function listed(
  h: { handle: (request: Request) => Promise<Response> },
  sid: string,
): Promise<string[]> {
  const response = await h.handle(asSession('GET', '/v0/tasks', sid))
  expect(response.status).toBe(200)
  const body = (await response.json()) as { tasks: BackgroundTaskView[] }
  return body.tasks.map(row => row.id)
}

describe('background tasks in the console (P29)', () => {
  test('the owner sees their own, ops sees every task', async () => {
    const { h, member, ops } = await setup()
    expect(await listed(h, member.sid)).toEqual([
      'task-mine',
      'task-waiting',
      'task-done',
    ])
    expect(await listed(h, ops.sid)).toHaveLength(4)
  })

  test('the owner or ops may cancel; anyone else gets the same 404 as a missing task', async () => {
    const { h, tasks, actions, member, other, ops, viewer } = await setup()
    const cancel = (sid: string, id: string) =>
      h.handle(asSession('POST', `/v0/tasks/${id}/cancel`, sid))
    expect((await cancel(other.sid, 'task-mine')).status).toBe(404)
    expect((await cancel(member.sid, 'nope')).status).toBe(404)
    // A viewer cannot write at all.
    expect((await cancel(viewer.sid, 'task-mine')).status).toBe(403)
    expect(tasks.cancelled).toEqual([])
    const done = await cancel(member.sid, 'task-mine')
    expect(done.status).toBe(200)
    expect(((await done.json()) as BackgroundTaskView).status).toBe('cancelled')
    expect((await cancel(ops.sid, 'task-theirs')).status).toBe(200)
    expect((await cancel(member.sid, 'task-done')).status).toBe(400)
    expect(tasks.cancelled.map(one => one.id)).toEqual([
      'task-mine',
      'task-theirs',
      'task-done',
    ])
    expect(
      actions.entries
        .filter(entry => entry.action === 'task.cancel')
        .map(entry => [entry.target, entry.outcome]),
    ).toEqual([
      ['task-mine', 'ok'],
      ['task-theirs', 'ok'],
      ['task-done', 'failed'],
    ])
    // Only GET lists and only POST cancels.
    expect(
      (await h.handle(asSession('POST', '/v0/tasks', member.sid))).status,
    ).toBe(405)
    expect(
      (
        await h.handle(
          asSession('GET', '/v0/tasks/task-mine/cancel', member.sid),
        )
      ).status,
    ).toBe(405)
  })

  test('the page lists states, turns, the last report and error, the main and worker sessions and 停止', async () => {
    const { h, member, ops } = await setup()
    const page = await (
      await h.handle(asSession('GET', '/admin/jobs', member.sid))
    ).text()
    const region = page.slice(page.indexOf('id="tasks"'))
    expect(region).toContain('data-poll="/fragments/tasks"')
    expect(region).toContain('运行中')
    expect(region).toContain('排队中')
    expect(region).toContain('已汇总 12 个提交')
    expect(region).toContain('模型服务不可用')
    expect(region).toContain('href="/?session=worker-1"')
    expect(region).toContain('href="/?session=main-1"')
    expect(region).not.toContain('别人的')
    // 停止 on the unfinished only; the confirmation is on the page once.
    expect(region.match(/data-action="task-cancel"/g)).toHaveLength(2)
    expect(region).toContain('停止')
    expect(page.match(/id="confirm-task-cancel"/g)).toHaveLength(1)
    // The member sees only their own tasks: no 发起人 column.
    expect(region).not.toContain('发起人')
    const fragment = await (
      await h.handle(asSession('GET', '/fragments/tasks', ops.sid))
    ).text()
    expect(fragment).toContain('别人的')
    expect(fragment).toContain('发起人')
    expect(fragment).toContain('运行中 2 · 排队中 1 · 最近结束 1')
  })

  test('several at once (P38): each row its own state and main session', async () => {
    const tasks = new FakeTasks()
    const actions = new MemoryActionLedger()
    const h = accountsHarness({ deps: { tasks, actions } })
    const member = await person(h.handle, 'member')
    await h.handle(asSession('GET', '/v0/tasks', member.sid))
    const owner = tasks.readers.at(-1)!.subject
    tasks.rows = [
      task({ id: 't-1', owner, title: '甲', workerSession: 'w-1' }),
      task({ id: 't-2', owner, title: '乙', workerSession: 'w-2' }),
      task({
        id: 't-3',
        owner,
        title: '丙',
        status: 'queued',
        state: 'queued',
        parentSession: 'main-2',
      }),
      task({
        id: 't-4',
        owner,
        title: '丁',
        status: 'needs_input',
        state: 'needs_input',
        workerSession: 'w-4',
      }),
      task({
        id: 't-5',
        owner,
        title: '戊',
        status: 'needs_input',
        state: 'failed',
        lastError: '派发被拒绝',
        workerSession: 'w-5',
      }),
    ]
    const body = (await (
      await h.handle(asSession('GET', '/v0/tasks', member.sid))
    ).json()) as { tasks: BackgroundTaskView[] }
    expect(body.tasks.find(row => row.id === 't-3')).toMatchObject({
      state: 'queued',
      parentSession: 'main-2',
    })
    const page = await (
      await h.handle(asSession('GET', '/admin/jobs', member.sid))
    ).text()
    const region = page.slice(page.indexOf('id="tasks"'))
    const row = (id: string) => {
      const start = region.indexOf(`data-key="${id}"`)
      return region.slice(start, region.indexOf('</tr>', start))
    }
    expect(row('t-1')).toContain('运行中')
    expect(row('t-2')).toContain('运行中')
    expect(row('t-3')).toContain('排队中')
    expect(row('t-3')).toContain('href="/?session=main-2"')
    expect(row('t-4')).toContain('等你回复')
    expect(row('t-5')).toContain('失败')
    expect(row('t-5')).toContain('href="/?session=w-5"')
    expect(region.match(/data-action="task-cancel"/g)).toHaveLength(5)
    expect(region).toContain(
      '运行中 2 · 排队中 1 · 等你回复 1 · 失败 1 · 最近结束 0',
    )
  })

  test('without the port the page says so and the API answers 501', async () => {
    const h = accountsHarness()
    const page = await (
      await h.handle(asBearer('GET', '/admin/jobs', ADMIN))
    ).text()
    expect(page).toContain('后台任务未接入')
    expect(page).not.toContain('id="confirm-task-cancel"')
    expect((await h.handle(asBearer('GET', '/v0/tasks', ADMIN))).status).toBe(
      501,
    )
  })
})

describe('the sidebar dot of 主动执行', () => {
  const navJobs = (page: string) => {
    const start = page.indexOf('id="nav-jobs"')
    return page.slice(start, page.indexOf('</a>', start))
  }

  test('a task that waits for its owner is 待你处理 with how many; one that runs is grey', async () => {
    const { h, tasks, member, other } = await setup()
    const page = async (sid: string) =>
      (await h.handle(asSession('GET', '/admin/jobs', sid))).text()
    // task-mine runs; task-waiting is queued, which is not running yet.
    let item = navJobs(await page(member.sid))
    expect(item).toContain('nav-state-running')
    expect(item).toContain('1 个运行中')
    tasks.rows = tasks.rows.map(row =>
      row.id === 'task-waiting' ? { ...row, status: 'needs_input' } : row,
    )
    item = navJobs(await page(member.sid))
    expect(item).toContain('nav-state-attention')
    expect(item).toContain('1 项待你处理')
    expect(item).toContain('<span aria-hidden="true">1</span>')
    // Somebody else's waiting task is not this reader's to handle.
    item = navJobs(await page(other.sid))
    expect(item).not.toContain('待你处理')
    tasks.rows = tasks.rows.map(row => ({ ...row, status: 'completed' }))
    expect(navJobs(await page(member.sid))).not.toContain('nav-state')
  })
})

describe("the front's session panel (后台任务)", () => {
  test("the reader's own tasks, waiting first, with 停止 while they run and the finished folded", async () => {
    const { h, tasks, member, viewer } = await setup()
    tasks.rows = tasks.rows.map(row =>
      row.id === 'task-waiting' ? { ...row, status: 'needs_input' } : row,
    )
    const panel = await (
      await h.handle(
        asSession('GET', '/fragments/chat/front/panel', member.sid),
      )
    ).text()
    expect(panel).toContain('id="fx-panel-body"')
    expect(panel).toContain('后台任务')
    expect(panel).toContain('1 项待你处理')
    // Waiting first, then running; the other member's task is not here.
    expect(panel.indexOf('data-key="task:task-waiting"')).toBeLessThan(
      panel.indexOf('data-key="task:task-mine"'),
    )
    expect(panel).not.toContain('别人的')
    expect(panel).toContain('data-task-stop="task-mine"')
    expect(panel).not.toContain('data-task-stop="task-done"')
    expect(panel).toContain('1 个已完成')
    expect(panel).toContain('已汇总 12 个提交')
    expect(panel).toContain('href="/?session=worker-1"')
    // The chat face's guard: a viewer has no conversation, so no panel.
    expect(
      (
        await h.handle(
          asSession('GET', '/fragments/chat/front/panel', viewer.sid),
        )
      ).status,
    ).toBe(403)
  })
})

describe('planned tasks (主动任务)', () => {
  test('a delayed or repeating task reads 已安排 with its next start and the runs left; the API carries the fields', async () => {
    const tasks = new FakeTasks()
    const actions = new MemoryActionLedger()
    const h = accountsHarness({ deps: { tasks, actions } })
    const member = await person(h.handle, 'member')
    await h.handle(asSession('GET', '/v0/tasks', member.sid))
    const owner = tasks.readers.at(-1)!.subject
    const soon = h.clock.now() + 2 * 60 * 60_000
    const later = h.clock.now() + 3 * 24 * 60 * 60_000
    tasks.rows = [
      task({
        id: 'task-later',
        owner,
        title: '周检',
        status: 'scheduled',
        state: 'scheduled',
        phase: '已安排',
        nextAt: later,
      }),
      task({
        id: 'task-repeat',
        owner,
        title: '巡检',
        status: 'scheduled',
        state: 'scheduled',
        phase: '已安排',
        nextAt: soon,
        everyMinutes: 60,
        runsLeft: 3,
      }),
      task({
        id: 'task-run',
        owner,
        title: '日报',
        everyMinutes: 1440,
        runsLeft: 2,
      }),
    ]
    const body = (await (
      await h.handle(asSession('GET', '/v0/tasks', member.sid))
    ).json()) as { tasks: BackgroundTaskView[] }
    expect(body.tasks.find(row => row.id === 'task-repeat')).toMatchObject({
      status: 'scheduled',
      nextAt: soon,
      everyMinutes: 60,
      runsLeft: 3,
    })
    const page = await (
      await h.handle(asSession('GET', '/admin/jobs', member.sid))
    ).text()
    const region = page.slice(page.indexOf('id="tasks"'))
    // Running first, then the planned ones by their next start.
    expect(region.indexOf('日报')).toBeLessThan(region.indexOf('巡检'))
    expect(region.indexOf('巡检')).toBeLessThan(region.indexOf('周检'))
    expect(region).toContain('运行中 · 剩 2 次')
    expect(region).toMatch(
      /已安排 · 下次 <time[^>]*data-fmt="hm"[^>]*>\d{2}:\d{2}<\/time> · 剩 3 次/,
    )
    // Further than a day off: with the date.
    expect(region).toMatch(/已安排 · 下次 <time[^>]*data-fmt="minute"/)
    expect(region).toContain('运行中 1 · 排队中 0 · 已安排 2 · 最近结束 0')
    // A planned task can be cancelled like any unfinished one.
    expect(region.match(/data-action="task-cancel"/g)).toHaveLength(3)
  })

  test('a start already due reads as the hub says, without a time gone by', async () => {
    const tasks = new FakeTasks()
    const actions = new MemoryActionLedger()
    const h = accountsHarness({ deps: { tasks, actions } })
    const member = await person(h.handle, 'member')
    await h.handle(asSession('GET', '/v0/tasks', member.sid))
    const owner = tasks.readers.at(-1)!.subject
    tasks.rows = [
      task({
        id: 'task-due',
        owner,
        title: '巡检',
        status: 'scheduled',
        state: 'scheduled',
        phase: '已安排 · 等名额',
        nextAt: h.clock.now() - 60_000,
        everyMinutes: 60,
        runsLeft: 2,
      }),
    ]
    const page = await (
      await h.handle(asSession('GET', '/admin/jobs', member.sid))
    ).text()
    const region = page.slice(page.indexOf('id="tasks"'))
    expect(region).toContain('已安排 · 等名额 · 剩 2 次')
    expect(region).not.toContain('下次')
  })
})
