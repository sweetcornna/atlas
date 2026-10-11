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
import type {
  DirectionActor,
  NotifyChannelDraft,
  NotifyChannelView,
  ScheduleDraft,
  ScheduleRunView,
  SchedulesPort,
  SchedulesSnapshot,
  ScheduleTemplateView,
  ScheduleView,
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

/** What `test/preview.ts`-style harnesses wire: one fake per port. */
export const PREVIEW_PORTS: Readonly<
  Record<string, (now: () => number) => unknown>
> = {
  schedules: now => new FakeSchedules(now),
  avatars: now => new FakeAvatars(now),
}
