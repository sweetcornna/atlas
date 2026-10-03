// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
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
  type ResidentTurnProgress,
  type ResidentUpstreamHealth,
} from '@qianmo/resident'
import type {
  DeliveryLedgerEntry,
  ResidentAssembledPrompt,
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
  type EmbeddingProvider,
  FileEmbeddingUsageMeter,
  type HybridConfig,
  InMemoryVectorIndex,
  type RetrievalMode,
} from '@qianmo/recall'
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
import { occConfigPath } from '../../config/paths.js'
import { buildCliLaunch, spawnCli } from '../../utils/process/cliLaunch.js'
import { writePrivateFileAtomicSync } from '../../utils/secureStorage/atomicWrite.js'
import {
  assembleResidentPrompt,
  assembleResidentPromptAsync,
} from './residentPrompt.js'
import { residentAcpEnvironment } from './residentAcpEnv.js'
import { ACP_NOTIFY_METHOD, type QianmoNotifyVerdict } from './notifyWire.js'

interface QianmoResidentAgentConfig {
  readonly agent: string
  readonly cwd: string
}

/**
 * What `commitPendingProviderConfig()` (`providers/node.ts`, P18.2) can
 * answer, restated structurally: this module never imports the write path
 * itself — the CLI handler hands it over (`ResidentProviderNode`), so the
 * provider stack stays out of this file's module graph.
 */
type ResidentProviderCommit =
  | { readonly status: 'none' }
  | { readonly status: 'busy' }
  | {
      readonly status: 'committed'
      readonly requestId: string
      readonly sessions: 'keep' | 'reset'
      readonly recovered: boolean
    }
  | {
      readonly status: 'conflict'
      readonly requestId: string
      readonly diffKeys: readonly string[]
    }
  | { readonly status: 'refused'; readonly message: string }
  | { readonly status: 'bad-pending'; readonly movedTo: string }
  | {
      readonly status: 'write-failed'
      readonly requestId: string
      readonly message: string
    }

/**
 * The node's provider write path, as the resident uses it. The functions are
 * the ones `providers/node.ts` exports, under the same names; see that module's
 * header for the contract.
 */
export interface ResidentProviderNode {
  /** A single `stat`. */
  hasPendingProviderConfig(): boolean
  commitPendingProviderConfig(): ResidentProviderCommit
  recordProviderGeneration(input: {
    readonly generation: number
    readonly env?: Readonly<Record<string, string | undefined>>
  }): unknown
  readProviderState(): {
    readonly applied: { readonly requestId: string } | null
    readonly pending: { readonly requestId: string } | null
  }
  currentManagedHash(): string
}

/** What a provider switch would cut off if the ACP child stopped now. */
interface ResidentInFlight {
  /** A turn is running in the node gate. */
  readonly turns: number
  /** Turns queued behind it. */
  readonly queued: number
  /** Network tasks registered and not yet answered. */
  readonly tasks: number
  /** `deliver()` calls still on their way to a turn. */
  readonly deliveries: number
  /** Admission polls in progress (mailbox read → turn submitted). */
  readonly polls: number
  /** Admission-ledger records not yet read (recovery still owes a turn). */
  readonly admissions: number
  /** A generation is being started. */
  readonly starting: boolean
}

/** Told once per provider configuration this resident takes on. */
export interface ResidentProviderSwitchEvent {
  readonly requestId: string
  readonly sessions: 'keep' | 'reset'
  /** Finished something a crash had interrupted. */
  readonly recovered: boolean
  /**
   * `switch`: committed at an idle boundary, ACP child recycled.
   * `startup`: committed before the first generation (crash roll-forward).
   * `reconcile`: found already applied at startup without its session policy
   * having been carried out here; sessions were reset (R-7 default).
   */
  readonly via: 'switch' | 'startup' | 'reconcile'
}

/**
 * `occConfigPath('resident', 'provider-switch.json')`: what this resident is
 * doing about the node's provider configuration, for `qm provider status`
 * (P18.7) to read next to `generation.json`. Written only when there is
 * something to say — a pending intent, a commit outcome, a startup
 * reconciliation — so a node that never has a pending intent never has one.
 */
interface ResidentProviderSwitchStatus {
  readonly v: 1
  /** The resident that wrote it; a stale file names a dead pid. */
  readonly pid: number
  readonly updatedAt: string
  readonly waiting: {
    readonly requestId: string | null
    readonly since: string
    readonly inFlight: ResidentInFlight
    readonly alertedAt: string | null
  } | null
  readonly last: {
    readonly at: string
    readonly outcome: string
    readonly requestId: string | null
    readonly sessions: 'keep' | 'reset' | null
    readonly detail: string | null
  } | null
  /**
   * The applied `requestId` whose session policy this resident has carried
   * out. A managed node whose `state.json` names a different one was committed
   * without the resident seeing the result, so the policy is unknown.
   */
  readonly reconciledRequestId: string | null
}

/** §2.7: the resident stats for a pending intent this often. */
const DEFAULT_PROVIDER_POLL_INTERVAL_MS = 5_000

/** R-6: how long a pending intent waits for idle before it is reported. */
const DEFAULT_PROVIDER_MAX_WAIT_MS = 30 * 60_000

/**
 * How long a generation retired for a provider switch keeps running, already
 * cut off from deliveries, before it is sent SIGTERM.
 *
 * The child writes its transcript through a queue drained every 100 ms
 * (`transcriptWriter.ts`), and its SIGTERM handler exits without draining it
 * (`acp/entry.ts`). A switch fires exactly when a turn has just ended, so
 * without this the answer to that turn is missing from the session a `keep`
 * switch resumes — measured with the real child. Ten drain intervals.
 */
const DEFAULT_PROVIDER_RETIRE_GRACE_MS = 1_000

interface QianmoResidentOptions {
  readonly node: string
  readonly team: string
  readonly agents: readonly QianmoResidentAgentConfig[]
  /**
   * 放宽到「工作目录之内的编辑自动放行」（`--allow-workspace-edits`）。
   *
   * 缺省不给，节点保持 `dontAsk`——不提示、未预批准即拒绝。放宽是显式动作：它改的
   * 是这台节点的权限姿态，不该由「跑的是哪一版产物」决定。
   */
  readonly allowWorkspaceEdits?: boolean
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
   * Where upstream HTTP statuses reported by the ACP child are remembered, so
   * the inactivity watchdog can say *why* a turn went quiet (design §3.B10,
   * issue #37). Injected by the host because the startup credential probe
   * writes into the same memory; omitted, the node makes its own.
   */
  readonly upstreamHealth?: ResidentUpstreamHealth
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
  /**
   * The semantic overlay on memory recall (`docs/dev/memory-m1.md` §5,
   * P16.6). **Off when absent, and absent by default**: no embedding call, no
   * usage file, the synchronous assembly of today and admission records
   * without a `retrieval` field — byte for byte the M0 path.
   *
   * Given, every turn is assembled in two stages (batch, then an awaited
   * `recallHybrid`, then the scan) and its `retrieval` goes into the admission
   * record. Full mode still never embeds; a ranked recall fuses only when the
   * index covers enough of the candidates and the day's token budget allows
   * it, and otherwise falls back to the deterministic block. The budget is
   * counted in tokens, per node and UTC day, in a file under the identity
   * config root that a restart does not reset; `dailyTokenLimit: 0` spends
   * nothing. Fallbacks are reported on `onError`.
   *
   * No command-line switch or configuration file sets this yet: real
   * embedding providers and their operator-only switch are P16.7, and the
   * in-process index starts cold on every restart until P16.8 persists it.
   */
  readonly semanticRecall?: {
    readonly embedder: EmbeddingProvider
    readonly dailyTokenLimit: number
    readonly config?: Partial<HybridConfig>
  }
  readonly onError?: (error: unknown) => void
  readonly onReady?: (address: {
    readonly port?: number
    readonly unix?: string
    readonly url?: string
  }) => void
  readonly spawnAcp?: () => ChildProcess
  /**
   * Restart policy for the ACP child; both fields default to the supervisor's
   * own constants.
   *
   * Exposed because parking became *visible*. It used to end the process, so
   * how long it took to get there was an internal detail nobody could act on.
   * Now a parked node stays up and refuses turns with a reason, which makes
   * "how many rapid failures before we stop trying" an operational choice —
   * and lets a test reach the degraded state without waiting out the
   * production backoff ladder.
   */
  readonly acpRestart?: {
    readonly initialBackoffMs?: number
    readonly maxRapidFailures?: number
  }
  /**
   * The node's provider write path (`providers/node.ts`), which turns on hot
   * switching (design `providers-console-m1.md` §2.7). **Absent, nothing
   * below happens** — no poll, no commit, no generation record.
   *
   * Present, a pending intent is committed at a generation boundary and only
   * there: once at startup before the first ACP child (crash roll-forward),
   * and afterwards when the node is idle, immediately followed by a recycle of
   * the ACP child. A node with no pending intent is never recycled and its
   * child's environment is untouched; the only trace is `generation.json`.
   */
  readonly providerNode?: ResidentProviderNode
  readonly providerSwitch?: {
    /** Pending-intent stat interval; `0` turns the poll off. Default 5 s. */
    readonly pollIntervalMs?: number
    /** When a waiting intent is reported. Default 30 min; never a kill. */
    readonly maxWaitMs?: number
    /** Clock for the wait above. Default `Date.now`. */
    readonly now?: () => number
    /** Grace before a switch's old child is terminated. Default 1 s. */
    readonly retireGraceMs?: number
  }
  /**
   * Something about the provider configuration an operator has to act on:
   * a refused or conflicting commit, a 30-minute wait, a parked agent.
   * Absent, these go to {@link onError}.
   */
  readonly onProviderAlert?: (message: string) => void
  /** A provider configuration was committed (the CLI re-runs its probe). */
  readonly onProviderSwitched?: (event: ResidentProviderSwitchEvent) => void
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

/**
 * The ACP child, told which memory root this host serves memory from so its
 * hardline refuses that tree too — not only the default it would derive on
 * its own (`residentAcpEnv.ts`).
 */
function defaultSpawnAcp(memoryRoot: string): ChildProcess {
  const launch = buildCliLaunch(['--acp'], {
    env: residentAcpEnvironment(process.env, { memoryRoot }),
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
  /**
   * True between `#registerTask` and the end of `deliver()` — the window in
   * which this task belongs to no ACP generation yet. See `#failActiveTasks`.
   */
  delivering: boolean
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

/**
 * What a peer is told when this node cannot run an agent turn at all.
 *
 * Deliberately not "not ready": the node *is* ready, it just has no agent.
 */
const RESIDENT_AGENT_UNAVAILABLE =
  'resident agent is unavailable on this node (the ACP child could not be started); delivery, receipts and audit still work'

/**
 * What a peer is told when the agent is merely between generations.
 *
 * A different sentence from {@link RESIDENT_AGENT_UNAVAILABLE} on purpose: one
 * says "come back", the other says "do not". Collapsing them would make an
 * ordinary restart look like a node that needs an operator.
 */
const RESIDENT_AGENT_RESTARTING =
  'resident agent is restarting and did not come up in time; the node is reachable, retry this task'

/**
 * How long a delivery waits for an agent that is still coming up.
 *
 * Bounded **below** the 5 s receipt budget every caller in this repository
 * uses ({@link TASK_REPLY_RECEIPT_TIMEOUT_MS}, and the transport outbox's own
 * default). Waiting longer than the sender does is the worst of both: the
 * sender times out and gives up while this node goes on to accept the message
 * and run the turn, so the work happens and nobody is told.
 */
const RUNTIME_WAIT_MS = 3_000

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
  /** The memory root in use, handed to the ACP child's hardline as well. */
  readonly #memoryRoot: string
  #stopping = false
  #releaseStop: (() => void) | null = null
  /** Woken when `#runtime` becomes available; see `#runtimeForDelivery`. */
  #runtimeWaiters: Array<() => void> = []
  /** The ACP child backing `#runtime`; see `#runtimeIsLive`. */
  #runtimeChild: ChildProcess | null = null
  #witnessClosed = false
  /** Generations this process has started (`generation.json`, §2.4). */
  #generation = 0
  /** Between the start of `#startAcp` and its runtime being ready. */
  #generationStarting = false
  /** `deliver()` calls not yet past the hand-off to a turn. */
  #deliveriesInFlight = 0
  /** Admission polls not yet past submitting their turn. */
  #pollsInFlight = 0
  /** Set once startup has rolled a pending intent forward (§2.6 step 5). */
  #providerReady = false
  #providerTimer: ReturnType<typeof setInterval> | null = null
  /** The pending intent being waited on, if any. */
  #providerWaiting: ProviderWaiting | null = null
  /** In-memory copy of `provider-switch.json`, once read or written. */
  #switchStatus: ResidentProviderSwitchStatus | undefined
  /** Set just before a switch's recycle; read once by the generation it stops. */
  #retireForSwitch = false

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
    this.#memoryRoot = options.memoryRoot ?? defaultMemoryRoot()
    const semantic = options.semanticRecall
    this.#memory = new ResidentMemorySidecar({
      store: new FileMemoryStore({
        root: this.#memoryRoot,
      }),
      onError: error => this.#options.onError?.(error),
      ...(semantic === undefined
        ? {}
        : {
            semantic: {
              embedder: semantic.embedder,
              index: new InMemoryVectorIndex(),
              meter: new FileEmbeddingUsageMeter({
                dailyTokenLimit: semantic.dailyTokenLimit,
              }),
              ...(semantic.config === undefined
                ? {}
                : { config: semantic.config }),
            },
            onRetrievalEvent: event =>
              this.#options.onError?.(
                new Error(`memory semantic recall: ${JSON.stringify(event)}`),
              ),
          }),
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
        ...(options.upstreamHealth === undefined
          ? {}
          : { upstreamHealth: options.upstreamHealth }),
        // 一轮跑到哪了，回给**问这一轮的那个人**。端口自己不知道对端是谁，
        // 这一格就是它和网络之间那条线。
        // **排到下一个 tick 再发**，不在 `session/update` 的处理栈上做这件事。
        // `#pushProgress` 一路下去是 `FileDeliveryLedger` 的三次同步 append 加
        // 一次全量积压排序，而调它的那条路以前只做一件事：戳一下存活看门狗。
        // 那条路同时喂着看门狗与首字时延，把每个工具调用都变成几次阻塞写盘，
        // 就是拿 ACP 流的实时性换一条装饰行。顺序不受影响：setImmediate 是 FIFO。
        onProgress: progress => {
          setImmediate(() => {
            void this.#pushProgress(progress)
          })
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
      ...(options.acpRestart?.initialBackoffMs === undefined
        ? {}
        : { initialBackoffMs: options.acpRestart.initialBackoffMs }),
      ...(options.acpRestart?.maxRapidFailures === undefined
        ? {}
        : { maxRapidFailures: options.acpRestart.maxRapidFailures }),
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
    //
    // A statement of its own, never an argument to `onPriorLife?.(…)`: an
    // optional call short-circuits its arguments too, so with no observer the
    // sentinel was never started. That is every production start — `qm
    // resident` passes none — and it meant no life stamped `running`, so a
    // SIGKILL left nothing to find (validation report 2026-09-08, B-1).
    const prior = this.#lifecycle.start()
    this.#options.onPriorLife?.(prior)
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
    // Bound before the agent, and outliving it. See `#startTransport`.
    this.#transport = this.#startTransport()
    // Before the first ACP child: an intent a crash left behind is committed
    // now, while no child can be reading settings (§2.6 step 5).
    this.#prepareProviderConfig()
    this.#startProviderPoll()
    try {
      await this.#supervisor.run()
      // `supervisor.run()` returning means one of two very different things.
      //
      // Stopped: we are shutting down, fall through and tear the node down.
      //
      // **Parked**: the ACP child failed to start five times in a row and the
      // supervisor gave up on it. That says nothing about the rest of this
      // node — the listener is bound, the audit chain is intact, the delivery
      // ledger is loaded, and peers can still reach us. Tearing all of that
      // down because the agent could not start is how a node with an expired
      // credential *disappears from the network* instead of reporting that its
      // agent is unavailable. Inbound task requests get a rejected receipt
      // carrying the reason (see `deliver`); everything that never needed a
      // model keeps working. Stay up until someone actually stops us.
      if (!this.#stopping) {
        this.#options.onError?.(
          new Error(
            'resident is degraded: the ACP child could not be started, so no ' +
              'agent turn can run here. Delivery, receipts and audit continue; ' +
              'inbound task requests will be refused with a reason. The node ' +
              'stays reachable so peers can tell "agent unavailable" from ' +
              '"node gone" — restart it once the cause is fixed.',
          ),
        )
        await this.#awaitStop()
      }
    } finally {
      this.#stopping = true
      this.#stopProviderPoll()
      // Before the listener goes, not after. The last generation's own
      // teardown already drained what *it* sent, but a degraded node keeps
      // answering after that: every refusal from `#receive` is a reply on the
      // wire waiting for a receipt, and tearing the transport out from under
      // one turns a delivered answer into a spurious `transport server closed
      // before receipt`. Cheap when there is nothing outstanding.
      await this.#drainReplyReceipts()
      await this.#stopTransport()
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
    // Counted for the provider switch's idle check (§2.7): from here until the
    // turn is handed off, this delivery belongs to whichever generation it
    // finds, and the switch must not pull that generation out from under it.
    this.#deliveriesInFlight += 1
    try {
      return await this.#deliverDurably(message, verified)
    } finally {
      this.#deliveriesInFlight -= 1
    }
  }

  async #deliverDurably(
    message: QianmoMessage,
    verified: InboundVerification,
  ): Promise<InboundDelivered> {
    const runtime = await this.#runtimeForDelivery()
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
    // Counted until the poll has handed its turn to the gate, for the provider
    // switch's idle check (§2.7). Still not awaited.
    void this.#trackPoll(runtime.deliver(message)).catch(async error => {
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
      // Rule N-1 on the way out, the same call the two refusals above make.
      // Every code reachable here is legacy today, so it is an identity now;
      // it is written down so a post-legacy delivery code added later cannot
      // reach an old peer as a payload it reads as malformed.
      const code = errorCodeForPeer(
        error instanceof ResidentDeliveryError
          ? error.code
          : ProtocolErrorCode.E_UNDELIVERABLE,
        context.channel.peerSupportedTypes,
      )
      const reason = error instanceof Error ? error.message : String(error)
      if (task !== undefined) {
        await this.#settleTask(task, errorReply(message, code, reason))
      } else if (message.type !== MessageType.Error) {
        // issue #34. A refusal from the delivery layer — `E_UNKNOWN_AGENT`, a
        // mailbox write that failed — used to be answered only for
        // `task.request`, because the answer rode on the task. Everything
        // else, `wake` above all, got silence: the sender saw a receipt
        // flattened to `E_UNDELIVERABLE` (`packages/transport/src/receiver.ts`
        // presses every handler throw into that one code) and had to read this
        // node's audit trail to learn why — the "log into the box to find
        // out" shape issues #13 / #9 / #29 exist to close.
        //
        // Who can read it is settled a layer down and does not depend on this
        // line: `startTransportServer` dispatches an `Envelope` frame only
        // after `ws.data.authed` is set, and `ws.data.channel` is assigned
        // nowhere but the auth-success branch. So this envelope can only reach
        // a peer that already passed PSK / Ed25519 — a stranger never gets to
        // send an envelope at all, and cannot dial for node state.
        //
        // Not the durable `#settleTask` path: there is no task to settle and
        // no owed answer to redeliver in a later life. Best-effort on the
        // connection the message arrived on is exactly right, because that is
        // the connection the sender is still holding open for its receipt.
        //
        // An inbound `error` is the one type left out, because this failure is
        // *stable* — an agent this node does not host will still not exist on
        // the next bounce — so two misconfigured nodes answering each other's
        // `error` would never converge, and nothing else would stop them:
        // `isReplyType` exempts `error` from the `(handler, taskId)` revisit
        // key by design (C-1), which is the loop net. Do not bounce a bounce.
        context.channel.send(errorReply(message, code, reason))
      }
      throw error
    } finally {
      if (task !== undefined) task.delivering = false
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
      delivering: true,
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
  ): string | Promise<ResidentAssembledPrompt> {
    if (this.#options.semanticRecall !== undefined) {
      return this.#assembleTwoStage(messages, scope)
    }
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
   * The semantic overlay's assembly (`memory-m1.md` §5.4): the batch is the
   * question, so it is rendered first; the turn then waits for the overlay,
   * bounded by its timeout; the scan runs on the finished string. The
   * retrieval mode rides out with the prompt so the reader records both in
   * the same admission record.
   */
  async #assembleTwoStage(
    messages: readonly ResidentMailboxMessage[],
    scope: ResidentPromptScope,
  ): Promise<ResidentAssembledPrompt> {
    let retrieval: RetrievalMode | undefined
    const prompt = await assembleResidentPromptAsync({
      messages,
      renderMemory: async base => {
        const memory = await this.#memory.renderHybrid(scope, base)
        retrieval = memory.retrieval
        return memory.block
      },
      onFinding: error => this.#options.onError?.(error),
    })
    return retrieval === undefined ? { prompt } : { prompt, retrieval }
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

  /**
   * Send one step of a running turn to whoever asked for that turn.
   *
   * The same road {@link #announce} takes, minus the parts that only make
   * sense for an agent calling the notify tool by hand: there is no session
   * to look up (the port already knows which turn raised this) and no payload
   * to validate against a hostile caller (it was built two frames down, in
   * this process).
   *
   * **Silence is a correct outcome here.** A turn whose task has already been
   * answered, or whose peer is gone, has nobody left to tell — and a step is
   * not worth an error path of its own: it is decoration on an answer that is
   * already on its way by another route.
   */
  async #pushProgress(progress: ResidentTurnProgress): Promise<void> {
    const task = this.#tasksByMessage.get(progress.networkMsgId)
    if (task === undefined || task.settled) return
    const peerNode = parseAddress(task.envelope.from)?.node
    if (peerNode === undefined) return
    const payload = {
      kind: 'task',
      severity: progress.severity,
      summary: progress.summary,
      observedAt: Date.now(),
      dedupKey: progress.dedupKey,
      ...(progress.detail === undefined ? {} : { detail: progress.detail }),
      // Correlation only, never a correlation key (rule C-1).
      causeTaskId: task.envelope.taskId,
    }
    if (!isNotifyPayload(payload)) return
    const contextId =
      typeof task.envelope.contextId === 'string' &&
      task.envelope.contextId.length > 0
        ? task.envelope.contextId
        : task.envelope.taskId
    try {
      await this.#notifier.announce({
        from: task.envelope.to,
        to: task.envelope.from,
        peerNode,
        contextId,
        payload,
        channel: task.channel,
      })
    } catch (error) {
      this.#options.onError?.(error)
    }
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
      [...this.#tasksByTask.values()]
        // A task still inside `deliver()` has not been handed to the
        // generation that is dying — it is waiting for the *next* one
        // (`#runtimeForDelivery`), and its message is not in the mailbox yet.
        // Failing it here answers the sender `task.result{failed}` for a turn
        // that then goes on to run and succeed on the new generation, and the
        // real answer is dropped because the task left both maps. This window
        // only exists because the listener now outlives the ACP child: before
        // that, nothing could arrive between the death and the restart.
        .filter(task => !task.delivering)
        .map(task =>
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
    this.#stopProviderPoll()
    this.#poller?.stop()
    this.#poller = null
    this.#closeWitness()
    this.#supervisor.stop()
    // Wakes `run()` when it is parked-but-alive; a no-op on every other path.
    this.#releaseStop?.()
  }

  /**
   * The runtime to hand this delivery to, waiting briefly if the agent is
   * still coming up.
   *
   * The listener is bound for the node's whole life now, so a peer can arrive
   * in two windows where it previously could not: while the first ACP child is
   * still starting, and during the backoff between restarts. Refusing those
   * deliveries would trade one wrong answer for another — the node is not
   * broken, the agent is seconds away — so they wait.
   *
   * **Parked is different and must not wait**: the supervisor has given up, so
   * no amount of waiting produces a runtime. Answer immediately with the
   * reason, which is what lets a peer tell "agent unavailable" from "node
   * gone". Same for a node already stopping.
   */
  async #runtimeForDelivery(): Promise<ResidentNodeRuntime> {
    const ready = this.#runtimeIsLive() ? this.#runtime : null
    if (ready !== null) return ready
    if (this.#supervisor.parked || this.#stopping) {
      throw new Error(RESIDENT_AGENT_UNAVAILABLE)
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this.#runtimeWaiters = this.#runtimeWaiters.filter(w => w !== wake)
        resolve()
      }, RUNTIME_WAIT_MS)
      timer.unref?.()
      const wake = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.#runtimeWaiters.push(wake)
    })
    const runtime = this.#runtimeIsLive() ? this.#runtime : null
    if (runtime !== null) return runtime
    throw new Error(
      this.#supervisor.parked || this.#stopping
        ? RESIDENT_AGENT_UNAVAILABLE
        : RESIDENT_AGENT_RESTARTING,
    )
  }

  /**
   * Whether `#runtime` still has a live ACP child behind it.
   *
   * `#runtime` is retired when the child's `closed` promise settles, but that
   * is an event-loop turn or more after the process actually dies — and with
   * the listener no longer dying alongside it, a peer can deliver inside that
   * gap. Handing it to the doomed generation costs a failed turn and a second
   * `read` ack for one task, which is protocol-visible noise for something the
   * node already knows. `killed` / `exitCode` / `signalCode` are set
   * synchronously, so asking is exact and free.
   */
  #runtimeIsLive(): boolean {
    if (this.#runtime === null) return false
    const child = this.#runtimeChild
    if (child === null) return true
    return !child.killed && child.exitCode === null && child.signalCode === null
  }

  /** Resolves when {@link stop} is called. */
  #awaitStop(): Promise<void> {
    return new Promise<void>(resolve => {
      if (this.#stopping) {
        resolve()
        return
      }
      this.#releaseStop = resolve
    })
  }

  async #stopTransport(): Promise<void> {
    const transport = this.#transport
    this.#transport = null
    try {
      await transport?.stop()
    } catch (error) {
      this.#options.onError?.(error)
    }
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

  /**
   * Bind the inbound listener, once, for this node's whole life.
   *
   * **It is deliberately not owned by the ACP child.** It used to be: the
   * listener was created at the end of `#startAcp`, after `sessions.start()`,
   * and torn down when that child stopped. Two consequences, both bad, both
   * invisible until this repository's CI was first able to run:
   *
   *   · Every ACP restart dropped the listener. A peer dialling during the
   *     backoff found nobody, which reads as "the node is gone" rather than
   *     "the agent is restarting".
   *   · A child that could not start at all — an expired or missing model
   *     credential is the ordinary case — meant the listener was **never**
   *     bound: `sessions.start()` throws before that line is reached, the
   *     supervisor retries five times, parks, and back then that ended the
   *     process. The node vanished from the network because it could not
   *     reach a model, taking the delivery, receipt and audit faces — none of
   *     which ever needed one — down with it.
   *
   * A node whose agent is unavailable is not the same thing as a node that is
   * down, and the network is entitled to be told which one it is: inbound
   * `task.request` gets a rejected receipt carrying
   * {@link RESIDENT_AGENT_UNAVAILABLE} (see {@link deliver}) instead of a
   * refused connection.
   */
  #startTransport(): TransportServerHandle {
    const transport = startTransportServer({
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
    // Reported here rather than at the end of `#startAcp`: reachability is a
    // property of the listener, and the address is knowable the moment it
    // binds. A node whose agent has not come up yet is still addressable, and
    // saying so is the difference between "restarting" and "gone".
    this.#options.onReady?.({
      ...(transport.port === undefined ? {} : { port: transport.port }),
      ...(transport.unix === undefined ? {} : { unix: transport.unix }),
      ...(transport.url === undefined ? {} : { url: transport.url }),
    })
    return transport
  }

  /**
   * One generation: record what it is about to load, then spawn it.
   *
   * The record comes first because `loadedHash` has to describe the child
   * that reads settings next, and the switch never commits while a
   * generation is starting (`#inFlightWork`), so nothing changes in between.
   */
  async #startAcp(): Promise<ResidentChildConnection> {
    this.#generation += 1
    this.#recordProviderGeneration()
    this.#generationStarting = true
    try {
      return await this.#spawnGeneration()
    } finally {
      this.#generationStarting = false
    }
  }

  async #spawnGeneration(): Promise<ResidentChildConnection> {
    const child =
      this.#options.spawnAcp?.() ?? defaultSpawnAcp(this.#memoryRoot)
    const closed = childClosed(child)
    void closed.catch(() => {})
    // Retire the runtime the moment the child is gone, not when the supervisor
    // gets around to calling `stop()`. With the listener no longer dying with
    // the child, a peer can deliver in that gap, and a runtime whose ACP
    // connection is already dead would take the turn and fail it. Nulling here
    // sends that delivery down the same path as any other mid-restart arrival:
    // wait for the next generation (`#runtimeForDelivery`).
    const retireRuntime = (): void => {
      if (runtime === null || this.#runtime !== runtime) return
      this.#runtime = null
      this.#runtimeChild = null
    }
    // `then(f, f)`, not `finally`: `closed` rejects on a non-zero exit, and a
    // `finally` chain would re-raise that rejection with nobody attached.
    void closed.then(retireRuntime, retireRuntime)
    let runtime: ResidentNodeRuntime | null = null
    let poller: ResidentPoller | null = null
    let stopping: Promise<void> | null = null
    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        if (this.#runtime === runtime) this.#runtime = null
        poller?.stop()
        if (this.#poller === poller) this.#poller = null
        const grace = this.#takeRetireGrace()
        await this.#failActiveTasks('resident ACP connection closed')
        // Both of these need the transport up. It is: the listener is owned by
        // `run()` now, not by this child, so it outlives every ACP restart and
        // every park. Before that change it was torn down here and rebuilt by
        // the next `#startAcp`, which is why a child that could not start left
        // the node with no listener at all.
        await this.#drainReplyReceipts()
        if (grace > 0) await new Promise(resolve => setTimeout(resolve, grace))
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
      })()
      return stopping
    }

    try {
      const streams = webStreams(child)
      const connection = new ResidentAcpConnection({
        stream: createResidentAcpStream(streams.writable, streams.readable),
        ...(this.#options.allowWorkspaceEdits === true
          ? { permissionMode: 'acceptEdits' as const }
          : {}),
        onInputAccepted: async params => {
          await this.#turn.handleInputAccepted(params)
        },
        onActivity: this.#options.onActivity,
        onSessionUpdate: params => {
          this.#turn.handleSessionUpdate(params)
        },
        // The ACP child is the only process on this node that talks to a model
        // endpoint, so it is the only one that can see a refused credential.
        // Without this the watchdog reports the resulting silence as "no
        // activity" and every reader goes looking at the model (issue #37).
        onUpstreamStatus: params => {
          this.#turn.handleUpstreamStatus(params)
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
          this.#checkProviderSoon()
        },
        onTurnError: async (error, input) => {
          await this.#failTask(error, input)
          this.#checkProviderSoon()
        },
      })
      this.#runtime = runtime
      this.#runtimeChild = child
      const waiters = this.#runtimeWaiters
      this.#runtimeWaiters = []
      for (const wake of waiters) wake()

      poller = new ResidentPoller({
        poll: async () => {
          // Cheap on all but one call in sixty; see the constant's comment for
          // why the cadence is not configurable.
          this.#lifecycle.heartbeat()
          // The witness handles its own 60 s period. Starting it on this
          // existing timer avoids another resident timer, but it must never
          // hold up mailbox admission while its second location is half-open.
          this.#triggerWitnessTick()
          if (runtime !== null) await this.#trackPoll(runtime.pollAll())
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

  // -------------------------------------------------------------------------
  // Provider hot switch (design `providers-console-m1.md` §2.7)
  // -------------------------------------------------------------------------

  /**
   * Look for a pending provider configuration and, when the node is idle,
   * commit it and recycle the ACP child.
   *
   * Called by the 5 s poll, by the CLI on SIGHUP, and after each turn while an
   * intent is waiting. **Synchronous on purpose**: the idle check, the commit,
   * the session policy and the recycle run with no `await` between them, and
   * `recycle()` retires the old generation's runtime and poller before it
   * returns. So no delivery can reach the old child once `settings.json` has
   * changed — which is the whole hazard (matrix §4.4: a `createSession` there
   * would pull the new env into a process other sessions are still using).
   *
   * Busy means: wait. New work keeps going to the current generation until it
   * is idle; nothing in flight is ever cut off, and a wait past the limit is
   * reported once, never enforced (R-6).
   */
  checkProviderConfig(): void {
    const node = this.#options.providerNode
    if (node === undefined || !this.#providerReady || this.#stopping) return
    let pending: boolean
    try {
      pending = node.hasPendingProviderConfig()
    } catch (error) {
      this.#options.onError?.(error)
      return
    }
    if (!pending) {
      if (this.#providerWaiting !== null) {
        this.#providerWaiting = null
        this.#writeSwitchStatus({ waiting: null })
      }
      return
    }
    const now = this.#providerNow()
    let waiting = this.#providerWaiting
    if (waiting === null) {
      waiting = {
        since: now,
        requestId: this.#pendingRequestId(node),
        raised: new Set(),
        alertedAt: null,
        statusKey: '',
      }
      this.#providerWaiting = waiting
    }
    if (this.#supervisor.parked) {
      this.#raiseOnce(
        waiting,
        'parked',
        'a provider configuration is pending, but the ACP child is parked and no generation will start to load it; it will be committed when this resident is restarted',
      )
      this.#writeWaiting(waiting, this.#inFlightWork() ?? IDLE)
      return
    }
    const inFlight = this.#inFlightWork()
    if (inFlight !== null) {
      const maxWait =
        this.#options.providerSwitch?.maxWaitMs ?? DEFAULT_PROVIDER_MAX_WAIT_MS
      if (waiting.alertedAt === null && now - waiting.since >= maxWait) {
        waiting.alertedAt = now
        this.#providerAlert(
          `provider configuration ${waiting.requestId ?? '(unknown request)'} has been waiting ` +
            `${Math.round((now - waiting.since) / 60_000)} min for the ACP child to go idle ` +
            `(${describeInFlight(inFlight)}). It is not forced: the switch happens when the ` +
            'work in flight ends.',
        )
      }
      this.#writeWaiting(waiting, inFlight)
      return
    }
    this.#commitAndRecycle(node, waiting)
  }

  /** The idle half of {@link checkProviderConfig}. */
  #commitAndRecycle(
    node: ResidentProviderNode,
    waiting: ProviderWaiting,
  ): void {
    const before = managedHashOf(node)
    let result: ResidentProviderCommit
    try {
      result = node.commitPendingProviderConfig()
    } catch (error) {
      this.#afterFailedCommit(node, waiting, before, null, errorText(error))
      return
    }
    switch (result.status) {
      case 'committed':
        this.#providerCommitted(result, 'switch')
        return
      case 'busy':
        // Another process holds `apply.lock` for a moment; the next check
        // retries. Nothing was touched.
        return
      case 'none':
        this.#providerWaiting = null
        this.#writeSwitchStatus({ waiting: null })
        return
      case 'write-failed':
        this.#afterFailedCommit(
          node,
          waiting,
          before,
          result.requestId,
          result.message,
        )
        return
      default:
        this.#reportUncommitted(result, waiting)
    }
  }

  /**
   * Carry out a commit: the session policy, the record, then the recycle.
   *
   * At startup there is no generation yet, so there is nothing to recycle; the
   * first one starts on the committed configuration.
   */
  #providerCommitted(
    result: Extract<ResidentProviderCommit, { status: 'committed' }>,
    via: 'switch' | 'startup',
  ): void {
    this.#applySessionPolicy(result.sessions)
    this.#providerWaiting = null
    this.#writeSwitchStatus({
      waiting: null,
      last: this.#switchOutcome(
        'committed',
        result.requestId,
        result.sessions,
        result.recovered ? 'finished a commit a crash had interrupted' : null,
      ),
      reconciledRequestId: result.requestId,
    })
    if (via === 'switch') this.#recycleForSwitch()
    this.#announceSwitch({
      requestId: result.requestId,
      sessions: result.sessions,
      recovered: result.recovered,
      via,
    })
  }

  /**
   * A commit that threw or failed to write. If `settings.json` changed anyway,
   * the running child no longer matches its file: recycle it, with sessions
   * reset because the policy that came with the intent is not known to have
   * been carried out. Otherwise the intent stays pending for the next check.
   */
  #afterFailedCommit(
    node: ResidentProviderNode,
    waiting: ProviderWaiting,
    before: string | undefined,
    requestId: string | null,
    detail: string,
  ): void {
    const after = managedHashOf(node)
    const changed =
      before !== undefined && after !== undefined && before !== after
    this.#raiseOnce(
      waiting,
      'write-failed',
      `could not commit the pending provider configuration: ${detail}. ` +
        (changed
          ? 'settings.json did change, so the ACP child is recycled anyway, with its sessions reset.'
          : 'It stays pending and is retried on the next check.'),
    )
    this.#writeSwitchStatus({
      last: this.#switchOutcome('write-failed', requestId, null, detail),
    })
    if (changed) {
      this.#applySessionPolicy('reset')
      this.#recycleForSwitch()
    }
  }

  /**
   * Recycle the running generation for a committed configuration. Its runtime
   * is retired from deliveries at once (the generation's `stop()` does that
   * before its first await); the process itself gets
   * {@link DEFAULT_PROVIDER_RETIRE_GRACE_MS} to write its transcript out.
   */
  #recycleForSwitch(): void {
    this.#retireForSwitch = true
    if (!this.#supervisor.recycle()) this.#retireForSwitch = false
  }

  /** The grace the generation now stopping owes a switch; `0` otherwise. */
  #takeRetireGrace(): number {
    if (!this.#retireForSwitch) return 0
    this.#retireForSwitch = false
    return (
      this.#options.providerSwitch?.retireGraceMs ??
      DEFAULT_PROVIDER_RETIRE_GRACE_MS
    )
  }

  /** `conflict`, `bad-pending` and `refused`: nothing was written. */
  #reportUncommitted(
    result: Extract<
      ResidentProviderCommit,
      { status: 'conflict' | 'bad-pending' | 'refused' }
    >,
    waiting: ProviderWaiting | null,
  ): void {
    switch (result.status) {
      case 'conflict':
        // The intent is gone (it held a key); the hub has to re-send.
        this.#providerWaiting = null
        this.#providerAlert(
          `provider configuration ${result.requestId} was not committed: the managed keys in ` +
            `settings.json changed after it was staged (${result.diffKeys.join(', ') || 'no key names'}). ` +
            'The intent was discarded; the hub has to send it again once ops decide.',
        )
        this.#writeSwitchStatus({
          waiting: null,
          last: this.#switchOutcome(
            'conflict',
            result.requestId,
            null,
            result.diffKeys.join(', '),
          ),
        })
        return
      case 'bad-pending':
        this.#providerWaiting = null
        this.#providerAlert(
          `a pending provider configuration could not be read and was moved to ${result.movedTo}; nothing was committed.`,
        )
        this.#writeSwitchStatus({
          waiting: null,
          last: this.#switchOutcome('bad-pending', null, null, result.movedTo),
        })
        return
      case 'refused': {
        const message = `provider configuration not committed: ${result.message}. It stays pending and is retried on every check.`
        if (waiting === null) this.#providerAlert(message)
        else this.#raiseOnce(waiting, 'refused', message)
        this.#writeSwitchStatus({
          last: this.#switchOutcome('refused', null, null, result.message),
        })
      }
    }
  }

  /**
   * Startup: commit an intent a crash left behind, then make sure the session
   * map matches whatever is applied.
   *
   * The second half covers the commits whose session policy this resident
   * never saw — a crash between commit and recycle, or a commit `qm provider`
   * made while no resident was running. The policy is unknown, so the session
   * map is reset, which is R-7's default. A node that is not managed has no
   * applied configuration and is left exactly as it was.
   */
  #prepareProviderConfig(): void {
    const node = this.#options.providerNode
    if (node === undefined) return
    try {
      const result = node.commitPendingProviderConfig()
      if (result.status === 'committed') {
        this.#providerCommitted(result, 'startup')
      } else if (
        result.status === 'conflict' ||
        result.status === 'bad-pending'
      ) {
        // Discarded by the attempt; nothing later would mention it.
        this.#reportUncommitted(result, null)
      }
      // `refused`, `write-failed` and `busy` leave the intent pending: the
      // first check after the first generation is up deals with it.
    } catch (error) {
      this.#options.onError?.(error)
    }
    let applied: string | null = null
    try {
      applied = node.readProviderState().applied?.requestId ?? null
    } catch (error) {
      this.#options.onError?.(error)
    }
    if (
      applied !== null &&
      applied !== this.#readSwitchStatus()?.reconciledRequestId
    ) {
      this.#applySessionPolicy('reset')
      this.#writeSwitchStatus({
        last: this.#switchOutcome(
          'reconciled',
          applied,
          'reset',
          'committed without this resident applying its session policy',
        ),
        reconciledRequestId: applied,
      })
      this.#announceSwitch({
        requestId: applied,
        sessions: 'reset',
        recovered: true,
        via: 'reconcile',
      })
    }
    this.#providerReady = true
  }

  /** `reset`: forget every session mapping, so each context starts anew. */
  #applySessionPolicy(policy: 'keep' | 'reset'): void {
    if (policy !== 'reset') return
    try {
      for (const key of Object.keys(this.#sessions.entries())) {
        this.#sessions.delete(key)
      }
    } catch (error) {
      this.#providerAlert(
        `could not reset the session map after a provider switch: ${errorText(error)}. ` +
          'The next generation may resume sessions recorded under the previous provider.',
      )
    }
  }

  /** `generation.json` for the generation about to start (§2.4). */
  #recordProviderGeneration(): void {
    const node = this.#options.providerNode
    if (node === undefined) return
    try {
      node.recordProviderGeneration({
        generation: this.#generation,
        env: process.env,
      })
    } catch (error) {
      this.#options.onError?.(error)
    }
  }

  /**
   * What stopping the ACP child now would cut off, or `null` when nothing.
   *
   * Wider than "a turn is running" on purpose: an admission poll can be
   * between reading the mailbox and submitting its turn, and a delivery can be
   * between the transport and the poll it starts. Either would land on the old
   * child a moment after it was judged idle.
   */
  #inFlightWork(): ResidentInFlight | null {
    let admissions: number
    try {
      admissions = pendingSessionIds(
        this.#options.agents.map(agent => this.#ledger(agent.agent)),
      ).length
    } catch {
      // A ledger that cannot answer is not evidence of idle.
      admissions = 1
    }
    const work: ResidentInFlight = {
      turns: this.#gate.active ? 1 : 0,
      queued: this.#gate.queued,
      tasks: this.#tasksByTask.size,
      deliveries: this.#deliveriesInFlight,
      polls: this.#pollsInFlight,
      admissions,
      starting: this.#generationStarting,
    }
    const busy =
      work.starting ||
      work.turns +
        work.queued +
        work.tasks +
        work.deliveries +
        work.polls +
        work.admissions >
        0
    return busy ? work : null
  }

  #trackPoll<T>(poll: Promise<T>): Promise<T> {
    this.#pollsInFlight += 1
    return poll.finally(() => {
      this.#pollsInFlight -= 1
    })
  }

  /** After a turn ends: a waiting intent may be committable now. */
  #checkProviderSoon(): void {
    if (this.#providerWaiting === null) return
    // After the gate has released the turn that called this.
    setImmediate(() => this.checkProviderConfig())
  }

  #startProviderPoll(): void {
    if (this.#options.providerNode === undefined) return
    const interval =
      this.#options.providerSwitch?.pollIntervalMs ??
      DEFAULT_PROVIDER_POLL_INTERVAL_MS
    if (interval <= 0) return
    this.#providerTimer = setInterval(
      () => this.checkProviderConfig(),
      interval,
    )
    this.#providerTimer.unref?.()
  }

  #stopProviderPoll(): void {
    if (this.#providerTimer !== null) clearInterval(this.#providerTimer)
    this.#providerTimer = null
  }

  #providerNow(): number {
    return (this.#options.providerSwitch?.now ?? Date.now)()
  }

  #pendingRequestId(node: ResidentProviderNode): string | null {
    try {
      return node.readProviderState().pending?.requestId ?? null
    } catch {
      return null
    }
  }

  #providerAlert(message: string): void {
    const alert = this.#options.onProviderAlert
    if (alert !== undefined) alert(message)
    else this.#options.onError?.(new Error(message))
  }

  /** One alert per kind per waiting intent; the poll would repeat it every 5 s. */
  #raiseOnce(waiting: ProviderWaiting, kind: string, message: string): void {
    if (waiting.raised.has(kind)) return
    waiting.raised.add(kind)
    this.#providerAlert(message)
  }

  #announceSwitch(event: ResidentProviderSwitchEvent): void {
    try {
      this.#options.onProviderSwitched?.(event)
    } catch (error) {
      this.#options.onError?.(error)
    }
  }

  /** Rewrite the waiting block only when what it says has changed. */
  #writeWaiting(waiting: ProviderWaiting, inFlight: ResidentInFlight): void {
    const key = JSON.stringify([inFlight, waiting.alertedAt])
    if (key === waiting.statusKey) return
    waiting.statusKey = key
    this.#writeSwitchStatus({
      waiting: {
        requestId: waiting.requestId,
        since: new Date(waiting.since).toISOString(),
        inFlight,
        alertedAt:
          waiting.alertedAt === null
            ? null
            : new Date(waiting.alertedAt).toISOString(),
      },
    })
  }

  #switchOutcome(
    outcome: string,
    requestId: string | null,
    sessions: 'keep' | 'reset' | null,
    detail: string | null,
  ): NonNullable<ResidentProviderSwitchStatus['last']> {
    return {
      at: new Date(this.#providerNow()).toISOString(),
      outcome,
      requestId,
      sessions,
      detail,
    }
  }

  #readSwitchStatus(): ResidentProviderSwitchStatus | undefined {
    if (this.#switchStatus !== undefined) return this.#switchStatus
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(occConfigPath('resident', PROVIDER_SWITCH_FILE), 'utf8'),
      )
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { v?: unknown }).v === 1
      ) {
        this.#switchStatus = parsed as ResidentProviderSwitchStatus
      }
    } catch {
      // Missing or unreadable: nothing has been reconciled.
    }
    return this.#switchStatus
  }

  #writeSwitchStatus(
    update: Partial<
      Pick<
        ResidentProviderSwitchStatus,
        'waiting' | 'last' | 'reconciledRequestId'
      >
    >,
  ): void {
    const current = this.#readSwitchStatus()
    const next: ResidentProviderSwitchStatus = {
      v: 1,
      pid: process.pid,
      updatedAt: new Date(this.#providerNow()).toISOString(),
      waiting:
        update.waiting !== undefined
          ? update.waiting
          : (current?.waiting ?? null),
      last: update.last !== undefined ? update.last : (current?.last ?? null),
      reconciledRequestId:
        update.reconciledRequestId !== undefined
          ? update.reconciledRequestId
          : (current?.reconciledRequestId ?? null),
    }
    try {
      const path = occConfigPath('resident', PROVIDER_SWITCH_FILE)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      chmodSync(dirname(path), 0o700)
      writePrivateFileAtomicSync(path, `${JSON.stringify(next, null, 2)}\n`)
      this.#switchStatus = next
    } catch (error) {
      this.#options.onError?.(error)
    }
  }
}

/** See {@link ResidentProviderSwitchStatus}. */
const PROVIDER_SWITCH_FILE = 'provider-switch.json'

const IDLE: ResidentInFlight = {
  turns: 0,
  queued: 0,
  tasks: 0,
  deliveries: 0,
  polls: 0,
  admissions: 0,
  starting: false,
}

interface ProviderWaiting {
  readonly since: number
  readonly requestId: string | null
  /** Alert kinds already raised for this intent. */
  readonly raised: Set<string>
  alertedAt: number | null
  /** What the status file last said, to skip identical rewrites. */
  statusKey: string
}

function describeInFlight(work: ResidentInFlight): string {
  const parts: string[] = []
  if (work.turns > 0) parts.push(`${work.turns} turn running`)
  if (work.queued > 0) parts.push(`${work.queued} queued`)
  if (work.tasks > 0) parts.push(`${work.tasks} task(s) unanswered`)
  if (work.admissions > 0) parts.push(`${work.admissions} admission(s) open`)
  if (work.deliveries + work.polls > 0) parts.push('a delivery in progress')
  if (work.starting) parts.push('a generation starting')
  return parts.join(', ')
}

function managedHashOf(node: ResidentProviderNode): string | undefined {
  try {
    return node.currentManagedHash()
  } catch {
    return undefined
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
