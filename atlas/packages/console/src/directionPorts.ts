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
  readonly doneBytes: number
  /** 清单摘要（各文件 `路径\tsha256` 按路径排序后的 SHA-256）；读到清单前为 null。 */
  readonly manifestSha256: string | null
  /** 中枢与目标两次核对都一致为 true；任何一次不一致为 false；没核对到为 null。 */
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

/** `sensitive`：只有账号、付款、发送类操作要确认；`always`：每次改变外部状态的操作都要确认。 */
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
  readonly outcome: 'allowed' | 'confirmed' | 'denied' | 'failed'
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
    actor: DirectionActor,
  ): Promise<ConsoleResult<DesktopNodeView>>
  recycle(
    ref: AgentRef,
    actor: DirectionActor,
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

export type ConnectorKind = 'mail' | 'calendar'

export interface ConnectorPresetView {
  readonly id: string
  readonly kind: ConnectorKind
  readonly name: string
  /** 预填的服务器与端口（`imapHost`、`smtpPort`、`caldavUrl` …），用户可改。 */
  readonly defaults: Readonly<Record<string, string | number | boolean>>
  /** 一行说明，例如「需要在邮箱设置里开启 IMAP 并生成授权码」。 */
  readonly hint: string
}

export interface ConnectorView {
  readonly id: string
  readonly name: string
  readonly kind: ConnectorKind
  readonly preset: string
  /** 只给主机名与账号的打码形式（`ab***@qq.com`）。 */
  readonly summary: Readonly<Record<string, string>>
  /**
   * 非秘密设置的原值（服务器、端口、账号），给编辑表单预填；只在运维级读者
   * 面前出现，路由对其他人去掉这一项。秘密（口令、带令牌的订阅地址）永不在此。
   */
  readonly settings?: Readonly<Record<string, string | number | boolean>>
  /** ICS 订阅为 true：只能读。 */
  readonly readOnly: boolean
  readonly secretSet: boolean
  readonly secretSetAt: number | null
  /** 能用这个连接的智能体地址。 */
  readonly agents: readonly string[]
  /** 没有用真实账号验证过：一律 false。 */
  readonly evaluated: boolean
  readonly lastProbe: {
    readonly at: number
    readonly ok: boolean
    readonly detail: string
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
  readonly id?: string
  readonly name: string
  readonly kind: ConnectorKind
  readonly preset: string
  /** 服务器、端口、账号等非秘密字段。 */
  readonly settings: Readonly<Record<string, string | number | boolean>>
  /** 口令或授权码；修改时不给就保留原值。 */
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
  /** 用保存的凭据连一次（登录后立即退出），结果记在 `lastProbe`。 */
  probe(
    id: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ConnectorView>>
}
