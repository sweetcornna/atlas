// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Hand-written, working fakes of the 2026-10 ports (`directionPorts.ts`), for
 * the page tests and for `test/preview.ts`. Like every fake here: plain
 * objects with state, no module mocking, the clock injected.
 */

import type {
  AvatarKey,
  AvatarRecord,
  AvatarSpec,
  AvatarsPort,
} from '../src/avatar.js'
import type { ConsoleFailure, ConsoleResult } from '../src/contracts.js'
import {
  MEMORY_KINDS,
  type AgentRef,
  type DirectionActor,
  type MemoryDraft,
  type MemoryEntryView,
  type MemoryKind,
  type MemoryPort,
  type MemoryQueryInput,
  type NotifyChannelDraft,
  type NotifyChannelView,
  type ScheduleDraft,
  type ScheduleRunView,
  type SchedulesPort,
  type SchedulesSnapshot,
  type ScheduleTemplateView,
  type ScheduleView,
} from '../src/directionPorts.js'

export function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

export function failed<T>(
  code: ConsoleFailure['code'],
  message: string,
): ConsoleResult<T> {
  return { ok: false, failure: { code, message } }
}

export const TEMPLATES: readonly ScheduleTemplateView[] = [
  {
    id: 'briefing',
    title: '晨间简报',
    prompt:
      '请结合长期记忆里的计划与待办 今天的日程和昨天未完成的事项 写一份不超过 300 字的简报 最后列出今天最重要的三件事',
    needs: null,
  },
  {
    id: 'followup',
    title: '跟进待办',
    prompt:
      '检查记忆里标记为计划或待办的事项 逐条说明进展和下一步 需要我拿主意的单独列出并通知我',
    needs: null,
  },
  {
    id: 'mail',
    title: '整理邮件',
    prompt:
      '读取最近 24 小时的未读邮件 按需要回复 需要知道 可忽略分三类 各列标题与一句摘要',
    needs: '邮件连接',
  },
  { id: 'custom', title: '自定义', prompt: '', needs: null },
]

/** A schedules port with a believable morning in it. */
export class FakeSchedules implements SchedulesPort {
  readonly calls: string[] = []
  schedules: ScheduleView[]
  runs: ScheduleRunView[]
  channels: NotifyChannelView[]
  estop = false
  readonly targets: readonly string[]
  #seq = 10

  constructor(
    private readonly now: () => number,
    targets: readonly string[] = [
      'qianmo://tokyo-1/planner',
      'qianmo://osaka-1/writer',
    ],
  ) {
    const at = now()
    this.targets = targets
    this.channels = [
      {
        id: 'ch-1',
        name: '我的手机',
        kind: 'bark',
        host: 'api.day.app',
        createdAt: at - 86_400_000 * 3,
        lastUsedAt: at - 3_600_000,
        lastError: null,
      },
    ]
    const brief: ScheduleRunView = {
      runId: 'run-1',
      scheduleId: 'sch-1',
      plannedAt: at - 3_600_000,
      startedAt: at - 3_600_000 + 400,
      finishedAt: at - 3_600_000 + 48_000,
      outcome: 'completed',
      taskId: 'task-run-1',
      sessionId: 'sess-brief',
      excerpt:
        '今天的重点有三件\n1 上午十点前把接力插件的配对流程交给评审\n2 下午整理文件互通的验收用例\n3 晚上给记忆页补窄屏检查\n昨天未完成 控制台的路由文档还差两条',
      reason: null,
      pushed: [{ channelId: 'ch-1', ok: true, error: null }],
      trigger: 'schedule',
    }
    this.runs = [brief]
    this.schedules = [
      {
        id: 'sch-1',
        title: '晨间简报',
        target: 'qianmo://tokyo-1/planner',
        template: 'briefing',
        prompt: TEMPLATES[0]?.prompt ?? '',
        when: { kind: 'daily', time: '08:00' },
        timezone: 'Asia/Shanghai',
        direction: 'chat',
        channels: ['ch-1'],
        notifyOnlyAgent: false,
        enabled: true,
        timeoutMs: 600_000,
        createdAt: at - 86_400_000 * 2,
        createdBy: 'u:0000000000000001',
        updatedAt: at - 86_400_000 * 2,
        nextRunAt: at + 20 * 3_600_000,
        lastRun: brief,
      },
      {
        id: 'sch-2',
        title: '跟进待办',
        target: 'qianmo://osaka-1/writer',
        template: 'followup',
        prompt: TEMPLATES[1]?.prompt ?? '',
        when: { kind: 'weekly', days: [1, 3, 5], time: '17:30' },
        timezone: 'Asia/Shanghai',
        direction: null,
        channels: [],
        notifyOnlyAgent: true,
        enabled: false,
        timeoutMs: 600_000,
        createdAt: at - 86_400_000,
        createdBy: 'u:0000000000000001',
        updatedAt: at - 86_400_000,
        nextRunAt: null,
        lastRun: null,
      },
    ]
  }

  async snapshot(): Promise<ConsoleResult<SchedulesSnapshot>> {
    this.calls.push('snapshot')
    return ok({
      schedules: this.schedules,
      runs: this.runs,
      channels: this.channels,
      templates: TEMPLATES,
      targets: this.targets,
      estop: this.estop,
      tickAt: this.now() - 12_000,
    })
  }

  async save(
    draft: ScheduleDraft,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ScheduleView>> {
    this.calls.push(`save ${draft.id ?? 'new'} ${actor.subject}`)
    if (typeof draft.title !== 'string' || draft.title.trim() === '') {
      return failed('invalid', 'title is required')
    }
    if (!this.targets.includes(draft.target)) {
      return failed('rejected', 'target is not on the chat allowlist')
    }
    const at = this.now()
    const existing = this.schedules.find(one => one.id === draft.id)
    const view: ScheduleView = {
      id: existing?.id ?? `sch-${++this.#seq}`,
      title: draft.title,
      target: draft.target,
      template: draft.template,
      prompt: draft.prompt,
      when: draft.when,
      timezone: draft.timezone,
      direction: draft.direction,
      channels: draft.channels,
      notifyOnlyAgent: draft.notifyOnlyAgent,
      enabled: draft.enabled,
      timeoutMs: draft.timeoutMs,
      createdAt: existing?.createdAt ?? at,
      createdBy: existing?.createdBy ?? actor.subject,
      updatedAt: at,
      nextRunAt: draft.enabled ? at + 3_600_000 : null,
      lastRun: existing?.lastRun ?? null,
    }
    this.schedules = existing
      ? this.schedules.map(one => (one.id === view.id ? view : one))
      : [...this.schedules, view]
    return ok(view)
  }

  async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<ConsoleResult<ScheduleView>> {
    this.calls.push(`${enabled ? 'enable' : 'disable'} ${id}`)
    const found = this.schedules.find(one => one.id === id)
    if (found === undefined) return failed('not_found', `no schedule ${id}`)
    const view: ScheduleView = {
      ...found,
      enabled,
      nextRunAt: enabled ? this.now() + 3_600_000 : null,
    }
    this.schedules = this.schedules.map(one => (one.id === id ? view : one))
    return ok(view)
  }

  async remove(id: string): Promise<ConsoleResult<null>> {
    this.calls.push(`remove ${id}`)
    const before = this.schedules.length
    this.schedules = this.schedules.filter(one => one.id !== id)
    return before === this.schedules.length
      ? failed('not_found', `no schedule ${id}`)
      : ok(null)
  }

  async runNow(id: string): Promise<ConsoleResult<ScheduleRunView>> {
    this.calls.push(`run ${id}`)
    const found = this.schedules.find(one => one.id === id)
    if (found === undefined) return failed('not_found', `no schedule ${id}`)
    const at = this.now()
    const run: ScheduleRunView = {
      runId: `run-${++this.#seq}`,
      scheduleId: id,
      plannedAt: at,
      startedAt: at,
      finishedAt: null,
      outcome: 'running',
      taskId: null,
      sessionId: null,
      excerpt: null,
      reason: null,
      pushed: [],
      trigger: 'manual',
    }
    this.runs = [run, ...this.runs]
    return ok(run)
  }

  async saveChannel(
    draft: NotifyChannelDraft,
  ): Promise<ConsoleResult<NotifyChannelView>> {
    this.calls.push(`channel.save ${draft.name}`)
    let host = ''
    try {
      host = new URL(draft.url ?? '').hostname
    } catch {
      return failed('invalid', 'url is not a URL')
    }
    const view: NotifyChannelView = {
      id: `ch-${++this.#seq}`,
      name: draft.name,
      kind: draft.kind,
      host,
      createdAt: this.now(),
      lastUsedAt: null,
      lastError: null,
    }
    this.channels = [...this.channels, view]
    return ok(view)
  }

  async removeChannel(id: string): Promise<ConsoleResult<null>> {
    this.calls.push(`channel.remove ${id}`)
    this.channels = this.channels.filter(one => one.id !== id)
    return ok(null)
  }

  async testChannel(id: string): Promise<ConsoleResult<NotifyChannelView>> {
    this.calls.push(`channel.test ${id}`)
    const found = this.channels.find(one => one.id === id)
    if (found === undefined) return failed('not_found', `no channel ${id}`)
    const view = { ...found, lastUsedAt: this.now(), lastError: null }
    this.channels = this.channels.map(one => (one.id === id ? view : one))
    return ok(view)
  }
}

/** A figure store kept in a map; `failRead` makes every read fail. */
export class FakeAvatars implements AvatarsPort {
  readonly calls: string[] = []
  readonly saved = new Map<AvatarKey, AvatarRecord>()
  failRead = false

  constructor(private readonly now: () => number) {}

  async read(
    keys: readonly AvatarKey[],
  ): Promise<ConsoleResult<ReadonlyMap<AvatarKey, AvatarRecord>>> {
    this.calls.push(`read ${keys.length}`)
    if (this.failRead) return failed('unreachable', 'avatar store down')
    const found = new Map<AvatarKey, AvatarRecord>()
    for (const key of keys) {
      const record = this.saved.get(key)
      if (record !== undefined) found.set(key, record)
    }
    return ok(found)
  }

  async save(
    key: AvatarKey,
    spec: AvatarSpec | null,
    actor: DirectionActor,
  ): Promise<ConsoleResult<AvatarRecord | null>> {
    this.calls.push(`save ${key} ${spec === null ? 'default' : spec.shape}`)
    if (spec === null) {
      this.saved.delete(key)
      return ok(null)
    }
    const record = { spec, updatedAt: this.now(), updatedBy: actor.subject }
    this.saved.set(key, record)
    return ok(record)
  }
}

/**
 * A memory port that keeps each person's long-term memory apart (D18): a
 * long entry belongs to the subject that wrote it, and `list` answers only
 * the caller's own. `owner` seeds the believable entries for one subject.
 */
export class FakeMemory implements MemoryPort {
  readonly calls: string[] = []
  entries: MemoryEntryView[] = []
  failList = false
  readonly roster: readonly (AgentRef & { readonly reachable: boolean })[]
  #seq = 10

  constructor(
    private readonly now: () => number,
    owner = 'legacy:admin',
    roster: readonly (AgentRef & { readonly reachable: boolean })[] = [
      { node: 'tokyo-1', agent: 'planner', reachable: true },
      { node: 'osaka-1', agent: 'writer', reachable: false },
    ],
  ) {
    this.roster = roster
    const at = now()
    const seed: [MemoryKind, string, string, string, number, string][] = [
      [
        'preference',
        '简报控制在 300 字以内',
        '每天的简报不超过 300 字 · 最后列三件最重要的事',
        '',
        6,
        'user',
      ],
      [
        'preference',
        '回复先给结论',
        '先说结论再说理由 · 不要客套开场',
        '',
        30,
        'session',
      ],
      [
        'plan',
        '本周把接力插件交评审',
        '周五前交接力插件的配对流程 · 评审人是负责人',
        '配对码 15 分钟有效 · 设备令牌只给一次\n评审前先在 tokyo-1 上跑一遍完整配对',
        50,
        'agent',
      ],
      [
        'project',
        '阡陌控制台改版',
        '对话为首页 · 侧栏精简成对话 主动执行 记忆 连接 云端电脑 模型',
        '',
        200,
        'session',
      ],
      [
        'daily',
        '周三下午不排会',
        '周三 14:00 以后留给写作 · 有会议就往后挪',
        '',
        400,
        'user',
      ],
    ]
    for (const [kind, title, summary, body, ago, source] of seed) {
      this.entries.push(
        this.entry(
          { node: 'tokyo-1', agent: 'planner' },
          owner,
          { kind, title, summary, body },
          source,
          at - ago * 3_600_000,
        ),
      )
    }
  }

  private entry(
    ref: AgentRef,
    owner: string,
    draft: MemoryDraft,
    source: string,
    at: number,
  ): MemoryEntryView {
    this.#seq += 1
    return {
      node: ref.node,
      agent: ref.agent,
      id: `mem-${this.#seq}`,
      owner,
      scope: 'long',
      contextId: null,
      kind: draft.kind,
      title: draft.title,
      summary: draft.summary,
      body: draft.body,
      tags: [],
      source: { kind: source, id: owner },
      createdAt: at,
      validAt: at,
      invalidAt: null,
      retired: null,
      supersedes: null,
      supersededBy: null,
    }
  }

  private mine(ref: AgentRef, actor: DirectionActor): MemoryEntryView[] {
    return this.entries.filter(
      one =>
        one.node === ref.node &&
        one.agent === ref.agent &&
        one.owner === actor.subject,
    )
  }

  private find(
    ref: AgentRef,
    id: string,
    actor: DirectionActor,
  ): MemoryEntryView | null {
    return this.mine(ref, actor).find(one => one.id === id) ?? null
  }

  private replace(next: MemoryEntryView): void {
    this.entries = this.entries.map(one => (one.id === next.id ? next : one))
  }

  async agents(): Promise<
    ConsoleResult<readonly (AgentRef & { readonly reachable: boolean })[]>
  > {
    return ok(this.roster)
  }

  async list(input: MemoryQueryInput, actor: DirectionActor) {
    this.calls.push(`list ${input.node}/${input.agent} ${actor.subject}`)
    if (this.failList) return failed<never>('unreachable', 'memory store down')
    const live = (one: MemoryEntryView) =>
      one.retired === null &&
      one.invalidAt === null &&
      one.supersededBy === null
    const own = this.mine(input, actor)
    const counts = Object.fromEntries(
      MEMORY_KINDS.map(kind => [
        kind,
        own.filter(one => live(one) && one.kind === kind).length,
      ]),
    ) as Record<MemoryKind, number>
    const text = (input.text ?? '').toLowerCase()
    const matched = own
      .filter(one => input.includeRetired === true || live(one))
      .filter(one => input.kind === undefined || one.kind === input.kind)
      .filter(
        one =>
          text === '' ||
          `${one.title} ${one.summary} ${one.body}`
            .toLowerCase()
            .includes(text),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
    return ok({
      entries: matched.slice(0, input.limit ?? 60),
      total: matched.length,
      counts,
    })
  }

  async add(ref: AgentRef, draft: MemoryDraft, actor: DirectionActor) {
    this.calls.push(`add ${ref.node}/${ref.agent} ${draft.title}`)
    if (
      !this.roster.some(one => one.node === ref.node && one.agent === ref.agent)
    ) {
      return failed<never>('not_found', 'no such agent')
    }
    const made = this.entry(ref, actor.subject, draft, 'user', this.now())
    this.entries.push(made)
    return ok(made)
  }

  async edit(
    ref: AgentRef,
    id: string,
    draft: MemoryDraft,
    actor: DirectionActor,
  ) {
    this.calls.push(`edit ${id}`)
    const old = this.find(ref, id, actor)
    if (old === null) return failed<never>('not_found', 'no such memory')
    const made = {
      ...this.entry(ref, actor.subject, draft, 'user', this.now()),
      supersedes: id,
    }
    this.replace({ ...old, supersededBy: made.id, invalidAt: this.now() })
    this.entries.push(made)
    return ok(made)
  }

  async forget(
    ref: AgentRef,
    id: string,
    reason: string,
    actor: DirectionActor,
  ) {
    this.calls.push(`forget ${id} ${reason}`)
    const old = this.find(ref, id, actor)
    if (old === null) return failed<never>('not_found', 'no such memory')
    const next: MemoryEntryView = {
      ...old,
      retired: { kind: 'revoked', reason, by: actor.subject },
    }
    this.replace(next)
    return ok(next)
  }

  async invalidate(ref: AgentRef, id: string, actor: DirectionActor) {
    this.calls.push(`invalidate ${id}`)
    const old = this.find(ref, id, actor)
    if (old === null) return failed<never>('not_found', 'no such memory')
    const next = { ...old, invalidAt: this.now() }
    this.replace(next)
    return ok(next)
  }
}

/** What `test/preview.ts`-style harnesses wire: one fake per port. */
export const PREVIEW_PORTS: Readonly<
  Record<string, (now: () => number) => unknown>
> = {
  schedules: now => new FakeSchedules(now),
  avatars: now => new FakeAvatars(now),
  memory: now => new FakeMemory(now),
}
