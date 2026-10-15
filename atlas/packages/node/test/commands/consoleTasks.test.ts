// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Background tasks on the hub (P29, ported from grantley `tasks/`): a
 * foreground starts a task, the hub drives the worker conversation turn after
 * turn until it reports, extra instructions and status, cancel, restart
 * recovery, and the result back in the parent conversation.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ControlOutcome } from '@qianmo/protocol'
import {
  ConsoleTasks,
  type TaskFinished,
  WORKER_INSTRUCTIONS,
} from '../../src/commands/consoleTasks.js'
import { until } from '../channels/fakes.js'
import { FakeChat } from './fakeChat.js'

const MAIN = 'qianmo://node-a/main'
const CODER = 'qianmo://node-b/coder'

let root: string
let chat: FakeChat
let stopped: [string, string][]
let finished: TaskFinished[]
let open: ConsoleTasks[]

function tasks(
  options: {
    foreground?: (id: string) => boolean
    related?: (id: string) => readonly string[]
  } = {},
) {
  const book = new ConsoleTasks({
    directory: root,
    chat,
    stopTask: async (target, taskId) => {
      stopped.push([target, taskId])
      return true
    },
    backoffMs: () => 5,
    ...options,
  })
  book.onFinished(async event => {
    finished.push(event)
    return undefined
  })
  open.push(book)
  book.start()
  return book
}

/** A foreground conversation with one operator line waiting for its answer. */
async function foreground(target = MAIN): Promise<string> {
  const session = await chat.open(target)
  if (!session.ok) throw new Error('open')
  await chat.send({ sessionId: session.value.id, text: '帮我整理一下周报' })
  return session.value.id
}

function call(
  book: ConsoleTasks,
  op: string,
  sessionId: string,
  args: Record<string, unknown> = {},
  agent = 'main',
  node = 'node-a',
): Promise<ControlOutcome> {
  return book.handle(
    `tasks.${op}`,
    { ...args, contextId: sessionId, taskId: chat.lastTask(sessionId) },
    { node, agent, callId: 'c-1' },
  )
}

function value<T = Record<string, unknown>>(outcome: ControlOutcome): T {
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.value as T
}

/** The worker conversation the hub opened, once it has sent `n` lines into it. */
async function workerTurn(n: number): Promise<string> {
  let worker = ''
  await until(() => {
    const ids = [...chat.records.keys()].filter(id =>
      chat
        .sentTo(id)
        .some(one => one.text.startsWith('你是一个持久后台子智能体')),
    )
    worker = ids[0] ?? ''
    return worker !== '' && chat.sentTo(worker).length >= n
  })
  return worker
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-tasks-'))
  chat = new FakeChat([MAIN, CODER])
  stopped = []
  finished = []
  open = []
})

afterEach(async () => {
  await Promise.all(open.map(book => book.close()))
  fs.rmSync(root, { recursive: true, force: true })
})

describe('starting', () => {
  test('a foreground starts a task and gets its id at once; the worker gets the rules, the task and recent context', async () => {
    const book = tasks()
    const parent = await foreground()
    const started = value<{ id: string; status: string; target: string }>(
      await call(book, 'start', parent, {
        title: '周报',
        instructions: '汇总本周提交并写成周报',
      }),
    )
    expect(started).toMatchObject({ status: 'queued', target: MAIN })
    expect(started.id).toMatch(/^task-/)
    const worker = await workerTurn(1)
    expect(worker).not.toBe(parent)
    const prompt = chat.sentTo(worker)[0]!.text
    expect(prompt.startsWith(WORKER_INSTRUCTIONS)).toBe(true)
    expect(prompt).toContain(`后台任务 ${started.id}：周报`)
    expect(prompt).toContain('汇总本周提交并写成周报')
    expect(prompt).toContain('帮我整理一下周报')
  })

  test('a task can run on another agent (another runtime or model)', async () => {
    const book = tasks()
    const parent = await foreground()
    value(
      await call(book, 'start', parent, {
        title: 'x',
        instructions: 'y',
        agent: CODER,
      }),
    )
    await until(() => chat.opened.includes(CODER))
  })

  test('only the agent of the conversation, during a turn still waiting, may call', async () => {
    const book = tasks()
    const parent = await foreground()
    const refused = async (outcome: Promise<ControlOutcome>) => {
      const result = await outcome
      return result.ok ? 'ok' : result.message
    }
    expect(
      await refused(
        call(book, 'start', parent, { title: 'a', instructions: 'b' }, 'other'),
      ),
    ).toBe('会话不属于这个智能体')
    expect(
      await refused(
        book.handle(
          'tasks.status',
          { contextId: parent, taskId: 'not-this-turn' },
          { node: 'node-a', agent: 'main', callId: 'c' },
        ),
      ),
    ).toBe('这一轮不在进行中')
    chat.reply(parent, '好的')
    expect(await refused(call(book, 'status', parent))).toBe('这一轮不在进行中')
    expect(
      await refused(
        book.handle(
          'tasks.status',
          { contextId: 'nope', taskId: 'x' },
          { node: 'node-a', agent: 'main', callId: 'c' },
        ),
      ),
    ).toBe('会话不存在')
  })

  test('channel groups and members may not start tasks; a worker may not start or manage any', async () => {
    const parent = await foreground()
    const book = tasks({ foreground: id => id !== parent })
    const denied = await call(book, 'start', parent, {
      title: 'a',
      instructions: 'b',
    })
    expect(denied.ok ? '' : denied.message).toBe(
      '后台任务只对主人的私聊和控制台对话开放',
    )
    const other = await foreground()
    value(await call(book, 'start', other, { title: 'a', instructions: 'b' }))
    const worker = await workerTurn(1)
    const nested = await call(book, 'start', worker, {
      title: 'c',
      instructions: 'd',
    })
    expect(nested.ok ? '' : nested.message).toBe(
      '后台子任务不能再开或管理其他任务',
    )
    const report = await call(book, 'report', other, {
      summary: 'x',
      state: 'working',
    })
    expect(report.ok ? '' : report.message).toBe('只有后台子任务能汇报')
  })
})

describe('the worker loop', () => {
  test('keeps going until an explicit completed report, then tells the parent', async () => {
    const book = tasks()
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, {
        title: '周报',
        instructions: '写周报',
      }),
    )
    const worker = await workerTurn(1)
    // An ordinary final answer is not a completion: the hub continues.
    chat.reply(worker, '我写好了')
    await until(() => chat.sentTo(worker).length === 2)
    expect(chat.sentTo(worker)[1]!.text).toContain('继续同一持久会话')
    value(
      await call(
        book,
        'report',
        worker,
        { summary: '已汇总 12 个提交', state: 'working' },
        'main',
      ),
    )
    value(
      await call(book, 'report', worker, {
        summary: '周报已写入 reports/w42.md 并核对',
        state: 'completed',
      }),
    )
    expect(
      value<{ task: { status: string } }>(
        await call(book, 'status', parent, { id }),
      ).task.status,
    ).toBe('completion_pending')
    chat.reply(worker, '完成')
    await until(() => finished.length === 1)
    expect(finished[0]).toMatchObject({ parentSession: parent, taskId: id })
    expect(finished[0]!.text).toBe(
      '周报：已完成\n\n周报已写入 reports/w42.md 并核对',
    )
    expect(chat.notes).toEqual([{ sessionId: parent, text: finished[0]!.text }])
    const status = value<{ tasks: { status: string; progress: string }[] }>(
      await call(book, 'status', parent),
    )
    expect(status.tasks[0]).toMatchObject({
      status: 'completed',
      progress: '周报已写入 reports/w42.md 并核对',
    })
    expect(book.statusText(parent)).toBe(
      '周报：已完成。周报已写入 reports/w42.md 并核对',
    )
  })

  test('new instructions must be read before a completion is accepted, and are offered in the next prompt', async () => {
    const book = tasks()
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, { title: 't', instructions: 'i' }),
    )
    const worker = await workerTurn(1)
    value(await call(book, 'send', parent, { id, message: '顺便附上图表' }))
    const early = await call(book, 'report', worker, {
      summary: 'done',
      state: 'completed',
    })
    expect(early.ok ? '' : early.message).toContain(
      '先调用 qianmo_task_updates',
    )
    const read = value<{ updates: { id: number; message: string }[] }>(
      await call(book, 'updates', worker),
    )
    expect(read.updates.map(one => one.message)).toEqual(['顺便附上图表'])
    value(
      await call(book, 'report', worker, {
        summary: '含图表',
        state: 'completed',
      }),
    )
    // Confirmed with the checkpoint: not offered again.
    expect(
      value<{ updates: unknown[] }>(await call(book, 'updates', worker))
        .updates,
    ).toEqual([])
    chat.reply(worker, 'ok')
    await until(() => finished.length === 1)
  })

  test('needs_input pauses; an added instruction resumes the same worker session', async () => {
    const book = tasks()
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, {
        title: '订会议室',
        instructions: '订周五的会议室',
      }),
    )
    const worker = await workerTurn(1)
    value(
      await call(book, 'report', worker, {
        summary: '几点开始？',
        state: 'needs_input',
      }),
    )
    chat.reply(worker, '等回复')
    await until(() => finished.length === 1)
    expect(finished[0]!.text).toBe('订会议室：需要你的补充\n\n几点开始？')
    await chat.send({ sessionId: parent, text: '下午三点' })
    value(await call(book, 'send', parent, { id, message: '下午三点' }))
    await until(() => chat.sentTo(worker).length === 2)
    expect(chat.sentTo(worker)[1]!.text).toContain('"message":"下午三点"')
    // The parent and one worker session: resuming opened nothing new.
    expect(chat.opened).toEqual([MAIN, MAIN])
  })

  test('a worker that never reports is paused after five quiet turns', async () => {
    const book = tasks()
    const parent = await foreground()
    value(await call(book, 'start', parent, { title: '闲', instructions: 'x' }))
    const worker = await workerTurn(1)
    for (let n = 1; n <= 5; n++) {
      await until(() => chat.sentTo(worker).length === n)
      chat.reply(worker, `第 ${n} 轮`)
    }
    await until(() => finished.length === 1)
    expect(finished[0]!.text).toContain(
      '连续 5 轮没有用 qianmo_task_report 汇报进展',
    )
    expect(chat.sentTo(worker)).toHaveLength(5)
  })

  test('failed turns are retried with backoff and the error kept as a checkpoint note', async () => {
    const book = tasks()
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, { title: 't', instructions: 'i' }),
    )
    const worker = await workerTurn(1)
    chat.reply(worker, '模型服务不可用', 'failed')
    await until(() => chat.sentTo(worker).length === 2)
    expect(chat.sentTo(worker)[1]!.text).toContain('上次中断：模型服务不可用')
    expect(
      value<{ task: { lastError: string } }>(
        await call(book, 'status', parent, { id }),
      ).task.lastError,
    ).toBe('模型服务不可用')
  })

  test('cancel stops the running worker turn on its node', async () => {
    const book = tasks()
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, {
        title: 't',
        instructions: 'i',
        agent: CODER,
      }),
    )
    const worker = await workerTurn(1)
    const running = chat.lastTask(worker)
    const cancelled = value<{ task: { status: string } }>(
      await call(book, 'cancel', parent, { id }),
    )
    expect(cancelled.task.status).toBe('cancelled')
    expect(stopped).toEqual([[CODER, running]])
    const again = await call(book, 'send', parent, { id, message: 'x' })
    expect(again.ok ? '' : again.message).toBe('任务已结束；请创建新任务')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(chat.sentTo(worker)).toHaveLength(1)
  })

  test('at most two workers run on one agent at a time', async () => {
    const book = tasks()
    const parent = await foreground()
    for (const title of ['a', 'b', 'c'])
      value(await call(book, 'start', parent, { title, instructions: 'x' }))
    await until(
      () =>
        chat.sent.filter(one => one.text.startsWith('你是一个持久后台子智能体'))
          .length === 2,
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    const first = chat.sent.filter(one =>
      one.text.startsWith('你是一个持久后台子智能体'),
    )
    expect(first).toHaveLength(2)
    chat.reply(first[0]!.sessionId, 'x', 'failed')
    await until(
      () =>
        chat.sent.filter(one => one.text.startsWith('你是一个持久后台子智能体'))
          .length === 3,
    )
  })
})

describe('durability', () => {
  test('an interrupted task resumes after a restart in the same worker session', async () => {
    const book = tasks()
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, { title: '长任务', instructions: 'x' }),
    )
    const worker = await workerTurn(1)
    value(
      await call(book, 'report', worker, {
        summary: '做了一半',
        state: 'working',
      }),
    )
    await book.close()
    open = []
    const ledger = JSON.parse(
      fs.readFileSync(path.join(root, 'tasks.json'), 'utf8'),
    )
    expect(ledger.tasks[0]).toMatchObject({
      id,
      status: 'interrupted',
      workerSession: worker,
      progress: '做了一半',
    })
    expect(fs.statSync(path.join(root, 'tasks.json')).mode & 0o777).toBe(0o600)
    tasks()
    await until(() => chat.sentTo(worker).length === 2)
    const prompt = chat.sentTo(worker)[1]!.text
    expect(prompt).toContain('继续同一持久会话')
    expect(prompt).toContain('持久检查点：做了一半')
    expect(prompt.startsWith(WORKER_INSTRUCTIONS)).toBe(false)
  })

  test('tasks follow a chat across /new (related sessions)', async () => {
    const first = await foreground()
    const second = await foreground()
    const book = tasks({
      related: id => (id === first || id === second ? [first, second] : [id]),
    })
    const { id } = value<{ id: string }>(
      await call(book, 'start', first, { title: 't', instructions: 'i' }),
    )
    const listed = value<{ tasks: { id: string }[] }>(
      await call(book, 'status', second),
    )
    expect(listed.tasks.map(task => task.id)).toEqual([id])
    expect(book.contextFor(second)).toContain(`"id":"${id}"`)
    expect(await book.cancelForSession(second)).toBe(1)
  })
})
