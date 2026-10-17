// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 2026-10 新方向（`docs/dev/directions-2026-10.md`）的控制台端口契约。
 *
 * 和 `deps.ts` 里的老端口同一套规矩：控制台包只定义形状，宿主
 * （`packages/node/src/commands/console*.ts`）实现；端口缺席时页面写「未接入」、
 * API 回 501。单独放一个文件，是为了让五个方向的后端各改各的实现文件，
 * 不在 `deps.ts` 上互相冲突。
 *
 * **谁在操作**一律用 {@link DirectionActor} 传进来：端口自己记审计和动作账本需要它，
 * 页面路由不替端口记。
 *
 * 除 P19 配对码与设备令牌的单次签发响应外，方法不返回密钥、令牌或带凭据的地址。
 */

import type { ConsoleResult } from './contracts.js'

/** 发起这次操作的控制台主体。 */
export interface DirectionActor {
  /** 个人账号 `u:…`；旧式令牌为 `legacy:admin` / `legacy:view`。 */
  readonly subject: string
  /** 个人账号的角色；旧式令牌为 null（管理令牌按 ops 对待由路由决定）。 */
  readonly role: 'viewer' | 'member' | 'ops' | null
  /** 本次请求的 id，端口写进审计与账本。 */
  readonly requestId: string
}

/** 一个智能体，`qianmo://<node>/<agent>` 拆开后的两段。 */
export interface AgentRef {
  readonly node: string
  readonly agent: string
}

// ---------------------------------------------------------------------------
// P19 接力插件化：设备
// ---------------------------------------------------------------------------

/** 一台配对过的设备。令牌本身永不出现。 */
export interface HandoffDeviceView {
  /** `d-` 加 12 位小写 base32。 */
  readonly deviceId: string
  readonly name: string
  /** `darwin-arm64` 这一类；本机没报时为 null。 */
  readonly platform: string | null
  /** 签发配对码的主体；设备以它的身份行事。 */
  readonly owner: string
  readonly createdAt: number
  readonly lastSeenAt: number | null
  readonly revokedAt: number | null
  /** 这台设备登记过的任务数（含已结束的）。 */
  readonly tasks: number
}

/** 刚签发的配对码。`code` 只在这一次返回里出现。 */
export interface HandoffPairingCode {
  /** `XXXX-XXXX-XXXX`，大写 base32。 */
  readonly code: string
  readonly expiresAt: number
  /** 给本机照抄的一行命令（含控制台地址和配对码）。 */
  readonly command: string
}

export interface HandoffDeviceIdentity {
  readonly deviceId: string
  readonly owner: string
}

export interface HandoffPairingResult extends HandoffDeviceIdentity {
  readonly name: string
  readonly token: string
  readonly console: string
}

export interface HandoffDevicesPort {
  authenticate?(token: string): HandoffDeviceIdentity | null
  pair?(
    input: {
      readonly code: string
      readonly name: string
      readonly platform: string | null
    },
    remoteAddr: string,
  ): Promise<
    ConsoleResult<HandoffPairingResult> & { readonly retryAfter?: number }
  >

  listDevices(): Promise<ConsoleResult<readonly HandoffDeviceView[]>>
  issuePairing(
    actor: DirectionActor,
    consoleUrl?: string,
  ): Promise<ConsoleResult<HandoffPairingCode>>
  revokeDevice(
    deviceId: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<HandoffDeviceView>>
}

// ---------------------------------------------------------------------------
// P20 节点间文件互通
// ---------------------------------------------------------------------------

export type FileRequestState =
  | 'pending'
  | 'granted'
  | 'denied'
  | 'expired'
  | 'revoked'

/** 授权的范围：一个文件，或一个目录前缀（含其下全部文件）。 */
export interface FileScope {
  readonly kind: 'file' | 'dir'
  /** 来源智能体工作区内的相对路径，`/` 分隔，不以 `/` 开头。 */
  readonly path: string
}

export interface FileGrantView {
  readonly grantId: string
  /** 由申请批准而来时是申请号；用户直接发起的传输为 null。 */
  readonly requestId: string | null
  readonly source: AgentRef
  readonly target: AgentRef
  readonly scope: FileScope
  readonly grantedBy: string
  readonly grantedAt: number
  readonly expiresAt: number
  readonly revokedAt: number | null
}

export interface FileRequestView {
  readonly requestId: string
  /** 文件在哪。 */
  readonly source: AgentRef
  /** 谁要。 */
  readonly target: AgentRef
  readonly path: string
  readonly reason: string
  /** `agent`（智能体经宿主工具申请）或发起页面操作的主体。 */
  readonly requestedBy: string
  readonly at: number
  readonly state: FileRequestState
  /** 批准后才有。 */
  readonly grantId: string | null
  /** 拒绝、过期时的说明。 */
  readonly note: string | null
}

export type FileTransferState =
  | 'queued'
  | 'reading'
  | 'verifying'
  | 'delivering'
  | 'done'
  | 'failed'

export interface FileTransferView {
  readonly transferId: string
  readonly grantId: string
  /** 汇集时同组的传输共用一个组号。 */
  readonly groupId: string | null
  readonly source: AgentRef & { readonly path: string }
  /** `path` 是目标工作区里的落点（`inbox/<来源节点>/…`），送达前为 null。 */
  readonly target: AgentRef & { readonly path: string | null }
  readonly files: number
  readonly bytes: number
  /** 送达完成后才知道已交付字节数；没有分块进度。 */
  readonly doneBytes: number
  /** 清单摘要（按路径 UTF-16 码元序排序的 `[路径,字节数,sha256]` 紧凑 JSON 数组的 UTF-8 SHA-256）；读到清单前为 null。 */
  readonly manifestSha256: string | null
  readonly exchange?: {
    readonly ref: string
    readonly commit: string | null
    readonly cleaned: boolean
  }
  /** 目标逐文件核对清单，并核对清单摘要与中枢账本一致；失败为 false，未核对为 null。 */
  readonly verified: boolean | null
  readonly state: FileTransferState
  readonly reason: string | null
  readonly startedAt: number
  readonly finishedAt: number | null
}

export interface FileGroupView {
  readonly groupId: string
  readonly target: AgentRef
  readonly transfers: readonly string[]
  readonly createdBy: string
  readonly createdAt: number
}

export interface FilesSnapshot {
  readonly exchange?: {
    readonly repo: string
    readonly private: boolean | null
  }
  readonly requests: readonly FileRequestView[]
  readonly grants: readonly FileGrantView[]
  readonly transfers: readonly FileTransferView[]
  readonly groups: readonly FileGroupView[]
  /** 能参与互通的智能体（接了控制链路的），给页面的下拉框用。 */
  readonly agents: readonly (AgentRef & { readonly reachable: boolean })[]
  readonly limits: {
    readonly maxFileBytes: number
    readonly maxTransferBytes: number
    readonly maxFiles: number
    readonly maxTtlMs: number
  }
}

/** 目录里的一项，给页面的路径选择器用。 */
export interface FileEntryView {
  readonly name: string
  readonly kind: 'file' | 'dir'
  readonly size: number | null
  readonly mtime: number | null
}

export interface FilesPort {
  snapshot(): Promise<ConsoleResult<FilesSnapshot>>
  /** 批准时 `scope` 缺省为申请的那个路径（文件）；`ttlMs` 缺省 1 小时，超过上限 `rejected`。 */
  decide(
    requestId: string,
    decision: {
      readonly approve: boolean
      readonly scope?: FileScope
      readonly ttlMs?: number
      readonly note?: string
    },
    actor: DirectionActor,
  ): Promise<ConsoleResult<FileRequestView>>
  revokeGrant(
    grantId: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<FileGrantView>>
  /** 用户直接发起：一个来源是一次传输，多个来源是一次汇集。 */
  transfer(
    input: {
      readonly sources: readonly (AgentRef & { readonly path: string })[]
      readonly target: AgentRef
    },
    actor: DirectionActor,
  ): Promise<ConsoleResult<FileGroupView>>
  retry(
    transferId: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<FileTransferView>>
  /** 列出来源工作区里的一个目录（经控制链路）。 */
  browse(
    ref: AgentRef,
    path: string,
  ): Promise<ConsoleResult<readonly FileEntryView[]>>
}

// ---------------------------------------------------------------------------
// P21 云端电脑
// ---------------------------------------------------------------------------

/** `sensitive`（默认）：仅截图、读页面、查元素、列 tab 自动放行；其余（含滚动）逐次确认。`always`：观察也逐次确认。只认单次批准。 */
export type DesktopConfirm = 'sensitive' | 'always'

export type DesktopUnitState = 'off' | 'starting' | 'running' | 'failed'

export interface DesktopNodeView extends AgentRef {
  /** 控制链路是否连着；断开时其余字段是最后一次知道的值。 */
  readonly reachable: boolean
  readonly platform: 'linux' | 'darwin' | 'other' | null
  readonly browser: {
    readonly enabled: boolean
    readonly state: DesktopUnitState
    readonly profileBytes: number | null
    readonly startedAt: number | null
    readonly reason: string | null
  }
  readonly computer: {
    readonly enabled: boolean
    /** macOS 节点与没有 Xvfb 的 Linux 节点为 false，页面不给开。 */
    readonly supported: boolean
    readonly state: DesktopUnitState
    /** `:12` 这样的显示号。 */
    readonly display: string | null
    readonly reason: string | null
  }
  readonly confirm: DesktopConfirm
  readonly lastActionAt: number | null
  /** 最近 24 小时的操作次数与其中经过用户确认的次数。 */
  readonly actions24h: number
  readonly confirmed24h: number
}

export interface DesktopActionView {
  readonly at: number
  readonly node: string
  readonly agent: string
  readonly unit: 'browser' | 'computer'
  /** `navigate` / `click` / `type` / `screenshot` …，宿主归类后的名字。 */
  readonly op: string
  /** 目标网址的主机名；电脑操作为 null。 */
  readonly host: string | null
  readonly outcome:
    | 'allowed'
    | 'confirmed'
    | 'denied'
    | 'failed'
    | 'intent'
    | 'unknown'
  readonly actionId?: string
  readonly taskId?: string
  readonly requestId?: string
  readonly invocationId?: string
  readonly resourceId?: string
  readonly resourceEpoch?: number
  readonly digest?: string
  readonly confirmed?: boolean
}

/** 端口在实际下发前重验租户权限；此回调不进入控制消息。 */
export interface DesktopActor extends DirectionActor {
  readonly beforeDispatch?: () => void
}

export interface DesktopPort {
  list(): Promise<ConsoleResult<readonly DesktopNodeView[]>>
  set(
    ref: AgentRef,
    change: {
      readonly browser?: boolean
      readonly computer?: boolean
      readonly confirm?: DesktopConfirm
    },
    actor: DesktopActor,
  ): Promise<ConsoleResult<DesktopNodeView>>
  recycle(
    ref: AgentRef,
    actor: DesktopActor,
  ): Promise<ConsoleResult<DesktopNodeView>>
  actions(
    ref: AgentRef | null,
    limit: number,
  ): Promise<ConsoleResult<readonly DesktopActionView[]>>
}

// ---------------------------------------------------------------------------
// P22 按任务匹配模型
// ---------------------------------------------------------------------------

export const MODEL_DIRECTIONS = [
  'code',
  'chat',
  'plan',
  'fast',
  'vision',
  'image',
  'speech',
  'video',
] as const

export type ModelDirection = (typeof MODEL_DIRECTIONS)[number]

/** 一个方向选了哪个服务里的哪个模型。两个都为 null = 跟随主模型（生图、语音、视频为「不开」）。 */
export interface ModelRouteView {
  readonly direction: ModelDirection
  readonly profileId: string | null
  readonly modelId: string | null
}

export interface ModelRoutingView {
  /** `null` 是全局默认；否则是节点名（覆盖默认）。 */
  readonly node: string | null
  /** 任务没带方向时，按文字自动归类。 */
  readonly auto: boolean
  readonly routes: readonly ModelRouteView[]
  readonly revision: number
  readonly updatedAt: number | null
  readonly updatedBy: string | null
}

/** 节点回报的一次归类。 */
export interface RouteDecisionView {
  readonly node: string
  readonly agent: string
  readonly at: number
  readonly direction: ModelDirection
  /** `hint`：派发请求里带了方向；`auto`：按文字归类；`default`：没开自动、走主模型。 */
  readonly source: 'hint' | 'auto' | 'default'
  /** `qm-…/<模型>`，即节点实际用的模型引用。 */
  readonly model: string
}

/** 一个服务里能选的模型，给方向下拉框用。 */
export interface RoutableModelView {
  readonly profileId: string
  readonly profileName: string
  readonly modelId: string
  /** `chat` / `image` / `speech` / `video`：决定它能出现在哪些方向下。 */
  readonly kind: 'chat' | 'image' | 'speech' | 'video'
  readonly evaluated: boolean
}

export interface ModelRoutingSnapshot {
  readonly defaults: ModelRoutingView
  readonly nodes: readonly ModelRoutingView[]
  readonly models: readonly RoutableModelView[]
  readonly recent: readonly RouteDecisionView[]
}

export interface ModelRoutingPort {
  snapshot(): Promise<ConsoleResult<ModelRoutingSnapshot>>
  /** `node` 为 null 改默认；`routes` 只需给要改的方向。`revision` 不符时 `rejected`（有人先改了）。 */
  save(
    input: {
      readonly node: string | null
      readonly auto: boolean
      readonly routes: readonly ModelRouteView[]
      readonly revision: number
    },
    actor: DirectionActor,
  ): Promise<ConsoleResult<ModelRoutingView>>
  /** 删掉某个节点的覆盖，回到默认。 */
  clearNode(
    node: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ModelRoutingView>>
}

// ---------------------------------------------------------------------------
// P23 长期记忆
// ---------------------------------------------------------------------------

export const MEMORY_KINDS = ['preference', 'plan', 'project', 'daily'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

export interface MemoryEntryView extends AgentRef {
  readonly id: string
  /**
   * 这条长期记忆属于谁（账号主体）。长期分区按「智能体 × 已验证账号」分开
   * （设计复核 D18）：A 的偏好不会在 B 的会话里被召回。对话分区为 null。
   */
  readonly owner: string | null
  /** `long`：长期分区；`conversation`：某次对话或某个作业的分区。 */
  readonly scope: 'long' | 'conversation'
  /** 对话分区的会话号；长期分区为 null。 */
  readonly contextId: string | null
  readonly kind: MemoryKind | null
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly tags: readonly string[]
  /** `user` / `agent` / `session` / `archive` / `import`，及其 id（账号或审批号）。 */
  readonly source: { readonly kind: string; readonly id: string }
  readonly createdAt: number
  readonly validAt: number | null
  readonly invalidAt: number | null
  readonly retired: {
    readonly kind: 'revoked' | 'archived'
    readonly reason: string
    readonly by: string
  } | null
  readonly supersedes: string | null
  readonly supersededBy: string | null
}

export interface MemoryQueryInput extends AgentRef {
  readonly scope?: 'long' | 'conversation' | 'all'
  readonly kind?: MemoryKind
  /** 在标题、摘要、正文里找的文字。 */
  readonly text?: string
  /** 带上已忘记、已过期、已被替换的。 */
  readonly includeRetired?: boolean
  /** Offset into the filtered list; nextOffset accounts for the wire byte ceiling. */
  readonly offset?: number
  readonly limit?: number
}

export interface MemoryDraft {
  readonly kind: MemoryKind
  readonly title: string
  readonly summary: string
  readonly body: string
}

export interface MemoryPort {
  agents(): Promise<
    ConsoleResult<readonly (AgentRef & { readonly reachable: boolean })[]>
  >
  /** 只列 `actor` 自己的长期记忆与他能看到的会话里的记忆。 */
  list(
    input: MemoryQueryInput,
    actor: DirectionActor,
  ): Promise<
    ConsoleResult<{
      readonly entries: readonly MemoryEntryView[]
      readonly total: number
      readonly nextOffset?: number | null
      /** 按类别的活条目数（长期分区）。 */
      readonly counts: Readonly<Record<MemoryKind, number>>
    }>
  >
  add(
    ref: AgentRef,
    draft: MemoryDraft,
    actor: DirectionActor,
  ): Promise<ConsoleResult<MemoryEntryView>>
  /** 新写一条并 supersede 旧的。 */
  edit(
    ref: AgentRef,
    id: string,
    draft: MemoryDraft,
    actor: DirectionActor,
  ): Promise<ConsoleResult<MemoryEntryView>>
  forget(
    ref: AgentRef,
    id: string,
    reason: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<MemoryEntryView>>
  invalidate(
    ref: AgentRef,
    id: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<MemoryEntryView>>
}

// ---------------------------------------------------------------------------
// P24 主动执行
// ---------------------------------------------------------------------------

export type ScheduleWhen =
  | { readonly kind: 'daily'; readonly time: string }
  /** `days` 1–7，周一到周日。 */
  | {
      readonly kind: 'weekly'
      readonly days: readonly number[]
      readonly time: string
    }
  | {
      readonly kind: 'interval'
      readonly everyMinutes: number
      /** 宿主存入任务创建时刻；旧值未带锚点时按 Unix epoch 计算。 */
      readonly anchorMs?: number
    }

export const SCHEDULE_TEMPLATES = [
  'briefing',
  'followup',
  'mail',
  'custom',
] as const
export type ScheduleTemplate = (typeof SCHEDULE_TEMPLATES)[number]

export type ScheduleRunOutcome =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'skipped'

export type ScheduleRunState = ScheduleRunOutcome | 'unknown'

export interface ScheduleRunView {
  /** Lifecycle state; absent on older records. Unknown retains running occupancy. */
  readonly state?: ScheduleRunState
  readonly runId: string
  /** Creator is retained after deletion so history keeps its account scope. */
  readonly createdBy?: string
  /** 这次发往的智能体；任务删除或改目标后，租户范围仍按它过滤。旧记录没有。 */
  readonly target?: string
  readonly scheduleId: string
  readonly plannedAt: number
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly outcome: ScheduleRunOutcome
  readonly taskId: string | null
  /** 对话页里对应的会话，可跳过去看全文。 */
  readonly sessionId: string | null
  /** 回复的前 2000 字。 */
  readonly excerpt: string | null
  readonly reason: string | null
  readonly pushed: readonly {
    readonly channelId: string
    readonly ok: boolean
    readonly error: string | null
  }[]
  /** `manual`：页面上点了「立即运行」。 */
  readonly trigger: 'schedule' | 'manual'
}

export interface ScheduleView {
  readonly id: string
  readonly title: string
  /** `qianmo://<node>/<agent>`。 */
  readonly target: string
  readonly template: ScheduleTemplate
  readonly prompt: string
  readonly when: ScheduleWhen
  /** IANA 时区名。 */
  readonly timezone: string
  readonly direction: ModelDirection | null
  readonly channels: readonly string[]
  /** 只在智能体自己调了通知工具时推送。 */
  readonly notifyOnlyAgent: boolean
  readonly enabled: boolean
  readonly timeoutMs: number
  readonly createdAt: number
  readonly createdBy: string
  readonly updatedAt: number
  readonly nextRunAt: number | null
  readonly lastRun: ScheduleRunView | null
}

export type NotifyChannelKind = 'webhook' | 'bark' | 'wecom' | 'feishu' | 'ntfy'

export interface NotifyChannelView {
  readonly id: string
  readonly name: string
  readonly kind: NotifyChannelKind
  /** 只有主机名：地址里常带密钥。 */
  readonly host: string
  /** 所属租户；未开租户或只给平台用的渠道为 null，旧记录没有。 */
  readonly tenant?: string | null
  readonly createdAt: number
  readonly lastUsedAt: number | null
  readonly lastError: string | null
}

export interface ScheduleTemplateView {
  readonly id: ScheduleTemplate
  readonly title: string
  readonly prompt: string
  /** 需要先接上的东西，例如「邮件连接」；为空就能直接用。 */
  readonly needs: string | null
}

export interface SchedulesSnapshot {
  readonly schedules: readonly ScheduleView[]
  /** 最近 50 次运行，新的在前。 */
  readonly runs: readonly ScheduleRunView[]
  readonly channels: readonly NotifyChannelView[]
  readonly templates: readonly ScheduleTemplateView[]
  /** 能选的目标（对话面白名单里的智能体）。 */
  readonly targets: readonly string[]
  /** 紧急停止文件存在时为 true：到点的任务一律记「跳过」。 */
  readonly estop: boolean
  /** 调度循环最近一次运行的时间；从未运行为 null。 */
  readonly tickAt: number | null
}

export interface ScheduleDraft {
  /** 有 id 是修改，没有是新建。 */
  readonly id?: string
  readonly title: string
  readonly target: string
  readonly template: ScheduleTemplate
  readonly prompt: string
  readonly when: ScheduleWhen
  readonly timezone: string
  readonly direction: ModelDirection | null
  readonly channels: readonly string[]
  readonly notifyOnlyAgent: boolean
  readonly enabled: boolean
  readonly timeoutMs: number
}

export interface NotifyChannelDraft {
  /** Platform ops may select a tenant; scoped routes set it themselves. */
  readonly tenant?: string
  readonly id?: string
  readonly name: string
  readonly kind: NotifyChannelKind
  /** 新建必填；修改时不给就保留原地址。 */
  readonly url?: string
}

export interface ScheduleReader {
  readonly subject: string
  readonly role?: DirectionActor['role']
}

export interface SchedulesPort {
  /** In-memory ownership preflight; never reads a port or admits an action. */
  visible(id: string, actor: DirectionActor): boolean
  /** In-memory tenant preflight: the schedule's target, undefined if unknown. */
  targetOf(id: string): string | undefined
  /** In-memory tenant preflight: null is platform-only, undefined unknown. */
  channelTenant(id: string): string | null | undefined
  snapshot(actor: ScheduleReader): Promise<ConsoleResult<SchedulesSnapshot>>
  save(
    draft: ScheduleDraft,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ScheduleView>>
  setEnabled(
    id: string,
    enabled: boolean,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ScheduleView>>
  remove(id: string, actor: DirectionActor): Promise<ConsoleResult<null>>
  runNow(
    id: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ScheduleRunView>>
  resolve(
    id: string,
    runId: string,
    outcome: 'ok' | 'failed',
    actor: DirectionActor,
  ): Promise<ConsoleResult<ScheduleRunView>>
  saveChannel(
    draft: NotifyChannelDraft,
    actor: DirectionActor,
  ): Promise<ConsoleResult<NotifyChannelView>>
  removeChannel(id: string, actor: DirectionActor): Promise<ConsoleResult<null>>
  /** 发一条测试通知。 */
  testChannel(
    id: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<NotifyChannelView>>
}

// ---------------------------------------------------------------------------
// P25 应用连接
// ---------------------------------------------------------------------------

export type ConnectorKind = 'mail' | 'calendar' | 'repo'

export interface ConnectorPresetView {
  readonly evaluated: false
  readonly id: string
  readonly kind: ConnectorKind
  readonly name: string
  /** 预填的服务器与端口（`imapHost`、`smtpPort`、`caldavUrl` …），用户可改。 */
  readonly defaults: Readonly<Record<string, string | number | boolean>>
  /** 一行说明，例如「需要在邮箱设置里开启 IMAP 并生成授权码」。 */
  readonly hint: string
}

export interface ConnectorView {
  /** Owner tenant, null only when tenancy is disabled. */
  readonly tenant: string | null
  readonly revision: number
  readonly id: string
  readonly name: string
  readonly kind: ConnectorKind
  readonly preset: string
  /** 只给主机名与账号的打码形式（`ab***@qq.com`）。 */
  readonly summary: Readonly<Record<string, string>>
  /**
   * 非秘密设置的原值（服务器、端口、账号、仓库坐标），给编辑表单预填；只在运维级读者
   * 面前出现，路由对其他人去掉这一项。秘密（口令、带令牌的订阅地址）永不在此。
   */
  readonly settings?: Readonly<Record<string, string | number | boolean>>
  /** ICS 订阅为 true：只能读。 */
  readonly readOnly: boolean
  readonly secretSet: boolean
  readonly secretSetAt: number | null
  /** 能用这个连接的智能体地址；repo 由中枢使用，必须为空。 */
  readonly agents: readonly string[]
  /** GitHub 仓库的非秘密坐标和探测事实；null 表示尚未取得该事实。 */
  readonly repo?: {
    readonly name: string
    readonly exchange: boolean
    readonly private: boolean | null
    readonly push: boolean | null
  }
  /** 没有用真实账号验证过：一律 false。 */
  readonly evaluated: boolean
  readonly lastProbe: {
    readonly at: number
    readonly ok: boolean
    readonly detail: string
    readonly private?: boolean | null
    readonly push?: boolean | null
  } | null
  readonly createdAt: number
  readonly createdBy: string
}

export interface ConnectorCallView {
  readonly at: number
  readonly connectorId: string
  readonly agent: string
  /** `mail.search` / `mail.read` / `mail.send` / `calendar.events` / `calendar.create`。 */
  readonly op: string
  readonly outcome: 'ok' | 'refused' | 'failed'
  readonly count: number | null
  readonly detail: string | null
}

export interface ConnectorDraft {
  /** Platform ops may select a tenant; scoped routes set it themselves. */
  readonly tenant?: string
  readonly id?: string
  readonly name: string
  readonly kind: ConnectorKind
  readonly preset: string
  /** 服务器、端口、账号、repo、exchange 等非秘密字段。 */
  readonly settings: Readonly<Record<string, string | number | boolean>>
  /** 口令、授权码或 GitHub fine-grained token；修改时不给就保留原值。 */
  readonly secret?: string
  readonly agents: readonly string[]
}

export interface ConnectorsSnapshot {
  readonly connectors: readonly ConnectorView[]
  readonly presets: readonly ConnectorPresetView[]
  readonly recent: readonly ConnectorCallView[]
  /** 能授权的智能体地址。 */
  readonly agents: readonly string[]
}

export interface ConnectorsPort {
  snapshot(): Promise<ConsoleResult<ConnectorsSnapshot>>
  save(
    draft: ConnectorDraft,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ConnectorView>>
  remove(id: string, actor: DirectionActor): Promise<ConsoleResult<null>>
  /** 用保存的凭据测连（repo 核对仓库可见性与写权限），结果记在 `lastProbe`。 */
  probe(
    id: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ConnectorView>>
}

// ---------------------------------------------------------------------------
// ChannelsPort —— 聊天渠道（P28，runtimes-channels.md §2）
// ---------------------------------------------------------------------------

export type ChannelPlatformId =
  | 'qq'
  | 'weixin'
  | 'telegram'
  | 'discord'
  | 'slack'

/** 一个平台要填什么。只列官方接口需要的字段。 */
export interface ChannelPlatformView {
  readonly id: ChannelPlatformId
  readonly name: string
  /** 非秘密字段（QQ 的 AppID）。 */
  readonly settings: readonly { readonly key: string; readonly label: string }[]
  /** 秘密字段；修改时留空就保留原值。 */
  readonly secrets: readonly { readonly key: string; readonly label: string }[]
  /** 凭据靠扫码取得（微信）。 */
  readonly qrLogin: boolean
  readonly hint: string
  /** 没有用真实账号跑过：一律 false。 */
  readonly evaluated: boolean
}

export interface ChannelView {
  readonly id: string
  readonly name: string
  readonly platform: ChannelPlatformId
  readonly enabled: boolean
  /** 主人私聊对话的智能体。 */
  readonly target: string
  /** 群聊与其他人私聊对话的智能体；null 不回应主人以外的人。 */
  readonly memberTarget: string | null
  /** 主人在该平台上的用户号。 */
  readonly ownerIds: readonly string[]
  readonly allowAll: boolean
  readonly allowUsers: readonly string[]
  readonly allowGroups: readonly string[]
  readonly groupTrigger: 'mention' | 'all'
  readonly replyWindowMs: number
  readonly prompt: string
  readonly settings: Readonly<Record<string, string>>
  readonly secretSet: boolean
  readonly health: {
    readonly state: 'stopped' | 'starting' | 'connected' | 'retrying' | 'failed'
    readonly since: number
    readonly detail?: string
  }
  readonly conversations: number
  readonly evaluated: boolean
  /** 对话以这个控制台账号的名义派发，记在它的会话与用量下。 */
  readonly owner: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ChannelDraft {
  readonly id?: string
  readonly name: string
  readonly platform: ChannelPlatformId
  readonly enabled?: boolean
  readonly target: string
  readonly memberTarget?: string | null
  readonly ownerIds?: readonly string[]
  readonly allowAll?: boolean
  readonly allowUsers?: readonly string[]
  readonly allowGroups?: readonly string[]
  readonly groupTrigger?: 'mention' | 'all'
  readonly replyWindowMs?: number
  readonly prompt?: string
  readonly settings?: Readonly<Record<string, string>>
  readonly secrets?: Readonly<Record<string, string>>
}

export interface ChannelsSnapshot {
  readonly channels: readonly ChannelView[]
  readonly platforms: readonly ChannelPlatformView[]
  /** 能绑定的智能体地址。 */
  readonly agents: readonly string[]
}

/** 微信扫码登录的一次进行中状态。`qr` 是二维码内容，页面画成图。 */
export interface ChannelLoginView {
  readonly loginId: string
  readonly state: 'wait' | 'scanned' | 'expired' | 'confirmed' | 'failed'
  readonly qr: string
  readonly channelId?: string
  readonly detail?: string
}

export interface ChannelsPort {
  snapshot(): Promise<ConsoleResult<ChannelsSnapshot>>
  save(
    draft: ChannelDraft,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ChannelView>>
  remove(id: string, actor: DirectionActor): Promise<ConsoleResult<null>>
  /** 开始微信扫码；确认后凭据写进 `draft` 描述的渠道（新建或更新）。 */
  login(
    draft: ChannelDraft,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ChannelLoginView>>
  loginStatus(
    loginId: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ChannelLoginView>>
  /** 这次登录当前的二维码内容（过期后会换新）。 */
  loginQr(
    loginId: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<string>>
}

// ---------------------------------------------------------------------------
// UpdatesPort —— 定时检查更新（P31，runtimes-channels.md §5）
// ---------------------------------------------------------------------------

export const UPDATE_SOURCES = [
  'qianmopi',
  'claude-code',
  'codex',
  'qianmo',
] as const
export type UpdateSourceId = (typeof UPDATE_SOURCES)[number]

/** `notify` 只通知；`auto` 触发上游同步工作流或在节点上装新版。 */
export type UpdateAction = 'notify' | 'auto'

export type UpdateTime = Extract<ScheduleWhen, { kind: 'daily' | 'weekly' }>

/** 一个节点上外部底层的版本。 */
export interface UpdateNodeVersion {
  readonly node: string
  readonly version: string | null
  /** 外部底层：阡陌装的那一份（false 是机器上原有的）；阡陌自身：能在线升级。 */
  readonly managed: boolean
  /** 启动参数指定了程序路径：不由阡陌更新。 */
  readonly pinned: boolean
}

export interface UpdateSourceView {
  readonly id: UpdateSourceId
  readonly name: string
  /** 中枢上的版本；外部底层看 `nodes`。 */
  readonly current: string | null
  readonly latest: string | null
  readonly nodes: readonly UpdateNodeVersion[]
  readonly action: UpdateAction
  /** 能不能设为自动处理。 */
  readonly autoAvailable: boolean
  readonly checkedAt: number | null
  readonly error: string | null
}

export interface UpdateRunView {
  readonly at: number
  readonly source: UpdateSourceId
  readonly current: string | null
  readonly latest: string | null
  /** `available`：有新版本，已按设定通知（或没有通知渠道）。 */
  readonly outcome:
    | 'current'
    | 'available'
    | 'dispatched'
    | 'installed'
    | 'failed'
  readonly detail: string | null
  readonly trigger: 'schedule' | 'manual'
}

/** 阡陌自身逐台升级或回滚的一次作业：节点逐台进行，中枢最后（P31 §5.2）。 */
export interface UpgradeJobView {
  readonly kind: 'upgrade' | 'rollback'
  /** 目标版本；回到本机备份而版本未知时为 null。 */
  readonly target: string | null
  readonly state: 'running' | 'done' | 'failed'
  readonly steps: readonly {
    /** 节点名；中枢是 `hub`。 */
    readonly node: string
    readonly state: 'pending' | 'upgrading' | 'done' | 'skipped' | 'failed'
    readonly detail: string | null
  }[]
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly trigger: 'schedule' | 'manual'
}

export interface UpdatesSnapshot {
  readonly times: readonly UpdateTime[]
  /** IANA 时区名。 */
  readonly timezone: string
  /** 有新版本时推送的通知渠道（P24）。 */
  readonly channels: readonly string[]
  /** 阡陌所在的 GitHub 仓库：查阡陌发行、触发 `sync-omp.yml`；null 不查。 */
  readonly repo: string | null
  readonly sources: readonly UpdateSourceView[]
  /** 最近 100 行，新的在前。 */
  readonly history: readonly UpdateRunView[]
  readonly nextAt: number | null
  readonly running: boolean
  readonly channelChoices: readonly {
    readonly id: string
    readonly name: string
  }[]
  /** 中枢自身：运行的版本、能否在线升级、本机备份里的版本。 */
  readonly hub: {
    readonly version: string
    readonly upgradable: boolean
    readonly backup: string | null
  }
  /** 能回到的更旧发行（最多三个，新的在前）。 */
  readonly rollbackVersions: readonly string[]
  /** 最近一次升级或回滚作业；进行中时页面跟着它刷新。 */
  readonly upgrade: UpgradeJobView | null
}

export interface UpdatesDraft {
  readonly times: readonly UpdateTime[]
  readonly timezone: string
  readonly actions: Readonly<Partial<Record<UpdateSourceId, UpdateAction>>>
  readonly channels: readonly string[]
  readonly repo: string | null
}

export interface UpdatesPort {
  snapshot(): Promise<ConsoleResult<UpdatesSnapshot>>
  save(
    draft: UpdatesDraft,
    actor: DirectionActor,
  ): Promise<ConsoleResult<UpdatesSnapshot>>
  /** 立即检查一次，在后台进行；返回时 `running` 为 true。 */
  run(actor: DirectionActor): Promise<ConsoleResult<UpdatesSnapshot>>
  /** 把节点与中枢逐台升到 `version`（缺省为最新发行），在后台进行。 */
  upgrade(
    input: { readonly version?: string },
    actor: DirectionActor,
  ): Promise<ConsoleResult<UpdatesSnapshot>>
  /** 不给版本：各台换回本机备份；给版本：装那个更旧的发行（须在 `rollbackVersions` 里）。 */
  rollback(
    input: { readonly version?: string },
    actor: DirectionActor,
  ): Promise<ConsoleResult<UpdatesSnapshot>>
}

// ---------------------------------------------------------------------------
// ExtensionsPort —— 连接器（MCP）、技能与插件（P32，runtimes-channels.md §9）
// ---------------------------------------------------------------------------

export const EXTENSION_KINDS = ['mcp', 'skill', 'plugin'] as const
export type ExtensionKind = (typeof EXTENSION_KINDS)[number]

/** 一个条目在一个节点上的落地结果。 */
export interface ExtensionNodeState {
  readonly node: string
  /** `pending`：还没送到，或节点还没答。 */
  readonly state: 'applied' | 'failed' | 'pending'
  readonly detail: string | null
  readonly at: number | null
}

/** GitHub 公开仓库里的一个目录，钉在一个提交上。 */
export interface ExtensionSourceView {
  readonly repo: string
  /** 填的分支、标签或提交。 */
  readonly ref: string
  readonly path: string
  readonly commit: string
}

export interface ExtensionView {
  readonly id: string
  readonly kind: ExtensionKind
  readonly name: string
  readonly description: string
  readonly enabled: boolean
  /** 智能体地址；空表示全部智能体。 */
  readonly agents: readonly string[]
  /** MCP：传输方式；其他条目为 null。 */
  readonly transport: 'stdio' | 'http' | 'sse' | null
  readonly command: string | null
  readonly args: readonly string[]
  readonly url: string | null
  /** 已设置的环境变量与请求头的名称；值封存在中枢，页面不回显。 */
  readonly envKeys: readonly string[]
  readonly headerKeys: readonly string[]
  /** MCP：`ask` 每次调用先问运维。 */
  readonly approval: 'allow' | 'ask'
  /** 直接写的技能正文；导入的为 null。 */
  readonly body: string | null
  readonly source: ExtensionSourceView | null
  readonly nodes: readonly ExtensionNodeState[]
  readonly updatedAt: number
  readonly updatedBy: string
}

export interface ExtensionsSnapshot {
  readonly extensions: readonly ExtensionView[]
  /** 可选的智能体地址。 */
  readonly agentChoices: readonly string[]
  /** 能下发的节点。 */
  readonly nodes: readonly string[]
}

/** 新建与编辑给全部字段；只给 `id` 与 `enabled` 是只切换启用，不重新解析来源。 */
export interface ExtensionDraft {
  readonly id?: string
  readonly kind?: ExtensionKind
  /** MCP 与直接写的技能必填；导入的技能取 `SKILL.md` 里的名称，插件缺省取目录名。 */
  readonly name?: string
  readonly description?: string
  readonly enabled?: boolean
  readonly agents?: readonly string[]
  readonly transport?: 'stdio' | 'http' | 'sse'
  readonly command?: string
  readonly args?: readonly string[]
  readonly url?: string
  /** 值为 null：沿用已存的值；没列出的名称删除。 */
  readonly env?: Readonly<Record<string, string | null>>
  readonly headers?: Readonly<Record<string, string | null>>
  readonly approval?: 'allow' | 'ask'
  readonly body?: string
  /** 技能或插件从 GitHub 公开仓库导入；每次保存都重新解析引用。 */
  readonly source?: {
    readonly repo: string
    readonly ref?: string
    readonly path?: string
  }
}

export interface ExtensionsPort {
  snapshot(): Promise<ConsoleResult<ExtensionsSnapshot>>
  /** 保存后在后台下发到各节点；`nodes` 先显示为 `pending`。 */
  save(
    draft: ExtensionDraft,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ExtensionView>>
  remove(id: string, actor: DirectionActor): Promise<ConsoleResult<void>>
}

// ---------------------------------------------------------------------------
// MagpiePort —— 平台模型网关 magpie（P33 / P34）
// ---------------------------------------------------------------------------

/**
 * magpie 作为平台网关：节点拿中枢签发的网关密钥直连它，中枢从不转发模型流量
 * （章程 N-5 v2.22、R-9），只调它的管理接口。一把网关密钥就是一份普通的模型
 * 档案 `magpie-<kind>-<id>`，经模型服务原样编译、下发、切换。
 *
 * 读方法不收调用者，按角色裁剪是路由的事：不能写的人看不到密钥尾号，地址只有
 * 主机部分。写方法收 {@link MagpieCaller}，端口自己再查一遍写权限；签发、轮换、
 * 收回会经 `ProviderPort` 写档案，那些写由模型服务自己记账（`provider.*`）。
 *
 * 从不返回网关密钥、上游密钥或管理密钥的值。
 */

export const MAGPIE_USAGE_PERIODS = ['today', '7d', '30d', 'all'] as const
export type MagpieUsagePeriod = (typeof MAGPIE_USAGE_PERIODS)[number]

export const MAGPIE_ROUTINGS = [
  'smart',
  'order',
  'rotate',
  'usage',
  'pace',
] as const
export type MagpieRoutingName = (typeof MAGPIE_ROUTINGS)[number]

export const MAGPIE_AFFINITIES = [
  'auto',
  'session',
  'turn',
  'off',
  'strict',
] as const
export type MagpieAffinityName = (typeof MAGPIE_AFFINITIES)[number]

export const MAGPIE_LIMIT_PERIODS = [
  'day',
  'week',
  'month',
  'days',
  'hours',
] as const
export type MagpieLimitWindow = (typeof MAGPIE_LIMIT_PERIODS)[number]

/** 一份 magpie 档案能用的线路：Anthropic 走 origin，两条 OpenAI 走 origin/v1。 */
export const MAGPIE_LANES = [
  'anthropic',
  'openai-responses',
  'openai-chat',
] as const
export type MagpieLane = (typeof MAGPIE_LANES)[number]

/** 一把网关密钥绑给谁：一个节点，或一个租户（P35）。 */
export interface MagpieBinding {
  readonly kind: 'node' | 'tenant'
  readonly id: string
}

/** 最近一次核对。 */
export interface MagpieCheckView {
  readonly at: number
  readonly ok: boolean
  /** 管理接口报的 magpie 版本。 */
  readonly version: string | null
  /**
   * 网关这一侧：`keyed` 要网关密钥才答（应有的样子）；`open` 不带密钥也答；
   * `closed` 没有共享到网络；`unreachable` 连不上。
   */
  readonly gateway: 'keyed' | 'open' | 'closed' | 'unreachable'
  /** 不成功时的失败码（`magpie_auth` 一类）。 */
  readonly code: string | null
}

export interface MagpieConnectionView {
  readonly configured: boolean
  /** 能写的人看到 origin；其他人只看到主机与端口。 */
  readonly gatewayUrl: string | null
  readonly managementUrl: string | null
  /** 管理密钥已封存在中枢。 */
  readonly keySet: boolean
  readonly connectedAt: number | null
  readonly check: MagpieCheckView | null
}

/** magpie 里的一个上游。 */
export interface MagpieProviderView {
  readonly id: string
  readonly name: string
  readonly preset: string
  readonly host: string
  readonly enabled: boolean
  readonly ready: boolean
  readonly models: number
  /** `key` API 密钥；`account` 订阅账号；`client` 借用厂商自家客户端身份。后两种阡陌从不使用（L-6）。 */
  readonly access: 'key' | 'account' | 'client'
  readonly plan: string | null
}

export interface MagpiePresetView {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly noKey: boolean
}

export interface MagpieGroupView {
  readonly id: string
  readonly name: string
  readonly members: readonly string[]
  readonly matched: readonly string[]
  readonly match: readonly string[]
  readonly routing: string
  readonly affinity: string
  readonly ready: boolean
  /** 成员全是 API 密钥上游：阡陌的密钥可以用它。 */
  readonly eligible: boolean
}

export interface MagpieLimitView {
  readonly period: MagpieLimitWindow
  readonly days: number | null
  readonly hours: number | null
  readonly tokens: number | null
  /** 美元，magpie 按它的价目估的，不是账单。 */
  readonly cost: number | null
  readonly cacheReads: boolean
  readonly tokensUsed: number | null
  readonly costUsed: number | null
  readonly spent: boolean
  readonly reset: string | null
}

export interface MagpieKeyView {
  readonly binding: MagpieBinding
  readonly keyId: string
  readonly keyName: string
  readonly profileId: string
  readonly lane: MagpieLane
  readonly mainModel: string
  readonly fastModel: string | null
  /** `all`：合格的全部（随 magpie 增减）；`list`：只这些。 */
  readonly modelsMode: 'all' | 'list'
  readonly models: readonly string[]
  /** magpie 里这把密钥启用与否；没连上或已不在为 null。 */
  readonly enabled: boolean | null
  /** magpie 自己的掩码（尾号）；只给能写的人。 */
  readonly masked: string | null
  readonly limits: readonly MagpieLimitView[]
  readonly createdAt: number
  /** magpie 里还有这把密钥；没连上为 null。 */
  readonly present: boolean | null
}

export interface MagpieUsageTotalsView {
  readonly calls: number
  readonly errors: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /** magpie 的估算，美元。 */
  readonly cost: number
  readonly unpriced: number
}

export interface MagpieUsageView {
  readonly period: MagpieUsagePeriod
  readonly since: string | null
  readonly totals: MagpieUsageTotalsView
  readonly models: readonly (MagpieUsageTotalsView & {
    readonly id: string
    readonly name: string
  })[]
  readonly keys: readonly (MagpieUsageTotalsView & {
    readonly keyId: string
    readonly name: string
    /** 阡陌签发的密钥对应的绑定；别的密钥为 null。 */
    readonly binding: MagpieBinding | null
  })[]
}

export interface MagpieSnapshot {
  readonly connection: MagpieConnectionView
  /** 读 magpie 失败的原因；连接与绑定照常列出。 */
  readonly problem: { readonly code: string; readonly message: string } | null
  readonly providers: readonly MagpieProviderView[]
  readonly presets: readonly MagpiePresetView[]
  readonly groups: readonly MagpieGroupView[]
  readonly keys: readonly MagpieKeyView[]
  /** 签发时可选的模型：合格上游的模型与合格的路由组。 */
  readonly models: readonly string[]
  /** 模型服务能下发的节点。 */
  readonly nodes: readonly string[]
  readonly tenants: readonly string[]
}

export interface MagpieConnectDraft {
  readonly gatewayUrl: string
  readonly managementUrl: string
  /** 不给：沿用已封存的。 */
  readonly managementKey?: string
  /** magpie 管理页实际监听的端口，前面有反向代理时才要。 */
  readonly webCookiePort?: number
}

export interface MagpieProviderDraft {
  readonly preset: string
  readonly key?: string
  readonly name?: string
}

export interface MagpieGroupDraft {
  readonly id: string
  readonly from?: string
  readonly name?: string
  readonly members?: readonly string[]
  readonly routing?: MagpieRoutingName
  readonly affinity?: MagpieAffinityName
}

export interface MagpieLimitDraft {
  readonly period: MagpieLimitWindow
  readonly days?: number
  readonly hours?: number
  readonly tokens?: number
  readonly cost?: number
  readonly cacheReads?: boolean
}

export interface MagpieKeyDraft {
  readonly binding: MagpieBinding
  readonly mainModel: string
  readonly fastModel?: string | null
  readonly lane?: MagpieLane
  readonly limits?: readonly MagpieLimitDraft[]
  /** 不给或空：合格的全部；给了：只这些，每条都要合格。 */
  readonly models?: readonly string[]
}

export interface MagpieKeyChange {
  readonly enabled?: boolean
  readonly limits?: readonly MagpieLimitDraft[]
  /** null：回到合格的全部。 */
  readonly models?: readonly string[] | null
  readonly mainModel?: string
  readonly fastModel?: string | null
  /** 重新计数：一条限额的序号，或 `all`。 */
  readonly resetLimit?: number | 'all'
}

export interface MagpieTestView {
  readonly protocol: string
  readonly ok: boolean
  readonly status: number | null
  readonly ms: number
  readonly model: string | null
}

/** 发起写的人；`record` 交给模型服务给它自己的写记账。 */
export interface MagpieCaller extends DirectionActor {
  readonly breakGlass: boolean
  record(
    action: string,
    target: string,
    outcome: 'ok' | 'refused' | 'failed',
    code?: string,
  ): Promise<boolean>
}

export interface MagpiePort {
  snapshot(): Promise<ConsoleResult<MagpieSnapshot>>
  usage(period: MagpieUsagePeriod): Promise<ConsoleResult<MagpieUsageView>>
  connect(
    draft: MagpieConnectDraft,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieConnectionView>>
  /** 核对连接，并把每把密钥的模型白名单改回合格的范围。 */
  check(caller: MagpieCaller): Promise<ConsoleResult<MagpieConnectionView>>
  saveProvider(
    draft: MagpieProviderDraft,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieProviderView>>
  setProviderEnabled(
    id: string,
    on: boolean,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieProviderView>>
  /** magpie 向上游发最小请求；厂商原文不转述。 */
  testProvider(
    id: string,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<readonly MagpieTestView[]>>
  removeProvider(id: string, caller: MagpieCaller): Promise<ConsoleResult<void>>
  saveGroup(
    draft: MagpieGroupDraft,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieGroupView>>
  removeGroup(id: string, caller: MagpieCaller): Promise<ConsoleResult<void>>
  /** 节点：建密钥、写档案、指派、下发；租户：建密钥与档案，指派留给 P35。 */
  issueKey(
    draft: MagpieKeyDraft,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieKeyView>>
  updateKey(
    binding: MagpieBinding,
    change: MagpieKeyChange,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieKeyView>>
  /** magpie 生成新值，中枢写进档案再下发；id、限额与用量不变。 */
  rotateKey(
    binding: MagpieBinding,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieKeyView>>
  /** 先把节点换回原来的指派，再删密钥与档案；档案还有人用时留着。 */
  removeKey(
    binding: MagpieBinding,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<{ readonly profileKept: boolean }>>
}

// ---------------------------------------------------------------------------
// BillingPort —— 公开版订阅（P35）
// ---------------------------------------------------------------------------

/**
 * 公开版：运营方托管，按节点买订阅才能用。套餐 = 价格 + 天数 + 含几台托管节点；
 * **不卖模型额度**——订阅者在订阅页把自己的上游密钥接进平台网关（magpie），由
 * magpie 按租户隔离统一调度。宿主实现在 `packages/node/src/commands/consoleBilling.ts`，
 * 用 `@qianmo/billing` 记账、收款，用租户配置与网关端口开通；控制台包只认这个形状。
 *
 * 读方法按「谁」裁剪：成员只拿到自己的（`subject` 由路由从会话取，从不来自请求体）；
 * 平台方法由路由先判平台运维再调。写方法收 {@link DirectionActor}。
 *
 * 返回值从不含商户密钥、上游密钥或网关密钥；兑换码明文只在 `codes` 那一次返回里出现。
 * 两种支付通道只对本地假服务测过（未评估）。
 */

export const BILLING_CHANNELS = ['wechatpay', 'alipay'] as const
export type BillingChannel = (typeof BILLING_CHANNELS)[number]

export interface BillingPlanView {
  readonly id: string
  readonly name: string
  /** 整数分。 */
  readonly priceCents: number
  readonly periodDays: number
  /** 套餐含几台托管节点。 */
  readonly nodes: number
  readonly note: string | null
}

/** 配置里的公开事实：套餐、开着的收款方式、源代码与条款链接。 */
export interface BillingSiteView {
  /** AGPL 第 13 条：每个公开页面页脚都给出这个链接。 */
  readonly sourceUrl: string
  readonly termsUrl: string | null
  readonly plans: readonly BillingPlanView[]
  readonly channels: {
    readonly wechatpay: boolean
    readonly alipay: boolean
    readonly redeem: boolean
  }
}

/** 一个人此刻的订阅，闸门与前台据它判断；读本地账本，不连支付平台与网关。 */
export interface BillingStanding {
  readonly active: boolean
  readonly planId: string | null
  readonly endsAt: number | null
  /** 有效套餐含的节点数；没有有效订阅为 0。 */
  readonly nodes: number
  /** 开通后自动建的租户；还没开通为 null。 */
  readonly tenant: string | null
  /** 租户配置里分给这个租户的节点数（运维分配，可能超过 {@link nodes}）。 */
  readonly nodesMapped: number
}

export type BillingOrderStatus =
  | 'created'
  | 'paid'
  | 'closed'
  | 'expired'
  | 'refunded'

export interface BillingOrderView {
  readonly orderId: string
  readonly planId: string
  readonly channel: string
  readonly amountCents: number
  readonly status: BillingOrderStatus
  readonly createdAt: number
  readonly expiresAt: number
  readonly paidAt: number | null
}

/** 一张待支付订单与它的二维码内容（页面用零依赖编码器画成 SVG）。 */
export interface BillingCheckoutView {
  readonly orderId: string
  readonly planId: string
  readonly channel: BillingChannel
  readonly amountCents: number
  readonly expiresAt: number
  readonly qrText: string
}

/** 订阅者自己接进网关的一个上游。密钥只写不读。 */
export interface BillingUpstreamView {
  /** magpie 里的上游 id。 */
  readonly id: string
  readonly name: string
  readonly preset: string
  readonly models: number
  readonly ready: boolean
  /** 还在 magpie 里且仍属于这个租户；不在了就不进白名单。 */
  readonly present: boolean
}

/** 可选的上游预设：只有填一把 API 密钥就能用的那些（L-6）。 */
export interface BillingPresetView {
  readonly id: string
  readonly name: string
}

/** 订阅者网关密钥近 30 天的用量；费用是 magpie 的估算，不是账单。 */
export interface BillingUsageView {
  readonly period: '30d'
  readonly calls: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cost: number
}

export interface BillingMeView {
  readonly standing: BillingStanding
  readonly orders: readonly BillingOrderView[]
  readonly upstreams: readonly BillingUpstreamView[]
  /** 租户网关密钥：还没有（`none`）、停用（`off`）、可用（`on`）。 */
  readonly gateway: 'none' | 'off' | 'on'
  /** 档案的主模型；还没有自己的上游时为 null。 */
  readonly mainModel: string | null
  /** 读网关失败时为 null，其余照常给出。 */
  readonly usage: BillingUsageView | null
}

export interface BillingAdminOrderView extends BillingOrderView {
  readonly subject: string
  readonly outTradeNo: string
  readonly providerTxnId: string | null
}

export interface BillingAdminSubscriptionView {
  readonly subject: string
  readonly planId: string
  readonly startsAt: number
  readonly endsAt: number
  readonly active: boolean
  /** 开通状态：待开通、已开通、已停用。 */
  readonly gateway: 'pending' | 'enabled' | 'disabled'
  readonly attempts: number
  readonly tenant: string | null
}

export interface BillingAdminCodeView {
  readonly id: string
  readonly planId: string
  readonly periods: number
  readonly createdBy: string
  readonly createdAt: number
  readonly expiresAt: number | null
  readonly usedBy: string | null
  readonly usedAt: number | null
}

export type BillingChainView =
  | { readonly ok: true; readonly events: number }
  | { readonly ok: false; readonly seq: number; readonly reason: string }

export interface BillingAdminView {
  readonly plans: readonly BillingPlanView[]
  readonly channels: BillingSiteView['channels']
  readonly orders: readonly BillingAdminOrderView[]
  readonly subscriptions: readonly BillingAdminSubscriptionView[]
  readonly codes: readonly BillingAdminCodeView[]
  readonly chain: BillingChainView
}

/** 支付平台的回调原样交进来：原文一个字节不动，签名覆盖的就是它。 */
export interface BillingNotifyRequest {
  readonly headers: Headers
  readonly rawBody: string
  readonly contentType?: string
}

/** 回给支付平台的原样应答（状态、正文、头都由通道定）。 */
export interface BillingNotifyReply {
  readonly httpStatus: number
  readonly body: string
  readonly headers: Readonly<Record<string, string>>
}

export interface BillingPort {
  site(): BillingSiteView
  standing(subject: string): Promise<BillingStanding>
  me(subject: string): Promise<ConsoleResult<BillingMeView>>
  /** 同一人同一套餐同一通道只留一张未过期的待支付订单，再来就复用。 */
  checkout(
    subject: string,
    planId: string,
    channel: BillingChannel,
  ): Promise<ConsoleResult<BillingCheckoutView>>
  /** 只答这个人自己的订单；别人的与不存在的一样是 `not_found`。待支付时顺带查一次单。 */
  order(
    subject: string,
    orderId: string,
  ): Promise<
    ConsoleResult<BillingOrderView & { readonly qrText: string | null }>
  >
  redeem(subject: string, code: string): Promise<ConsoleResult<BillingStanding>>
  notify(
    channel: string,
    request: BillingNotifyRequest,
  ): Promise<BillingNotifyReply>
  presets(): Promise<ConsoleResult<readonly BillingPresetView[]>>
  /** 有效订阅者接一个自己的上游；密钥只交给 magpie，中枢不留存。 */
  addUpstream(
    subject: string,
    draft: { readonly preset: string; readonly key: string },
  ): Promise<ConsoleResult<BillingUpstreamView>>
  removeUpstream(subject: string, id: string): Promise<ConsoleResult<void>>
  // --- 平台运维 ---------------------------------------------------------
  admin(): Promise<ConsoleResult<BillingAdminView>>
  grant(
    actor: DirectionActor,
    input: {
      readonly subject: string
      readonly planId: string
      readonly periods: number
      readonly reason: string
    },
  ): Promise<ConsoleResult<BillingStanding>>
  /** 只登记商户平台上已经做完的退款，并相应缩短订阅。 */
  refund(
    actor: DirectionActor,
    input: { readonly orderId: string; readonly reason: string },
  ): Promise<ConsoleResult<BillingStanding>>
  /** 兑换码明文只在这一次返回；落盘只存哈希。 */
  codes(
    actor: DirectionActor,
    input: {
      readonly planId: string
      readonly periods: number
      readonly count: number
      readonly expiresAt?: number
    },
  ): Promise<ConsoleResult<{ readonly codes: readonly string[] }>>
  verify(): Promise<ConsoleResult<BillingChainView>>
}
