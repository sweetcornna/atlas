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
  type ConnectorDraft,
  type ConnectorPresetView,
  type ConnectorsPort,
  type ConnectorsSnapshot,
  type ConnectorView,
  type DesktopActionView,
  type DesktopConfirm,
  type DesktopNodeView,
  type DesktopPort,
  type HandoffDevicesPort,
  type HandoffDeviceView,
  type HandoffPairingCode,
  type DirectionActor,
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
      user: '',
      imapHost: 'imap.qq.com',
      imapPort: 993,
      smtpHost: 'smtp.qq.com',
      smtpPort: 465,
    },
    hint: '在 QQ 邮箱设置里开启 IMAP/SMTP 并生成授权码 · 这里填授权码',
  },
  {
    id: 'gmail',
    kind: 'mail',
    name: 'Gmail',
    defaults: {
      user: '',
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
    },
    hint: '开启两步验证后生成应用专用密码 · 这里填应用专用密码',
  },
  {
    id: 'icloud-calendar',
    kind: 'calendar',
    name: 'iCloud 日历',
    defaults: { user: '', caldavUrl: 'https://caldav.icloud.com/' },
    hint: '在 Apple 账户里生成 App 专用密码',
  },
  {
    id: 'ics',
    kind: 'calendar',
    name: 'ICS 订阅',
    defaults: {},
    hint: '只读 · 订阅地址里通常带令牌 · 按秘密保存',
  },
]

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
        summary: { user: 'ch***@qq.com', imapHost: 'imap.qq.com' },
        settings: {
          user: 'chen@qq.com',
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
        lastProbe: { at: at - 3_600_000, ok: true, detail: '登录成功' },
        createdAt: at - 86_400_000 * 2,
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
      typeof draft.settings.user === 'string' ? draft.settings.user : ''
    const view: ConnectorView = {
      id: old?.id ?? `con-${this.#seq}`,
      name: draft.name,
      kind: draft.kind,
      preset: draft.preset,
      summary: {
        ...(user === ''
          ? {}
          : {
              user: `${user.slice(0, 2)}***${user.includes('@') ? user.slice(user.indexOf('@')) : ''}`,
            }),
        ...(typeof draft.settings.imapHost === 'string'
          ? { imapHost: draft.settings.imapHost }
          : {}),
      },
      settings: draft.settings,
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
    const view = {
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
export class FakeDesktop implements DesktopPort {
  readonly calls: string[] = []
  units: DesktopNodeView[]
  failList = false

  constructor(private readonly now: () => number) {
    const at = now()
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
    ]
  }

  async list() {
    this.calls.push('list')
    if (this.failList)
      return failed<readonly DesktopNodeView[]>('unreachable', 'desktop down')
    return ok<readonly DesktopNodeView[]>(this.units)
  }

  async set(
    ref: AgentRef,
    change: {
      readonly browser?: boolean
      readonly computer?: boolean
      readonly confirm?: DesktopConfirm
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
      computer:
        change.computer === undefined
          ? found.computer
          : {
              ...found.computer,
              enabled: change.computer,
              state: change.computer ? 'running' : 'off',
              display: change.computer ? ':13' : null,
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
}
