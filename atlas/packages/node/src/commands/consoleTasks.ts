// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Background tasks on the hub (P29, `runtimes-channels.md` §3), ported from
 * grantley's `tasks/`.
 *
 * A foreground conversation (a person's console chat, or the owner's private
 * chat on a channel) calls `qianmo_task_start`; the hub opens a separate
 * worker conversation with the same or another agent — possibly on another
 * runtime and model — and drives it turn after turn, as the foreground's
 * owner, until the worker reports `completed` or `needs_input` through
 * `qianmo_task_report`. A model's ordinary final answer is not a completion.
 * The user can add instructions (`qianmo_task_send`), ask for status and
 * cancel; tasks survive a hub restart and resume from their last checkpoint.
 * The result goes back into the parent conversation as a notice, and to the
 * chat it came from when that is a channel.
 *
 * Every worker turn goes through the same `ChatDispatch` boundary as the
 * console (ownership, tenancy, quota, audit), so a task cannot do anything
 * its owner could not.
 *
 * A node runs one turn at a time, so a worker turn is a turn the owner's
 * foreground is not getting. Three things keep the foreground responsive:
 * workers end their turn after each phase (the hub calls them again), at most
 * one worker turn per node is in flight, and every worker turn goes out marked
 * `background` with its own deadline, so the node lets interactive turns go
 * first and stops a worker turn that outlives it.
 */

import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  ChatDispatch,
  type ChatPort,
  type ChatTranscript,
  type ConsoleAccounts,
  type TenantPort,
  type UsagePort,
} from '@qianmo/console'
import { parseAddress, type ControlOutcome } from '@qianmo/protocol'
import {
  acquirePrivateInstanceLock,
  ensurePrivateDir,
  type PrivateInstanceLock,
  readTextIfExists,
  writePrivateJson,
} from '../providers/store.js'
import {
  refusal,
  sendAndWait,
  terminalReply,
  type ChatTurnHandle,
} from './chatTurn.js'
import type { HubCallHandler } from './consoleControl.js'

const STATUSES = [
  'queued',
  'running',
  'interrupted',
  'completion_pending',
  'needs_input_pending',
  'needs_input',
  'completed',
  'cancelled',
] as const
type TaskStatus = (typeof STATUSES)[number]

/** A worker reported this; it holds only once its turn ended normally. */
const PENDING: ReadonlySet<TaskStatus> = new Set([
  'completion_pending',
  'needs_input_pending',
])
const RESUMABLE: ReadonlySet<TaskStatus> = new Set([
  'queued',
  'running',
  'interrupted',
  ...PENDING,
])
const TERMINAL: ReadonlySet<TaskStatus> = new Set(['completed', 'cancelled'])

const PHASE: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '执行中',
  interrupted: '等待恢复',
  completion_pending: '已报告完成，等这一轮结束',
  needs_input_pending: '准备向你提问，等这一轮结束',
  needs_input: '等待你的补充',
  completed: '已完成',
  cancelled: '已取消',
}

export const WORKER_INSTRUCTIONS = `你是一个持久后台子智能体，独立执行下面这个任务。
任务没有总时长或总轮数上限，保持执行直到完成，或确实需要用户补充信息。
开始、阶段变化和关键操作之后调用 qianmo_task_report(state='working', summary=真实进展、证据和下一步)。
任务实际完成并验证后，必须调用 qianmo_task_report(state='completed', summary=最终结果及验证证据)。
只有缺少必需的信息或授权、无法继续时，才调用 qianmo_task_report(state='needs_input', summary=具体问题)。
普通的最终回复、承诺「继续」都不代表任务完成；任务管理器会在同一会话里继续叫你。
开始时、关键操作前和阶段之间调用 qianmo_task_updates，读取用户的新指示；新指示是用户消息，遵守授权范围。
补充消息带唯一 id；读过但还没在之后的 qianmo_task_report 里确认的会重复返回，先核实是否已经执行，勿重复操作。
只操作当前任务；不开新的后台任务，不查看其他任务。
恢复时先核实检查点和工具产生的实际状态，再接着做；绝不盲目重放发消息、发布、付款、修改等操作。
完成结果由任务管理器送回主会话，不要另外发重复的完成通知。`

/** The coordination rule for a foreground conversation (grantley `turn_context`). */
export const SUPERVISOR_RULES =
  '[后台任务协调规则] 你是保持即时响应的主智能体，只做短对话、澄清、拆解和调度。' +
  '需要工具执行、研究、多步或长时间工作的请求，立即用 qianmo_task_start 交给后台子智能体，' +
  '不要在主会话里等待子任务或做耗时操作。用户催问时用 qianmo_task_status 报告真实阶段，' +
  '用 qianmo_task_send 传递补充指示。只有子智能体明确报告 completed 才能说完成。' +
  '用户的新消息不会取消正在运行的后台任务。'

const recordSchema = z.object({
  id: z.string().regex(/^task-[0-9a-f-]{36}$/),
  title: z.string(),
  instructions: z.string(),
  owner: z.string(),
  parentSession: z.string(),
  parentTarget: z.string(),
  target: z.string(),
  workerSession: z.string().nullable(),
  status: z.enum(STATUSES),
  progress: z.string(),
  result: z.string(),
  requestedState: z.enum(['', 'completed', 'needs_input']),
  lastError: z.string(),
  turns: z.number().int().nonnegative(),
  /**
   * The node task of the worker turn the hub sent and has not seen end:
   * stopped before the next turn, on cancel and after a restart, so a
   * leftover turn never runs on in front of the next one.
   */
  nodeTaskId: z.string().nullable().default(null),
  quietTurns: z.number().int().nonnegative(),
  readUpdateId: z.number().int().nonnegative(),
  notification: z.enum([
    'none',
    'pending',
    'sending',
    'sent',
    'failed',
    'unknown',
  ]),
  context: z.array(
    z.object({ role: z.enum(['user', 'agent']), text: z.string() }),
  ),
  createdAt: z.number(),
  updatedAt: z.number(),
})
type TaskRecord = z.infer<typeof recordSchema>

const updateSchema = z.object({
  id: z.number().int().positive(),
  taskId: z.string(),
  message: z.string(),
  at: z.number(),
  consumedAt: z.number().nullable(),
})
type TaskUpdate = z.infer<typeof updateSchema>

const bookSchema = z.object({
  v: z.literal(1),
  tasks: z.array(recordSchema),
  updates: z.array(updateSchema),
  nextUpdateId: z.number().int().positive(),
})

export interface TaskView {
  readonly id: string
  readonly title: string
  readonly target: string
  readonly status: TaskStatus
  readonly phase: string
  readonly progress: string
  readonly result: string
  readonly lastError: string
  readonly turns: number
  readonly updatedAt: number
}

/** A task finished or needs input; `text` is what the parent hears. */
export interface TaskFinished {
  readonly parentSession: string
  readonly taskId: string
  readonly text: string
}

export interface ConsoleTasksOptions {
  readonly directory: string
  readonly chat: ChatPort
  readonly accounts?: ConsoleAccounts
  readonly usage?: UsagePort
  readonly tenancy?: TenantPort
  readonly now?: () => number
  /** Stops a worker's running turn on its node (`turn.stop`). */
  readonly stopTask?: (target: string, taskId: string) => Promise<boolean>
  /** False for conversations that may not start tasks (channel groups, members). */
  readonly foreground?: (sessionId: string) => boolean
  /** Sessions that are the same conversation (a chat after `/new`); tasks follow it. */
  readonly related?: (sessionId: string) => readonly string[]
  /**
   * One worker turn's deadline (`taskTtlMs`); approvals asked for in the
   * turn expire with it. Default 30 minutes.
   */
  readonly turnTtlMs?: number
  /** How long to wait after a failed turn; tests shorten it. */
  readonly backoffMs?: (failures: number) => number
  readonly onError?: (message: string) => void
}

const MAX_ACTIVE_PER_PARENT = 8
/**
 * Worker turns in flight per node. One: the node runs one turn at a time, and
 * a second worker turn would only queue there in front of the owner's next
 * message. Tasks on the same node take turns.
 */
const MAX_RUNNING_PER_NODE = 1
const DEFAULT_TURN_TTL_MS = 30 * 60_000
/**
 * How much longer than the deadline the hub waits for a worker turn's answer:
 * the node answers a stopped background turn within seconds of its deadline,
 * and the chat face's own fallback fires 15 s after it.
 */
const TURN_WAIT_SLACK_MS = 60_000
/** Consecutive successful turns without any report before the task pauses. */
const MAX_QUIET_TURNS = 5
/** Consecutive failed turns before the task stops and asks the user. */
const MAX_FAILURES = 10
/**
 * Refusals retrying cannot fix: the owner's account or role changed, the
 * target left the dial list or the tenant, the quota is spent. Same set the
 * schedules treat as "skipped". The task pauses for the owner at once.
 */
const PERMANENT_REFUSALS: ReadonlySet<number> = new Set([401, 403, 404, 429])

interface TurnOutcome {
  readonly ok: boolean
  readonly error?: string
  readonly cancelled?: boolean
  readonly permanent?: boolean
}

function ok(value: unknown): ControlOutcome {
  return { ok: true, value }
}
function refused(message: string): ControlOutcome {
  return { ok: false, code: 'refused', message }
}

function clip(text: string, length: number): string {
  const chars = [...text]
  return chars.length <= length ? text : `${chars.slice(0, length).join('')}…`
}

/** Seconds to wait after the n-th consecutive failure (grantley `_retry_wait`). */
function defaultBackoff(failures: number): number {
  return Math.min(60_000, 2 ** Math.min(failures, 6) * 1_000)
}

interface Caller {
  readonly transcript: ChatTranscript
  readonly owner: string
  readonly worker: TaskRecord | undefined
}

export class ConsoleTasks {
  readonly #options: ConsoleTasksOptions
  readonly #now: () => number
  readonly #path: string
  readonly #lock: PrivateInstanceLock | null
  readonly #tasks = new Map<string, TaskRecord>()
  #updates: TaskUpdate[] = []
  #nextUpdateId = 1
  /** Worker loops in flight, by task id. */
  readonly #loops = new Map<string, Promise<void>>()
  /** The turn each worker is waiting on, to cancel. */
  readonly #turns = new Map<
    string,
    { target: string; taskId: string | null; handle: ChatTurnHandle }
  >()
  readonly #waits = new Map<string, () => void>()
  /** Worker turns in flight by node; see {@link MAX_RUNNING_PER_NODE}. */
  readonly #slots = new Map<string, number>()
  readonly #slotQueue = new Map<string, (() => void)[]>()
  readonly #listeners = new Set<
    (event: TaskFinished) => Promise<boolean | undefined>
  >()
  #closed = false

  constructor(options: ConsoleTasksOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    ensurePrivateDir(options.directory)
    this.#path = path.join(options.directory, 'tasks.json')
    this.#lock = acquirePrivateInstanceLock(
      path.join(options.directory, 'instance.lock'),
    )
    if (!this.#lock)
      options.onError?.('后台任务目录已由另一实例持有；本实例不执行任务')
    const raw = readTextIfExists(this.#path)
    if (raw !== undefined) {
      const book = bookSchema.parse(JSON.parse(raw))
      for (const task of book.tasks) this.#tasks.set(task.id, task)
      this.#updates = book.updates
      this.#nextUpdateId = book.nextUpdateId
    }
  }

  /** Resumes unfinished tasks and resends notices a restart cut off. */
  start(): void {
    if (!this.#lock?.owned()) return
    for (const task of this.#tasks.values()) {
      if (task.notification === 'sending')
        // The send may or may not have happened; never duplicate it.
        this.#patch(task.id, { notification: 'unknown' })
      if (RESUMABLE.has(task.status)) this.#schedule(task.id)
      else if (
        (task.status === 'completed' || task.status === 'needs_input') &&
        task.notification === 'pending'
      )
        void this.#notify(task.id)
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const wake of this.#waits.values()) wake()
    for (const turn of this.#turns.values()) turn.handle.cancel()
    for (const queue of this.#slotQueue.values())
      for (const wake of queue.splice(0)) wake()
    await Promise.allSettled([...this.#loops.values()])
    for (const task of this.#tasks.values())
      if (task.status === 'running')
        this.#patch(task.id, { status: 'interrupted' })
    this.#lock?.release()
  }

  /** Channels deliver results to the chat a task came from. */
  onFinished(
    listener: (event: TaskFinished) => Promise<boolean | undefined>,
  ): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  // -- the ledger ---------------------------------------------------------------

  #save(): void {
    if (!this.#lock?.owned()) return
    try {
      writePrivateJson(this.#path, {
        v: 1,
        tasks: [...this.#tasks.values()],
        updates: this.#updates,
        nextUpdateId: this.#nextUpdateId,
      })
    } catch {
      this.#options.onError?.('后台任务账本写入失败')
    }
  }

  #patch(id: string, changes: Partial<TaskRecord>): TaskRecord {
    const current = this.#tasks.get(id)
    if (current === undefined) throw new Error(`no task ${id}`)
    const next = { ...current, ...changes, updatedAt: this.#now() }
    this.#tasks.set(id, next)
    this.#save()
    return next
  }

  #unread(task: TaskRecord): TaskUpdate[] {
    return this.#updates.filter(
      one => one.taskId === task.id && one.consumedAt === null,
    )
  }

  #view(task: TaskRecord): TaskView {
    return {
      id: task.id,
      title: task.title,
      target: task.target,
      status: task.status,
      phase: PHASE[task.status],
      progress: clip(task.progress, 2_000),
      result: clip(task.result, 6_000),
      lastError: clip(task.lastError, 1_000),
      turns: task.turns,
      updatedAt: task.updatedAt,
    }
  }

  #family(sessionId: string): ReadonlySet<string> {
    return new Set([sessionId, ...(this.#options.related?.(sessionId) ?? [])])
  }

  /** Tasks started from a conversation, newest first. */
  forSession(sessionId: string): TaskView[] {
    const family = this.#family(sessionId)
    return [...this.#tasks.values()]
      .filter(task => family.has(task.parentSession))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(task => this.#view(task))
  }

  /** The per-turn note a foreground gets: its current and recent tasks. */
  contextFor(sessionId: string): string | undefined {
    const tasks = this.forSession(sessionId)
    if (tasks.length === 0) return undefined
    const current = tasks.filter(task => !TERMINAL.has(task.status))
    const recent = tasks.filter(task => TERMINAL.has(task.status)).slice(0, 5)
    return `[当前会话的后台任务] ${JSON.stringify(
      [...current, ...recent].map(task => ({
        id: task.id,
        title: task.title,
        status: task.status,
        progress: clip(task.progress, 300),
      })),
    )}`
  }

  /** A short status answer for "进度怎么样了" (grantley `status_text`). */
  statusText(sessionId: string): string | undefined {
    const tasks = this.forSession(sessionId)
    if (tasks.length === 0) return undefined
    const active = tasks.filter(task => !TERMINAL.has(task.status))
    return (active.length > 0 ? active : tasks.slice(0, 3))
      .map(task => {
        let line = `${task.title}：${task.phase}`
        if (task.progress) line += `。${clip(task.progress, 400)}`
        if (task.lastError) line += `\n最近中断：${clip(task.lastError, 200)}`
        return line
      })
      .join('\n\n')
  }

  /** `/stop` in a chat: cancels that conversation's running tasks. */
  async cancelForSession(sessionId: string): Promise<number> {
    let count = 0
    const family = this.#family(sessionId)
    for (const task of [...this.#tasks.values()])
      if (family.has(task.parentSession) && !TERMINAL.has(task.status)) {
        await this.#cancel(task)
        count++
      }
    return count
  }

  // -- hub calls ------------------------------------------------------------------

  readonly handle: HubCallHandler = async (fullOp, args, ctx) => {
    if (!fullOp.startsWith('tasks.') || this.#closed)
      return refused('后台任务不可用')
    if (!this.#lock?.owned()) return refused('后台任务由另一控制台实例负责')
    const op = fullOp.slice('tasks.'.length)
    const caller = await this.#caller(args, ctx)
    if (typeof caller === 'string') return refused(caller)
    const sessionId = caller.transcript.session.id
    const worker = caller.worker
    if (op === 'report' || op === 'updates') {
      if (worker === undefined) return refused('只有后台子任务能汇报')
      if (TERMINAL.has(worker.status)) return refused('任务已结束')
      return op === 'report'
        ? this.#report(worker, args)
        : this.#readUpdates(worker)
    }
    if (worker !== undefined) return refused('后台子任务不能再开或管理其他任务')
    if (this.#options.foreground?.(sessionId) === false)
      return refused('后台任务只对主人的私聊和控制台对话开放')
    const family = this.#family(sessionId)
    const owned = (id: unknown): TaskRecord | string => {
      const task = typeof id === 'string' ? this.#tasks.get(id) : undefined
      return task === undefined || !family.has(task.parentSession)
        ? '当前会话中没有这个任务'
        : task
    }
    switch (op) {
      case 'start':
        return this.#start(caller, args)
      case 'status': {
        if (args['id'] === undefined)
          return ok({ tasks: this.forSession(sessionId) })
        const task = owned(args['id'])
        return typeof task === 'string'
          ? refused(task)
          : ok({ task: this.#view(task) })
      }
      case 'send': {
        const task = owned(args['id'])
        if (typeof task === 'string') return refused(task)
        return this.#send(task, args['message'])
      }
      case 'cancel': {
        const task = owned(args['id'])
        if (typeof task === 'string') return refused(task)
        await this.#cancel(task)
        return ok({ task: this.#view(this.#tasks.get(task.id)!) })
      }
      default:
        return { ok: false, code: 'unsupported', message: `不支持 ${fullOp}` }
    }
  }

  /**
   * Who is calling: the console conversation named by `contextId` must be
   * with this very agent, and `taskId` must be a turn of it still waiting
   * for its answer — a node can act only for the turn it is running.
   */
  async #caller(
    args: Record<string, unknown>,
    ctx: { readonly node: string; readonly agent?: string },
  ): Promise<Caller | string> {
    const contextId = args['contextId']
    const taskId = args['taskId']
    if (
      typeof contextId !== 'string' ||
      typeof taskId !== 'string' ||
      !ctx.agent
    )
      return '缺少会话信息'
    const transcript = await this.#options.chat.transcript(contextId)
    if (!transcript.ok) return '会话不存在'
    if (transcript.value.session.target !== `qianmo://${ctx.node}/${ctx.agent}`)
      return '会话不属于这个智能体'
    const turns = transcript.value.turns
    const asked = turns.some(
      turn => turn.author === 'operator' && turn.taskId === taskId,
    )
    // The same terminal rule the worker loop waits on: the chat face's local
    // timeout guess is not the node's answer, and until the node answers the
    // turn may still be running and reporting.
    if (!asked || terminalReply(turns, taskId) !== undefined)
      return '这一轮不在进行中'
    return {
      transcript: transcript.value,
      owner: this.#options.accounts?.book.ownerOf(contextId) ?? 'legacy:admin',
      worker: [...this.#tasks.values()].find(
        task => task.workerSession === contextId,
      ),
    }
  }

  #dispatch(owner: string): ChatDispatch | string {
    const dispatch = ChatDispatch.forSubject(owner, {
      deps: {
        chat: this.#options.chat,
        ...(this.#options.usage === undefined
          ? {}
          : { usage: this.#options.usage }),
        ...(this.#options.tenancy === undefined
          ? {}
          : { tenancy: this.#options.tenancy }),
      },
      accounts: this.#options.accounts,
      now: this.#now(),
      requestId: randomUUID(),
    })
    return dispatch instanceof Response ? '任务主人的账号已不可用' : dispatch
  }

  async #start(
    caller: Caller,
    args: Record<string, unknown>,
  ): Promise<ControlOutcome> {
    const title = typeof args['title'] === 'string' ? args['title'].trim() : ''
    const instructions =
      typeof args['instructions'] === 'string'
        ? args['instructions'].trim()
        : ''
    if (title === '' || instructions === '')
      return refused('需要标题和任务说明')
    if ([...title].length > 80 || instructions.length > 8_000)
      return refused('标题最多 80 字，说明最多 8000 字')
    const session = caller.transcript.session
    const target =
      typeof args['agent'] === 'string' && args['agent'].trim() !== ''
        ? args['agent'].trim()
        : session.target
    if (parseAddress(target) === null)
      return refused('agent 不是有效的智能体地址')
    const family = this.#family(session.id)
    const active = [...this.#tasks.values()].filter(
      task => family.has(task.parentSession) && !TERMINAL.has(task.status),
    )
    if (active.length >= MAX_ACTIVE_PER_PARENT)
      return refused(`这个会话已有 ${active.length} 个未结束的任务`)
    const dispatch = this.#dispatch(caller.owner)
    if (typeof dispatch === 'string') return refused(dispatch)
    const denied = await dispatch.authorizeTarget(target)
    if (denied)
      return refused((await refusal(denied)).error ?? '不能派给这个智能体')
    const now = this.#now()
    const task: TaskRecord = {
      id: `task-${randomUUID()}`,
      title,
      instructions,
      owner: caller.owner,
      parentSession: session.id,
      parentTarget: session.target,
      target,
      workerSession: null,
      status: 'queued',
      progress: '',
      result: '',
      requestedState: '',
      lastError: '',
      turns: 0,
      nodeTaskId: null,
      quietTurns: 0,
      readUpdateId: 0,
      notification: 'none',
      context: caller.transcript.turns
        .filter(turn => turn.variant !== 'notice' && turn.text.trim() !== '')
        .slice(-6)
        .map(turn => ({
          role:
            turn.author === 'operator' ? ('user' as const) : ('agent' as const),
          text: clip(turn.text, 1_500),
        })),
      createdAt: now,
      updatedAt: now,
    }
    this.#tasks.set(task.id, task)
    this.#save()
    this.#schedule(task.id)
    return ok({ id: task.id, title, target, status: task.status })
  }

  #send(task: TaskRecord, raw: unknown): ControlOutcome {
    if (TERMINAL.has(task.status)) return refused('任务已结束；请创建新任务')
    const message = typeof raw === 'string' ? raw.trim() : ''
    if (message === '' || message.length > 4_000)
      return refused('补充指示需要 1–4000 字')
    const update: TaskUpdate = {
      id: this.#nextUpdateId++,
      taskId: task.id,
      message,
      at: this.#now(),
      consumedAt: null,
    }
    this.#updates.push(update)
    let next = task
    if (task.status === 'needs_input' || task.status === 'interrupted')
      next = this.#patch(task.id, {
        status: 'queued',
        notification: 'none',
        requestedState: '',
        quietTurns: 0,
      })
    else if (PENDING.has(task.status))
      // Amended while the worker finishes its turn: handle it before finishing.
      next = this.#patch(task.id, {
        status: 'running',
        requestedState: '',
        notification: 'none',
      })
    else this.#save()
    this.#schedule(task.id)
    // A task waiting out a failure's backoff takes the instruction now.
    this.#waits.get(task.id)?.()
    return ok({ updateId: update.id, task: this.#view(next) })
  }

  async #cancel(task: TaskRecord): Promise<void> {
    if (task.status === 'completed' || task.status === 'cancelled') return
    this.#patch(task.id, { status: 'cancelled' })
    this.#waits.get(task.id)?.()
    const turn = this.#turns.get(task.id)
    // The turn the loop waits on, or one a restart left on the node.
    const running = turn?.taskId ?? task.nodeTaskId
    if (running !== null && this.#options.stopTask)
      await this.#options
        .stopTask(turn?.target ?? task.target, running)
        .catch(() => false)
    turn?.handle.cancel()
  }

  #report(task: TaskRecord, args: Record<string, unknown>): ControlOutcome {
    const state = args['state']
    const summary =
      typeof args['summary'] === 'string' ? args['summary'].trim() : ''
    if (state !== 'working' && state !== 'completed' && state !== 'needs_input')
      return refused('state 只能是 working、completed 或 needs_input')
    if (summary === '') return refused('需要 summary')
    if (
      state !== 'working' &&
      this.#unread(task).some(one => one.id > task.readUpdateId)
    )
      return refused(
        '有新的用户指示还没读取，先调用 qianmo_task_updates，再确认完成或提问。',
      )
    // Confirm what was read, atomically with the checkpoint (grantley `checkpoint`).
    const at = this.#now()
    this.#updates = this.#updates.map(one =>
      one.taskId === task.id &&
      one.consumedAt === null &&
      one.id <= task.readUpdateId
        ? { ...one, consumedAt: at }
        : one,
    )
    this.#patch(task.id, {
      progress: clip(summary, 8_000),
      lastError: '',
      status:
        state === 'working'
          ? 'running'
          : state === 'completed'
            ? 'completion_pending'
            : 'needs_input_pending',
      requestedState: state === 'working' ? '' : state,
      quietTurns: 0,
      ...(state === 'working'
        ? {}
        : { result: clip(summary, 8_000), notification: 'none' as const }),
    })
    return ok({ state })
  }

  #readUpdates(task: TaskRecord): ControlOutcome {
    const pending = this.#unread(task)
    if (pending.length > 0)
      this.#patch(task.id, {
        readUpdateId: Math.max(
          task.readUpdateId,
          pending[pending.length - 1]!.id,
        ),
      })
    return ok({
      updates: pending.map(one => ({
        id: one.id,
        message: one.message,
        at: one.at,
      })),
    })
  }

  // -- the worker loop --------------------------------------------------------------

  #schedule(id: string): void {
    if (this.#closed || !this.#lock?.owned() || this.#loops.has(id)) return
    const loop = this.#execute(id)
      .catch(error =>
        this.#options.onError?.(
          `后台任务 ${id} 异常：${String((error as Error)?.message ?? error)}`,
        ),
      )
      .finally(() => {
        this.#loops.delete(id)
        // Amended or resumed while the loop was ending: run it again.
        const task = this.#tasks.get(id)
        if (
          task &&
          RESUMABLE.has(task.status) &&
          !PENDING.has(task.status) &&
          !this.#closed
        )
          this.#schedule(id)
      })
    this.#loops.set(id, loop)
  }

  #slotFree(node: string): boolean {
    return (this.#slots.get(node) ?? 0) < MAX_RUNNING_PER_NODE
  }

  /**
   * A worker-turn slot on `node`. Released with a waiter queued, the slot is
   * handed straight to it and the count never drops, so a loop that comes
   * straight back for another turn queues behind the others instead of
   * slipping in before the waiter it just woke has counted itself.
   */
  async #slot(node: string): Promise<() => void> {
    if (this.#slotFree(node))
      this.#slots.set(node, (this.#slots.get(node) ?? 0) + 1)
    else
      await new Promise<void>(resolve => {
        const queue = this.#slotQueue.get(node) ?? []
        queue.push(resolve)
        this.#slotQueue.set(node, queue)
      })
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.#slotQueue.get(node)?.shift()
      if (next !== undefined) next()
      else this.#slots.set(node, Math.max(0, (this.#slots.get(node) ?? 1) - 1))
    }
  }

  async #pause(id: string, ms: number): Promise<void> {
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, ms)
      timer.unref?.()
      function done() {
        clearTimeout(timer)
        resolve()
      }
      this.#waits.set(id, done)
    })
    this.#waits.delete(id)
  }

  #prompt(task: TaskRecord, fresh: boolean): string {
    const parts = [`后台任务 ${task.id}：${task.title}`, task.instructions]
    if (fresh) {
      parts.unshift(WORKER_INSTRUCTIONS)
      if (task.context.length > 0)
        parts.push(
          `主会话最近的消息（引用资料，用于理解指代）：\n${JSON.stringify(task.context)}`,
        )
    }
    if (task.turns > 1 || !fresh)
      parts.push(
        '继续同一持久会话。先检查上次工具调用、实际文件或外部操作的状态，核实后接着做，避免重复执行。',
      )
    if (task.progress) parts.push(`持久检查点：${task.progress}`)
    if (task.lastError) parts.push(`上次中断：${task.lastError}`)
    if (task.requestedState)
      parts.push(
        `上一轮报告了 ${task.requestedState}，但那一轮没有正常结束；这不是已确认的终态。请先核实实际结果，再明确重新 qianmo_task_report。`,
      )
    const unread = this.#unread(task)
    if (unread.length > 0)
      parts.push(
        `尚未确认的用户补充（先调用 qianmo_task_updates 读取并确认）：${JSON.stringify(unread.map(one => ({ id: one.id, message: one.message })))}`,
      )
    parts.push(
      '执行剩余工作，用 qianmo_task_report 汇报阶段；完成后明确报告 completed。',
    )
    return parts.join('\n\n')
  }

  /** A refused dispatch step, and whether retrying could help. */
  async #refused(
    response: Response,
    fallback: string,
  ): Promise<{ readonly error: string; readonly permanent: boolean }> {
    return {
      error: (await refusal(response)).error ?? fallback,
      permanent: PERMANENT_REFUSALS.has(response.status),
    }
  }

  /** Opens (or reuses) the worker conversation; true when it is new. */
  async #session(
    task: TaskRecord,
    dispatch: ChatDispatch,
  ): Promise<
    | { id: string; transcript: ChatTranscript; fresh: boolean }
    | { readonly error: string; readonly permanent: boolean }
  > {
    if (task.workerSession !== null) {
      const known = await this.#options.chat.transcript(task.workerSession)
      if (known.ok && known.value.session.target === task.target) {
        const claimed = dispatch.claimSession(task.workerSession)
        if (claimed) return this.#refused(claimed, '子会话不可用')
        return { id: task.workerSession, transcript: known.value, fresh: false }
      }
    }
    const opened = await dispatch.open(task.target)
    if (opened instanceof Response)
      return this.#refused(opened, '没能开启子会话')
    if (!opened.ok) return { error: '没能开启子会话', permanent: false }
    this.#patch(task.id, { workerSession: opened.value.id })
    const transcript = await this.#options.chat.transcript(opened.value.id)
    if (!transcript.ok) return { error: '子会话记录不可用', permanent: false }
    return { id: opened.value.id, transcript: transcript.value, fresh: true }
  }

  async #execute(id: string): Promise<void> {
    const ttl = this.#options.turnTtlMs ?? DEFAULT_TURN_TTL_MS
    let failures = 0
    while (!this.#closed) {
      let task = this.#tasks.get(id)
      if (task === undefined || !RESUMABLE.has(task.status)) break
      const node = parseAddress(task.target)?.node ?? task.target
      // Waiting for the node's one worker turn reads as waiting, not running.
      if (task.status === 'running' && !this.#slotFree(node))
        task = this.#patch(id, { status: 'queued' })
      const release = await this.#slot(node)
      let outcome: TurnOutcome = { ok: false }
      const before = task
      try {
        task = this.#tasks.get(id)
        if (task === undefined || !RESUMABLE.has(task.status) || this.#closed)
          break
        const dispatch = this.#dispatch(task.owner)
        if (typeof dispatch === 'string') {
          outcome = { ok: false, error: dispatch, permanent: true }
        } else {
          const quota = dispatch.preflightUsage(task.target, task.workerSession)
          const denied = quota ?? (await dispatch.authorizeTarget(task.target))
          const session = denied
            ? await this.#refused(denied, '不能派给这个智能体')
            : await this.#session(task, dispatch)
          // Cancelled or closed while this turn was being authorised and its
          // session opened: never write `running` over that.
          task = this.#tasks.get(id)
          if (task === undefined || !RESUMABLE.has(task.status) || this.#closed)
            break
          if ('error' in session)
            outcome = {
              ok: false,
              error: session.error,
              permanent: session.permanent,
            }
          else {
            // A turn the hub never saw end (a restart, a local timeout) is
            // stopped first, or the next one would queue behind it.
            if (task.nodeTaskId !== null) {
              await this.#options
                .stopTask?.(task.target, task.nodeTaskId)
                .catch(() => false)
              task = this.#patch(id, { nodeTaskId: null })
            }
            task = this.#patch(id, {
              status: 'running',
              requestedState: '',
              turns: task.turns + 1,
            })
            const prompt = this.#prompt(
              { ...task, requestedState: before.requestedState },
              session.fresh,
            )
            const turn: {
              target: string
              taskId: string | null
              handle: ChatTurnHandle
            } = {
              target: task.target,
              taskId: null,
              handle: sendAndWait({
                chat: this.#options.chat,
                dispatch,
                target: task.target,
                input: {
                  sessionId: session.id,
                  text: prompt,
                  taskTtlMs: ttl,
                  background: true,
                },
                baseline: new Set(session.transcript.turns.map(one => one.id)),
                now: this.#now,
                timeoutMs: ttl + TURN_WAIT_SLACK_MS,
                onTask: taskId => {
                  turn.taskId = taskId
                  const now = this.#tasks.get(id)
                  // Cancelled or closed while the line was on its way: the
                  // cancel had no node task to stop yet, so stop it here.
                  if (
                    this.#closed ||
                    now === undefined ||
                    TERMINAL.has(now.status)
                  ) {
                    void this.#options
                      .stopTask?.(turn.target, taskId)
                      .catch(() => false)
                    return
                  }
                  this.#patch(id, { nodeTaskId: taskId })
                },
              }),
            }
            this.#turns.set(id, turn)
            const result = await turn.handle.outcome
            this.#turns.delete(id)
            if (
              result.answered &&
              this.#tasks.get(id)?.nodeTaskId === turn.taskId
            )
              this.#patch(id, { nodeTaskId: null })
            outcome = {
              ok: result.ok,
              ...(result.error === undefined ? {} : { error: result.error }),
              ...(result.cancelled ? { cancelled: true } : {}),
              ...(result.refusedStatus !== undefined &&
              PERMANENT_REFUSALS.has(result.refusedStatus)
                ? { permanent: true }
                : {}),
            }
          }
        }
      } finally {
        release()
      }
      task = this.#tasks.get(id)
      if (task === undefined || !RESUMABLE.has(task.status) || this.#closed)
        break
      if (outcome.ok && PENDING.has(task.status)) {
        this.#patch(id, {
          status:
            task.requestedState === 'completed' ? 'completed' : 'needs_input',
          requestedState: '',
          notification: 'pending',
        })
        break
      }
      if (outcome.ok) {
        failures = 0
        const quiet =
          task.progress === before.progress ? task.quietTurns + 1 : 0
        if (quiet >= MAX_QUIET_TURNS) {
          this.#patch(id, {
            status: 'needs_input',
            quietTurns: 0,
            result: `子任务连续 ${MAX_QUIET_TURNS} 轮没有用 qianmo_task_report 汇报进展，已暂停。可以追加指示让它继续。`,
            notification: 'pending',
          })
          break
        }
        this.#patch(id, { quietTurns: quiet })
        continue
      }
      failures++
      this.#patch(id, {
        status: outcome.cancelled ? 'interrupted' : task.status,
        lastError: clip(
          outcome.error ??
            (outcome.cancelled
              ? '子会话被中断，将核实后恢复'
              : '子会话意外结束'),
          1_000,
        ),
      })
      if (outcome.permanent) {
        this.#patch(id, {
          status: 'needs_input',
          result: `子任务已暂停：${clip(outcome.error ?? '派发被拒绝', 300)}。处理之后追加一条指示即可继续。`,
          notification: 'pending',
        })
        break
      }
      if (failures >= MAX_FAILURES) {
        this.#patch(id, {
          status: 'needs_input',
          result: `子任务连续 ${MAX_FAILURES} 轮失败，已暂停。最近的错误：${clip(outcome.error ?? '未知', 300)}`,
          notification: 'pending',
        })
        break
      }
      await this.#pause(
        id,
        (this.#options.backoffMs ?? defaultBackoff)(failures),
      )
    }
    const task = this.#tasks.get(id)
    if (
      task &&
      (task.status === 'completed' || task.status === 'needs_input') &&
      task.notification === 'pending'
    )
      await this.#notify(id)
  }

  // -- results ----------------------------------------------------------------

  async #notify(id: string): Promise<void> {
    const task = this.#tasks.get(id)
    if (task === undefined || task.notification !== 'pending') return
    const label = task.status === 'completed' ? '已完成' : '需要你的补充'
    const text = `${task.title}：${label}\n\n${task.result}`
    this.#patch(id, { notification: 'sending' })
    let delivered = false
    let failed = false
    const noted = await this.#options.chat.note?.(task.parentSession, text)
    if (noted?.ok) delivered = true
    for (const listener of this.#listeners) {
      const sent = await listener({
        parentSession: task.parentSession,
        taskId: id,
        text,
      }).catch(() => false)
      if (sent === true) delivered = true
      if (sent === false) failed = true
    }
    this.#patch(id, { notification: delivered && !failed ? 'sent' : 'failed' })
  }
}
