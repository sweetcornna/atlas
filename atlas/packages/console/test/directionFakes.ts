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
  MODEL_DIRECTIONS,
  type AgentRef,
  type ChannelDraft,
  type ChannelLoginView,
  type ChannelPairingDecision,
  type ChannelPlatformView,
  type ChannelsPort,
  type ChannelsSnapshot,
  type ChannelView,
  type ConnectorDraft,
  type ConnectorPresetView,
  type ConnectorsPort,
  type ConnectorsSnapshot,
  type ConnectorView,
  type DesktopActionView,
  type DesktopApps,
  type DesktopConfirm,
  type DesktopNodeView,
  type DesktopPort,
  type DesktopScreenView,
  type ExtensionDraft,
  type ExtensionsPort,
  type ExtensionsSnapshot,
  type ExtensionView,
  type FileEntryView,
  type FileGrantView,
  type FileGroupView,
  type FileRequestView,
  type FileScope,
  type FilesPort,
  type FilesSnapshot,
  type FileTransferView,
  type HandoffDevicesPort,
  type HandoffDeviceView,
  type HandoffPairingCode,
  type DirectionActor,
  type MagpieAgentChange,
  type MagpieAgentsNodeView,
  type MagpieAgentsPort,
  type MagpieAgentsSnapshot,
  type MagpieAgentView,
  type MagpieBinding,
  type MagpieCaller,
  type MagpieConnectDraft,
  type MagpieConnectionView,
  type MagpieExtensionInstall,
  type MagpieExtensionJobView,
  type MagpieExtensionRemove,
  type MagpieExtensionsView,
  type MagpieGroupDraft,
  type MagpieGroupView,
  type MagpieKeyChange,
  type MagpieKeyDraft,
  type MagpieKeyView,
  type MagpiePort,
  type MagpieProviderDraft,
  type MagpieProviderView,
  type MagpieRuntimeJobView,
  type MagpieRuntimeView,
  type MagpieSnapshot,
  type MagpieTestView,
  type MagpieUsagePeriod,
  type MagpieUsageView,
  type MemoryDraft,
  type MemoryEntryView,
  type MemoryKind,
  type MemoryPort,
  type MemoryQueryInput,
  type ModelRouteView,
  type ModelRoutingPort,
  type ModelRoutingSnapshot,
  type ModelRoutingView,
  type NotifyChannelDraft,
  type NotifyChannelView,
  type ScheduleDraft,
  type ScheduleReader,
  type ScheduleRunView,
  type SchedulesPort,
  type SchedulesSnapshot,
  type ScheduleTemplateView,
  type ScheduleView,
  type UpdatesDraft,
  type UpdatesPort,
  type UpdatesSnapshot,
} from '../src/directionPorts.js'
import { extensionInstallRequest } from '../src/extensionSource.js'

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
    // A manual run whose end never came back: it holds the schedule until a
    // person confirms how it went.
    const lost: ScheduleRunView = {
      state: 'unknown',
      runId: 'run-0',
      scheduleId: 'sch-1',
      plannedAt: at - 26 * 3_600_000,
      startedAt: at - 26 * 3_600_000 + 300,
      finishedAt: null,
      outcome: 'running',
      taskId: 'task-run-0',
      sessionId: 'sess-lost',
      excerpt: null,
      reason: '本地等待超时，没有收到这一轮的结果',
      pushed: [],
      trigger: 'manual',
    }
    this.runs = [brief, lost]
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

  visible(id: string, actor: ScheduleReader): boolean {
    const row = this.schedules.find(v => v.id === id)
    return (
      row !== undefined &&
      (actor.role === 'ops' ||
        (actor.role == null && actor.subject.startsWith('legacy:')) ||
        row.createdBy === actor.subject)
    )
  }

  targetOf(id: string): string | undefined {
    return this.schedules.find(v => v.id === id)?.target
  }

  channelTenant(id: string): string | null | undefined {
    const row = this.channels.find(v => v.id === id)
    return row === undefined ? undefined : (row.tenant ?? null)
  }

  async resolve(
    id: string,
    runId: string,
    outcome: 'ok' | 'failed',
    _actor: DirectionActor,
  ): Promise<ConsoleResult<ScheduleRunView>> {
    this.calls.push(`resolve ${id} ${runId}`)
    const run = this.runs.find(v => v.runId === runId && v.scheduleId === id)
    if (!run) return failed('not_found', 'no run')
    const settled: ScheduleRunView = {
      ...run,
      state: outcome === 'ok' ? 'completed' : 'failed',
      outcome: outcome === 'ok' ? 'completed' : 'failed',
      finishedAt: this.now(),
    }
    this.runs = this.runs.map(v => (v === run ? settled : v))
    return ok(settled)
  }

  async snapshot(
    actor: ScheduleReader,
  ): Promise<ConsoleResult<SchedulesSnapshot>> {
    this.calls.push('snapshot')
    return ok({
      schedules: this.schedules.filter(v => this.visible(v.id, actor)),
      runs: this.runs.filter(v => this.visible(v.scheduleId, actor)),
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
      ...(draft.tenant === undefined ? {} : { tenant: draft.tenant }),
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

/**
 * A routing book: defaults plus node overrides under one revision, the
 * models two chat services and two media services offer, and a few
 * decisions the nodes reported.
 */
export class FakeRouting implements ModelRoutingPort {
  readonly calls: string[] = []
  revision = 3
  defaults: ModelRoutingView
  nodes: ModelRoutingView[] = []
  failSnapshot = false

  constructor(private readonly now: () => number) {
    const at = now()
    this.defaults = {
      node: null,
      auto: true,
      routes: MODEL_DIRECTIONS.map(direction =>
        direction === 'code'
          ? { direction, profileId: 'deepseek', modelId: 'deepseek-coder' }
          : direction === 'image'
            ? { direction, profileId: 'images', modelId: 'gpt-image-1' }
            : { direction, profileId: null, modelId: null },
      ),
      revision: this.revision,
      updatedAt: at - 3_600_000 * 5,
      updatedBy: 'u:ops-1',
    }
  }

  async snapshot() {
    this.calls.push('snapshot')
    if (this.failSnapshot) {
      return failed<ModelRoutingSnapshot>('unreachable', 'routing book down')
    }
    const at = this.now()
    return ok<ModelRoutingSnapshot>({
      defaults: { ...this.defaults, revision: this.revision },
      nodes: this.nodes.map(one => ({ ...one, revision: this.revision })),
      models: [
        {
          profileId: 'deepseek',
          profileName: 'DeepSeek',
          modelId: 'deepseek-coder',
          kind: 'chat',
          evaluated: true,
        },
        {
          profileId: 'deepseek',
          profileName: 'DeepSeek',
          modelId: 'deepseek-chat',
          kind: 'chat',
          evaluated: true,
        },
        {
          profileId: 'chat-svc',
          profileName: '团队网关',
          modelId: 'gpt-6-luna',
          kind: 'chat',
          evaluated: true,
        },
        {
          profileId: 'images',
          profileName: 'OpenAI Images',
          modelId: 'gpt-image-1',
          kind: 'image',
          evaluated: false,
        },
        {
          profileId: 'video',
          profileName: 'OpenRouter 视频',
          modelId: 'video-preview',
          kind: 'video',
          evaluated: false,
        },
      ],
      recent: [
        {
          node: 'node-a',
          agent: 'planner',
          at: at - 120_000,
          direction: 'code',
          source: 'auto',
          model: 'qm-deepseek/deepseek-coder',
        },
        {
          node: 'node-b',
          agent: 'writer',
          at: at - 900_000,
          direction: 'image',
          source: 'hint',
          model: 'qm-images/gpt-image-1',
        },
        {
          node: 'node-a',
          agent: 'planner',
          at: at - 3_600_000,
          direction: 'chat',
          source: 'default',
          model: 'qm-deepseek/deepseek-chat',
        },
      ],
    })
  }

  async save(
    input: {
      readonly node: string | null
      readonly auto: boolean
      readonly routes: readonly ModelRouteView[]
      readonly revision: number
    },
    actor: DirectionActor,
  ) {
    this.calls.push(`save ${input.node ?? 'default'} ${actor.subject}`)
    if (input.revision !== this.revision) {
      return failed<ModelRoutingView>(
        'rejected',
        'revision 不符 · 请刷新后重试',
      )
    }
    const current =
      input.node === null
        ? this.defaults
        : (this.nodes.find(one => one.node === input.node) ?? {
            ...this.defaults,
            node: input.node,
          })
    this.revision += 1
    const view: ModelRoutingView = {
      ...current,
      auto: input.auto,
      routes: current.routes.map(
        one =>
          input.routes.find(patch => patch.direction === one.direction) ?? one,
      ),
      revision: this.revision,
      updatedAt: this.now(),
      updatedBy: actor.subject,
    }
    if (input.node === null) this.defaults = view
    else
      this.nodes = [...this.nodes.filter(one => one.node !== input.node), view]
    return ok(view)
  }

  async clearNode(node: string, actor: DirectionActor) {
    this.calls.push(`clear ${node} ${actor.subject}`)
    this.nodes = this.nodes.filter(one => one.node !== node)
    this.revision += 1
    return ok<ModelRoutingView>({
      ...this.defaults,
      node,
      revision: this.revision,
    })
  }
}

export const CONNECTOR_PRESETS: readonly ConnectorPresetView[] = [
  {
    id: 'qq-mail',
    kind: 'mail',
    name: 'QQ 邮箱',
    defaults: {
      username: '',
      imapHost: 'imap.qq.com',
      imapPort: 993,
      smtpHost: 'smtp.qq.com',
      smtpPort: 465,
    },
    hint: '在 QQ 邮箱设置里开启 IMAP/SMTP 并生成授权码 · 这里填授权码',
    evaluated: false,
  },
  {
    id: 'gmail',
    kind: 'mail',
    name: 'Gmail',
    defaults: {
      username: '',
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
    },
    hint: '开启两步验证后生成应用专用密码 · 这里填应用专用密码',
    evaluated: false,
  },
  {
    id: 'icloud-calendar',
    kind: 'calendar',
    name: 'iCloud 日历',
    defaults: { username: '', caldavUrl: 'https://caldav.icloud.com/' },
    hint: '在 Apple 账户里生成 App 专用密码',
    evaluated: false,
  },
  {
    id: 'ics',
    kind: 'calendar',
    name: 'ICS 订阅',
    defaults: {},
    hint: '只读 · 订阅地址里通常带令牌 · 按秘密保存',
    evaluated: false,
  },
  {
    id: 'github-repo',
    kind: 'repo',
    name: 'GitHub 仓库',
    defaults: { repo: 'owner/name', exchange: false },
    hint: '只授权这一个仓库的 Contents 读写 · 用于接力的代码和结果；勾选「文件交换仓库」则用于节点间文件互通（必须私有）',
    evaluated: false,
  },
]

/** The `repo` part of a view for a repo connection's settings. */
function repoOf(
  settings: ConnectorDraft['settings'],
  probe: {
    readonly private?: boolean | null
    readonly push?: boolean | null
  } | null,
): ConnectorView['repo'] {
  return {
    name: String(settings.repo ?? ''),
    exchange: settings.exchange === true,
    private: probe?.private ?? null,
    push: probe?.push ?? null,
  }
}

/** A connections port with one mailbox in it and a few calls. */
export class FakeConnectors implements ConnectorsPort {
  readonly calls: string[] = []
  connectors: ConnectorView[]
  failSnapshot = false
  readonly agents: readonly string[]
  #seq = 10

  constructor(
    private readonly now: () => number,
    agents: readonly string[] = [
      'qianmo://tokyo-1/planner',
      'qianmo://osaka-1/writer',
    ],
  ) {
    this.agents = agents
    const at = now()
    this.connectors = [
      {
        id: 'con-1',
        name: '工作邮箱',
        kind: 'mail',
        preset: 'qq-mail',
        summary: { account: 'ch***@qq.com', imapHost: 'imap.qq.com' },
        settings: {
          username: 'chen@qq.com',
          imapHost: 'imap.qq.com',
          imapPort: 993,
          smtpHost: 'smtp.qq.com',
          smtpPort: 465,
        },
        readOnly: false,
        secretSet: true,
        secretSetAt: at - 86_400_000 * 2,
        agents: ['qianmo://tokyo-1/planner'],
        evaluated: false,
        tenant: null,
        revision: 1,
        lastProbe: { at: at - 3_600_000, ok: true, detail: '登录成功' },
        createdAt: at - 86_400_000 * 2,
        createdBy: 'legacy:admin',
      },
      {
        id: 'con-2',
        name: '代码与交换仓库',
        kind: 'repo',
        preset: 'github-repo',
        summary: {},
        settings: { repo: 'cornna/qianmo-exchange', exchange: true },
        readOnly: false,
        secretSet: true,
        secretSetAt: at - 86_400_000,
        agents: [],
        repo: {
          name: 'cornna/qianmo-exchange',
          exchange: true,
          private: true,
          push: true,
        },
        evaluated: false,
        tenant: null,
        revision: 1,
        lastProbe: {
          at: at - 7_200_000,
          ok: true,
          detail: '仓库可读写（未评估）',
          private: true,
          push: true,
        },
        createdAt: at - 86_400_000,
        createdBy: 'legacy:admin',
      },
    ]
  }

  async snapshot() {
    this.calls.push('snapshot')
    if (this.failSnapshot) {
      return failed<ConnectorsSnapshot>('unreachable', 'connector book down')
    }
    const at = this.now()
    return ok<ConnectorsSnapshot>({
      connectors: this.connectors,
      presets: CONNECTOR_PRESETS,
      agents: this.agents,
      recent: [
        {
          at: at - 600_000,
          connectorId: 'con-1',
          agent: 'qianmo://tokyo-1/planner',
          op: 'mail.search',
          outcome: 'ok',
          count: 12,
          detail: null,
        },
        {
          at: at - 1_800_000,
          connectorId: 'con-1',
          agent: 'qianmo://tokyo-1/planner',
          op: 'mail.send',
          outcome: 'refused',
          count: null,
          detail: '用户没有批准',
        },
      ],
    })
  }

  async save(draft: ConnectorDraft, actor: DirectionActor) {
    this.calls.push(`save ${draft.id ?? 'new'} ${draft.name}`)
    const preset = CONNECTOR_PRESETS.find(one => one.id === draft.preset)
    if (preset === undefined)
      return failed<ConnectorView>('invalid', 'no such preset')
    const old =
      draft.id === undefined
        ? undefined
        : this.connectors.find(one => one.id === draft.id)
    if (draft.id !== undefined && old === undefined) {
      return failed<ConnectorView>('not_found', 'no such connector')
    }
    if (old === undefined && (draft.secret ?? '') === '') {
      return failed<ConnectorView>('invalid', 'secret required')
    }
    this.#seq += 1
    const at = this.now()
    const user =
      typeof draft.settings.username === 'string' ? draft.settings.username : ''
    const view: ConnectorView = {
      tenant: old?.tenant ?? null,
      revision: (old?.revision ?? 0) + 1,
      id: old?.id ?? `con-${this.#seq}`,
      name: draft.name,
      kind: draft.kind,
      preset: draft.preset,
      summary: {
        ...(user === ''
          ? {}
          : {
              account: `${user.slice(0, 2)}***${user.includes('@') ? user.slice(user.indexOf('@')) : ''}`,
            }),
        ...(typeof draft.settings.imapHost === 'string'
          ? { imapHost: draft.settings.imapHost }
          : {}),
      },
      settings: draft.settings,
      ...(draft.kind === 'repo'
        ? { repo: repoOf(draft.settings, old?.lastProbe ?? null) }
        : {}),
      readOnly: draft.preset === 'ics',
      secretSet: true,
      secretSetAt: draft.secret === undefined ? (old?.secretSetAt ?? at) : at,
      agents: draft.agents,
      evaluated: false,
      lastProbe: old?.lastProbe ?? null,
      createdAt: old?.createdAt ?? at,
      createdBy: old?.createdBy ?? actor.subject,
    }
    this.connectors =
      old === undefined
        ? [...this.connectors, view]
        : this.connectors.map(one => (one.id === view.id ? view : one))
    return ok(view)
  }

  async remove(id: string, _actor: DirectionActor) {
    this.calls.push(`remove ${id}`)
    if (!this.connectors.some(one => one.id === id))
      return failed<null>('not_found', 'no such connector')
    this.connectors = this.connectors.filter(one => one.id !== id)
    return ok(null)
  }

  async probe(id: string, _actor: DirectionActor) {
    this.calls.push(`probe ${id}`)
    const found = this.connectors.find(one => one.id === id)
    if (found === undefined)
      return failed<ConnectorView>('not_found', 'no such connector')
    const view: ConnectorView =
      found.kind === 'repo'
        ? {
            ...found,
            repo: repoOf(found.settings ?? {}, { private: true, push: true }),
            lastProbe: {
              at: this.now(),
              ok: true,
              detail: '仓库可读写（未评估）',
              private: true,
              push: true,
            },
          }
        : {
            ...found,
            lastProbe: { at: this.now(), ok: true, detail: '登录成功' },
          }
    this.connectors = this.connectors.map(one => (one.id === id ? view : one))
    return ok(view)
  }
}

/** Paired laptops: two in use, one revoked. */
export class FakeHandoffDevices implements HandoffDevicesPort {
  readonly calls: string[] = []
  devices: HandoffDeviceView[]
  #seq = 0

  constructor(
    private readonly now: () => number,
    owner = 'legacy:admin',
  ) {
    const at = now()
    this.devices = [
      {
        deviceId: 'd-aaaaaaaaaaaa',
        name: '我的 MacBook',
        platform: 'darwin-arm64',
        owner,
        createdAt: at - 86_400_000 * 6,
        lastSeenAt: at - 300_000,
        revokedAt: null,
        tasks: 14,
      },
      {
        deviceId: 'd-bbbbbbbbbbbb',
        name: '实验室工作站',
        platform: 'linux-x64',
        owner,
        createdAt: at - 86_400_000 * 3,
        lastSeenAt: at - 86_400_000,
        revokedAt: null,
        tasks: 3,
      },
      {
        deviceId: 'd-cccccccccccc',
        name: '旧笔记本',
        platform: 'win32-x64',
        owner,
        createdAt: at - 86_400_000 * 40,
        lastSeenAt: at - 86_400_000 * 30,
        revokedAt: at - 86_400_000 * 20,
        tasks: 7,
      },
    ]
  }

  async listDevices() {
    this.calls.push('list')
    return ok<readonly HandoffDeviceView[]>(this.devices)
  }

  async issuePairing(actor: DirectionActor) {
    this.calls.push(`pair ${actor.subject}`)
    this.#seq += 1
    const code = `QM${this.#seq}A-7K2P-X9WD`
    return ok<HandoffPairingCode>({
      code,
      expiresAt: this.now() + 15 * 60_000,
      command: `qm handoff login https://console.example --code ${code}`,
    })
  }

  async revokeDevice(deviceId: string, actor: DirectionActor) {
    this.calls.push(`revoke ${deviceId} ${actor.subject}`)
    const found = this.devices.find(one => one.deviceId === deviceId)
    if (found === undefined)
      return failed<HandoffDeviceView>('not_found', 'no such device')
    const view = { ...found, revokedAt: this.now() }
    this.devices = this.devices.map(one =>
      one.deviceId === deviceId ? view : one,
    )
    return ok(view)
  }
}

/** Three agents' desktops: one running on Linux, one off on macOS, one away. */
/** A 1×1 PNG: the smallest screenshot a browser will draw. */
export const DESKTOP_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/**
 * 云端电脑: tokyo-1/planner is a Linux private desktop running with every
 * §6 field; osaka-1/writer and berlin-1/helper are what a node from before
 * §6 sends (no desktop facts); kyoto-1/designer is a macOS host desktop with
 * no applications listed yet.
 */
export class FakeDesktop implements DesktopPort {
  readonly calls: string[] = []
  units: DesktopNodeView[]
  failList = false
  /** The latest screenshot per `node/agent`; absent is none. */
  readonly screens = new Map<string, DesktopScreenView | null>()
  /** What `view` answers instead, e.g. a node too old for `desktop.view`. */
  failView: ConsoleFailure | null = null

  constructor(private readonly now: () => number) {
    const at = now()
    this.screens.set('tokyo-1/planner', {
      at: at - 3_000,
      mimeType: 'image/png',
      data: DESKTOP_PIXEL_PNG,
    })
    this.units = [
      {
        node: 'tokyo-1',
        agent: 'planner',
        reachable: true,
        platform: 'linux',
        browser: {
          enabled: true,
          state: 'running',
          profileBytes: 186_000_000,
          startedAt: at - 3_600_000 * 3,
          reason: null,
        },
        computer: {
          enabled: true,
          supported: true,
          state: 'running',
          display: ':12',
          reason: null,
          mode: 'private',
          windowManager: 'openbox',
          accessibility: true,
          confined: true,
          apps: ['org.gnome.TextEditor', 'org.gnome.Calculator', 'firefox-esr'],
          terminal: false,
          memoryBytes: 327_155_712,
          memoryLimitBytes: 1_610_612_736,
        },
        confirm: 'sensitive',
        lastActionAt: at - 240_000,
        actions24h: 37,
        confirmed24h: 4,
      },
      {
        node: 'osaka-1',
        agent: 'writer',
        reachable: true,
        platform: 'darwin',
        browser: {
          enabled: false,
          state: 'off',
          profileBytes: null,
          startedAt: null,
          reason: null,
        },
        computer: {
          enabled: false,
          supported: false,
          state: 'off',
          display: null,
          reason: null,
        },
        confirm: 'sensitive',
        lastActionAt: null,
        actions24h: 0,
        confirmed24h: 0,
      },
      {
        node: 'berlin-1',
        agent: 'helper',
        reachable: false,
        platform: 'linux',
        browser: {
          enabled: true,
          state: 'failed',
          profileBytes: 52_000_000,
          startedAt: null,
          reason: 'Chromium 启动后 20 秒没有就绪',
        },
        computer: {
          enabled: false,
          supported: false,
          state: 'off',
          display: null,
          reason: '这个节点没有 Xvfb',
        },
        confirm: 'always',
        lastActionAt: at - 86_400_000,
        actions24h: 0,
        confirmed24h: 0,
      },
      {
        node: 'kyoto-1',
        agent: 'designer',
        reachable: true,
        platform: 'darwin',
        browser: {
          enabled: true,
          state: 'running',
          profileBytes: 64_000_000,
          startedAt: at - 600_000,
          reason: null,
        },
        computer: {
          enabled: false,
          supported: true,
          state: 'off',
          display: null,
          reason: null,
          mode: 'host',
          windowManager: null,
          accessibility: false,
          confined: false,
          apps: [],
          terminal: false,
          memoryBytes: null,
          memoryLimitBytes: null,
        },
        confirm: 'autonomous',
        lastActionAt: null,
        actions24h: 0,
        confirmed24h: 0,
      },
    ]
  }

  async list() {
    this.calls.push('list')
    if (this.failList)
      return failed<readonly DesktopNodeView[]>('unreachable', 'desktop down')
    return ok<readonly DesktopNodeView[]>(this.units)
  }

  async view(ref: AgentRef) {
    this.calls.push(`view ${ref.node}/${ref.agent}`)
    if (this.failView !== null)
      return { ok: false as const, failure: this.failView }
    if (
      !this.units.some(one => one.node === ref.node && one.agent === ref.agent)
    )
      return failed<DesktopScreenView | null>('not_found', 'no such agent')
    return ok(this.screens.get(`${ref.node}/${ref.agent}`) ?? null)
  }

  async set(
    ref: AgentRef,
    change: {
      readonly browser?: boolean
      readonly computer?: boolean
      readonly confirm?: DesktopConfirm
      readonly apps?: DesktopApps
      readonly terminal?: boolean
    },
    actor: DirectionActor,
  ) {
    this.calls.push(
      `set ${ref.node}/${ref.agent} ${JSON.stringify(change)} ${actor.subject}`,
    )
    const found = this.units.find(
      one => one.node === ref.node && one.agent === ref.agent,
    )
    if (found === undefined)
      return failed<DesktopNodeView>('not_found', 'no such agent')
    if (change.computer === true && !found.computer.supported) {
      return failed<DesktopNodeView>('rejected', '这个节点不提供专属电脑')
    }
    // §6.5, as the node holds it: a host desktop takes a list of bundle ids.
    const apps = change.apps ?? found.computer.apps
    if (
      found.computer.mode === 'host' &&
      (change.apps !== undefined || change.computer === true) &&
      !(Array.isArray(apps) && apps.length > 0 && apps.length <= 20)
    ) {
      return failed<DesktopNodeView>('invalid', 'apps 本机桌面只接受应用列表')
    }
    const at = this.now()
    const view: DesktopNodeView = {
      ...found,
      browser:
        change.browser === undefined
          ? found.browser
          : {
              ...found.browser,
              enabled: change.browser,
              state: change.browser ? 'running' : 'off',
              startedAt: change.browser ? at : null,
            },
      computer: {
        ...(change.computer === undefined
          ? found.computer
          : {
              ...found.computer,
              enabled: change.computer,
              state: change.computer ? 'running' : 'off',
              display: change.computer ? ':13' : null,
            }),
        ...(change.apps === undefined ? {} : { apps: change.apps }),
        ...(change.terminal === undefined ? {} : { terminal: change.terminal }),
      },
      confirm: change.confirm ?? found.confirm,
    }
    this.units = this.units.map(one => (one === found ? view : one))
    return ok(view)
  }

  async recycle(ref: AgentRef, actor: DirectionActor) {
    this.calls.push(`recycle ${ref.node}/${ref.agent} ${actor.subject}`)
    const found = this.units.find(
      one => one.node === ref.node && one.agent === ref.agent,
    )
    if (found === undefined)
      return failed<DesktopNodeView>('not_found', 'no such agent')
    const view: DesktopNodeView = {
      ...found,
      browser: {
        enabled: false,
        state: 'off',
        profileBytes: null,
        startedAt: null,
        reason: null,
      },
      computer: {
        ...found.computer,
        enabled: false,
        state: 'off',
        display: null,
      },
    }
    this.units = this.units.map(one => (one === found ? view : one))
    return ok(view)
  }

  async actions(ref: AgentRef | null, limit: number) {
    this.calls.push(
      `actions ${ref === null ? 'all' : `${ref.node}/${ref.agent}`} ${limit}`,
    )
    const at = this.now()
    const all: DesktopActionView[] = [
      {
        at: at - 240_000,
        node: 'tokyo-1',
        agent: 'planner',
        unit: 'browser',
        op: 'click',
        host: 'mail.example.com',
        outcome: 'confirmed',
      },
      {
        at: at - 260_000,
        node: 'tokyo-1',
        agent: 'planner',
        unit: 'browser',
        op: 'screenshot',
        host: 'mail.example.com',
        outcome: 'allowed',
      },
      {
        at: at - 900_000,
        node: 'tokyo-1',
        agent: 'planner',
        unit: 'browser',
        op: 'type',
        host: 'shop.example.com',
        outcome: 'denied',
      },
      {
        at: at - 1_800_000,
        node: 'tokyo-1',
        agent: 'planner',
        unit: 'computer',
        op: 'key',
        host: null,
        outcome: 'confirmed',
      },
    ]
    return ok<readonly DesktopActionView[]>(all.slice(0, limit))
  }
}

/**
 * 文件互通 between three agents: one request waiting, one grant live and one
 * revoked, a gathering of two sources (one done, one still delivering) and a
 * single transfer that failed its digest check.
 */
export class FakeFiles implements FilesPort {
  readonly calls: string[] = []
  /** The private exchange repo the bytes go through; null for the old relay. */
  exchange: FilesSnapshot['exchange'] | null = {
    repo: 'cornna/qianmo-exchange',
    private: true,
  }
  requests: FileRequestView[]
  grants: FileGrantView[]
  transfers: FileTransferView[]
  groups: FileGroupView[]
  failSnapshot = false
  private serial = 0

  constructor(private readonly now: () => number) {
    const at = now()
    const planner = { node: 'tokyo-1', agent: 'planner' }
    const writer = { node: 'osaka-1', agent: 'writer' }
    const helper = { node: 'berlin-1', agent: 'helper' }
    this.requests = [
      {
        requestId: 'fr-1',
        source: planner,
        target: writer,
        path: 'reports/2026-10/weekly.md',
        reason: '写周报需要上周的会议纪要',
        requestedBy: 'agent',
        at: at - 120_000,
        state: 'pending',
        grantId: null,
        note: null,
      },
      {
        requestId: 'fr-0',
        source: helper,
        target: writer,
        path: 'drafts/plan.md',
        reason: '',
        requestedBy: 'agent',
        at: at - 7_200_000,
        state: 'granted',
        grantId: 'fg-1',
        note: null,
      },
    ]
    this.grants = [
      {
        grantId: 'fg-1',
        requestId: 'fr-0',
        source: helper,
        target: writer,
        scope: { kind: 'dir', path: 'drafts' },
        grantedBy: 'u:chen',
        grantedAt: at - 7_000_000,
        expiresAt: at + 1_800_000,
        revokedAt: null,
      },
      {
        grantId: 'fg-0',
        requestId: null,
        source: planner,
        target: helper,
        scope: { kind: 'file', path: 'notes/todo.md' },
        grantedBy: 'u:chen',
        grantedAt: at - 90_000_000,
        expiresAt: at - 86_400_000,
        revokedAt: at - 88_000_000,
      },
    ]
    this.transfers = [
      {
        transferId: 'ft-1',
        grantId: 'fg-2',
        groupId: 'fgp-1',
        source: { ...planner, path: 'reports/2026-10' },
        target: { ...helper, path: 'inbox/tokyo-1/2026-10' },
        files: 12,
        bytes: 4_200_000,
        doneBytes: 4_200_000,
        manifestSha256: 'a'.repeat(64),
        exchange: {
          ref: 'refs/heads/qianmo/files/ft-1',
          commit: '5e2c9a1'.padEnd(40, '0'),
          cleaned: true,
        },
        verified: true,
        state: 'done',
        reason: null,
        startedAt: at - 600_000,
        finishedAt: at - 560_000,
      },
      {
        transferId: 'ft-2',
        grantId: 'fg-3',
        groupId: 'fgp-1',
        source: { ...writer, path: 'drafts' },
        target: { ...helper, path: null },
        files: 3,
        bytes: 860_000,
        doneBytes: 310_000,
        manifestSha256: 'b'.repeat(64),
        exchange: {
          ref: 'refs/heads/qianmo/files/ft-2',
          commit: '8d41f07'.padEnd(40, '0'),
          cleaned: false,
        },
        verified: null,
        state: 'delivering',
        reason: null,
        startedAt: at - 30_000,
        finishedAt: null,
      },
      {
        transferId: 'ft-3',
        grantId: 'fg-4',
        groupId: null,
        source: { ...helper, path: 'data/export.csv' },
        target: { ...planner, path: null },
        files: 1,
        bytes: 1_500_000,
        doneBytes: 1_500_000,
        manifestSha256: 'c'.repeat(64),
        exchange: {
          ref: 'refs/heads/qianmo/files/ft-3',
          commit: 'c07ffee'.padEnd(40, '0'),
          cleaned: true,
        },
        verified: false,
        state: 'failed',
        reason: '收件方核对摘要不一致',
        startedAt: at - 3_600_000,
        finishedAt: at - 3_590_000,
      },
    ]
    this.groups = [
      {
        groupId: 'fgp-1',
        target: helper,
        transfers: ['ft-1', 'ft-2'],
        createdBy: 'u:chen',
        createdAt: at - 600_000,
      },
    ]
  }

  async snapshot() {
    this.calls.push('snapshot')
    if (this.failSnapshot)
      return failed<FilesSnapshot>('unreachable', 'files down')
    return ok<FilesSnapshot>({
      ...(this.exchange === null ? {} : { exchange: this.exchange }),
      requests: this.requests,
      grants: this.grants,
      transfers: this.transfers,
      groups: this.groups,
      agents: [
        { node: 'tokyo-1', agent: 'planner', reachable: true },
        { node: 'osaka-1', agent: 'writer', reachable: true },
        { node: 'berlin-1', agent: 'helper', reachable: false },
      ],
      limits: {
        maxFileBytes: 64 * 1024 * 1024,
        maxTransferBytes: 256 * 1024 * 1024,
        maxFiles: 500,
        maxTtlMs: 86_400_000,
      },
    })
  }

  async decide(
    requestId: string,
    decision: {
      readonly approve: boolean
      readonly scope?: FileScope
      readonly ttlMs?: number
      readonly note?: string
    },
    actor: DirectionActor,
  ) {
    this.calls.push(
      `decide ${requestId} ${JSON.stringify(decision)} ${actor.subject}`,
    )
    const found = this.requests.find(one => one.requestId === requestId)
    if (found === undefined)
      return failed<FileRequestView>('not_found', 'no such request')
    if (found.state !== 'pending')
      return failed<FileRequestView>('rejected', 'already decided')
    if ((decision.ttlMs ?? 3_600_000) > 86_400_000)
      return failed<FileRequestView>('rejected', 'ttl too long')
    const at = this.now()
    if (!decision.approve) {
      const view: FileRequestView = {
        ...found,
        state: 'denied',
        note: decision.note ?? null,
      }
      this.requests = this.requests.map(one => (one === found ? view : one))
      return ok(view)
    }
    this.serial += 1
    const grantId = `fg-new-${this.serial}`
    this.grants = [
      {
        grantId,
        requestId,
        source: found.source,
        target: found.target,
        scope: decision.scope ?? { kind: 'file', path: found.path },
        grantedBy: actor.subject,
        grantedAt: at,
        expiresAt: at + (decision.ttlMs ?? 3_600_000),
        revokedAt: null,
      },
      ...this.grants,
    ]
    const view: FileRequestView = { ...found, state: 'granted', grantId }
    this.requests = this.requests.map(one => (one === found ? view : one))
    return ok(view)
  }

  async revokeGrant(grantId: string, actor: DirectionActor) {
    this.calls.push(`revoke ${grantId} ${actor.subject}`)
    const found = this.grants.find(one => one.grantId === grantId)
    if (found === undefined)
      return failed<FileGrantView>('not_found', 'no such grant')
    const view = { ...found, revokedAt: this.now() }
    this.grants = this.grants.map(one => (one === found ? view : one))
    return ok(view)
  }

  async transfer(
    input: {
      readonly sources: readonly (AgentRef & { readonly path: string })[]
      readonly target: AgentRef
    },
    actor: DirectionActor,
  ) {
    this.calls.push(`transfer ${JSON.stringify(input)} ${actor.subject}`)
    const at = this.now()
    this.serial += 1
    const groupId = `fgp-new-${this.serial}`
    const made = input.sources.map((source, index) => ({
      transferId: `ft-new-${this.serial}-${index}`,
      grantId: `fg-direct-${this.serial}-${index}`,
      groupId: input.sources.length > 1 ? groupId : null,
      source,
      target: { ...input.target, path: null },
      files: 0,
      bytes: 0,
      doneBytes: 0,
      manifestSha256: null,
      verified: null,
      state: 'queued' as const,
      reason: null,
      startedAt: at,
      finishedAt: null,
    }))
    this.transfers = [...made, ...this.transfers]
    const group: FileGroupView = {
      groupId,
      target: input.target,
      transfers: made.map(one => one.transferId),
      createdBy: actor.subject,
      createdAt: at,
    }
    if (input.sources.length > 1) this.groups = [group, ...this.groups]
    return ok(group)
  }

  async retry(transferId: string, actor: DirectionActor) {
    this.calls.push(`retry ${transferId} ${actor.subject}`)
    const found = this.transfers.find(one => one.transferId === transferId)
    if (found === undefined)
      return failed<FileTransferView>('not_found', 'no such transfer')
    if (found.state !== 'failed')
      return failed<FileTransferView>('rejected', 'not failed')
    const view: FileTransferView = {
      ...found,
      state: 'queued',
      doneBytes: 0,
      verified: null,
      reason: null,
      startedAt: this.now(),
      finishedAt: null,
    }
    this.transfers = this.transfers.map(one => (one === found ? view : one))
    return ok(view)
  }

  async browse(ref: AgentRef, path: string) {
    this.calls.push(`browse ${ref.node}/${ref.agent} ${path}`)
    const at = this.now()
    const tree: Record<string, readonly FileEntryView[]> = {
      '': [
        { name: 'reports', kind: 'dir', size: null, mtime: at - 3_600_000 },
        { name: 'notes', kind: 'dir', size: null, mtime: at - 86_400_000 },
        { name: 'README.md', kind: 'file', size: 2_310, mtime: at - 5_000 },
      ],
      reports: [
        { name: '2026-10', kind: 'dir', size: null, mtime: at - 3_600_000 },
      ],
      'reports/2026-10': [
        {
          name: 'weekly.md',
          kind: 'file',
          size: 18_400,
          mtime: at - 3_600_000,
        },
        {
          name: 'metrics.csv',
          kind: 'file',
          size: 402_000,
          mtime: at - 7_200_000,
        },
      ],
      notes: [],
    }
    const entries = tree[path]
    if (entries === undefined)
      return failed<readonly FileEntryView[]>('not_found', 'no such directory')
    return ok(entries)
  }
}

/** What `test/preview.ts`-style harnesses wire: one fake per port. */
export const PREVIEW_PORTS: Readonly<
  Record<string, (now: () => number) => unknown>
> = {
  schedules: now => new FakeSchedules(now),
  avatars: now => new FakeAvatars(now),
  memory: now => new FakeMemory(now),
  routing: now => new FakeRouting(now),
  connectors: now => new FakeConnectors(now),
  handoffDevices: now => new FakeHandoffDevices(now),
  desktop: now => new FakeDesktop(now),
  files: now => new FakeFiles(now),
}

export const CHANNEL_PLATFORMS: readonly ChannelPlatformView[] = [
  {
    id: 'qq',
    name: 'QQ',
    settings: [{ key: 'appId', label: 'AppID' }],
    secrets: [{ key: 'appSecret', label: 'AppSecret' }],
    qrLogin: false,
    pairing: true,
    hint: 'QQ 开放平台机器人',
    evaluated: false,
  },
  {
    id: 'weixin',
    name: '微信',
    settings: [],
    secrets: [],
    qrLogin: true,
    pairing: true,
    hint: '用微信扫码授权',
    evaluated: false,
  },
  {
    id: 'telegram',
    name: 'Telegram',
    settings: [],
    secrets: [{ key: 'token', label: 'Bot Token' }],
    qrLogin: false,
    pairing: true,
    hint: '@BotFather 创建',
    evaluated: false,
  },
]

/** `ChannelsPort` over a list: one QQ channel, a WeChat login that confirms on the second poll. */
export class FakeChannels implements ChannelsPort {
  readonly calls: string[] = []
  channels: ChannelView[]
  readonly #logins = new Map<string, { draft: ChannelDraft; polls: number }>()
  #seq = 10

  constructor(private readonly now: () => number) {
    const at = now()
    this.channels = [
      {
        id: 'ch-1',
        name: '工作 QQ',
        platform: 'qq',
        enabled: true,
        target: 'qianmo://tokyo-1/planner',
        memberTarget: 'qianmo://osaka-1/writer',
        ownerIds: ['OWNER-OPENID'],
        allowAll: false,
        allowUsers: [],
        allowGroups: ['GROUP-OPENID'],
        groupTrigger: 'mention',
        replyWindowMs: 0,
        prompt: '',
        pairing: 'on',
        pairingOpen: true,
        groupContext: true,
        pairingRequests: [
          {
            id: 'pr-1',
            userId: 'STRANGER-OPENID',
            userName: '访客',
            createdAt: at - 60_000,
            expiresAt: at + 3_540_000,
          },
        ],
        settings: { appId: '102000001' },
        secretSet: true,
        health: { state: 'connected', since: at - 3_600_000 },
        conversations: 3,
        evaluated: false,
        owner: 'legacy:admin',
        createdAt: at - 86_400_000,
        updatedAt: at - 3_600_000,
      },
    ]
  }

  async snapshot() {
    this.calls.push('snapshot')
    return ok<ChannelsSnapshot>({
      channels: this.channels,
      platforms: CHANNEL_PLATFORMS,
      agents: ['qianmo://tokyo-1/planner', 'qianmo://osaka-1/writer'],
    })
  }

  async save(draft: ChannelDraft, actor: DirectionActor) {
    this.calls.push(`save ${draft.id ?? 'new'} ${draft.name}`)
    const old =
      draft.id === undefined
        ? undefined
        : this.channels.find(one => one.id === draft.id)
    if (draft.id !== undefined && old === undefined)
      return failed<ChannelView>('not_found', 'no such channel')
    this.#seq += 1
    const at = this.now()
    const view: ChannelView = {
      id: old?.id ?? `ch-${this.#seq}`,
      name: draft.name,
      platform: draft.platform,
      enabled: draft.enabled ?? old?.enabled ?? true,
      target: draft.target,
      memberTarget: draft.memberTarget ?? old?.memberTarget ?? null,
      ownerIds: draft.ownerIds ?? old?.ownerIds ?? [],
      allowAll: draft.allowAll ?? old?.allowAll ?? false,
      allowUsers: draft.allowUsers ?? old?.allowUsers ?? [],
      allowGroups: draft.allowGroups ?? old?.allowGroups ?? [],
      groupTrigger: draft.groupTrigger ?? old?.groupTrigger ?? 'mention',
      replyWindowMs: draft.replyWindowMs ?? old?.replyWindowMs ?? 0,
      prompt: draft.prompt ?? old?.prompt ?? '',
      pairing: draft.pairing ?? old?.pairing ?? 'auto',
      pairingOpen: (draft.pairing ?? old?.pairing) === 'on',
      groupContext: draft.groupContext ?? old?.groupContext ?? true,
      pairingRequests: old?.pairingRequests ?? [],
      settings: { ...old?.settings, ...draft.settings },
      secretSet:
        old?.secretSet === true || Object.keys(draft.secrets ?? {}).length > 0,
      health: { state: 'starting', since: at },
      conversations: old?.conversations ?? 0,
      evaluated: false,
      owner: old?.owner ?? actor.subject,
      createdAt: old?.createdAt ?? at,
      updatedAt: at,
    }
    this.channels = [...this.channels.filter(one => one.id !== view.id), view]
    return ok(view)
  }

  async remove(id: string) {
    this.calls.push(`remove ${id}`)
    if (!this.channels.some(one => one.id === id))
      return failed<null>('not_found', 'no such channel')
    this.channels = this.channels.filter(one => one.id !== id)
    return ok(null)
  }

  async login(draft: ChannelDraft) {
    this.calls.push(`login ${draft.name}`)
    this.#seq += 1
    const loginId = `login-${this.#seq}`
    this.#logins.set(loginId, { draft, polls: 0 })
    return ok<ChannelLoginView>({
      loginId,
      state: 'wait',
      qr: `https://liteapp.weixin.qq.com/q/${loginId}`,
    })
  }

  async loginStatus(loginId: string, actor: DirectionActor) {
    const login = this.#logins.get(loginId)
    if (login === undefined)
      return failed<ChannelLoginView>('not_found', 'no such login')
    login.polls += 1
    const qr = `https://liteapp.weixin.qq.com/q/${loginId}`
    if (login.polls < 2)
      return ok<ChannelLoginView>({ loginId, state: 'scanned', qr })
    const saved = await this.save(
      { ...login.draft, ownerIds: ['wxid-owner'] },
      actor,
    )
    if (!saved.ok)
      return failed<ChannelLoginView>(saved.failure.code, saved.failure.message)
    this.#logins.delete(loginId)
    return ok<ChannelLoginView>({
      loginId,
      state: 'confirmed',
      qr,
      channelId: saved.value.id,
    })
  }

  async loginQr(loginId: string) {
    if (!this.#logins.has(loginId))
      return failed<string>('not_found', 'no such login')
    return ok(`https://liteapp.weixin.qq.com/q/${loginId}`)
  }

  async pair(
    channelId: string,
    requestId: string,
    decision: ChannelPairingDecision,
  ) {
    this.calls.push(`pair ${channelId} ${requestId} ${decision}`)
    const channel = this.channels.find(one => one.id === channelId)
    const request = channel?.pairingRequests.find(one => one.id === requestId)
    if (channel === undefined || request === undefined)
      return failed<ChannelView>('not_found', 'no such request')
    const view: ChannelView = {
      ...channel,
      pairingRequests: channel.pairingRequests.filter(one => one !== request),
      ownerIds:
        decision === 'owner'
          ? [...channel.ownerIds, request.userId]
          : channel.ownerIds,
      allowUsers:
        decision === 'member'
          ? [...channel.allowUsers, request.userId]
          : channel.allowUsers,
    }
    this.channels = this.channels.map(one =>
      one.id === channelId ? view : one,
    )
    return ok(view)
  }
}

// ---------------------------------------------------------------------------
// UpdatesPort (P31)
// ---------------------------------------------------------------------------

export class FakeUpdates implements UpdatesPort {
  readonly calls: string[] = []
  value: UpdatesSnapshot

  constructor(now: () => number) {
    const at = now()
    this.value = {
      times: [{ kind: 'daily', time: '08:00' }],
      timezone: 'Asia/Shanghai',
      channels: ['nc-1'],
      repo: 'qianmo-team/atlas',
      sources: [
        {
          id: 'qianmopi',
          name: 'qianmopi 上游',
          current: '18.8.8',
          latest: '18.11.0',
          nodes: [],
          action: 'notify',
          autoAvailable: true,
          checkedAt: at - 3_600_000,
          error: null,
        },
        {
          id: 'claude-code',
          name: 'Claude Code',
          current: null,
          latest: '2.1.0',
          nodes: [
            { node: 'tokyo-1', version: '2.1.0', managed: true, pinned: false },
          ],
          action: 'auto',
          autoAvailable: true,
          checkedAt: at - 3_600_000,
          error: null,
        },
        {
          id: 'codex',
          name: 'Codex',
          current: null,
          latest: null,
          nodes: [],
          action: 'notify',
          autoAvailable: true,
          checkedAt: at - 3_600_000,
          error: 'npm 查询失败',
        },
        {
          id: 'qianmo',
          name: '阡陌',
          current: '3.0.1',
          latest: '3.0.1',
          nodes: [],
          action: 'notify',
          autoAvailable: false,
          checkedAt: at - 3_600_000,
          error: null,
        },
      ],
      history: [
        {
          at: at - 3_600_000,
          source: 'qianmopi',
          current: '18.8.8',
          latest: '18.11.0',
          outcome: 'available',
          detail: '已推送 1 个通知渠道',
          trigger: 'schedule',
        },
      ],
      nextAt: at + 3_600_000,
      running: false,
      channelChoices: [{ id: 'nc-1', name: '值班群' }],
      hub: { version: '3.0.1', upgradable: true, backup: '3.0.0' },
      rollbackVersions: ['3.0.0', '2.47.2'],
      upgrade: null,
    }
  }

  async snapshot(): Promise<ConsoleResult<UpdatesSnapshot>> {
    return { ok: true, value: this.value }
  }

  async save(draft: UpdatesDraft): Promise<ConsoleResult<UpdatesSnapshot>> {
    this.calls.push(`save ${draft.times.length}`)
    this.value = {
      ...this.value,
      times: draft.times,
      timezone: draft.timezone,
      channels: draft.channels,
      repo: draft.repo,
      sources: this.value.sources.map(one => ({
        ...one,
        action: one.autoAvailable
          ? (draft.actions[one.id] ?? one.action)
          : 'notify',
      })),
    }
    return { ok: true, value: this.value }
  }

  async run(): Promise<ConsoleResult<UpdatesSnapshot>> {
    this.calls.push('run')
    this.value = { ...this.value, running: true }
    return { ok: true, value: this.value }
  }

  async upgrade(input: {
    version?: string
  }): Promise<ConsoleResult<UpdatesSnapshot>> {
    this.calls.push(`upgrade ${input.version ?? 'latest'}`)
    this.value = {
      ...this.value,
      upgrade: {
        kind: 'upgrade',
        target: input.version ?? '3.0.2',
        state: 'running',
        steps: [
          { node: 'tokyo-1', state: 'upgrading', detail: null },
          { node: 'hub', state: 'pending', detail: null },
        ],
        startedAt: 1,
        finishedAt: null,
        trigger: 'manual',
      },
    }
    return { ok: true, value: this.value }
  }

  async rollback(input: {
    version?: string
  }): Promise<ConsoleResult<UpdatesSnapshot>> {
    this.calls.push(`rollback ${input.version ?? 'backup'}`)
    return { ok: true, value: this.value }
  }
}

// ---------------------------------------------------------------------------
// ExtensionsPort (P32)
// ---------------------------------------------------------------------------

export class FakeExtensions implements ExtensionsPort {
  readonly calls: string[] = []
  readonly entries: ExtensionView[] = [
    {
      id: 'ext-00000000-0000-4000-8000-000000000001',
      kind: 'mcp',
      name: 'docs',
      description: '',
      enabled: true,
      agents: [],
      transport: 'stdio',
      command: 'docs-mcp',
      args: ['--stdio'],
      url: null,
      envKeys: ['DOCS_TOKEN'],
      headerKeys: [],
      approval: 'ask',
      body: null,
      source: null,
      nodes: [
        {
          node: 'tokyo-1',
          state: 'applied',
          detail: null,
          at: 1,
          agents: [{ agent: 'planner', state: 'applied', detail: null }],
        },
        {
          node: 'osaka-2',
          state: 'failed',
          detail: 'coder：命令找不到',
          at: 1,
          agents: [
            { agent: 'coder', state: 'failed', detail: '命令找不到' },
            { agent: 'writer', state: 'applied', detail: null },
          ],
        },
      ],
      updatedAt: 1,
      updatedBy: 'u:ops',
    },
    {
      id: 'ext-00000000-0000-4000-8000-000000000002',
      kind: 'skill',
      name: 'weekly-report',
      description: '整理本周进展',
      enabled: true,
      agents: ['qianmo://tokyo-1/planner'],
      transport: null,
      command: null,
      args: [],
      url: null,
      envKeys: [],
      headerKeys: [],
      approval: 'ask',
      body: '按项目分组列出进展',
      source: null,
      nodes: [
        { node: 'tokyo-1', state: 'applied', detail: null, at: 1, agents: [] },
      ],
      updatedAt: 1,
      updatedBy: 'u:ops',
    },
  ]

  async snapshot(): Promise<ConsoleResult<ExtensionsSnapshot>> {
    return ok({
      extensions: this.entries,
      agentChoices: ['qianmo://tokyo-1/planner', 'qianmo://osaka-2/coder'],
      nodes: ['tokyo-1', 'osaka-2'],
    })
  }

  async save(
    draft: ExtensionDraft,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ExtensionView>> {
    this.calls.push(`save ${draft.id ?? draft.name ?? '-'} ${actor.subject}`)
    const found = this.entries.find(one => one.id === draft.id)
    if (draft.id !== undefined && found === undefined)
      return failed('not_found', '没有这个扩展')
    if (found !== undefined && draft.kind === undefined) {
      const next = { ...found, enabled: draft.enabled !== false }
      this.entries.splice(this.entries.indexOf(found), 1, next)
      return ok(next)
    }
    if (draft.kind === 'mcp' && !/^[a-z][a-z0-9-]*$/.test(draft.name ?? ''))
      return failed('invalid', '名称只能用小写字母 · 数字与连字符')
    const view: ExtensionView = {
      ...this.entries[0]!,
      id:
        found?.id ??
        `ext-00000000-0000-4000-8000-${String(this.entries.length + 1).padStart(12, '0')}`,
      kind: draft.kind ?? 'mcp',
      name: draft.name ?? 'new',
      envKeys: Object.keys(draft.env ?? {}),
      nodes: [],
    }
    if (found) this.entries.splice(this.entries.indexOf(found), 1, view)
    else this.entries.push(view)
    return ok(view)
  }

  async remove(
    id: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<void>> {
    this.calls.push(`remove ${id} ${actor.subject}`)
    const index = this.entries.findIndex(one => one.id === id)
    if (index < 0) return failed('not_found', '没有这个扩展')
    this.entries.splice(index, 1)
    return ok(undefined)
  }
}

/**
 * The magpie gateway port (P33/P34), in memory: a connected magpie with two
 * API-key upstreams, a subscription upstream, one eligible and one mixed
 * routing group, and a key bound to tokyo-1. Writes change the state the
 * next snapshot shows; `calls` lists them with the caller.
 */
function fakeRuntime(
  id: string,
  label: string,
  over: Partial<MagpieRuntimeView> = {},
): MagpieRuntimeView {
  return {
    id,
    label,
    installed: true,
    version: null,
    builtin: false,
    installing: false,
    removing: false,
    verified: true,
    failed: null,
    ...over,
  }
}

function fakeAgent(
  agent: string,
  over: Partial<MagpieAgentView> = {},
): MagpieAgentView {
  return {
    agent,
    runtime: 'dsh',
    effective: 'dsh',
    model: null,
    choice: { mode: 'auto' },
    pick: null,
    outOfFamily: false,
    followsNode: false,
    choosable: true,
    reason: null,
    write: null,
    extensions: null,
    ...over,
  }
}

function fakeExtensions(
  agent: string,
  over: Partial<MagpieExtensionsView> = {},
): MagpieExtensionsView {
  return {
    node: 'tokyo-1',
    agent,
    state: 'ok',
    fresh: true,
    runtime: 'dsh',
    items: [],
    notes: [],
    openCommand: `qm runtime open ${agent}`,
    error: null,
    job: null,
    ...over,
  }
}

/**
 * The 智能体 section (P36.5): tokyo-1 on its magpie key with four agents —
 * one automatic, one manual whose last write failed, one falling back to
 * qianmopi, one on qianmopi — osaka-1 too old for the runtime ops, nagoya-1
 * out of reach. Failure text carries marks the copy rules forbid on purpose:
 * only writers see it, folded under 详情.
 *
 * Native extensions (P36.7): coder lists one of each kind and opens a web
 * frontend on a port; reviewer's last read and install failed; builder has
 * an install running and was never read; planner's plugin is not loaded by
 * the resident runtime.
 */
export class FakeMagpieAgents implements MagpieAgentsPort {
  readonly calls: string[] = []
  autoJoin = true
  readonly nodes: MagpieAgentsNodeView[] = [
    {
      node: 'tokyo-1',
      state: 'ok',
      gateway: 'bound',
      tenant: null,
      defaultRuntime: 'dsh',
      runtimes: [
        fakeRuntime('dsh', 'DeepSeek Harness', {
          version: '0.2.0-rc.2',
          verified: false,
        }),
        fakeRuntime('omp', 'qianmopi', { builtin: true }),
        fakeRuntime('claude-code', 'Claude Code', { version: '2.1.301' }),
        fakeRuntime('codex', 'Codex', {
          installed: false,
          failed: { at: 1_700_000_000_000, message: 'npm 下载失败，网络超时' },
        }),
      ],
      agents: [
        fakeAgent('coder', {
          model: 'deepseek/deepseek-v4',
          pick: 'deepseek/deepseek-v4',
          extensions: fakeExtensions('coder', {
            items: [
              {
                kind: 'plugin',
                name: '@deepseek-ai/dsh-plugin-review',
                version: '0.3.1',
                enabled: true,
                source: 'npm',
                notLoaded: null,
              },
              {
                kind: 'mcp',
                name: 'github',
                version: null,
                enabled: false,
                source: 'npx',
                notLoaded: null,
              },
              {
                kind: 'skill',
                name: 'release-notes',
                version: null,
                enabled: true,
                source: null,
                notLoaded: null,
              },
            ],
            notes: ['项目级配置不加载'],
            openCommand: 'qm runtime open coder --port 8123',
          }),
        }),
        fakeAgent('reviewer', {
          runtime: 'claude-code',
          effective: 'claude-code',
          model: 'anthropic/claude-opus-5',
          choice: { mode: 'manual', model: 'anthropic/claude-opus-5' },
          pick: 'anthropic/claude-opus-5',
          write: {
            state: 'failed',
            at: 1_700_000_000_000,
            message: 'E_RUNTIME_MODEL：模型不在档案里，已拒绝',
          },
          extensions: fakeExtensions('reviewer', {
            state: 'failed',
            fresh: false,
            runtime: 'claude-code',
            error: '列表命令超时，已放弃',
            job: {
              op: 'install',
              kind: 'plugin',
              name: 'obra/superpowers',
              state: 'failed',
              at: 1_700_000_000_000,
              message: 'E_RUNTIME_EXT_FAILED：克隆失败，仓库不存在',
            },
          }),
        }),
        fakeAgent('builder', {
          runtime: 'codex',
          effective: 'omp',
          model: 'openai/gpt-6',
          pick: 'openai/gpt-6',
          reason: { code: 'not-installed', message: '未安装，等待安装' },
          extensions: fakeExtensions('builder', {
            state: 'unread',
            fresh: false,
            runtime: null,
            openCommand: null,
            job: {
              op: 'install',
              kind: 'mcp',
              name: 'docs',
              state: 'running',
              at: 1_700_000_000_000,
              message: null,
            },
          }),
        }),
        fakeAgent('planner', {
          runtime: 'omp',
          effective: 'omp',
          followsNode: true,
          choosable: false,
          extensions: fakeExtensions('planner', {
            runtime: 'omp',
            items: [
              {
                kind: 'plugin',
                name: 'opencode-wakatime',
                version: '1.0.0',
                enabled: true,
                source: 'npm',
                notLoaded: '常驻运行时不加载',
              },
            ],
          }),
        }),
      ],
      models: [
        { id: 'deepseek/deepseek-v4', family: 'DeepSeek', group: false },
        { id: 'anthropic/claude-opus-5', family: 'Claude', group: false },
        { id: 'openai/gpt-6', family: 'GPT', group: false },
        { id: 'group/fast', family: null, group: true },
      ],
      error: null,
    },
    {
      node: 'osaka-1',
      state: 'old',
      gateway: 'inherit',
      tenant: null,
      defaultRuntime: null,
      runtimes: [],
      agents: [],
      models: [],
      error: null,
    },
    {
      node: 'nagoya-1',
      state: 'unreachable',
      gateway: 'profile',
      tenant: null,
      defaultRuntime: null,
      runtimes: [],
      agents: [],
      models: [],
      error: '节点控制链路未连接，稍后重试',
    },
  ]

  #note(what: string, caller: MagpieCaller): void {
    this.calls.push(`${what} ${caller.subject}`)
  }

  async snapshot(): Promise<ConsoleResult<MagpieAgentsSnapshot>> {
    return ok({
      autoJoin: this.autoJoin,
      connected: true,
      catalog: [
        {
          id: 'dsh',
          label: 'DeepSeek Harness',
          family: 'DeepSeek',
          builtin: false,
          default: true,
        },
        {
          id: 'omp',
          label: 'qianmopi',
          family: null,
          builtin: true,
          default: false,
        },
        {
          id: 'claude-code',
          label: 'Claude Code',
          family: 'Claude',
          builtin: false,
          default: false,
        },
        {
          id: 'codex',
          label: 'Codex',
          family: 'GPT',
          builtin: false,
          default: false,
        },
      ],
      nodes: this.nodes,
    })
  }

  async configure(
    change: MagpieAgentChange,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieAgentView>> {
    this.#note(
      `configure ${change.node}/${change.agent} ${change.runtime ?? '-'} ${change.model ?? '-'}`,
      caller,
    )
    const agent = this.nodes
      .find(one => one.node === change.node)
      ?.agents.find(one => one.agent === change.agent)
    if (agent === undefined) return failed('not_found', '节点上没有这个智能体')
    return ok({
      ...agent,
      ...(change.runtime === undefined ? {} : { runtime: change.runtime }),
      ...(change.model === undefined
        ? {}
        : {
            choice:
              change.model === 'auto'
                ? { mode: 'auto' as const }
                : { mode: 'manual' as const, model: change.model },
          }),
    })
  }

  async install(
    input: { readonly node: string; readonly runtime: string },
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieRuntimeJobView>> {
    this.#note(`install ${input.node}/${input.runtime}`, caller)
    return ok({ ...input, state: 'running' })
  }

  async remove(
    input: { readonly node: string; readonly runtime: string },
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieRuntimeJobView>> {
    this.#note(`remove ${input.node}/${input.runtime}`, caller)
    if (input.runtime === 'claude-code')
      return failed('refused', '节点 · reviewer 配置在它上面')
    return ok({ ...input, state: 'done' })
  }

  async setAutoJoin(
    on: boolean,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<{ readonly autoJoin: boolean }>> {
    this.#note(`autojoin ${on}`, caller)
    this.autoJoin = on
    return ok({ autoJoin: on })
  }

  async join(
    node: string,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieKeyView>> {
    this.#note(`join ${node}`, caller)
    if (node === 'tokyo-1') return failed('invalid', '这台节点已经有网关密钥')
    return ok(fakeJoinKey(node))
  }

  #agent(node: string, agent: string): MagpieAgentView | undefined {
    return this.nodes
      .find(one => one.node === node)
      ?.agents.find(one => one.agent === agent)
  }

  async extensions(
    node: string,
    agent: string,
  ): Promise<ConsoleResult<MagpieExtensionsView>> {
    const found = this.#agent(node, agent)
    if (found === undefined) return failed('not_found', '节点上没有这个智能体')
    if (found.extensions === null)
      return failed('unsupported', '节点版本过旧 · 不支持原生扩展')
    return ok(found.extensions)
  }

  async installExtension(
    input: MagpieExtensionInstall,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieExtensionJobView>> {
    const { node, agent, ...asked } = input
    const request = extensionInstallRequest(asked)
    if (!request.ok) return request
    const name = request.value.name ?? request.value.source
    this.#note(`ext-install ${node}/${agent} ${input.kind}:${name}`, caller)
    if (agent === 'reviewer')
      return failed('refused', '该智能体的官方前端正开着')
    return ok({
      node,
      agent,
      op: 'install',
      kind: input.kind,
      name,
      state: 'running',
    })
  }

  async removeExtension(
    input: MagpieExtensionRemove,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieExtensionJobView>> {
    this.#note(
      `ext-remove ${input.node}/${input.agent} ${input.kind}:${input.name}`,
      caller,
    )
    return ok({ ...input, op: 'remove', state: 'done' })
  }
}

/** The key a node gets when it joins magpie from the page. */
function fakeJoinKey(node: string): MagpieKeyView {
  return {
    binding: { kind: 'node', id: node },
    keyId: 'k-0002',
    keyName: `qm-node-${node}-0002`,
    profileId: `magpie-node-${node}`,
    lane: 'anthropic',
    mainModel: 'deepseek/deepseek-v4',
    fastModel: null,
    modelsMode: 'all',
    models: ['deepseek/*'],
    enabled: true,
    masked: '…c3d4',
    limits: [],
    createdAt: 1,
    present: true,
  }
}

export class FakeMagpie implements MagpiePort {
  readonly calls: string[] = []
  agents: FakeMagpieAgents | undefined = new FakeMagpieAgents()
  connection: MagpieConnectionView = {
    configured: true,
    gatewayUrl: 'https://gw.tokyo.example:8443',
    managementUrl: 'http://127.0.0.1:3430',
    keySet: true,
    connectedAt: 1,
    check: {
      at: 1_700_000_000_000,
      ok: true,
      version: '0.1.1268',
      gateway: 'keyed',
      code: null,
    },
  }
  problem: MagpieSnapshot['problem'] = null
  readonly providers: MagpieProviderView[] = [
    {
      id: 'openai',
      name: 'OpenAI',
      preset: 'openai',
      host: 'api.openai.com',
      enabled: true,
      ready: true,
      models: 2,
      access: 'key',
      plan: null,
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      preset: 'deepseek',
      host: 'api.deepseek.com',
      enabled: false,
      ready: false,
      models: 1,
      access: 'key',
      plan: null,
    },
    {
      id: 'codex',
      name: 'Codex 订阅',
      preset: 'codex',
      host: 'chatgpt.com',
      enabled: true,
      ready: true,
      models: 3,
      access: 'account',
      plan: 'pro',
    },
  ]
  readonly groups: MagpieGroupView[] = [
    {
      id: 'fast',
      name: '快速',
      members: ['openai/gpt-6-mini', 'deepseek/deepseek-v4'],
      matched: [],
      match: [],
      routing: 'order',
      affinity: 'auto',
      ready: true,
      eligible: true,
    },
    {
      id: 'mixed',
      name: '混合',
      members: ['openai/gpt-6', 'codex/gpt-6-codex'],
      matched: [],
      match: [],
      routing: 'smart',
      affinity: 'session',
      ready: true,
      eligible: false,
    },
  ]
  readonly keys: MagpieKeyView[] = [
    {
      binding: { kind: 'node', id: 'tokyo-1' },
      keyId: 'k-0001',
      keyName: 'qm-node-tokyo-1-0001',
      profileId: 'magpie-node-tokyo-1',
      lane: 'anthropic',
      mainModel: 'openai/gpt-6',
      fastModel: 'group/fast',
      modelsMode: 'all',
      models: ['openai/*', 'deepseek/*', 'group/fast'],
      enabled: true,
      masked: '…a1b2',
      limits: [
        {
          period: 'day',
          days: null,
          hours: null,
          tokens: 1_000_000,
          cost: null,
          cacheReads: false,
          tokensUsed: 1_200_000,
          costUsed: 0.4,
          spent: true,
          reset: '2026-10-17T00:00:00Z',
        },
      ],
      createdAt: 1,
      present: true,
    },
  ]

  #find(binding: MagpieBinding): MagpieKeyView | undefined {
    return this.keys.find(
      key => key.binding.kind === binding.kind && key.binding.id === binding.id,
    )
  }

  #note(what: string, caller: MagpieCaller): void {
    this.calls.push(`${what} ${caller.subject}`)
  }

  async snapshot(): Promise<ConsoleResult<MagpieSnapshot>> {
    return ok({
      connection: this.connection,
      problem: this.problem,
      providers: this.providers,
      presets: [
        { id: 'anthropic', name: 'Anthropic', kind: 'vendor', noKey: false },
        { id: 'openai', name: 'OpenAI', kind: 'vendor', noKey: false },
        { id: 'ollama', name: 'Ollama', kind: 'local', noKey: true },
      ],
      groups: this.groups,
      keys: this.keys,
      models: ['openai/gpt-6', 'openai/gpt-6-mini', 'group/fast'],
      nodes: ['tokyo-1', 'osaka-1'],
      tenants: ['acme'],
    })
  }

  async usage(
    period: MagpieUsagePeriod,
  ): Promise<ConsoleResult<MagpieUsageView>> {
    const row = {
      calls: 12,
      errors: 1,
      input: 48_000,
      output: 9_500,
      cacheRead: 120_000,
      cacheWrite: 0,
      cost: 0.42,
      unpriced: 0,
    }
    return ok({
      period,
      since: '2026-10-09T00:00:00Z',
      totals: row,
      models: [{ ...row, id: 'openai/gpt-6', name: 'gpt-6' }],
      keys: [
        {
          ...row,
          keyId: 'k-0001',
          name: 'qm-node-tokyo-1-0001',
          binding: { kind: 'node', id: 'tokyo-1' },
        },
      ],
    })
  }

  async connect(
    draft: MagpieConnectDraft,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieConnectionView>> {
    this.#note(`connect ${draft.gatewayUrl}`, caller)
    if (!draft.gatewayUrl.startsWith('https://'))
      return failed('invalid', '网关地址要用 https')
    this.connection = {
      ...this.connection,
      configured: true,
      gatewayUrl: draft.gatewayUrl,
      managementUrl: draft.managementUrl,
      keySet: this.connection.keySet || draft.managementKey !== undefined,
    }
    return ok(this.connection)
  }

  async check(
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieConnectionView>> {
    this.#note('check', caller)
    return ok(this.connection)
  }

  async saveProvider(
    draft: MagpieProviderDraft,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieProviderView>> {
    this.#note(`provider.save ${draft.preset}`, caller)
    if (draft.preset === 'codex')
      return failed('rejected', '订阅账号的上游阡陌不用')
    const base = draft.preset || (draft.name ?? 'custom')
    const view: MagpieProviderView = {
      id: `${base}-${this.providers.length + 1}`,
      name: draft.name ?? draft.preset,
      preset: draft.preset,
      host:
        draft.preset === ''
          ? new URL(draft.chat ?? draft.responses ?? draft.anthropic ?? '').host
          : `${draft.preset}.example`,
      enabled: true,
      ready: true,
      models: 1,
      access: 'key',
      plan: null,
    }
    this.providers.push(view)
    return ok(view)
  }

  async setProviderEnabled(
    id: string,
    on: boolean,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieProviderView>> {
    this.#note(`provider.toggle ${id} ${on}`, caller)
    const index = this.providers.findIndex(one => one.id === id)
    if (index < 0) return failed('not_found', '没有这个上游')
    const next = { ...this.providers[index]!, enabled: on }
    this.providers.splice(index, 1, next)
    return ok(next)
  }

  async testProvider(
    id: string,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<readonly MagpieTestView[]>> {
    this.#note(`provider.test ${id}`, caller)
    if (!this.providers.some(one => one.id === id))
      return failed('not_found', '没有这个上游')
    return ok([
      { protocol: 'chat', ok: true, status: 200, ms: 412, model: 'gpt-6' },
    ])
  }

  async removeProvider(
    id: string,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<void>> {
    this.#note(`provider.remove ${id}`, caller)
    const index = this.providers.findIndex(one => one.id === id)
    if (index < 0) return failed('not_found', '没有这个上游')
    this.providers.splice(index, 1)
    return ok(undefined)
  }

  async saveGroup(
    draft: MagpieGroupDraft,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieGroupView>> {
    this.#note(`group.save ${draft.id}`, caller)
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(draft.id))
      return failed('invalid', '路由组 id 只能用小写字母 · 数字 · 点与连字符')
    const found = this.groups.find(one => one.id === (draft.from ?? draft.id))
    const view: MagpieGroupView = {
      ...(found ?? this.groups[0]!),
      id: draft.id,
      name: draft.name ?? found?.name ?? draft.id,
      members: draft.members ?? found?.members ?? [],
      routing: draft.routing ?? found?.routing ?? 'smart',
      affinity: draft.affinity ?? found?.affinity ?? 'auto',
    }
    if (found) this.groups.splice(this.groups.indexOf(found), 1, view)
    else this.groups.push(view)
    return ok(view)
  }

  async removeGroup(
    id: string,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<void>> {
    this.#note(`group.remove ${id}`, caller)
    const index = this.groups.findIndex(one => one.id === id)
    if (index < 0) return failed('not_found', '没有这个路由组')
    this.groups.splice(index, 1)
    return ok(undefined)
  }

  async issueKey(
    draft: MagpieKeyDraft,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieKeyView>> {
    this.#note(`key.issue ${draft.binding.kind}:${draft.binding.id}`, caller)
    if (this.#find(draft.binding) !== undefined)
      return failed('invalid', '这个绑定已有网关密钥')
    if (draft.models?.some(model => model.startsWith('codex/')))
      return failed('rejected', '白名单里有订阅账号的上游')
    const view: MagpieKeyView = {
      ...this.keys[0]!,
      binding: draft.binding,
      keyId: `k-${String(this.keys.length + 1).padStart(4, '0')}`,
      keyName: `qm-${draft.binding.kind}-${draft.binding.id}-x`,
      profileId: `magpie-${draft.binding.kind}-${draft.binding.id}`,
      mainModel: draft.mainModel,
      fastModel: draft.fastModel ?? null,
      lane: draft.lane ?? 'anthropic',
      modelsMode: draft.models === undefined ? 'all' : 'list',
      models: draft.models ?? ['openai/*', 'deepseek/*', 'group/fast'],
      limits: [],
    }
    this.keys.push(view)
    return ok(view)
  }

  async updateKey(
    binding: MagpieBinding,
    change: MagpieKeyChange,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieKeyView>> {
    this.#note(`key.update ${binding.kind}:${binding.id}`, caller)
    const found = this.#find(binding)
    if (found === undefined) return failed('not_found', '没有这把网关密钥')
    const next: MagpieKeyView = {
      ...found,
      ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
      ...(change.mainModel === undefined
        ? {}
        : { mainModel: change.mainModel }),
      ...(change.fastModel === undefined
        ? {}
        : { fastModel: change.fastModel }),
      ...(change.models === undefined
        ? {}
        : change.models === null
          ? { modelsMode: 'all' as const }
          : { modelsMode: 'list' as const, models: change.models }),
    }
    this.keys.splice(this.keys.indexOf(found), 1, next)
    return ok(next)
  }

  async rotateKey(
    binding: MagpieBinding,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieKeyView>> {
    this.#note(`key.rotate ${binding.kind}:${binding.id}`, caller)
    const found = this.#find(binding)
    if (found === undefined) return failed('not_found', '没有这把网关密钥')
    return ok({ ...found, masked: '…c3d4' })
  }

  async removeKey(
    binding: MagpieBinding,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<{ readonly profileKept: boolean }>> {
    this.#note(`key.remove ${binding.kind}:${binding.id}`, caller)
    const found = this.#find(binding)
    if (found === undefined) return failed('not_found', '没有这把网关密钥')
    this.keys.splice(this.keys.indexOf(found), 1)
    return ok({ profileKept: false })
  }
}
