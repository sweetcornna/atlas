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
import type {
  ConsoleAccounts,
  TenantPort,
  TenantSnapshot,
} from '@qianmo/console'
import type { ControlOutcome } from '@qianmo/protocol'
import {
  accountsHarness,
  person,
} from '../../../console/test/accountsHarness.js'
import {
  AgentProfiles,
  type AgentProfile,
  ConsoleTasks,
  SUPERVISOR_RULES,
  type TaskFinished,
  WORKER_INSTRUCTIONS,
  withTaskNotes,
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
    deliveryTimeoutMs?: number
    onError?: (message: string) => void
    stopTask?: (target: string, taskId: string) => Promise<boolean>
    steerTask?: (target: string, taskId: string, text: string) => Promise<boolean>
    workersPerNode?: number
    nodeTurns?: (node: string) => Promise<number | undefined>
    reportDelayMs?: number
    reportRetryMs?: (attempts: number) => number
    now?: () => number
    scheduled?: (id: string) => boolean
    accounts?: ConsoleAccounts
    tenancy?: TenantPort
    profile?: (address: string) => Promise<AgentProfile>
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

  test('one worker turn per node (--task-workers 1): tasks on a node take turns, the slot is handed over, another node runs alongside', async () => {
    const book = tasks({ workersPerNode: 1 })
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

  test('starts made in parallel in one turn cannot pass the eight or the twenty', async () => {
    const now = Date.UTC(2026, 9, 17, 1, 0)
    const book = tasks({ now: () => now })
    const parent = await foreground()
    for (let n = 0; n < 7; n++)
      value(
        await call(book, 'start', parent, {
          title: `n${n}`,
          instructions: 'x',
        }),
      )
    const eighth = await Promise.all(
      [0, 1, 2].map(n =>
        call(book, 'start', parent, { title: `并行 ${n}`, instructions: 'x' }),
      ),
    )
    expect(eighth.filter(one => one.ok)).toHaveLength(1)
    expect(
      eighth.filter(one => !one.ok).map(one => (one.ok ? '' : one.message)),
    ).toEqual([
      '这个会话已有 8 个进行中的任务',
      '这个会话已有 8 个进行中的任务',
    ])
    for (let n = 0; n < 19; n++)
      value(
        await call(book, 'start', parent, {
          title: `安排 ${n}`,
          instructions: 'x',
          after: 60 + n,
        }),
      )
    const twentieth = await Promise.all(
      [0, 1, 2, 3, 4].map(n =>
        call(book, 'start', parent, {
          title: `并行安排 ${n}`,
          instructions: 'x',
          after: 120 + n,
        }),
      ),
    )
    expect(twentieth.filter(one => one.ok)).toHaveLength(1)
    expect(
      book.forSession(parent).filter(task => task.status === 'scheduled'),
    ).toHaveLength(20)
  })
})

describe('the agent list (qianmo_task_agents)', () => {
  const THIRD = 'qianmo://node-c/third'

  type Row = {
    address: string
    name: string
    self: boolean
    idle: boolean
    turns: number
    queued: number
    running: number
    runtime?: string
    model?: string
  }

  test('dialable agents only, with the caller marked, runtime and model where known, and how busy each node is', async () => {
    chat = new FakeChat([MAIN, CODER, THIRD])
    chat.undialable.add(THIRD)
    const book = tasks({
      profile: async address =>
        address === CODER
          ? { runtime: 'codex', model: 'gpt-6-luna' }
          : address === MAIN
            ? { runtime: 'qianmopi' }
            : {},
    })
    const parent = await foreground()
    // Nothing else is running: the caller's own turn does not make it busy.
    const quiet = value<{ agents: Row[] }>(await call(book, 'agents', parent))
    expect(quiet.agents.map(row => row.address)).toEqual([MAIN, CODER])
    expect(quiet.agents[0]).toEqual({
      address: MAIN,
      name: 'main',
      status: 'online',
      self: true,
      runtime: 'qianmopi',
      idle: true,
      turns: 0,
      queued: 0,
      running: 0,
    } as Row)
    expect(quiet.agents[1]).toMatchObject({
      self: false,
      runtime: 'codex',
      model: 'gpt-6-luna',
      idle: true,
    })
    // Another conversation waits on main; a task runs on coder.
    await foreground(MAIN)
    value(
      await call(book, 'start', parent, {
        title: '编码',
        instructions: 'x',
        agent: CODER,
      }),
    )
    const worker = await workerTurn(1)
    const busy = value<{ agents: Row[] }>(await call(book, 'agents', parent))
    expect(busy.agents[0]).toMatchObject({ turns: 1, idle: false })
    // The worker's own session is a task, not a conversation turn.
    expect(busy.agents[1]).toMatchObject({
      turns: 0,
      running: 1,
      queued: 0,
      idle: false,
    })
    // A worker may not ask.
    const nested = await call(book, 'agents', worker, {}, 'coder', 'node-b')
    expect(nested.ok ? '' : nested.message).toBe(
      '后台子任务不能再开或管理其他任务',
    )
  })

  test("the owner's tenant decides who is listed, as for qianmo_task_start", async () => {
    const subject = 'u:alice'
    let state = 'active'
    const accounts = {
      book: {
        ownerOf: () => subject,
        list: () => ({
          ok: true,
          value: {
            accounts: [{ subject, state, role: 'member' }],
          },
        }),
      },
      breakGlass: false,
    } as unknown as ConsoleAccounts
    const snapshot: TenantSnapshot = {
      revision: 'r1',
      config: {
        version: 1,
        hubServer: 'hub',
        tenants: [{ id: 'a' }],
        subjects: [{ subject, tenant: 'a' }],
        nodes: [
          {
            nodeId: 'node-a',
            tenant: 'a',
            server: 'server-a',
            memoryRoot: path.join(root, 'a'),
          },
        ],
        jobs: [],
        platformSubjects: [],
      },
    }
    const tenancy: TenantPort = {
      read: () => snapshot,
      subscribe: () => () => {},
    }
    const book = tasks({ accounts, tenancy })
    const parent = await foreground()
    const listed = value<{ agents: Row[] }>(await call(book, 'agents', parent))
    expect(listed.agents.map(row => row.address)).toEqual([MAIN])
    const refused = await call(book, 'start', parent, {
      title: 't',
      instructions: 'i',
      agent: CODER,
    })
    expect(refused.ok).toBe(false)
    // The owner's account is gone: nobody is listed.
    state = 'disabled'
    const gone = await call(book, 'agents', parent)
    expect(gone.ok ? '' : gone.message).toBe('任务主人的账号已不可用')
  })

  test('AgentProfiles: each node says its runtimes; a qianmopi agent runs the node model; nothing is guessed', async () => {
    let now = 1_000_000
    const pings: string[] = []
    let answer: ControlOutcome = {
      ok: true,
      value: {
        node: 'node-a',
        agents: ['main', 'coder', 'reviewer'],
        runtimes: { main: 'omp', coder: 'codex', reviewer: 'claude-code' },
        models: { coder: 'gpt-6-luna' },
      },
    }
    const profiles = new AgentProfiles({
      ping: async node => {
        pings.push(node)
        return answer
      },
      nodeModel: async node => (node === 'node-a' ? 'claude-opus' : undefined),
      now: () => now,
    })
    expect(await profiles.of('qianmo://node-a/main')).toEqual({
      runtime: 'qianmopi',
      model: 'claude-opus',
    })
    expect(await profiles.of('qianmo://node-a/coder')).toEqual({
      runtime: 'codex',
      model: 'gpt-6-luna',
    })
    expect(await profiles.of('qianmo://node-a/reviewer')).toEqual({
      runtime: 'claude-code',
    })
    expect(await profiles.of('qianmo://node-a/unknown')).toEqual({})
    // One answer per node for five minutes.
    expect(pings).toEqual(['node-a'])
    // A node that does not answer, or an older one, gives nothing.
    answer = { ok: false, code: 'unreachable', message: 'down' }
    expect(await profiles.of('qianmo://node-b/main')).toEqual({})
    answer = { ok: true, value: { node: 'node-c', agents: ['main'] } }
    expect(await profiles.of('qianmo://node-c/main')).toEqual({})
    expect(await profiles.of('not-an-address')).toEqual({})
    // A failed node is asked again after a minute; a known one after five.
    now += 61_000
    answer = {
      ok: true,
      value: { runtimes: { main: 'omp' }, models: {} },
    }
    expect(await profiles.of('qianmo://node-b/main')).toEqual({
      runtime: 'qianmopi',
    })
    expect(pings.filter(node => node === 'node-a')).toHaveLength(1)
    now += 5 * 60_000
    await profiles.of('qianmo://node-a/main')
    expect(pings.filter(node => node === 'node-a')).toHaveLength(2)
  })
})

describe('planned tasks (主动任务)', () => {
  const MINUTE = 60_000

  function ledger(): {
    tasks: Record<string, unknown>[]
    scheduled: Record<string, unknown>[]
  } {
    return JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8'))
  }

  /** The worker reports its run done and ends the turn. */
  async function finishRun(
    book: ConsoleTasks,
    worker: string,
    summary: string,
  ): Promise<void> {
    value(await call(book, 'report', worker, { summary, state: 'completed' }))
    chat.reply(worker, '完成')
  }

  test('a delayed task waits as scheduled and starts only when due', async () => {
    let now = Date.UTC(2026, 9, 17, 1, 0)
    const book = tasks({ now: () => now })
    const parent = await foreground()
    const started = value<{ id: string; status: string; nextAt: string }>(
      await call(book, 'start', parent, {
        title: '回看',
        instructions: '看一下构建结果',
        after: 30,
      }),
    )
    expect(started).toMatchObject({
      status: 'scheduled',
      nextAt: new Date(now + 30 * MINUTE).toISOString(),
    })
    expect(book.forSession(parent)[0]!.phase).toStartWith('已安排 · 下次 ')
    now += 29 * MINUTE
    book.tick()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(workerSessions()).toEqual([])
    now += 2 * MINUTE
    book.tick()
    const worker = await workerTurn(1)
    expect(book.forSession(parent)[0]!.status).toBe('running')
    await finishRun(book, worker, '构建通过')
    await until(() => finished.length === 1)
    expect(finished[0]!.text).toBe('回看：已完成\n\n构建通过')
    expect(book.forSession(parent)[0]!.status).toBe('completed')
  })

  test('the arguments: one of after and at, at with its zone within a week, repeats with times', async () => {
    const now = Date.UTC(2026, 9, 17, 1, 0)
    const book = tasks({ now: () => now })
    const parent = await foreground()
    const refusal = async (args: Record<string, unknown>) => {
      const outcome = await call(book, 'start', parent, {
        title: 't',
        instructions: 'i',
        ...args,
      })
      return outcome.ok ? 'ok' : outcome.message
    }
    expect(await refusal({ after: 5, at: '2026-10-17T10:00:00+08:00' })).toBe(
      'after 和 at 只能给一个',
    )
    expect(await refusal({ after: -1 })).toBe('after 是 1–10080 分钟')
    expect(await refusal({ after: 10_081 })).toBe('after 是 1–10080 分钟')
    expect(await refusal({ after: 1.5 })).toBe(
      'after、everyMinutes、times 要是整数',
    )
    expect(await refusal({ at: '2026-10-17T10:00:00' })).toBe(
      'at 要是带时区的 ISO 时间，例如 2026-10-18T09:00:00+08:00',
    )
    expect(await refusal({ at: '2026-10-17T08:59:00+08:00' })).toBe(
      'at 要晚于现在',
    )
    expect(await refusal({ at: '2026-10-25T09:00:00+08:00' })).toBe(
      'at 至多 7 天后',
    )
    expect(await refusal({ everyMinutes: 29, times: 2 })).toBe(
      'everyMinutes 是 30–10080 分钟',
    )
    expect(await refusal({ everyMinutes: 60 })).toBe(
      '重复任务要给 times（1–100 次）',
    )
    expect(await refusal({ everyMinutes: 60, times: 101 })).toBe(
      'times 是 1–100 次',
    )
    expect(await refusal({ everyMinutes: -60, times: 2 })).toBe(
      'everyMinutes 是 30–10080 分钟',
    )
    expect(await refusal({ everyMinutes: 60, times: -1 })).toBe(
      'times 是 1–100 次',
    )
    expect(await refusal({ times: 3 })).toBe('times 要和 everyMinutes 一起给')
    expect(await refusal({ times: -1 })).toBe('times 是 1–100 次')
    // Optional arguments a model left empty are not given.
    expect(
      book.forSession(parent).filter(task => task.status === 'scheduled'),
    ).toHaveLength(0)
    const empty = value<{ status: string }>(
      await call(book, 'start', parent, {
        title: 't',
        instructions: 'i',
        at: '',
        after: null,
      }),
    )
    expect(empty.status).toBe('queued')
    // Digits a model sent as text are taken; an at with its zone is too.
    expect(await refusal({ after: '15' })).toBe('ok')
    const at = value<{ nextAt: string }>(
      await call(book, 'start', parent, {
        title: 't',
        instructions: 'i',
        at: '2026-10-17T10:30:00+08:00',
      }),
    )
    expect(at.nextAt).toBe('2026-10-17T02:30:00.000Z')
  })

  test('0 and empty strings are not given: all of them is a task that starts now, once', async () => {
    const now = Date.UTC(2026, 9, 17, 1, 0)
    const book = tasks({ now: () => now })
    const parent = await foreground()
    let last = ''
    const start = async (args: Record<string, unknown>) => {
      const outcome = await call(book, 'start', parent, {
        title: 't',
        instructions: 'i',
        ...args,
      })
      if (!outcome.ok) return outcome
      last = (outcome.value as { id: string }).id
      return outcome.value as Record<string, unknown>
    }
    /** The plan the ledger keeps for the task started last. */
    const plan = () => {
      const { tasks, scheduled } = ledger()
      return (
        [...tasks, ...scheduled].find(task => task['id'] === last) as {
          plan: Record<string, unknown> | null
        }
      ).plan
    }
    // What gpt-6-luna sent for a task it meant to start at once.
    const zeros = { agent: '', after: 0, at: '', everyMinutes: 0, times: 0 }
    const immediate = await start(zeros)
    expect(immediate).toMatchObject({ status: 'queued', target: MAIN })
    expect(immediate).not.toContainAnyKeys([
      'nextAt',
      'everyMinutes',
      'runsLeft',
    ])
    expect(plan()).toBeNull()
    // The same as text, and with null.
    expect(
      await start({ after: '0', everyMinutes: '0', times: '0', agent: null }),
    ).toMatchObject({ status: 'queued' })
    expect(plan()).toBeNull()
    // Only after given: one run, later.
    expect(await start({ ...zeros, after: 30 })).toMatchObject({
      status: 'scheduled',
      nextAt: new Date(now + 30 * 60_000).toISOString(),
    })
    expect(plan()).toMatchObject({ everyMinutes: null, times: 1, runs: 0 })
    // Only a repeat given: the first run starts now.
    expect(await start({ ...zeros, everyMinutes: 60, times: 3 })).toMatchObject(
      { status: 'queued', everyMinutes: 60, runsLeft: 2 },
    )
    // No repeat and times 1 is one run; more than one needs everyMinutes.
    expect(await start({ ...zeros, times: 1 })).toMatchObject({
      status: 'queued',
    })
    expect(plan()).toBeNull()
    expect(await start({ ...zeros, after: 30, times: 1 })).toMatchObject({
      status: 'scheduled',
    })
    expect(plan()).toMatchObject({ everyMinutes: null, times: 1 })
    expect(await start({ ...zeros, times: 3 })).toMatchObject({
      ok: false,
      message: 'times 要和 everyMinutes 一起给',
    })
    // A repeat without times is still refused, 0 or not.
    expect(await start({ ...zeros, everyMinutes: 60 })).toMatchObject({
      ok: false,
      message: '重复任务要给 times（1–100 次）',
    })
  })

  test('an at naming a day or time that does not exist is refused, not moved to the next day', async () => {
    let now = Date.UTC(2026, 10, 28, 1, 0)
    const book = tasks({ now: () => now })
    const parent = await foreground()
    const start = async (at: string) => {
      const outcome = await call(book, 'start', parent, {
        title: 't',
        instructions: 'i',
        at,
      })
      return outcome.ok
        ? (outcome.value as { nextAt: string }).nextAt
        : outcome.message
    }
    for (const at of [
      '2026-11-31T09:00:00+08:00',
      '2026-11-29T24:00:00+08:00',
      '2026-11-29T25:00+08:00',
      '2026-11-29T09:00:60Z',
      '2026-11-29T09:00:00+08:60',
    ])
      expect(await start(at)).toBe(
        `at 的日期或时刻不存在：${at}；请核对当月天数与 00:00–23:59 的时刻`,
      )
    // The day and time are read in the zone given, wherever that falls in UTC.
    expect(await start('2026-11-29T00:30:00+08:00')).toBe(
      '2026-11-28T16:30:00.000Z',
    )
    expect(await start('2026-11-28T23:30:00-05:00')).toBe(
      '2026-11-29T04:30:00.000Z',
    )
    expect(await start('2026-11-28T09:00:00.5Z')).toBe(
      '2026-11-28T09:00:00.500Z',
    )
    now = Date.UTC(2026, 1, 27, 1, 0)
    expect(await start('2026-02-30T09:00+08:00')).toBe(
      'at 的日期或时刻不存在：2026-02-30T09:00+08:00；请核对当月天数与 00:00–23:59 的时刻',
    )
    now = Date.UTC(2028, 1, 27, 1, 0)
    expect(await start('2028-02-29T09:00+08:00')).toBe(
      '2028-02-29T01:00:00.000Z',
    )
  })

  test('a repeat runs in the same sub-session and goes back to scheduled until its times are used; times a run outlasted are skipped', async () => {
    let now = Date.UTC(2026, 9, 17, 1, 0)
    const anchor = now
    const book = tasks({ now: () => now })
    const parent = await foreground()
    const started = value<{ status: string; runsLeft: number }>(
      await call(book, 'start', parent, {
        title: '巡检',
        instructions: '检查三台机器的磁盘',
        everyMinutes: 60,
        times: 3,
      }),
    )
    // No later start: the first run starts now.
    expect(started).toMatchObject({ status: 'queued', runsLeft: 2 })
    const worker = await workerTurn(1)
    expect(chat.sentTo(worker)[0]!.text).toContain(
      '这是重复任务的第 1 次运行（共 3 次，每 60 分钟一次）',
    )
    now += 5 * MINUTE
    await finishRun(book, worker, '磁盘都在 60% 以下')
    await until(() => finished.length === 1)
    expect(book.forSession(parent)[0]).toMatchObject({
      status: 'scheduled',
      nextAt: new Date(anchor + 60 * MINUTE).toISOString(),
      runsLeft: 2,
    })
    expect(finished[0]!.text).toStartWith('巡检：第 1/3 次已完成 · 下次 ')
    now = anchor + 61 * MINUTE
    book.tick()
    await until(() => chat.sentTo(worker).length === 2)
    const second = chat.sentTo(worker)[1]!.text
    expect(second).toContain(WORKER_INSTRUCTIONS)
    expect(second).toContain('这是重复任务的第 2 次运行')
    expect(second).toContain('上一次的结果在检查点里')
    expect(second).toContain('持久检查点：磁盘都在 60% 以下')
    expect(workerSessions()).toEqual([worker])
    // This run lasts past 2:00 and 3:00: the next start is 4:00.
    now = anchor + 190 * MINUTE
    await finishRun(book, worker, '第二次也正常')
    await until(() => finished.length === 2)
    expect(book.forSession(parent)[0]!.nextAt).toBe(
      new Date(anchor + 240 * MINUTE).toISOString(),
    )
    now = anchor + 241 * MINUTE
    book.tick()
    await until(() => chat.sentTo(worker).length === 3)
    await finishRun(book, worker, '第三次正常')
    await until(() => finished.length === 3)
    expect(finished[2]!.text).toBe(
      '巡检：第 3/3 次已完成 · 全部完成\n\n第三次正常',
    )
    expect(book.forSession(parent)[0]!.status).toBe('completed')
    now += 2 * 60 * MINUTE
    book.tick()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(chat.sentTo(worker)).toHaveLength(3)
  })

  test('a cancel takes effect at once and a cancelled plan never runs', async () => {
    let now = Date.UTC(2026, 9, 17, 1, 0)
    const book = tasks({ now: () => now })
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, {
        title: '回看',
        instructions: 'x',
        after: 10,
      }),
    )
    const cancelled = value<{ task: { status: string } }>(
      await call(book, 'cancel', parent, { id }),
    )
    expect(cancelled.task.status).toBe('cancelled')
    now += 20 * MINUTE
    book.tick()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(workerSessions()).toEqual([])
    expect(book.forSession(parent)[0]!.status).toBe('cancelled')
  })

  test('a restart resumes the plans from the ledger; times missed while the hub was down run once', async () => {
    let now = Date.UTC(2026, 9, 17, 1, 0)
    const anchor = now + 30 * MINUTE
    const book = tasks({ now: () => now })
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, {
        title: '巡检',
        instructions: 'x',
        after: 30,
        everyMinutes: 30,
        times: 5,
      }),
    )
    await book.close()
    open = []
    // Waiting plans are kept apart, so an older hub ignores them.
    expect(ledger().tasks).toEqual([])
    expect(ledger().scheduled[0]).toMatchObject({ id, status: 'scheduled' })
    // Down for three hours: six starts missed.
    now = anchor + 180 * MINUTE + 5 * MINUTE
    const reopened = tasks({ now: () => now })
    const worker = await workerTurn(1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(workerSessions()).toEqual([worker])
    expect(reopened.forSession(parent)[0]).toMatchObject({
      status: 'running',
      runsLeft: 4,
    })
    await finishRun(reopened, worker, '补跑一次')
    await until(() => finished.length === 1)
    expect(reopened.forSession(parent)[0]).toMatchObject({
      status: 'scheduled',
      nextAt: new Date(anchor + 210 * MINUTE).toISOString(),
      runsLeft: 4,
    })
    reopened.tick()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(chat.sentTo(worker)).toHaveLength(1)
  })

  test('at most twenty planned per owner; planned ones hold no place among the eight', async () => {
    const now = Date.UTC(2026, 9, 17, 1, 0)
    const book = tasks({ now: () => now })
    const parent = await foreground()
    for (let n = 0; n < 20; n++)
      value(
        await call(book, 'start', parent, {
          title: `安排 ${n}`,
          instructions: 'x',
          after: 60 + n,
        }),
      )
    const over = await call(book, 'start', parent, {
      title: '多一个',
      instructions: 'x',
      everyMinutes: 60,
      times: 2,
    })
    expect(over.ok ? '' : over.message).toBe(
      '已有 20 个安排好的任务，最多 20 个；先取消不需要的',
    )
    // A task that runs once, now, is not planned and still has its place.
    value(
      await call(book, 'start', parent, { title: '现在', instructions: 'y' }),
    )
    expect(
      book.forSession(parent).filter(task => task.status === 'scheduled'),
    ).toHaveLength(20)
  })

  test('a due plan waits for a place when its conversation already has eight in flight, and says so', async () => {
    let now = Date.UTC(2026, 9, 17, 1, 0)
    const book = tasks({ now: () => now })
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, {
        title: '回看',
        instructions: 'x',
        after: 1,
        everyMinutes: 60,
        times: 2,
      }),
    )
    const running: string[] = []
    for (let n = 0; n < 8; n++)
      running.push(
        value<{ id: string }>(
          await call(book, 'start', parent, {
            title: `n${n}`,
            instructions: 'x',
          }),
        ).id,
      )
    now += 2 * MINUTE
    book.tick()
    await new Promise(resolve => setTimeout(resolve, 20))
    const waiting = () => book.forSession(parent).find(task => task.id === id)!
    expect(waiting()).toMatchObject({
      status: 'scheduled',
      phase: '已安排 · 等名额 · 剩 2 次',
      waitingForPlace: true,
    })
    expect(book.contextFor(parent)).toContain('"waitingForPlace":true')
    expect(
      book
        .list({ subject: 'legacy:admin', role: null })
        .find(task => task.id === id),
    ).toMatchObject({ status: 'scheduled', phase: '已安排 · 等名额' })
    expect(
      book
        .forSession(parent)
        .filter(task => task.status === 'queued' || task.status === 'running'),
    ).toHaveLength(8)
    // A place frees up: the next look starts it.
    value(await call(book, 'cancel', parent, { id: running[7]! }))
    book.tick()
    expect(waiting().status).toBe('queued')
    expect(waiting().waitingForPlace).toBeUndefined()
  })

  test('a worker and a schedule’s session cannot plan; /stop leaves planned tasks; an instruction waits for the run', async () => {
    let now = Date.UTC(2026, 9, 17, 1, 0)
    const scheduledSession = await foreground()
    const book = tasks({
      now: () => now,
      scheduled: id => id === scheduledSession,
    })
    const fromSchedule = await call(book, 'start', scheduledSession, {
      title: 't',
      instructions: 'i',
      after: 5,
    })
    expect(fromSchedule.ok).toBe(false)
    const parent = await foreground()
    value(
      await call(book, 'start', parent, { title: '现在', instructions: 'y' }),
    )
    const worker = await workerTurn(1)
    const nested = await call(book, 'start', worker, {
      title: 't',
      instructions: 'i',
      after: 5,
    })
    expect(nested.ok ? '' : nested.message).toBe(
      '后台子任务不能再开或管理其他任务',
    )
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, {
        title: '回看',
        instructions: 'x',
        after: 10,
      }),
    )
    value(await call(book, 'send', parent, { id, message: '顺便看日志' }))
    expect(book.forSession(parent).find(task => task.id === id)!.status).toBe(
      'scheduled',
    )
    // /stop stops what runs; the plan stays.
    expect(await book.cancelForSession(parent)).toBe(1)
    expect(book.forSession(parent).find(task => task.id === id)!.status).toBe(
      'scheduled',
    )
    now += 11 * MINUTE
    book.tick()
    await until(() => workerSessions().length === 2)
    const planned = workerSessions()[1]!
    await until(() => chat.sentTo(planned).length === 1)
    expect(chat.sentTo(planned)[0]!.text).toContain('有 1 条尚未确认的用户补充')
  })

  test('/stop during a repeat’s run stops that run only and the later runs go on; on the last run it cancels', async () => {
    let now = Date.UTC(2026, 9, 17, 1, 0)
    const anchor = now
    const book = tasks({ now: () => now })
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, {
        title: '巡检',
        instructions: 'x',
        everyMinutes: 60,
        times: 3,
      }),
    )
    const worker = await workerTurn(1)
    const first = chat.lastTask(worker)
    await until(() => book.forSession(parent)[0]?.status === 'running')
    await new Promise(resolve => setTimeout(resolve, 20))
    now += 10 * MINUTE
    expect(await book.cancelForSession(parent)).toBe(1)
    expect(stopped).toEqual([[MAIN, first]])
    expect(book.forSession(parent)[0]).toMatchObject({
      id,
      status: 'scheduled',
      nextAt: new Date(anchor + 60 * MINUTE).toISOString(),
      runsLeft: 2,
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(book.forSession(parent)[0]!.status).toBe('scheduled')
    // A stopped run reports nothing.
    expect(finished).toEqual([])
    now = anchor + 61 * MINUTE
    book.tick()
    await until(() => chat.sentTo(worker).length === 2)
    expect(chat.sentTo(worker)[1]!.text).toContain('这是重复任务的第 2 次运行')
    // The stopped turn is not stopped twice.
    expect(stopped).toEqual([[MAIN, first]])
    await finishRun(book, worker, '第二次正常')
    await until(() => finished.length === 1)
    now = anchor + 121 * MINUTE
    book.tick()
    await until(() => chat.sentTo(worker).length === 3)
    await until(() => book.forSession(parent)[0]?.status === 'running')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await book.cancelForSession(parent)).toBe(1)
    expect(book.forSession(parent)[0]).toMatchObject({ status: 'cancelled' })
  })

  test('the run after /stop cut short a resumed run before the node took it is a new run, not a resume', async () => {
    class GatedChat extends FakeChat {
      gated = false
      release: () => void = () => {}
      readonly gate = new Promise<void>(resolve => {
        this.release = resolve
      })
      override async send(input: Parameters<FakeChat['send']>[0]) {
        if (input.background && this.gated) await this.gate
        return super.send(input)
      }
    }
    const gated = new GatedChat([MAIN, CODER])
    chat = gated
    let now = Date.UTC(2026, 9, 17, 1, 0)
    const anchor = now
    const book = tasks({ now: () => now })
    const parent = await foreground()
    value(
      await call(book, 'start', parent, {
        title: '巡检',
        instructions: 'x',
        everyMinutes: 60,
        times: 3,
      }),
    )
    const worker = await workerTurn(1)
    await book.close()
    open = []
    // After the restart the run resumes; its line waits at the gate.
    gated.gated = true
    const reopened = tasks({ now: () => now })
    await until(() => reopened.forSession(parent)[0]?.status === 'running')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await reopened.cancelForSession(parent)).toBe(1)
    gated.release()
    await until(() => chat.sentTo(worker).length === 2)
    now = anchor + 61 * MINUTE
    reopened.tick()
    await until(() => chat.sentTo(worker).length === 3)
    const next = chat.sentTo(worker)[2]!.text
    expect(next).toContain('这是重复任务的第 2 次运行')
    expect(next).not.toContain('核实后接着做')
  })

  test('a cancel while a due run stops the turn its last run left on the node stays cancelled and sends nothing', async () => {
    let now = Date.UTC(2026, 9, 17, 1, 0)
    const anchor = now
    // The node cannot be reached for the /stop; later stops wait for release.
    let reachable = false
    const releases: (() => void)[] = []
    const book = tasks({
      now: () => now,
      stopTask: async (target, taskId) => {
        stopped.push([target, taskId])
        if (!reachable) return false
        await new Promise<void>(resolve => releases.push(resolve))
        return true
      },
    })
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, {
        title: '巡检',
        instructions: 'x',
        everyMinutes: 60,
        times: 3,
      }),
    )
    const worker = await workerTurn(1)
    const left = chat.lastTask(worker)
    await until(() => book.forSession(parent)[0]?.status === 'running')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await book.cancelForSession(parent)).toBe(1)
    // The run is stopped back to its plan, its node turn still recorded.
    expect(book.forSession(parent)[0]!.status).toBe('scheduled')
    const ledger = JSON.parse(
      fs.readFileSync(path.join(root, 'tasks.json'), 'utf8'),
    ) as { scheduled: { nodeTaskId: string | null }[] }
    expect(ledger.scheduled[0]!.nodeTaskId).toBe(left)
    reachable = true
    now = anchor + 61 * MINUTE
    book.tick()
    // The due run stops that turn first; the cancel comes meanwhile.
    await until(() => releases.length === 1)
    const cancelling = call(book, 'cancel', parent, { id })
    await until(() => book.forSession(parent)[0]?.status === 'cancelled')
    // The cancel stops that same turn too; then both stops answer.
    await until(() => releases.length === 2)
    for (const release of releases.splice(0)) release()
    value(await cancelling)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(book.forSession(parent)[0]!.status).toBe('cancelled')
    expect(chat.sentTo(worker)).toHaveLength(1)
  })

  test('a finished repeat has no runs left, in the view, the note and the console list alike', async () => {
    const now = Date.UTC(2026, 9, 17, 1, 0)
    const book = tasks({ now: () => now })
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, {
        title: '巡检',
        instructions: 'x',
        after: 30,
        everyMinutes: 60,
        times: 4,
      }),
    )
    value(await call(book, 'cancel', parent, { id }))
    expect(book.forSession(parent)[0]).toMatchObject({
      status: 'cancelled',
      phase: '已取消',
      everyMinutes: 60,
      runsLeft: null,
    })
    expect(book.forSession(parent)[0]!.nextAt).toBeUndefined()
    expect(book.contextFor(parent)).toContain('"runsLeft":null')
    expect(book.list({ subject: 'legacy:admin', role: null })[0]).toMatchObject(
      { status: 'cancelled', nextAt: null, everyMinutes: 60, runsLeft: null },
    )
  })

  test('/stop while a repeat’s line is on its way stops the node turn once it has a task id, and the plan stays', async () => {
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
    const now = Date.UTC(2026, 9, 17, 1, 0)
    const book = tasks({ now: () => now })
    const parent = await foreground()
    value(
      await call(book, 'start', parent, {
        title: '巡检',
        instructions: 'x',
        everyMinutes: 60,
        times: 3,
      }),
    )
    // The line is sent and waits at the gate: no node task id yet.
    await until(() => book.forSession(parent)[0]?.status === 'running')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await book.cancelForSession(parent)).toBe(1)
    expect(stopped).toEqual([])
    slow.release()
    await until(() => stopped.length === 1)
    expect(stopped).toEqual([[MAIN, slow.lastTask(workerSessions()[0]!)]])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(book.forSession(parent)[0]).toMatchObject({
      status: 'scheduled',
      runsLeft: 2,
    })
  })

  test('a place that never answers a delivery is given up as unknown, and the next run still starts', async () => {
    let now = Date.UTC(2026, 9, 17, 1, 0)
    const anchor = now
    const errors: string[] = []
    const book = tasks({
      now: () => now,
      deliveryTimeoutMs: 50,
      onError: message => errors.push(message),
      listeners: { stuck: () => new Promise(() => {}) },
    })
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, {
        title: '巡检',
        instructions: 'x',
        everyMinutes: 60,
        times: 2,
      }),
    )
    const worker = await workerTurn(1)
    await finishRun(book, worker, '第一次正常')
    await until(() => finished.length === 1)
    await until(() => ledger().scheduled[0]?.['notification'] === 'unknown')
    expect(ledger().scheduled[0]).toMatchObject({
      deliveries: { note: 'sent', test: 'skipped', stuck: 'unknown' },
    })
    expect(errors).toEqual([
      `后台任务 ${id} 的结果送到 stuck 超时没有回音，按不确定记下，不再重发`,
    ])
    now = anchor + 61 * MINUTE
    book.tick()
    await until(() => chat.sentTo(worker).length === 2)
  })

  test('the console list carries the next start and the runs left', async () => {
    const now = Date.UTC(2026, 9, 17, 1, 0)
    const book = tasks({ now: () => now })
    const parent = await foreground()
    value(
      await call(book, 'start', parent, {
        title: '巡检',
        instructions: 'x',
        after: 30,
        everyMinutes: 60,
        times: 4,
      }),
    )
    expect(book.list({ subject: 'legacy:admin', role: null })[0]).toMatchObject(
      {
        status: 'scheduled',
        phase: '已安排',
        nextAt: now + 30 * MINUTE,
        everyMinutes: 60,
        runsLeft: 4,
      },
    )
    expect(book.contextFor(parent)).toContain('"runsLeft":4')
  })
})

describe('the coordination rules', () => {
  test('the main session stays free: short work in place, long work to its own sub-session, simple slow work to another agent, and it plans ahead', () => {
    expect(SUPERVISOR_RULES).toStartWith(
      '[后台任务协调规则] 你是主会话，始终保持空闲，随时能接主人的下一句。',
    )
    // One paragraph: a worker's context drops it whole.
    expect(SUPERVISOR_RULES).not.toMatch(/\n[ \t]*\n/)
    for (const cue of [
      '一两步能完成的（直接回答、澄清、查一项、一次简单的工具调用、读一个文件）当场做完，不开任务',
      '大约超过一两分钟',
      '立即用 qianmo_task_start 不带 agent 交给你自己的子会话',
      '不在主会话里等它',
      '可以带 agent 交给名册里的其他智能体',
      '先用 qianmo_task_agents 看有谁、谁闲、用什么底层与模型，优先闲的、便宜的',
      '分别开任务并行',
      '主动判断下一步',
      'after 或 at、everyMinutes 与 times',
      '告诉主人安排了什么',
      'qianmo_task_status 报告真实阶段',
      '只有后台任务明确报告 completed 才能说完成',
      '主人的新消息不会取消正在运行的后台任务',
    ])
      expect(SUPERVISOR_RULES).toContain(cue)
    // The old rule sent even one simple tool call to the background.
    expect(SUPERVISOR_RULES).not.toContain('需要工具执行')
    // Without agent it is a sub-session; only with agent another agent.
    expect(SUPERVISOR_RULES).not.toContain('子智能体')
  })

  test('the worker is told it handles a background task for the main session, whether or not it is another agent', () => {
    expect(WORKER_INSTRUCTIONS).toStartWith(
      '你在为主会话处理一个后台任务，按下面的任务说明独立完成。',
    )
    expect(WORKER_INSTRUCTIONS).not.toContain('子智能体')
  })
})

describe('the task note in a console conversation', () => {
  test('a person’s line carries the note as host context, only when it changed, and again after compaction', async () => {
    const book = tasks()
    const web = withTaskNotes(chat, book)
    const opened = await web.open(MAIN)
    if (!opened.ok) throw new Error('open')
    const parent = opened.value.id
    const say = async (text: string) =>
      expect((await web.send({ sessionId: parent, text })).ok).toBe(true)
    // No task yet: nothing to say.
    await say('你好')
    expect(chat.sentTo(parent).at(-1)!.context).toBeUndefined()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, { title: '周报', instructions: 'x' }),
    )
    // The worker's turn is out: the note holds still until it reports.
    const worker = await workerTurn(1)
    await until(() => book.forSession(parent)[0]?.status === 'running')
    chat.reply(parent, '已交给后台')
    await say('进度？')
    const first = chat.sentTo(parent).at(-1)!
    expect(first.text).toBe('进度？')
    expect(first.context).toStartWith('[当前会话的后台任务] ')
    expect(first.context).toContain(id)
    chat.reply(parent, '还在做')
    // Unchanged: not again.
    await say('好')
    expect(chat.sentTo(parent).at(-1)!.context).toBeUndefined()
    // The runtime compacted that turn: the note goes again.
    chat.reply(parent, '好', 'done', { compacted: true })
    await say('继续')
    expect(chat.sentTo(parent).at(-1)!.context).toContain(id)
    chat.reply(parent, 'ok')
    // A command, a worker's line and a schedule's session carry none.
    const command = await web.send({
      sessionId: parent,
      text: '/compact',
      command: 'compact',
    })
    expect(command.ok).toBe(true)
    expect(chat.sentTo(parent).at(-1)!.context).toBeUndefined()
    expect(await book.noteFor(worker)).toBeUndefined()
    const scheduled = tasks({ scheduled: sessionId => sessionId === parent })
    expect(await scheduled.noteFor(parent)).toBeUndefined()
  })
})

describe('what the notes remember', () => {
  test('a conversation that is gone, or whose tasks were all cleared away, is let go of', async () => {
    const DAY = 24 * 60 * 60_000
    let now = Date.now()
    const book = tasks({ now: () => now })
    const web = withTaskNotes(chat, book)
    const say = async (sessionId: string, text: string) =>
      expect((await web.send({ sessionId, text })).ok).toBe(true)
    // Two conversations, each told of its task.
    const parents: string[] = []
    for (const title of ['周报', '月报']) {
      const opened = await web.open(MAIN)
      if (!opened.ok) throw new Error('open')
      const parent = opened.value.id
      parents.push(parent)
      await say(parent, `开个${title}任务`)
      const { id } = value<{ id: string }>(
        await call(book, 'start', parent, { title, instructions: 'x' }),
      )
      chat.reply(parent, '交给后台了')
      await say(parent, '好')
      // The worker's first line may go out in between: this chat's own.
      expect(chat.sentTo(parent).at(-1)!.context).toContain(id)
      value(await call(book, 'cancel', parent, { id }))
      chat.reply(parent, '好')
    }
    expect(book.remembered()).toBe(2)
    // The first conversation is gone.
    chat.records.delete(parents[0]!)
    expect(await book.noteFor(parents[0]!)).toBeUndefined()
    expect(book.remembered()).toBe(1)
    // A month on the second one's task leaves the ledger when another ends.
    now += 31 * DAY
    const other = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', other, { title: '另一个', instructions: 'y' }),
    )
    value(await call(book, 'cancel', other, { id }))
    expect(book.forSession(parents[1]!)).toEqual([])
    expect(book.remembered()).toBe(0)
  })

  test('a reminder is let go of once the conversation has moved past that turn', async () => {
    const book = tasks()
    const web = withTaskNotes(chat, book)
    const opened = await web.open(MAIN)
    if (!opened.ok) throw new Error('open')
    const parent = opened.value.id
    expect((await web.send({ sessionId: parent, text: '查一下' })).ok).toBe(
      true,
    )
    chat.patchLastLine(parent, { readMs: 0 })
    chat.reply(parent, '查完了', 'done', { at: Date.now() + 150_000 })
    expect((await web.send({ sessionId: parent, text: '还有' })).ok).toBe(true)
    expect(chat.sentTo(parent).at(-1)!.context).toContain('提醒：')
    expect(book.remembered()).toBe(1)
    chat.reply(parent, '好')
    expect((await web.send({ sessionId: parent, text: '嗯' })).ok).toBe(true)
    expect(chat.sentTo(parent).at(-1)!.context).toBeUndefined()
    expect(book.remembered()).toBe(0)
  })

  test('at most a thousand reminded conversations are remembered, the oldest let go', async () => {
    const book = tasks()
    let first = ''
    for (let n = 0; n < 1_001; n++) {
      const parent = await foreground()
      if (n === 0) first = parent
      chat.patchLastLine(parent, { readMs: 0 })
      chat.reply(parent, '好了', 'done', { at: Date.now() + 100_000 })
      expect(await book.reminderFor(parent)).toStartWith('提醒：')
    }
    expect(book.remembered()).toBe(1_000)
    // The oldest is let go of: its long turn may be reminded of again.
    expect(await book.reminderFor(first)).toStartWith('提醒：')
  })
})

describe('the task note when the ledger fails', () => {
  test('a note that cannot be had leaves the line as typed; the line still goes', async () => {
    const errors: string[] = []
    const web = withTaskNotes(
      chat,
      {
        noteFor: async () => {
          throw new Error('账本读不出来')
        },
      },
      message => errors.push(message),
    )
    const opened = await web.open(MAIN)
    if (!opened.ok) throw new Error('open')
    const parent = opened.value.id
    const sent = await web.send({ sessionId: parent, text: '在吗' })
    expect(sent.ok).toBe(true)
    expect(chat.sentTo(parent).at(-1)).toMatchObject({ text: '在吗' })
    expect(chat.sentTo(parent).at(-1)!.context).toBeUndefined()
    expect(errors).toEqual(['后台任务附注失败：账本读不出来'])
  })
})

describe('keeping the main session free', () => {
  /** A person's line through the console, and the note it carried. */
  async function line(
    web: ReturnType<typeof withTaskNotes>,
    sessionId: string,
    text: string,
  ): Promise<string | undefined> {
    expect((await web.send({ sessionId, text })).ok).toBe(true)
    return chat.sentTo(sessionId).at(-1)!.context
  }

  test('after a turn over 90 seconds the next line is reminded once; the node’s queue does not count', async () => {
    const book = tasks()
    const web = withTaskNotes(chat, book)
    const opened = await web.open(MAIN)
    if (!opened.ok) throw new Error('open')
    const parent = opened.value.id
    expect(await line(web, parent, '查一下日志')).toBeUndefined()
    // The node read it at once and worked for two and a half minutes.
    chat.patchLastLine(parent, { readMs: 0 })
    chat.reply(parent, '查完了', 'done', { at: Date.now() + 150_000 })
    expect(await line(web, parent, '还有呢')).toBe(
      '[当前会话的后台任务] 提醒：上一轮主会话用了 3 分钟，长活交给后台任务，主会话保持空闲。',
    )
    chat.reply(parent, '好')
    // Once: the turn after is not reminded again of the same long turn.
    expect(await line(web, parent, '再看看')).toBeUndefined()
    // Waited 80 s in the node's queue and worked 70 s: not long.
    chat.patchLastLine(parent, { readMs: 80_000 })
    chat.reply(parent, '看了', 'done', { at: Date.now() + 150_000 })
    expect(await line(web, parent, '嗯')).toBeUndefined()
  })

  test('more than ten tool steps earn a reminder too, beside the task note; ten do not', async () => {
    const book = tasks()
    const web = withTaskNotes(chat, book)
    const opened = await web.open(MAIN)
    if (!opened.ok) throw new Error('open')
    const parent = opened.value.id
    await line(web, parent, '整理一下')
    for (let n = 0; n < 10; n++) chat.step(parent, `读取：${n}.md`)
    // A failed step is not one more call.
    chat.step(parent, '读取：x.md — 失败', true)
    chat.reply(parent, '整理好了')
    expect(await line(web, parent, '好')).toBeUndefined()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, { title: '周报', instructions: 'x' }),
    )
    for (let n = 0; n < 11; n++) chat.step(parent, `读取：${n}.md`)
    chat.reply(parent, '交给后台了')
    const note = await line(web, parent, '谢谢')
    expect(note).toStartWith('[当前会话的后台任务] [')
    expect(note).toContain(id)
    expect(note).toMatch(
      /\n提醒：上一轮主会话用了 \d+ 秒、11 个工具步骤，长活交给后台任务/,
    )
    // One paragraph: a worker's context drops it whole.
    expect(note).not.toMatch(/\n[ \t]*\n/)
  })

  test('a channel takes the reminder as given; a worker or a local command gets none', async () => {
    const book = tasks()
    const parent = await foreground()
    chat.patchLastLine(parent, { readMs: 0 })
    chat.reply(parent, '好了', 'done', { at: Date.now() + 100_000 })
    expect(await book.reminderFor(parent)).toBe(
      '提醒：上一轮主会话用了 100 秒，长活交给后台任务，主会话保持空闲。',
    )
    expect(await book.reminderFor(parent)).toBeUndefined()
    await chat.send({ sessionId: parent, text: '/compact', command: 'compact' })
    chat.patchLastLine(parent, { readMs: 0 })
    chat.reply(parent, '已压缩', 'done', { at: Date.now() + 200_000 })
    expect(await book.reminderFor(parent)).toBeUndefined()
    await chat.send({ sessionId: parent, text: '开个任务' })
    value(await call(book, 'start', parent, { title: 't', instructions: 'i' }))
    const worker = await workerTurn(1)
    chat.patchLastLine(worker, { readMs: 0 })
    chat.reply(worker, '阶段一', 'done', { at: Date.now() + 600_000 })
    expect(await book.reminderFor(worker)).toBeUndefined()
  })

  test('a line the node never read earns no reminder for the time it waited', async () => {
    const book = tasks()
    const parent = await foreground()
    // No ack: the chat face's own deadline ran out five minutes on.
    chat.reply(parent, '这一轮在任务期限内没有回复。', 'failed', {
      at: Date.now() + 315_000,
      code: 'E_TASK_TIMEOUT',
    })
    expect(await book.reminderFor(parent)).toBeUndefined()
  })
})

describe('parallel sub-sessions and reports (P38)', () => {
  /** Steers the hub sent, and whether the node takes them. */
  function steering(takes: (target: string, taskId: string) => boolean) {
    const calls: { target: string; taskId: string; text: string }[] = []
    return {
      calls,
      steerTask: async (target: string, taskId: string, text: string) => {
        calls.push({ target, taskId, text })
        return takes(target, taskId)
      },
    }
  }

  /** Report turns the hub sent into a conversation. */
  function reports(sessionId: string) {
    return chat.sentTo(sessionId).filter(one => one.report === true)
  }

  /** A worker reports completed and ends its turn. */
  async function complete(
    book: ConsoleTasks,
    worker: string,
    summary: string,
  ): Promise<void> {
    value(await call(book, 'report', worker, { summary, state: 'completed' }))
    chat.reply(worker, '完成')
  }

  function sessionOf(title: string): string | undefined {
    return workerSessions().find(
      id => chat.sentTo(id)[0]?.text.includes(`任务：${title}`) === true,
    )
  }

  /** The worker session of the task titled `title`, once it has its first line. */
  async function workerOf(title: string): Promise<string> {
    await until(() => sessionOf(title) !== undefined)
    return sessionOf(title)!
  }

  test('three worker turns per node by default: the fourth waits as 排队中 and takes the first slot freed', async () => {
    const book = tasks()
    const parent = await foreground()
    for (const title of ['a', 'b', 'c', 'd'])
      value(await call(book, 'start', parent, { title, instructions: 'x' }))
    await until(() => workerSessions().length === 3)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(outstanding('node-a')).toBe(3)
    expect(
      book
        .forSession(parent)
        .filter(task => task.status === 'queued')
        .map(task => task.title),
    ).toEqual(['d'])
    chat.reply(workerSessions()[0]!, '这一阶段做完了')
    await until(() => workerSessions().length === 4)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(outstanding('node-a')).toBe(3)
  })

  test("a node that says it runs fewer background turns gets no more than that", async () => {
    const asked: string[] = []
    const book = tasks({
      nodeTurns: async node => {
        asked.push(node)
        return node === 'node-a' ? 2 : undefined
      },
    })
    const parent = await foreground()
    for (const title of ['a', 'b', 'c'])
      value(await call(book, 'start', parent, { title, instructions: 'x' }))
    await until(() => workerSessions().length === 2)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(outstanding('node-a')).toBe(2)
    expect(asked).toContain('node-a')
  })

  test('node.ping says the background share; an older node says nothing', async () => {
    let answer: ControlOutcome = {
      ok: true,
      value: { runtimes: {}, turns: { max: 4, background: 3 } },
    }
    const profiles = new AgentProfiles({
      ping: async () => answer,
      nodeModel: async () => undefined,
      now: () => 0,
    })
    expect(await profiles.backgroundTurns('node-a')).toBe(3)
    answer = { ok: true, value: { runtimes: {} } }
    expect(await profiles.backgroundTurns('node-b')).toBeUndefined()
    answer = { ok: false, code: 'unreachable', message: 'down' }
    expect(await profiles.backgroundTurns('node-c')).toBeUndefined()
  })

  test('an added instruction goes into the running worker turn at once and counts as read; one that cannot waits for the next turn', async () => {
    let live = true
    const steer = steering(() => live)
    const book = tasks({ steerTask: steer.steerTask })
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, { title: '周报', instructions: 'x' }),
    )
    const worker = await workerTurn(1)
    // Only the hub's own record picks where it goes: arguments naming
    // another agent or turn change nothing.
    const sent = value<{ delivery: string; updateId: number }>(
      await call(book, 'send', parent, {
        id,
        message: '顺便统计一下评审意见',
        agent: CODER,
        target: CODER,
        nodeTaskId: 'forged',
      }),
    )
    expect(sent.delivery).toBe('live')
    expect(steer.calls).toHaveLength(1)
    expect(steer.calls[0]).toMatchObject({
      target: MAIN,
      taskId: chat.lastTask(worker),
    })
    expect(steer.calls[0]!.text).toContain('顺便统计一下评审意见')
    expect(steer.calls[0]!.text).toContain(`#${sent.updateId}`)
    // Read already: the worker may finish without asking for updates.
    value(
      await call(book, 'report', worker, {
        summary: '做完了，评审意见 4 条',
        state: 'completed',
      }),
    )
    // Not taken mid-turn: it waits for qianmo_task_updates.
    live = false
    const parent2 = await foreground()
    const second = value<{ id: string }>(
      await call(book, 'start', parent2, { title: '月报', instructions: 'x' }),
    ).id
    const worker2 = await workerOf('月报')
    const late = value<{ delivery: string }>(
      await call(book, 'send', parent2, { id: second, message: '加一页' }),
    )
    expect(late.delivery).toBe('next_turn')
    const refused = await call(book, 'report', worker2, {
      summary: '完成',
      state: 'completed',
    })
    expect(refused.ok).toBe(false)
  })

  test('an instruction taken mid-turn after one that was not leaves the earlier one unread', async () => {
    let live = false
    const steer = steering(() => live)
    const book = tasks({ steerTask: steer.steerTask })
    const parent = await foreground()
    const { id } = value<{ id: string }>(
      await call(book, 'start', parent, { title: '周报', instructions: 'x' }),
    )
    const worker = await workerTurn(1)
    value(await call(book, 'send', parent, { id, message: '第一条' }))
    live = true
    expect(
      value<{ delivery: string }>(
        await call(book, 'send', parent, { id, message: '第二条' }),
      ).delivery,
    ).toBe('live')
    // 第一条 is still unread: no completion before reading it.
    const early = await call(book, 'report', worker, {
      summary: '完成',
      state: 'completed',
    })
    expect(early.ok ? '' : early.message).toContain('qianmo_task_updates')
    const read = value<{ updates: { message: string }[] }>(
      await call(book, 'updates', worker),
    )
    expect(read.updates.map(one => one.message)).toEqual(['第一条', '第二条'])
  })

  test('results that finish together reach an idle parent in one report turn; tasks started in it report by note only', async () => {
    const book = tasks({ reportDelayMs: 300, reportRetryMs: () => 10 })
    const parent = await foreground()
    for (const title of ['周报', '月报'])
      value(await call(book, 'start', parent, { title, instructions: 'x' }))
    await until(() => workerSessions().length === 2)
    // The foreground answered at once: it is idle when the results come.
    chat.reply(parent, '已经交给后台')
    await complete(book, await workerOf('周报'), '周报写好了')
    // The second result comes in while the first waits for company.
    await until(() => chat.notes.length === 1)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(reports(parent)).toEqual([])
    await complete(book, await workerOf('月报'), '月报写好了')
    await until(() => reports(parent).length === 1)
    const line = reports(parent)[0]!
    expect(line.text).toContain('周报 已完成')
    expect(line.text).toContain('月报 已完成')
    expect(line.context).toContain('[后台任务回报]')
    expect(line.context).toContain('周报写好了')
    expect(line.context).toContain('月报写好了')
    expect(line.taskTtlMs).toBe(5 * 60_000)
    expect(line.background).toBeUndefined()
    // The notices in the transcript stay as they were.
    expect(chat.notes.filter(one => one.sessionId === parent)).toHaveLength(2)
    // In the report turn the main agent starts another task.
    const followUp = value<{ id: string }>(
      await call(book, 'start', parent, { title: '复核', instructions: 'x' }),
    ).id
    await until(() => workerSessions().length === 3)
    chat.reply(parent, '已安排复核')
    await complete(book, await workerOf('复核'), '复核没问题')
    await until(() =>
      chat.notes.some(one => one.text.startsWith('复核：已完成')),
    )
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(reports(parent)).toHaveLength(1)
    expect(book.forSession(parent).find(task => task.id === followUp)?.status).toBe(
      'completed',
    )
  })

  test('a busy parent hears results and progress mid-turn; where its turn takes nothing, the result waits for the turn to end', async () => {
    let parentTakes = true
    const steer = steering(() => parentTakes)
    const book = tasks({
      steerTask: steer.steerTask,
      reportDelayMs: 10,
      reportRetryMs: () => 10,
    })
    const parent = await foreground()
    const busy = chat.lastTask(parent)
    value(await call(book, 'start', parent, { title: '周报', instructions: 'x' }))
    const worker = await workerTurn(1)
    value(
      await call(book, 'report', worker, {
        summary: '读完了 12 个提交',
        state: 'working',
      }),
    )
    await until(() => steer.calls.length === 1)
    expect(steer.calls[0]).toMatchObject({ target: MAIN, taskId: busy })
    expect(steer.calls[0]!.text).toContain('进展')
    expect(steer.calls[0]!.text).toContain('读完了 12 个提交')
    await complete(book, worker, '周报写好了')
    await until(() => steer.calls.length === 2)
    expect(steer.calls[1]).toMatchObject({ taskId: busy })
    expect(steer.calls[1]!.text).toContain('周报写好了')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(reports(parent)).toEqual([])
    // A runtime that takes nothing mid-turn: the result waits for the end
    // of the turn and then comes in a turn of its own.
    parentTakes = false
    value(await call(book, 'start', parent, { title: '月报', instructions: 'x' }))
    await until(() => workerSessions().length === 2)
    await complete(book, await workerOf('月报'), '月报写好了')
    await until(() => steer.calls.length >= 4)
    expect(reports(parent)).toEqual([])
    chat.reply(parent, '先这样')
    await until(() => reports(parent).length === 1)
    // Only what is still owed: the result told mid-turn is not told again.
    expect(reports(parent)[0]!.text).toBe('后台任务回报：月报 已完成')
    expect(reports(parent)[0]!.context).toContain('月报写好了')
  })

  test('a chat a channel posted the result to gets no report turn, nor does one whose next line carried it', async () => {
    const book = tasks({
      reportDelayMs: 80,
      reportRetryMs: () => 10,
      listeners: {
        channel: async event =>
          event.parentSession === channelChat ? true : undefined,
      },
    })
    const channelChat = await foreground()
    value(
      await call(book, 'start', channelChat, { title: '周报', instructions: 'x' }),
    )
    const console = await foreground()
    value(await call(book, 'start', console, { title: '月报', instructions: 'x' }))
    await until(() => workerSessions().length === 2)
    chat.reply(channelChat, '好')
    chat.reply(console, '好')
    await complete(book, await workerOf('周报'), '周报写好了')
    await complete(book, await workerOf('月报'), '月报写好了')
    await until(() => chat.notes.length === 2)
    // The owner writes again before the report goes out: the task note on
    // that line tells the result, so no report turn follows.
    const sent = await withTaskNotes(chat, book).send({
      sessionId: console,
      text: '还有别的吗',
    })
    expect(sent.ok).toBe(true)
    expect(chat.sentTo(console).at(-1)?.context).toContain('月报')
    chat.reply(console, '没有了')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(reports(channelChat)).toEqual([])
    expect(reports(console)).toEqual([])
  })
})
