// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import type { ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import {
  AcpResidentTurnPort,
  createResidentAcpStream,
  FileAdmissionLedger,
  FileResidentSessionStore,
  NodeTurnGate,
  ResidentAcpConnection,
  ResidentDeadlineClock,
  ResidentNodeRuntime,
  ResidentPoller,
  ResidentSessionManager,
  ResidentSupervisor,
  ResidentTimingRecorder,
  type ResidentTimingSink,
} from '@qianmo/resident'
import type {
  ResidentChildConnection,
  ResidentMailboxMessage,
  ResidentMailboxPort,
  ResidentTurnInput,
  ResidentTurnResult,
} from '@qianmo/resident'
import { InboundAdapter, type InboundDelivered } from '@qianmo/adapter/inbound'
import {
  MessageType,
  ProtocolErrorCode,
  createAck,
  createTaskResult,
  errorReply,
  parseAddress,
  taskExpiresAt,
  type QianmoMessage,
} from '@qianmo/protocol'
import { QIANMO_WRAPPER_TYPE } from '@qianmo/adapter/wrapper'
import {
  NodeRouter,
  type CapabilityGate,
  type RouterAuditSink,
} from '@qianmo/router'
import { BackupScheduler, type SnapshotWriter } from '@qianmo/backup'
import { startTransportServer } from '@qianmo/transport'
import type {
  InboundContext,
  TransportChannel,
  TransportEventSink,
  TransportServerHandle,
} from '@qianmo/transport'
import {
  formatTeammateMessages,
  isStructuredProtocolMessage,
  markMessagesAsReadBySnapshot,
  readMailbox,
} from '../../utils/agents/teammateMailbox.js'
import { occConfigPath } from '../../config/paths.js'
import { buildCliLaunch, spawnCli } from '../../utils/process/cliLaunch.js'

interface QianmoResidentAgentConfig {
  readonly agent: string
  readonly cwd: string
}

interface QianmoResidentOptions {
  readonly node: string
  readonly team: string
  readonly agents: readonly QianmoResidentAgentConfig[]
  readonly pollIntervalMs?: number
  readonly psk: string
  readonly listen: {
    readonly port?: number
    readonly hostname?: string
    readonly unix?: string
  }
  /**
   * Authorization (P4.3). Absent means capabilities are neither required nor
   * verifiable here — every message counts as `read`. Present means a presented
   * token is fully checked, and rule S-1 refuses any remote `user-confirmed`.
   */
  readonly capability?: CapabilityGate
  /**
   * Durable audit trail (P7.2). Absent means the routing layer's refusals live
   * only in this process's ring — which is fine for a test and useless for the
   * question asked three days later.
   */
  readonly auditSink?: RouterAuditSink
  /**
   * Durable sink for the transport's own message events. Without it the trail
   * has the refusals but not the deliveries, and a chain reconstructed from it
   * would show only the parts that went wrong.
   */
  readonly transportEvents?: TransportEventSink
  /**
   * Workspace backups (P4.4). Absent means this node takes none — which is the
   * right default for a node whose workspace is disposable, and the wrong one
   * for anything AC-6(b) cares about, so the wiring passes it whenever a backup
   * service is configured.
   */
  readonly backup?: {
    readonly writer: SnapshotWriter
    readonly intervalMs?: number
  }
  readonly onActivity?: (active: boolean) => void | Promise<void>
  readonly activityReconnectFactor?: number
  readonly onTiming?: ResidentTimingSink
  readonly onError?: (error: unknown) => void
  readonly onReady?: (address: {
    readonly port?: number
    readonly unix?: string
    readonly url?: string
  }) => void
  readonly spawnAcp?: () => ChildProcess
}

class BaseMailboxPort implements ResidentMailboxPort {
  async readAll(
    agent: string,
    team: string,
  ): Promise<readonly ResidentMailboxMessage[]> {
    return await readMailbox(agent, team)
  }

  async markRead(
    agent: string,
    team: string,
    snapshot: readonly ResidentMailboxMessage[],
    readBefore: Readonly<Record<string, number>>,
  ): Promise<number> {
    return await markMessagesAsReadBySnapshot(
      agent,
      team,
      [...snapshot],
      readBefore,
    )
  }
}

function networkEnvelope(
  message: ResidentMailboxMessage | undefined,
): Record<string, unknown> | undefined {
  if (message === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(message.text)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined
    }
    const wrapper = parsed as Record<string, unknown>
    if (wrapper.type !== QIANMO_WRAPPER_TYPE) return undefined
    const envelope = wrapper.envelope
    return typeof envelope === 'object' &&
      envelope !== null &&
      !Array.isArray(envelope)
      ? (envelope as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function selectResidentSnapshot(
  messages: readonly ResidentMailboxMessage[],
): readonly ResidentMailboxMessage[] {
  const networkIndex = messages.findIndex(
    message => networkEnvelope(message) !== undefined,
  )
  if (networkIndex < 0) return messages
  return networkIndex === 0
    ? messages.slice(0, 1)
    : messages.slice(0, networkIndex)
}

function networkMessageId(
  messages: readonly ResidentMailboxMessage[],
): string | undefined {
  if (messages.length !== 1) return undefined
  const msgId = networkEnvelope(messages[0])?.msgId
  return typeof msgId === 'string' && msgId.length > 0 ? msgId : undefined
}

function defaultSpawnAcp(): ChildProcess {
  const launch = buildCliLaunch(['--acp'], {
    env: {
      ...process.env,
      OCC_IDENTITY: 'qianmo',
      CLAUDE_CODE_REMOTE_SEND_KEEPALIVES: '1',
    },
  })
  return spawnCli(launch, { stdio: ['pipe', 'pipe', 'inherit'] })
}

function webStreams(child: ChildProcess): {
  writable: WritableStream<Uint8Array>
  readable: ReadableStream<Uint8Array>
} {
  if (child.stdin === null || child.stdout === null) {
    throw new Error('resident ACP child requires piped stdin and stdout')
  }
  return {
    writable: Writable.toWeb(
      child.stdin,
    ) as unknown as WritableStream<Uint8Array>,
    readable: Readable.toWeb(
      child.stdout,
    ) as unknown as ReadableStream<Uint8Array>,
  }
}

function childClosed(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) resolve()
      else
        reject(
          new Error(`resident ACP child exited code=${code} signal=${signal}`),
        )
    })
  })
}

const TASK_REPLY_RECEIPT_TIMEOUT_MS = 5_000

/** Largest delay `setTimeout` takes before silently collapsing it to 1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

interface ActiveResidentTask {
  readonly envelope: QianmoMessage
  readonly channel: TransportChannel
  readonly releaseChannel: () => void
  timeout: ReturnType<typeof setTimeout> | null
  acked: boolean
  settled: boolean
}

class ResidentDeliveryError extends Error {
  readonly code: ProtocolErrorCode

  constructor(code: ProtocolErrorCode, message: string) {
    super(message)
    this.name = 'ResidentDeliveryError'
    this.code = code
  }
}

export class QianmoResident {
  readonly #options: QianmoResidentOptions
  readonly #gate = new NodeTurnGate()
  readonly #mailbox = new BaseMailboxPort()
  readonly #deadlineClock = new ResidentDeadlineClock({ periodMs: 10_000 })
  readonly #adapter: InboundAdapter
  readonly #router: NodeRouter
  readonly #sessions = new FileResidentSessionStore(
    occConfigPath('resident', 'sessions.json'),
  )
  readonly #ledgers = new Map<string, FileAdmissionLedger>()
  readonly #timings: ResidentTimingRecorder
  #poller: ResidentPoller | null = null
  readonly #turn: AcpResidentTurnPort
  readonly #supervisor: ResidentSupervisor
  #runtime: ResidentNodeRuntime | null = null
  #transport: TransportServerHandle | null = null
  readonly #tasksByMessage = new Map<string, ActiveResidentTask>()
  readonly #tasksByTask = new Map<string, ActiveResidentTask>()
  /** One scheduler per agent workspace; empty when backups are not configured. */
  readonly #backups = new Map<string, BackupScheduler>()

  constructor(options: QianmoResidentOptions) {
    this.#options = options
    this.#timings = new ResidentTimingRecorder(options.onTiming)
    this.#turn = new AcpResidentTurnPort(
      {
        extMethod: async () => {
          throw new Error('resident ACP connection is not ready')
        },
        prompt: async () => {
          throw new Error('resident ACP connection is not ready')
        },
      },
      { timings: this.#timings },
    )
    this.#adapter = new InboundAdapter({
      node: options.node,
      team: options.team,
      deadlineNow: this.#deadlineClock.nowFor,
    })
    // The routing gates run inside the sandbox too, not only on the host: a
    // resident is directly dialable (that is how P3.1's wake demo reaches it),
    // and a node whose only loop detection lives in front of it has none at all
    // in the deployment that skips the activator.
    this.#router = new NodeRouter({
      node: options.node,
      deadlineNow: this.#deadlineClock.nowFor,
      ...(options.capability === undefined
        ? {}
        : { capability: options.capability }),
      ...(options.auditSink === undefined
        ? {}
        : { auditSink: options.auditSink }),
    })
    const backup = options.backup
    if (backup !== undefined) {
      for (const agent of options.agents) {
        this.#backups.set(
          agent.agent,
          new BackupScheduler({
            workspace: agent.cwd,
            writer: backup.writer,
            ...(backup.intervalMs === undefined
              ? {}
              : { intervalMs: backup.intervalMs }),
            onError: error => this.#options.onError?.(error),
          }),
        )
      }
    }
    this.#supervisor = new ResidentSupervisor({
      start: async () => await this.#startAcp(),
      onError: error => this.#options.onError?.(error),
      onParked: failures =>
        this.#options.onError?.(
          new Error(`resident ACP parked after ${failures} rapid failures`),
        ),
    })
  }

  async run(): Promise<void> {
    this.#deadlineClock.start()
    for (const backups of this.#backups.values()) backups.start()
    try {
      await this.#supervisor.run()
    } finally {
      for (const backups of this.#backups.values()) backups.stop()
      this.#deadlineClock.stop()
      for (const ledger of this.#ledgers.values()) ledger.close()
    }
  }

  async deliver(
    message: QianmoMessage,
    verified: { readonly capIss?: string } = {},
  ): Promise<InboundDelivered> {
    const runtime = this.#runtime
    if (runtime === null)
      throw new Error('resident ACP connection is not ready')
    const result = await this.#adapter.deliver(message, verified)
    if (result.status === 'rejected') {
      throw new ResidentDeliveryError(result.code, result.reason)
    }
    await runtime.deliver(message)
    return result
  }

  /** The routing gates in force here, for tests and the AC-3 demo. */
  get router(): NodeRouter {
    return this.#router
  }

  async #receive(
    message: QianmoMessage,
    context: InboundContext,
  ): Promise<void> {
    // Ahead of everything with a side effect: no task route is registered, no
    // mailbox line is written, no ACP turn is opened for a message the routing
    // layer refuses (rule L-1 — a refused message must not eat the recipient's
    // inbox quota).
    const routed = this.#router.inbound(message)
    if (!routed.ok) {
      context.channel.send(errorReply(message, routed.code, routed.reason))
      throw new ResidentDeliveryError(routed.code, routed.reason)
    }

    const task =
      message.type === MessageType.TaskRequest
        ? this.#registerTask(message, context.channel)
        : undefined
    try {
      await this.deliver(
        message,
        routed.issuer === undefined ? {} : { capIss: routed.issuer },
      )
    } catch (error) {
      if (task !== undefined) {
        const code =
          error instanceof ResidentDeliveryError
            ? error.code
            : ProtocolErrorCode.E_UNDELIVERABLE
        const reason = error instanceof Error ? error.message : String(error)
        await this.#settleTask(task, errorReply(message, code, reason))
      }
      throw error
    }
  }

  #registerTask(
    envelope: QianmoMessage,
    channel: TransportChannel,
  ): ActiveResidentTask {
    const byTask = this.#tasksByTask.get(envelope.taskId)
    if (byTask !== undefined) {
      if (
        byTask.envelope.msgId === envelope.msgId &&
        byTask.channel.id === channel.id
      ) {
        return byTask
      }
      throw new ResidentDeliveryError(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        `task ${envelope.taskId} already belongs to another resident channel`,
      )
    }
    const task: ActiveResidentTask = {
      envelope,
      channel,
      releaseChannel: channel.hold(),
      timeout: null,
      acked: false,
      settled: false,
    }
    this.#tasksByMessage.set(envelope.msgId, task)
    this.#tasksByTask.set(envelope.taskId, task)
    this.#armTaskTimeout(task)
    this.#snapshotBeforeTask(envelope)
    return task
  }

  /**
   * Take the pre-task snapshot roadmap P4.4 asks for — **without awaiting it**.
   *
   * Awaiting would put a `tar` of an unbounded workspace in front of the ack,
   * and AC-2's ack line is a budget this node has already been measured
   * against. So the snapshot is started here and runs alongside the turn.
   *
   * Say plainly what that costs: the archive is taken *around* the start of the
   * task rather than at a frozen instant before it, so a file the turn writes
   * in its first second may or may not be in it. For AC-6(b) — "the workspace
   * comes back after a deletion" — that is immaterial. For "restore to exactly
   * the state this task began from" it is not, and a caller that needs the
   * stronger promise should own the task lifecycle and await
   * `BackupScheduler.beforeTask` itself, the way a scripted runner can.
   */
  #snapshotBeforeTask(envelope: QianmoMessage): void {
    const agent = parseAddress(envelope.to)?.agent
    if (agent === undefined) return
    const backups = this.#backups.get(agent)
    if (backups === undefined) return
    void backups.beforeTask(envelope.taskId).catch(error => {
      this.#options.onError?.(error)
    })
  }

  #armTaskTimeout(task: ActiveResidentTask): void {
    if (task.settled) return
    const now = this.#deadlineClock.nowFor(task.envelope.createdAt)
    const remaining = taskExpiresAt(task.envelope) - now
    task.timeout = setTimeout(
      () => {
        task.timeout = null
        if (task.settled) return
        const adjustedNow = this.#deadlineClock.nowFor(task.envelope.createdAt)
        if (adjustedNow < taskExpiresAt(task.envelope)) {
          this.#armTaskTimeout(task)
          return
        }
        void this.#settleTask(
          task,
          createTaskResult(task.envelope, task.envelope.to, {
            outcome: 'failed',
            code: ProtocolErrorCode.E_TASK_TIMEOUT,
            reason: 'resident task deadline expired before completion',
          }),
        )
      },
      // Clamped, then re-armed by the check above: `setTimeout` collapses any
      // delay past its 32-bit ceiling to 1 ms, which would turn a generous
      // `taskTtlMs` into a ~1000/s re-arm loop instead of a long wait.
      Math.min(Math.max(0, remaining), MAX_TIMER_DELAY_MS),
    )
    task.timeout.unref?.()
  }

  #taskFor(input: ResidentTurnInput): ActiveResidentTask | undefined {
    return input.networkMsgId === undefined
      ? undefined
      : this.#tasksByMessage.get(input.networkMsgId)
  }

  #ackTask(input: ResidentTurnInput, readAt: number): void {
    const task = this.#taskFor(input)
    if (task === undefined || task.acked || task.settled) return
    try {
      task.channel.send(createAck(task.envelope, task.envelope.to, readAt))
      task.acked = true
    } catch (error) {
      this.#options.onError?.(error)
    }
  }

  async #completeTask(
    input: ResidentTurnInput,
    result: ResidentTurnResult,
  ): Promise<void> {
    const task = this.#taskFor(input)
    if (task === undefined || task.settled) return
    await this.#settleTask(
      task,
      createTaskResult(task.envelope, task.envelope.to, result),
    )
  }

  async #failTask(error: unknown, input: ResidentTurnInput): Promise<void> {
    const task = this.#taskFor(input)
    if (task === undefined || task.settled) {
      this.#options.onError?.(error)
      return
    }
    const reason = error instanceof Error ? error.message : String(error)
    await this.#settleTask(
      task,
      createTaskResult(task.envelope, task.envelope.to, {
        outcome: 'failed',
        code: ProtocolErrorCode.E_TASK_FAILED,
        reason,
      }),
    )
  }

  async #settleTask(
    task: ActiveResidentTask,
    reply: QianmoMessage,
  ): Promise<void> {
    if (task.settled) return
    task.settled = true
    if (task.timeout !== null) clearTimeout(task.timeout)
    task.timeout = null
    this.#tasksByMessage.delete(task.envelope.msgId)
    this.#tasksByTask.delete(task.envelope.taskId)
    // Terminal state reached: the loop keys for this task have nothing left to
    // protect (protocol.md §8.2 rows 19–20).
    this.#router.release(task.envelope.taskId)
    try {
      await task.channel.sendAndWait(reply, TASK_REPLY_RECEIPT_TIMEOUT_MS)
    } catch (error) {
      this.#options.onError?.(error)
    } finally {
      task.releaseChannel()
    }
  }

  async #failActiveTasks(reason: string): Promise<void> {
    await Promise.all(
      [...this.#tasksByTask.values()].map(task =>
        this.#settleTask(
          task,
          createTaskResult(task.envelope, task.envelope.to, {
            outcome: 'failed',
            code: ProtocolErrorCode.E_TASK_FAILED,
            reason,
          }),
        ),
      ),
    )
  }

  stop(): void {
    this.#supervisor.stop()
  }

  async #startAcp(): Promise<ResidentChildConnection> {
    const child = (this.#options.spawnAcp ?? defaultSpawnAcp)()
    const closed = childClosed(child)
    void closed.catch(() => {})
    let runtime: ResidentNodeRuntime | null = null
    let poller: ResidentPoller | null = null
    let transport: TransportServerHandle | null = null
    let stopping: Promise<void> | null = null
    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        if (this.#runtime === runtime) this.#runtime = null
        poller?.stop()
        if (this.#poller === poller) this.#poller = null
        await this.#failActiveTasks('resident ACP connection closed')
        if (this.#transport === transport) this.#transport = null
        try {
          await transport?.stop()
        } finally {
          if (
            !child.killed &&
            child.exitCode === null &&
            child.signalCode === null
          ) {
            child.kill('SIGTERM')
          }
          try {
            await closed
          } catch {
            // Exit status is reported through the supervisor's `closed` await.
          }
          try {
            await this.#options.onActivity?.(false)
          } catch (error) {
            this.#options.onError?.(error)
          }
        }
      })()
      return stopping
    }

    try {
      const streams = webStreams(child)
      const connection = new ResidentAcpConnection({
        stream: createResidentAcpStream(streams.writable, streams.readable),
        onInputAccepted: async params => {
          await this.#turn.handleInputAccepted(params)
        },
        onActivity: this.#options.onActivity,
        onSessionUpdate: params => {
          this.#turn.handleSessionUpdate(params)
        },
      })
      this.#turn.replaceConnection(connection)

      const sessions = new ResidentSessionManager({
        connection,
        store: this.#sessions,
        agents: this.#options.agents,
      })
      await sessions.start()
      for (const agent of this.#options.agents) {
        this.#timings.record({
          stage: 'acp_ready',
          at: Date.now(),
          sessionId: sessions.sessionOf(agent.agent),
          agent: agent.agent,
          ...(this.#options.activityReconnectFactor === undefined
            ? {}
            : {
                activityReconnectFactor: this.#options.activityReconnectFactor,
              }),
        })
      }

      runtime = new ResidentNodeRuntime({
        node: this.#options.node,
        team: this.#options.team,
        mailbox: this.#mailbox,
        turn: this.#turn,
        formatPrompt: messages => formatTeammateMessages([...messages]),
        accepts: message => !isStructuredProtocolMessage(message.text),
        selectSnapshot: selectResidentSnapshot,
        correlationId: networkMessageId,
        timings: this.#timings,
        gate: this.#gate,
        agents: this.#options.agents.map(agent => ({
          agent: agent.agent,
          sessionId: sessions.sessionOf(agent.agent),
          ledger: this.#ledger(agent.agent),
        })),
        onRead: (input, readAt) => this.#ackTask(input, readAt),
        onTurnResult: async (input, result) => {
          await this.#completeTask(input, result)
        },
        onTurnError: async (error, input) => {
          await this.#failTask(error, input)
        },
      })
      this.#runtime = runtime

      transport = startTransportServer({
        psk: this.#options.psk,
        deadlineNow: this.#deadlineClock.nowFor,
        ...(this.#options.transportEvents === undefined
          ? {}
          : { events: this.#options.transportEvents }),
        onMessage: async (message, context) => {
          await this.#receive(message, context)
        },
        ...(this.#options.listen.port === undefined
          ? {}
          : { port: this.#options.listen.port }),
        ...(this.#options.listen.hostname === undefined
          ? {}
          : { hostname: this.#options.listen.hostname }),
        ...(this.#options.listen.unix === undefined
          ? {}
          : { unix: this.#options.listen.unix }),
      })
      this.#transport = transport

      poller = new ResidentPoller({
        poll: async () => {
          await runtime?.pollAll()
        },
        ...(this.#options.pollIntervalMs === undefined
          ? {}
          : { intervalMs: this.#options.pollIntervalMs }),
        onError: error => this.#options.onError?.(error),
      })
      this.#poller = poller
      poller.start()

      this.#options.onReady?.({
        ...(transport.port === undefined ? {} : { port: transport.port }),
        ...(transport.unix === undefined ? {} : { unix: transport.unix }),
        ...(transport.url === undefined ? {} : { url: transport.url }),
      })
      return { closed, stop }
    } catch (error) {
      await stop()
      throw error
    }
  }

  #ledger(agent: string): FileAdmissionLedger {
    let ledger = this.#ledgers.get(agent)
    if (ledger === undefined) {
      ledger = new FileAdmissionLedger(
        occConfigPath('resident', agent, 'admission.ndjson'),
      )
      this.#ledgers.set(agent, ledger)
    }
    return ledger
  }
}
