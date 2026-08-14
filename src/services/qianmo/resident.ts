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
  taskExpiresAt,
  type QianmoMessage,
} from '@qianmo/protocol'
import { QIANMO_WRAPPER_TYPE } from '@qianmo/adapter/wrapper'
import { startTransportServer } from '@qianmo/transport'
import type {
  InboundContext,
  TransportChannel,
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
    try {
      await this.#supervisor.run()
    } finally {
      this.#deadlineClock.stop()
      for (const ledger of this.#ledgers.values()) ledger.close()
    }
  }

  async deliver(message: QianmoMessage): Promise<InboundDelivered> {
    const runtime = this.#runtime
    if (runtime === null)
      throw new Error('resident ACP connection is not ready')
    const result = await this.#adapter.deliver(message)
    if (result.status === 'rejected') {
      throw new ResidentDeliveryError(result.code, result.reason)
    }
    await runtime.deliver(message)
    return result
  }

  async #receive(
    message: QianmoMessage,
    context: InboundContext,
  ): Promise<void> {
    const task =
      message.type === MessageType.TaskRequest
        ? this.#registerTask(message, context.channel)
        : undefined
    try {
      await this.deliver(message)
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
    return task
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
