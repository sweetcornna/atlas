// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 阡陌端到端验收套件 —— 场景与驱动的公共类型。
 *
 * 这套件要回答的是负责人给的那条验收标准：「流程全部跑通，逻辑和所有功能
 * 模块全部正常，无任何 bug，无干预无错误跑完全部可能的场景和模拟」。
 * 一条标准要么被证明，要么被证伪 —— 所以这里的每个类型都为「逐场景独立
 * 判定 + 失败给原文证据」服务，没有任何聚合成一个布尔值的出口。
 *
 * 三条设计约束，改这个文件前先读：
 *
 * ① **场景定义与驱动分离，且只有一套场景。** 本地（起真进程 + 可控假上游）
 *    与真机舰队（四节点 + 控制台）是两个 {@link AcceptanceDriver} 实现，
 *    场景代码对二者一字不改。写第二套场景 = 两边会漂移，那时候「本地绿」
 *    就不再说明任何事。
 *
 * ② **能力不足要 skip，不要假装 pass。** 场景声明自己需要哪些
 *    {@link DriverCapability}，驱动声明自己有哪些，runner 做差集。真机驱动
 *    对「按任意参数起一个新节点」这类能力天然没有，那就如实记 `skip` 并写明
 *    原因 —— 报告里 skip 与 pass 分列两栏，覆盖率据此计算。
 *
 * ③ **判定只由场景自己给，证据必须是原文。** {@link Evidence.value} 存的是
 *    错误串 / HTTP 码 / 日志行 / 帧内容本身，不是「失败了」这种转述。这套
 *    件的价值全在红的那几行上；把证据摘要化等于把价值删掉。
 */

/** 验收目标：本地进程，或真机舰队。 */
export type Target = 'local' | 'fleet'

/**
 * 单场景判定。
 *
 * `fail` 与 `error` 分开：前者是**断言不成立**（系统行为与期望不符，这正是
 * 套件要抓的东西），后者是**套件自己炸了**（驱动起不来、超时、抛异常）。
 * 合并成一个值会让「被测系统有 bug」和「测试有 bug」看起来一样，而这两件事
 * 的处理方式完全相反。
 */
export type Outcome = 'pass' | 'fail' | 'skip' | 'error'

/** 场景维度 —— 与验收矩阵的行一一对应。 */
export type Dimension =
  | 'handshake'
  | 'policy'
  | 'capability'
  | 'trust'
  | 'delivery'
  | 'model-credential'
  | 'abort-attribution'
  | 'multi-agent'
  | 'audit'
  | 'wake'
  | 'recovery'
  | 'launcher'
  | 'limits'
  | 'console'
  | 'certificate'

export const DIMENSIONS: readonly Dimension[] = [
  'handshake',
  'policy',
  'capability',
  'trust',
  'delivery',
  'model-credential',
  'abort-attribution',
  'multi-agent',
  'audit',
  'wake',
  'recovery',
  'launcher',
  'limits',
  'console',
  'certificate',
]

/**
 * 一条原文证据。
 *
 * `value` 不截断也不改写。太长的话由渲染层负责折行，不是由采集层负责裁剪 ——
 * 采集层一裁剪，NDJSON 里就永远拿不回来了。
 */
export interface Evidence {
  readonly label: string
  readonly value: string
}

/** 驱动能力。场景按需声明，驱动按实提供，缺一项就 skip。 */
export type DriverCapability =
  /** 能按任意参数起一个全新常驻节点（本地有，真机没有）。 */
  | 'spawn-node'
  /**
   * 能按任意参数起一个全新控制台进程 **并直连它的 HTTP 面**（本地有，真机没有）。
   *
   * 与 `spawn-node` 分开，因为两者在真机腿上不足的理由不同：那边节点是部署好的，
   * 而控制台既是部署好的、又只经隧道可达，「起一个自己的控制台再打它的端口」
   * 在真机上两头都不成立。合并成一个能力会让真机腿的 skip 理由说不清是哪一半。
   */
  | 'spawn-console'
  /** 能重启一个已有节点（本地有；真机需 `--allow-restart`）。 */
  | 'restart-node'
  /** 能改节点的环境变量 / 凭据文件后重启。 */
  | 'mutate-node-env'
  /** 能读节点上的文件（审计链、transcript、timings、pid）。 */
  | 'read-node-files'
  /** 能在节点侧跑一条 CLI（`qm audit --verify` 之类）。 */
  | 'exec-node-cli'
  /** 能对节点做帧级原始拨号（自带握手材料，两个目标都有）。 */
  | 'raw-dial'
  /** 能跑仓库自带的启动器脚本（`beta-up.sh` 等）。 */
  | 'run-launcher'
  /** 能对着一个可控的假模型上游跑（本地有；真机打真实端点）。 */
  | 'stub-upstream'
  /**
   * 能读**本仓库源码**（静态断言用，两个目标都有）。
   *
   * 少数场景断言的是「代码里只有一处按 trust 分支」「NoticeTrust 是两值封闭
   * 联合」这类**代码形状**，不需要任何被测进程。它们仍要声明能力而不是留空
   * `requires`：留空会让「忘了写 requires」和「确实不需要能力」在表自检里
   * 长得一模一样。
   */
  | 'read-repo-source'

/** 场景执行结果（写进 NDJSON 的那一行）。 */
export interface ScenarioResult {
  readonly id: string
  readonly dimension: Dimension
  readonly title: string
  readonly target: Target
  readonly outcome: Outcome
  readonly durationMs: number
  /** 期望行为，一句话。红的时候人读的就是这句和 `actual` 的差。 */
  readonly expected: string
  /** 实际观察到的行为。 */
  readonly actual: string
  readonly evidence: readonly Evidence[]
  /** `skip` 时必填：为什么跳过（缺哪个能力 / 被 filter 排除）。 */
  readonly skipReason?: string
  /**
   * 已知缺陷编号（如 `#44`）。
   *
   * **这不是豁免。** 挂了编号的场景照样按 `fail` 计，只是在汇总表里标出来，
   * 让读的人知道这条红是已被记录的缺陷而不是新回归。把已知缺陷改判成 pass
   * 就等于让套件对自己要抓的东西闭眼。
   */
  readonly knownIssue?: string
  /** 场景自己声明的、这次实际用到的能力（便于复盘覆盖面）。 */
  readonly requires: readonly DriverCapability[]
  /**
   * 这条场景实际调用过的驱动方法名，按调用顺序，含重复。
   *
   * **这是「它到底有没有碰过目标」的唯一凭据**，由 runner 用
   * {@link instrumentDriver} 自动采集，场景写不了也改不了它。空数组有两种
   * 合法情形（`read-repo-source` 那类静态断言、以及被 skip 的场景），除此
   * 之外的空数组就是一条声明了能力却绕过驱动的场景 —— issue #61 那次假绿
   * 里 11 条绿全部是这个形态。
   */
  readonly driverCalls: readonly string[]
}

/** 场景返回给 runner 的东西 —— 判定 + 证据，不含 id/耗时这些框架字段。 */
export interface ScenarioOutcome {
  /** 断言是否成立。 */
  readonly ok: boolean
  readonly actual: string
  readonly evidence: readonly Evidence[]
  /**
   * 场景自己要求跳过（例如探测到本目标上这条链路根本没部署）。
   * 置了就覆盖 `ok`，记成 `skip`。
   */
  readonly skip?: string
}

/** 场景定义。 */
export interface Scenario {
  /** 稳定 id，形如 `handshake/psk-ok`。NDJSON 的主键，不要改。 */
  readonly id: string
  readonly dimension: Dimension
  readonly title: string
  readonly expected: string
  readonly requires: readonly DriverCapability[]
  readonly knownIssue?: string
  /** 单场景超时，缺省取 runner 的默认值。超时记 `error` 不记 `fail`。 */
  readonly timeoutMs?: number
  run(ctx: ScenarioContext): Promise<ScenarioOutcome>
}

/** 场景运行上下文。每个场景一份，互不共享。 */
export interface ScenarioContext {
  readonly driver: AcceptanceDriver
  /** 本场景专属的临时目录，runner 负责创建与清理。 */
  readonly workdir: string
  /** 分配一个当前空闲的 TCP 端口。 */
  allocPort(): Promise<number>
  /** 登记一个清理动作，runner 在 `finally` 里逆序执行（超时也会跑）。 */
  cleanup(fn: () => void | Promise<void>): void
  /** 结构化日志，只进 NDJSON 的 `log` 字段，不污染汇总表。 */
  log(line: string): void
  /** 中止信号：超时时 abort，长等待应当监听它。 */
  readonly signal: AbortSignal
}

// ---------------------------------------------------------------------------
// 驱动层
// ---------------------------------------------------------------------------

/** 一个常驻节点的启动参数（驱动无关的那部分）。 */
export interface NodeSpec {
  /** 节点名，落到 `qianmo://<name>/<agent>` 的第一段。 */
  readonly name: string
  /** agent 名 → 工作区绝对路径。至少一项。 */
  readonly agents: Readonly<Record<string, string>>
  /** 握手认证档：`psk` / `signature` / `credential_signature`。 */
  readonly auth: AuthSpec
  /** 任务策略：开放 / 要求签名任务。 */
  readonly policy: 'open' | 'signed-task'
  /**
   * 一个策略开关都不给（测「默认档位是什么」以及那条未选警告）。
   *
   * 单独成字段而不是让 `policy` 多一个取值：`policy` 是**期望的运行档位**，
   * 场景后面的断言都按它写；这一条问的是**命令行给没给**，两件事。
   */
  readonly omitPolicyFlag?: boolean
  /** 信任的签发者公钥（PEM / base64，按 {@link AuthSpec} 的约定）。 */
  readonly trust?: readonly string[]
  /** 是否要求唤醒签名。 */
  readonly wakeSign?: boolean
  /** 额外环境变量（模型端点、假上游地址等）。 */
  readonly env?: Readonly<Record<string, string>>
  /** 额外 CLI 参数，给场景开后门用，慎用。 */
  readonly extraArgs?: readonly string[]
}

export type AuthSpec =
  | { readonly mode: 'psk'; readonly psk: string }
  | { readonly mode: 'signature'; readonly keyDir: string }
  | { readonly mode: 'credential_signature'; readonly keyDir: string }

/** 已启动节点的句柄。 */
export interface NodeHandle {
  readonly name: string
  readonly spec: NodeSpec
  /** 传输层监听地址，形如 `ws://127.0.0.1:38625`（真机是隧道后的地址）。 */
  readonly endpoint: string
  /** 节点配置根（`.../config/qianmo`），审计链与身份都在它下面。 */
  readonly configRoot: string
  /** 进程 stderr 的累计内容（本地驱动实时收集，真机驱动按需拉取）。 */
  stderr(): Promise<string>
  stdout(): Promise<string>
  /** 进程是否还活着。 */
  alive(): Promise<boolean>
}

export interface ExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** 原始拨号的结果 —— 帧级探针要看的全部东西。 */
export interface DialProbe {
  /** 握手是否走完。 */
  readonly authed: boolean
  /** 连接被关闭时的 code（4003 / 4004 / 1000 …），没关就是 undefined。 */
  readonly closeCode?: number
  /** 关闭原因原文。 */
  readonly closeReason?: string
  /** 收到的全部帧（原文 JSON 串，按到达顺序）。 */
  readonly frames: readonly string[]
  /** 拨号过程中的异常原文。 */
  readonly error?: string
}

/** 原始拨号参数。故意允许构造非法材料 —— 这正是要测的东西。 */
export interface DialOptions {
  readonly auth: DialAuth
  /** 握手成功后要发的帧（原样序列化发出，允许违反协议）。 */
  readonly send?: readonly unknown[]
  /** 不等握手完成就发（用来测 4003）。 */
  readonly sendBeforeAuth?: readonly unknown[]
  /** 收到几帧后主动关闭；缺省等服务端关或超时。 */
  readonly expectFrames?: number
  readonly timeoutMs?: number
}

export type DialAuth =
  | { readonly mode: 'psk'; readonly psk: string }
  | {
      readonly mode: 'signature'
      readonly nodeName: string
      readonly privateKeyPem: string
    }
  | {
      readonly mode: 'credential_signature'
      readonly nodeName: string
      readonly privateKeyPem: string
      readonly credential?: string
    }
  /** 完全不握手，直接发业务帧。 */
  | { readonly mode: 'none' }

/**
 * 驱动层。本地与真机各一个实现，场景只认这个接口。
 *
 * 方法都可能抛；runner 会把抛出记成 `error` 并带上栈。驱动**不要**吞异常
 * 后返回一个「看起来正常」的值 —— 那会把套件变成永远绿的装饰品。
 */
export interface AcceptanceDriver {
  readonly target: Target
  readonly capabilities: ReadonlySet<DriverCapability>
  /** 起一个节点（真机驱动上是「附着到已有节点」，见各实现的注释）。 */
  startNode(ctx: ScenarioContext, spec: NodeSpec): Promise<NodeHandle>
  stopNode(node: NodeHandle): Promise<void>
  /**
   * 停掉再按（可覆盖的）同一份参数起回来。
   *
   * **配置根必须原样保留** —— 身份密钥、审计链、会话表都锚在它上面，换一个
   * 根就不是「重启」而是「另起一个节点」，恢复维度那三条断言全部失去意义。
   */
  restartNode(
    ctx: ScenarioContext,
    node: NodeHandle,
    overrides?: Partial<NodeSpec>,
  ): Promise<NodeHandle>
  /** 帧级原始拨号。 */
  dial(
    ctx: ScenarioContext,
    node: NodeHandle,
    opts: DialOptions,
  ): Promise<DialProbe>
  /** 读节点上的文件，不存在返回 undefined（**不要**抛，「不存在」是一种观察）。 */
  readNodeFile(node: NodeHandle, relPath: string): Promise<string | undefined>
  /** 列目录，不存在返回 undefined。 */
  listNodeDir(node: NodeHandle, relPath: string): Promise<string[] | undefined>
  /** 在节点侧跑一条 CLI。 */
  execNode(node: NodeHandle, argv: readonly string[]): Promise<ExecResult>
}

/** 整轮运行的汇总（写进 NDJSON 的最后一行 + 汇总表表头）。 */
export interface SuiteRun {
  readonly target: Target
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly results: readonly ScenarioResult[]
  readonly counts: Readonly<Record<Outcome, number>>
  /**
   * 本轮**真正触达目标**的场景数：已执行（非 skip）且至少调用过一次驱动。
   *
   * 0 意味着这一轮关于被测目标什么都没证明 —— 见 {@link SuiteRun.pass}。
   */
  readonly targetTouches: number
  /**
   * 是否整体通过：无 `fail`、无 `error`，**且 `targetTouches > 0`**。
   * skip 不影响。
   *
   * 最后那一项是 issue #61 的直接产物：真机腿曾经在驱动零调用的情况下报出
   * `pass=11 fail=0 skip=104` 与 exit 0。一轮没碰过目标的运行不是「通过」，
   * 它是「没验」，而这两者对读报告的人必须长得不一样。
   */
  readonly pass: boolean
  /** 套件版本 / 提交，便于把一份结果钉回代码。 */
  readonly commit?: string
}
