// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Everything the console reads or acts on, expressed as ports.
 *
 * The console package is a leaf: it never imports the host's `src/`, never
 * opens the audit file itself and never talks to a socket on its own. The CLI
 * handler that starts it (`occ console`) is the only place that knows where the
 * registry lives, which trail file to read and how to send a wake — it injects
 * those here. That keeps this package testable with plain objects and keeps the
 * host's dependency direction pointing inward, the same rule the tool-runtime
 * facades follow (root CLAUDE.md, "Host facade 模式").
 *
 * Every port returns data or a typed failure. None of them throw for an
 * expected condition — a console that 500s because the registry is down is
 * worse than one that renders "注册中心不可达" next to the rest of the page.
 */

import type { AuditRecord, MessageChain } from '@qianmo/audit'

/** One agent as the registry reports it (registry HTTP v0 `AgentBody`). */
export interface ConsoleAgent {
  readonly address: string
  readonly endpoint: string
  readonly capabilities: readonly string[]
  /** Absent until the node publishes one; never a private key. */
  readonly publicKey?: string
  readonly status: string
  readonly registeredAt: number
  readonly lastHeartbeatAt: number
  readonly expiresAt: number
}

/**
 * Uniform failure shape for every port. `code` is for tests, not for users.
 *
 * `unreachable` and `refused` are the pair worth being careful with, because
 * collapsing them is a bug that costs an operator an afternoon: `unreachable`
 * means the far side was never reached, and it points at tunnels, ports and
 * routes; `refused` means it was reached, understood the request and declined
 * it, and it points at that node's policy and its audit trail. A node that
 * refuses a wake for want of a capability token is `refused` — reporting it as
 * `unreachable` sent people to check a network that was working (issue #29).
 *
 * `rejected` is the third of the family and it is about **this** side: a rule
 * here would not let the request leave.
 */
export interface ConsoleFailure {
  readonly code:
    | 'unreachable'
    | 'refused'
    | 'rejected'
    | 'not_found'
    | 'unsupported'
    | 'invalid'
  readonly message: string
}

export type ConsoleResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ConsoleFailure }

/** Registration input accepted from the page — the reason the console exists. */
export interface RegisterAgentInput {
  readonly address: string
  readonly endpoint: string
  readonly capabilities?: readonly string[]
  readonly publicKey?: string
  readonly status?: string
}

/**
 * The registry face. Backed by HTTP v0 in production, by a fake in tests.
 * `list` is the only call the read-only view makes.
 */
export interface RegistryPort {
  list(): Promise<ConsoleResult<readonly ConsoleAgent[]>>
  register(input: RegisterAgentInput): Promise<ConsoleResult<ConsoleAgent>>
  deregister(address: string): Promise<ConsoleResult<void>>
  heartbeat(address: string): Promise<ConsoleResult<ConsoleAgent>>
}

// ---------------------------------------------------------------------------
// LifecyclePort —— 智能体生命周期（P15.2）
// ---------------------------------------------------------------------------

/**
 * 智能体生命周期：注册（发布）、暂停、恢复、退役（`tenancy-m1.md` §3.6，P15.2）。
 *
 * ## 这是控制台登记簿上的开关，不是节点上的动作
 *
 * 节点托管哪些 agent 由节点启动配置决定；装机面的动作集里没有 agent 粒度的
 * 动作。所以这四个动作只改两处：控制台的登记簿（`registrations.json`，状态与
 * 最近一次改它的主体），以及注册中心的那条记录（发布与恢复 `POST`，暂停与
 * 退役 `DELETE`）。真正挡住流量的是中枢的三个出口——对话、唤醒、`qm watch`——
 * 它们在拨号之前查登记簿，`paused` 与 `retired` 的地址一次都不拨（D8）。
 *
 * ## 托管清单
 *
 * 装机面落地之前，能被这样开关的地址只有中枢 `peers.conf` 的地址行
 * （注册中心的 `--register` 种子）。宿主用 `--managed <地址>=<端点>` 把它交给
 * 控制台；给了清单，发布与恢复只认清单里的地址，端点从清单取。
 *
 * ## 读不出来就全拒
 *
 * 登记簿读不出来时，宿主不知道哪些地址被暂停、哪些已退役。这时四个写动作
 * 一律 `unavailable`，三个出口一律不发——「从空登记簿起」会把退役的地址重新
 * 发布出去。
 *
 * 这一段只放形状。实现在宿主（`src/cli/handlers/consoleRegistrations.ts`），
 * 与其余端口同一条边界：这个包不碰文件系统。
 */

/** 登记簿里一条的状态。盘上缺这个字段的条目（P15.2 之前写的）就是 `active`。 */
export const REGISTRATION_STATES = ['active', 'paused', 'retired'] as const

export type RegistrationState = (typeof REGISTRATION_STATES)[number]

/** 登记簿里的一条，连同最近一次改它的人。历史在动作账本里，这里只有现状。 */
export interface RegistrationRecord {
  readonly address: string
  readonly state: RegistrationState
  /** 主体（`u:…` / `legacy:admin`），与动作账本同一种写法。旧条目没有。 */
  readonly by?: string
  /** epoch 毫秒。旧条目没有。 */
  readonly at?: number
  /** 在不在托管清单里。控制台没有托管清单时缺席。 */
  readonly managed?: boolean
}

/** 登记簿此刻的样子。 */
export interface LifecycleSnapshot {
  /**
   * `null` 表示可用；否则是读不出来或写不进去的原因。这时发布与恢复一律被拒，
   * 读不出来时三个出口也一律不发。
   */
  readonly problem: string | null
  /**
   * `problem` 是哪一种（`console.md` §7.3.1）。`unreadable`：读不出来，四个写动作
   * 全拒、三个出口谁都不拨；`unwritable`：写不进去，暂停与退役照收、出口按内存里
   * 那份判，只是发布与恢复被拒。`problem` 为 `null` 时缺席；有 `problem` 却缺席时
   * 读的人按 `unreadable` 处理——拿不准就往关着的那边说。
   */
  readonly problemKind?: 'unreadable' | 'unwritable'
  /** 托管清单里的地址；控制台起的时候没给清单就是 `null`。 */
  readonly managed: readonly string[] | null
  readonly registrations: readonly RegistrationRecord[]
}

/** 页面上的「发布」。有托管清单时端点从清单取，可以不给；给了就必须一致。 */
export interface PublishInput {
  readonly address: string
  readonly endpoint?: string
  readonly capabilities?: readonly string[]
  readonly publicKey?: string
  readonly status?: string
}

/**
 * 在这一侧挡下、什么都没发出去的拒绝。
 *
 * - `unavailable`：登记簿读不出来或写不进去（503）；
 * - `unmanaged`：地址不在托管清单里（403）；
 * - `retired` / `paused`：状态不允许（409）——退役的地址不再分配，暂停的
 *   地址要用恢复；
 * - `not_found`：登记簿与托管清单里都没有这个地址（404）；
 * - `invalid`：输入本身不对，例如端点与托管清单不一致（400）。
 */
export interface LifecycleRefusal {
  readonly code:
    | 'unavailable'
    | 'unmanaged'
    | 'retired'
    | 'paused'
    | 'not_found'
    | 'invalid'
  readonly message: string
}

/**
 * 三种结局分开：做成了；这一侧拒了（`refusal`）；交给注册中心、它没收
 * （`failure`）。动作账本据此记 `refused` 或 `failed`。
 */
export type LifecycleOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: LifecycleRefusal }
  | { readonly ok: false; readonly failure: ConsoleFailure }

/** 一次动作之后：登记簿里那一条，以及（发布与恢复时）注册中心的回执。 */
export interface LifecycleChange {
  readonly registration: RegistrationRecord
  readonly agent?: ConsoleAgent
}

/**
 * 生命周期的写面与读面。可选：缺席时这几条路由回 501，`POST /v0/agents`
 * 照旧直接走 {@link ConsoleDeps.registry}。
 *
 * 写方法都带 `by`：路由取当前请求的主体（`access.ts` 的 `subjectOf`），
 * 实现把它与时刻一起写进登记簿。
 */
export interface LifecyclePort {
  read(): Promise<LifecycleSnapshot>
  publish(
    input: PublishInput,
    by: string,
  ): Promise<LifecycleOutcome<LifecycleChange>>
  pause(address: string, by: string): Promise<LifecycleOutcome<LifecycleChange>>
  resume(
    address: string,
    by: string,
  ): Promise<LifecycleOutcome<LifecycleChange>>
  retire(
    address: string,
    by: string,
  ): Promise<LifecycleOutcome<LifecycleChange>>
}

/**
 * Where a trail stands, in the four states that call for four different next
 * actions.
 *
 * `intact` alone could not carry this. Three of these read `records: []` on
 * the wire and the console used to render all three as the green 完整:
 *
 * - `intact` — records are there and the hash chain holds end to end;
 * - `empty` — the chain file is there and holds no records. A node that has
 *   done no protocol work yet, which is a **normal** state and must not be
 *   reported as a finding;
 * - `absent` — there is no chain file. The node never wrote one, or the copy
 *   that was meant to arrive never did. Not a finding about integrity, but
 *   emphatically not health either: it is the state in which the audit
 *   surface would stay silent through anything;
 * - `broken` — records are there and the chain does not verify.
 */
export type AuditChainState = 'intact' | 'empty' | 'absent' | 'broken'

/** What a trail read yields, integrity verdict included. */
export interface AuditPage {
  readonly records: readonly AuditRecord[]
  /**
   * Where the chain stands. The field `intact` cannot answer on its own —
   * see {@link AuditChainState}.
   */
  readonly chain: AuditChainState
  /**
   * True only when there is a chain and nothing is wrong with it, so `empty`
   * qualifies and `absent` does not. Retained beside {@link AuditPage.chain}
   * because "is anything wrong" is still the one question most callers ask,
   * and because a caller that never learned about the four states must not
   * keep reading a missing file as a healthy one.
   */
  readonly intact: boolean
  /** How many issues the reader found, whatever their kind. */
  readonly issueCount: number
  /** Total records in the trail before filtering, for "showing N of M". */
  readonly total: number
  /**
   * Off-host witness verdict, absent only when this console has no anchor
   * source configured. A stale witness is distinct from a chain mismatch: it
   * means records past the newest anchor have no evidence and the witness has
   * heard nothing within its window (or there is no valid anchor at all), not
   * that a rewrite was found. An idle trail whose head is anchored is not
   * stale, so a quiet node keeps its verified state.
   *
   * `uncovered` appears only on a mirror source, and only when the witness
   * already holds anchors past the end of the copy: the mirror has not
   * caught up, which is neither a mismatch nor an absence of evidence. It
   * never appears together with `stale`.
   */
  readonly witness?: {
    readonly tampered: boolean
    readonly stale: boolean
    readonly uncovered?: true
    /**
     * Only with `tampered`: the lowest anchor whose head disagrees, and the
     * local record's digest at that seq (`null` when the record is missing).
     * Together they name this occurrence of the mismatch — the alert inbox
     * keys on them, so a chain repaired and later rewritten again raises a
     * new alert instead of hiding under the old acknowledgement.
     */
    readonly firstMismatch?: {
      readonly seq: number
      readonly actual: string | null
    }
  }
  /**
   * The highest `seq` on the trail, 0 when it holds no records: what an
   * incremental poll passes back as {@link AuditFilter.since}. Absent from a
   * port that does not page (a hand-written test double).
   */
  readonly head?: number
  /**
   * The {@link AuditFilter.before} that reads the next older page, or `null`
   * when this page already reaches the oldest record the filter matches.
   * Absent from a port that does not page.
   */
  readonly earlier?: number | null
}

/** Filter accepted by the audit view; every field is optional and ANDed. */
export interface AuditFilter {
  readonly source?: string
  readonly outcome?: string
  readonly traceId?: string
  readonly taskId?: string
  readonly agent?: string
  readonly from?: number
  readonly to?: number
  /**
   * A relative time window (`1h` / `24h` / `7d`), as the filter form's
   * segmented control submits it.
   *
   * **Not a port concern**: `parseAuditFilter` resolves it into `from` before
   * any port ever sees the filter, and every {@link AuditPort} keeps reading
   * `from`/`to` alone. It survives on the shape for two consumers on the view
   * side — the segment has to know which of its four options is checked, and
   * the poller has to replay the *window* rather than the instant it happened
   * to resolve to five seconds ago. An explicit `from`/`to` out of the advanced
   * panel wins, which is what the 自定义 option means.
   */
  readonly window?: string
  /** Tail size. The port clamps it; the view never asks for the whole file. */
  readonly limit?: number
  /**
   * One search box: a case-insensitive substring of the kind, the trace,
   * task and message ids, the code, node, peer, source or a detail string
   * (`@qianmo/audit`, `TrailQuery.text`). ANDed with everything else.
   */
  readonly q?: string
  /**
   * The cursor: only records whose `seq` is below this — the page older
   * than one already shown, as {@link AuditPage.earlier} handed it out.
   * Records appended meanwhile never land on a page asked for this way.
   */
  readonly before?: number
  /**
   * The increment: only records whose `seq` is above this — what arrived
   * after a poller last saw {@link AuditPage.head}. When more arrived than
   * one page holds, the page says so with a non-null `earlier`.
   */
  readonly since?: number
}

export interface AuditPort {
  read(filter: AuditFilter): Promise<ConsoleResult<AuditPage>>
  chain(traceId: string): Promise<ConsoleResult<MessageChain | null>>
}

/** One independently read audit source, supplied by the host CLI. */
export interface ConsoleAuditSource {
  /** Stable CLI node name, never inferred from the path. */
  readonly node: string
  readonly audit: AuditPort
  /** Explicit deployment metadata; mirror status is never path-derived. */
  readonly kind: 'authoritative' | 'mirror'
  /** Required when kind is mirror; measured timer interval in minutes. */
  readonly maxLagMinutes?: number
}

/** A wake request as the page can express it. */
export interface WakeInput {
  /** Named wake allowlist selector. Required only for multi-target consoles. */
  readonly node?: string
  readonly from: string
  readonly to: string
  readonly prompt: string
  readonly url: string
  readonly afterMs?: number
}

export interface WakeOutcome {
  readonly msgId: string
  readonly taskId: string
  readonly receipt: string
}

/**
 * Optional: absent when the console runs without a transport PSK, in which
 * case the page shows the wake form disabled with the reason, rather than
 * offering a button that always fails.
 */
export interface WakePort {
  send(input: WakeInput): Promise<ConsoleResult<WakeOutcome>>
}

/** A fixed, named outbound wake target and its independently wired port. */
export interface WakeTarget {
  readonly node: string
  readonly url: string
  /** Missing only when that node's own PSK was absent or unusable. */
  readonly wake?: WakePort
  /** Operator-facing local-degradation reason; never contains a PSK. */
  readonly unavailableReason?: string
}

// ---------------------------------------------------------------------------
// ChatPort —— 与常驻 agent 对话（P12）
// ---------------------------------------------------------------------------

/**
 * 聊天面的端口。
 *
 * 这个包**不知道回程是怎么回来的**：它不知道有传输层、不知道有 PSK、不知道一条
 * 回复是 `task.result` 还是别的什么。它只知道四件事——有哪些能聊的对象、有哪些
 * 会话、一条会话里有哪些轮次、以及「有新东西了」这个通知。host 侧
 * (`src/cli/handlers/consoleChat.ts`) 负责把它接到真的网络上。
 *
 * 这条边界不是形式主义：回程的实现（同一条已认证连接上的 ack + task.result）
 * 是协议层的决定，将来换成别的形状时，这个包一行都不用改，而它的用例也不需要
 * 起一个 WebSocket 服务端。
 */

/** 一个可以聊天的对象：注册中心里的一条记录，且它的端点在允许拨号的名单里。 */
export interface ChatTarget {
  /** `qianmo://<node>/<agent>`。 */
  readonly address: string
  readonly node: string
  /** 地址的 agent 段——**会话标题用的就是它**，不另起一套显示名。 */
  readonly agent: string
  /** 注册中心给的端点。 */
  readonly endpoint: string
  /** 注册中心报的状态字符串（`online` / `dormant` / …）。 */
  readonly status: string
  /**
   * 这个控制台**愿意**拨它吗。
   *
   * 注册中心自己没有任何鉴权（console.md §8.2），所以「注册中心说端点在这里」
   * 不等于「控制台就该往那里发一条带 PSK 握手的消息」。允许拨号的端点由启动参数
   * 钉死，不在名单里的对象照样列出来，但标成不可达并说明原因——藏起来只会让人
   * 以为控制台坏了。
   */
  readonly dialable: boolean
}

/** 一轮是谁说的。只有两种，没有「系统」这一档。 */
export type ChatAuthor = 'operator' | 'agent'

/**
 * 这一条是一句话，还是一条过程。
 *
 * **`message`** 是转录本来就有的那种：操作者问的一句，或 agent 答的一句。
 * **`notice`** 是任务跑到一半时节点推过来的一条 `notify`——工具开始/结束、
 * 计划更新。两者同处一个有序表而不是分成两条流，因为页面要回答的问题是
 * 「这一轮里先后发生了什么」，而两条各自有序的流合并起来才是那个答案，
 * 合并的时机越晚越容易错。
 *
 * 字段可选且缺省为 `message`：存量 NDJSON 里没有它，重放必须原样成立。
 * **刻意不叫 `kind`**——`consoleChatStore.ts` 的落盘信封已经用那个词区分
 * 「这行是会话还是轮次」，同一个文件里两个 `kind` 指两件事是给未来的读者
 * 埋雷。
 */
export type ChatTurnVariant = 'message' | 'notice'

/**
 * 一条过程行的分量，原样取自 `notify` 的 `severity`（协议 §14.2）。
 *
 * 页面只拿它选颜色，**不拿它过滤**：一条被过滤掉的过程行，和一条从来没发生
 * 过的过程，在页面上长得一模一样。
 */
export type ChatNoticeSeverity = 'info' | 'warn' | 'error'

/**
 * 一轮的处置。**是一条链，不是一个枚举里的平行项**：
 * `pending`（交给传输层了）→ `delivered`（有回执了）→ `read`（对方 ack 了，
 * 也就是消息真的进了它的输入）→ `done`（拿到终态回复）。`failed` 是任何一步的
 * 出口。agent 的那一轮只会是 `done` 或 `failed`。
 */
export type ChatTurnState = 'pending' | 'delivered' | 'read' | 'done' | 'failed'

/**
 * 转录里的一轮。
 *
 * 字段是**平的**，因为页面上那几个小 pill（「已投递 · 回执 accepted」「已读
 * 42ms」）是视图从这些数字算出来的，不是端口拼好的字符串。端口拼字符串等于把
 * 文案纪律搬到 host 侧，而那边没有视图层的用例看着它。
 */
export interface ChatTurn {
  readonly id: string
  readonly sessionId: string
  readonly author: ChatAuthor
  /** epoch 毫秒。 */
  readonly at: number
  readonly text: string
  readonly state: ChatTurnState
  /** 请求与回复的关联键（protocol C-1）。 */
  readonly taskId?: string
  /** 审计关联用，页面据此跳到消息链面板。 */
  readonly traceId?: string
  /** 传输层回执状态字符串。 */
  readonly receipt?: string
  /** 从发出到拿到回执的毫秒数。 */
  readonly receiptMs?: number
  /** 从发出到对方 ack 的毫秒数。 */
  readonly readMs?: number
  /** 从发出到终态回复的毫秒数（记在 agent 那一轮上）。 */
  readonly elapsedMs?: number
  /** 失败时的协议错误码，例如 `E_TASK_TIMEOUT`。 */
  readonly code?: string
  /** 缺省为 `message`；`notice` 是任务跑到一半推过来的一条过程。 */
  readonly variant?: ChatTurnVariant
  /** 只有 `notice` 有：这条过程的分量。 */
  readonly severity?: ChatNoticeSeverity
  /** 只有 `notice` 有：`notify` 的 `detail`，页面折起来给愿意看的人。 */
  readonly detail?: string
  /**
   * 只有 `notice` 有：这条是对面重发的。
   *
   * 协议 §14.4 要求重发**看得见**，不能悄悄变成第二条不同的过程。刻意不塞进
   * `code`——那一格是失败时的协议错误码，而重发既不是失败也不是错误码。
   */
  readonly redelivered?: true
  /**
   * 这一轮是本地命令（P18.20）。操作者那一轮是命令原文；agent 那一轮是命令在
   * 节点上的输出，**不是模型写的**，页面据此换一种画法。只有拿到 `completed`
   * 的那一轮带它：超时、失败照旧是一条失败行。
   */
  readonly command?: ChatLocalCommand
}

/**
 * 对话里能当本地命令发给节点的三条（P18.20，D-9）。
 *
 * 控制台按 `^/(autocompact|compact|context)(\s|$)` 认出它们，原文不改，信封
 * 的 payload 另带 `command: { name }`。节点只在这条是控制台签的、且它被告知
 * 这个签名名就是它的控制台（`qm resident --local-commands-from`）时把原文交给
 * 会话当命令跑；其余情况照旧当一句话。节点那一侧的同一张表是
 * `src/services/acp/agent/localCommands.ts` 的 `ACP_LOCAL_COMMANDS`，两边有
 * 用例对着。
 */
export const CHAT_LOCAL_COMMANDS = [
  'autocompact',
  'compact',
  'context',
] as const

export type ChatLocalCommand = (typeof CHAT_LOCAL_COMMANDS)[number]

/** 一条会话的抬头。列表只需要这些，不需要把转录整篇读出来。 */
export interface ChatSession {
  readonly id: string
  /** 目标地址。 */
  readonly target: string
  readonly node: string
  readonly agent: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly turnCount: number
  /** 最后一轮的原文，视图自己截断。 */
  readonly preview: string
}

export interface ChatTranscript {
  readonly session: ChatSession
  readonly turns: readonly ChatTurn[]
}

export interface ChatSendInput {
  readonly sessionId: string
  readonly text: string
  /** 这句是哪条本地命令；路由层认出来、查过角色之后才给。 */
  readonly command?: ChatLocalCommand
}

/**
 * 「这条会话有新东西了」。
 *
 * **故意不带内容**：订阅者拿到它以后回头去取服务端渲染好的片段，于是「服务端
 * 渲染 HTML、客户端只写 textContent」这条规矩在流式面上也成立（`assets/client.ts`
 * 的模块注释）。带内容的推送等于开一条新的、没人守着的注入面。
 */
export interface ChatUpdate {
  readonly sessionId: string
  /** 单调递增，客户端据此判断自己有没有漏掉一次。 */
  readonly revision: number
}

/**
 * 可选：没有配置聊天通道时整个聊天面消失（不是灰掉）。
 *
 * 和唤醒面不同的取舍：唤醒是主页上的一块，藏起来会让人以为面板坏了，所以渲染成
 * 禁用并说明原因；聊天是**另一个页面**，一个打开就说「这里什么都没有」的页面
 * 不如不给入口。stdout 的 `chat` 那一行会说明是哪种情况。
 */
export interface ChatPort {
  /** 能聊的对象。注册中心挂了就是一个失败值，不抛。 */
  targets(): Promise<ConsoleResult<readonly ChatTarget[]>>
  sessions(): Promise<ConsoleResult<readonly ChatSession[]>>
  /** 开一条新会话。同一个目标可以有多条——它们是不同的话题，不是重复。 */
  open(target: string): Promise<ConsoleResult<ChatSession>>
  transcript(sessionId: string): Promise<ConsoleResult<ChatTranscript>>
  /**
   * 发一句话。
   *
   * 返回的是**操作者那一轮**，不是 agent 的回复：回复要等一个真的模型轮次跑完，
   * 而这是在一个 HTTP 请求里。回复通过 {@link ChatPort.subscribe} 到达。
   */
  send(input: ChatSendInput): Promise<ConsoleResult<ChatTurn>>
  /** 订阅新消息，返回退订函数。 */
  subscribe(listener: (update: ChatUpdate) => void): () => void
}

// ---------------------------------------------------------------------------
// CertificatePort —— 证书栏（key-distribution.md §10.1，P12.4）
// ---------------------------------------------------------------------------

/**
 * 一个节点证书的处置。§10.1 的六个取值，其中 `expiring(<n>d)` 按 §6.2 的两道
 * 门限拆成两个：`expiring`（< 21 天，黄）与 `expiring-urgent`（< 7 天，红）。
 *
 * **不能折成「好/坏」两档**：`absent`（还没发布）与 `bad-signature`（发布了但
 * 不是本 CA 签的）指向完全相反的下一步动作——前者是「这个节点还没走过签发
 * 流程」，后者是「有人往零鉴权的注册中心里塞了东西」（§5.2 T-B）。同理
 * `expired` 与 `revoked`：一个是运维忘了续签，一个是这把钥匙被主动作废了。
 * `expiring-urgent` 与 `expired` 也是两件事：前者还来得及，后者这个节点已经被
 * 对端拒绝。
 */
export type CertificateStatus =
  | 'valid'
  | 'expiring'
  | 'expiring-urgent'
  | 'expired'
  | 'revoked'
  | 'absent'
  | 'bad-signature'

/**
 * 一个节点的证书，**全是公开材料**。
 *
 * 没有任何私钥字段，也不可能有：§10.3 那条硬规矩说控制台进程不得读 CA 私钥、
 * 节点身份私钥、节点 TLS 私钥，本接口是那条规矩在类型上的形状。指纹是核对用的
 * 同一种量具（运维核对 CA 根时用的就是 `fingerprint256`），所以它可以整串给出
 * 而不像公钥那样只给哈希前缀。
 */
export interface ConsoleCertificate {
  /** 节点段，不是地址——一个节点一张证书，与它有几个 agent 无关。 */
  readonly node: string
  readonly status: CertificateStatus
  /** 证书指纹；`absent` 时没有。 */
  readonly fingerprint256?: string
  /** `notAfter`，epoch 毫秒。 */
  readonly notAfter?: number
}

/**
 * 吊销清单的抬头。**不含 `revoked` 明细**：页面要回答的是「RL 什么时候过期」，
 * 而逐条吊销记录属于运维手上的那份 runbook，不属于一个零鉴权网络里人人能开的
 * 页面。
 */
export interface ConsoleRevocationList {
  readonly issuedAt: number
  readonly nextUpdate: number
  readonly revokedCount: number
}

export interface CertificateSnapshot {
  readonly certificates: readonly ConsoleCertificate[]
  /**
   * `null` = 一份都没发布过。
   *
   * 与「发布过但过期了」**必须分开**：§6.4 的两行给它们的是同一个 fail-closed
   * 行为但完全不同的成因，而页面是运维唯一能看出是哪一种的地方。
   */
  readonly revocationList: ConsoleRevocationList | null
}

/**
 * `--trust-ca` 文件里的一张 CA 根，§6.2 表里「CA 根」那一行的提醒。
 *
 * 到期分档与节点证书**同一组**（`valid` / `expiring` / `expiring-urgent` /
 * `expired`，门限也是同两道）：根过期时它签的每张证书在 TLS 层和证书目录里一并
 * 失效，这件事对运维的紧迫程度不低于任何一张叶证书。`subject` 足以区分两张根：
 * 信任文件拒绝两张同名的根。
 */
export interface ConsoleCaRoot {
  readonly subject: string
  /** 根自己的 `notAfter`，epoch 毫秒。 */
  readonly notAfter: number
  readonly status: Extract<
    CertificateStatus,
    'valid' | 'expiring' | 'expiring-urgent' | 'expired'
  >
}

/**
 * 可选：没有配 CA 根就整条证书栏不出现（不是显示一排「未知」）。
 *
 * 与唤醒面的取舍不同：唤醒是主页上的一块功能，藏起来会让人以为面板坏了；证书栏
 * 是一列**事实**，一列全是「未知」的事实不是降级，是噪声——而且它会让「这个部署
 * 还没上证书」和「证书全坏了」在页面上长得一样。
 */
export interface CertificatePort {
  read(): Promise<ConsoleResult<CertificateSnapshot>>
  /**
   * 信任文件里的根，按文件顺序，每张一条。
   *
   * 与 `read()` 分开、同步返回：根是本机启动时读进来的文件，不经注册中心。放进
   * `read()` 的快照里，注册中心一不可达，根的到期提示就跟着从页面上消失。
   */
  roots(): readonly ConsoleCaRoot[]
}

// ---------------------------------------------------------------------------
// 服务器归属与备注 —— 「这个智能体跑在哪台机器上」
// ---------------------------------------------------------------------------

/**
 * 一个节点跑在哪台服务器上，**启动时钉死的一条事实**。
 *
 * 为什么不从端点推：名册上的端点是宿主机这一侧的隧道本地口
 * （`ws://127.0.0.1:38631` 这种），四个节点落在四台机器上时它们长得一模一样，
 * 只差一个端口号。端点回答的是「这个控制台怎么拨到它」，不是「它在哪」——后者
 * 只有起控制台的那个人知道，所以它从启动参数来。
 *
 * `server` 是运维自己的叫法（`p11`、一个 IPv4 字面量、一个机房名），不是协议
 * 地址段：它要能带点号，所以它**不**走 `isValidSegment`。形状由 host 侧的
 * `consoleArgs.ts` 把关，这个包只当它是一串要转义后才能进 HTML 的字符。
 */
export interface NodeServer {
  /** 协议节点段，与名册里 `qianmo://<node>/<agent>` 的 node 同一个词。 */
  readonly node: string
  /** 那台机器的名字，运维自己起的。 */
  readonly server: string
}

/** 一台服务器的一段备注，连同它最后一次被改的时刻。 */
export interface ServerNote {
  readonly server: string
  /** 操作者写的自由文本，可以带换行；空串就是「没有备注」。 */
  readonly note: string
  /** epoch 毫秒。 */
  readonly updatedAt: number
}

/**
 * 备注的落盘面。**这个包不碰文件系统**，所以它只是一对方法。
 *
 * host 侧（`src/cli/handlers/consoleServerNotes.ts`）把它接到一个
 * append-only NDJSON 文件上，位置从 `occConfigPath()` 派生。这条边界和
 * {@link ChatPort} 是同一条：这里不知道有磁盘，用例因此是一个普通对象。
 *
 * 可选：缺了备注框渲染成只读并说明原因，而不是给一个按下去必定失败的按钮——
 * 与唤醒面同一个取舍。
 *
 * **`set` 不负责判「这台服务器存不存在」**：那是白名单的事，由 HTTP 层拿
 * {@link ConsoleDeps.nodeServers} 判定后才会走到这里。端口只管写。
 */
export interface ServerNotesPort {
  list(): Promise<ConsoleResult<readonly ServerNote[]>>
  set(server: string, note: string): Promise<ConsoleResult<ServerNote>>
}

// ---------------------------------------------------------------------------
// NotifyPort —— 告警收件箱（J5，P18.15）
// ---------------------------------------------------------------------------

/**
 * 告警的三档，与协议 `notify.severity` 同名同序（`@qianmo/protocol` 的
 * `NOTIFY_SEVERITIES`，protocol §14.2）。
 *
 * 不另起一套词：agent 自己发的通知带的就是这三个值，控制台从注册中心、证书、
 * 审计链推出来的「状况」也落在这三档里，筛选因此只有一把尺子。
 */
export type AlertLevel = 'info' | 'warn' | 'error'

/**
 * 一条到了中枢的通知：值守作业里 agent 自己调 `qianmo_notify` 发出、由
 * `qm watch` 收到并记进中枢审计链的那一条（`console.md` §10.1.3）。
 *
 * **只有给人的通知**：节点自动推的过程行（`watch_step_received`）不在这里，
 * 那是过程数据，不打扰人。正文（`detail`）也不在这里——`qm watch` 只把它打到
 * stdout，审计链里没有，所以这里没有来源。
 */
export interface ConsoleNotice {
  /**
   * 同一条通知每次读出来都是同一个 id，换一条通知就换一个 id。确认按它记。
   * 生产实现取通知消息自己的 `msgId`：链被重置后序号会从 1 重新数，序号做 id
   * 会让旧的确认落到新的通知上。
   */
  readonly id: string
  /** 中枢收到它的时刻（审计记录的 `at`），epoch 毫秒。不是节点观测到的时刻。 */
  readonly at: number
  readonly level: AlertLevel
  /** 协议 `notify.kind`：`watch` / `task` / `health`。 */
  readonly kind: string
  /** 发出它的节点地址（审计记录的 `peer`）。 */
  readonly from?: string
  /** 值守作业 id：通知的 `contextId`，值守作业里就是作业 id（§4.1③）。 */
  readonly job?: string
  readonly summary: string
  /** 对端重发的那一条（协议 §14.4 要求重发看得见）。 */
  readonly redelivered?: true
}

/** 一次读到的通知，新的在前。 */
export interface NoticeFeed {
  readonly notices: readonly ConsoleNotice[]
  /** 截断之前一共有几条，页面据此说「最近 N 条 · 共 M 条」。 */
  readonly total: number
  /**
   * 通知所在的那条审计链验不验得过。验不过时通知照样列出来，页面另起一条说明
   * ——链断了不等于通知是假的，但读的人应该知道。
   */
  readonly intact: boolean
  /**
   * 那条链的文件在不在。`qm watch` 一启动就建好它（`openAuditTrail`），所以
   * 不在就是值守进程从没在这个配置根上跑过——和「跑过、没人发通知」是两件事，
   * 两者都是零条，只有这一格能分开。
   */
  readonly present: boolean
}

/** 一次确认：哪条告警、什么时候、谁。 */
export interface AlertAck {
  readonly id: string
  /** epoch 毫秒。 */
  readonly at: number
  /**
   * 主体，与动作账本同一种写法（`u:…` / `legacy:admin`）。只落盘，不上页面：
   * 「谁动过什么」的页面是操作记录（H4），只读角色看不到它。
   */
  readonly by: string
}

/**
 * 告警的两件事：通知从哪来，确认记在哪。
 *
 * 可选：缺席时告警页仍然列出控制台自己推得出来的状况（节点失联、证书、审计链），
 * 通知那一栏写「未接入」，确认按钮不出现——没有地方记的确认按下去只会丢。
 *
 * 与其余端口同一条规矩：过得去的失败不抛，落成 `{ ok: false }`。
 */
export interface NotifyPort {
  /** 最近 `limit` 条给人的通知，新的在前。 */
  notices(limit: number): Promise<ConsoleResult<NoticeFeed>>
  /** 记过的全部确认。告警页拿它判「未确认」，所以它就是未读角标的来源。 */
  acks(): Promise<ConsoleResult<readonly AlertAck[]>>
  /**
   * 记一次确认。**幂等**：已经确认过的 id 原样返回第一次那条，不重写——
   * 两个人同时点同一条，留下的是先到的那一次。
   *
   * **不判 id 存不存在**：那是路由层的事，它拿当前告警集合查过才会走到这里
   * （与服务器备注的白名单同一条纪律）。
   */
  ack(id: string, by: string): Promise<ConsoleResult<AlertAck>>
}

// ---------------------------------------------------------------------------
// SchedulerPort —— 值守作业（J6，P18.15）
// ---------------------------------------------------------------------------

/**
 * 调度器最后一次运行（`SchedulerRunner.status().lastTickAt`）。
 *
 * **三态，缺一不可**（`console.md` §10.3「缺席可见」）：
 *
 * - `seen`：读到了，`at` 是那一刻，`everyMs` 是调度器自报的两轮之间最长的间隔
 *   （`qm watch` 写进 `status.json` 的 `tickMs`）。超过两个间隔没有新的一轮，
 *   页面就说它可能已停止——这把尺子来自调度器自己，控制台不另定一个数；
 * - `never`：调度器在，但一次都没跑过；
 * - `unwired`：这个端口拿不到它，`reason` 说为什么。生产实现在
 *   `qm watch` 没有写出 `status.json`（没在这个配置根上跑过，或版本早于它）、
 *   或那份文件读不出来时就是这一态。
 *
 * 一个没在跑的调度器和一个没事可做的调度器看起来一模一样，只有这个时间戳能
 * 把两者分开；所以拿不到它这件事本身必须写在页面上，不能渲染成一格空白。
 */
export type SchedulerTick =
  | {
      readonly state: 'seen'
      readonly at: number
      readonly everyMs: number
    }
  | { readonly state: 'never' }
  | { readonly state: 'unwired'; readonly reason: string }

/**
 * 急停哨兵（`<config>/qianmo/scheduler/ESTOP`）的状态。
 *
 * `unknown` 与 `released` 必须分开：`stat` 本身失败时调度器按「未拉下」处理
 * （可靠性件套 fail-open，`@qianmo/resident` 的 `ResidentEstop`），页面要说出
 * 「读不出来、调度器照常触发」，而不是说「未拉下」。
 */
export type SchedulerEstop =
  | { readonly state: 'released' }
  | {
      readonly state: 'engaged'
      /** 拉下的时刻（文件 mtime），尽力而为，只用于显示。 */
      readonly since?: number
    }
  | { readonly state: 'unknown'; readonly reason: string }

/** 一次触发怎么结束的，与 `@qianmo/scheduler` 的 `FireOutcome` 同一组值。 */
export type WatchFireOutcome = 'completed' | 'failed' | 'skipped' | 'preempted'

/**
 * 一个值守作业此刻的样子。
 *
 * 定义里的字段（标题、目标、周期、通知策略）**都可选**：作业定义在
 * `qm watch` 的内存里，经它写出的 `status.json` 才到得了控制台。读不到那份文件
 * 时只能从调度状态与审计链里看到作业 id、上次触发和最近结果。缺席的字段页面写
 * 「未接入」，不猜。
 */
export interface WatchJobStatus {
  readonly id: string
  readonly title?: string
  /** `qianmo://<node>/<agent>`。没有定义时取最近一次派发记录的目标。 */
  readonly target?: string
  /** 周期，毫秒。只有作业定义有。 */
  readonly everyMs?: number
  readonly notifyPolicy?: string
  /**
   * 调度器正在调度它。`false` 是「调度状态里还有记录、正在跑的 `qm watch` 已经
   * 没有这个作业」，所以它不会再触发。作业定义未接入时恒为 `false`，页面按
   * {@link SchedulerSnapshot.definitions} 区分两种情形。
   */
  readonly listed: boolean
  /**
   * 上次触发：已退休的**排定**时刻与结局（`state.json` 的 `lastFiredAt` 与
   * `lastOutcome`），不是 turn 跑完的墙上时间（scheduler README §4）。
   * `recordedAt` 是这条结局落账的墙上时间。
   */
  readonly last?: {
    readonly at: number
    readonly outcome: WatchFireOutcome
    readonly recordedAt?: number
  }
  readonly consecutiveFailures: number
  /**
   * 调度器下一次要处理它的时刻：`planFire` 的排定时刻，退避中则是退避结束的
   * 时刻——取自调度器写出的 `status.json`，不是控制台另算的。小于等于当前时刻
   * 就是「已到期」：调度器在跑的话这一刻就该触发。没有作业定义时缺席。
   */
  readonly next?: number
  /** 失败退避：这一刻之前不会触发。 */
  readonly holdUntil?: number
  /**
   * 最近一次作业结果（节点回的 `task.result` 或 `error`），取自中枢审计链的
   * `watch_result_received`。与 {@link last} 是两件事：`last` 说派发有没有拿到
   * 回执，这里说节点上那一轮跑完是什么结果。
   */
  readonly result?: {
    readonly at: number
    /** `completed` / `failed` / `error`。 */
    readonly result: string
    readonly code?: string
  }
}

export interface SchedulerSnapshot {
  readonly tick: SchedulerTick
  readonly estop: SchedulerEstop
  /** 作业定义有没有来源；没有时「周期」「下次触发」两列整列未接入。 */
  readonly definitions:
    | {
        readonly state: 'wired'
        /** 定义从哪来，显示用（`status.json` 的路径）。 */
        readonly source: string
      }
    | { readonly state: 'unwired'; readonly reason: string }
  readonly jobs: readonly WatchJobStatus[]
}

/**
 * 值守作业的只读面。
 *
 * 可选：缺席时作业页整页写「未接入」并说明原因。**没有写方法**：急停的拉下与
 * 松开今天仍是 `touch` / `rm` 那个文件（`console.md` §10.2），控制台只看。
 */
export interface SchedulerPort {
  read(): Promise<ConsoleResult<SchedulerSnapshot>>
}

// ---------------------------------------------------------------------------
// LedgerPort —— 账号库与会话表的落盘面（P15.3 / P15.5）
// ---------------------------------------------------------------------------

/**
 * 一本哈希链账的文件面：整篇读出来，或在末尾追加一行。
 *
 * **只搬字节，不判内容**：解析、验链、语义校验全在包内（`ledger.ts`、
 * `accounts.ts`），那样 fail-closed 的每一条规矩都能用一个普通对象测到。host
 * 侧（`src/cli/handlers/consoleAccountsStore.ts`）只负责 0600、O_APPEND、
 * 每行 fsync，路径从 `occConfigPath()` 派生。
 *
 * 与其余端口不同，这两个方法**允许抛**：它们失败只可能是 I/O 坏了，而账本对
 * 任何一次抛出的处置都是同一个——整本转为不可用并告警（`AccountBook`）。
 * 同步也是有意的：「查这枚邀请还没用过」与「写下它已用掉」必须在同一拍里完成，
 * 中间一个 `await` 就是两次并发兑换同一枚邀请的窗口。
 */
export interface LedgerPort {
  /** 文件位置，只用于横幅与告警，不是秘密。 */
  readonly path: string
  /** 整篇内容；文件不存在时 `null`。 */
  read(): string | null
  /** 追加一行（已带换行）并落盘。 */
  append(line: string): void
}

// ---------------------------------------------------------------------------
// ActionLedgerPort —— 控制台动作账本（P15.9 实现；P18.4 定接口与调用点）
// ---------------------------------------------------------------------------

/**
 * 一次动作的结果。
 *
 * - `ok`：做成了。
 * - `refused`：过了角色门，但被这次请求本身挡下——输入不合法、目标不在启动时
 *   的白名单里、账本不收（{@link ActionLedgerPort.admit}）。
 * - `failed`：交给端口了，端口失败（注册中心不可达、对端拒收……）。
 *
 * 角色门本身的 401 / 403 **不记**：那是凭据不够，不是一次动作；记下来只会让
 * 一个拿着只读令牌乱点的人把账本刷满（`console.md` 的守门顺序见 `routes/shared.ts`）。
 */
export type ActionOutcome = 'ok' | 'refused' | 'failed'

/**
 * 账本里的一条：谁、在哪次请求里、对什么、做了什么、结果如何。
 *
 * **从不记载荷**：唤醒的提示词、对话的正文、备注的内容、公钥都不进账——账本
 * 回答「谁动过什么」，不是第二份数据副本（`console.md` §7.2 的「控制台不碰
 * 载荷」）。`target` 是被动对象的标识（地址、服务器名、会话 id），不是内容。
 */
export interface ConsoleAction {
  /** 毫秒时间戳，取自 `deps.now`。 */
  readonly at: number
  /** 这次 HTTP 请求的 id，控制台为每个请求生成；同一请求的多条记录共用一个。 */
  readonly requestId: string
  /**
   * 主体：个人账号的 `u:…`，或 `legacy:admin` / `legacy:view`；没有任何凭据时
   * 为 `anonymous`（只会出现在 break-glass 之外的公开路由上，今天没有）。
   */
  readonly subject: string
  /** admin 令牌以 break-glass 方式使用时为 `true`（`tenancy-m1.md` §3.4）。 */
  readonly breakGlass?: true
  /**
   * 点分动词，见 {@link CONSOLE_ACTIONS}。前缀可筛：`agent.`、`chat.`。
   */
  readonly action: string
  /** 被动对象：地址、服务器名、会话 id、`方法 路径`。 */
  readonly target: string
  readonly outcome: ActionOutcome
  /** 结果不是 `ok` 时的错误码（`ConsoleFailure['code']` 或 HTTP 侧的码）。 */
  readonly code?: string
}

/**
 * 控制台今天会写的动作名。P15.9 与之后的页面包增加动作时在这里补一行，
 * 让「账本里会出现哪些动作」有一个可以 grep 的地方。
 */
export const CONSOLE_ACTIONS = [
  'agent.register',
  'agent.deregister',
  'agent.heartbeat',
  /** 生命周期（P15.2），target 是地址；注册（发布）仍记 `agent.register`。 */
  'agent.pause',
  'agent.resume',
  'agent.retire',
  'wake.send',
  'server.note.set',
  'chat.session.open',
  'chat.message.send',
  /** 本地命令（P18.20）：取代那一句的 `chat.message.send`，target 是会话 id。 */
  'chat.command.autocompact',
  'chat.command.compact',
  'chat.command.context',
  /** 明确打开一份转录：整页带 `?session=`、JSON 读转录、片段带 `?open=1`。轮询与 SSE 不算。 */
  'chat.transcript.open',
  /** 账号 API 的写请求，`accounts.<方法>`，target 是 `/v0/accounts` 之后的路径。 */
  'accounts.post',
  'accounts.put',
  'accounts.patch',
  'accounts.delete',
  /** break-glass 下的每一个请求（P15.9 DoD），target 是 `方法 路径`。 */
  'breakglass.request',
  /** 确认一条告警（J5），target 是告警 id。 */
  'alert.ack',
  /** 登记一次本地—云端接力（P17.4），target 是任务 id；没登上时是项目名。 */
  'handoff.accept',
  /** 给接力任务追加一句话（P17.4 只记账），target 是任务 id。 */
  'handoff.send',
  /** 要一个运行中任务的接入定位（P17.6，`qm handoff attach`），target 是任务 id。 */
  'handoff.attach',
  /** 记下任务已接回本机（P17.6，`qm handoff pull`），target 是任务 id。 */
  'handoff.return',
  // 模型服务（P18.6，`ProviderPort` 自己记，见 {@link ProviderCaller}）。target 一律是
  // 档案 id 或节点名，从不是密钥、地址或带凭据的 URL。
  'provider.save',
  'provider.delete',
  'provider.secret.set',
  'provider.secret.clear',
  'provider.default.set',
  'provider.assign',
  'provider.context.set',
  'provider.context.clear',
  /** 一个节点一条，结果是节点回报的（ok / refused：conflict、busy… / failed：unreachable…）。 */
  'provider.apply',
  /** 带 `force` 的下发：ops 确认了「覆盖节点上的改动」。 */
  'provider.apply.force',
  'provider.probe.auth',
  'provider.probe.latency',
  /** 真实调用一次模型，会产生一次计费调用。 */
  'provider.probe.call',
  /**
   * 「保存并切换」时 ops 勾了「跳过测连」（§6.3.2 第 7 条），target 是档案 id。端口没有
   * 这一步，由模型服务页的路由在切换执行前记，记不进去就不切换。
   */
  'provider.probe.skip',
  'provider.autocompact',
  'provider.import',
] as const

/** 账本里的一条，带上账本给它的序号（递增，从 1 开始）。 */
export interface ActionRecord extends ConsoleAction {
  readonly seq: number
}

/** 查询条件。全部可选；缺省为「最新的一页」。 */
export interface ActionQuery {
  /** 只要这个主体做的。 */
  readonly subject?: string
  /**
   * 只要作用于这些对象的——「我的转录被谁读过」就是把自己的会话 id 放进来、
   * 再配 `actionPrefix: 'chat.transcript.'`。
   */
  readonly targets?: readonly string[]
  /** 动作名前缀，例如 `chat.`。 */
  readonly actionPrefix?: string
  /** 游标：只要序号小于它的（更早的）。 */
  readonly beforeSeq?: number
  /** 每页条数；实现自定上限。 */
  readonly limit?: number
}

/** 一页记录，新的在前。 */
export interface ActionPage {
  readonly entries: readonly ActionRecord[]
  /** 下一页（更早）的 `beforeSeq`；没有更早的时为 `null`。 */
  readonly nextBeforeSeq: number | null
}

/**
 * 控制台动作账本：P15.9 用 `@qianmo/audit` 的哈希链实现（`tenancy-m1.md` §6），
 * 页面（H4「操作记录」）在 P18.10。
 *
 * 控制台对它的用法只有三处，全部在路由层（`routes/*.ts` 经 `RouteContext`）：
 *
 * 1. 写动作执行**之前**调 {@link admit}：账本写不进去（链断、盘满、文件被改）时
 *    这次写被拒（503），不会出现「做了但没记」。
 * 2. 写动作执行**之后**调 {@link record}，带上结果。这一步失败不回滚已经做成的
 *    动作——那正是 `admit` 存在的原因；实现应让 `admit` 通过即意味着随后一次
 *    `record` 能落盘。
 * 3. 读：{@link list}，供 H4 页面与「我的转录被谁读过」。
 *
 * 缺席（`ConsoleDeps.actions` 未接）时控制台照旧工作、什么都不记——今天的
 * 部署就是这样，legacyParity 的金样也是在缺席时取的。
 */
export interface ActionLedgerPort {
  /** 写动作之前问一次：现在能记账吗。缺省视为能。 */
  admit?(): Promise<ConsoleResult<void>>
  record(entry: ConsoleAction): Promise<ConsoleResult<void>>
  list(query: ActionQuery): Promise<ConsoleResult<ActionPage>>
}

// ---------------------------------------------------------------------------
// HandoffPort —— 本地—云端接力的中枢台账（P17.4）
// ---------------------------------------------------------------------------

/**
 * 接力任务的状态，与 `@qianmo/handoff` 的 `HANDOFF_STATES` 同一组词。
 *
 * 这里按形状重新声明而不是 import：控制台是只依赖 `@qianmo/audit` 的叶子包
 * （`test/dependencies.test.ts` 钉着），而 `@qianmo/handoff` 会带进
 * tool-runtime 的扫描器。宿主（`src/cli/handlers/consoleHandoff.ts`）把那个包
 * 的 `HandoffTask` 原样交过来，结构一致即可赋值，类型检查就是两边对得上的证据。
 */
export type HandoffTaskState =
  | 'accepted'
  | 'dispatched'
  | 'running'
  | 'done'
  | 'failed'
  | 'returned'

/** 接力清单：只有引用，没有代码与会话正文（`handoff-p17-plan.md` §1）。 */
export interface HandoffManifestView {
  readonly kind: 'handoff'
  readonly project: string
  readonly device: string
  readonly branch: string
  readonly wip: string
  readonly tree: string
  readonly tool: 'qmcode' | 'claude-code'
  readonly sessionId: string
  readonly sessionRef: string
  readonly sessionCommit: string
  readonly cwd: string
  readonly brief: {
    readonly goal: string
    readonly done: string
    readonly remaining: string
  }
  readonly deadline: string
}

/** 云端回合的结果（`task.result.content` 解出来的那份）。 */
export interface HandoffResultView {
  readonly status: 'completed' | 'interrupted' | 'failed'
  readonly branch: string
  readonly head: string
  readonly threadId: string
  readonly summary: string
}

/** 台账里的一个任务。 */
export interface HandoffTaskView {
  readonly taskId: string
  readonly state: HandoffTaskState
  readonly manifest: HandoffManifestView
  /** 派发以后才有。 */
  readonly node: string | null
  readonly result: HandoffResultView | null
  readonly reason: string | null
  /** epoch 毫秒。 */
  readonly acceptedAt: number
  readonly updatedAt: number
}

/** 记下的一句给云端的话。 */
export interface HandoffSendView {
  readonly taskId: string
  /** 每个任务从 1 起。 */
  readonly seq: number
  readonly at: number
  readonly text: string
}

/**
 * 接入一个运行中任务的定位（P17.6）：在哪个节点、哪个线程。**只有定位**——
 * 节点 app-server 的令牌由用户本人经 SSH 从节点读，从不经过中枢（计划 D-6）。
 */
export interface HandoffAttachView {
  readonly taskId: string
  readonly state: HandoffTaskState
  readonly node: string
  /**
   * 云端线程号。qmcode 会话就是清单里的 `sessionId`（节点按它续接）；Claude Code
   * 会话在节点上导入成新线程，结果回来之前中枢不知道，这时为 null，由本机经隧道
   * 向节点 app-server 查。
   */
  readonly threadId: string | null
  readonly project: string
  readonly tool: HandoffManifestView['tool']
}

/** 谁在要定位：只进审计。 */
export interface HandoffAttachRequest {
  /** 发起机器的设备名；没给为 null。 */
  readonly device: string | null
}

/** 接回本机的方式：快进当前分支，或另开 `qianmo/<任务>-return`。 */
export type HandoffReturnMode = 'fast-forward' | 'branch'

export interface HandoffReturnRequest {
  readonly device: string | null
  readonly mode: HandoffReturnMode | null
}

export interface HandoffReturnView {
  readonly task: HandoffTaskView
  /** false = 任务本来就是 returned（重跑接回），台账没有多写一行。 */
  readonly changed: boolean
}

/** 登记的结果：新任务，或同一份清单已经登记过的那个任务。 */
export interface HandoffAcceptance {
  readonly task: HandoffTaskView
  /** false = 逐字段相同的清单已在台账里且仍是 accepted：同一次请求的重试，不另起任务。 */
  readonly created: boolean
}

/**
 * 中枢的接力台账（`handoff-p17-plan.md` P17.4「中枢」表）。
 *
 * **「可以关机」的依据就在 {@link accept} 里**：它返回成功之前，宿主已经在
 * 中枢裸仓里确认影子提交与会话提交都在、影子提交的树就是清单里的树，并把
 * `accepted` 写进台账、fsync 过。本地的 `qm handoff now` 只有拿到成功才告诉人
 * 可以关机，所以这个端口不能有「先回成功、后核对」的实现。
 *
 * 失败的码：清单不合法 `invalid`；裸仓里缺对象、树对不上、项目没有裸仓
 * `rejected`（数据没落地，这正是「不能关机」的那种回答）；任务不存在
 * `not_found`；台账读写坏了 `unreachable`。
 *
 * 可选：缺席时 `/v0/handoff` 回 501，与其余可选面同一条规矩。
 */
export interface HandoffPort {
  /** `body` 是请求体解出来的 JSON，校验在宿主做。 */
  accept(body: unknown): Promise<ConsoleResult<HandoffAcceptance>>
  /** 全部任务，按登记先后。 */
  list(): Promise<ConsoleResult<readonly HandoffTaskView[]>>
  get(taskId: string): Promise<ConsoleResult<HandoffTaskView>>
  /**
   * 记下一句给云端的话；配了 `--handoff-node` 的中枢在任务 running 后把它转给
   * 节点（P17.5）。任务已结束（done / failed / returned）时 `rejected`。
   */
  send(taskId: string, text: string): Promise<ConsoleResult<HandoffSendView>>
  /**
   * 运行中任务的接入定位（P17.6），并记审计 `handoff.attach-requested`。只给
   * running 的任务；其余状态 `rejected`，文案说现在是什么状态、该用什么命令。
   */
  attach(
    taskId: string,
    request: HandoffAttachRequest,
  ): Promise<ConsoleResult<HandoffAttachView>>
  /**
   * 任务已接回本机（P17.6）：done / failed → returned，记审计 `handoff.returned`。
   * 已是 returned 时成功、`changed: false`（重跑接回）；其余状态 `rejected`。
   */
  markReturned(
    taskId: string,
    request: HandoffReturnRequest,
  ): Promise<ConsoleResult<HandoffReturnView>>
}

// ---------------------------------------------------------------------------
// ProviderPort —— 模型服务（P18.6 实现；P18.9 页面）
// ---------------------------------------------------------------------------
//
// 设计：`docs/dev/providers-console-m1.md` v1.2 §2–§3、§6.3、§7。
//
// 下面的类型是 `@qianmo/providers` 那几个类型的**镜像**：控制台包只许依赖
// `@qianmo/audit`（`test/dependencies.test.ts`），所以这里不 import 目录包。宿主实现
// （`src/cli/handlers/consoleProviders.ts`）把目录包的值直接赋给这些类型，两边一旦
// 漂移，tsc 在宿主那一侧报错。厂商清单仍然只有一份：页面要的预设经
// {@link ProviderPort.catalog} 从目录包来，控制台不留自己的。
//
// **任何方法都不返回密钥的值或片段**：只有「已设置 / 未设置」、设置时间与指纹
// （指纹只给 ops 看，由页面按角色决定画不画）。

type ProviderLane =
  | 'anthropic'
  | 'openai-chat'
  | 'openai-responses'
  | 'gemini'
  | 'grok'
type ProviderPlan = 'paygo' | 'plan' | 'local' | 'custom'
export type ProviderEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type ProviderModelTier = 'opus' | 'sonnet' | 'haiku' | 'fable'

/** §3.2 的一个模型。 */
interface ProviderModelView {
  readonly id: string
  readonly role: 'main' | 'fast' | 'extra'
  readonly tiers: readonly ProviderModelTier[]
  readonly capabilities:
    | { readonly mode: 'family' }
    | {
        readonly mode: 'explicit'
        readonly thinking: boolean
        readonly adaptive_thinking: boolean
        readonly interleaved_thinking: boolean
      }
  readonly effort: {
    readonly send: 'always' | 'never' | 'auto'
    readonly level?: ProviderEffortLevel
    readonly levels?: readonly ProviderEffortLevel[]
  }
  /** 缺省按 200 000 编译（D-8）；节点指派的覆盖优先。 */
  readonly contextTokens?: number
  readonly maxOutputTokens?: number
  readonly retireAt?: string
}

/** 档案持有的一把密钥：只有标识与对账材料。`fingerprint` 在就是「已设置」。 */
interface ProviderKeyView {
  readonly id: string
  readonly label?: string
  readonly priority?: number
  readonly fingerprint?: string
  readonly setAt?: string
}

interface ProviderTerms {
  readonly restricted: boolean
  readonly note: string
  readonly url: string
}

interface ProviderHttpProbe {
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly body?: Readonly<Record<string, unknown>>
  readonly free: boolean
}

type ProviderEvaluated =
  | false
  | { readonly at: string; readonly by: string; readonly evidence: string }

/** §3.1 一份档案，中枢存的样子（不含任何密钥值）。 */
export interface ProviderProfileView {
  readonly id: string
  readonly revision: number
  readonly name: string
  readonly presetId: string | null
  readonly plan: ProviderPlan
  readonly site: string | null
  readonly lane: ProviderLane
  readonly baseUrl: string
  readonly templateValues?: Readonly<Record<string, string>>
  readonly models: readonly ProviderModelView[]
  readonly compat?: Readonly<Partial<Record<string, string>>>
  readonly effortLock?: ProviderEffortLevel | null
  readonly keySelection?: 'fill_first' | 'round_robin' | 'least_used'
  readonly auth: { readonly scheme: 'bearer' | 'x-api-key' }
  readonly keys: readonly ProviderKeyView[]
  /** 预设带来的验 key 与拉模型请求说明（§5.5），节点用。 */
  readonly probe?: {
    readonly auth: ProviderHttpProbe | null
    readonly models: ProviderHttpProbe | null
  }
  readonly terms?: ProviderTerms
  readonly evaluated: ProviderEvaluated
}

/**
 * 页面交上来的档案：形状同 {@link ProviderProfileView}，由宿主用目录包的校验器
 * **严格**解析（不认识的字段一律拒收）。`revision` 与 `keys[].fingerprint/setAt`
 * 由中枢维护，交上来的值被忽略。
 */
export type ProviderProfileDraft = Readonly<Record<string, unknown>>

/** 目录里的一条预设（§4），去掉了只给节点用的探测说明。 */
export interface ProviderPresetView {
  readonly id: string
  readonly vendor: string
  readonly name: string
  readonly group: 'cn-paygo' | 'intl' | 'plan' | 'local' | 'custom'
  readonly plan: ProviderPlan
  readonly lane: ProviderLane
  readonly baseUrl: string
  readonly sites: readonly {
    readonly id: string
    readonly label: string
    readonly baseUrl: string
  }[]
  readonly templateVars: readonly {
    readonly name: string
    readonly label: string
  }[]
  readonly authScheme: 'bearer' | 'x-api-key'
  readonly models: readonly ProviderModelView[]
  readonly compat: Readonly<Partial<Record<string, string>>>
  /** 只做软提示（§4.1 第 4 条），从不据此拒收。 */
  readonly keyHint: {
    readonly prefixes: readonly string[]
    readonly pattern?: string
    readonly display: string
  } | null
  readonly placeholderKey?: string
  readonly terms: ProviderTerms | null
  readonly source: { readonly url: string; readonly verifiedAt: string }
  /** 一律 `false`：没有真 key 冒烟证据之前，页面写「未评估」。 */
  readonly evaluated: false
  readonly listed: boolean
  readonly unverified: readonly string[]
  readonly notes: readonly string[]
}

export interface ProviderCatalog {
  /** 分组的显示顺序（§6.3.2）。 */
  readonly groups: readonly ProviderPresetView['group'][]
  readonly presets: readonly ProviderPresetView[]
}

/**
 * 多 key 池里的一把（P18.18，镜像目录包的 `KeyStatus`）。`cooling` 到 `until`
 * 自己恢复；`dead`（凭据被吊销）要中枢给这个 id 下发新值才恢复。
 */
export interface ProviderNodeKey {
  readonly id: string
  readonly state: 'ok' | 'cooling' | 'dead'
  /** 只有 `cooling` 带：再试的时间（ISO）。 */
  readonly until?: string
  readonly reason?:
    | 'rate-limit'
    | 'usage-limit'
    | 'billing'
    | 'auth'
    | 'revoked'
}

/** 节点上一次 `status` 报回的实际状态（§2.4），中枢不推断。 */
export interface ProviderNodeActual {
  readonly managed: boolean
  readonly applied: {
    readonly profileId: string
    readonly revision: number
    readonly requestId: string
    readonly at: string
  } | null
  readonly onDiskHash: string
  readonly appliedHash: string | null
  readonly loadedHash: string | null
  readonly pending: {
    readonly requestId: string
    readonly since: string
    readonly waitingTurns: number | null
  } | null
  readonly resident: {
    readonly running: boolean
    readonly generation: number | null
    readonly inFlight: number | null
  } | null
  /** 只有键名。 */
  readonly inheritedProviderKeys: readonly string[]
  readonly capabilities: {
    readonly protocol: number
    readonly chatEffortHonorsOverride: boolean
    readonly replayFilter: boolean
    readonly multiKey: boolean
  }
  readonly lastResult: {
    readonly requestId: string
    readonly code: string
    readonly at: string
    readonly diffKeys: readonly string[]
  } | null
  /**
   * P18.18：节点在跑多 key 池时逐把报的状态，按节点的选取顺序。只有 key id，
   * 没有值也没有指纹；单 key 节点不报这一项。
   */
  readonly keys?: readonly ProviderNodeKey[]
  /**
   * 节点用真实门控函数算出来的生效值。页面上「线路 / 发不发 effort / 档位 / 上下文
   * / 自动压缩」只取这里，中枢自己不算（§3.4「显示 = 线上」）。节点没算出来时缺席。
   */
  readonly effective?: {
    readonly apiProvider: string
    readonly wire: string
    readonly model: string
    readonly wireModel: string
    readonly modelSettingsSlot: string | null
    readonly effortOnWire: boolean
    /** 五档之一，或 `none`（P18.8：线上显式关掉推理）。 */
    readonly effortLevel: string | null
    readonly contextTokens: number
    /** D-9，P18.7 起节点报回；更早的节点缺席。 */
    readonly autoCompactWindow?: number
    readonly autoCompactSource?: 'env' | 'settings' | 'auto'
  }
}

/** §2.4 的漂移类型，每类在页面上有说明与修复动作。 */
type ProviderDriftKind =
  | 'unmanaged'
  | 'out-of-sync'
  | 'pending'
  | 'local-edit'
  | 'not-loaded'
  | 'env-residue'
  | 'unreachable'
  | 'retiring-model'

export interface ProviderDrift {
  readonly kind: ProviderDriftKind
  /** 冷静的一句中文，不含任何值；`local-edit` 带被改动的键名在 {@link keys}。 */
  readonly message: string
  readonly keys?: readonly string[]
}

/** 一次下发或测连在中枢账本里的记录（§6.3.8「最近 10 次」）。 */
export interface ProviderActivity {
  readonly kind: 'apply' | 'probe'
  readonly at: number
  readonly requestId: string
  readonly profileId: string
  readonly outcome: ActionOutcome
  /** 不是 `ok` 时节点的错误码，或 `unreachable`。 */
  readonly code?: string
  /** probe 的模式；apply 是否带了 force。 */
  readonly mode?: 'auth' | 'latency' | 'call'
  readonly force?: boolean
}

/** 节点 → 档案的指派（§2.4）：跟随全局默认、指定一份、或明确不托管。 */
export type ProviderAssignment =
  | { readonly mode: 'inherit' }
  | { readonly mode: 'profile'; readonly profileId: string }
  | { readonly mode: 'unmanaged' }

export interface ProviderNodeView {
  readonly node: string
  /** 中枢怎么够到它：本机子进程，或 ssh 强制命令。 */
  readonly executor: 'local' | 'ssh'
  readonly assignment: ProviderAssignment
  /** D-8 的节点覆盖；`null` 是没有覆盖（用档案值，档案也没写就是 200 000）。 */
  readonly contextOverride: number | null
  /** 期望；`null` 是不托管。 */
  readonly expected: {
    readonly profileId: string
    readonly revision: number
    readonly contextOverride: number | null
  } | null
  /** 最近一次**成功**的 `status`；失败时保留上一次的，并在 {@link lastStatus} 标明过期。 */
  readonly actual: ProviderNodeActual | null
  readonly lastStatus: {
    readonly at: number
    readonly ok: boolean
    readonly message?: string
  } | null
  readonly drift: readonly ProviderDrift[]
  /** 新的在前，最多 10 条。 */
  readonly recent: readonly ProviderActivity[]
}

export interface ProviderProfileSummary {
  readonly profile: ProviderProfileView
  /** 每把密钥是否已设置；页面不显示任何片段。 */
  readonly secrets: readonly {
    readonly keyId: string
    readonly set: boolean
    readonly setAt?: string
  }[]
  /** 期望里用着它的节点（含跟随全局默认的）。 */
  readonly nodes: readonly string[]
  readonly isDefault: boolean
}

export interface ProviderOverview {
  /** 任何状态变化都加一；页面拿它判断要不要换掉某一块。 */
  readonly revision: number
  readonly defaultProfileId: string | null
  readonly profiles: readonly ProviderProfileSummary[]
  readonly nodes: readonly ProviderNodeView[]
}

/** 中枢一侧的编译预览（§3.3）：将要写进节点 `settings.json` 的键，没有密钥值。 */
export interface ProviderCompilePreview {
  readonly modelType: string
  /** `direct`，或 DeepSeek 经运行时镜像走官方 Anthropic 端点（§3.3）。 */
  readonly route: 'direct' | 'deepseek-mirror'
  readonly effectiveLane: ProviderLane
  /** 要写的 env 键与值；装密钥的那个键值为 `null`，名字另列在 {@link secretKeys}。 */
  readonly set: Readonly<Record<string, string | null>>
  readonly secretKeys: readonly string[]
  /** 先被置为删除的受管键（激活语义：全部受管键先删、再写）。 */
  readonly deleted: readonly string[]
  readonly modelSettings: Readonly<
    Record<
      string,
      { readonly effort?: ProviderEffortLevel; readonly contextTokens?: number }
    >
  >
  readonly warnings: readonly ProviderIssueView[]
}

/** 一条校验意见：`code` 给程序，`message` 是给人看的中文，`path` 指到字段。 */
export interface ProviderIssueView {
  readonly code: string
  readonly message: string
  readonly path: string
}

/** 一个节点上一次 `apply`（或 dry-run）的结果。 */
export interface ProviderApplyResult {
  readonly node: string
  readonly requestId: string
  readonly outcome: ActionOutcome
  /** 不是 `ok` 时：节点的错误码（`conflict`、`busy`…），或 `unreachable` 等中枢侧的码。 */
  readonly code?: string
  readonly message: string
  /** 节点只写了 pending，等 resident 在空闲时切换。 */
  readonly pending?: boolean
  /** 变化的受管键，只有键名（dry-run 与 `conflict` 时有）。 */
  readonly diffKeys?: readonly string[]
  readonly sessions?: 'keep' | 'reset'
  readonly profileId?: string
  readonly revision?: number
}

export interface ProviderProbeResult {
  readonly node: string
  readonly requestId: string
  /** §5.5 三态：`ok`；连上了但被拒（`reachable && !ok`）；没连上。 */
  readonly ok: boolean
  readonly reachable: boolean
  /** 节点写的中文原因，不转述厂商原文。 */
  readonly message: string
  readonly httpStatus?: number
  readonly vendorCode?: string
  /** `/v1` 纠正：页面直接改写表单里的地址并提示。 */
  readonly suggestion?: { readonly baseUrl: string }
  readonly latency?: {
    readonly medianMs: number
    readonly minMs: number
    readonly samples: number
  }
}

export interface ProviderAutocompactResult {
  readonly node: string
  /** 生效值：`min(上下文窗口, 设定值)`。 */
  readonly autoCompactWindow: number
  readonly configured: number
  readonly source: 'env' | 'settings' | 'auto'
  /** 节点 `/autocompact` 的回显（英文，基座原话）。 */
  readonly message?: string
}

export interface ProviderExport {
  readonly filename: string
  /** `{v:1, kind:'qianmo-providers', secrets:'not-included', profiles:[…]}`，不含密钥也不含指纹。 */
  readonly text: string
  readonly count: number
}

export interface ProviderImportPreview {
  readonly profiles: readonly ProviderProfileView[]
  /** 与现有档案撞 id 的；导入时只能另存为新 id（{@link ProviderImportInput.renames}）。 */
  readonly collisions: readonly string[]
  readonly warnings: readonly ProviderIssueView[]
}

export interface ProviderImportInput {
  readonly text: string
  /** 撞 id 的档案改成什么新 id。缺一个就整份拒绝，不覆盖。 */
  readonly renames?: Readonly<Record<string, string>>
}

/** 测连、测速、拉模型列表与 dry-run 用的档案：已存的一份，或表单上还没保存的一份。 */
export type ProviderCandidate =
  | { readonly profileId: string; readonly secret?: string }
  | { readonly draft: ProviderProfileDraft; readonly secret?: string }

type ProviderFailureCode =
  /** 输入不合法（形状、闭合键集外的键、值）。带 `path`。→ 400 */
  | 'invalid'
  /** 档案或节点不存在。→ 404 */
  | 'not_found'
  /** `If-Match` 修订号不符；带 `fields`（被改动的字段名）。→ 409 */
  | 'conflict'
  /** 还有节点在用这份档案（期望或实际）；带 `nodes`。→ 409 */
  | 'in_use'
  /** 调用者不是个人账号的 ops（或是 break-glass）。不记账。→ 403 */
  | 'rejected'
  /** 模型服务这一面停用：账本坏行、主密钥缺失或权限过宽。→ 503 */
  | 'unavailable'
  /** 节点够不着：ssh 失败、无响应、超时、强制命令缺失。→ 502 */
  | 'unreachable'
  /** 节点收到了并拒绝；带 `nodeCode`。→ 422 */
  | 'refused'

export interface ProviderFailure {
  readonly code: ProviderFailureCode
  /** 冷静的一句中文，不含任何密钥。 */
  readonly message: string
  readonly path?: string
  readonly fields?: readonly string[]
  readonly nodes?: readonly string[]
  readonly nodeCode?: string
}

export type ProviderResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ProviderFailure }

/**
 * 端口会写进动作账本的动词：{@link CONSOLE_ACTIONS} 里 `provider.` 开头的那些，去掉
 * `provider.probe.skip`——那一行由模型服务页的路由在切换前自己记，端口没有这一步。
 */
export type ProviderActionName = Exclude<
  Extract<(typeof CONSOLE_ACTIONS)[number], `provider.${string}`>,
  'provider.probe.skip'
>

/**
 * 发起一次写的人，由路由从请求里取：
 *
 * ```ts
 * const blocked = await ctx.admit(); if (blocked) return blocked
 * const p = ctx.access.principal
 * const caller = {
 *   subject: p?.subject ?? 'anonymous',
 *   role: p?.kind === 'user' ? p.role : null,
 *   breakGlass: ctx.access.breakGlass,
 *   record: ctx.record,
 * }
 * ```
 *
 * 端口再判一次：只有个人账号（`u:…`）、`role === 'ops'`、不是 break-glass 才放行，
 * 否则 `rejected` 且**不记账**（与「角色门不记」同一条）。放行之后，端口在动作做完的
 * 那一刻自己调 `record`：一次保存记一条，一次下发每个节点各记一条、记的是节点回报
 * 的结果。所以路由不要再为同一次写调 `ctx.record`。
 */
export interface ProviderCaller {
  readonly subject: string
  readonly role: 'viewer' | 'member' | 'ops' | null
  readonly breakGlass: boolean
  readonly record: (
    action: ProviderActionName,
    target: string,
    outcome: ActionOutcome,
    code?: string,
  ) => Promise<boolean>
}

/**
 * 模型服务（`providers-console-m1.md` §2、§6.3）。宿主实现在
 * `src/cli/handlers/consoleProviders.ts`；缺席（`ConsoleDeps.providers` 未接）时页面
 * 说明「模型服务未开启」。
 *
 * - 读方法不收 {@link ProviderCaller}，按角色裁剪是页面的事（§7.3：viewer 不看指纹、
 *   不看 Base URL 主机以外的部分）。例外是 `models` 和只读的 `autocompact`：它们会
 *   连到节点（`models` 还可能带着候选密钥），所以收 caller、要 ops，但不记账。
 *   `preview` 只在中枢编译、不连节点，密钥以占位符代替。
 * - 写方法都收 caller、要 ops、自己记账（见 {@link ProviderCaller}）；写之前由路由
 *   `ctx.admit()`。
 * - 带 `ifMatch` 的方法：`null` 只用于新建；修订号不符返回 `conflict`（409）。
 * - 返回值从不含密钥值或片段；节点的 stderr 与厂商原文都不转述。
 */
export interface ProviderPort {
  // --- 读 ---------------------------------------------------------------
  overview(): Promise<ProviderResult<ProviderOverview>>
  profile(id: string): Promise<ProviderResult<ProviderProfileView>>
  /** 预设目录，按组排好。这一面停用时也照常返回（它不读任何本地状态）。 */
  catalog(): ProviderCatalog
  /** 从预设起一份草稿（§6.3.2）：表单默认只剩密钥一个必填项。 */
  draftFromPreset(input: {
    readonly presetId: string
    readonly site?: string
  }): ProviderResult<ProviderProfileView>
  /** 中枢一侧的编译预览；给了 `node` 就带上该节点的上下文覆盖与能力。 */
  preview(input: {
    readonly candidate: ProviderCandidate
    readonly node?: string
  }): Promise<ProviderResult<ProviderCompilePreview>>
  node(node: string): Promise<ProviderResult<ProviderNodeView>>
  /** 立刻向节点要一次 `status`（同一节点 5 s 内的重复请求直接回缓存）。 */
  refreshNode(node: string): Promise<ProviderResult<ProviderNodeView>>
  exportProfiles(
    ids?: readonly string[],
  ): Promise<ProviderResult<ProviderExport>>
  importPreview(text: string): Promise<ProviderResult<ProviderImportPreview>>
  /** 经节点拉模型列表（§5.5）。不给 candidate 就用节点当前已生效的配置。要 ops，不记账。 */
  models(
    input: { readonly node: string; readonly candidate?: ProviderCandidate },
    caller: ProviderCaller,
  ): Promise<ProviderResult<readonly { readonly id: string }[]>>

  // --- 写：要 ops，端口自己记账 ---------------------------------------------
  /**
   * 新建或修改一份档案。`secrets` 是同一次保存里顺带填的密钥（keyId → 值），与档案、
   * 账本事件在同一个同步段里落盘（§2.3 第 3 步），各记一条 `provider.secret.set`。
   */
  saveProfile(
    input: {
      readonly profile: ProviderProfileDraft
      readonly ifMatch: number | null
      readonly secrets?: Readonly<Record<string, string>>
    },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderProfileView>>
  /** 还有节点在用（期望或实际）时 `in_use`，先指定替代档案。 */
  deleteProfile(
    input: { readonly profileId: string; readonly ifMatch: number },
    caller: ProviderCaller,
  ): Promise<ProviderResult<void>>
  /** 只写不读：设置或重新填写一把密钥。旧密文随即从密文库消失。 */
  setSecret(
    input: {
      readonly profileId: string
      readonly keyId: string
      readonly value: string
      readonly ifMatch: number
    },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderProfileView>>
  clearSecret(
    input: {
      readonly profileId: string
      readonly keyId: string
      readonly ifMatch: number
    },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderProfileView>>
  /** 全局默认；`null` 是取消。单独指派过的节点不受影响。 */
  setDefault(
    input: { readonly profileId: string | null },
    caller: ProviderCaller,
  ): Promise<ProviderResult<void>>
  /** 节点 → 档案；`unmanaged` 是「停止托管」，只改中枢的期望、不动节点文件（§6.3.7）。 */
  assign(
    input: { readonly node: string; readonly assignment: ProviderAssignment },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderNodeView>>
  /** D-8：`tokens` 为 `null` 是清除覆盖、回到档案值。随下一次下发生效。 */
  setContextOverride(
    input: { readonly node: string; readonly tokens: number | null },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderNodeView>>
  /**
   * 按节点逐个下发期望配置。`nodes` 缺省是全部受托管的节点。`dryRun` 只校验与比对、
   * 返回将要变化的键名，不记账。`sessions` 缺省按 §2.7 算（同一线路同一主机 `keep`，
   * 否则 `reset`）。`force` 覆盖节点上的本地改动，记为 `provider.apply.force`。
   * 部分失败时整体仍是 `ok: true`，逐节点看 {@link ProviderApplyResult.outcome}。
   * `profileId` 只用于 dry-run（「换成这份会变什么」）；真下发带它是 `invalid`，
   * 换档案要先 {@link ProviderPort.assign}。
   */
  apply(
    input: {
      readonly nodes?: readonly string[]
      readonly dryRun?: boolean
      readonly force?: boolean
      readonly sessions?: 'keep' | 'reset'
      readonly profileId?: string
    },
    caller: ProviderCaller,
  ): Promise<ProviderResult<readonly ProviderApplyResult[]>>
  /** 测连 `auth`、测速 `latency`、真实调用 `call`（会计费），都在节点上跑。 */
  probe(
    input: {
      readonly node: string
      readonly mode: 'auth' | 'latency' | 'call'
      readonly candidate: ProviderCandidate
    },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderProbeResult>>
  /**
   * D-9：节点自己的自动压缩阈值，经节点的 `autocompact` 写入。`value` 缺省是只读
   * （不记账）；`'auto'` 或 100 000–1 000 000 的整数是写。
   */
  autocompact(
    input: { readonly node: string; readonly value?: 'auto' | number },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderAutocompactResult>>
  /** 导入：先 {@link importPreview}；导入的档案一律没有密钥、`evaluated: false`。 */
  importProfiles(
    input: ProviderImportInput,
    caller: ProviderCaller,
  ): Promise<ProviderResult<readonly ProviderProfileView[]>>
}

/** Protocol/runtime ceilings, read from the packages that own them. */
export interface LimitsSnapshot {
  /** `@qianmo/protocol` LIMITS — the single source for protocol ceilings. */
  readonly protocol: {
    readonly maxMessageBytes: number
    readonly maxHops: number
    readonly defaultTtlMs: number
    readonly defaultTaskTtlMs: number
    readonly ratePerMinute: number
  }
  /**
   * `@qianmo/router` RUNTIME_RATE. Deliberately a separate column: the two
   * rate limits are structurally distinct and must not be shown as one number
   * (`packages/router/src/rate.ts` module note).
   */
  readonly runtime: {
    readonly capacity: number
    readonly windowMs: number
  }
  /**
   * `@qianmo/registry`'s default lease — the scale of last resort, not the
   * scale. The registry may run with any `ttlMs`, so the roster judges each
   * record by the lease the registry granted it (`expiresAt − lastHeartbeatAt`)
   * and the page prints that; this number stands in only for a record that
   * carries no lease, and for an empty roster. `/v0/limits` reports it as is.
   */
  readonly registryTtlMs: number
}

/**
 * The instance's own facts, as the startup banner prints them (A4).
 *
 * Before this the build, the registry, the trails, the signing state and the
 * files a console writes were only in its stdout: a page could not say which
 * build it was, so a report about it started with "which one is that". Every
 * value here is already in that banner and none is a secret — no token, no
 * PSK, no private key. The one key that appears is the public signing
 * identity the banner prints for `--trust`.
 */
export interface ConsoleAbout {
  /** `sourceCommit()`: a full SHA, `<sha>-dirty`, or `unknown` (issue #70). */
  readonly sourceCommit: string
  /** The registry this console reads and writes. */
  readonly registryUrl: string
  /** One line per audit source: `node=path`. */
  readonly auditTrails: readonly string[]
  /** The banner's wake line, as printed. */
  readonly wake: string
  /** `node=publicKey` when wakes are signed (`--wake-sign`). */
  readonly wakeSigning?: string
  /** The banner's chat line, as printed; `(signed)` in it is `--chat-sign`. */
  readonly chat: string
  /**
   * The files this console writes, labelled. Paths are not secrets, but they
   * describe the host: the page shows them only to a reader who may write.
   */
  readonly paths: readonly (readonly [label: string, path: string])[]
}

/** Everything a console instance needs. `wake` and `chat` are optional. */
export interface ConsoleDeps {
  readonly registry: RegistryPort
  /**
   * 生命周期（P15.2，见上面 {@link LifecyclePort} 那一段）。缺席时生命周期
   * 路由回 501，注册照旧直接走 {@link registry}。
   */
  readonly lifecycle?: LifecyclePort
  /**
   * Legacy single-audit facade. New hosts provide {@link audits}; retaining
   * this keeps direct package consumers on the old one-source contract.
   */
  readonly audit: AuditPort
  /** Ordered audit sources. Absent means one authoritative `default` source. */
  readonly audits?: readonly ConsoleAuditSource[]
  readonly limits: LimitsSnapshot
  readonly wake?: WakePort
  /** Named wake allowlist. Absent preserves the legacy single WakePort path. */
  readonly wakeTargets?: readonly WakeTarget[]
  /** Absent removes the chat page and every `/v0/chat/*` route (§4.5). */
  readonly chat?: ChatPort
  /** Absent removes the certificate column entirely (§10.1). */
  readonly certificates?: CertificatePort
  /**
   * 每个节点跑在哪台服务器上，**启动时确定，而且这就是白名单**。
   *
   * 两件事同时由它决定：名册上一个节点显示哪台机器，以及
   * `PUT /v0/servers/<id>/note` 允许写哪些 id。客户端送来的 server id 必须先在
   * 这张表里查到才处理，查不到回 403——与 {@link ConsoleDeps.wakeTargets} 同一条
   * 纪律（`http.ts` 的 `handleWake`）：客户端不能凭一个任意字符串让服务端多出
   * 一条记录来。
   *
   * 缺席就是整个归属面消失（名册不显示归属、服务器区块不渲染、两条路由回 501），
   * 而不是显示一列空白：一列空白会让「这个部署没配归属」和「归属全丢了」长得
   * 一样。
   */
  readonly nodeServers?: readonly NodeServer[]
  /** 备注的落盘面。缺席时备注框只读并说明原因。 */
  readonly serverNotes?: ServerNotesPort
  /**
   * The CLI name the certificate column writes its copyable `qm ca issue`
   * line under. Read from the host's identity roster, never spelled here.
   */
  readonly binName?: string
  /**
   * What the startup banner says about this instance, for 设置与关于 (A4).
   * Absent from a host that does not say; the page then shows what the
   * package itself knows.
   */
  readonly about?: ConsoleAbout
  /** Injected for deterministic tests; defaults to `Date.now` at the edges. */
  readonly now?: () => number
  /** Shown in the page header so two consoles are never confused. */
  readonly label?: string
  /**
   * The wake receipt endpoint this console is pinned to, for display only.
   *
   * The wake form used to carry a `回调` text box that could only ever hold
   * this one value — `createWakePort` refuses anything else (`consolePorts.ts`)
   * — so the field was a box that existed to be left empty. It is now a read-
   * only line of small print, and this is where the line gets its value.
   * Absent renders no line rather than an empty one.
   */
  readonly wakeUrl?: string
  /**
   * The address this console speaks as, prefilled into the wake form's
   * `发起方`. Absent leaves the field editable and empty.
   */
  readonly identity?: string
  /**
   * 动作账本（P15.9）。缺席时什么都不记，其余行为不变。
   */
  readonly actions?: ActionLedgerPort
  /**
   * 告警的通知来源与确认存储（J5）。缺席时告警页照常列出状况，通知一栏与确认
   * 写「未接入」。
   */
  readonly notify?: NotifyPort
  /** 值守作业的只读面（J6）。缺席时作业页写「未接入」。 */
  readonly scheduler?: SchedulerPort
  /** 接力台账（P17.4）。缺席时 `/v0/handoff` 回 501。 */
  readonly handoff?: HandoffPort
  /**
   * 模型服务（P18.6）。只在 `--providers` 打开时接；缺席时页面说明未开启。
   */
  readonly providers?: ProviderPort
}
