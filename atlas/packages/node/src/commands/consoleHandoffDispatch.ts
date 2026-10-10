// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The hub's half of P17.5: handing accepted tasks to node bridges
 * (`handoff-p17-plan.md` §2 P17.5「中枢侧派发」).
 *
 * `qm console --handoff-root … --handoff-node <node>=<ws url>
 * --handoff-node-git <node>=<ssh target>:<root>` wires this into the ledger
 * `consoleHandoff.ts` keeps. Per task:
 *
 * 1. pick an idle node — no task of the ledger holds it (`dispatched` /
 *    `running`) — in the order the nodes were given;
 * 2. `git push` the shadow commit (and so its tree) and the session commit
 *    into that node's `<project>.git`, through the node's SSH gate with the
 *    hub's own gate key (the node's `pre-receive` takes `refs/qianmo/{wip,
 *    sessions}/<device ≠ cloud>/…` and nothing else);
 * 3. `dispatched`, then a signed `task.request` to `qianmo://<node>/handoff`
 *    whose payload is the manifest and whose `taskTtlMs` runs to the
 *    manifest's deadline; the node's ack makes it `running`;
 * 4. while it runs, a `ping` every 60 s: any message from the hub is the
 *    node's cue to deliver a result whose receipt was lost;
 * 5. on `task.result`: `git fetch` `qianmo/<task>` and the cloud session ref
 *    back into the hub's bare repository, check the branch tip is the one
 *    the result names, `done` — or `failed` with the reason — and one webhook
 *    POST (D-7).
 *
 * A sentence queued with `POST /v0/handoff/<task>/send` goes to the node as
 * one more `task.request` (`{kind: 'handoff.send', task, seq, text}`) once the
 * task runs; the node starts a turn with it on the task's thread and drops a
 * `seq` it has seen.
 *
 * ## What survives a restart
 *
 * Only the ledger. A hub that comes back sends every `dispatched` or
 * `running` task's request again: the node answers a task it is still
 * running with another ack, a task it finished with its stored result, and a
 * task it lost (the bridge restarted mid-turn) with an error, which fails the
 * task here instead of leaving it to the deadline. Queued sentences go again
 * too; the node's `seq` check makes that harmless. The same re-request
 * follows a reconnect of the link to a node.
 *
 * ## Refusals that are not final
 *
 * `E_BUSY` (the node runs something this hub does not know about, or its
 * app-server is over the memory line), its legacy form `E_RATE_LIMITED`, and
 * `E_LOOP` (a re-request inside the node's loop window) leave the task where
 * it is and are tried again on the next tick. Every other refusal fails it:
 * an unsigned or unknown issuer, missing objects, a branch the node already
 * has.
 *
 * ## Time
 *
 * A task nobody took is failed at its deadline. One that went out is failed
 * at deadline + 10 min without a result — the node interrupts the turn at the
 * deadline itself, so the grace is for committing and replying.
 *
 * ## Secrets
 *
 * The PSK and the signing key never leave the transport and the issuer; the
 * webhook URL (a Bark or ntfy URL carries its secret in the path) is printed
 * as its origin only. Nothing here sees the model key: that lives on the node,
 * in the app-server's environment alone.
 */

import { join } from 'node:path'
import { AuditSource, type AuditTrail } from '@qianmo/audit'
import {
  CLOUD_DEVICE,
  decodeResultContent,
  FAILURE_REASON_MAX_BYTES,
  HANDOFF_SEND_KIND,
  type HandoffLedger,
  type HandoffResult,
  type HandoffTask,
  handoffNodeAddress,
  runGit,
  sessionRef,
  taskBranch,
  taskRef,
  wipRef,
} from '@qianmo/handoff'
import {
  createMessage,
  isTaskResultPayload,
  LEGACY_MESSAGE_TYPES,
  LIMITS,
  MessageType,
  ProtocolErrorCode,
  parseAddress,
  type QianmoMessage,
} from '@qianmo/protocol'
import { NodeRouter } from '@qianmo/router'
import { pskFromEnv, ReceiptStatus, TransportClient } from '@qianmo/transport'
import {
  type ConsoleCliConfig,
  transportPskEnvVarForNode,
} from './consoleArgs.js'
import { loadConsoleWakeIdentity } from './consoleWakeIdentity.js'
import { hubConnection, pushToHub } from './handoffHub.js'
import { formatHub, type HubLocation } from './handoffStore.js'
import type { WakeCapabilityIssuer } from './residentWake.js'

const DEFAULT_PING_INTERVAL_MS = 60_000
/** How long after the deadline a task that went out may still answer. */
const DEFAULT_DEADLINE_GRACE_MS = 10 * 60_000
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_RECEIPT_TIMEOUT_MS = 20_000
const DEFAULT_NOTIFY_TIMEOUT_MS = 10_000
/**
 * Extra `ssh` options for the hub's pushes and fetches: a node that does not
 * answer must cost one failed attempt, not a dispatcher stuck on a socket.
 */
const SSH_TIMEOUTS =
  '-o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4'

/**
 * The floor plus `notify`, as the console's chat face declares. Declaring a
 * post-legacy type is what makes the node answer `E_BUSY` rather than its
 * legacy downgrade, and mark a re-sent result `redelivered`.
 */
const SUPPORTED_TYPES: readonly string[] = [
  ...LEGACY_MESSAGE_TYPES,
  MessageType.Notify,
]

/** Refusals that mean "not now": the task stays, the next tick tries again. */
const NOT_NOW: ReadonlySet<unknown> = new Set([
  ProtocolErrorCode.E_BUSY,
  ProtocolErrorCode.E_RATE_LIMITED,
  ProtocolErrorCode.E_LOOP,
])

/** One node bridge the hub may hand tasks to. */
export interface HandoffNodeTarget {
  readonly node: string
  /** `ws(s)://` endpoint of `qm handoff node` on that node. */
  readonly url: string
  /** Transport key for that node; never printed. */
  readonly psk: string
  /** The node's repository root (`<root>/repos` of the bridge), as git reaches it. */
  readonly git: HubLocation
}

/** What the console's arguments decide; `consoleHandoff.ts` adds the ledger. */
export interface HandoffDispatchConfig {
  readonly nodes: readonly HandoffNodeTarget[]
  /** The console's own address (`--chat-from`), the `from` of every request. */
  readonly from: string
  /** The console's signing identity; the node trusts it with `--trust`. */
  readonly issueCapability: WakeCapabilityIssuer
  /** The hub's gate key on the nodes, for SSH repository roots. */
  readonly sshKey?: string
  /** D-7: POSTed once when a task ends. */
  readonly notifyUrl?: string
  readonly pingIntervalMs?: number
  readonly deadlineGraceMs?: number
  /**
   * Delivery deadline of every request. Also the shortest gap between two
   * requests for one task id: inside it the node's loop guard refuses the
   * second one.
   */
  readonly deliverTtlMs?: number
  readonly connectTimeoutMs?: number
  readonly receiptTimeoutMs?: number
  readonly notifyTimeoutMs?: number
  /** For tests; `0` disables the transport keep-alive. */
  readonly keepAliveIntervalMs?: number
}

interface HandoffDispatcherOptions extends HandoffDispatchConfig {
  /** `--handoff-root`: `<root>/<project>.git`. */
  readonly root: string
  readonly ledger: HandoffLedger
  readonly trail: AuditTrail
  readonly now: () => number
  /** One line per event; the console writes them to stderr. */
  readonly log: (line: string) => void
}

export interface HandoffDispatcher {
  /** A task was accepted or a node came free: dispatch what can be. */
  kick(): void
  /** A sentence was queued for `taskId`: forward it if the task runs. */
  forwardSends(taskId: string): void
  /** Start the clock; called once the console's port is bound. */
  start(): void
  /** Resolves once nothing is in flight. */
  idle(): Promise<void>
  /** Stop the clock and close every link. */
  close(): Promise<void>
}

interface NodeState {
  readonly target: HandoffNodeTarget
  readonly address: string
  link: TransportClient | null
  linking: Promise<TransportClient> | null
  /** No new task before this: the last push to it failed. */
  coolingUntil: number
}

interface TaskState {
  /** When this process last sent the task's request; `null` before the first. */
  lastRequestAt: number | null
  /** A request from this process reached the node's transport. */
  requestLanded: boolean
  requesting: boolean
  /** The objects went to the node from this process. */
  pushed: boolean
  /** A result whose fetch failed; tried again every tick. */
  pendingFetch: {
    readonly result: HandoffResult
    readonly error: string
  } | null
  finishing: boolean
}

interface SendState {
  readonly taskId: string
  readonly seq: number
  lastAt: number | null
  /** The node's transport took it; its answer may still be on the way. */
  delivered: boolean
  /** The node answered for good: it went into the thread, or never will. */
  settled: boolean
}

const OPEN_STATES: ReadonlySet<string> = new Set([
  'accepted',
  'dispatched',
  'running',
])

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncateBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text
  let cut = text.slice(0, max)
  while (Buffer.byteLength(`${cut}…`, 'utf8') > max) cut = cut.slice(0, -1)
  return `${cut}…`
}

/** The envelope task id of one forwarded sentence. */
function sendEnvelopeTaskId(taskId: string, seq: number): string {
  return `${taskId}-send-${seq}`
}

/** `https://host[:port]` of a URL; what is printed instead of the URL. */
function urlOrigin(raw: string): string {
  try {
    return new URL(raw).origin
  } catch {
    return '(invalid url)'
  }
}

export function createHandoffDispatcher(
  options: HandoffDispatcherOptions,
): HandoffDispatcher {
  const { ledger, now, log } = options
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS
  const deadlineGraceMs = options.deadlineGraceMs ?? DEFAULT_DEADLINE_GRACE_MS
  const deliverTtlMs = options.deliverTtlMs ?? LIMITS.defaultTtlMs
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const receiptTimeoutMs =
    options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS
  const selfNode = parseAddress(options.from)?.node
  if (selfNode === undefined) {
    throw new Error(`--chat-from 不是 qianmo:// 地址：${options.from}`)
  }
  const router = new NodeRouter({ node: selfNode })

  const nodes = new Map<string, NodeState>()
  for (const target of options.nodes) {
    nodes.set(target.node, {
      target,
      address: handoffNodeAddress(target.node),
      link: null,
      linking: null,
      coolingUntil: 0,
    })
  }
  const tasks = new Map<string, TaskState>()
  const sends = new Map<string, SendState>()
  const forwarding = new Set<string>()
  const inFlight = new Set<Promise<unknown>>()
  let timer: ReturnType<typeof setInterval> | undefined
  let closed = false
  let ticking = false
  let pumping: Promise<void> | null = null
  let pumpAgain = false

  const say = (line: string): void => {
    log(`[handoff] ${new Date(now()).toISOString()} ${line}`)
  }

  const track = <T>(promise: Promise<T>): Promise<T> => {
    inFlight.add(promise)
    void promise.finally(() => inFlight.delete(promise)).catch(() => {})
    return promise
  }

  const taskState = (taskId: string): TaskState => {
    let state = tasks.get(taskId)
    if (state === undefined) {
      state = {
        lastRequestAt: null,
        requestLanded: false,
        requesting: false,
        pushed: false,
        pendingFetch: null,
        finishing: false,
      }
      tasks.set(taskId, state)
    }
    return state
  }

  const forget = (taskId: string): void => {
    tasks.delete(taskId)
    for (const [id, send] of sends) {
      if (send.taskId === taskId) sends.delete(id)
    }
  }

  const deadlineOf = (task: HandoffTask): number =>
    Date.parse(task.manifest.deadline)

  // ── audit and webhook ──

  const audit = (
    task: HandoffTask,
    kind: 'handoff.dispatched' | 'handoff.completed' | 'handoff.failed',
    outcome: 'ok' | 'refused',
    detail: Readonly<Record<string, string>>,
    code?: string,
  ): void => {
    try {
      options.trail.append({
        at: now(),
        source: AuditSource.Handoff,
        kind,
        taskId: task.taskId,
        ...(task.node === null ? {} : { peer: task.node }),
        outcome,
        ...(code === undefined ? {} : { code }),
        detail,
      })
    } catch (error) {
      say(`task ${task.taskId} 审计写不进去（${kind}）：${messageOf(error)}`)
    }
  }

  const notify = async (task: HandoffTask): Promise<void> => {
    const url = options.notifyUrl
    if (url === undefined) return
    const done = task.state === 'done'
    const title = done
      ? `接力任务 ${task.taskId} ${task.result?.status === 'completed' ? '完成' : `已收尾（${task.result?.status ?? '?'}）`}`
      : `接力任务 ${task.taskId} 失败`
    const body = done
      ? `节点 ${task.node ?? '?'} · 分支 ${task.result?.branch ?? '?'} · 用 qm handoff status 查看`
      : truncateBytes(task.reason ?? '', 500)
    const payload = {
      title,
      body,
      msgtype: 'text',
      text: { content: `${title}\n${body}` },
      qianmo: {
        taskId: task.taskId,
        state: task.state,
        node: task.node,
        ...(task.result === null
          ? {}
          : {
              status: task.result.status,
              branch: task.result.branch,
              head: task.result.head,
              threadId: task.result.threadId,
            }),
        ...(task.reason === null ? {} : { reason: task.reason }),
      },
    }
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(
          options.notifyTimeoutMs ?? DEFAULT_NOTIFY_TIMEOUT_MS,
        ),
      })
      await response.body?.cancel()
      if (!response.ok) {
        say(
          `task ${task.taskId} 通知 ${urlOrigin(url)} 回 HTTP ${response.status}`,
        )
      }
    } catch (error) {
      say(
        `task ${task.taskId} 通知没有发到 ${urlOrigin(url)}：${messageOf(error).replaceAll(url, urlOrigin(url))}`,
      )
    }
  }

  // ── ledger moves ──

  const fail = (taskId: string, reason: string, code?: string): void => {
    if (closed) return
    const current = ledger.get(taskId)
    if (current === undefined || !OPEN_STATES.has(current.state)) return
    let failed: HandoffTask
    try {
      failed = ledger.fail(
        taskId,
        truncateBytes(reason, FAILURE_REASON_MAX_BYTES),
      )
    } catch (error) {
      say(`task ${taskId} 台账写不进 failed：${messageOf(error)}`)
      return
    }
    say(`task ${taskId} 失败：${failed.reason ?? reason}`)
    audit(
      failed,
      'handoff.failed',
      'refused',
      { reason: failed.reason ?? reason },
      code,
    )
    forget(taskId)
    void track(notify(failed))
    kick()
  }

  const complete = (taskId: string, result: HandoffResult): void => {
    if (closed) return
    const current = ledger.get(taskId)
    if (
      current === undefined ||
      (current.state !== 'dispatched' && current.state !== 'running')
    ) {
      return
    }
    let done: HandoffTask
    try {
      if (current.state === 'dispatched') ledger.start(taskId)
      done = ledger.complete(taskId, result)
    } catch (error) {
      say(`task ${taskId} 台账写不进 done：${messageOf(error)}`)
      return
    }
    say(
      `task ${taskId} 完成：${result.status}，${result.branch} → ${result.head}，线程 ${result.threadId}`,
    )
    audit(done, 'handoff.completed', 'ok', {
      status: result.status,
      branch: result.branch,
      head: result.head,
      threadId: result.threadId,
    })
    forget(taskId)
    void track(notify(done))
    kick()
  }

  // ── links ──

  const linkFor = async (state: NodeState): Promise<TransportClient> => {
    if (state.link !== null && !state.link.isClosed()) return state.link
    if (state.linking !== null) return state.linking
    const linking = (async () => {
      const previous = state.link
      state.link = null
      if (previous !== null) await previous.close().catch(() => {})
      let readies = 0
      const client = new TransportClient({
        endpoint: { url: state.target.url },
        node: selfNode,
        peerNode: state.target.node,
        psk: state.target.psk,
        supportedTypes: SUPPORTED_TYPES,
        ...(options.keepAliveIntervalMs === undefined
          ? {}
          : { keepAliveIntervalMs: options.keepAliveIntervalMs }),
        onMessage: message => {
          onInbound(state, message)
        },
        onReady: () => {
          readies += 1
          // The first one is the dial itself; later ones are reconnects, after
          // which the node may be a fresh process that lost its task.
          if (readies > 1) onReconnect(state)
        },
      })
      try {
        await client.connect(connectTimeoutMs)
      } catch (error) {
        await client.close().catch(() => {})
        throw error
      }
      if (closed) {
        await client.close().catch(() => {})
        throw new Error('派发已停止')
      }
      state.link = client
      return client
    })()
    state.linking = linking
    try {
      return await linking
    } finally {
      state.linking = null
    }
  }

  /** Route, sign-stamp and hand one message to the node; throws when it did not land. */
  const deliver = async (
    state: NodeState,
    build: (createdAt: number) => QianmoMessage,
  ): Promise<void> => {
    const link = await linkFor(state)
    const routed = router.outbound(build(now()))
    if (!routed.ok) throw new Error(`${routed.code}：${routed.reason}`)
    const receipt = await link.sendAndWait(routed.message, receiptTimeoutMs)
    if (receipt === ReceiptStatus.Duplicate) {
      // Swallowed by the node's dedup window: nothing was done with it.
      throw new Error('节点按重复消息丢掉了这一条')
    }
  }

  // ── git ──

  const connectionTo = (state: NodeState, project: string) => {
    const conn = hubConnection({
      hub: state.target.git,
      project,
      ...(options.sshKey === undefined ? {} : { key: options.sshKey }),
    })
    const ssh = conn.env.GIT_SSH_COMMAND
    return ssh === undefined
      ? conn
      : { url: conn.url, env: { GIT_SSH_COMMAND: `${ssh} ${SSH_TIMEOUTS}` } }
  }

  const hubRepository = (task: HandoffTask): string =>
    join(options.root, `${task.manifest.project}.git`)

  /** The shadow commit (with its tree) and the session commit, to the node. */
  const pushObjects = async (
    task: HandoffTask,
    state: NodeState,
  ): Promise<void> => {
    const { manifest } = task
    await pushToHub(
      connectionTo(state, manifest.project),
      hubRepository(task),
      [
        { ref: wipRef(manifest.device, manifest.branch), sha: manifest.wip },
        { ref: manifest.sessionRef, sha: manifest.sessionCommit },
      ],
    )
  }

  /** `qianmo/<task>` and the cloud session ref, from the node into the hub. */
  const fetchBack = async (
    task: HandoffTask,
    state: NodeState,
    result: HandoffResult,
  ): Promise<void> => {
    const conn = connectionTo(state, task.manifest.project)
    const repo = hubRepository(task)
    const branch = taskRef(task.taskId)
    const session = sessionRef(CLOUD_DEVICE, result.threadId)
    await runGit(
      [
        '-c',
        'core.fsmonitor=false',
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        conn.url,
        `+${branch}:${branch}`,
        `+${session}:${session}`,
      ],
      { cwd: repo, env: conn.env },
    )
    const head = (
      await runGit(['rev-parse', '--verify', `${branch}^{commit}`], {
        cwd: repo,
      })
    ).stdout
      .toString('utf8')
      .trim()
    if (head !== result.head) {
      throw new Error(
        `取回的 ${taskBranch(task.taskId)} 指向 ${head}，结果里写的是 ${result.head}`,
      )
    }
  }

  // ── requests ──

  const requestMessage = (
    task: HandoffTask,
    state: NodeState,
    createdAt: number,
  ): QianmoMessage =>
    createMessage({
      from: options.from,
      to: state.address,
      type: MessageType.TaskRequest,
      taskId: task.taskId,
      createdAt,
      deliverTtlMs,
      // Rule 6 of 2026-10-03: the deadline stays in the manifest and becomes
      // the envelope's task deadline here.
      taskTtlMs: Math.max(1, deadlineOf(task) - createdAt),
      payload: task.manifest,
      cap: options.issueCapability({
        aud: state.target.node,
        sub: state.address,
        taskId: task.taskId,
        createdAt,
      }),
    })

  /** Send (or send again) a task's request; failures wait for the next tick. */
  const request = async (taskId: string, state: NodeState): Promise<void> => {
    const memo = taskState(taskId)
    if (memo.requesting || memo.finishing || closed) return
    memo.requesting = true
    try {
      const task = ledger.get(taskId)
      if (
        task === undefined ||
        (task.state !== 'dispatched' && task.state !== 'running')
      ) {
        return
      }
      if (task.state === 'dispatched' && !memo.pushed) {
        await pushObjects(task, state)
        memo.pushed = true
      }
      memo.lastRequestAt = now()
      await deliver(state, createdAt => requestMessage(task, state, createdAt))
      memo.requestLanded = true
      say(`task ${taskId} 请求已送到 ${state.target.node}`)
    } catch (error) {
      say(
        `task ${taskId} 请求没送到 ${state.target.node}（${messageOf(error)}），下个周期再发`,
      )
    } finally {
      memo.requesting = false
    }
  }

  // ── sends ──

  const forwardSends = (taskId: string): void => {
    if (closed || forwarding.has(taskId)) return
    const task = ledger.get(taskId)
    if (task === undefined || task.state !== 'running' || task.node === null) {
      return
    }
    const state = nodes.get(task.node)
    if (state === undefined) return
    forwarding.add(taskId)
    void track(
      (async () => {
        try {
          // One at a time and in order: the node starts turns in arrival
          // order, so a sentence never overtakes one the node has not taken.
          for (const queued of ledger.sends(taskId)) {
            if (closed) return
            const id = sendEnvelopeTaskId(taskId, queued.seq)
            let send = sends.get(id)
            if (send === undefined) {
              send = {
                taskId,
                seq: queued.seq,
                lastAt: null,
                delivered: false,
                settled: false,
              }
              sends.set(id, send)
            }
            if (send.settled || send.delivered) continue
            // Inside the node's loop window a second envelope with this id
            // would be refused; wait for the next tick.
            if (send.lastAt !== null && now() - send.lastAt < deliverTtlMs) {
              return
            }
            send.lastAt = now()
            try {
              await deliver(state, createdAt =>
                createMessage({
                  from: options.from,
                  to: state.address,
                  type: MessageType.TaskRequest,
                  taskId: id,
                  createdAt,
                  deliverTtlMs,
                  payload: {
                    kind: HANDOFF_SEND_KIND,
                    task: taskId,
                    seq: queued.seq,
                    text: queued.text,
                  },
                  cap: options.issueCapability({
                    aud: state.target.node,
                    sub: state.address,
                    taskId: id,
                    createdAt,
                  }),
                }),
              )
              send.delivered = true
              say(`task ${taskId} 追加的话 #${queued.seq} 已送到节点`)
            } catch (error) {
              say(
                `task ${taskId} 追加的话 #${queued.seq} 没送到（${messageOf(error)}），下个周期再发`,
              )
              return
            }
          }
        } finally {
          forwarding.delete(taskId)
        }
      })(),
    )
  }

  const onSendAnswer = (send: SendState, message: QianmoMessage): void => {
    if (message.type === MessageType.TaskResult) {
      send.settled = true
      const payload = message.payload
      if (isTaskResultPayload(payload) && payload.outcome === 'failed') {
        say(
          `task ${send.taskId} 追加的话 #${send.seq} 没进线程：${payload.reason}`,
        )
      } else {
        say(`task ${send.taskId} 追加的话 #${send.seq} 进了线程`)
      }
      return
    }
    if (message.type === MessageType.Error) {
      const code = isRecord(message.payload) ? message.payload.code : undefined
      const reason = isRecord(message.payload) ? message.payload.reason : ''
      if (NOT_NOW.has(code)) {
        // Not taken: the next tick sends it again.
        send.delivered = false
        return
      }
      send.settled = true
      say(
        `task ${send.taskId} 追加的话 #${send.seq} 被节点拒绝（${String(code)}）：${String(reason)}`,
      )
    }
  }

  // ── inbound ──

  const onResult = async (
    taskId: string,
    state: NodeState,
    payload: unknown,
  ): Promise<void> => {
    const memo = taskState(taskId)
    if (memo.finishing) return
    if (!isTaskResultPayload(payload)) {
      fail(taskId, `节点 ${state.target.node} 回的 task.result 不成形`)
      return
    }
    if (payload.outcome === 'failed') {
      fail(
        taskId,
        `节点 ${state.target.node} 上续跑失败（${payload.code}）：${payload.reason}`,
        payload.code,
      )
      return
    }
    const decoded = decodeResultContent(payload.content)
    if (!decoded.ok) {
      fail(
        taskId,
        `节点 ${state.target.node} 的结果解不开：${decoded.errors.join('；')}`,
      )
      return
    }
    if (decoded.value.branch !== taskBranch(taskId)) {
      fail(
        taskId,
        `节点 ${state.target.node} 的结果指向分支 ${decoded.value.branch}，不是 ${taskBranch(taskId)}`,
      )
      return
    }
    await finishCompleted(taskId, state, decoded.value)
  }

  const finishCompleted = async (
    taskId: string,
    state: NodeState,
    result: HandoffResult,
  ): Promise<void> => {
    const memo = taskState(taskId)
    const task = ledger.get(taskId)
    if (
      memo.finishing ||
      task === undefined ||
      (task.state !== 'dispatched' && task.state !== 'running')
    ) {
      return
    }
    memo.finishing = true
    try {
      await fetchBack(task, state, result)
    } catch (error) {
      memo.pendingFetch = { result, error: messageOf(error) }
      say(
        `task ${taskId} 结果到了，但从 ${state.target.node} 取回失败（${messageOf(error)}），下个周期再取`,
      )
      return
    } finally {
      memo.finishing = false
    }
    memo.pendingFetch = null
    complete(taskId, result)
  }

  const onInbound = (state: NodeState, message: QianmoMessage): void => {
    if (closed || message.from !== state.address) return
    const send = sends.get(message.taskId)
    if (send !== undefined) {
      onSendAnswer(send, message)
      return
    }
    const task = ledger.get(message.taskId)
    if (task === undefined || task.node !== state.target.node) return
    switch (message.type) {
      case MessageType.Ack: {
        if (task.state === 'dispatched') {
          try {
            ledger.start(task.taskId)
            say(`task ${task.taskId} ${state.target.node} 已接手`)
          } catch (error) {
            say(`task ${task.taskId} 台账写不进 running：${messageOf(error)}`)
            return
          }
        }
        forwardSends(task.taskId)
        return
      }
      case MessageType.TaskResult:
        // A second copy of a result already taken (a redelivery crossing a
        // re-request) has nothing left to move.
        if (task.state !== 'dispatched' && task.state !== 'running') return
        void track(onResult(task.taskId, state, message.payload))
        return
      case MessageType.Error: {
        const code = isRecord(message.payload)
          ? message.payload.code
          : undefined
        const reason = isRecord(message.payload)
          ? String(message.payload.reason ?? '')
          : ''
        if (NOT_NOW.has(code)) {
          say(
            `task ${task.taskId} ${state.target.node} 暂时不收（${String(code)}）：${reason}，下个周期再发`,
          )
          return
        }
        fail(
          task.taskId,
          `节点 ${state.target.node} 拒绝了任务（${String(code)}）：${reason}`,
          typeof code === 'string' ? code : undefined,
        )
        return
      }
      default:
        return
    }
  }

  const onReconnect = (state: NodeState): void => {
    if (closed) return
    const task = ledger.activeOn(state.target.node)
    if (task === undefined) return
    const memo = taskState(task.taskId)
    if (memo.finishing || memo.pendingFetch !== null) return
    if (
      memo.lastRequestAt !== null &&
      now() - memo.lastRequestAt < deliverTtlMs
    ) {
      return
    }
    say(`task ${task.taskId} 到 ${state.target.node} 的链路重连，再发一次请求`)
    void track(request(task.taskId, state))
  }

  // ── dispatch ──

  const idleNodes = (): NodeState[] =>
    [...nodes.values()].filter(
      state =>
        ledger.activeOn(state.target.node) === undefined &&
        state.coolingUntil <= now(),
    )

  /** Push, `dispatched`, request. False when this node could not take it. */
  const dispatchTo = async (
    task: HandoffTask,
    state: NodeState,
  ): Promise<boolean> => {
    try {
      await pushObjects(task, state)
    } catch (error) {
      state.coolingUntil = now() + pingIntervalMs
      say(
        `task ${task.taskId} 推不到 ${state.target.node}（${messageOf(error)}），这个节点先歇一个周期`,
      )
      return false
    }
    if (closed) return false
    let dispatched: HandoffTask
    try {
      dispatched = ledger.dispatch(task.taskId, state.target.node)
    } catch (error) {
      say(`task ${task.taskId} 台账写不进 dispatched：${messageOf(error)}`)
      return false
    }
    taskState(task.taskId).pushed = true
    say(`task ${task.taskId} 派给 ${state.target.node}`)
    audit(dispatched, 'handoff.dispatched', 'ok', {
      node: state.target.node,
      project: task.manifest.project,
      wip: task.manifest.wip,
      sessionCommit: task.manifest.sessionCommit,
      git: formatHub(state.target.git),
    })
    void track(request(task.taskId, state))
    return true
  }

  const pumpOnce = async (): Promise<void> => {
    for (const task of ledger.list()) {
      if (closed) return
      if (task.state !== 'accepted' || deadlineOf(task) <= now()) continue
      let taken = false
      for (const state of idleNodes()) {
        if (await dispatchTo(task, state)) {
          taken = true
          break
        }
      }
      // No node took this one; a later task would meet the same nodes.
      if (!taken) return
    }
  }

  const pump = (): Promise<void> => {
    if (pumping !== null) {
      pumpAgain = true
      return pumping
    }
    pumping = (async () => {
      try {
        do {
          pumpAgain = false
          await pumpOnce()
        } while (pumpAgain && !closed)
      } finally {
        pumping = null
      }
    })()
    return pumping
  }

  function kick(): void {
    if (closed || timer === undefined) return
    void track(pump())
  }

  // ── the clock ──

  const tend = async (task: HandoffTask, state: NodeState): Promise<void> => {
    const memo = taskState(task.taskId)
    if (memo.finishing || memo.requesting) return
    if (memo.pendingFetch !== null) {
      await finishCompleted(task.taskId, state, memo.pendingFetch.result)
      return
    }
    // The request goes (again) until one from this process has landed — after
    // a restart that is what fetches a result the node already delivered to
    // the hub that went down — and, while the node has not acked, once per
    // loop window.
    const due =
      memo.lastRequestAt === null || now() - memo.lastRequestAt >= deliverTtlMs
    if (due && (!memo.requestLanded || task.state === 'dispatched')) {
      await request(task.taskId, state)
      return
    }
    try {
      await deliver(state, createdAt =>
        createMessage({
          from: options.from,
          to: state.address,
          type: MessageType.Ping,
          createdAt,
          payload: {},
        }),
      )
    } catch (error) {
      say(
        `task ${task.taskId} ping ${state.target.node} 没送到：${messageOf(error)}`,
      )
    }
    if (task.state === 'running') forwardSends(task.taskId)
  }

  const tick = async (): Promise<void> => {
    if (ticking || closed) return
    ticking = true
    try {
      const at = now()
      for (const task of ledger.list()) {
        const deadline = deadlineOf(task)
        if (task.state === 'accepted' && at >= deadline) {
          fail(task.taskId, '到截止时间还没有空闲节点接手')
        } else if (
          (task.state === 'dispatched' || task.state === 'running') &&
          at >= deadline + deadlineGraceMs
        ) {
          const pending = tasks.get(task.taskId)?.pendingFetch
          fail(
            task.taskId,
            `截止时间过了 ${Math.round(deadlineGraceMs / 60_000)} 分钟，节点 ${task.node ?? '?'} 还没有回结果${
              pending === null || pending === undefined
                ? ''
                : `（结果到了，取回一直失败：${pending.error}）`
            }`,
          )
        }
      }
      await Promise.all(
        [...nodes.values()].map(async state => {
          const task = ledger.activeOn(state.target.node)
          if (task === undefined) return
          try {
            await tend(task, state)
          } catch (error) {
            say(`task ${task.taskId} 周期检查出错：${messageOf(error)}`)
          }
        }),
      )
      await pump()
    } finally {
      ticking = false
    }
  }

  return {
    kick,
    forwardSends,
    start() {
      if (closed || timer !== undefined) return
      timer = setInterval(() => {
        void track(tick())
      }, pingIntervalMs)
      void track(tick())
    },
    async idle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight])
    },
    async close() {
      closed = true
      clearInterval(timer)
      const links = [...nodes.values()].map(state => state.link)
      await Promise.allSettled(links.map(link => link?.close()))
      await Promise.allSettled([...inFlight])
    },
  }
}

// ─── Wiring ──────────────────────────────────────────────────────────

/** What the console prints, and the config when there is one to run. */
export interface HandoffDispatchWiring {
  readonly config?: HandoffDispatchConfig
  readonly status: string
}

interface HandoffDispatchDependencies {
  readonly pskFromEnv: (variable?: string) => string
  /** Creates the key pair on first run — called only when a node is usable. */
  readonly loadIdentity: typeof loadConsoleWakeIdentity
}

/**
 * Resolve `--handoff-node …` into nodes with their transport keys and the
 * console's signing identity.
 *
 * The PSK follows the node and is the same variable `--chat-url` and
 * `--wake-url` read for it (`transportPskEnvVarForNode`); a node without one
 * is left out and the banner says so. Requests are always signed: the node
 * bridge refuses anything else, so a switch here could only produce a hub
 * that dispatches into certain refusal. The public key is in the banner line
 * because that is what goes after `--trust` on the node.
 */
export function wireHandoffDispatch(
  config: Pick<
    ConsoleCliConfig,
    'handoffNodes' | 'handoffNodeKey' | 'handoffNotifyUrl' | 'chatFrom'
  >,
  dependencies: HandoffDispatchDependencies = {
    pskFromEnv,
    loadIdentity: loadConsoleWakeIdentity,
  },
): HandoffDispatchWiring {
  const wanted = config.handoffNodes ?? []
  if (wanted.length === 0) return { status: 'disabled (no --handoff-node)' }
  const nodes: HandoffNodeTarget[] = []
  const notes: string[] = []
  for (const entry of wanted) {
    try {
      const psk = dependencies.pskFromEnv(
        transportPskEnvVarForNode(entry.node, '--handoff-node'),
      )
      nodes.push({ node: entry.node, url: entry.url, psk, git: entry.git })
      notes.push(`${entry.node} -> ${entry.url} (git ${formatHub(entry.git)})`)
    } catch {
      // The variable's content belongs to the secret boundary: no message.
      notes.push(`${entry.node} disabled (PSK unavailable)`)
    }
  }
  if (nodes.length === 0) return { status: `disabled (${notes.join(', ')})` }
  const identity = dependencies.loadIdentity(config.chatFrom)
  return {
    config: {
      nodes,
      from: config.chatFrom,
      issueCapability: identity.issue,
      ...(config.handoffNodeKey === undefined
        ? {}
        : { sshKey: config.handoffNodeKey }),
      ...(config.handoffNotifyUrl === undefined
        ? {}
        : { notifyUrl: config.handoffNotifyUrl }),
    },
    status:
      `enabled, signed as ${identity.node}=${identity.publicKey} -> ${notes.join(', ')}` +
      (config.handoffNotifyUrl === undefined
        ? ''
        : `; notify ${urlOrigin(config.handoffNotifyUrl)}`),
  }
}
