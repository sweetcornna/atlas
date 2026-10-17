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
 * A task can also be planned (主动任务): its first run after a delay or at a
 * time, and repeats at an interval a set number of times. It waits as
 * `scheduled`, holding no place among a conversation's running tasks; when a
 * run is due it queues like any task, in the same worker session each time,
 * and every run's result goes back the same way.
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
  type BackgroundTaskReader,
  type BackgroundTasksPort,
  type BackgroundTaskView,
  ChatDispatch,
  type ChatPort,
  type ChatTranscript,
  type ChatTurn,
  type ConsoleAccounts,
  type ConsoleResult,
  type DirectionActor,
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
  'scheduled',
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
  scheduled: '已安排',
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

/**
 * The coordination rule for a foreground conversation (grantley
 * `turn_context`): the main session stays free, does what one or two steps
 * finish, hands longer work to its own sub-session and simple slow work to
 * another agent, and plans ahead. One paragraph, so a worker's context drops
 * it; the tool descriptions (`host/taskTools.ts`) carry the same rules to a
 * console conversation, which gets no channel framing.
 */
export const SUPERVISOR_RULES = [
  '[后台任务协调规则] 你是主会话，始终保持空闲，随时能接主人的下一句。',
  '一两步能完成的（直接回答、澄清、查一项、一次简单的工具调用、读一个文件）当场做完，不开任务。',
  '预计要多步或较久（大约超过一两分钟）、要研究、写或改代码、跑长命令、反复试的，立即用 qianmo_task_start 不带 agent 交给你自己的子会话，拿到任务号就回复主人，不在主会话里等它。',
  '简单但耗时的活（机械、边界清楚：批量整理、按清单核对、汇总资料、等一个结果再检查）可以带 agent 交给名册里的其他智能体：先用 qianmo_task_agents 看有谁、谁闲、用什么底层与模型，优先闲的、便宜的。',
  '主动安排：能拆成互不依赖的几块就分别开任务并行；得知一个任务完成后主动判断下一步，接着开或问主人；需要过一段时间回看或周期性做的事，用 qianmo_task_start 的 after 或 at、everyMinutes 与 times 安排成延时或重复的任务，并告诉主人安排了什么、什么时候。',
  '主人催问时用 qianmo_task_status 报告真实阶段，用 qianmo_task_send 传递补充指示。只有子智能体明确报告 completed 才能说完成。主人的新消息不会取消正在运行的后台任务。',
].join('\n')

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
  /**
   * A delayed or repeating task (主动任务): when the next run starts, the
   * time repeats are counted from, how often and how many times, and the runs
   * started so far. Null for a task that runs once, at once.
   */
  plan: z
    .object({
      nextAt: z.number(),
      anchor: z.number(),
      everyMinutes: z.number().int().positive().nullable(),
      times: z.number().int().positive(),
      runs: z.number().int().nonnegative(),
    })
    .nullable()
    .default(null),
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
  /**
   * Tasks waiting for their next run (`scheduled`), kept apart from `tasks`:
   * a hub from before 主动任务 ignores this key instead of refusing a status
   * it does not know, so rolling back loses the plans, not the ledger.
   */
  scheduled: z.array(recordSchema).default([]),
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
  /** A planned task's next start (ISO, UTC); only while it is `scheduled`. */
  readonly nextAt?: string
  /**
   * A repeating task: how often, and the runs not started yet (null once it
   * has ended, as in the console's list).
   */
  readonly everyMinutes?: number
  readonly runsLeft?: number | null
  /** Due, but its conversation has eight in flight: it starts when one ends. */
  readonly waitingForPlace?: true
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
  /** True for a schedule's session (P24): its turns start no tasks. */
  readonly scheduled?: (sessionId: string) => boolean
  /** Sessions that are the same conversation (a chat after `/new`); tasks follow it. */
  readonly related?: (sessionId: string) => readonly string[]
  /**
   * What the hub knows of an agent's runtime and model, for
   * `qianmo_task_agents` ({@link AgentProfiles}); either may be absent.
   */
  readonly profile?: (address: string) => Promise<AgentProfile>
  /**
   * One worker turn's deadline (`taskTtlMs`); approvals asked for in the
   * turn expire with it. Default 30 minutes.
   */
  readonly turnTtlMs?: number
  /** How long to wait after a failed turn; tests shorten it. */
  readonly backoffMs?: (failures: number) => number
  /** How long to wait before delivering a result again; tests shorten it. */
  readonly deliveryRetryMs?: (attempts: number) => number
  /**
   * How long one place may take to take a result before it is given up as
   * `unknown` (default {@link DELIVERY_TIMEOUT_MS}); tests shorten it.
   */
  readonly deliveryTimeoutMs?: number
  readonly onError?: (message: string) => void
}

/**
 * Unfinished tasks per conversation, not counting those waiting for input or
 * for their planned start.
 */
const MAX_ACTIVE_PER_PARENT = 8
/**
 * 主动任务: the first run at most a week ahead; a repeat every 30 minutes to
 * a week, at most 100 times; at most 20 planned tasks per owner at once.
 */
const MAX_DELAY_MINUTES = 7 * 24 * 60
const MIN_EVERY_MINUTES = 30
const MAX_EVERY_MINUTES = 7 * 24 * 60
const MAX_TIMES = 100
const MAX_PLANNED_PER_OWNER = 20
/** How often the hub looks for planned runs that are due. */
const TICK_MS = 15_000
/** `at`: an ISO time with its zone. */
const ZONED_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/
/** How long a finished task still answers a status question. */
const RECENTLY_MS = 10 * 60_000
/** Finished tasks stay in the ledger this long, and this many per owner. */
const KEEP_FINISHED_MS = 30 * 24 * 60 * 60_000
const KEEP_FINISHED_PER_OWNER = 200
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
 * One place's answer to a delivery. A channel's requests time out at 30 s
 * each, but a long result goes in several, a rate limit waits, and a
 * listener may be anything: past this the place is given up as `unknown`
 * (it may have the result; it is not sent again), so a stuck place cannot
 * hold a repeat's next run (see {@link ConsoleTasks.tick}) for ever.
 */
const DELIVERY_TIMEOUT_MS = 5 * 60_000
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

/** An optional tool argument a model left empty is not given. */
function given(value: unknown): unknown {
  return value === null || (typeof value === 'string' && value.trim() === '')
    ? undefined
    : value
}

/**
 * A whole number from a tool argument — a number, or digits a model sent as
 * text; undefined when absent, null when it is something else.
 */
function whole(raw: unknown): number | undefined | null {
  const value = given(raw)
  if (value === undefined) return undefined
  if (typeof value === 'number') return Number.isInteger(value) ? value : null
  if (typeof value === 'string' && /^\d{1,6}$/.test(value.trim()))
    return Number(value.trim())
  return null
}

/**
 * An `at` as epoch milliseconds: undefined when it is not an ISO time with
 * its zone, null when it names a day or time that does not exist (11-31,
 * 24:00, an offset of 08:60). `Date.parse` moves such a day to the next one;
 * the date and time are read back in the zone given and must be the ones
 * written.
 */
function zonedTime(text: string): number | null | undefined {
  const match = ZONED_TIME.exec(text)
  if (match === null) return undefined
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) return null
  const offset =
    match[7] === 'Z'
      ? 0
      : (match[8] === '-' ? -1 : 1) *
        (Number(match[9]) * 60 + Number(match[10]))
  const local = new Date(parsed + offset * 60_000)
  const written = [match[1], match[2], match[3], match[4], match[5], match[6]]
  const read = [
    local.getUTCFullYear(),
    local.getUTCMonth() + 1,
    local.getUTCDate(),
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
  ]
  return written.every(
    (part, index) => part === undefined || Number(part) === read[index],
  )
    ? parsed
    : null
}

type Plan = NonNullable<TaskRecord['plan']>

/** A repeat's next start after `now`: the times a run outlasted are skipped. */
function nextSlot(plan: Plan, now: number): number {
  const every = (plan.everyMinutes ?? 0) * 60_000
  if (every <= 0) return now
  const k = Math.max(1, Math.floor((now - plan.anchor) / every) + 1)
  return plan.anchor + k * every
}

/** `10-18 09:00 UTC+8`: the hub's clock with its zone, for people to read. */
function wallClock(at: number): string {
  const date = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const zone =
    offset === 0
      ? 'UTC'
      : `UTC${offset > 0 ? '+' : '-'}${Math.floor(Math.abs(offset) / 60)}${
          Math.abs(offset) % 60 === 0 ? '' : `:${two(Math.abs(offset) % 60)}`
        }`
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())} ${zone}`
}

/** Seconds to wait after the n-th consecutive failure (grantley `_retry_wait`). */
const LATE = Symbol('late')

/** `work`'s value, or {@link LATE} when it takes longer than `ms`. */
async function within<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | typeof LATE> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<typeof LATE>(resolve => {
        timer = setTimeout(() => resolve(LATE), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function defaultBackoff(failures: number): number {
  return Math.min(60_000, 2 ** Math.min(failures, 6) * 1_000)
}

/** 1, 4, 16 then 30 minutes between delivery rounds. */
function defaultDeliveryRetry(attempts: number): number {
  return Math.min(30 * 60_000, 4 ** (attempts - 1) * 60_000)
}

/** The task note a console line carries, and the mark that it went out. */
export interface TaskNote {
  readonly text: string
  /** The line carrying it was accepted: later notes carry only what changed. */
  sent(): void
}

/**
 * A foreground turn longer than this, or with more tool steps, earns the
 * next turn a reminder to hand long work to a task (保持空闲).
 */
const LONG_TURN_MS = 90_000
const LONG_TURN_STEPS = 10

interface FinishedTurn {
  readonly taskId: string
  readonly compacted: boolean
  /**
   * From when the node took the line (its queue is not this turn's work) to
   * the answer; 0 when the node never acknowledged it (the dial failed, or
   * the chat face's own deadline ran out): that wait was not work done here.
   */
  readonly ms: number
  /** Tool calls the node reported starting (`noticeSource: 'step'`). */
  readonly steps: number
  /** The line was a local command (`/compact` …), not a turn of the model. */
  readonly command: boolean
}

/** A conversation's last finished turn: how long it worked and its tool steps. */
function lastTurn(turns: readonly ChatTurn[]): FinishedTurn | undefined {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!
    if (
      turn.author !== 'agent' ||
      turn.variant === 'notice' ||
      turn.taskId === undefined ||
      (turn.state !== 'done' && turn.state !== 'failed')
    )
      continue
    const taskId = turn.taskId
    const asked = turns.find(
      one => one.author === 'operator' && one.taskId === taskId,
    )
    const read = asked?.readMs
    return {
      taskId,
      compacted: turn.compacted === true,
      ms:
        asked === undefined || read === undefined
          ? 0
          : Math.max(0, turn.at - (asked.at + read)),
      steps: turns.filter(
        one =>
          one.variant === 'notice' &&
          one.noticeSource === 'step' &&
          one.causeTaskId === taskId &&
          one.severity !== 'warn',
      ).length,
      command: asked?.command !== undefined || turn.command !== undefined,
    }
  }
  return undefined
}

/** 「上一轮主会话用了 3 分钟、14 个工具步骤，长活交给后台任务。」 */
function reminderText(turn: FinishedTurn): string {
  const time =
    turn.ms < 120_000
      ? `${Math.round(turn.ms / 1_000)} 秒`
      : `${Math.round(turn.ms / 60_000)} 分钟`
  const steps = turn.steps > 0 ? `、${turn.steps} 个工具步骤` : ''
  return `提醒：上一轮主会话用了 ${time}${steps}，长活交给后台任务，主会话保持空闲。`
}

/**
 * The task note's one paragraph: the tasks, then the reminder on a line of
 * its own; a reminder alone still opens with the note's marker, so a
 * worker's context drops it.
 */
export function taskNote(
  summary: string | undefined,
  reminder: string | undefined,
): string | undefined {
  if (reminder === undefined) return summary
  return summary === undefined
    ? `[当前会话的后台任务] ${reminder}`
    : `${summary}\n${reminder}`
}

/**
 * The console's chat port with the task note put ahead of each line a
 * person sends in a foreground conversation (`ChatSendInput.context`), the
 * note a channel turn carries. Background, command and continuation lines go
 * as they are; so does a line whose note cannot be had (`onError` hears
 * why), so the person's words are never lost to it.
 */
export function withTaskNotes(
  chat: ChatPort,
  tasks: Pick<ConsoleTasks, 'noteFor'>,
  onError?: (message: string) => void,
): ChatPort {
  const note = chat.note?.bind(chat)
  return {
    targets: () => chat.targets(),
    sessions: () => chat.sessions(),
    open: target => chat.open(target),
    transcript: sessionId => chat.transcript(sessionId),
    subscribe: listener => chat.subscribe(listener),
    ...(note === undefined ? {} : { note }),
    async send(input) {
      const plain =
        input.background === true ||
        input.command !== undefined ||
        input.continuation !== undefined ||
        input.context !== undefined
      let extra: TaskNote | undefined
      if (!plain)
        try {
          extra = await tasks.noteFor(input.sessionId)
        } catch (error) {
          onError?.(
            `后台任务附注失败：${String((error as Error)?.message ?? error)}`,
          )
        }
      const result = await chat.send(
        extra === undefined ? input : { ...input, context: extra.text },
      )
      if (result.ok) extra?.sent()
      return result
    },
  }
}

interface Caller {
  readonly transcript: ChatTranscript
  readonly owner: string
  readonly worker: TaskRecord | undefined
}

/** An agent's runtime and model as far as the hub knows them. */
export interface AgentProfile {
  readonly runtime?: 'qianmopi' | 'claude-code' | 'codex'
  readonly model?: string
}

/** Rows `qianmo_task_agents` lists at most. */
const MAX_AGENTS_LISTED = 50
/** How long a node's answer about its agents is kept, and a failed one. */
const PROFILE_TTL_MS = 5 * 60_000
const PROFILE_RETRY_MS = 60_000

const pingSchema = z.object({
  runtimes: z.record(z.string(), z.string()).optional(),
  models: z.record(z.string(), z.string()).optional(),
})

interface NodeProfiles {
  readonly at: number
  /** Agent → `omp` / `claude-code` / `codex`; null when the node did not say. */
  readonly runtimes: Readonly<Record<string, string>> | null
  readonly models: Readonly<Record<string, string>>
}

/**
 * Runtimes and models for `qianmo_task_agents`: each node's `node.ping`
 * names its agents' runtimes and an external runtime's model; a qianmopi
 * agent runs the node's model, which the model service knows. Nothing is
 * guessed: a node that did not answer, or an older one, gives neither.
 */
export class AgentProfiles {
  readonly #ping: (node: string) => Promise<ControlOutcome>
  readonly #nodeModel: (node: string) => Promise<string | undefined>
  readonly #now: () => number
  readonly #nodes = new Map<string, NodeProfiles>()
  readonly #asking = new Map<string, Promise<NodeProfiles>>()

  constructor(options: {
    /** `node.ping` over the node's control link. */
    readonly ping: (node: string) => Promise<ControlOutcome>
    /** The model the node's qianmopi agents run, when the hub knows it. */
    readonly nodeModel?: (node: string) => Promise<string | undefined>
    readonly now?: () => number
  }) {
    this.#ping = options.ping
    this.#nodeModel = options.nodeModel ?? (async () => undefined)
    this.#now = options.now ?? Date.now
  }

  async of(address: string): Promise<AgentProfile> {
    const parsed = parseAddress(address)
    if (parsed === null) return {}
    const node = await this.#node(parsed.node)
    const runtime = node.runtimes?.[parsed.agent]
    if (runtime === 'omp') {
      const model = await this.#nodeModel(parsed.node).catch(() => undefined)
      return {
        runtime: 'qianmopi',
        ...(model ? { model: clip(model, 200) } : {}),
      }
    }
    if (runtime !== 'claude-code' && runtime !== 'codex') return {}
    const model = node.models[parsed.agent]
    return { runtime, ...(model ? { model: clip(model, 200) } : {}) }
  }

  async #node(node: string): Promise<NodeProfiles> {
    const known = this.#nodes.get(node)
    const age = known === undefined ? Infinity : this.#now() - known.at
    if (
      known !== undefined &&
      age < (known.runtimes === null ? PROFILE_RETRY_MS : PROFILE_TTL_MS)
    )
      return known
    const asking =
      this.#asking.get(node) ??
      this.#ask(node).finally(() => this.#asking.delete(node))
    this.#asking.set(node, asking)
    return asking
  }

  async #ask(node: string): Promise<NodeProfiles> {
    const outcome = await this.#ping(node).catch(() => null)
    const parsed =
      outcome?.ok === true ? pingSchema.safeParse(outcome.value) : null
    const value: NodeProfiles = {
      at: this.#now(),
      runtimes: parsed?.success ? (parsed.data.runtimes ?? null) : null,
      models: parsed?.success ? (parsed.data.models ?? {}) : {},
    }
    this.#nodes.set(node, value)
    return value
  }
}

export class ConsoleTasks implements BackgroundTasksPort {
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
  /** Looks for planned runs that are due; see {@link tick}. */
  #ticker: ReturnType<typeof setInterval> | null = null
  /** The task note each console conversation was last given; see {@link noteFor}. */
  readonly #noted = new Map<string, { text: string; at: number }>()
  /** The long foreground turn each conversation was last reminded of. */
  readonly #reminded = new Map<string, string>()
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
      for (const task of [...book.tasks, ...book.scheduled])
        this.#tasks.set(task.id, task)
      this.#updates = book.updates
      this.#nextUpdateId = book.nextUpdateId
    }
  }

  /** Resumes unfinished tasks and resends notices a restart cut off. */
  start(): void {
    if (!this.#lock?.owned()) return
    this.#prune()
    this.#save()
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
        (task.status === 'completed' ||
          task.status === 'needs_input' ||
          task.status === 'scheduled') &&
        task.notification === 'pending'
      )
        void this.#notify(task.id)
    }
    // Runs that came due while the hub was down start now, once each.
    this.tick()
    this.#ticker = setInterval(() => this.tick(), TICK_MS)
    this.#ticker.unref?.()
  }

  async close(): Promise<void> {
    this.#closed = true
    if (this.#ticker !== null) clearInterval(this.#ticker)
    this.#ticker = null
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
      const all = [...this.#tasks.values()]
      writePrivateJson(this.#path, {
        v: 1,
        tasks: all.filter(task => task.status !== 'scheduled'),
        scheduled: all.filter(task => task.status === 'scheduled'),
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
    if (TERMINAL.has(next.status) && !TERMINAL.has(current.status))
      this.#prune()
    this.#save()
    return next
  }

  /**
   * Keeps the ledger, rewritten whole on every change, from growing without
   * end: finished tasks go after {@link KEEP_FINISHED_MS} or beyond
   * {@link KEEP_FINISHED_PER_OWNER} per owner (never one whose result is still
   * being delivered), and instructions nobody reads again go with them.
   */
  #prune(): void {
    const now = this.#now()
    const finished = [...this.#tasks.values()]
      .filter(
        task =>
          TERMINAL.has(task.status) &&
          task.notification !== 'pending' &&
          task.notification !== 'sending' &&
          !this.#redeliverable(task) &&
          !this.#delivering.has(task.id),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const kept = new Map<string, number>()
    for (const task of finished) {
      const count = (kept.get(task.owner) ?? 0) + 1
      kept.set(task.owner, count)
      if (
        now - task.updatedAt > KEEP_FINISHED_MS ||
        count > KEEP_FINISHED_PER_OWNER
      )
        this.#tasks.delete(task.id)
    }
    // Confirmed instructions and those of a finished task are never read.
    this.#updates = this.#updates.filter(one => {
      const task = this.#tasks.get(one.taskId)
      return (
        task !== undefined &&
        !TERMINAL.has(task.status) &&
        one.consumedAt === null
      )
    })
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
      phase: this.#phase(task),
      progress: clip(task.progress, 2_000),
      result: clip(task.result, 6_000),
      lastError: clip(task.lastError, 1_000),
      turns: task.turns,
      updatedAt: task.updatedAt,
      ...this.#planFields(task),
    }
  }

  /**
   * The phase as a person reads it: a planned task with its next start, or
   * waiting for a place once due.
   */
  #phase(task: TaskRecord): string {
    const plan = task.plan
    let phase = PHASE[task.status]
    if (this.#waitingForPlace(task)) phase += ' · 等名额'
    else if (task.status === 'scheduled' && plan !== null)
      phase += ` · 下次 ${wallClock(plan.nextAt)}`
    if (plan?.everyMinutes != null && !TERMINAL.has(task.status))
      phase += ` · 剩 ${plan.times - plan.runs} 次`
    return phase
  }

  /** What a foreground is told of a planned task. */
  #planFields(task: TaskRecord): {
    nextAt?: string
    everyMinutes?: number
    runsLeft?: number | null
    waitingForPlace?: true
  } {
    const plan = task.plan
    if (plan === null) return {}
    return {
      ...(task.status === 'scheduled'
        ? { nextAt: new Date(plan.nextAt).toISOString() }
        : {}),
      ...(this.#waitingForPlace(task) ? { waitingForPlace: true } : {}),
      ...(plan.everyMinutes === null
        ? {}
        : {
            everyMinutes: plan.everyMinutes,
            runsLeft: TERMINAL.has(task.status) ? null : plan.times - plan.runs,
          }),
    }
  }

  /**
   * A planned start that is due while its conversation has eight tasks in
   * flight: it stays scheduled until one of them ends (see {@link tick}).
   */
  #waitingForPlace(task: TaskRecord): boolean {
    return (
      task.status === 'scheduled' &&
      task.plan !== null &&
      task.plan.nextAt <= this.#now() &&
      this.#activeIn(task.parentSession) >= MAX_ACTIVE_PER_PARENT
    )
  }

  /** A delayed task not started yet, or a repeat with runs still to start. */
  #planned(task: TaskRecord): boolean {
    const plan = task.plan
    return (
      plan !== null &&
      !TERMINAL.has(task.status) &&
      (task.status === 'scheduled' ||
        (plan.everyMinutes !== null && plan.runs < plan.times))
    )
  }

  // -- the console's list (BackgroundTasksPort) --------------------------------

  /** A task's owner sees it; ops and the legacy tokens see every task. */
  #sees(task: TaskRecord, actor: BackgroundTaskReader): boolean {
    return (
      actor.role === 'ops' ||
      (actor.role == null && actor.subject.startsWith('legacy:')) ||
      task.owner === actor.subject
    )
  }

  #consoleView(task: TaskRecord): BackgroundTaskView {
    return {
      id: task.id,
      title: task.title,
      owner: task.owner,
      target: task.target,
      status: task.status,
      phase: this.#waitingForPlace(task)
        ? `${PHASE.scheduled} · 等名额`
        : PHASE[task.status],
      progress: clip(task.progress, 2_000),
      lastError: clip(task.lastError, 1_000),
      turns: task.turns,
      workerSession: task.workerSession,
      nextAt:
        task.status === 'scheduled' && task.plan !== null
          ? task.plan.nextAt
          : null,
      everyMinutes: task.plan?.everyMinutes ?? null,
      runsLeft:
        task.plan?.everyMinutes == null || TERMINAL.has(task.status)
          ? null
          : task.plan.times - task.plan.runs,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }
  }

  list(actor: BackgroundTaskReader): readonly BackgroundTaskView[] {
    return [...this.#tasks.values()]
      .filter(task => this.#sees(task, actor))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(task => this.#consoleView(task))
  }

  visible(id: string, actor: BackgroundTaskReader): boolean {
    const task = this.#tasks.get(id)
    return task !== undefined && this.#sees(task, actor)
  }

  /** The console's 取消: the same cancel the conversation has. */
  async cancel(
    id: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<BackgroundTaskView>> {
    const task = this.#tasks.get(id)
    if (task === undefined || !this.#sees(task, actor))
      return {
        ok: false,
        failure: { code: 'not_found', message: '后台任务不存在' },
      }
    if (TERMINAL.has(task.status))
      return { ok: false, failure: { code: 'rejected', message: '任务已结束' } }
    await this.#cancel(task)
    return { ok: true, value: this.#consoleView(this.#tasks.get(id) ?? task) }
  }

  #family(sessionId: string): ReadonlySet<string> {
    return new Set([sessionId, ...(this.#options.related?.(sessionId) ?? [])])
  }

  /**
   * A conversation's tasks holding one of its eight places. One waiting for
   * the owner's answer, or for its planned start, holds none.
   */
  #activeIn(sessionId: string): number {
    const family = this.#family(sessionId)
    return [...this.#tasks.values()].filter(
      task =>
        family.has(task.parentSession) &&
        !TERMINAL.has(task.status) &&
        task.status !== 'needs_input' &&
        task.status !== 'scheduled',
    ).length
  }

  /** Tasks started from a conversation, newest first. */
  forSession(sessionId: string): TaskView[] {
    const family = this.#family(sessionId)
    return [...this.#tasks.values()]
      .filter(task => family.has(task.parentSession))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(task => this.#view(task))
  }

  /**
   * The per-turn note a foreground gets: its unfinished tasks, and those that
   * finished after `since` (when it was last given one) or, without it, the
   * five most recent finished ones.
   */
  contextFor(sessionId: string, since?: number): string | undefined {
    const tasks = this.forSession(sessionId)
    const current = tasks.filter(task => !TERMINAL.has(task.status))
    const finished = tasks.filter(task => TERMINAL.has(task.status))
    const recent =
      since === undefined
        ? finished.slice(0, 5)
        : finished.filter(task => task.updatedAt > since)
    if (current.length + recent.length === 0) return undefined
    return `[当前会话的后台任务] ${JSON.stringify(
      [...current, ...recent].map(task => ({
        id: task.id,
        title: task.title,
        status: task.status,
        progress: clip(task.progress, 300),
        ...(task.nextAt === undefined ? {} : { nextAt: task.nextAt }),
        ...(task.runsLeft === undefined ? {} : { runsLeft: task.runsLeft }),
        ...(task.waitingForPlace === undefined
          ? {}
          : { waitingForPlace: true }),
      })),
    )}`
  }

  /**
   * A conversation that may run tasks: not a worker's, not a schedule's
   * (P24), and on a channel only the owner's private chat.
   */
  #foregroundSession(sessionId: string): boolean {
    if (this.#options.scheduled?.(sessionId) === true) return false
    if (this.#options.foreground?.(sessionId) === false) return false
    for (const task of this.#tasks.values())
      if (task.workerSession === sessionId) return false
    return true
  }

  /**
   * The task note for a console conversation's next line ({@link
   * withTaskNotes}): {@link contextFor} since the last note that went out,
   * nothing when that is unchanged, and the whole note again after the
   * runtime compacted the conversation. A channel keeps its own (its turns
   * know when they succeeded).
   */
  async noteFor(sessionId: string): Promise<TaskNote | undefined> {
    if (this.#closed || !this.#foregroundSession(sessionId)) return undefined
    const transcript = await this.#options.chat.transcript(sessionId)
    if (!transcript.ok) return undefined
    const last = lastTurn(transcript.value.turns)
    if (last?.compacted === true) this.#noted.delete(sessionId)
    const noted = this.#noted.get(sessionId)
    const at = this.#now()
    const summary = this.contextFor(sessionId, noted?.at)
    const fresh = summary === noted?.text ? undefined : summary
    const long = this.#longTurn(sessionId, last)
    const text = taskNote(
      fresh,
      long === undefined ? undefined : reminderText(long),
    )
    if (text === undefined) return undefined
    return {
      text,
      sent: () => {
        if (fresh !== undefined) this.#noted.set(sessionId, { text: fresh, at })
        if (long !== undefined) this.#reminded.set(sessionId, long.taskId)
      },
    }
  }

  /**
   * The reminder a foreground's next turn carries once after a long one
   * (more than {@link LONG_TURN_MS} or {@link LONG_TURN_STEPS} tool steps):
   * hand long work to a task. The turn it is about is never interrupted;
   * the reminder is taken as given (a channel builds its note around it).
   */
  async reminderFor(sessionId: string): Promise<string | undefined> {
    if (this.#closed || !this.#foregroundSession(sessionId)) return undefined
    const transcript = await this.#options.chat.transcript(sessionId)
    if (!transcript.ok) return undefined
    const long = this.#longTurn(sessionId, lastTurn(transcript.value.turns))
    if (long === undefined) return undefined
    this.#reminded.set(sessionId, long.taskId)
    return reminderText(long)
  }

  /** The last turn, when it was long and not reminded of yet. */
  #longTurn(
    sessionId: string,
    last: FinishedTurn | undefined,
  ): FinishedTurn | undefined {
    if (
      last === undefined ||
      last.command ||
      this.#reminded.get(sessionId) === last.taskId ||
      (last.ms <= LONG_TURN_MS && last.steps <= LONG_TURN_STEPS)
    )
      return undefined
    return last
  }

  /**
   * A short status answer for "进度怎么样了" (grantley `status_text`): the
   * unfinished tasks, else those finished in the last ten minutes unless the
   * foreground is `busy` with a turn of its own (the question is then about
   * that). Undefined lets the question through to the agent.
   */
  statusText(
    sessionId: string,
    options: { readonly busy?: boolean } = {},
  ): string | undefined {
    const tasks = this.forSession(sessionId)
    // A planned task is not in progress: the question is not about it.
    const active = tasks.filter(
      task => !TERMINAL.has(task.status) && task.status !== 'scheduled',
    )
    const shown =
      active.length > 0
        ? active
        : options.busy
          ? []
          : tasks
              .filter(task => this.#now() - task.updatedAt <= RECENTLY_MS)
              .slice(0, 3)
    if (shown.length === 0) return undefined
    return shown
      .map(task => {
        let line = `${task.title}：${task.phase}`
        if (task.progress) line += `。${clip(task.progress, 400)}`
        if (task.lastError) line += `\n最近中断：${clip(task.lastError, 200)}`
        return line
      })
      .join('\n\n')
  }

  /**
   * `/stop` in a chat: cancels that conversation's running tasks. Planned
   * ones waiting for their start are not running; they stay.
   */
  async cancelForSession(sessionId: string): Promise<number> {
    const family = this.#family(sessionId)
    const doomed = [...this.#tasks.values()].filter(
      task =>
        family.has(task.parentSession) &&
        !TERMINAL.has(task.status) &&
        task.status !== 'scheduled',
    )
    // Each stop may wait on its node; the chat's answer waits for the slowest.
    await Promise.all(
      doomed.map(task =>
        task.plan !== null &&
        task.plan.everyMinutes !== null &&
        task.plan.runs < task.plan.times
          ? this.#stopRun(task, task.plan)
          : this.#cancel(task),
      ),
    )
    return doomed.length
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
    // Nobody reads a schedule's session live: a result would reach no one.
    if (this.#options.scheduled?.(sessionId) === true)
      return refused(
        '定时任务的会话不能开后台任务，结果没有人接收；请在这一轮里直接完成',
      )
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
      case 'agents':
        return this.#agents(caller)
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
    const plan = this.#plan(args)
    if (typeof plan === 'string') return refused(plan)
    const later = plan !== null && plan.runs === 0
    const dispatch = this.#dispatch(caller.owner)
    if (typeof dispatch === 'string') return refused(dispatch)
    const denied = await dispatch.authorizeTarget(target)
    if (denied)
      return refused((await refusal(denied)).error ?? '不能派给这个智能体')
    // The limits are counted after the last await and before the write, so
    // starts made in parallel in one turn cannot all pass them.
    const active = this.#activeIn(session.id)
    if (!later && active >= MAX_ACTIVE_PER_PARENT)
      return refused(`这个会话已有 ${active} 个进行中的任务`)
    if (
      plan !== null &&
      (later || (plan.everyMinutes !== null && plan.runs < plan.times))
    ) {
      const planned = [...this.#tasks.values()].filter(
        task => task.owner === caller.owner && this.#planned(task),
      ).length
      if (planned >= MAX_PLANNED_PER_OWNER)
        return refused(
          `已有 ${planned} 个安排好的任务，最多 ${MAX_PLANNED_PER_OWNER} 个；先取消不需要的`,
        )
    }
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
      status: later ? 'scheduled' : 'queued',
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
      plan,
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
    if (!later) this.#schedule(task.id)
    return ok({
      id: task.id,
      title,
      target,
      status: task.status,
      ...this.#planFields(task),
    })
  }

  /**
   * 主动任务: `after` minutes or `at` an ISO time with its zone for a later
   * first run, `everyMinutes` with `times` for a repeat. Null when the task
   * runs once, at once; a refusal's words when the arguments do not hold.
   */
  #plan(args: Record<string, unknown>): Plan | null | string {
    const now = this.#now()
    const after = whole(args['after'])
    const every = whole(args['everyMinutes'])
    const times = whole(args['times'])
    const at = given(args['at'])
    if (after === null || every === null || times === null)
      return 'after、everyMinutes、times 要是整数'
    if (after !== undefined && at !== undefined) return 'after 和 at 只能给一个'
    let first = now
    if (after !== undefined) {
      if (after < 1 || after > MAX_DELAY_MINUTES)
        return `after 是 1–${MAX_DELAY_MINUTES} 分钟`
      first = now + after * 60_000
    } else if (at !== undefined) {
      const text = typeof at === 'string' ? at.trim() : ''
      const parsed = zonedTime(text)
      if (parsed === undefined)
        return 'at 要是带时区的 ISO 时间，例如 2026-10-18T09:00:00+08:00'
      if (parsed === null)
        return `at 的日期或时刻不存在：${text}；请核对当月天数与 00:00–23:59 的时刻`
      if (parsed <= now) return 'at 要晚于现在'
      if (parsed > now + MAX_DELAY_MINUTES * 60_000) return 'at 至多 7 天后'
      first = parsed
    }
    if (every === undefined) {
      if (times !== undefined) return 'times 要和 everyMinutes 一起给'
      return first === now
        ? null
        : {
            nextAt: first,
            anchor: first,
            everyMinutes: null,
            times: 1,
            runs: 0,
          }
    }
    if (every < MIN_EVERY_MINUTES || every > MAX_EVERY_MINUTES)
      return `everyMinutes 是 ${MIN_EVERY_MINUTES}–${MAX_EVERY_MINUTES} 分钟`
    if (times === undefined) return `重复任务要给 times（1–${MAX_TIMES} 次）`
    if (times < 1 || times > MAX_TIMES) return `times 是 1–${MAX_TIMES} 次`
    // Without a later start the first run starts now.
    return {
      nextAt: first,
      anchor: first,
      everyMinutes: every,
      times,
      runs: first === now ? 1 : 0,
    }
  }

  /**
   * `qianmo_task_agents`: whom this owner may hand work to — the dial list
   * and tenant rule `qianmo_task_start` checks — with the runtime and model
   * where the hub knows them, and how busy each is. A node runs one turn at a
   * time, so `idle` is about the node: no conversation turn waiting for its
   * answer there (the caller's own aside) and no background task running or
   * queued for it.
   */
  async #agents(caller: Caller): Promise<ControlOutcome> {
    const dispatch = this.#dispatch(caller.owner)
    if (typeof dispatch === 'string') return refused(dispatch)
    const targets = await dispatch.dialable()
    if (targets instanceof Response)
      return refused((await refusal(targets)).error ?? '名册暂不可用')
    const self = caller.transcript.session
    const tasks = [...this.#tasks.values()]
    const workers = new Set(tasks.map(task => task.workerSession))
    const sessions = await this.#options.chat.sessions()
    const turns = new Map<string, number>()
    const busy = new Set<string>()
    const nodeOf = (address: string) => parseAddress(address)?.node ?? address
    for (const session of sessions.ok ? sessions.value : [])
      if (
        session.running === true &&
        session.id !== self.id &&
        !workers.has(session.id)
      ) {
        turns.set(session.target, (turns.get(session.target) ?? 0) + 1)
        busy.add(nodeOf(session.target))
      }
    const counts = new Map<string, { queued: number; running: number }>()
    for (const task of tasks) {
      if (
        TERMINAL.has(task.status) ||
        task.status === 'needs_input' ||
        task.status === 'scheduled'
      )
        continue
      const count = counts.get(task.target) ?? { queued: 0, running: 0 }
      if (task.status === 'queued' || task.status === 'interrupted')
        count.queued++
      else count.running++
      counts.set(task.target, count)
      busy.add(nodeOf(task.target))
    }
    const listed = targets.slice(0, MAX_AGENTS_LISTED)
    const agents = await Promise.all(
      listed.map(async row => {
        const profile =
          (await this.#options.profile?.(row.address).catch(() => ({}))) ?? {}
        const count = counts.get(row.address)
        return {
          address: row.address,
          name: row.agent,
          status: row.status,
          self: row.address === self.target,
          ...profile,
          idle: !busy.has(row.node),
          turns: turns.get(row.address) ?? 0,
          queued: count?.queued ?? 0,
          running: count?.running ?? 0,
        }
      }),
    )
    return ok({
      agents,
      ...(targets.length > listed.length
        ? { more: targets.length - listed.length }
        : {}),
    })
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
    // A planned task reads it when its run starts, not before.
    if (task.status === 'scheduled') {
      this.#save()
      return ok({ updateId: update.id, task: this.#view(task) })
    }
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

  /**
   * `/stop` on a repeat with runs still to come: this run stops on its node
   * and the task waits as scheduled for its next start, the later runs
   * untouched. A cancel (qianmo_task_cancel, the console) ends them all;
   * `/stop` on the last run is one.
   */
  async #stopRun(task: TaskRecord, plan: Plan): Promise<void> {
    this.#patch(task.id, {
      status: 'scheduled',
      plan: { ...plan, nextAt: nextSlot(plan, this.#now()) },
      requestedState: '',
      notification: 'none',
    })
    this.#waits.get(task.id)?.()
    const turn = this.#turns.get(task.id)
    const running = turn?.taskId ?? task.nodeTaskId
    if (running !== null && this.#options.stopTask) {
      const stopped = await this.#options
        .stopTask(turn?.target ?? task.target, running)
        .catch(() => false)
      // Stopped: the next run need not stop it again first.
      if (stopped && this.#tasks.get(task.id)?.nodeTaskId === running)
        this.#patch(task.id, { nodeTaskId: null })
    }
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
    const plan = task.plan
    if (turn.brief) {
      parts.push(WORKER_INSTRUCTIONS, `任务说明：\n${task.instructions}`)
      // A repeat: each run is the whole task again, in the same session.
      if (plan !== null && plan.everyMinutes !== null)
        parts.push(
          `这是重复任务的第 ${plan.runs} 次运行（共 ${plan.times} 次，每 ${plan.everyMinutes} 分钟一次）。按任务说明完整做这一次${
            plan.runs > 1 ? '，上一次的结果在检查点里，可以对照' : ''
          }；做完就报告 completed，下一次由任务管理器到点再叫你。`,
        )
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
                // Checked against the dial list just above.
                authorized: true,
                onTask: taskId => {
                  turn.taskId = taskId
                  const now = this.#tasks.get(id)
                  // Cancelled, stopped back to its plan or closed while the
                  // line was on its way: there was no node task to stop yet,
                  // so stop it here.
                  if (
                    this.#closed ||
                    now === undefined ||
                    !RESUMABLE.has(now.status)
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
        const done = task.requestedState === 'completed'
        const plan = task.plan
        // A repeat with runs left waits for the next one; the times this run
        // outlasted are skipped, not made up.
        const again =
          done &&
          plan !== null &&
          plan.everyMinutes !== null &&
          plan.runs < plan.times
        this.#patch(id, {
          status: again ? 'scheduled' : done ? 'completed' : 'needs_input',
          requestedState: '',
          notification: 'pending',
          ...(again
            ? { plan: { ...plan, nextAt: nextSlot(plan, this.#now()) } }
            : {}),
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
      (task.status === 'completed' ||
        task.status === 'needs_input' ||
        task.status === 'scheduled') &&
      task.notification === 'pending'
    )
      await this.#notify(id)
  }

  // -- planned runs -------------------------------------------------------------

  /**
   * Starts the planned runs that are due: at start-up (a time missed while
   * the hub was down runs once, not once per missed time) and every
   * {@link TICK_MS}. A run whose last result is still being delivered waits
   * for the next look; so does one whose conversation has eight tasks in
   * flight, which is the same limit a start meets.
   */
  tick(): void {
    if (this.#closed || !this.#lock?.owned()) return
    const now = this.#now()
    for (const task of [...this.#tasks.values()])
      if (
        task.status === 'scheduled' &&
        task.plan !== null &&
        task.plan.nextAt <= now &&
        !this.#delivering.has(task.id) &&
        this.#activeIn(task.parentSession) < MAX_ACTIVE_PER_PARENT
      )
        this.#run(task, task.plan)
  }

  /**
   * One planned run: the task goes to its node's queue like any other. A
   * repeat continues in its worker session, briefed again for the run; a
   * delivery of the last result still owed is given up for the new one.
   */
  #run(task: TaskRecord, plan: Plan): void {
    clearTimeout(this.#redeliveries.get(task.id))
    this.#redeliveries.delete(task.id)
    this.#patch(task.id, {
      status: 'queued',
      plan: { ...plan, runs: plan.runs + 1 },
      requestedState: '',
      quietTurns: 0,
      abnormal: false,
      lastError: '',
      notification: 'none',
      deliveries: {},
      deliveryAttempts: 0,
      rebrief: task.workerSession !== null,
    })
    this.#schedule(task.id)
  }

  // -- results ----------------------------------------------------------------

  /** 已完成, 需要你的补充, or a repeat's run and its next start. */
  #resultLabel(task: TaskRecord): string {
    const plan = task.plan
    if (task.status === 'needs_input') return '需要你的补充'
    if (plan === null || plan.everyMinutes === null) return '已完成'
    return task.status === 'scheduled'
      ? `第 ${plan.runs}/${plan.times} 次已完成 · 下次 ${wallClock(plan.nextAt)}`
      : `第 ${plan.runs}/${plan.times} 次已完成 · 全部完成`
  }

  /** A result whose last round failed somewhere, with rounds left. */
  #redeliverable(task: TaskRecord): boolean {
    return (
      task.notification === 'failed' &&
      (task.status === 'completed' ||
        task.status === 'needs_input' ||
        task.status === 'scheduled') &&
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
      const text = `${task.title}：${this.#resultLabel(task)}\n\n${task.result}`
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
        const sent = await within(
          send().catch(() => false),
          this.#options.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS,
        )
        if (sent === LATE)
          this.#options.onError?.(
            `后台任务 ${id} 的结果送到 ${key} 超时没有回音，按不确定记下，不再重发`,
          )
        deliveries[key] =
          sent === LATE
            ? 'unknown'
            : sent === true
              ? 'sent'
              : sent === false
                ? 'failed'
                : 'skipped'
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
