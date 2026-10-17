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
import type { ConsoleAccounts } from '@qianmo/console'
import type { ControlOutcome } from '@qianmo/protocol'
import {
  accountsHarness,
  person,
} from '../../../console/test/accountsHarness.js'
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
    turnTtlMs?: number
    deliveryRetryMs?: (attempts: number) => number
    stopTask?: (target: string, taskId: string) => Promise<boolean>
    now?: () => number
    scheduled?: (id: string) => boolean
    accounts?: ConsoleAccounts
    /** More result listeners, by key, registered before the book starts. */
    listeners?: Record<
      string,
      (event: TaskFinished) => Promise<boolean | undefined>
    >
  } = {},
) {
  const { listeners, ...rest } = options
  const book = new ConsoleTasks({
    directory: root,
    chat,
    stopTask: async (target, taskId) => {
      stopped.push([target, taskId])
      return true
    },
    backoffMs: () => 5,
    ...rest,
  })
  book.onFinished(async event => {
    finished.push(event)
    return undefined
  }, 'test')
  for (const [key, listener] of Object.entries(listeners ?? {}))
    book.onFinished(listener, key)
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
      chat.sentTo(id).some(one => one.background),
    )
    worker = ids[0] ?? ''
    return worker !== '' && chat.sentTo(worker).length >= n
  })
  return worker
}

/** Worker sessions, in the order the hub first sent into them. */
function workerSessions(): string[] {
  return [
    ...new Set(
      chat.sent.filter(one => one.background).map(one => one.sessionId),
    ),
  ]
}

function targetOf(sessionId: string): string {
  return chat.records.get(sessionId)!.session.target
}

/** Worker lines on a node's agents still waiting for their answer. */
function outstanding(node: string): number {
  let count = 0
  for (const id of workerSessions()) {
    if (targetOf(id).split('/')[2] !== node) continue
    const turns = chat.records.get(id)!.turns
    for (const turn of turns)
      if (
        turn.author === 'operator' &&
        !turns.some(one => one.author === 'agent' && one.taskId === turn.taskId)
      )
        count++
  }
  return count
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
    // The first line names the task, wherever the session is listed.
    expect(prompt.startsWith(`后台任务：周报（${started.id}）\n\n`)).toBe(true)
    expect(prompt).toContain(WORKER_INSTRUCTIONS)
    expect(prompt).toContain('汇总本周提交并写成周报')
    expect(prompt).toContain('帮我整理一下周报')
    // Nothing went wrong before the first turn: nothing to verify.
    expect(prompt).not.toContain('核实后接着做')
  })

  test("the worker context keeps the user's words, not the host's framing, and the end of a long line", async () => {
    const book = tasks()
    const session = await chat.open(MAIN)
    if (!session.ok) throw new Error('open')
    const parent = session.value.id
    // A channel line: framing, a long channel prompt, the coordination rule
    // and the task note ahead of what the owner said.
    const framed = [
      '[渠道] 这段对话来自 Telegram 的私聊。对方是你的主人。\n你的回复会原样发到聊天里',
      `[渠道说明]\n${'渠道说明。'.repeat(320)}`,
      '[后台任务协调规则] 你是保持即时响应的主智能体',
      '[当前会话的后台任务] []',
      '请把本周提交整理成周报发我',
    ].join('\n\n')
    await chat.send({ sessionId: parent, text: framed })
    chat.reply(parent, '好的')
    const long = `${'前情。'.repeat(600)}最后这句是要点`
    await chat.send({ sessionId: parent, text: long })
    value(await call(book, 'start', parent, { title: 't', instructions: 'i' }))
    const worker = await workerTurn(1)
    const prompt = chat.sentTo(worker)[0]!.text
    expect(prompt).toContain('请把本周提交整理成周报发我')
    expect(prompt).toContain('最后这句是要点')
    for (const marker of [
      '[渠道]',
      '[渠道说明]',
      '[后台任务协调规则]',
      '[当前会话的后台任务]',
    ])
      expect(prompt).not.toContain(marker)
  })

  test('a schedule’s session starts no task and is told why', async () => {
    const parent = await foreground()
    const book = tasks({ scheduled: id => id === parent })
    const refused = await call(book, 'start', parent, {
      title: 't',
      instructions: 'i',
    })
    expect(refused.ok ? '' : refused.message).toBe(
      '定时任务的会话不能开后台任务，结果没有人接收；请在这一轮里直接完成',
    )
    expect(workerSessions()).toEqual([])
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
    expect(chat.sentTo(worker)[1]!.text).toContain('继续下一个阶段')
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
    // Only the ids and the count: the worker reads them with the tool.
    const resumed = chat.sentTo(worker)[1]!.text
    expect(resumed).toMatch(
      /有 1 条尚未确认的用户补充（编号 \S+），先调用 qianmo_task_updates 读取并确认/,
    )
    expect(resumed).not.toContain('下午三点')
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
      '连续 5 轮没有用 qianmo_task_report 汇报新的进展',
    )
    expect(chat.sentTo(worker)).toHaveLength(5)
  })

  test('a worker that reports the same words every turn is paused like a quiet one', async () => {
    const book = tasks()
    const parent = await foreground()
    value(await call(book, 'start', parent, { title: 't', instructions: 'x' }))
    const worker = await workerTurn(1)
    for (let n = 1; n <= 6; n++) {
      await until(() => chat.sentTo(worker).length === n || finished.length > 0)
      if (finished.length > 0) break
      value(
        await call(book, 'report', worker, {
          summary: '继续核实中',
          state: 'working',
        }),
      )
      chat.reply(worker, `第 ${n} 轮`)
    }
    await until(() => finished.length === 1)
    expect(finished[0]!.text).toContain('汇报新的进展')
    // The first report is progress; five more turns of the same are not.
    expect(chat.sentTo(worker)).toHaveLength(6)
  })

  test('a report says how many new instructions wait to be read', async () => {
    const book = tasks()
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, { title: 't', instructions: 'x' }),
    )
    const worker = await workerTurn(1)
    const report = () =>
      call(book, 'report', worker, { summary: '一', state: 'working' })
    expect(value<object>(await report())).toEqual({
      state: 'working',
      newUpdates: 0,
    })
    value(await call(book, 'send', parent, { id, message: '换成表格' }))
    value(await call(book, 'send', parent, { id, message: '加上图' }))
    expect(value<object>(await report())).toEqual({
      state: 'working',
      newUpdates: 2,
    })
    value(await call(book, 'updates', worker))
    expect(value<object>(await report())).toEqual({
      state: 'working',
      newUpdates: 0,
    })
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
    const retry = chat.sentTo(worker)[1]!.text
    expect(retry).toContain('上次中断：模型服务不可用')
    expect(retry).toContain('核实后接着做')
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

  test('one worker turn per node: tasks on a node take turns, the slot is handed over, another node runs alongside', async () => {
    const book = tasks()
    const parent = await foreground()
    const ids: string[] = []
    for (const title of ['a', 'b', 'c'])
      ids.push(
        value<{ id: string }>(
          await call(book, 'start', parent, { title, instructions: 'x' }),
        ).id,
      )
    value(
      await call(book, 'start', parent, {
        title: 'd',
        instructions: 'x',
        agent: CODER,
      }),
    )
    await until(() => workerSessions().length === 2)
    await new Promise(resolve => setTimeout(resolve, 20))
    // One on node-a, one on node-b, the other two node-a tasks wait.
    expect(outstanding('node-a')).toBe(1)
    expect(outstanding('node-b')).toBe(1)
    const waiting = book
      .forSession(parent)
      .filter(task => task.target === MAIN && task.status === 'queued')
    expect(waiting.map(task => task.phase)).toEqual(['排队中', '排队中'])
    // The running node-a worker ends a turn without a report: its loop wants
    // another turn, but the slot goes to the next task in line first.
    const first = workerSessions().find(id => targetOf(id) === MAIN)!
    chat.reply(first, '这一阶段做完了')
    await until(() => workerSessions().length === 3)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(outstanding('node-a')).toBe(1)
    expect(chat.sentTo(first)).toHaveLength(1)
    expect(
      book.forSession(parent).find(task => task.title === 'a')?.status,
    ).toBe('queued')
  })

  test('a worker turn carries its own deadline and the background marker', async () => {
    const book = tasks()
    const parent = await foreground()
    value(await call(book, 'start', parent, { title: 't', instructions: 'i' }))
    const worker = await workerTurn(1)
    // Not the chat face's five-minute default: 30 minutes unless configured.
    expect(chat.sentTo(worker)[0]).toMatchObject({
      taskTtlMs: 30 * 60_000,
      background: true,
    })
    await book.close()
    open = []
    tasks({ turnTtlMs: 1_200_000 })
    await until(() => chat.sentTo(worker).length === 2)
    expect(chat.sentTo(worker)[1]?.taskTtlMs).toBe(1_200_000)
  })

  test("a report after the chat face's local timeout still counts until the node answers", async () => {
    const book = tasks()
    const parent = await foreground()
    value(await call(book, 'start', parent, { title: 't', instructions: 'i' }))
    const worker = await workerTurn(1)
    // The chat face gave up waiting; the node has not answered.
    chat.timeout(worker, false)
    value(
      await call(book, 'report', worker, {
        summary: '到点前的进展',
        state: 'working',
      }),
    )
    // The node's own E_TASK_TIMEOUT ends the turn: now it is over.
    chat.timeout(worker, true)
    const late = await call(book, 'report', worker, {
      summary: '晚到',
      state: 'working',
    })
    expect(late.ok ? '' : late.message).toBe('这一轮不在进行中')
  })
})

describe('delivering results', () => {
  /** Starts a task and has its worker complete it. */
  async function complete(book: ConsoleTasks): Promise<string> {
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, { title: '周报', instructions: 'x' }),
    )
    const worker = await workerTurn(1)
    value(
      await call(book, 'report', worker, {
        summary: '写好了',
        state: 'completed',
      }),
    )
    chat.reply(worker, '完成')
    return id
  }

  function ledger(): {
    tasks: Record<string, unknown>[]
  } {
    return JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8'))
  }

  test('a chat that failed gets the result again later; the transcript note is not repeated', async () => {
    let calls = 0
    const book = tasks({
      deliveryRetryMs: () => 5,
      listeners: {
        chat: async () => {
          calls++
          return calls >= 3
        },
      },
    })
    await complete(book)
    await until(() => calls === 3)
    await until(() => ledger().tasks[0]!['notification'] === 'sent')
    expect(chat.notes).toHaveLength(1)
    expect(finished).toHaveLength(1)
    expect(ledger().tasks[0]).toMatchObject({
      deliveries: { note: 'sent', test: 'skipped', chat: 'sent' },
      deliveryAttempts: 3,
    })
  })

  test('a place that keeps failing is given up after five rounds', async () => {
    let calls = 0
    const book = tasks({
      deliveryRetryMs: () => 5,
      listeners: {
        chat: async () => {
          calls++
          return false
        },
      },
    })
    await complete(book)
    await until(() => calls === 5)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(calls).toBe(5)
    expect(ledger().tasks[0]).toMatchObject({
      notification: 'failed',
      deliveryAttempts: 5,
    })
  })

  test('a channel coming up delivers at once what failed before', async () => {
    let calls = 0
    const book = tasks({
      deliveryRetryMs: () => 3_600_000,
      listeners: {
        chat: async () => {
          calls++
          return calls > 1
        },
      },
    })
    await complete(book)
    await until(() => calls === 1)
    await until(() => ledger().tasks[0]!['notification'] === 'failed')
    book.retryNotifications()
    await until(() => ledger().tasks[0]!['notification'] === 'sent')
    expect(calls).toBe(2)
    expect(chat.notes).toHaveLength(1)
  })

  test('after a restart only a failed place is tried again, never one cut off mid-send', async () => {
    const book = tasks()
    await complete(book)
    await until(() => ledger().tasks[0]!['notification'] === 'sent')
    await book.close()
    open = []
    const file = path.join(root, 'tasks.json')
    const cut = ledger()
    cut.tasks[0] = {
      ...cut.tasks[0],
      notification: 'sending',
      deliveries: { note: 'sent', chat: 'sending', mail: 'failed' },
      deliveryAttempts: 1,
    }
    fs.writeFileSync(file, JSON.stringify(cut), { mode: 0o600 })
    const sent: string[] = []
    const reopened = tasks({
      deliveryRetryMs: () => 5,
      listeners: {
        chat: async () => {
          sent.push('chat')
          return true
        },
        mail: async () => {
          sent.push('mail')
          return true
        },
      },
    })
    await until(() => sent.length === 1)
    await until(() => ledger().tasks[0]!['notification'] === 'unknown')
    expect(sent).toEqual(['mail'])
    expect(ledger().tasks[0]!['deliveries']).toMatchObject({
      note: 'sent',
      chat: 'unknown',
      mail: 'sent',
    })
    expect(chat.notes).toHaveLength(1)
    // A result from a ledger without delivery records is not sent again.
    await reopened.close()
    open = []
    const old = ledger()
    const { deliveries: _d, deliveryAttempts: _a, ...rest } = old.tasks[0]!
    old.tasks[0] = { ...rest, notification: 'failed' }
    fs.writeFileSync(file, JSON.stringify(old), { mode: 0o600 })
    const later: string[] = []
    const third = tasks({
      deliveryRetryMs: () => 5,
      listeners: {
        mail: async () => {
          later.push('mail')
          return true
        },
      },
    })
    third.retryNotifications()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(later).toEqual([])
  })

  test('a newer result that comes while an older one is still on its way goes out after it', async () => {
    const texts: string[] = []
    let release: (sent: boolean) => void = () => {}
    const book = tasks({
      deliveryRetryMs: () => 5,
      listeners: {
        chat: async event => {
          texts.push(event.text)
          // The question fails, then its second round hangs on a slow chat.
          if (texts.length === 1) return false
          if (texts.length === 2)
            return new Promise<boolean>(resolve => {
              release = resolve
            })
          return true
        },
      },
    })
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
    await until(() => texts.length === 2)
    await chat.send({ sessionId: parent, text: '下午三点' })
    value(await call(book, 'send', parent, { id, message: '下午三点' }))
    await until(() => chat.sentTo(worker).length === 2)
    value(await call(book, 'updates', worker))
    value(
      await call(book, 'report', worker, {
        summary: '已订下午三点',
        state: 'completed',
      }),
    )
    chat.reply(worker, '完成')
    await until(() => book.forSession(parent)[0]?.status === 'completed')
    release(true)
    await until(() => texts.length === 3)
    expect(texts[2]).toBe('订会议室：已完成\n\n已订下午三点')
    await until(() => ledger().tasks[0]!['notification'] === 'sent')
    expect(chat.notes.map(one => one.text)).toEqual([
      '订会议室：需要你的补充\n\n几点开始？',
      '订会议室：已完成\n\n已订下午三点',
    ])
    expect(ledger().tasks[0]).toMatchObject({
      deliveries: { note: 'sent', test: 'skipped', chat: 'sent' },
      deliveryAttempts: 1,
    })
  })

  test('delivering a result again later does not make a long-finished task recent', async () => {
    let now = 1_000_000
    let calls = 0
    const book = tasks({
      now: () => now,
      deliveryRetryMs: () => 3_600_000,
      listeners: { chat: async () => ++calls > 1 },
    })
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, { title: '周报', instructions: 'x' }),
    )
    const worker = await workerTurn(1)
    value(
      await call(book, 'report', worker, {
        summary: '写好了',
        state: 'completed',
      }),
    )
    chat.reply(worker, '完成')
    await until(() => ledger().tasks[0]!['notification'] === 'failed')
    const done = now
    // The chat comes back eleven minutes later and gets the result.
    now += 11 * 60_000
    book.retryNotifications()
    await until(() => ledger().tasks[0]!['notification'] === 'sent')
    expect(book.contextFor(parent, done)).toBeUndefined()
    expect(book.statusText(parent)).toBeUndefined()
    expect(book.forSession(parent)[0]).toMatchObject({ id, finishedAt: done })
    expect(ledger().tasks[0]).toMatchObject({ finishedAt: done })
  })
})

describe('prompts', () => {
  test('a first prompt the node never took goes out again with the rules and the context', async () => {
    class FlakyChat extends FakeChat {
      failed = false
      override async send(input: Parameters<FakeChat['send']>[0]) {
        if (input.background && !this.failed) {
          this.failed = true
          this.sent.push(input)
          return {
            ok: false as const,
            failure: { code: 'unreachable' as const, message: 'node offline' },
          }
        }
        return super.send(input)
      }
    }
    const flaky = new FlakyChat([MAIN, CODER])
    chat = flaky
    const book = tasks()
    const parent = await foreground()
    value(
      await call(book, 'start', parent, {
        title: 't',
        instructions: '要做的事',
      }),
    )
    await until(() => flaky.sent.filter(one => one.background).length >= 2)
    const second = flaky.sent.filter(one => one.background)[1]!.text
    expect(second).toContain(WORKER_INSTRUCTIONS)
    expect(second).toContain('要做的事')
    expect(second).toContain('帮我整理一下周报')
  })

  test('continuation prompts carry only what changed', async () => {
    const book = tasks()
    const parent = await foreground()
    const long = '很长的任务说明。'.repeat(200)
    value(await call(book, 'start', parent, { title: 't', instructions: long }))
    const worker = await workerTurn(1)
    value(
      await call(book, 'report', worker, {
        summary: '阶段一完成',
        state: 'working',
      }),
    )
    chat.reply(worker, 'r1')
    await until(() => chat.sentTo(worker).length === 2)
    chat.reply(worker, 'r2')
    await until(() => chat.sentTo(worker).length === 3)
    const prompts = chat.sentTo(worker).map(one => one.text)
    expect(prompts.map(one => one.includes(long))).toEqual([true, false, false])
    // The checkpoint once it changed, not again while it stays the same.
    expect(prompts.map(one => one.includes('持久检查点：阶段一完成'))).toEqual([
      false,
      true,
      false,
    ])
    expect(prompts.some(one => one.includes('核实后接着做'))).toBe(false)
    expect(prompts[2]!.length).toBeLessThan(200)
  })

  test('the rules go out again every ten turns', async () => {
    const book = tasks()
    const parent = await foreground()
    value(
      await call(book, 'start', parent, {
        title: 't',
        instructions: '长期任务说明',
      }),
    )
    const worker = await workerTurn(1)
    for (let n = 1; n <= 11; n++) {
      await until(() => chat.sentTo(worker).length === n)
      value(
        await call(book, 'report', worker, {
          summary: `第 ${n} 步`,
          state: 'working',
        }),
      )
      chat.reply(worker, `r${n}`)
    }
    await until(() => chat.sentTo(worker).length === 12)
    const briefed = chat
      .sentTo(worker)
      .map(one => one.text.includes('长期任务说明'))
    expect(briefed).toEqual([
      true,
      ...Array<boolean>(9).fill(false),
      true,
      false,
    ])
  })

  test('after the runtime compacted the worker session the next prompt briefs it again', async () => {
    const book = tasks()
    const parent = await foreground()
    value(
      await call(book, 'start', parent, {
        title: 't',
        instructions: '整理说明',
      }),
    )
    const worker = await workerTurn(1)
    for (let n = 1; n <= 3; n++) {
      await until(() => chat.sentTo(worker).length === n)
      value(
        await call(book, 'report', worker, {
          summary: `第 ${n} 步`,
          state: 'working',
        }),
      )
      chat.reply(worker, `r${n}`, 'done', n === 2 ? { compacted: true } : {})
    }
    await until(() => chat.sentTo(worker).length === 4)
    const prompts = chat.sentTo(worker).map(one => one.text)
    expect(prompts.map(one => one.includes('整理说明'))).toEqual([
      true,
      false,
      true,
      false,
    ])
    expect(prompts[2]).toContain(WORKER_INSTRUCTIONS)
    expect(prompts[2]).toContain('帮我整理一下周报')
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
    expect(prompt.startsWith(`后台任务：长任务（${id}）`)).toBe(true)
    // A restart briefs again and asks to verify what the cut turn left.
    expect(prompt).toContain(WORKER_INSTRUCTIONS)
    expect(prompt).toContain('核实后接着做')
    expect(prompt).toContain('持久检查点：做了一半')
    // The session has the main conversation's words from the first prompt.
    expect(prompt).not.toContain('帮我整理一下周报')
  })

  test('a ledger from before the briefing mark counts a worker session as briefed', async () => {
    const book = tasks()
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, { title: '旧账', instructions: 'x' }),
    )
    const worker = await workerTurn(1)
    await book.close()
    open = []
    const file = path.join(root, 'tasks.json')
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const key of [
      'briefed',
      'briefedTurn',
      'promptedProgress',
      'abnormal',
      'rebrief',
    ])
      delete ledger.tasks[0][key]
    fs.writeFileSync(file, JSON.stringify(ledger), { mode: 0o600 })
    tasks()
    await until(() => chat.sentTo(worker).length === 2)
    chat.reply(worker, '继续')
    await until(() => chat.sentTo(worker).length === 3)
    const third = chat.sentTo(worker)[2]!.text
    expect(third.startsWith(`后台任务：旧账（${id}）`)).toBe(true)
    expect(third).not.toContain(WORKER_INSTRUCTIONS)
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

  test('the task note carries unfinished tasks and those finished since the last note', async () => {
    let now = 1_000_000
    const book = tasks({ now: () => now })
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, { title: '周报', instructions: 'x' }),
    )
    const worker = await workerTurn(1)
    expect(book.contextFor(parent, now)).toContain(id)
    const before = now
    now += 1_000
    value(
      await call(book, 'report', worker, {
        summary: '好了',
        state: 'completed',
      }),
    )
    chat.reply(worker, '完成')
    await until(() => finished.length === 1)
    now += 1_000
    // Finished after the last note: once; with no note yet: among the recent.
    expect(book.contextFor(parent, before)).toContain(id)
    expect(book.contextFor(parent, now)).toBeUndefined()
    expect(book.contextFor(parent)).toContain(id)
  })

  test('finished tasks leave the ledger after 30 days or beyond 200 per owner, with their instructions', async () => {
    const book = tasks()
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, { title: '活的', instructions: 'x' }),
    )
    const worker = await workerTurn(1)
    value(await call(book, 'send', parent, { id, message: '未读的' }))
    await book.close()
    open = []
    const file = path.join(root, 'tasks.json')
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'))
    const live = ledger.tasks[0]
    const day = 24 * 60 * 60_000
    const finished = (n: number, age: number, owner = live.owner) => ({
      ...live,
      id: `task-${crypto.randomUUID()}`,
      title: `旧${n}`,
      owner,
      status: 'completed',
      notification: 'sent',
      updatedAt: Date.now() - age,
    })
    const old = finished(0, 31 * day)
    const many = Array.from({ length: 205 }, (_, n) =>
      finished(n + 1, (n + 1) * 60_000),
    )
    const other = finished(999, day, 'someone-else')
    ledger.tasks = [live, old, ...many, other]
    ledger.updates = [
      ...ledger.updates,
      { id: 90, taskId: old.id, message: 'x', at: 1, consumedAt: null },
      { id: 91, taskId: live.id, message: 'y', at: 1, consumedAt: 5 },
    ]
    fs.writeFileSync(file, JSON.stringify(ledger), { mode: 0o600 })
    tasks()
    const after = JSON.parse(fs.readFileSync(file, 'utf8'))
    const ids = new Set(after.tasks.map((task: { id: string }) => task.id))
    expect(ids.has(live.id)).toBe(true)
    expect(ids.has(old.id)).toBe(false)
    expect(ids.has(other.id)).toBe(true)
    // The newest 200 of that owner's finished tasks stay.
    expect(many.filter(task => ids.has(task.id))).toEqual(many.slice(0, 200))
    expect(
      after.updates.map((one: { message: string }) => one.message),
    ).toEqual(['未读的'])
    await until(() => chat.sentTo(worker).length === 2)
  })

  test('a task waiting for the owner holds no place among the eight', async () => {
    const book = tasks()
    const parent = await foreground()
    value(await call(book, 'start', parent, { title: 'a', instructions: 'x' }))
    await workerTurn(1)
    await book.close()
    open = []
    const file = path.join(root, 'tasks.json')
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'))
    const waiting = { ...ledger.tasks[0], status: 'needs_input' }
    ledger.tasks = Array.from({ length: 8 }, () => ({
      ...waiting,
      id: `task-${crypto.randomUUID()}`,
    }))
    fs.writeFileSync(file, JSON.stringify(ledger), { mode: 0o600 })
    const reopened = tasks()
    await chat.send({ sessionId: parent, text: '再开一个' })
    value(
      await call(reopened, 'start', parent, { title: 'b', instructions: 'y' }),
    )
  })

  test('a conversation runs at most eight unfinished tasks; the ninth is refused', async () => {
    const book = tasks()
    const parent = await foreground()
    for (let n = 1; n <= 8; n++)
      value(
        await call(book, 'start', parent, {
          title: `t${n}`,
          instructions: 'x',
        }),
      )
    const ninth = await call(book, 'start', parent, {
      title: 't9',
      instructions: 'x',
    })
    expect(ninth.ok ? '' : ninth.message).toBe('这个会话已有 8 个进行中的任务')
    expect(book.forSession(parent)).toHaveLength(8)
  })

  test('a conversation holds at most 32 tasks waiting for the owner', async () => {
    const book = tasks()
    const parent = await foreground()
    value(await call(book, 'start', parent, { title: 'a', instructions: 'x' }))
    await workerTurn(1)
    await book.close()
    open = []
    const file = path.join(root, 'tasks.json')
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'))
    const waiting = { ...ledger.tasks[0], status: 'needs_input' }
    ledger.tasks = Array.from({ length: 32 }, () => ({
      ...waiting,
      id: `task-${crypto.randomUUID()}`,
    }))
    fs.writeFileSync(file, JSON.stringify(ledger), { mode: 0o600 })
    const reopened = tasks()
    await chat.send({ sessionId: parent, text: '再开一个' })
    const refused = await call(reopened, 'start', parent, {
      title: 'b',
      instructions: 'y',
    })
    expect(refused.ok ? '' : refused.message).toBe(
      '这个会话已有 32 个等待补充的任务；请先补充或取消一些',
    )
    expect(reopened.forSession(parent)).toHaveLength(32)
  })

  test('a finished task in a ledger from before the finish time counts as finished when last changed', async () => {
    const book = tasks()
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, { title: '旧账', instructions: 'x' }),
    )
    await workerTurn(1)
    await book.close()
    open = []
    const file = path.join(root, 'tasks.json')
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'))
    const { finishedAt: _f, ...old } = ledger.tasks[0]
    const at = Date.now() - 60_000
    ledger.tasks = [
      { ...old, status: 'completed', notification: 'sent', updatedAt: at },
    ]
    fs.writeFileSync(file, JSON.stringify(ledger), { mode: 0o600 })
    const reopened = tasks()
    expect(reopened.forSession(parent)[0]).toMatchObject({
      id,
      finishedAt: at,
    })
    expect(reopened.contextFor(parent, at - 1)).toContain(id)
    expect(reopened.contextFor(parent, at)).toBeUndefined()
    expect(reopened.statusText(parent)).toBe('旧账：已完成')
  })

  test('/stop stops all of a chat’s tasks at once, not one after another', async () => {
    const THIRD = 'qianmo://node-c/third'
    chat = new FakeChat([MAIN, CODER, THIRD])
    const book = tasks({
      stopTask: async (target, taskId) => {
        await new Promise(resolve => setTimeout(resolve, 150))
        stopped.push([target, taskId])
        return true
      },
    })
    const parent = await foreground()
    for (const agent of [MAIN, CODER, THIRD])
      value(
        await call(book, 'start', parent, {
          title: agent,
          instructions: 'x',
          agent,
        }),
      )
    await until(() => workerSessions().length === 3)
    await until(
      () =>
        outstanding('node-a') +
          outstanding('node-b') +
          outstanding('node-c') ===
        3,
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    const began = Date.now()
    expect(await book.cancelForSession(parent)).toBe(3)
    expect(Date.now() - began).toBeLessThan(400)
    expect(stopped).toHaveLength(3)
  })

  test('a worker turn looks the target up in the dial list once', async () => {
    class CountingChat extends FakeChat {
      lookups = 0
      override async targets() {
        this.lookups++
        return super.targets()
      }
    }
    const counting = new CountingChat([MAIN, CODER])
    chat = counting
    const book = tasks()
    const parent = await foreground()
    value(await call(book, 'start', parent, { title: 't', instructions: 'x' }))
    const worker = await workerTurn(1)
    const first = counting.lookups
    value(
      await call(book, 'report', worker, { summary: '一', state: 'working' }),
    )
    chat.reply(worker, 'r1')
    await until(() => chat.sentTo(worker).length === 2)
    expect(counting.lookups - first).toBe(1)
  })
})

describe('the console list', () => {
  test('the owner sees a task and ops sees every one; cancel is the conversation’s cancel', async () => {
    const book = tasks()
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, { title: '周报', instructions: 'x' }),
    )
    const worker = await workerTurn(1)
    const owner = { subject: 'legacy:admin', role: null }
    const stranger = { subject: 'u:someone', role: 'member' as const }
    const ops = { subject: 'u:ops', role: 'ops' as const }
    expect(book.list(owner).map(task => task.id)).toEqual([id])
    expect(book.list(owner)[0]).toMatchObject({
      title: '周报',
      owner: 'legacy:admin',
      target: MAIN,
      status: 'running',
      workerSession: worker,
    })
    expect(book.list(stranger)).toEqual([])
    expect(book.list(ops)).toHaveLength(1)
    expect(book.visible(id, stranger)).toBe(false)
    expect(book.visible(id, ops)).toBe(true)
    const denied = await book.cancel(id, { ...stranger, requestId: 'r' })
    expect(denied.ok ? '' : denied.failure.code).toBe('not_found')
    expect(stopped).toEqual([])
    const done = await book.cancel(id, { ...ops, requestId: 'r' })
    expect(done.ok && done.value.status).toBe('cancelled')
    expect(stopped).toEqual([[MAIN, chat.lastTask(worker)]])
    const again = await book.cancel(id, { ...ops, requestId: 'r' })
    expect(again.ok ? '' : again.failure.code).toBe('rejected')
  })

  test('a member who started a task sees and cancels it; another member does neither', async () => {
    const h = accountsHarness()
    const member = async () => {
      const principal = h.book.bearerPrincipal(
        (await person(h.handle)).credential,
      )
      if (!principal.ok || principal.value.kind !== 'user')
        throw new Error('fixture account unavailable')
      return principal.value.subject
    }
    const alice = await member()
    const bob = await member()
    const book = tasks({ accounts: { book: h.book } })
    const parent = await foreground()
    expect(h.book.recordOwner(parent, alice).ok).toBe(true)
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, { title: '周报', instructions: 'x' }),
    )
    // The worker turns go out as her, too.
    const worker = await workerTurn(1)
    expect(h.book.ownerOf(worker)).toBe(alice)
    const owner = { subject: alice, role: 'member' as const }
    const other = { subject: bob, role: 'member' as const }
    expect(book.list(owner).map(task => task.id)).toEqual([id])
    expect(book.list(owner)[0]).toMatchObject({
      owner: alice,
      status: 'running',
      workerSession: worker,
    })
    expect(book.visible(id, owner)).toBe(true)
    expect(book.list(other)).toEqual([])
    expect(book.visible(id, other)).toBe(false)
    const denied = await book.cancel(id, { ...other, requestId: 'r' })
    expect(denied.ok ? '' : denied.failure.code).toBe('not_found')
    expect(stopped).toEqual([])
    expect(book.list(owner)[0]?.status).toBe('running')
    const done = await book.cancel(id, { ...owner, requestId: 'r' })
    expect(done.ok && done.value.status).toBe('cancelled')
    expect(stopped).toEqual([[MAIN, chat.lastTask(worker)]])
  })
})

describe('races and leftovers', () => {
  test('a cancel while the next turn is being authorised stays cancelled and sends nothing', async () => {
    class GatedChat extends FakeChat {
      calls = 0
      release: () => void = () => {}
      readonly gate = new Promise<void>(resolve => {
        this.release = resolve
      })
      override async targets() {
        this.calls++
        if (this.calls === 2) await this.gate
        return super.targets()
      }
    }
    const gated = new GatedChat([MAIN, CODER])
    chat = gated
    const book = tasks()
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, { title: 't', instructions: 'i' }),
    )
    await until(() => gated.calls === 2)
    const cancelled = value<{ task: { status: string } }>(
      await call(book, 'cancel', parent, { id }),
    )
    expect(cancelled.task.status).toBe('cancelled')
    gated.release()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(book.forSession(parent)[0]?.status).toBe('cancelled')
    expect(workerSessions()).toEqual([])
  })

  test('a cancel while the line is on its way stops the node turn once it has a task id', async () => {
    class SlowChat extends FakeChat {
      release: () => void = () => {}
      readonly gate = new Promise<void>(resolve => {
        this.release = resolve
      })
      override async send(input: Parameters<FakeChat['send']>[0]) {
        if (input.background) await this.gate
        return super.send(input)
      }
    }
    const slow = new SlowChat([MAIN, CODER])
    chat = slow
    const book = tasks()
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, { title: 't', instructions: 'i' }),
    )
    await until(() => slow.sent.length === 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    value(await call(book, 'cancel', parent, { id }))
    expect(stopped).toEqual([])
    slow.release()
    await until(() => stopped.length === 1)
    const worker = workerSessions()[0]!
    expect(stopped).toEqual([[MAIN, slow.lastTask(worker)]])
  })

  test('an added instruction wakes a task out of its failure backoff', async () => {
    const book = new ConsoleTasks({
      directory: root,
      chat,
      backoffMs: () => 60_000,
    })
    open.push(book)
    book.start()
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, { title: 't', instructions: 'i' }),
    )
    const worker = await workerTurn(1)
    chat.reply(worker, '模型服务不可用', 'failed')
    await new Promise(resolve => setTimeout(resolve, 20))
    await chat.send({ sessionId: parent, text: '补一句' })
    const sentAt = Date.now()
    value(await call(book, 'send', parent, { id, message: '附上图表' }))
    await until(() => chat.sentTo(worker).length === 2)
    expect(Date.now() - sentAt).toBeLessThan(1_000)
  })

  test('a turn a restart left on the node is stopped before the next one goes out', async () => {
    const book = tasks()
    const parent = await foreground()
    value(await call(book, 'start', parent, { title: 't', instructions: 'i' }))
    const worker = await workerTurn(1)
    const leftover = chat.lastTask(worker)
    await until(
      () =>
        JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8'))
          .tasks[0].nodeTaskId === leftover,
    )
    await book.close()
    open = []
    expect(stopped).toEqual([])
    tasks()
    await until(() => chat.sentTo(worker).length === 2)
    expect(stopped).toEqual([[MAIN, leftover]])
    // Answered by the node: nothing left over any more.
    chat.reply(worker, '接着做')
    await until(() => chat.sentTo(worker).length === 3)
    expect(stopped).toHaveLength(1)
  })

  test('a cancel while a leftover turn is being stopped stays cancelled and starts no new turn', async () => {
    const book = tasks()
    const parent = await foreground()
    value(await call(book, 'start', parent, { title: 't', instructions: 'i' }))
    const worker = await workerTurn(1)
    const leftover = chat.lastTask(worker)
    await until(
      () =>
        JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8'))
          .tasks[0].nodeTaskId === leftover,
    )
    await book.close()
    open = []
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    // A node can take seconds to stop a turn.
    const reopened = tasks({
      stopTask: async (target, taskId) => {
        stopped.push([target, taskId])
        await gate
        return true
      },
    })
    await until(() => stopped.length === 1)
    const cancelling = reopened.cancelForSession(parent)
    expect(reopened.forSession(parent)[0]?.status).toBe('cancelled')
    release()
    expect(await cancelling).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(reopened.forSession(parent)[0]?.status).toBe('cancelled')
    expect(chat.sentTo(worker)).toHaveLength(1)
  })

  test('a refusal retrying cannot fix pauses the task at once, with the reason', async () => {
    class LeavingChat extends FakeChat {
      gone = false
      override async targets() {
        const listed = await super.targets()
        return this.gone
          ? {
              ok: true as const,
              value: listed.value.map(row => ({
                ...row,
                dialable: row.address !== MAIN,
              })),
            }
          : listed
      }
    }
    const leaving = new LeavingChat([MAIN, CODER])
    chat = leaving
    const book = tasks()
    const parent = await foreground()
    value(
      await call(book, 'start', parent, { title: '周报', instructions: 'i' }),
    )
    const worker = await workerTurn(1)
    leaving.gone = true
    chat.reply(worker, '阶段一')
    await until(() => finished.length === 1)
    expect(finished[0]!.text).toContain('目标已不在对话可拨允许名单内')
    expect(book.forSession(parent)[0]?.status).toBe('needs_input')
    expect(chat.sentTo(worker)).toHaveLength(1)
  })
})
