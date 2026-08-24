// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import type { ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import {
  AcpResidentTurnPort,
  createResidentAcpStream,
  DEFAULT_RESIDENT_INACTIVITY_MS,
  FileAdmissionLedger,
  FileDeliveryLedger,
  FileResidentSessionStore,
  NodeTurnExpiredError,
  NodeTurnGate,
  pendingSessionIds,
  ResidentAcpConnection,
  ResidentDeadlineClock,
  ResidentEstop,
  ResidentLifecycleSentinel,
  ResidentMemorySidecar,
  ResidentNodeRuntime,
  ResidentNotifier,
  ResidentPoller,
  ResidentSessionManager,
  ResidentSupervisor,
  ResidentTimingRecorder,
  type ResidentTimingSink,
} from '@qianmo/resident'
import type {
  DeliveryLedgerEntry,
  ResidentChildConnection,
  ResidentNotifyAuditSink,
  ResidentMailboxMessage,
  ResidentMailboxPort,
  ResidentPriorLife,
  ResidentPromptScope,
  ResidentTurnInput,
  ResidentTurnResult,
} from '@qianmo/resident'
import {
  InboundAdapter,
  type InboundDelivered,
  type InboundVerification,
} from '@qianmo/adapter/inbound'
import {
  MessageType,
  ProtocolErrorCode,
  createAck,
  createMessage,
  createTaskResult,
  errorCodeForPeer,
  errorReply,
  isNotifyPayload,
  isTaskResultPayload,
  parseAddress,
  peerIsPostLegacy,
  taskExpiresAt,
  type QianmoMessage,
} from '@qianmo/protocol'
import { QIANMO_WRAPPER_TYPE } from '@qianmo/adapter/wrapper'
import { FileMemoryStore, defaultMemoryRoot } from '@qianmo/memory'
import {
  NodeRouter,
  type CapabilityGate,
  type RouterAuditSink,
} from '@qianmo/router'
import { BackupScheduler, type SnapshotWriter } from '@qianmo/backup'
import type { AuditWitnessScheduler } from '@qianmo/witness'
import { startTransportServer } from '@qianmo/transport'
import type {
  InboundContext,
  ListenerIdentity,
  TransportChannel,
  TransportEventSink,
  TransportServerHandle,
} from '@qianmo/transport'
import type { TLSOptions } from 'bun'
import {
  formatTeammateMessages,
  isStructuredProtocolMessage,
  markMessagesAsReadBySnapshot,
  readMailbox,
} from '../../utils/agents/teammateMailbox.js'
import {
  IDENTITY_ENV_VAR,
  NODE_IDENTITY_MODE,
} from '../../constants/identity.js'
import { occConfigPath } from '../../config/paths.js'
import { buildCliLaunch, spawnCli } from '../../utils/process/cliLaunch.js'
import { assembleResidentPrompt } from './residentPrompt.js'
import { ACP_NOTIFY_METHOD, type QianmoNotifyVerdict } from './notifyWire.js'

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
   * L0 admission materials for the listener (key-distribution.md §7.1).
   *
   * Built by the wiring layer through `mutualTlsServerOptions`, which is what
   * keeps `ca`, `requestCert` and `rejectUnauthorized` from being applied one
   * at a time (F-10). Absent means plaintext, which is the right answer for a
   * unix socket and a deliberate one everywhere else.
   */
  readonly tls?: TLSOptions
  /** `notAfter` of the certificate in {@link tls}, epoch ms (§6.3). */
  readonly certificateNotAfter?: number
  /**
   * L1 signing material (§7.1 / §7.1.1). Absent means this node checks the
   * pre-shared key and signs nothing back — the pre-P12.3 behaviour, and the
   * default until an operator says otherwise.
   */
  readonly handshakeSigning?: ListenerIdentity
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
  /**
   * Off-host audit witness (P11.4). It is called by the existing resident
   * poller; the scheduler itself gates the documented 60 s anchor period.
   */
  readonly witness?: AuditWitnessScheduler
  readonly onActivity?: (active: boolean) => void | Promise<void>
  readonly activityReconnectFactor?: number
  /**
   * Silence budget for one ACP turn (design §3.B10). Defaults to
   * {@link DEFAULT_RESIDENT_INACTIVITY_MS}; `0` turns the watchdog off.
   */
  readonly inactivityMs?: number
  /**
   * How the previous life of this node ended (design §3.B2).
   *
   * A separate channel from `onError` because it is **evidence, not a fault**:
   * a node that was killed last time is not a node that is failing now, and
   * routing it through the error sink would make every restart after a `kill
   * -9` look like a new problem. Nothing branches on it (B8).
   */
  readonly onPriorLife?: (prior: ResidentPriorLife) => void
  readonly onTiming?: ResidentTimingSink
  /**
   * Where outbound `notify` events go (design §4.1 ⑤, hermes B9).
   *
   * Separate from `auditSink`, which is the router's: the router only records
   * refusals, while this path has to record the successes too — "the operator
   * was told, at 03:14, and the console receipted it" is the whole evidence a
   * watch job produces, and it is not a refusal.
   */
  readonly notifyAudit?: ResidentNotifyAuditSink
  /**
   * Where this node's memory store lives (design §4.4). Defaults to
   * {@link defaultMemoryRoot}, which is derived from the identity config root.
   *
   * An option rather than a constant only so a test can point at a temporary
   * directory. It is **not** a discovery path: the value is required to be
   * absolute (see `assertNodeOwnedMemoryRoot`), because a relative root would
   * resolve against the agent's working tree and let a `memory/` directory
   * committed to a repository stand in for this node's memory (hermes F9).
   */
  readonly memoryRoot?: string
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

/**
 * Which requester's context this batch belongs to (design §4.3).
 *
 * Nothing new travels for this: `@qianmo/adapter` already serializes the whole
 * envelope into the base mailbox entry, and `networkEnvelope` above already
 * reads it back for `msgId`. So the protocol, the adapter and the base runtime
 * are all untouched — the field was in the payload the entire time.
 *
 * `selectResidentSnapshot` guarantees a network entry is a batch of one, so a
 * batch can never straddle two contexts and there is nothing to split here.
 */
function networkContextId(
  messages: readonly ResidentMailboxMessage[],
): string | undefined {
  if (messages.length !== 1) return undefined
  const contextId = networkEnvelope(messages[0])?.contextId
  return typeof contextId === 'string' && contextId.length > 0
    ? contextId
    : undefined
}

function defaultSpawnAcp(): ChildProcess {
  const launch = buildCliLaunch(['--acp'], {
    env: {
      ...process.env,
      [IDENTITY_ENV_VAR]: NODE_IDENTITY_MODE,
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

/**
 * Re-mint a stored `task.result` for one more trip, marked as a repeat.
 *
 * New `msgId` and new `createdAt`, same `taskId` and `traceId`: the original
 * envelope's delivery deadline is long gone by the time a restart gets here, so
 * retransmitting it verbatim would earn an `E_TTL_EXPIRED` and nothing else
 * (protocol.md §14.4③). The peer suppresses the duplicate by `taskId`, which
 * is the correlation key it already has (rule C-1).
 *
 * The `redelivered` flag goes on **only for a peer that declared a post-legacy
 * type** — rule N-1's discipline applied to a field rather than to a code. A
 * peer older than that flag validates `task.result` by an exact key set, so
 * sending it would not degrade to "an unfamiliar marker"; it would degrade to
 * the whole reply being refused as malformed, which is the one outcome a
 * redelivery must not produce. Such a peer still gets the answer, and still has
 * `taskId` to notice it twice by.
 *
 * `undefined` when the stored bytes are not a `task.result` this node can
 * rebuild — a hand-edited or truncated ledger line. The caller abandons it
 * rather than guessing.
 */
function redeliveryEnvelope(
  entry: DeliveryLedgerEntry,
  channel: TransportChannel,
): QianmoMessage | undefined {
  const stored = entry.envelope as unknown as QianmoMessage
  if (
    typeof stored.from !== 'string' ||
    typeof stored.to !== 'string' ||
    typeof stored.traceId !== 'string' ||
    typeof stored.taskId !== 'string' ||
    !isTaskResultPayload(stored.payload)
  ) {
    return undefined
  }
  const payload = peerIsPostLegacy(channel.peerSupportedTypes)
    ? { ...stored.payload, redelivered: true as const }
    : stored.payload
  return createMessage({
    from: stored.from,
    to: stored.to,
    type: MessageType.TaskResult,
    traceId: stored.traceId,
    taskId: stored.taskId,
    ...(typeof stored.contextId === 'string' && stored.contextId.length > 0
      ? { contextId: stored.contextId }
      : {}),
    payload,
  })
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
  /**
   * Replies this node still owes a peer (design §3.B1).
   *
   * One file for the node rather than one per agent, unlike the admission
   * ledgers above: an obligation belongs to the peer it is owed to, and the
   * sweep that discharges it runs when *that peer* makes contact — which agent
   * produced the answer is not a key anything looks it up by.
   */
  readonly #deliveries = new FileDeliveryLedger(
    occConfigPath('resident', 'deliveries.ndjson'),
    { onError: error => this.#options.onError?.(error) },
  )
  /**
   * Notifications this node owes the hub (design §2.4③, §4.1⑤).
   *
   * A second file rather than a second mechanism — see
   * `packages/resident/src/notify.ts` for why the ledger is shared and the
   * file is not.
   */
  readonly #notifies = new FileDeliveryLedger(
    occConfigPath('resident', 'notifies.ndjson'),
    { onError: error => this.#options.onError?.(error) },
  )
  readonly #notifier: ResidentNotifier
  /** Redeliveries on the wire right now, so a second sweep does not double up. */
  readonly #redelivering = new Set<string>()
  /** Emergency stop (design §3.B6). Existence of the file is the whole test. */
  readonly #estop = new ResidentEstop({
    path: occConfigPath('resident', 'ESTOP'),
    onError: error => this.#options.onError?.(error),
  })
  /** Termination-cause forensics (design §3.B2). */
  readonly #lifecycle: ResidentLifecycleSentinel
  readonly #timings: ResidentTimingRecorder
  #poller: ResidentPoller | null = null
  readonly #turn: AcpResidentTurnPort
  readonly #supervisor: ResidentSupervisor
  #runtime: ResidentNodeRuntime | null = null
  #transport: TransportServerHandle | null = null
  readonly #tasksByMessage = new Map<string, ActiveResidentTask>()
  readonly #tasksByTask = new Map<string, ActiveResidentTask>()
  /** Replies sent but not yet receipted. See {@link #drainReplyReceipts}. */
  readonly #settling = new Set<Promise<void>>()
  /** One scheduler per agent workspace; empty when backups are not configured. */
  readonly #backups = new Map<string, BackupScheduler>()
  /** Memory recall for the user-message sidecar (design §4.4). */
  readonly #memory: ResidentMemorySidecar
  #stopping = false
  #witnessClosed = false

  constructor(options: QianmoResidentOptions) {
    this.#options = options
    this.#timings = new ResidentTimingRecorder(options.onTiming)
    this.#notifier = new ResidentNotifier({
      node: options.node,
      ledger: this.#notifies,
      onError: error => this.#options.onError?.(error),
      ...(options.notifyAudit === undefined
        ? {}
        : { audit: options.notifyAudit }),
    })
    this.#memory = new ResidentMemorySidecar({
      store: new FileMemoryStore({
        root: options.memoryRoot ?? defaultMemoryRoot(),
      }),
      onError: error => this.#options.onError?.(error),
    })
    this.#lifecycle = new ResidentLifecycleSentinel({
      path: occConfigPath('resident', 'lifecycle.json'),
      node: options.node,
      onError: error => this.#options.onError?.(error),
    })
    this.#turn = new AcpResidentTurnPort(
      {
        extMethod: async () => {
          throw new Error('resident ACP connection is not ready')
        },
        prompt: async () => {
          throw new Error('resident ACP connection is not ready')
        },
      },
      {
        timings: this.#timings,
        // Turned on here and nowhere else: the port defaults it off so unit
        // tests do not grow a timer they never asked for.
        inactivity: {
          timeoutMs: options.inactivityMs ?? DEFAULT_RESIDENT_INACTIVITY_MS,
        },
      },
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
    // Read before anything else writes: the sentinel's verdict is about the
    // process that came before this one, and stamping first would erase it.
    this.#options.onPriorLife?.(this.#lifecycle.start())
    // Loaded now so an obligation left over from that previous life is counted
    // — and its damaged lines reported — before the first peer arrives.
    // Nothing is *sent* here: a redelivery leaves on contact from the peer,
    // never on a connection this node opens (invariant H-2). See
    // `#redeliverOwed`.
    this.#deliveries.outstanding()
    // Same reason, same discipline: notifications owed from a previous life
    // are counted now and leave only when the hub comes back to us.
    this.#notifies.outstanding()
    this.#deadlineClock.start()
    for (const backups of this.#backups.values()) backups.start()
    try {
      await this.#supervisor.run()
    } finally {
      this.#stopping = true
      this.#poller?.stop()
      this.#poller = null
      this.#closeWitness()
      for (const backups of this.#backups.values()) backups.stop()
      this.#deadlineClock.stop()
      for (const ledger of this.#ledgers.values()) ledger.close()
      this.#deliveries.close()
      this.#notifies.close()
      this.#lifecycle.stop()
    }
  }

  /**
   * Take one inbound envelope as far as **durable**, and no further.
   *
   * The turn is started but not awaited, and that is the whole of H-3. The
   * caller of this method is on the transport's receipt path, and a receipt is
   * a link-layer statement — "I have this envelope and will not lose it". It
   * was previously withheld until the ACP turn had actually been admitted,
   * which meant that queueing behind a running turn was paid for out of the
   * sender's 5 s receipt budget: a busy node looked, to every peer, exactly
   * like an unreachable one.
   *
   * Three things this deliberately does **not** change (design §4.2(b)):
   *
   * - **The protocol `ack` is untouched.** It is still sent from `#ackTask`,
   *   off `onRead`, strictly after the mailbox read flip has been committed.
   *   AC-2's "ack is later than the durable read" line is about that message,
   *   not about the receipt below it.
   * - **The receipt still only leaves after a persistent write.** The mailbox
   *   write is the last step of `InboundAdapter.deliver` and the only one with
   *   a persistent side effect, so "receipted" continues to mean "on disk",
   *   never "seen".
   * - **Eviction still reads the same way.** A message the base mailbox later
   *   evicts leaves the sender with a receipt and no ack, and it gives up at
   *   `deliverTtlMs` — one of the three outcomes protocol.md §4.5 already
   *   lists, not a fourth.
   *
   * What it does cost, stated plainly: a receipt no longer promises the work
   * was *queued*, only that it was *kept*. A deep queue will accept a run of
   * messages and then answer them with `E_TASK_TIMEOUT` minutes later. That is
   * strictly better than today's silence, but it is a different promise.
   */
  async deliver(
    message: QianmoMessage,
    verified: InboundVerification = {},
  ): Promise<InboundDelivered> {
    const runtime = this.#runtime
    if (runtime === null)
      throw new Error('resident ACP connection is not ready')
    // Ahead of the write, and synchronous: the poll below no longer reports
    // "this node hosts no such agent" back in time to stop the write.
    try {
      runtime.assertDeliverable(message)
    } catch (error) {
      throw new ResidentDeliveryError(
        ProtocolErrorCode.E_UNKNOWN_AGENT,
        error instanceof Error ? error.message : String(error),
      )
    }
    const result = await this.#adapter.deliver(message, verified)
    if (result.status === 'rejected') {
      throw new ResidentDeliveryError(result.code, result.reason)
    }
    this.#startTurn(runtime, message)
    return result
  }

  /**
   * Kick the admission loop without waiting for it.
   *
   * Failures raised past this point used to become a rejected transport
   * receipt. They now take the better channel they always had: a terminal
   * `task.result{failed}`, which carries a `ProtocolErrorCode` where a receipt
   * carried a truncated reason string. Anything with no task behind it — local
   * teammate mail — has nowhere to report to and goes to `onError`.
   */
  #startTurn(runtime: ResidentNodeRuntime, message: QianmoMessage): void {
    void runtime.deliver(message).catch(async error => {
      const task = this.#tasksByMessage.get(message.msgId)
      if (task === undefined || task.settled) {
        this.#options.onError?.(error)
        return
      }
      await this.#settleTask(
        task,
        createTaskResult(task.envelope, task.envelope.to, {
          outcome: 'failed',
          code: this.#failureCodeFor(error, task),
          reason: error instanceof Error ? error.message : String(error),
        }),
      )
    })
  }

  /** The routing gates in force here, for tests and the AC-3 demo. */
  get router(): NodeRouter {
    return this.#router
  }

  /**
   * The node turn gate, for tests that need to observe or occupy it.
   *
   * Saturating it is the only way to reach the `E_BUSY` refusal below from
   * outside: the admission loop submits at most one turn per agent at a time,
   * so no amount of traffic will fill a 32-deep queue through the front door.
   */
  get gate(): NodeTurnGate {
    return this.#gate
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

    // Contact from this peer is the only moment a redelivery can leave, so it
    // is taken here — before the refusals below, which are about *this*
    // message and say nothing about the answers already owed for earlier ones.
    // Fire and forget: an obligation from a previous life must not delay the
    // envelope that just arrived.
    const peerNode = parseAddress(message.from)?.node
    this.#redeliverOwed(context.channel, peerNode)
    // The other half of the same rule (H-2). A notification produced while the
    // hub was away has been sitting in its ledger; this contact is the only
    // moment it is allowed to leave, and it leaves in the order it was made.
    if (peerNode !== undefined) this.#notifier.drain(context.channel, peerNode)

    // Emergency stop, ahead of the mailbox write for the same rule L-1 reason
    // as the queue check below: a refusal must not spend the recipient's inbox
    // quota. Pause-new-work only — nothing in flight is touched, because a turn
    // that has been admitted has a `task.result` owed to someone.
    if (this.#estop.engaged()) {
      const reason = 'resident is halted by its ESTOP sentinel'
      const code = errorCodeForPeer(
        ProtocolErrorCode.E_BUSY,
        context.channel.peerSupportedTypes,
      )
      context.channel.send(errorReply(message, code, reason))
      throw new ResidentDeliveryError(code, reason)
    }

    // Queue governance, in the same place and for the same reason: a node
    // whose turn queue is full says so *before* it writes, so the refusal does
    // not cost the recipient an inbox slot.
    //
    // The check is a question to the gate rather than a refusal thrown back
    // out of it. Once the receipt stopped waiting for the poll, a rejection
    // raised inside the gate could no longer reach this method at all — and
    // the design asks for both "refuse before the write" and "`#receive` sees
    // it", which only a look-before-you-write satisfies. The gate keeps its
    // own bound as well; that one is the hard invariant, this one is what the
    // sender hears about.
    if (this.#gate.saturated) {
      const reason = `resident turn queue is full, ${this.#gate.queued} turns waiting`
      const code = errorCodeForPeer(
        ProtocolErrorCode.E_BUSY,
        context.channel.peerSupportedTypes,
      )
      context.channel.send(errorReply(message, code, reason))
      throw new ResidentDeliveryError(code, reason)
    }

    const task =
      message.type === MessageType.TaskRequest
        ? this.#registerTask(message, context.channel)
        : undefined
    try {
      // Both halves of the routing layer's finding travel together: who
      // signed, and what this node concluded that signature was worth
      // (issue #28). Passing only the first is what left every cross-node
      // message pinned to `untrusted` no matter what it presented.
      await this.deliver(message, {
        trust: routed.trust,
        ...(routed.issuer === undefined ? {} : { capIss: routed.issuer }),
      })
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
   * Assemble the user message one turn runs on.
   *
   * The work itself lives in `residentPrompt.ts`; this is the seam that gives
   * it the memory sidecar. It runs **once per turn** — the reader writes the
   * result into the admission ledger and every later step, including a replay
   * after a crash, reads that stored string back. That is what makes the memory
   * block a frozen snapshot rather than a live read.
   */
  #assemblePrompt(
    messages: readonly ResidentMailboxMessage[],
    scope: ResidentPromptScope,
  ): string {
    return assembleResidentPrompt({
      messages,
      // The batch text doubles as the ranking question. It never filters — a
      // watch job that words things differently from the entry it needs still
      // sees that entry, which is the point of full injection.
      renderMemory: base => this.#memory.render(scope, base),
      onFinding: error => this.#options.onError?.(error),
    })
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

  /**
   * Settle the task behind a record the restart breaker just retired.
   *
   * Usually there is no task to settle: three restarts have gone by, so the
   * channel that asked is long gone and the request is somebody else's timeout
   * by now. That is not a reason to skip the call — the intra-process case
   * (a record that burns its attempts without taking the node down) does have a
   * live task, and it deserves a real answer rather than a wait until
   * `taskTtlMs`.
   */
  async #abandonTask(
    input: ResidentTurnInput,
    attempts: number,
    reason: string,
  ): Promise<void> {
    const task = this.#taskFor(input)
    if (task === undefined || task.settled) {
      this.#options.onError?.(new Error(reason))
      return
    }
    await this.#settleTask(
      task,
      createTaskResult(task.envelope, task.envelope.to, {
        outcome: 'failed',
        code: errorCodeForPeer(
          ProtocolErrorCode.E_TASK_FAILED,
          task.channel.peerSupportedTypes,
        ),
        reason: `${reason} (${attempts} attempts)`,
      }),
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
        code: this.#failureCodeFor(error, task),
        reason,
      }),
    )
  }

  /**
   * Which code a turn's failure deserves — and which one this peer can read.
   *
   * A turn the gate dropped at the head of the queue did not fail; it ran out
   * of the deadline the sender itself set, so it is `E_TASK_TIMEOUT` and not
   * `E_TASK_FAILED`. Everything else, a full queue included, is the general
   * failure code: `protocol.md` §4.6 closes `task.result{failed}` to exactly
   * those two codes, and widening that contract is not this change's business
   * — the refusal a sender acts on (`E_BUSY`) is delivered as an `error`
   * reply from `#receive`, before any task exists.
   *
   * The result still goes through rule N-1 (`errorCodeForPeer`) even though
   * both codes are legacy today: the rule is "call it wherever a code is put
   * on the wire", and the point of that is that the next code added does not
   * have to remember to.
   */
  #failureCodeFor(error: unknown, task: ActiveResidentTask): ProtocolErrorCode {
    const code =
      error instanceof NodeTurnExpiredError
        ? ProtocolErrorCode.E_TASK_TIMEOUT
        : ProtocolErrorCode.E_TASK_FAILED
    return errorCodeForPeer(code, task.channel.peerSupportedTypes)
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
    // Registered before the first await, because the two deletions above have
    // just made this task invisible to {@link #failActiveTasks}: it is in
    // neither map any more, yet its reply is on the wire with no receipt back.
    // This set is the only remaining record that the transport still owes us
    // something.
    // Written down *before* it goes on the wire. The whole failure this ledger
    // closes is "the reply left and its receipt never came back", and an entry
    // opened after the send would be missing for exactly the crash window that
    // matters.
    const receipt = this.#awaitReceipt(task, reply, this.#openDelivery(reply))
    // Tracked through a handle that cannot reject. The drain awaits these in
    // bulk, and the only way `#awaitReceipt` rejects is a caller's `onError`
    // sink throwing — which callers of *this* method still see, unchanged,
    // through the await below.
    const tracked = receipt.catch(() => {})
    this.#settling.add(tracked)
    try {
      await receipt
    } finally {
      this.#settling.delete(tracked)
    }
  }

  /** Send a terminal reply and wait for its receipt. Never rejects. */
  async #awaitReceipt(
    task: ActiveResidentTask,
    reply: QianmoMessage,
    deliveryId: string | undefined,
  ): Promise<void> {
    try {
      await task.channel.sendAndWait(reply, TASK_REPLY_RECEIPT_TIMEOUT_MS)
      this.#settleDelivery(deliveryId, 'delivered')
    } catch (error) {
      // Deliberately **not** retired. An unreceipted reply stays `attempting`
      // in the ledger, which is the entire deliverable: before this, the only
      // trace of a lost answer was this `onError` call, and the peer waited
      // forever for something nobody remembered owing it.
      this.#options.onError?.(error)
    } finally {
      task.releaseChannel()
    }
  }

  /**
   * Open a delivery obligation for a terminal reply and claim its first
   * attempt.
   *
   * Returns `undefined` when there is nothing to track — an address this node
   * cannot parse, or a ledger write that failed. Both degrade to exactly the
   * behaviour that predates this ledger, which is what fail-open means here.
   */
  #openDelivery(reply: QianmoMessage): string | undefined {
    const peerNode = parseAddress(reply.to)?.node
    if (peerNode === undefined) return undefined
    try {
      const deliveryId = this.#deliveries.open({
        taskId: reply.taskId,
        peerNode,
        envelope: reply as unknown as Record<string, unknown>,
      })
      if (deliveryId === undefined) return undefined
      this.#deliveries.attempt(deliveryId)
      return deliveryId
    } catch (error) {
      this.#options.onError?.(error)
      return undefined
    }
  }

  #settleDelivery(
    deliveryId: string | undefined,
    outcome: 'delivered' | 'failed',
  ): void {
    if (deliveryId === undefined) return
    try {
      this.#deliveries.settle(deliveryId, outcome)
    } catch (error) {
      this.#options.onError?.(error)
    }
  }

  /**
   * Hand a peer whatever this node still owes it (design §3.B1).
   *
   * Driven by contact **from** the peer, and that is not a convenience: rule
   * H-2 says a node never dials, so the moment a peer's channel exists is the
   * only moment an owed reply can leave. A peer that never comes back keeps its
   * entry until the attempt ceiling retires it.
   *
   * Each redelivery is a fresh envelope carrying the same `taskId` — never a
   * retransmission of the original, which would be refused as `E_TTL_EXPIRED`
   * long before a restart finished (protocol.md §14.4③).
   */
  #redeliverOwed(
    channel: TransportChannel,
    peerNode: string | undefined,
  ): void {
    if (peerNode === undefined) return
    let owed: readonly DeliveryLedgerEntry[]
    try {
      owed = this.#deliveries.outstanding(peerNode)
    } catch (error) {
      this.#options.onError?.(error)
      return
    }
    for (const entry of owed) {
      if (this.#redelivering.has(entry.deliveryId)) continue
      let attempt = 0
      try {
        attempt = this.#deliveries.attempt(entry.deliveryId)
      } catch (error) {
        this.#options.onError?.(error)
        continue
      }
      // `0` means the ledger just abandoned it at the ceiling, or it was gone
      // already. Either way there is nothing left to send.
      if (attempt === 0) continue
      const reply = redeliveryEnvelope(entry, channel)
      if (reply === undefined) {
        this.#abandonDelivery(
          entry.deliveryId,
          'stored reply is not a task.result this node can re-mint',
        )
        continue
      }
      this.#sendRedelivery(entry.deliveryId, channel, reply)
    }
  }

  /**
   * Answer `qianmo/notify` from the ACP child (design §4.1⑤, §2 end to end).
   *
   * The agent supplies **what** to say and nothing else. Who hears it is
   * derived here, from the task whose turn is running: the announcer is the
   * agent that was addressed, the recipient is whoever sent the work, and the
   * grouping key is that message's `contextId` — which for a watch job is the
   * job id (§4.1③), so every notification from one job groups under it without
   * the agent ever being told the id.
   *
   * A request with no running network task behind it is **refused, not
   * guessed**. That case is real — a turn started by local teammate mail has
   * no peer at all — and picking "the most recent hub" for it would send one
   * agent's finding to a console that never asked for it.
   */
  async #announce(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const sessionId = params['sessionId']
    if (typeof sessionId !== 'string') {
      return this.#notifyRefusal('the notify request named no session')
    }
    const turn = this.#turn.activeTurn(sessionId)
    const networkMsgId = turn?.networkMsgId
    if (networkMsgId === undefined) {
      return this.#notifyRefusal(
        'no network task is running in this session, so there is nobody to notify',
      )
    }
    const task = this.#tasksByMessage.get(networkMsgId)
    if (task === undefined || task.settled) {
      return this.#notifyRefusal(
        'the task behind this turn has already been answered',
      )
    }
    const peerNode = parseAddress(task.envelope.from)?.node
    if (peerNode === undefined) {
      return this.#notifyRefusal('the requesting peer has no parseable address')
    }
    const payload = {
      kind: params['kind'],
      severity: params['severity'],
      summary: params['summary'],
      observedAt: Date.now(),
      ...(typeof params['detail'] === 'string'
        ? { detail: params['detail'] }
        : {}),
      ...(typeof params['dedupKey'] === 'string'
        ? { dedupKey: params['dedupKey'] }
        : {}),
      // Correlation only, never a correlation key (rule C-1) — the notify
      // carries its own fresh `taskId`, and this says which work produced it.
      causeTaskId: task.envelope.taskId,
    }
    // Validated by the protocol's own predicate rather than by a check written
    // here: `kind` and `severity` are closed sets that live in
    // `@qianmo/protocol`, and a second spelling of them in the host is a second
    // thing to forget to update.
    if (!isNotifyPayload(payload)) {
      return this.#notifyRefusal(
        'the notification is missing a field or names an unknown kind or severity',
      )
    }
    const contextId =
      typeof task.envelope.contextId === 'string' &&
      task.envelope.contextId.length > 0
        ? task.envelope.contextId
        : task.envelope.taskId
    const outcome = await this.#notifier.announce({
      from: task.envelope.to,
      to: task.envelope.from,
      peerNode,
      contextId,
      payload,
      channel: task.channel,
    })
    const verdict: QianmoNotifyVerdict =
      outcome.status === 'rejected'
        ? { status: 'rejected', detail: outcome.reason }
        : outcome.status === 'queued' && outcome.retryAfterMs !== undefined
          ? { status: 'queued', retryAfterMs: outcome.retryAfterMs }
          : { status: outcome.status }
    return { ...verdict }
  }

  #notifyRefusal(detail: string): Record<string, unknown> {
    return { status: 'rejected', detail }
  }

  #abandonDelivery(deliveryId: string, reason: string): void {
    try {
      this.#deliveries.abandon(deliveryId, reason)
    } catch (error) {
      this.#options.onError?.(error)
    }
  }

  #sendRedelivery(
    deliveryId: string,
    channel: TransportChannel,
    reply: QianmoMessage,
  ): void {
    this.#redelivering.add(deliveryId)
    const release = channel.hold()
    const sent = (async () => {
      try {
        await channel.sendAndWait(reply, TASK_REPLY_RECEIPT_TIMEOUT_MS)
        this.#settleDelivery(deliveryId, 'delivered')
      } catch (error) {
        // Left outstanding again — the attempt was spent, and the ceiling is
        // what stops this rather than any judgement made here.
        this.#options.onError?.(error)
      } finally {
        this.#redelivering.delete(deliveryId)
        release()
      }
    })()
    // Tracked with the settle receipts so teardown drains it too: a redelivery
    // in flight is exactly as much "on the wire with no receipt yet" as a first
    // delivery is.
    this.#settling.add(sent)
    void sent.finally(() => {
      this.#settling.delete(sent)
    })
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

  /**
   * Let replies already on the wire be receipted before the transport carrying
   * them is torn down.
   *
   * {@link #failActiveTasks} settles everything still *active*, and awaits each
   * receipt as it goes. What it cannot reach is a task that entered
   * {@link #settleTask} a moment earlier: that one leaves both maps before its
   * first await, so the sweep walks straight past it, and `transport.stop()`
   * then closes its channel and rejects the outstanding wait with `transport
   * server closed before receipt`. The reply itself went to the socket long
   * before that — only the confirmation is lost — so what reached `onError` was
   * a fault that had not happened, on a schedule set by how fast the peer
   * answered. On a loaded runner that is a coin flip.
   *
   * Bounded by the same budget one receipt already gets: teardown will not wait
   * longer for confirmations than a single confirmation is allowed to take. A
   * peer that has gone away therefore costs at most that budget — which is what
   * {@link #failActiveTasks} has always cost on the same path.
   */
  async #drainReplyReceipts(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(resolve, TASK_REPLY_RECEIPT_TIMEOUT_MS)
      timer.unref?.()
    })
    // Re-read rather than snapshotted: the listener is still up here, so an
    // envelope arriving mid-drain can register and settle a task of its own.
    // Every wait carries its own timeout and nothing new is admitted once the
    // listener closes, so this terminates on its own; the deadline is the
    // backstop that keeps a peer that keeps talking from extending it.
    //
    // Notifications are drained in the same breath: one on the wire is in
    // exactly the position a reply is — sent, unreceipted — and leaving it out
    // would put the fault this method exists to stop back on the other path.
    // Its own settle never rejects, so it needs no guard of its own.
    const drained = (async () => {
      while (this.#settling.size > 0) await Promise.all([...this.#settling])
      await this.#notifier.settle()
    })()
    try {
      await Promise.race([drained, deadline])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  stop(): void {
    if (this.#stopping) return
    this.#stopping = true
    this.#poller?.stop()
    this.#poller = null
    this.#closeWitness()
    this.#supervisor.stop()
  }

  /**
   * Remove peer connections that the shared certificate directory just
   * invalidated. The resident owns the inbound transport handle, while the
   * CLI owns directory polling; keeping this hand-off explicit means neither
   * layer silently assumes the other will terminate already-authenticated
   * links.
   */
  closePeers(peerNodes: Iterable<string>): void {
    this.#transport?.closePeers(peerNodes)
  }

  closePeerCredentials(
    credentials: Iterable<{
      readonly node: string
      readonly source: string
      readonly id: string
    }>,
  ): void {
    this.#transport?.closePeerCredentials(credentials)
  }

  #closeWitness(): void {
    if (this.#witnessClosed) return
    this.#witnessClosed = true
    try {
      this.#options.witness?.close()
    } catch (error) {
      try {
        this.#options.onError?.(error)
      } catch {
        // Teardown must continue even when an injected close hook is invalid.
      }
    }
  }

  /**
   * Witness I/O is best-effort evidence collection, never an admission gate.
   *
   * The scheduler coalesces its own in-flight attempt. Detaching it here lets
   * the existing mailbox poll continue when an endpoint is half-open; a custom
   * scheduler rejection is still observable through the resident error sink.
   */
  #triggerWitnessTick(): void {
    const witness = this.#options.witness
    if (witness === undefined || this.#stopping) return
    try {
      void witness.tick().catch(error => {
        if (this.#stopping) return
        try {
          this.#options.onError?.(error)
        } catch {
          // An observer must not turn witness outage into a resident outage.
        }
      })
    } catch (error) {
      try {
        this.#options.onError?.(error)
      } catch {
        // The same fail-open rule covers an invalid injected scheduler.
      }
    }
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
        // Both of these have to finish while the transport is still up: the
        // sweep above needs a channel to send terminal replies on, and this one
        // needs it to carry the receipts for replies sent before either ran.
        await this.#drainReplyReceipts()
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
        onExtMethod: async (method, params) =>
          method === ACP_NOTIFY_METHOD
            ? await this.#announce(params)
            : undefined,
      })
      this.#turn.replaceConnection(connection)

      const sessions = new ResidentSessionManager({
        connection,
        store: this.#sessions,
        agents: this.#options.agents,
        // GC exemption ③: a session the admission ledger still has a pending
        // record for is holding a message this node already promised to
        // handle. Materialize every agent's ledger, not just the ones already
        // opened, or the exemption silently covers a subset.
        pendingSessionIds: () =>
          pendingSessionIds(
            this.#options.agents.map(agent => this.#ledger(agent.agent)),
          ),
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
        formatPrompt: (messages, scope) =>
          this.#assemblePrompt(messages, scope),
        accepts: message => !isStructuredProtocolMessage(message.text),
        selectSnapshot: selectResidentSnapshot,
        correlationId: networkMessageId,
        contextId: networkContextId,
        deadlineOf: message => this.#taskDeadlineOf(message),
        sessions,
        timings: this.#timings,
        gate: this.#gate,
        agents: this.#options.agents.map(agent => ({
          agent: agent.agent,
          ledger: this.#ledger(agent.agent),
        })),
        onRead: (input, readAt) => this.#ackTask(input, readAt),
        onAbandoned: async (input, attempts, reason) => {
          await this.#abandonTask(input, attempts, reason)
        },
        onBreakerError: error => this.#options.onError?.(error),
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
        ...(this.#options.tls === undefined ? {} : { tls: this.#options.tls }),
        ...(this.#options.certificateNotAfter === undefined
          ? {}
          : { certificateNotAfter: this.#options.certificateNotAfter }),
        ...(this.#options.handshakeSigning === undefined
          ? {}
          : { signing: this.#options.handshakeSigning }),
      })
      this.#transport = transport

      poller = new ResidentPoller({
        poll: async () => {
          // Cheap on all but one call in sixty; see the constant's comment for
          // why the cadence is not configurable.
          this.#lifecycle.heartbeat()
          // The witness handles its own 60 s period. Starting it on this
          // existing timer avoids another resident timer, but it must never
          // hold up mailbox admission while its second location is half-open.
          this.#triggerWitnessTick()
          await runtime?.pollAll()
        },
        // The admission loop is the only thing that turns an unread mailbox
        // entry into a turn, so skipping it here is what makes "no new work"
        // true at the source — including for mail that arrived before the
        // brake was pulled. Nothing running is touched.
        paused: () => this.#estop.engaged(),
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

  /**
   * When the task behind one mailbox entry stops being worth a turn, in this
   * process's clock.
   *
   * Two halves, both load-bearing:
   *
   * - The deadline comes off the envelope the adapter already embedded in the
   *   entry — the same place `networkMessageId` and `networkContextId` read
   *   from — so nothing new travels for it.
   * - It is **shifted onto the local clock** before it leaves, exactly the way
   *   `InboundAdapter` reports its own `deadlineAt`. The freeze-aware clock
   *   subtracts time the node spent paused, so comparing a raw envelope
   *   deadline against `Date.now()` would declare every in-flight task dead in
   *   the same millisecond a suspended node came back (protocol.md §5.3).
   */
  #taskDeadlineOf(message: ResidentMailboxMessage): number | undefined {
    const envelope = networkEnvelope(message)
    if (envelope === undefined) return undefined
    const createdAt = envelope.createdAt
    if (typeof createdAt !== 'number' || typeof envelope.taskTtlMs !== 'number')
      return undefined
    // The wrapper holds a serialized envelope, so this is a re-typing of what
    // it already is rather than a claim about it — and the two fields
    // `taskExpiresAt` reads have just been checked. Going through the protocol
    // helper keeps the deadline formula spelled once.
    const expiresAt = taskExpiresAt(envelope as unknown as QianmoMessage)
    return expiresAt + Date.now() - this.#deadlineClock.nowFor(createdAt)
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
