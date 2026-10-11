// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import {
  MODEL_DIRECTIONS,
  SCHEDULE_TEMPLATES,
  type ActionLedgerPort,
  type ChatPort,
  type ChatTurn,
  type ConsoleFailure,
  type ConsoleResult,
  type DirectionActor,
  type NotifyChannelDraft,
  type NotifyChannelView,
  type ScheduleDraft,
  type ScheduleRunView,
  type SchedulesPort,
  type ScheduleTemplateView,
  type ScheduleView,
} from '@qianmo/console'
import { readTextIfExists, writePrivateJson } from '../providers/store.js'
import { FileLedger } from './consoleAccountsStore.js'
import {
  notifyChannelUrl,
  pushNotifyChannel,
  type ChannelPushOptions,
  type ChannelPushResult,
  type ScheduleNotification,
} from './consoleNotifyChannels.js'
import { nextRunAt, validateScheduleWhen } from './scheduleTime.js'

const MINUTE = 60_000
const DEFAULT_TIMEOUT = 10 * MINUTE
const whenSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), time: z.string() }),
  z.object({
    kind: z.literal('weekly'),
    time: z.string(),
    days: z.array(z.number()),
  }),
  z.object({
    kind: z.literal('interval'),
    everyMinutes: z.number(),
    anchorMs: z.number().optional(),
  }),
])
const draftSchema = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(1).max(120),
  target: z.string(),
  template: z.enum(SCHEDULE_TEMPLATES),
  prompt: z.string().trim().min(1).max(20_000),
  when: whenSchema,
  timezone: z.string().default('Asia/Shanghai'),
  direction: z.enum(MODEL_DIRECTIONS).nullable().default('chat'),
  channels: z.array(z.string()).max(50),
  notifyOnlyAgent: z.boolean(),
  enabled: z.boolean(),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(60 * MINUTE)
    .default(DEFAULT_TIMEOUT),
})
const channelDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['webhook', 'bark', 'wecom', 'feishu', 'ntfy']),
  url: z.string().optional(),
})
const runSchema = z.object({
  runId: z.string(),
  scheduleId: z.string(),
  plannedAt: z.number(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  outcome: z.enum(['running', 'completed', 'failed', 'timeout', 'skipped']),
  taskId: z.string().nullable(),
  sessionId: z.string().nullable(),
  excerpt: z.string().nullable(),
  reason: z.string().nullable(),
  pushed: z.array(
    z.object({
      channelId: z.string(),
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
  ),
  trigger: z.enum(['schedule', 'manual']),
})
const storedSchema = draftSchema.extend({
  id: z.string(),
  createdAt: z.number(),
  createdBy: z.string(),
  updatedAt: z.number(),
  nextRunAt: z.number().nullable(),
  sessionId: z.string().nullable(),
})
const channelSchema = channelDraftSchema.omit({ url: true }).extend({
  id: z.string(),
  host: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
  lastError: z.string().nullable(),
})
const bookSchema = z.object({
  schedules: z.array(storedSchema),
  channels: z.array(channelSchema),
  running: z.array(runSchema),
})

type StoredSchedule = z.infer<typeof storedSchema>
interface ActiveRun {
  view: ScheduleRunView
  readonly schedule: StoredSchedule
  baseline: Set<string>
  notices: string[]
  phase: 'sending' | 'waiting' | 'pushing'
}

const TEMPLATES: readonly ScheduleTemplateView[] = [
  {
    id: 'briefing',
    title: '晨间简报',
    needs: null,
    prompt:
      '请结合长期记忆里的计划与待办、今天的日程（若接了日历）、昨天未完成的事项，写一份不超过 300 字的简报，最后列出今天最重要的三件事。',
  },
  {
    id: 'followup',
    title: '跟进待办',
    needs: null,
    prompt:
      '检查记忆里标记为计划或待办的事项，逐条说明进展和下一步，需要用户拿主意的单独列出并调用通知工具。',
  },
  {
    id: 'mail',
    title: '整理邮件',
    needs: '邮件连接',
    prompt:
      '用邮件工具读取最近 24 小时未读邮件，按需要回复、需要知道、可忽略分三类，各列标题与一句摘要。',
  },
  { id: 'custom', title: '自定义', needs: null, prompt: '' },
]

export interface ConsoleSchedulesOptions {
  readonly directory: string
  readonly estopPath: string
  readonly chat: ChatPort
  readonly actions?: ActionLedgerPort
  readonly now?: () => number
  readonly push?: (
    kind: NotifyChannelView['kind'],
    url: string,
    notice: ScheduleNotification,
  ) => Promise<ChannelPushResult>
  readonly pushOptions?: ChannelPushOptions
  /** Receives fixed diagnostics, never upstream errors or channel addresses. */
  readonly onError?: (message: string) => void
}

function fail<T>(
  code: ConsoleFailure['code'],
  message: string,
): ConsoleResult<T> {
  return { ok: false, failure: { code, message } }
}
function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

/** Tail from the end: old history never needs to be loaded into memory. */
function recentLines(file: string): { lines: string[]; interrupted: boolean } {
  let fd: number
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { lines: [], interrupted: false }
    throw error
  }
  try {
    let offset = fs.fstatSync(fd).size
    let bytes = Buffer.alloc(0)
    while (offset > 0 && bytes.toString('utf8').split('\n').length <= 501) {
      const size = Math.min(offset, 64 * 1024)
      offset -= size
      const chunk = Buffer.alloc(size)
      fs.readSync(fd, chunk, 0, size, offset)
      bytes = Buffer.concat([chunk, bytes])
    }
    const lines = bytes.toString('utf8').split('\n')
    if (offset > 0) lines.shift()
    // A torn last append is not a completed run.
    lines.pop()
    return {
      lines: lines.slice(-500),
      interrupted: bytes.length > 0 && bytes[bytes.length - 1] !== 10,
    }
  } finally {
    fs.closeSync(fd)
  }
}

/** The watch scheduler stays separate; this book owns only console conversations. */
export class ConsoleSchedules implements SchedulesPort {
  readonly #options: ConsoleSchedulesOptions
  readonly #bookPath: string
  readonly #secretPath: string
  readonly #ledger: FileLedger
  readonly #now: () => number
  readonly #schedules = new Map<string, StoredSchedule>()
  readonly #channels = new Map<string, NotifyChannelView>()
  readonly #secrets = new Map<string, string>()
  readonly #redactions = new Set<string>()
  readonly #runs: ScheduleRunView[] = []
  readonly #active = new Map<string, ActiveRun>()
  readonly #background = new Set<Promise<void>>()
  #queue: Promise<unknown> = Promise.resolve()
  #timer: NodeJS.Timeout | null = null
  #unsubscribe: (() => void) | null = null
  #closed = false
  #tickAt: number | null = null
  #interruptedTail = false

  constructor(options: ConsoleSchedulesOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#bookPath = path.join(options.directory, 'schedules.json')
    this.#secretPath = path.join(options.directory, 'channels.secret.json')
    this.#ledger = new FileLedger(path.join(options.directory, 'runs.ndjson'))
    try {
      const secret = readTextIfExists(this.#secretPath)
      if (secret) {
        const values = z
          .record(z.string(), z.string())
          .parse(JSON.parse(secret))
        for (const [id, value] of Object.entries(values)) {
          this.#secrets.set(id, notifyChannelUrl(value).toString())
          this.#redactions.add(value)
        }
      }
      const tail = recentLines(this.#ledger.path)
      this.#interruptedTail = tail.interrupted
      for (const line of tail.lines) {
        try {
          const run = runSchema.parse(JSON.parse(line))
          this.#runs.push(this.#redact(run))
        } catch {
          // A crash may have separated a partial append with the next newline.
          // History is diagnostic; only the validated book can dispatch work.
          options.onError?.('定时任务运行记录有不完整行，已忽略')
        }
      }
      const raw = readTextIfExists(this.#bookPath)
      if (raw) {
        const book = bookSchema.parse(JSON.parse(raw))
        for (const schedule of book.schedules) {
          validateScheduleWhen(schedule.when, schedule.timezone)
          this.#schedules.set(schedule.id, schedule)
        }
        for (const channel of book.channels) {
          const url = this.#secrets.get(channel.id)
          if (!url) throw new Error('missing secret')
          this.#channels.set(channel.id, {
            ...channel,
            host: notifyChannelUrl(url).hostname,
          })
        }
        for (const run of book.running) {
          if (this.#runs.some(previous => previous.runId === run.runId))
            continue
          this.#append({
            ...run,
            outcome: 'failed',
            finishedAt: this.#now(),
            reason: '控制台重启',
          })
        }
        this.#persist()
      }
    } catch {
      this.#ledger.close()
      throw new Error('定时任务簿无法恢复，请检查状态文件')
    }
    this.#unsubscribe = options.chat.subscribe(update => {
      this.#launch(
        this.#serial(async () => {
          for (const active of this.#active.values()) {
            if (active.view.sessionId === update.sessionId)
              await this.#inspect(active)
          }
        }),
      )
    })
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work)
    this.#queue = next.catch(() => {})
    return next
  }

  #launch(work: Promise<void>): void {
    const safe = work.catch(() => {
      this.#options.onError?.('定时任务后台操作失败')
    })
    this.#background.add(safe)
    void safe.finally(() => this.#background.delete(safe))
  }

  /** Useful to deterministic hosts/tests; does not wait for a still-running agent. */
  async idle(): Promise<void> {
    while (this.#background.size) await Promise.all([...this.#background])
    await this.#queue
  }

  #redact<T>(value: T): T {
    const visit = (item: unknown): unknown => {
      if (typeof item === 'string') {
        let text = item
        for (const secret of this.#redactions)
          text = text.split(secret).join('[渠道地址]')
        return text
      }
      if (Array.isArray(item)) return item.map(visit)
      if (item && typeof item === 'object')
        return Object.fromEntries(
          Object.entries(item).map(([key, val]) => [key, visit(val)]),
        )
      return item
    }
    return visit(value) as T
  }

  #persist(): void {
    writePrivateJson(
      this.#bookPath,
      this.#redact({
        schedules: [...this.#schedules.values()],
        channels: [...this.#channels.values()],
        running: [...this.#active.values()].map(active => active.view),
      }),
    )
  }

  #append(run: ScheduleRunView): void {
    const safe = this.#redact(run)
    if (this.#interruptedTail) {
      this.#ledger.append('\n')
      this.#interruptedTail = false
    }
    this.#ledger.append(`${JSON.stringify(safe)}\n`)
    this.#runs.push(safe)
    if (this.#runs.length > 500) this.#runs.shift()
  }

  #view(schedule: StoredSchedule): ScheduleView {
    const { sessionId: _sessionId, ...fields } = schedule
    const lastRun =
      [...this.#runs].reverse().find(run => run.scheduleId === schedule.id) ??
      null
    const active = this.#active.get(schedule.id)?.view
    const latest =
      active && (!lastRun || active.startedAt >= lastRun.startedAt)
        ? active
        : lastRun
    return this.#redact({ ...fields, lastRun: latest })
  }

  #estop(): boolean {
    try {
      fs.lstatSync(this.#options.estopPath)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ENOENT'
    }
  }

  async snapshot() {
    return this.#serial(async () => {
      const targets = await this.#options.chat.targets()
      if (!targets.ok) return targets
      return ok(
        this.#redact({
          schedules: [...this.#schedules.values()].map(schedule =>
            this.#view(schedule),
          ),
          runs: [
            ...[...this.#active.values()].map(active => active.view),
            ...[...this.#runs].reverse(),
          ]
            .sort(
              (a, b) => b.startedAt - a.startedAt || b.plannedAt - a.plannedAt,
            )
            .slice(0, 50),
          channels: [...this.#channels.values()],
          templates: TEMPLATES,
          targets: targets.value
            .filter(target => target.dialable)
            .map(target => target.address),
          estop: this.#estop(),
          tickAt: this.#tickAt,
        }),
      )
    })
  }

  async #write<T>(
    action: string,
    target: string,
    actor: DirectionActor,
    work: () => Promise<ConsoleResult<T>>,
  ): Promise<ConsoleResult<T>> {
    return this.#serial(async () => {
      if (this.#closed) return fail('unreachable', '定时任务簿已关闭')
      const allowed =
        actor.role === 'ops' ||
        (actor.role === null && actor.subject === 'legacy:admin') ||
        (action.startsWith('schedule.') && actor.role === 'member')
      if (!allowed)
        return fail('refused', '该操作需要成员或运维权限；渠道管理需要运维权限')
      try {
        const admitted = await this.#options.actions?.admit?.()
        if (admitted && !admitted.ok)
          return fail('unreachable', '动作账本不可写')
      } catch {
        return fail('unreachable', '动作账本不可写')
      }
      let result: ConsoleResult<T>
      try {
        result = await work()
      } catch {
        result = fail('unreachable', '定时任务状态无法写入')
      }
      try {
        const recorded = await this.#options.actions?.record({
          at: this.#now(),
          requestId: actor.requestId,
          subject: actor.subject,
          action,
          target: /^[sc]-[0-9a-f-]{36}$/.test(target) ? target : '-',
          outcome: result.ok
            ? 'ok'
            : result.failure.code === 'refused' ||
                result.failure.code === 'rejected'
              ? 'refused'
              : 'failed',
          ...(result.ok ? {} : { code: result.failure.code }),
        })
        if (recorded && !recorded.ok)
          this.#options.onError?.('定时任务动作账本记录失败')
      } catch {
        this.#options.onError?.('定时任务动作账本记录失败')
      }
      return result
    })
  }

  save(
    draft: ScheduleDraft,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ScheduleView>> {
    const id =
      typeof draft?.id === 'string' ? draft.id : `s-${crypto.randomUUID()}`
    return this.#write('schedule.save', id, actor, async () => {
      const parsed = draftSchema.safeParse(draft)
      if (!parsed.success) return fail('invalid', '定时任务字段无效')
      const value = parsed.data
      const existing =
        value.id === undefined ? undefined : this.#schedules.get(value.id)
      if (value.id !== undefined && !existing)
        return fail('not_found', '定时任务不存在')
      if (
        new Set(value.channels).size !== value.channels.length ||
        value.channels.some(one => !this.#channels.has(one))
      )
        return fail('invalid', '通知渠道不存在或重复')
      const targets = await this.#options.chat.targets()
      if (!targets.ok) return targets
      if (
        !targets.value.some(
          target => target.address === value.target && target.dialable,
        )
      )
        return fail('rejected', '目标不在对话面允许名单内')
      const createdAt = existing?.createdAt ?? this.#now()
      const when =
        value.when.kind === 'interval'
          ? { ...value.when, anchorMs: createdAt }
          : value.when
      let next: number | null
      try {
        next = nextRunAt(when, value.timezone, this.#now())
      } catch {
        return fail('invalid', '时间、星期、间隔或时区无效')
      }
      const sameTiming =
        existing &&
        JSON.stringify(existing.when) === JSON.stringify(when) &&
        existing.timezone === value.timezone
      const schedule: StoredSchedule = {
        ...value,
        id,
        when,
        createdAt,
        createdBy: existing?.createdBy ?? actor.subject,
        updatedAt: this.#now(),
        nextRunAt:
          sameTiming && !(value.enabled && !existing.enabled)
            ? existing.nextRunAt
            : next,
        sessionId:
          existing?.target === value.target ? existing.sessionId : null,
      }
      this.#schedules.set(id, schedule)
      try {
        this.#persist()
      } catch (error) {
        if (existing) this.#schedules.set(id, existing)
        else this.#schedules.delete(id)
        throw error
      }
      return ok(this.#view(schedule))
    })
  }

  setEnabled(
    id: string,
    enabled: boolean,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ScheduleView>> {
    return this.#write(
      enabled ? 'schedule.enable' : 'schedule.disable',
      id,
      actor,
      async () => {
        if (typeof enabled !== 'boolean')
          return fail('invalid', '启用状态必须为布尔值')
        const schedule = this.#schedules.get(id)
        if (!schedule) return fail('not_found', '定时任务不存在')
        const next = {
          ...schedule,
          enabled,
          updatedAt: this.#now(),
          nextRunAt:
            enabled && !schedule.enabled
              ? nextRunAt(schedule.when, schedule.timezone, this.#now())
              : schedule.nextRunAt,
        }
        this.#schedules.set(id, next)
        try {
          this.#persist()
        } catch (error) {
          this.#schedules.set(id, schedule)
          throw error
        }
        return ok(this.#view(next))
      },
    )
  }

  remove(id: string, actor: DirectionActor): Promise<ConsoleResult<null>> {
    return this.#write('schedule.remove', id, actor, async () => {
      const schedule = this.#schedules.get(id)
      if (!schedule) return fail('not_found', '定时任务不存在')
      this.#schedules.delete(id)
      try {
        this.#persist()
      } catch (error) {
        this.#schedules.set(id, schedule)
        throw error
      }
      return ok(null)
    })
  }

  runNow(
    id: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ScheduleRunView>> {
    return this.#write('schedule.run', id, actor, async () => {
      const schedule = this.#schedules.get(id)
      if (!schedule) return fail('not_found', '定时任务不存在')
      return ok(this.#reserve(schedule, this.#now(), 'manual', null))
    })
  }

  saveChannel(
    draft: NotifyChannelDraft,
    actor: DirectionActor,
  ): Promise<ConsoleResult<NotifyChannelView>> {
    const id =
      typeof draft?.id === 'string' ? draft.id : `c-${crypto.randomUUID()}`
    return this.#write('channel.save', id, actor, async () => {
      const parsed = channelDraftSchema.safeParse(draft)
      if (!parsed.success) return fail('invalid', '通知渠道字段无效')
      const value = parsed.data
      const existing =
        value.id === undefined ? undefined : this.#channels.get(value.id)
      if (value.id !== undefined && !existing)
        return fail('not_found', '通知渠道不存在')
      const raw = value.url ?? this.#secrets.get(id)
      if (!raw) return fail('invalid', '新通知渠道必须设置地址')
      let url: URL
      try {
        url = notifyChannelUrl(raw)
      } catch {
        return fail('invalid', '渠道地址无效，只允许 HTTPS（回环允许 HTTP）')
      }
      const channel: NotifyChannelView = {
        id,
        name: value.name,
        kind: value.kind,
        host: url.hostname,
        createdAt: existing?.createdAt ?? this.#now(),
        lastUsedAt: existing?.lastUsedAt ?? null,
        lastError: null,
      }
      const previous = this.#secrets.get(id)
      this.#redactions.add(raw)
      this.#redactions.add(url.toString())
      this.#secrets.set(id, url.toString())
      try {
        // Secret first: a crash can leave an unused secret, never a public URL.
        writePrivateJson(this.#secretPath, Object.fromEntries(this.#secrets))
        this.#channels.set(id, channel)
        this.#persist()
      } catch (error) {
        if (previous) this.#secrets.set(id, previous)
        else this.#secrets.delete(id)
        if (existing) this.#channels.set(id, existing)
        else this.#channels.delete(id)
        throw error
      }
      return ok(this.#redact(channel))
    })
  }

  removeChannel(
    id: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<null>> {
    return this.#write('channel.remove', id, actor, async () => {
      const channel = this.#channels.get(id)
      if (!channel) return fail('not_found', '通知渠道不存在')
      if (
        [...this.#schedules.values()].some(schedule =>
          schedule.channels.includes(id),
        ) ||
        [...this.#active.values()].some(active =>
          active.schedule.channels.includes(id),
        )
      )
        return fail('rejected', '通知渠道仍被定时任务引用')
      this.#channels.delete(id)
      try {
        this.#persist()
      } catch (error) {
        this.#channels.set(id, channel)
        throw error
      }
      this.#secrets.delete(id)
      writePrivateJson(this.#secretPath, Object.fromEntries(this.#secrets))
      return ok(null)
    })
  }

  async #push(
    channel: NotifyChannelView,
    notice: ScheduleNotification,
  ): Promise<ChannelPushResult> {
    const url = this.#secrets.get(channel.id)
    if (!url) return { ok: false, error: '渠道地址未设置', attempts: 0 }
    try {
      const result = this.#options.push
        ? await this.#options.push(channel.kind, url, notice)
        : await pushNotifyChannel(
            channel.kind,
            url,
            notice,
            this.#options.pushOptions,
          )
      // Injected transports get the same secret boundary as production fetch.
      return { ...result, error: result.ok ? null : '通知推送失败' }
    } catch {
      return { ok: false, error: '通知推送失败', attempts: 1 }
    }
  }

  testChannel(
    id: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<NotifyChannelView>> {
    return this.#write('channel.test', id, actor, async () => {
      const channel = this.#channels.get(id)
      if (!channel) return fail('not_found', '通知渠道不存在')
      const result = await this.#push(channel, {
        title: '阡陌通知测试',
        body: '这是一条测试通知。',
        at: this.#now(),
        qianmo: {
          scheduleId: 'test',
          runId: crypto.randomUUID(),
          outcome: 'completed',
        },
      })
      const next = {
        ...channel,
        lastUsedAt: this.#now(),
        lastError: result.error,
      }
      this.#channels.set(id, next)
      this.#persist()
      return result.ok
        ? ok(this.#redact(next))
        : fail('unreachable', '通知推送失败')
    })
  }

  #reserve(
    schedule: StoredSchedule,
    plannedAt: number,
    trigger: ScheduleRunView['trigger'],
    note: string | null,
  ): ScheduleRunView {
    const reason = this.#estop()
      ? '紧急停止'
      : this.#active.has(schedule.id)
        ? '上一轮未结束'
        : null
    const view: ScheduleRunView = {
      runId: crypto.randomUUID(),
      scheduleId: schedule.id,
      plannedAt,
      startedAt: this.#now(),
      finishedAt: reason ? this.#now() : null,
      outcome: reason ? 'skipped' : 'running',
      taskId: null,
      sessionId: schedule.sessionId,
      excerpt: null,
      reason: [reason, note].filter(Boolean).join('；') || null,
      pushed: [],
      trigger,
    }
    if (reason) {
      this.#append(view)
      return this.#redact(view)
    }
    const active: ActiveRun = {
      view,
      schedule: structuredClone(schedule),
      baseline: new Set(),
      notices: [],
      phase: 'sending',
    }
    this.#active.set(schedule.id, active)
    try {
      this.#persist()
    } catch (error) {
      this.#active.delete(schedule.id)
      throw error
    }
    this.#launch(this.#execute(active))
    return this.#redact(view)
  }

  async #execute(active: ActiveRun): Promise<void> {
    try {
      let sessionId = active.schedule.sessionId
      let transcript =
        sessionId === null
          ? null
          : await this.#options.chat.transcript(sessionId)
      if (
        transcript &&
        !transcript.ok &&
        transcript.failure.code !== 'not_found'
      )
        throw new Error('transcript unavailable')
      if (
        sessionId === null ||
        !transcript?.ok ||
        transcript.value.session.target !== active.schedule.target
      ) {
        const opened = await this.#options.chat.open(active.schedule.target)
        if (!opened.ok) throw new Error('open failed')
        sessionId = opened.value.id
        transcript = await this.#options.chat.transcript(sessionId)
      }
      if (!transcript?.ok) throw new Error('transcript unavailable')
      active.baseline = new Set(transcript.value.turns.map(turn => turn.id))
      await this.#serial(async () => {
        if (this.#closed || active.phase !== 'sending') return
        active.view = { ...active.view, sessionId }
        const schedule = this.#schedules.get(active.schedule.id)
        if (schedule?.target === active.schedule.target)
          this.#schedules.set(schedule.id, { ...schedule, sessionId })
        this.#persist()
      })
      if (this.#closed || active.phase !== 'sending') return
      // ESTOP can engage during open/transcript I/O, before bytes leave.
      if (this.#estop()) {
        await this.#serial(async () => {
          this.#finish(active, 'skipped', null, '紧急停止')
        })
        return
      }
      const sent = await this.#options.chat.send({
        sessionId,
        text: active.schedule.prompt,
        ...(active.schedule.direction === null
          ? {}
          : { direction: active.schedule.direction }),
        taskTtlMs: active.schedule.timeoutMs,
      })
      await this.#serial(async () => {
        if (this.#closed || active.phase !== 'sending') return
        if (!sent.ok) {
          this.#finish(active, 'failed', null, '对话发送失败')
          return
        }
        active.view = { ...active.view, taskId: sent.value.taskId ?? null }
        active.phase = 'waiting'
        this.#persist()
        await this.#inspect(active)
      })
    } catch {
      await this.#serial(async () => {
        if (!this.#closed && active.phase !== 'pushing')
          this.#finish(active, 'failed', null, '对话执行失败')
      })
    }
  }

  async #inspect(active: ActiveRun): Promise<void> {
    if (
      this.#closed ||
      active.phase === 'pushing' ||
      active.view.sessionId === null
    )
      return
    const transcript = await this.#options.chat.transcript(
      active.view.sessionId,
    )
    if (!transcript.ok) {
      if (transcript.failure.code === 'not_found')
        this.#finish(active, 'failed', null, '专属对话会话已删除')
      return
    }
    const turns = transcript.value.turns.filter(
      turn => !active.baseline.has(turn.id),
    )
    active.notices = turns
      .filter(
        turn =>
          turn.author === 'agent' &&
          turn.variant === 'notice' &&
          turn.noticeSource === 'agent' &&
          (turn.causeTaskId === undefined ||
            turn.causeTaskId === active.view.taskId) &&
          turn.at >= active.view.startedAt,
      )
      .map(turn => turn.text)
    if (active.phase !== 'waiting') return
    const reply = turns.find(
      turn =>
        turn.author === 'agent' &&
        turn.variant !== 'notice' &&
        turn.taskId === active.view.taskId &&
        (turn.state === 'done' || turn.state === 'failed'),
    )
    if (reply) {
      this.#finish(
        active,
        reply.state === 'done'
          ? 'completed'
          : reply.code === 'E_TASK_TIMEOUT'
            ? 'timeout'
            : 'failed',
        reply,
        reply.state === 'done'
          ? null
          : reply.code === 'E_TASK_TIMEOUT'
            ? '任务超时'
            : '智能体运行失败',
      )
    }
  }

  #finish(
    active: ActiveRun,
    outcome: ScheduleRunView['outcome'],
    reply: ChatTurn | null,
    reason: string | null,
  ): void {
    if (active.phase === 'pushing') return
    active.phase = 'pushing'
    const view: ScheduleRunView = this.#redact({
      ...active.view,
      outcome,
      finishedAt: this.#now(),
      excerpt: reply ? [...reply.text].slice(0, 2000).join('') : null,
      reason: [reason, active.view.reason].filter(Boolean).join('；') || null,
    })
    if (outcome === 'skipped') {
      this.#append(view)
      this.#active.delete(view.scheduleId)
      this.#persist()
      return
    }
    // Until the notification result is durable this is still an unfinished run.
    // A restart records it as failed instead of silently retrying an external push.
    active.view = { ...view, outcome: 'running', finishedAt: null }
    this.#persist()
    this.#launch(
      (async () => {
        const pushed: {
          channelId: string
          ok: boolean
          error: string | null
        }[] = []
        if (!active.schedule.notifyOnlyAgent || active.notices.length) {
          const body = this.#redact(
            active.schedule.notifyOnlyAgent
              ? active.notices.join('\n')
              : (view.excerpt ?? view.reason ?? '任务已结束'),
          )
          for (const id of active.schedule.channels) {
            const channel = this.#channels.get(id)
            const result = channel
              ? await this.#push(channel, {
                  title: this.#redact(active.schedule.title),
                  body,
                  at: view.finishedAt!,
                  qianmo: {
                    scheduleId: view.scheduleId,
                    runId: view.runId,
                    outcome,
                  },
                })
              : { ok: false, error: '通知渠道不存在' }
            pushed.push({ channelId: id, ok: result.ok, error: result.error })
            await this.#serial(async () => {
              const current = this.#channels.get(id)
              if (current)
                this.#channels.set(id, {
                  ...current,
                  lastUsedAt: this.#now(),
                  lastError: result.error,
                })
            })
          }
        }
        await this.#serial(async () => {
          if (this.#closed) return
          this.#append({ ...view, pushed })
          this.#active.delete(view.scheduleId)
          this.#persist()
        })
      })(),
    )
  }

  async tick(): Promise<void> {
    await this.#serial(async () => {
      if (this.#closed) return
      const now = this.#now()
      this.#tickAt = now
      let admitted = true
      try {
        const verdict = await this.#options.actions?.admit?.()
        admitted = verdict?.ok ?? true
      } catch {
        admitted = false
      }
      // Decide overdue runs before settling old ones: a still-running prior turn skips this slot.
      for (const schedule of this.#schedules.values()) {
        if (
          !admitted ||
          !schedule.enabled ||
          schedule.nextRunAt === null ||
          schedule.nextRunAt > now
        )
          continue
        const planned = schedule.nextRunAt
        let next = planned
        let missed = 0
        if (schedule.when.kind === 'interval') {
          missed = Math.floor(
            (now - planned) / (schedule.when.everyMinutes * MINUTE),
          )
          next = nextRunAt(schedule.when, schedule.timezone, now)!
        } else {
          do {
            next = nextRunAt(schedule.when, schedule.timezone, next)!
            if (next !== null && next <= now) missed++
          } while (next !== null && next <= now)
        }
        const updated = { ...schedule, nextRunAt: next }
        this.#schedules.set(schedule.id, updated)
        let run: ScheduleRunView
        try {
          // Reserve persists nextRunAt and the in-flight checkpoint together,
          // before opening a conversation or sending any bytes.
          run = this.#reserve(
            updated,
            planned,
            'schedule',
            missed ? `错过 ${missed} 次，仅补跑一次` : null,
          )
          if (run.outcome === 'skipped') this.#persist()
        } catch (error) {
          this.#schedules.set(schedule.id, schedule)
          throw error
        }
        try {
          const recorded = await this.#options.actions?.record({
            at: now,
            requestId: run.runId,
            subject: 'system:schedules',
            action: 'schedule.run',
            target: schedule.id,
            outcome: 'ok',
          })
          if (recorded && !recorded.ok)
            this.#options.onError?.('定时任务动作账本记录失败')
        } catch {
          this.#options.onError?.('定时任务动作账本记录失败')
        }
      }
      for (const active of this.#active.values()) {
        await this.#inspect(active)
        if (
          active.phase !== 'pushing' &&
          now - active.view.startedAt >= active.schedule.timeoutMs
        )
          this.#finish(active, 'timeout', null, '任务超时')
      }
    })
  }

  start(): void {
    if (this.#timer || this.#closed) return
    this.#launch(this.tick())
    this.#timer = setInterval(() => {
      this.#launch(this.tick())
    }, 30_000)
    this.#timer.unref()
  }

  close(): void {
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    this.#unsubscribe?.()
    this.#unsubscribe = null
    this.#ledger.close()
  }
}
