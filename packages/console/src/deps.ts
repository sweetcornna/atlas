// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

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

/** Uniform failure shape for every port. `code` is for tests, not for users. */
export interface ConsoleFailure {
  readonly code:
    | 'unreachable'
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

/** What a trail read yields, integrity verdict included. */
export interface AuditPage {
  readonly records: readonly AuditRecord[]
  /** False when the hash chain is broken — surfaced, never swallowed. */
  readonly intact: boolean
  /** How many issues the reader found, whatever their kind. */
  readonly issueCount: number
  /** Total records in the trail before filtering, for "showing N of M". */
  readonly total: number
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
  /** Tail size. The port clamps it; the view never asks for the whole file. */
  readonly limit?: number
}

export interface AuditPort {
  read(filter: AuditFilter): Promise<ConsoleResult<AuditPage>>
  chain(traceId: string): Promise<ConsoleResult<MessageChain | null>>
}

/** A wake request as the page can express it. */
export interface WakeInput {
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
}

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
  /** Registry lease TTL, so the roster's "expires" column has a scale. */
  readonly registryTtlMs: number
}

/** Everything a console instance needs. `wake` and `chat` are optional. */
export interface ConsoleDeps {
  readonly registry: RegistryPort
  readonly audit: AuditPort
  readonly limits: LimitsSnapshot
  readonly wake?: WakePort
  /** Absent removes the chat page and every `/v0/chat/*` route (§4.5). */
  readonly chat?: ChatPort
  /** Injected for deterministic tests; defaults to `Date.now` at the edges. */
  readonly now?: () => number
  /** Shown in the page header so two consoles are never confused. */
  readonly label?: string
}
