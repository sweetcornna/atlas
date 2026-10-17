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

/** One place a result goes; `skipped` is a listener it was not for. */
const DELIVERY_STATES = [
  'sending',
  'sent',
  'failed',
  'unknown',
  'skipped',
] as const
type DeliveryState = (typeof DELIVERY_STATES)[number]

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
任务没有总时长或总轮数上限，保持执行直到完成，或确实需要用户补充信息；单轮有时间上限，到点会被停下。
每一轮只推进一个阶段：做完一个阶段就调用 qianmo_task_report(state='working', summary=真实进展、证据和下一步)，然后结束本轮回复。任务管理器会在同一会话里接着叫你，主会话也借这个空档及时回应用户。
任务实际完成并验证后，必须调用 qianmo_task_report(state='completed', summary=最终结果及验证证据)。
只有缺少必需的信息或授权、无法继续时，才调用 qianmo_task_report(state='needs_input', summary=具体问题)。
普通的最终回复、承诺「继续」都不代表任务完成。
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
  /**
   * The node accepted a prompt carrying the worker rules and the task. Absent
   * in a ledger older than the field: a worker session there means the first
   * prompt went out. Until then every prompt carries them, so a first line
   * that never arrived is not taken for a briefing.
   */
  briefed: z.boolean().optional(),
  /** The turn whose prompt last carried the rules and the task. */
  briefedTurn: z.number().int().nonnegative().default(0),
  /** The checkpoint as the worker last saw it in a prompt. */
  promptedProgress: z.string().default(''),
  /** The previous turn ended abnormally: the next one verifies first. */
  abnormal: z.boolean().default(false),
  /** The runtime compacted the worker's context: brief it again. */
  rebrief: z.boolean().default(false),
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
  /**
   * The result's delivery to each place it goes: `note` for the parent's
   * transcript, then each {@link ConsoleTasks.onFinished} listener by key.
   * Only a `failed` one is tried again; one cut off mid-send is `unknown`.
   */
  deliveries: z.record(z.string(), z.enum(DELIVERY_STATES)).default({}),
  /** Delivery rounds for the current result; zero for a ledger without it. */
  deliveryAttempts: z.number().int().nonnegative().default(0),
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
  /** How long to wait before delivering a result again; tests shorten it. */
  readonly deliveryRetryMs?: (attempts: number) => number
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
/** The worker rules and the task go out again every this many turns. */
const BRIEF_EVERY_TURNS = 10
/** Delivery rounds for one result before a failed place is given up. */
const MAX_DELIVERY_ATTEMPTS = 5
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
  readonly compacted?: boolean
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

/**
 * Paragraphs the host adds to a foreground line ahead of what was said: the
 * channel framing and channel prompt (P28), the coordination rule and the
 * task note. Each is one paragraph (`gateway.ts` keeps the channel prompt so).
 */
const FRAME_MARKERS = [
  '[渠道]',
  '[渠道说明]',
  '[后台任务协调规则]',
  '[当前会话的后台任务]',
] as const

/**
 * What a foreground line said, for a worker's context: the host's framing
 * paragraphs dropped and, when still long, the end kept, since the words come
 * after the frames.
 */
function spoken(text: string, length: number): string {
  const said = text
    .split(/\n[ \t]*\n/)
    .filter(
      paragraph =>
        !FRAME_MARKERS.some(marker => paragraph.trimStart().startsWith(marker)),
    )
    .join('\n\n')
    .trim()
  const chars = [...said]
  return chars.length <= length ? said : `…${chars.slice(-length).join('')}`
}

/** Seconds to wait after the n-th consecutive failure (grantley `_retry_wait`). */
function defaultBackoff(failures: number): number {
  return Math.min(60_000, 2 ** Math.min(failures, 6) * 1_000)
}

/** 1, 4, 16 then 30 minutes between delivery rounds. */
function defaultDeliveryRetry(attempts: number): number {
  return Math.min(30 * 60_000, 4 ** (attempts - 1) * 60_000)
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
  /** Tasks this process resumed from the ledger, until their first prompt. */
  readonly #resumed = new Set<string>()
  /** Worker turns in flight by node; see {@link MAX_RUNNING_PER_NODE}. */
  readonly #slots = new Map<string, number>()
  readonly #slotQueue = new Map<string, (() => void)[]>()
  readonly #listeners = new Map<
    string,
    (event: TaskFinished) => Promise<boolean | undefined>
  >()
  #listenerSeq = 0
  /** Results being delivered, and the timers of the next delivery round. */
  readonly #delivering = new Set<string>()
  readonly #redeliveries = new Map<string, ReturnType<typeof setTimeout>>()
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
      if (task.notification === 'sending') {
        // A place cut off mid-send may or may not have it: never send it
        // twice. Places that had failed are still owed.
        const deliveries = Object.fromEntries(
          Object.entries(task.deliveries).map(([key, state]) => [
            key,
            state === 'sending' ? ('unknown' as const) : state,
          ]),
        )
        const failed = Object.values(deliveries).includes('failed')
        const next = this.#patch(task.id, {
          deliveries,
          notification: failed ? 'failed' : 'unknown',
        })
        if (this.#redeliverable(next)) this.#redeliverLater(next)
      } else if (this.#redeliverable(task)) this.#redeliverLater(task)
      if (RESUMABLE.has(task.status)) {
        this.#resumed.add(task.id)
        this.#schedule(task.id)
      } else if (
        (task.status === 'completed' || task.status === 'needs_input') &&
        task.notification === 'pending'
      )
        void this.#notify(task.id)
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const timer of this.#redeliveries.values()) clearTimeout(timer)
    this.#redeliveries.clear()
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

  /**
   * Channels deliver results to the chat a task came from. The listener
   * answers true (delivered), false (failed; tried again later) or undefined
   * (not its conversation). `key` names it in the ledger's delivery record,
   * so a restart retries only the places that failed.
   */
  onFinished(
    listener: (event: TaskFinished) => Promise<boolean | undefined>,
    key = `listener-${++this.#listenerSeq}`,
  ): () => void {
    this.#listeners.set(key, listener)
    return () => this.#listeners.delete(key)
  }

  /**
   * Delivers now the results whose last round failed somewhere, without
   * waiting for the next round. Channels call it once an adapter is up.
   */
  retryNotifications(): void {
    for (const task of this.#tasks.values())
      if (this.#redeliverable(task)) {
        clearTimeout(this.#redeliveries.get(task.id))
        this.#redeliveries.delete(task.id)
        void this.#notify(task.id)
      }
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
      briefed: false,
      briefedTurn: 0,
      promptedProgress: '',
      abnormal: false,
      rebrief: false,
      quietTurns: 0,
      readUpdateId: 0,
      notification: 'none',
      deliveries: {},
      deliveryAttempts: 0,
      context: caller.transcript.turns
        .filter(turn => turn.variant !== 'notice')
        .map(turn => ({
          role:
            turn.author === 'operator' ? ('user' as const) : ('agent' as const),
          text: spoken(turn.text, 1_500),
        }))
        .filter(turn => turn.text !== '')
        .slice(-6),
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
    const progress = clip(summary, 8_000)
    this.#patch(task.id, {
      progress,
      lastError: '',
      status:
        state === 'working'
          ? 'running'
          : state === 'completed'
            ? 'completion_pending'
            : 'needs_input_pending',
      requestedState: state === 'working' ? '' : state,
      // The same words again are no progress: the quiet count goes on.
      quietTurns: progress === task.progress ? task.quietTurns : 0,
      ...(state === 'working'
        ? {}
        : { result: clip(summary, 8_000), notification: 'none' as const }),
    })
    // Spares the worker a qianmo_task_updates call that would find nothing.
    const newUpdates = this.#unread(task).filter(
      one => one.id > task.readUpdateId,
    ).length
    return ok({ state, newUpdates })
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

  /**
   * Whether this turn's prompt carries the worker rules and the task: until a
   * briefing was accepted, after a restart, in a new session, after the
   * runtime compacted the session, and every {@link BRIEF_EVERY_TURNS} turns.
   * Other turns carry only what changed, so a long task does not resend the
   * same few thousand characters every turn.
   */
  #briefing(task: TaskRecord, fresh: boolean, resumed: boolean): boolean {
    const briefed = task.briefed ?? task.workerSession !== null
    return (
      fresh ||
      !briefed ||
      resumed ||
      task.rebrief ||
      task.turns - task.briefedTurn >= BRIEF_EVERY_TURNS
    )
  }

  /**
   * One worker turn's prompt. The first line names the task, so the session
   * reads as that task wherever it is listed.
   */
  #prompt(
    task: TaskRecord,
    turn: {
      readonly brief: boolean
      readonly fresh: boolean
      readonly resumed: boolean
    },
  ): string {
    const parts = [`后台任务：${task.title}（${task.id}）`]
    if (turn.brief) {
      parts.push(WORKER_INSTRUCTIONS, `任务说明：\n${task.instructions}`)
      // The main session's words, for what "it" and "that" refer to: the
      // session has them once it was briefed, unless compaction dropped them.
      if (
        task.context.length > 0 &&
        (turn.fresh || task.briefed !== true || task.rebrief)
      )
        parts.push(
          `主会话最近的消息（引用资料，用于理解指代）：\n${JSON.stringify(task.context)}`,
        )
    }
    if (task.abnormal || turn.resumed)
      parts.push(
        '上一轮没有正常结束，或任务管理器重启过。先检查上次工具调用、实际文件或外部操作的状态，核实后接着做，避免重复执行。',
      )
    if (
      task.progress &&
      (turn.brief || turn.resumed || task.progress !== task.promptedProgress)
    )
      parts.push(`持久检查点：${task.progress}`)
    if (task.lastError && (task.abnormal || turn.resumed))
      parts.push(`上次中断：${task.lastError}`)
    if (task.requestedState)
      parts.push(
        `上一轮报告了 ${task.requestedState}，但那一轮没有正常结束；这不是已确认的终态。请先核实实际结果，再明确重新 qianmo_task_report。`,
      )
    const unread = this.#unread(task)
    if (unread.length > 0)
      parts.push(
        `有 ${unread.length} 条尚未确认的用户补充（编号 ${unread.map(one => one.id).join('、')}），先调用 qianmo_task_updates 读取并确认。`,
      )
    parts.push(
      turn.brief
        ? '执行剩余工作，每完成一个阶段用 qianmo_task_report 汇报并结束本轮；完成后明确报告 completed。'
        : '继续下一个阶段；做完就用 qianmo_task_report 汇报并结束本轮，完成后明确报告 completed。',
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
            const resumed = this.#resumed.delete(id)
            const brief = this.#briefing(task, session.fresh, resumed)
            const prompt = this.#prompt(
              { ...task, requestedState: before.requestedState },
              { brief, fresh: session.fresh, resumed },
            )
            const prompted = {
              promptedProgress: task.progress,
              ...(brief
                ? { briefed: true, briefedTurn: task.turns, rebrief: false }
                : {}),
            }
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
                  // Accepted by the node: now the worker has seen it.
                  this.#patch(id, { nodeTaskId: taskId, ...prompted })
                },
              }),
            }
            this.#turns.set(id, turn)
            const result = await turn.handle.outcome
            this.#turns.delete(id)
            // The node never took this line: the restart note still owes.
            if (resumed && turn.taskId === null) this.#resumed.add(id)
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
              ...(result.compacted ? { compacted: true } : {}),
            }
          }
        }
      } finally {
        release()
      }
      task = this.#tasks.get(id)
      if (task === undefined || !RESUMABLE.has(task.status) || this.#closed)
        break
      if (outcome.compacted) task = this.#patch(id, { rebrief: true })
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
            result: `子任务连续 ${MAX_QUIET_TURNS} 轮没有用 qianmo_task_report 汇报新的进展，已暂停。可以追加指示让它继续。`,
            notification: 'pending',
          })
          break
        }
        this.#patch(id, { quietTurns: quiet, abnormal: false })
        continue
      }
      failures++
      this.#patch(id, {
        status: outcome.cancelled ? 'interrupted' : task.status,
        abnormal: true,
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

  /** A result whose last round failed somewhere, with rounds left. */
  #redeliverable(task: TaskRecord): boolean {
    return (
      task.notification === 'failed' &&
      (task.status === 'completed' || task.status === 'needs_input') &&
      task.deliveryAttempts > 0 &&
      task.deliveryAttempts < MAX_DELIVERY_ATTEMPTS
    )
  }

  #redeliverLater(task: TaskRecord): void {
    if (this.#closed || this.#redeliveries.has(task.id)) return
    const timer = setTimeout(
      () => {
        this.#redeliveries.delete(task.id)
        void this.#notify(task.id)
      },
      (this.#options.deliveryRetryMs ?? defaultDeliveryRetry)(
        task.deliveryAttempts,
      ),
    )
    timer.unref?.()
    this.#redeliveries.set(task.id, timer)
  }

  /**
   * Delivers a result to the parent's transcript and to every listener, each
   * place recorded on its own: a later round (a timer, a channel coming up,
   * a restart) goes only where the last one failed, never where it arrived
   * or may have arrived.
   */
  async #notify(id: string): Promise<void> {
    const task = this.#tasks.get(id)
    if (task === undefined || this.#closed || this.#delivering.has(id)) return
    const first = task.notification === 'pending'
    if (!first && !this.#redeliverable(task)) return
    this.#delivering.add(id)
    try {
      const label = task.status === 'completed' ? '已完成' : '需要你的补充'
      const text = `${task.title}：${label}\n\n${task.result}`
      const deliveries: Record<string, DeliveryState> = first
        ? {}
        : { ...task.deliveries }
      const attempts = (first ? 0 : task.deliveryAttempts) + 1
      this.#patch(id, {
        notification: 'sending',
        deliveries: { ...deliveries },
        deliveryAttempts: attempts,
      })
      const deliver = async (
        key: string,
        send: () => Promise<boolean | undefined>,
      ) => {
        if (deliveries[key] !== undefined && deliveries[key] !== 'failed')
          return
        deliveries[key] = 'sending'
        this.#patch(id, { deliveries: { ...deliveries } })
        const sent = await send().catch(() => false)
        deliveries[key] =
          sent === true ? 'sent' : sent === false ? 'failed' : 'skipped'
        this.#patch(id, { deliveries: { ...deliveries } })
      }
      const note = this.#options.chat.note?.bind(this.#options.chat)
      if (note)
        await deliver(
          'note',
          async () => (await note(task.parentSession, text)).ok,
        )
      for (const [key, listener] of [...this.#listeners])
        await deliver(key, () =>
          listener({ parentSession: task.parentSession, taskId: id, text }),
        )
      const states = Object.values(deliveries)
      const next = this.#patch(id, {
        notification: states.includes('failed')
          ? 'failed'
          : states.includes('unknown')
            ? 'unknown'
            : states.includes('sent')
              ? 'sent'
              : 'failed',
      })
      if (states.includes('failed') && this.#redeliverable(next))
        this.#redeliverLater(next)
    } finally {
      this.#delivering.delete(id)
    }
  }
}
