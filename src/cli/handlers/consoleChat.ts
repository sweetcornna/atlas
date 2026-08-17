// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `ChatPort` 的生产实现：把控制台的聊天面接到真的阡陌网络上。
 *
 * ## 回程走的是既有的那一条，不是新发明的一条
 *
 * 「浏览器发一句话，常驻 agent 回一句话」需要一条**回程**。仓库里已经有一条，而且
 * 它就是为这件事设计的：`task.request` → `ack` → `task.result`，**三者都在发起方
 * 自己那条已认证连接上**（P4.1 / AC-2；`demo/lib/p41-send.ts` 的模块注释把「回程
 * 另开一条连接也算数」明确列为要排除的实现方式）。`task.result` 的
 * `completed` 分支带的 `content` 字段，就是 agent 那一轮的正文
 * （`packages/protocol/src/message.ts` 的 `TaskResultPayload`，由
 * `src/services/qianmo/resident.ts` 的 `#completeTask` 填进去）。
 *
 * 所以这个模块**不起监听端口、不注册进注册中心、不持有节点身份私钥**：它是一个
 * 拨号方，回复顺着自己拨出去的那条 WebSocket 回来。
 *
 * 另一条路——「把控制台做成一个可寻址的对等体：起 `@qianmo/transport` 的 server、
 * 给它一份 PSK 与身份、把 `qianmo://<console>/<operator>` 注册进注册中心」——被否
 * 掉了，三个理由，每一个单独都够：
 *
 * 1. **协议里没有「agent 主动对操作者说话」这种消息。**要让回复走那条路，就得教
 *    常驻侧在跑完一轮之后**再**往控制台发一条新消息——那是改
 *    `packages/resident` / `src/services/qianmo/resident.ts` 的既有语义，而本阶段
 *    的纪律是不动它们。
 * 2. **P4.1 的判据明确排除了「回程另开一条连接」。**再造一条就是给同一件事开第二
 *    个出处，而那个出处不受 AC-2 的用例守着。
 * 3. **它要多一个监听端口、多一份 PSK 服务端面、多一条注册中心写入。**每一样都是
 *    真实的攻击面，换来的只是同一段文本。
 *
 * 代价说清楚：这条路**只能回答被问到的问题**。agent 想在没人问的时候主动说一句
 * （「我跑完了那个后台任务」），当前形状承载不了——那要等协议真的长出一个「通知」
 * 消息类型。见 `docs/dev/console.md` 的已知边界。
 *
 * ## 拨号目标钉死在允许名单上
 *
 * 注册中心自己**没有任何鉴权**（console.md §8.2：能连上它的人就能改任何一条记录）。
 * 「注册中心说这个 agent 的端点在那儿」因此不是「控制台就该往那儿发一条带 PSK
 * 握手的消息」的理由。名字从注册中心来（发现），能不能拨从启动参数来（授权），
 * 两者分开——和唤醒面把目标钉死在 `--wake-url` 上是同一条纪律，只是这里允许多个。
 */

import { randomUUID } from 'node:crypto'
import type {
  ChatPort,
  ChatSendInput,
  ChatSession,
  ChatTarget,
  ChatTranscript,
  ChatTurn,
  ChatUpdate,
  ConsoleFailure,
  ConsoleResult,
  RegistryPort,
} from '@qianmo/console'
import {
  MessageType,
  assertAddress,
  createMessage,
  isTaskResultPayload,
  type QianmoMessage,
} from '@qianmo/protocol'
import { NodeRouter } from '@qianmo/router'
import { TransportClient } from '@qianmo/transport'
import { ChatStore, type StoredChatSession } from './consoleChatStore.js'

// ---------------------------------------------------------------------------
// 可注入的那一层：一条链路
// ---------------------------------------------------------------------------

/**
 * 一条到某个节点入站端点的链路。
 *
 * 抽成接口只有一个目的：让这个 hub 的用例能在**不开一个 WebSocket 服务端**的前提
 * 下把四种回程（ack / 完成 / 失败 / 超时）都跑一遍。生产实现就是
 * {@link TransportClient} 的一层薄壳。
 */
export interface ChatLink {
  connect(timeoutMs: number): Promise<void>
  /** 交给传输层并等回执；抛错即「这条没发出去」。 */
  sendAndWait(message: QianmoMessage, timeoutMs: number): Promise<string>
  /** 终态：重连预算耗尽、PSK 被拒、或已经 close 过。 */
  isClosed(): boolean
  close(): Promise<void>
}

/** 建链路。回复经 `onReply` 回来——它就是回程本身。 */
export type ChatDialer = (input: {
  readonly url: string
  readonly node: string
  readonly peerNode: string
  readonly psk: string
  readonly onReply: (message: QianmoMessage) => void
}) => ChatLink

function defaultDialer(input: Parameters<ChatDialer>[0]): ChatLink {
  const client = new TransportClient({
    endpoint: { url: input.url },
    node: input.node,
    peerNode: input.peerNode,
    psk: input.psk,
    onMessage: message => {
      input.onReply(message)
    },
  })
  return {
    connect: timeoutMs => client.connect(timeoutMs),
    sendAndWait: (message, timeoutMs) => client.sendAndWait(message, timeoutMs),
    isClosed: () => client.isClosed(),
    close: () => client.close(),
  }
}

// ---------------------------------------------------------------------------
// 选项与默认值
// ---------------------------------------------------------------------------

interface ConsoleChatOptions {
  /** 控制台自己的地址，`qianmo://<node>/<agent>`。 */
  readonly from: string
  /** 允许拨号的入站端点，已归一（`new URL(...).toString()`）。 */
  readonly endpoints: readonly string[]
  /** 传输层 PSK。**只从环境变量来**，不从命令行、更不从页面来。 */
  readonly psk: string
  /** 会话落盘位置（绝对路径，由 `consoleArgs.ts` 从 `occConfigPath()` 派生）。 */
  readonly storePath: string
  /** 复用控制台既有的注册中心端口——名册只有一个出处。 */
  readonly registry: RegistryPort
  readonly taskTtlMs?: number
  readonly deliverTtlMs?: number
  readonly connectTimeoutMs?: number
  readonly sendTimeoutMs?: number
  readonly dial?: ChatDialer
  readonly now?: () => number
  readonly newId?: () => string
  readonly onError?: (error: unknown) => void
}

/**
 * 一轮的默认任务期限。
 *
 * 比唤醒面那 60 s 宽得多，理由是这里等的是一个**真的模型轮次**：常驻 agent 拿到
 * prompt 之后要跑工具、读文件、可能还要等别的模型。5 分钟是 P4.1 判据给 result
 * 的同一个上限（`demo/p41-task-result.sh` 的 `RESULT_LIMIT_MS`），不另立一个。
 */
const DEFAULT_CHAT_TASK_TTL_MS = 300_000

/** 投递期限：这一跳把信送到就算数，与那一轮跑多久无关。 */
const DEFAULT_CHAT_DELIVER_TTL_MS = 30_000

const DEFAULT_CHAT_CONNECT_TIMEOUT_MS = 15_000

/** 等回执的预算。回执是「传输层收下了」，不是「agent 答完了」。 */
const DEFAULT_CHAT_SEND_TIMEOUT_MS = 20_000

/**
 * 本地兜底计时器比任务期限多出来的这一段。
 *
 * 常驻侧自己也会在任务期限到点时发一条 `failed` 的 `task.result`
 * （`resident.ts` 的 `#armTaskTimeout`），所以正常情况下轮不到本地这个计时器。它
 * 存在是为了那条消息**回不来**的情况——链路断了、对面进程没了——否则页面上会永远
 * 停在「已读」，而那是所有状态里最像「还在想」的一个。
 *
 * 实际用的是 `min(这个数, taskTtlMs)`：宽限期比任务期限本身还长是没有意义的，而
 * 夹一下也让用例能用一个很短的 TTL 把这条路径跑完，不必等十几秒。
 */
const CHAT_TIMEOUT_SLACK_MS = 15_000

// ---------------------------------------------------------------------------
// 内部状态
// ---------------------------------------------------------------------------

interface PendingTask {
  readonly taskId: string
  readonly turnId: string
  readonly sessionId: string
  readonly sentAt: number
  timer: ReturnType<typeof setTimeout> | null
}

function fail<T>(
  code: ConsoleFailure['code'],
  message: string,
): ConsoleResult<T> {
  return { ok: false, failure: { code, message } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `ws://h:p` 与 `ws://h:p/` 是同一个端点；比较前一律过这一道。 */
export function normalizeChatEndpoint(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null
  return url.toString()
}

/**
 * 状态只升不降。
 *
 * 回程的四个事件（回执、ack、终态、本地超时）**不保证按顺序到**：本机回环上
 * `task.result` 完全可能先于 `sendAndWait` 的回执落地。用一个秩把它们排好，比在
 * 每个回调里各写一遍「除非已经是……」要短得多，也少一处会漂移的判断。
 */
const STATE_RANK: Readonly<Record<ChatTurn['state'], number>> = {
  pending: 0,
  delivered: 1,
  read: 2,
  done: 3,
  failed: 4,
}

// ---------------------------------------------------------------------------
// hub
// ---------------------------------------------------------------------------

/** {@link createConsoleChatPort} 返回的东西：一个 `ChatPort`，外加一个关。 */
export interface ConsoleChatHub extends ChatPort {
  /** 关掉全部链路与计时器。`occ console` 收到信号时调用。 */
  close(): Promise<void>
}

export function createConsoleChatPort(
  options: ConsoleChatOptions,
): ConsoleChatHub {
  const now = options.now ?? Date.now
  const newId = options.newId ?? randomUUID
  const dial = options.dial ?? defaultDialer
  const taskTtlMs = options.taskTtlMs ?? DEFAULT_CHAT_TASK_TTL_MS
  const deliverTtlMs = options.deliverTtlMs ?? DEFAULT_CHAT_DELIVER_TTL_MS
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_CHAT_CONNECT_TIMEOUT_MS
  const sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_CHAT_SEND_TIMEOUT_MS

  const self = assertAddress(options.from, 'chat from')
  const allowed = new Set<string>()
  for (const endpoint of options.endpoints) {
    const normalized = normalizeChatEndpoint(endpoint)
    if (normalized === null) {
      throw new Error(`chat endpoint must be ws or wss: ${endpoint}`)
    }
    allowed.add(normalized)
  }

  const store = new ChatStore(options.storePath)
  const router = new NodeRouter({ node: self.node })

  const sessions = new Map<string, StoredChatSession>()
  const turns = new Map<string, ChatTurn>()
  const order = new Map<string, string[]>()
  const pending = new Map<string, PendingTask>()
  const links = new Map<string, ChatLink>()
  const listeners = new Set<(update: ChatUpdate) => void>()
  let revision = 0

  // --- replay ------------------------------------------------------------

  const snapshot = store.load()
  for (const session of snapshot.sessions) {
    sessions.set(session.id, session)
    order.set(session.id, [])
  }
  for (const turn of snapshot.turns) {
    // A turn whose session record was lost is dropped rather than orphaned:
    // there is nowhere to render it, and keeping it would only make the
    // transcript count disagree with the transcript.
    const ids = order.get(turn.sessionId)
    if (ids === undefined) continue
    turns.set(turn.id, turn)
    ids.push(turn.id)
  }

  // --- notification ------------------------------------------------------

  function notify(sessionId: string): void {
    revision += 1
    const update: ChatUpdate = { sessionId, revision }
    for (const listener of listeners) {
      try {
        listener(update)
      } catch (error) {
        // One broken subscriber must not take the others — or the send that
        // triggered this — down with it.
        options.onError?.(error)
      }
    }
  }

  // --- turn bookkeeping --------------------------------------------------

  function persist(turn: ChatTurn): ChatTurn {
    turns.set(turn.id, turn)
    try {
      store.appendTurn(turn)
    } catch (error) {
      // The conversation is still on screen and still on the wire; only its
      // durability is gone. Taking the send down because the disk is full
      // would trade a degraded feature for a broken one.
      options.onError?.(error)
    }
    notify(turn.sessionId)
    return turn
  }

  function addTurn(turn: ChatTurn): ChatTurn {
    const ids = order.get(turn.sessionId)
    if (ids === undefined) return turn
    ids.push(turn.id)
    return persist(turn)
  }

  function patchTurn(id: string, patch: Partial<ChatTurn>): ChatTurn | null {
    const current = turns.get(id)
    if (current === undefined) return null
    const nextState =
      patch.state === undefined ||
      STATE_RANK[patch.state] <= STATE_RANK[current.state]
        ? current.state
        : patch.state
    return persist({ ...current, ...patch, state: nextState })
  }

  // --- reply path --------------------------------------------------------

  function settle(task: PendingTask): void {
    if (task.timer !== null) clearTimeout(task.timer)
    task.timer = null
    pending.delete(task.taskId)
    // Terminal for this task: the loop key has nothing left to protect.
    router.release(task.taskId)
  }

  function armTimeout(task: PendingTask): void {
    const timer = setTimeout(() => {
      if (!pending.has(task.taskId)) return
      settle(task)
      patchTurn(task.turnId, { state: 'failed', code: 'E_TASK_TIMEOUT' })
      addTurn({
        id: newId(),
        sessionId: task.sessionId,
        author: 'agent',
        at: now(),
        text: '这一轮在任务期限内没有回复。',
        state: 'failed',
        code: 'E_TASK_TIMEOUT',
        taskId: task.taskId,
        elapsedMs: now() - task.sentAt,
      })
    }, taskTtlMs + Math.min(CHAT_TIMEOUT_SLACK_MS, taskTtlMs))
    timer.unref?.()
    task.timer = timer
  }

  function failureText(payload: unknown): { text: string; code?: string } {
    if (typeof payload === 'object' && payload !== null) {
      const record = payload as Record<string, unknown>
      const reason = record['reason']
      const code = record['code']
      return {
        text:
          typeof reason === 'string' && reason.length > 0
            ? reason
            : '这一轮失败了。',
        ...(typeof code === 'string' && code.length > 0 ? { code } : {}),
      }
    }
    return { text: '这一轮失败了。' }
  }

  /**
   * One reply off a link this console dialled.
   *
   * Correlation is the envelope's `taskId` (protocol rule C-1) and nothing
   * else — never a payload field, never the sender address. An envelope whose
   * task nobody is waiting for is dropped in silence: it is a duplicate the
   * dedup table let through, or a reply to a turn a restart already settled.
   */
  function onReply(message: QianmoMessage): void {
    const task = pending.get(message.taskId)
    if (task === undefined) return
    const at = now()

    if (message.type === MessageType.Ack) {
      patchTurn(task.turnId, { state: 'read', readMs: at - task.sentAt })
      return
    }

    if (message.type === MessageType.TaskResult) {
      settle(task)
      const payload = message.payload
      if (isTaskResultPayload(payload) && payload.outcome === 'completed') {
        patchTurn(task.turnId, { state: 'read' })
        addTurn({
          id: newId(),
          sessionId: task.sessionId,
          author: 'agent',
          at,
          text: payload.content,
          state: 'done',
          taskId: message.taskId,
          traceId: message.traceId,
          elapsedMs: at - task.sentAt,
        })
        return
      }
      const failed = failureText(payload)
      patchTurn(task.turnId, {
        state: 'failed',
        ...(failed.code === undefined ? {} : { code: failed.code }),
      })
      addTurn({
        id: newId(),
        sessionId: task.sessionId,
        author: 'agent',
        at,
        text: failed.text,
        state: 'failed',
        ...(failed.code === undefined ? {} : { code: failed.code }),
        taskId: message.taskId,
        traceId: message.traceId,
        elapsedMs: at - task.sentAt,
      })
      return
    }

    if (message.type === MessageType.Error) {
      settle(task)
      const failed = failureText(message.payload)
      patchTurn(task.turnId, {
        state: 'failed',
        ...(failed.code === undefined ? {} : { code: failed.code }),
      })
      addTurn({
        id: newId(),
        sessionId: task.sessionId,
        author: 'agent',
        at,
        text: failed.text,
        state: 'failed',
        ...(failed.code === undefined ? {} : { code: failed.code }),
        taskId: message.taskId,
        traceId: message.traceId,
        elapsedMs: at - task.sentAt,
      })
    }
  }

  // --- links -------------------------------------------------------------

  async function linkFor(url: string, peerNode: string): Promise<ChatLink> {
    const existing = links.get(url)
    if (existing !== undefined && !existing.isClosed()) return existing
    if (existing !== undefined) {
      links.delete(url)
      try {
        await existing.close()
      } catch (error) {
        options.onError?.(error)
      }
    }
    const link = dial({
      url,
      node: self.node,
      peerNode,
      psk: options.psk,
      onReply,
    })
    links.set(url, link)
    try {
      await link.connect(connectTimeoutMs)
    } catch (error) {
      links.delete(url)
      // A client that failed to become ready keeps its own reconnect loop
      // running; dropping the reference without closing it leaks that loop for
      // as long as the console lives.
      try {
        await link.close()
      } catch {
        // Already unusable — the connect failure is the error worth reporting.
      }
      throw error
    }
    return link
  }

  // --- views -------------------------------------------------------------

  function sessionView(stored: StoredChatSession): ChatSession {
    const ids = order.get(stored.id) ?? []
    const last =
      ids.length === 0 ? undefined : turns.get(ids[ids.length - 1] ?? '')
    return {
      id: stored.id,
      target: stored.target,
      node: stored.node,
      agent: stored.agent,
      createdAt: stored.createdAt,
      updatedAt: last?.at ?? stored.createdAt,
      turnCount: ids.length,
      preview: last?.text ?? '',
    }
  }

  async function endpointFor(address: string): Promise<ConsoleResult<string>> {
    const listed = await options.registry.list()
    if (!listed.ok) return listed
    const agent = listed.value.find(entry => entry.address === address)
    if (agent === undefined) {
      return fail('not_found', `注册中心里没有 ${address}`)
    }
    const normalized = normalizeChatEndpoint(agent.endpoint)
    if (normalized === null) {
      return fail(
        'invalid',
        `${address} 的端点不是 ws/wss 地址：${agent.endpoint}`,
      )
    }
    if (!allowed.has(normalized)) {
      return fail(
        'rejected',
        `控制台只向 ${[...allowed].join('、')} 发消息；` +
          `${address} 的端点是 ${agent.endpoint}，要加进去请重启控制台并补一个 --chat-url`,
      )
    }
    return { ok: true, value: normalized }
  }

  // --- port --------------------------------------------------------------

  return {
    async targets(): Promise<ConsoleResult<readonly ChatTarget[]>> {
      const listed = await options.registry.list()
      if (!listed.ok) return listed
      const out: ChatTarget[] = []
      for (const agent of listed.value) {
        const parsed = (() => {
          try {
            return assertAddress(agent.address)
          } catch {
            return null
          }
        })()
        if (parsed === null) continue
        const normalized = normalizeChatEndpoint(agent.endpoint)
        out.push({
          address: agent.address,
          node: parsed.node,
          agent: parsed.agent,
          endpoint: agent.endpoint,
          status: agent.status,
          dialable: normalized !== null && allowed.has(normalized),
        })
      }
      return { ok: true, value: out }
    },

    async sessions(): Promise<ConsoleResult<readonly ChatSession[]>> {
      const out = [...sessions.values()].map(sessionView)
      out.sort((a, b) => b.updatedAt - a.updatedAt)
      return { ok: true, value: out }
    },

    async open(target: string): Promise<ConsoleResult<ChatSession>> {
      let parsed
      try {
        parsed = assertAddress(target, 'target')
      } catch (error) {
        return fail('invalid', messageOf(error))
      }
      const stored: StoredChatSession = {
        id: newId(),
        target,
        node: parsed.node,
        agent: parsed.agent,
        createdAt: now(),
      }
      try {
        store.appendSession(stored)
      } catch (error) {
        return fail('invalid', `会话写不进 ${store.path}：${messageOf(error)}`)
      }
      sessions.set(stored.id, stored)
      order.set(stored.id, [])
      notify(stored.id)
      return { ok: true, value: sessionView(stored) }
    },

    async transcript(
      sessionId: string,
    ): Promise<ConsoleResult<ChatTranscript>> {
      const stored = sessions.get(sessionId)
      if (stored === undefined) {
        return fail('not_found', '这条会话不在本控制台的记录里')
      }
      const ids = order.get(sessionId) ?? []
      const list: ChatTurn[] = []
      for (const id of ids) {
        const turn = turns.get(id)
        if (turn !== undefined) list.push(turn)
      }
      return { ok: true, value: { session: sessionView(stored), turns: list } }
    },

    async send(input: ChatSendInput): Promise<ConsoleResult<ChatTurn>> {
      const stored = sessions.get(input.sessionId)
      if (stored === undefined) {
        return fail('not_found', '这条会话不在本控制台的记录里')
      }
      const text = input.text.trim()
      if (text === '') return fail('invalid', '消息不能为空')

      const endpoint = await endpointFor(stored.target)
      if (!endpoint.ok) return endpoint

      let message: QianmoMessage
      try {
        const draft = createMessage({
          from: options.from,
          to: stored.target,
          type: MessageType.TaskRequest,
          payload: { prompt: text },
          deliverTtlMs,
          taskTtlMs,
        })
        // protocol.md §6.3 call site 1 — the origin stamps itself into
        // `hops[0]` before the envelope reaches a transport, and the same call
        // runs the runtime throttle every other sender goes through.
        const routed = router.outbound(draft)
        if (!routed.ok) {
          return fail('rejected', `${routed.code}: ${routed.reason}`)
        }
        message = routed.message
      } catch (error) {
        return fail('invalid', messageOf(error))
      }

      const sentAt = now()
      const turn = addTurn({
        id: newId(),
        sessionId: stored.id,
        author: 'operator',
        at: sentAt,
        text,
        state: 'pending',
        taskId: message.taskId,
        traceId: message.traceId,
      })

      const task: PendingTask = {
        taskId: message.taskId,
        turnId: turn.id,
        sessionId: stored.id,
        sentAt,
        timer: null,
      }
      // Registered *before* the send: on a loopback link the ack can arrive
      // inside `sendAndWait`, and a correlation table populated afterwards
      // would drop it.
      pending.set(task.taskId, task)
      armTimeout(task)

      try {
        const link = await linkFor(endpoint.value, stored.node)
        const receipt = await link.sendAndWait(message, sendTimeoutMs)
        const patched = patchTurn(turn.id, {
          state: 'delivered',
          receipt,
          receiptMs: now() - sentAt,
        })
        return { ok: true, value: patched ?? turn }
      } catch (error) {
        settle(task)
        patchTurn(turn.id, { state: 'failed' })
        return fail('unreachable', messageOf(error))
      }
    },

    subscribe(listener: (update: ChatUpdate) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async close(): Promise<void> {
      for (const task of pending.values()) {
        if (task.timer !== null) clearTimeout(task.timer)
      }
      pending.clear()
      listeners.clear()
      const open = [...links.values()]
      links.clear()
      await Promise.all(
        open.map(async link => {
          try {
            await link.close()
          } catch (error) {
            options.onError?.(error)
          }
        }),
      )
    },
  }
}
