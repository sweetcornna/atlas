// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { NodeDesktop } from './desktop.js'
import { NodeElevation } from './elevation.js'
import { isDesktopTool } from '@qianmo/extension/desktopPolicy'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { NodeFiles } from './files.js'
import type { AuditInput } from '@qianmo/audit'
import { AuditSource } from '@qianmo/audit'
import {
  ControlRegistry,
  HubCallClient,
  type ControlOutcome,
} from './control.js'
import { MemoryControl } from './memoryControl.js'
import { verifiedBackground, verifiedTaskOwner } from '@qianmo/capability'
import { connectorTools, type ConnectorToolContext } from './connectorTools.js'
import { taskTools, type TaskToolOrigin } from './taskTools.js'
import {
  settingsTools,
  type SettingsApproval,
  type SettingsUnavailable,
} from './settingsTools.js'
import {
  askReentry,
  NESTED_NO_ROOM_REASON,
  peerTools,
  type PeerToolOrigin,
} from './peerTools.js'
import { FALLBACK_RUNTIME } from './runtimes/catalog.js'
import { NodeExtensions } from './extensions.js'
import { runtimeBin } from './runtimeUpdate.js'
import { NodeRuntimes } from './runtimeConfig.js'
import {
  RUNTIME_CATALOG_CAPABILITY,
  RUNTIME_EXT_OPS,
  RUNTIME_OPS,
} from './runtimes/contract.js'
import { SelfUpgrader, systemControl } from './selfUpgradeRunner.js'
import { residentToolSurface, type HostToolDefinition } from './notifyTool.js'
import { buildVersion } from '../provenance.js'
import {
  OmpResidentTurnPort,
  MAX_RESIDENT_TURN_PROGRESS,
  DEFAULT_RESIDENT_INACTIVITY_MS,
  FileAdmissionLedger,
  FileDeliveryLedger,
  FileResidentSessionStore,
  NodeTurnExpiredError,
  NodeTurnGate,
  pendingSessionIds,
  ResidentDeadlineClock,
  ResidentEstop,
  ResidentLifecycleSentinel,
  ResidentMemorySidecar,
  writeResidentMemory,
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
  AuthzCall,
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
  LIMITS,
  messageBytes,
  MessageType,
  CONTROL_MESSAGE_TYPES,
  CONTROL_OPERATION_ID_CAPABILITY,
  LEGACY_MESSAGE_TYPES,
  ProtocolErrorCode,
  createAck,
  createMessage,
  createTaskResult,
  errorCodeForPeer,
  errorReply,
  isNotifyPayload,
  isTaskResultPayload,
  isNodeControlPayload,
  isHubSubscribePayload,
  parseAddress,
  peerIsPostLegacy,
  taskExpiresAt,
  type QianmoMessage,
} from '@qianmo/protocol'
import { QIANMO_WRAPPER_TYPE } from '@qianmo/adapter/wrapper'
import { sanitizeRemoteText } from '@qianmo/adapter/sanitize'
import { FileMemoryStore, defaultMemoryRoot } from '@qianmo/memory'
import {
  residentToolVerdict,
  residentApprovalInput,
  residentApprovalMode,
} from '@qianmo/extension/policy'
import { parseMemoryWrite } from './residentMemoryWrite.js'
import {
  ResidentAuthorization,
  type ResidentAuthorizationOptions,
} from './residentAuthorization.js'
import {
  type EmbeddingProvider,
  FileEmbeddingUsageMeter,
  type HybridConfig,
  FileVectorIndex,
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
} from '@qianmo/mailbox'
import { qianmoConfigPath, nodeHomeDir } from '@qianmo/paths'
import {
  protectedConfigRoots,
  qianmoConfigDir,
  qmcodeHome,
} from '@qianmo/paths'
import { contextOfSessionKey } from '@qianmo/resident'
import { writePrivateFileAtomic as writePrivateFileAtomicSync } from '../providers/store.js'
import {
  assembleResidentPrompt,
  assembleResidentPromptAsync,
} from './residentPrompt.js'
import {
  ResidentOmpPool,
  type ResidentOmpSpawn,
  type ResidentPermission,
} from './residentOmp.js'
import type { ExternalRuntimeKind } from './runtimes/channel.js'
import { ResidentRuntimePool } from './runtimes/composite.js'
import { writeResidentRoster } from './runtimes/frontendLock.js'
import { isNativeExtensionOp, NativeExtensions } from './runtimes/nativeExt.js'
import {
  ExternalRuntimePool,
  type ExternalAgent,
  type ExternalLaunch,
  type ExternalLaunchSession,
  type ExternalRuntimeSpawn,
} from './runtimes/pool.js'
import type { ChildProcess } from 'node:child_process'
import {
  residentLocalCommand,
  parseResidentOmpLocalCommand,
} from './residentLocalCommand.js'
import type { QianmoNotifyVerdict } from './notifyWire.js'

interface QianmoResidentAgentConfig {
  readonly agent: string
  readonly cwd: string
  /**
   * The external runtime it is configured on at start (P27, P36); where it
   * runs turn by turn is `runtimes`' answer.
   */
  readonly runtime?: ExternalRuntimeKind
  /** Shell access for an external runtime (`--agent-shell`). */
  readonly shell?: boolean
  /**
   * The model an external runtime runs (the model of `--agent-model`), for
   * `node.ping`: the hub lists it to a foreground choosing whom to hand work
   * to (P29 `qianmo_task_agents`).
   */
  readonly model?: string
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
  commitPendingProviderConfig():
    | ResidentProviderCommit
    | Promise<ResidentProviderCommit>
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

/** What a provider switch would cut off if the omp RPC child stopped now. */
interface ResidentInFlight {
  /** Turns running in the node gate. */
  readonly turns: number
  /** Turns waiting there for a place or for their session. */
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
   * `switch`: committed at an idle boundary, omp RPC child recycled.
   * `startup`: committed before the first generation (crash roll-forward).
   * `reconcile`: found already applied at startup without its session policy
   * having been carried out here; sessions were reset (R-7 default).
   */
  readonly via: 'switch' | 'startup' | 'reconcile'
}

/**
 * `qianmoConfigPath('resident', 'provider-switch.json')`: what this resident is
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

interface QianmoResidentOptions {
  /** Handshake identities allowed to control this node, independently of task issuers. */
  readonly controllers?: ReadonlySet<string>
  readonly memoryControllers?: ReadonlyMap<string, string>
  readonly controlAudit?: (event: AuditInput) => void
  readonly extraHostTools?: readonly HostToolDefinition[]
  readonly node: string
  readonly team: string
  readonly agents: readonly QianmoResidentAgentConfig[]
  /**
   * 放宽到「工作目录之内的编辑自动放行」（`--allow-workspace-edits`）。
   *
   * 缺省不给，extension 只允许只读工具。放宽是显式动作：它改的
   * 是这台节点的权限姿态，不该由「跑的是哪一版产物」决定。
   */
  readonly allowWorkspaceEdits?: boolean
  /** `--desktop-memory-mib`: memory cap of one agent's cloud computer, bytes. */
  readonly desktopMemoryBytes?: number
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
   * The console's signing names (`--local-commands-from`): a `task.request`
   * one of them signed, marked as a local command, reaches the omp RPC child as
   * the command itself instead of as a message (P18.20,
   * `residentLocalCommand.ts`). Absent or empty, nothing arrives that way.
   */
  readonly localCommandIssuers?: readonly string[]
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
   * Silence budget for one omp RPC turn (design §3.B10). Defaults to
   * {@link DEFAULT_RESIDENT_INACTIVITY_MS}; `0` turns the watchdog off.
   */
  readonly inactivityMs?: number
  /**
   * Where upstream HTTP statuses reported by the omp RPC child are remembered, so
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
  readonly tenantGate?: (authenticatedPeer: string | null) => boolean
  readonly protectedRoots?: readonly string[]
  readonly authorization?: Omit<
    ResidentAuthorizationOptions,
    'node' | 'memoryRoot' | 'estop'
  >
  readonly runtimeAudit?: ResidentAuthorizationOptions['audit']
  readonly usageAudit?: (event: {
    readonly taskId: string
    readonly msgId: string
    readonly traceId: string
    readonly sequence: number
    readonly usage: Readonly<
      Record<'input' | 'output' | 'cacheWrite' | 'cacheRead', number>
    >
  }) => void
  readonly usageEndAudit?: (taskId: string, traceId: string) => void
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
   * The resident command reads memory/embedding.json under its Qianmo
   * config root. P16.8 persists vectors as a private, content-addressed cache;
   * the operator-only memory backfill/rebuild commands warm that cache.
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
  readonly ompIdleMs?: number
  readonly ompMaxChildren?: number
  /**
   * Turns the node runs at once, across sessions and agents (P38): the turn
   * gate's places. Absent: 1, one turn at a time. The CLI keeps it within
   * {@link ompMaxChildren}, since each running turn holds a process.
   */
  readonly maxTurns?: number
  /**
   * Of those, the hub's background sub-agent turns at most; the gate keeps
   * one place for the foreground whenever there are two or more.
   */
  readonly maxBackgroundTurns?: number
  readonly spawnOmp?: (input: ResidentOmpSpawn) => ChildProcess
  /**
   * The model and credentials an external-runtime agent starts with. The CLI
   * hands this over from the provider stack, which stays out of this module.
   */
  readonly resolveRuntimeLaunch?: (
    agent: ExternalAgent,
    session: ExternalLaunchSession,
  ) => ExternalLaunch
  readonly runtimeBins?: Partial<Record<ExternalRuntimeKind, string>>
  /**
   * Per-agent runtime and model, qianmopi fallback and default installs
   * (P36); the CLI passes one. Absent: agents run where `runtime` says.
   */
  readonly runtimes?: NodeRuntimes
  readonly spawnRuntime?: (input: ExternalRuntimeSpawn) => ChildProcess
  /** How an external runtime starts `qm runtime-mcp`; tests override it. */
  readonly runtimeMcpArgv?: (args: readonly string[]) => string[]
  /**
   * Generation restart policy. Lazy starts use maxRapidFailures as a pool-level
   * consecutive startup failure limit; idle time does not reset it. Backoff
   * applies to generation failures, with the supervisor's existing defaults.
   *
   * Exposed because parking became *visible*. It used to end the process, so
   * how long it took to get there was an internal detail nobody could act on.
   * Now a parked node stays up and refuses turns with a reason, which makes
   * "how many rapid failures before we stop trying" an operational choice —
   * and lets a test reach the degraded state without waiting out the
   * production backoff ladder.
   */
  readonly ompRestart?: {
    readonly initialBackoffMs?: number
    readonly maxRapidFailures?: number
    /** How long a generation must stay healthy before its crash no longer
     * counts as rapid (supervisor default 10 s). */
    readonly stableAfterMs?: number
  }
  /**
   * How long a terminal reply waits for its transport receipt, and teardown
   * for the receipts still owed (default 5 s, the budget every caller in this
   * repository uses). An option only so a test whose peer is gone does not
   * sit the 5 s out.
   */
  readonly replyReceiptTimeoutMs?: number
  /**
   * The node's provider write path (`providers/node.ts`), which turns on hot
   * switching (design `providers-console-m1.md` §2.7). **Absent, nothing
   * below happens** — no poll, no commit, no generation record.
   *
   * Present, a pending intent is committed at a generation boundary and only
   * there: once at startup before the first omp RPC child (crash roll-forward),
   * and afterwards when the node is idle, immediately followed by a recycle of
   * the omp RPC child. A node with no pending intent is never recycled and its
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
  }
  /**
   * Something about the provider configuration an operator has to act on:
   * a refused or conflicting commit, a 30-minute wait, a parked agent.
   * Absent, these go to {@link onError}.
   */
  readonly onProviderAlert?: (message: string) => void
  /** Runs after the previous generation is closed, before any new OMP child.
   * Rejection leaves the generation unavailable. The transport stays reachable. */
  readonly beforeModelGeneration?: (input: {
    readonly generation: number
    readonly signal: AbortSignal
  }) => Promise<void>
  /** A provider configuration was committed. Observers must not spawn model children. */
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

const TASK_REPLY_RECEIPT_TIMEOUT_MS = 5_000

/**
 * How long a background turn stopped at its deadline gets to end on its own
 * abort before the node answers without it.
 *
 * Shorter than the console's local fallback after the deadline (15 s,
 * `CHAT_TIMEOUT_SLACK_MS` in `consoleChat.ts`), so the hub hears the node's
 * own `E_TASK_TIMEOUT` rather than its local guess, and until then the turn's
 * `qianmo_task_report` still reaches the hub.
 */
const BACKGROUND_STOP_GRACE_MS = 10_000

/** The longest text `turn.steer` takes (P38): a report or an instruction. */
const MAX_STEER_CHARS = 16_000

/** Largest delay `setTimeout` takes before silently collapsing it to 1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** The two process pools of a generation, each capped by `--omp-max-children`. */
type RuntimePool = 'qianmopi' | 'external'

interface ActiveResidentTask {
  owner?: string
  trust?: 'untrusted' | 'verified-capability'
  readonly envelope: QianmoMessage
  readonly channel: TransportChannel
  readonly releaseChannel: () => void
  timeout: ReturnType<typeof setTimeout> | null
  acked: boolean
  settled: boolean
  /** Claims terminal settlement and closes progress admission before any await. */
  settling: boolean
  readonly progressQueue: ResidentTurnProgress[]
  progressDrain: Promise<void> | null
  /**
   * True between `#registerTask` and the end of `deliver()` — the window in
   * which this task belongs to no omp RPC generation yet. See `#failActiveTasks`.
   */
  delivering: boolean
  /**
   * Written to the mailbox while a planned provider switch had no generation
   * to hand it to (`#deliverDurably`). Like {@link delivering} it belongs to
   * no omp RPC generation yet, so `#failActiveTasks` leaves it alone; the
   * generation the switch starts admits it and clears this (`#adoptKept`).
   */
  kept: boolean
  /**
   * The text this task's turn runs on verbatim, when the routing verdict made
   * it a console's local command (`residentLocalCommand.ts`). Read by
   * `#assemblePrompt`; absent for everything else.
   */
  localCommand?: string
  /**
   * A hub's background sub-agent turn, by its signed marker
   * (`verifiedBackground`): it yields at the gate and is stopped at its
   * deadline rather than left running.
   */
  background?: boolean
  /** The deadline passed and this node asked the runtime to stop the turn. */
  stoppedAtDeadline?: boolean
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
  'resident agent is unavailable on this node (the omp RPC child could not be started); delivery, receipts and audit still work'

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
  readonly desktop: NodeDesktop
  /** Per-agent high-permission grants, gate and audit (P39). */
  readonly elevation: NodeElevation
  /** Operator-configured MCP servers, skills and plugins (P32). */
  readonly extensions: NodeExtensions
  readonly control: ControlRegistry
  /** Where each agent runs and which runtimes are installed (P36). */
  readonly runtimes: NodeRuntimes
  /** The harnesses' own extension commands for the console (P36.7). */
  readonly nativeExtensions: NativeExtensions
  /**
   * Host tools answered by the hub: connectors (P25), background tasks (P29),
   * other agents (P36.6) and the hub's settings (P40).
   */
  readonly #hubHostTools: readonly HostToolDefinition[]
  readonly hubCall: HubCallClient
  readonly #options: QianmoResidentOptions
  /** `options.localCommandIssuers`, as the set it is looked up in. */
  readonly #localCommandIssuers: ReadonlySet<string>
  readonly #gate: NodeTurnGate
  /**
   * The process each running turn holds, by session: which pool it came from
   * (qianmopi or an external runtime). Each pool starts at most
   * `--omp-max-children` processes, and a turn's process stays busy until the
   * turn ends — so this says when a nested answer would find none (P36.6).
   */
  readonly #held = new Map<string, RuntimePool>()
  readonly #mailbox = new BaseMailboxPort()
  readonly #deadlineClock = new ResidentDeadlineClock({ periodMs: 10_000 })
  readonly #adapter: InboundAdapter
  readonly #router: NodeRouter
  readonly #sessions = new FileResidentSessionStore(
    qianmoConfigPath('resident', 'sessions.json'),
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
    qianmoConfigPath('resident', 'deliveries.ndjson'),
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
    qianmoConfigPath('resident', 'notifies.ndjson'),
    { onError: error => this.#options.onError?.(error) },
  )
  readonly #notifier: ResidentNotifier
  /** Redeliveries on the wire right now, so a second sweep does not double up. */
  readonly #redelivering = new Set<string>()
  /** Emergency stop (design §3.B6). Existence of the file is the whole test. */
  readonly #estop = new ResidentEstop({
    path: qianmoConfigPath('resident', 'ESTOP'),
    onError: error => this.#options.onError?.(error),
  })
  /** Termination-cause forensics (design §3.B2). */
  readonly #lifecycle: ResidentLifecycleSentinel
  readonly #timings: ResidentTimingRecorder
  #poller: ResidentPoller | null = null
  readonly #turn: OmpResidentTurnPort
  readonly #supervisor: ResidentSupervisor
  #runtime: ResidentNodeRuntime | null = null
  #transport: TransportServerHandle | null = null
  readonly #tasksByMessage = new Map<string, ActiveResidentTask>()
  readonly #authorization: ResidentAuthorization | undefined
  readonly #approvalChannels = new Map<string, TransportChannel>()
  readonly #tasksByTask = new Map<string, ActiveResidentTask>()
  /** Progress handoffs and replies awaiting receipts. See {@link #drainReplyReceipts}. */
  readonly #settling = new Set<Promise<void>>()
  /** One scheduler per agent workspace; empty when backups are not configured. */
  readonly #backups = new Map<string, BackupScheduler>()
  /** Memory recall for the user-message sidecar (design §4.4). */
  readonly #memory: ResidentMemorySidecar
  /** The memory root in use, handed to the omp RPC child's hardline as well. */
  readonly #memoryRoot: string
  readonly #memoryIndex: FileVectorIndex | undefined
  #stopping = false
  #releaseStop: (() => void) | null = null
  /** Woken when `#runtime` becomes available; see `#runtimeForDelivery`. */
  #runtimeWaiters: Array<() => void> = []
  /** The omp RPC child backing `#runtime`; see `#runtimeIsLive`. */
  #runtimeChild: ResidentRuntimePool | null = null
  #witnessClosed = false
  /** Generations this process has started (`generation.json`, §2.4). */
  #generation = 0
  /** Between the start of `#startRuntime` and its runtime being ready. */
  #generationStarting = false
  readonly #generationAbort = new AbortController()
  /** `deliver()` calls not yet past the hand-off to a turn. */
  #deliveriesInFlight = 0
  /** Admission polls not yet past submitting their turn. */
  #pollsInFlight = 0
  /** Set once startup has rolled a pending intent forward (§2.6 step 5). */
  #providerCheckQueued = false
  #providerCommitting = false
  /** Set while an in-place upgrade waits for in-flight work (P31 §5.2). */
  #upgradeDraining = false
  /**
   * A provider switch has recycled the generation and the next one is not
   * published yet. Old pool reaping, the supervisor's backoff and the model
   * probe on the new configuration together routinely outlast
   * {@link RUNTIME_WAIT_MS}, so a delivery in this window (or while the
   * commit itself runs) is kept in the mailbox for the next generation
   * instead of being turned away (`#deliverDurably`).
   */
  #switching = false
  /** Something was kept that way and no generation has adopted it yet. */
  #keptMail = false
  #providerCommitFlight: Promise<void> | undefined
  #providerReady = false
  #providerTimer: ReturnType<typeof setInterval> | null = null
  /** The pending intent being waited on, if any. */
  #providerWaiting: ProviderWaiting | null = null
  /** In-memory copy of `provider-switch.json`, once read or written. */
  #switchStatus: ResidentProviderSwitchStatus | undefined

  constructor(options: QianmoResidentOptions) {
    this.#gate = new NodeTurnGate({
      ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
      ...(options.maxBackgroundTurns === undefined
        ? {}
        : { maxBackgroundTurns: options.maxBackgroundTurns }),
    })
    const files =
      options.controllers?.size &&
      (process.platform === 'darwin' || process.platform === 'linux')
        ? new NodeFiles({
            node: options.node,
            agents: () => options.agents,
            directory: qianmoConfigPath('qianmo', 'files', options.node),
            stopped: () => this.#estop.engaged(),
            hub: {
              call: (op, args, callOptions) =>
                this.hubCall.call(op, args, callOptions),
            },
            audit: (kind, detail) =>
              options.controlAudit?.({
                at: Date.now(),
                source: AuditSource.Control,
                node: options.node,
                kind,
                outcome:
                  kind === 'files.rejected' || kind === 'files.denied'
                    ? 'refused'
                    : 'ok',
                detail,
              }),
          })
        : undefined
    if (files)
      options = {
        ...options,
        extraHostTools: [...(options.extraHostTools ?? []), files.tool()],
      }
    this.#options = options
    this.#hubHostTools = [
      ...connectorTools({
        call: (op, args, callOptions) =>
          this.hubCall.call(op, args, callOptions),
        approve: (ctx, tool, args) => this.#approveConnector(ctx, tool, args),
      }),
      ...taskTools({
        call: (op, args, callOptions) =>
          this.hubCall.call(op, args, callOptions),
        origin: ctx => this.#taskOrigin(ctx),
      }),
      // The roster and synchronous questions between agents (P36.6).
      ...peerTools({
        call: (op, args, callOptions) =>
          this.hubCall.call(op, args, callOptions),
        origin: ctx => this.#peerOrigin(ctx),
      }),
      // The hub's settings (P40): read without approval; every change is
      // approved by a person in the conversation, once, before the hub makes it.
      ...settingsTools({
        call: (op, args, callOptions) =>
          this.hubCall.call(op, args, callOptions),
        origin: ctx => this.#taskOrigin(ctx),
        unavailable: ctx => this.#settingsUnavailable(ctx),
        approve: async (ctx, tool, args) => {
          const unavailable = this.#settingsUnavailable(ctx)
          return unavailable === null
            ? await this.#approveInTurn(ctx, tool, args)
            : { kind: 'unavailable', reason: unavailable }
        },
      }),
    ]
    residentToolSurface(options.authorization !== undefined, [
      ...this.#hubHostTools,
      ...(options.extraHostTools ?? []),
    ])
    this.control = new ControlRegistry({
      onError: options.onError,
      estopEngaged: () => this.#estop.engaged(),
      ledgerPath: qianmoConfigPath(
        'resident',
        options.node,
        'control-operations.sqlite',
      ),
    })
    files?.register(this.control)
    this.desktop = new NodeDesktop({
      node: options.node,
      agents: options.agents.map(a => a.agent),
      estop: () => this.#estop.engaged(),
      audit: options.runtimeAudit ?? options.authorization?.audit,
      invalidated: agent => this.#authorization?.cancelDesktop(agent),
      changed: async agent => {
        await this.#runtimeChild?.invalidateAgent(agent)
      },
      // The private desktop sees the workspace the way the agent does, and
      // none of what the resident guard protects (runtimes-channels.md §6.3).
      workspace: agent => options.agents.find(a => a.agent === agent)?.cwd,
      workspaceWritable: options.allowWorkspaceEdits === true,
      protectedRoots: [
        options.memoryRoot ?? defaultMemoryRoot(),
        ...(options.protectedRoots ?? []),
      ],
      // 跳过权限确认 (P39) lifts the per-step confirmation of a `sensitive`
      // resource; read per action, so a revoke or expiry applies at once.
      elevationTier: agent => this.elevation.liveTier(agent),
      ...(options.desktopMemoryBytes === undefined
        ? {}
        : { memoryBytes: options.desktopMemoryBytes }),
    })
    // Under ESTOP the cloud computer can still be read, switched off and
    // recycled; enabling it and acting through it wait (P21 §4.2).
    this.control.register('desktop', this.desktop.control, {
      estopAllowed: [
        'desktop.status',
        'desktop.actions',
        'desktop.view',
        'desktop.disable',
        'desktop.recycle',
      ],
    })
    // High-permission mode (P39): per-agent grants, gate and audit. Under
    // ESTOP a grant can be read and withdrawn but never opened; the gate
    // itself clears every grant when ESTOP engages (host/elevation.ts).
    this.elevation = new NodeElevation({
      node: options.node,
      agents: options.agents.map(a => a.agent),
      estop: () => this.#estop.engaged(),
      audit: options.runtimeAudit ?? options.authorization?.audit,
      invalidated: agent => this.#authorization?.cancelElevation(agent),
      changed: async agent => {
        await this.#runtimeChild?.invalidateAgent(agent)
      },
      terminate: async agent => {
        await this.#runtimeChild?.retireAgent(agent)
      },
      // Only qianmopi children load the extension that carries the grant.
      unsupported: agent => {
        const runtime = this.runtimes.effectiveRuntime(agent)
        return runtime === FALLBACK_RUNTIME
          ? undefined
          : `该智能体运行在外部底层 ${runtime} 上：高权限模式只对 qianmopi 底层生效`
      },
      workspace: agent => options.agents.find(a => a.agent === agent)?.cwd,
    })
    this.control.register('elevation', this.elevation.control, {
      estopAllowed: [
        'elevation.status',
        'elevation.actions',
        'elevation.disable',
        'elevation.revoke',
      ],
      sideEffects: op =>
        op === 'elevation.enable' ||
        op === 'elevation.disable' ||
        op === 'elevation.revoke',
    })
    // MCP servers, skills and plugins the operator configures on the console
    // (P32): the hub sends the set, the node lays it out for each runtime.
    // Under ESTOP the set can be read but not changed.
    this.extensions = new NodeExtensions({
      agents: options.agents.map(agent => ({
        agent: agent.agent,
        ...(agent.runtime === undefined ? {} : { runtime: agent.runtime }),
      })),
      ...(options.agents.some(agent => agent.runtime === 'codex')
        ? { codexBin: runtimeBin('codex', options.runtimeBins) }
        : {}),
      changed: async agent => {
        await this.#runtimeChild?.invalidateAgent(agent)
      },
      onError: message => process.stderr.write(`${message}\n`),
    })
    this.control.register('extensions', this.extensions.control, {
      estopAllowed: ['extensions.status'],
      sideEffects: op => op === 'extensions.apply',
    })
    // `/stop` from a chat channel: the hub names the task it is waiting on.
    // `turn.steer` (P38): the hub's word for a turn it asked for, read by the
    // model at its next step — an owner's instruction for a running
    // sub-session, a sub-session's result for a busy main conversation.
    this.control.register(
      'turn',
      async (op, args, ctx) => {
        const task =
          typeof args.taskId === 'string'
            ? this.#tasksByTask.get(args.taskId)
            : undefined
        if (op === 'turn.stop')
          return {
            ok: true,
            value: {
              stopped:
                task !== undefined && this.#turn.stop(task.envelope.msgId),
            },
          }
        if (op === 'turn.steer') return this.#steerTurn(task, args.text, ctx)
        return { ok: false, code: 'unsupported', message: '不支持此回合操作' }
      },
      {
        estopAllowed: ['turn.stop'],
        // A steer said twice is said twice: a resent request answers from
        // the ledger instead.
        sideEffects: op => op === 'turn.steer',
      },
    )
    // Runtimes, installs and per-agent configuration (P31, P36); reading
    // works under ESTOP. A change of where an agent runs recycles it.
    this.runtimes =
      options.runtimes ??
      NodeRuntimes.unmanaged(options.agents, options.runtimeBins)
    this.runtimes.onChange(agent => {
      void this.#runtimeChild
        ?.invalidateAgent(agent)
        .catch(error => this.#options.onError?.(error))
      // A grant does not follow an agent onto an external runtime (P39).
      void this.elevation.sweep().catch(error => this.#options.onError?.(error))
      this.#writeRuntimeRoster()
    })
    // Native extensions (P36.7) ride the `runtime` prefix: listing works
    // under ESTOP and is not recorded; installs and removals are.
    this.nativeExtensions = new NativeExtensions({
      agents: options.agents.map(agent => ({
        agent: agent.agent,
        cwd: agent.cwd,
      })),
      runtimeOf: agent => this.runtimes.nativeRuntimeOf(agent),
      ...(options.runtimeBins === undefined
        ? {}
        : { bins: options.runtimeBins }),
      invalidate: async agent => {
        await this.#runtimeChild?.invalidateAgent(agent)
      },
    })
    const readOnly: readonly string[] = [
      RUNTIME_OPS.versions,
      RUNTIME_OPS.status,
      RUNTIME_EXT_OPS.list,
    ]
    this.control.register(
      'runtime',
      (op, args, ctx) =>
        isNativeExtensionOp(op)
          ? this.nativeExtensions.control(op, args, ctx)
          : this.runtimes.control(op, args, ctx),
      {
        estopAllowed: [...readOnly],
        sideEffects: op => !readOnly.includes(op),
      },
    )
    this.#writeRuntimeRoster()
    // qianmo's own in-place upgrade (P31 §5.2): stage, drain, swap, restart.
    this.control.register(
      'system',
      systemControl(
        new SelfUpgrader({
          drain: () => {
            this.#upgradeDraining = true
          },
          resume: () => {
            this.#upgradeDraining = false
          },
          idle: () => this.#inFlightWork() === null,
          log: line => process.stderr.write(`${line}\n`),
        }),
      ),
      {
        estopAllowed: ['system.version'],
        sideEffects: op => op !== 'system.version',
      },
    )
    this.control.register(
      'node',
      async op =>
        op === 'node.ping'
          ? {
              ok: true,
              value: {
                node: options.node,
                agents: options.agents.map(agent => agent.agent),
                // Each agent's runtime, and an external one's model: what
                // the hub's agent list says about them (P29). Both are the
                // ones in effect now, which change with P36 configuration
                // and fallback.
                runtimes: Object.fromEntries(
                  options.agents.map(agent => [
                    agent.agent,
                    this.runtimes.effectiveRuntime(agent.agent),
                  ]),
                ),
                models: Object.fromEntries(
                  options.agents.flatMap(agent => {
                    if (this.runtimes.effectiveRuntime(agent.agent) === 'omp')
                      return []
                    // The resolved model, else the configured one (flags
                    // name a bare model; fallback off resolves none).
                    const spec =
                      this.runtimes.state(agent.agent)?.effective.model ??
                      this.runtimes.configured(agent.agent).model
                    if (spec === null || spec === 'auto') return []
                    return [[agent.agent, spec.slice(spec.indexOf('/') + 1)]]
                  }),
                ),
                // How many turns run here at once, and how many of them may
                // be background sub-agent turns: the hub sends no more
                // worker turns than that at a time (P38).
                turns: {
                  max: this.#gate.limits.maxTurns,
                  background: this.#gate.limits.maxBackgroundTurns,
                },
                version: buildVersion(),
                platform: process.platform,
                now: Date.now(),
              },
            }
          : { ok: false, code: 'unsupported', message: '不支持此节点操作' },
      { estopAllowed: ['node.ping'] },
    )
    this.#localCommandIssuers = new Set(options.localCommandIssuers ?? [])
    this.#timings = new ResidentTimingRecorder(event => {
      options.onTiming?.(event)
      if (event.stage === 'detected' && event.networkMsgId !== undefined) {
        const task = this.#tasksByMessage.get(event.networkMsgId)
        if (task !== undefined)
          (options.runtimeAudit ?? options.authorization?.audit)?.({
            kind: 'authz.admission',
            taskId: task.envelope.taskId,
            traceId: task.envelope.traceId,
            detail: {
              sessionId: event.sessionId,
              messageId: event.inputMessageId ?? '',
              contextId: task.envelope.contextId ?? 'default',
              agent: event.agent ?? '',
              networkMsgId: event.networkMsgId,
            },
          })
      }
    })
    this.#notifier = new ResidentNotifier({
      node: options.node,
      ledger: this.#notifies,
      onError: error => this.#options.onError?.(error),
      ...(options.notifyAudit === undefined
        ? {}
        : { audit: options.notifyAudit }),
    })
    this.#memoryRoot = options.memoryRoot ?? defaultMemoryRoot()
    new MemoryControl({
      node: options.node,
      agents: options.agents.map(agent => agent.agent),
      root: this.#memoryRoot,
      ledgerPath: qianmoConfigPath('resident', 'memory-operations.sqlite'),
      estop: this.#estop,
      onError: options.onError,
    }).register(this.control)
    this.#authorization =
      options.authorization === undefined
        ? undefined
        : new ResidentAuthorization({
            ...options.authorization,
            node: options.node,
            memoryRoot: this.#memoryRoot,
            estop: this.#estop,
            protectedRoots: options.protectedRoots,
          })
    const semantic = options.semanticRecall
    let memoryIndex: FileVectorIndex | undefined
    try {
      if (semantic !== undefined) {
        memoryIndex = new FileVectorIndex(this.#memoryRoot)
        memoryIndex.prune(
          new FileMemoryStore({ root: this.#memoryRoot, readOnly: true }),
        )
      }
    } catch (error) {
      memoryIndex?.close()
      memoryIndex = undefined
      options.onError?.(
        new Error(
          `memory index unavailable; recall falls back to deterministic: ${errorText(error)}`,
        ),
      )
    }
    this.#memoryIndex = memoryIndex
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
              index: this.#memoryIndex ?? {
                get() {
                  throw new Error('persistent index unavailable')
                },
                set() {
                  throw new Error('persistent index unavailable')
                },
              },
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
      path: qianmoConfigPath('resident', 'lifecycle.json'),
      node: options.node,
      onError: error => this.#options.onError?.(error),
    })
    this.#turn = new OmpResidentTurnPort(
      {
        channelFor: async (sessionId, signal) => {
          if (this.#runtimeChild === null)
            throw new Error('resident omp pool is not ready')
          const first = this.#turn.activeInput(sessionId)
          const owner = first?.agent
          const pool = owner === undefined ? undefined : this.#poolOf(owner)
          // A worker session's task tier picks its model on an external
          // runtime (`harness-backends.md` §11.3); its first turn's counts.
          // Only a hub's background turn, by its signed marker: a chat's
          // direction leaves the agent's model as it is.
          if (first !== undefined && this.#taskFor(first)?.background === true)
            this.#runtimeChild.noteTier(
              sessionId,
              this.#turnPayload(sessionId)?.raw?.direction,
            )
          const child = await this.#runtimeChild.channelFor(sessionId, signal)
          if (pool !== undefined && signal !== undefined)
            this.#hold(sessionId, pool, signal)
          const active = this.#turn.activeInput(sessionId)
          if (active) {
            const { pending, envelope, raw } =
              this.#turnPayload(sessionId) ?? {}
            const text =
              typeof raw?.prompt === 'string'
                ? raw.prompt
                : typeof raw?.text === 'string'
                  ? raw.text
                  : typeof raw?.goal === 'string'
                    ? raw.goal
                    : (pending?.snapshot.map(m => m.text).join('\n') ??
                      active.prompt)
            // Recovered admissions retain the authorized frozen prompt even
            // when their original transport task is no longer in memory.
            const localCommand =
              this.#taskFor(active)?.localCommand ??
              (parseResidentOmpLocalCommand(active.prompt)
                ? active.prompt
                : undefined)
            const route = await child.prepareRoute({
              text,
              hint: raw?.direction,
              localCommand,
            })
            if (route) {
              const actual = route.actual
              this.#options.runtimeAudit?.({
                kind: 'model.route',
                ...(typeof envelope?.taskId === 'string'
                  ? { taskId: envelope.taskId }
                  : {}),
                ...(typeof envelope?.traceId === 'string'
                  ? { traceId: envelope.traceId }
                  : {}),
                detail: {
                  agent: active.agent ?? '',
                  direction: route.direction,
                  source: route.source,
                  rule: route.rule,
                  model: actual.model,
                  thinkingLevel: actual.thinkingLevel,
                  ...(route.mediaModel
                    ? {
                        mediaModel: `${route.mediaModel.provider}/${route.mediaModel.modelId}`,
                      }
                    : {}),
                },
              })
            }
          }
          return child
        },
        isAccepted: async (sessionId, messageId) => {
          if (this.#runtimeChild === null)
            throw new Error('resident omp pool is not ready')
          return await this.#runtimeChild.isAccepted(sessionId, messageId)
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
        // 就是拿 omp RPC 流的实时性换一条装饰行。先同步登记到本任务，
        // 一轮的过程行在其结果之前交给通知器；交接仍在下一 tick 执行。
        onProgress: progress => this.#queueProgress(progress),
        onUsage: (input, usage, sequence) => {
          const task =
            input.networkMsgId === undefined
              ? undefined
              : this.#tasksByMessage.get(input.networkMsgId)
          if (task !== undefined)
            this.#options.usageAudit?.({
              taskId: task.envelope.taskId,
              msgId: task.envelope.msgId,
              traceId: task.envelope.traceId,
              sequence,
              usage,
            })
        },
        memoryAnswer: (input, args) =>
          this.#memory.answer(input.memoryIds ?? [], args),
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
    this.hubCall = new HubCallClient({
      from: `qianmo://${options.node}/console`,
      router: this.#router,
      onError: options.onError,
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
      start: async () => await this.#startRuntime(),
      ...(options.ompRestart?.initialBackoffMs === undefined
        ? {}
        : { initialBackoffMs: options.ompRestart.initialBackoffMs }),
      ...(options.ompRestart?.maxRapidFailures === undefined
        ? {}
        : { maxRapidFailures: options.ompRestart.maxRapidFailures }),
      ...(options.ompRestart?.stableAfterMs === undefined
        ? {}
        : { stableAfterMs: options.ompRestart.stableAfterMs }),
      onError: error => this.#options.onError?.(error),
      onParked: failures =>
        this.#options.onError?.(
          new Error(`resident omp RPC parked after ${failures} rapid failures`),
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
    // Before the first omp RPC child: an intent a crash left behind is committed
    // now, while no child can be reading settings (§2.6 step 5).
    await this.#prepareProviderConfig()
    // With the model service in place: where each agent runs (P36 §2).
    // Waited for, so no turn is routed before Node.js was checked; the
    // default installs go on in the background.
    await this.runtimes.start().catch(error => this.#options.onError?.(error))
    this.#startProviderPoll()
    // The last extension set, laid out again for this start's agents with
    // every MCP server probed anew (P32); in the background, like the hub's.
    void this.extensions.start()
    try {
      await this.#supervisor.run()
      // `supervisor.run()` returning means one of two very different things.
      //
      // Stopped: we are shutting down, fall through and tear the node down.
      //
      // **Parked**: the omp RPC child failed to start five times in a row and the
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
            'resident is degraded: the omp RPC child could not be started, so no ' +
              'agent turn can run here. Delivery, receipts and audit continue; ' +
              'inbound task requests will be refused with a reason. The node ' +
              'stays reachable so peers can tell "agent unavailable" from ' +
              '"node gone" — restart it once the cause is fixed.',
          ),
        )
        await this.#awaitStop()
      }
    } finally {
      this.runtimes.stop()
      await this.desktop.close()
      this.elevation.close()
      await this.extensions.close()
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
   * was previously withheld until the omp RPC turn had actually been admitted,
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
    let runtime = await this.#runtimeForDelivery()
    // Ahead of the write, and synchronous: the poll below no longer reports
    // "this node hosts no such agent" back in time to stop the write.
    try {
      if (runtime === null) this.#assertHosted(message)
      else runtime.assertDeliverable(message)
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
    // A planned switch had no generation to give this to. The write is on
    // disk; if the next generation was published while it landed, hand it
    // over now (its first poll may already have run), else keep it for that
    // generation's first poll. Either way the receipt means "kept" (H-3).
    runtime ??= this.#runtimeIsLive() ? this.#runtime : null
    if (runtime === null) {
      this.#keep(message)
      return result
    }
    this.#startTurn(runtime, message)
    return result
  }

  /** {@link ResidentNodeRuntime.assertDeliverable} with no generation up. */
  #assertHosted(message: QianmoMessage): void {
    const address = parseAddress(message.to)
    if (address === null || address.node !== this.#options.node) {
      throw new Error(
        `message is not addressed to resident node ${this.#options.node}`,
      )
    }
    if (!this.#options.agents.some(agent => agent.agent === address.agent)) {
      throw new Error(`resident agent ${address.agent} is not configured`)
    }
  }

  /** Mark a message kept during a switch; see {@link #switching}. */
  #keep(message: QianmoMessage): void {
    this.#keptMail = true
    const task = this.#tasksByMessage.get(message.msgId)
    if (task !== undefined) task.kept = true
  }

  /**
   * The generation now running takes over what was kept during a switch. A
   * newly published one polls at once on its own; one the commit retained
   * (`poll`) has its poll paused-then-periodic, so it is asked now.
   */
  #adoptKept(runtime: ResidentNodeRuntime, poll: boolean): void {
    this.#switching = false
    if (!this.#keptMail) return
    this.#keptMail = false
    for (const task of this.#tasksByTask.values()) task.kept = false
    if (poll) {
      void this.#trackPoll(runtime.pollAll()).catch(error =>
        this.#options.onError?.(error),
      )
    }
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
      if (this.#stopping) return
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
   * Saturating it is the most direct way to reach the `E_BUSY` refusal below
   * from outside: through the front door it takes that many turns waiting for
   * a place or for their sessions at once.
   */
  get gate(): NodeTurnGate {
    return this.#gate
  }

  #auditControl(
    message: QianmoMessage,
    context: InboundContext,
    outcome: ControlOutcome,
  ): void {
    if (
      message.type !== MessageType.NodeControl ||
      !isNodeControlPayload(message.payload)
    )
      return
    try {
      this.#options.controlAudit?.({
        at: Date.now(),
        source: AuditSource.Control,
        node: this.#options.node,
        peer: context.channel.authenticatedPeerNode ?? '',
        kind: `control.${message.payload.op}`,
        outcome: outcome.ok ? 'ok' : 'refused',
        taskId: message.taskId,
        msgId: message.msgId,
        traceId: message.traceId,
        ...(outcome.ok ? {} : { code: outcome.code }),
        detail: { actor: message.payload.actor },
      })
    } catch (error) {
      this.#options.onError?.(error)
    }
  }

  async #receive(
    message: QianmoMessage,
    context: InboundContext,
  ): Promise<void> {
    // Ahead of everything with a side effect: no task route is registered, no
    // mailbox line is written, no omp RPC turn is opened for a message the routing
    // layer refuses (rule L-1 — a refused message must not eat the recipient's
    // inbox quota).
    const routed = this.#router.inbound(message)
    if (!routed.ok) {
      this.#auditControl(message, context, {
        ok: false,
        code: routed.code,
        message: routed.reason,
      })
      context.channel.send(errorReply(message, routed.code, routed.reason))
      throw new ResidentDeliveryError(routed.code, routed.reason)
    }

    if (
      this.#options.tenantGate !== undefined &&
      !this.#options.tenantGate(context.channel.authenticatedPeerNode ?? null)
    ) {
      const code = ProtocolErrorCode.E_UNKNOWN_AGENT
      const reason = 'recipient is unavailable'
      this.#auditControl(message, context, { ok: false, code, message: reason })
      context.channel.send(errorReply(message, code, reason))
      throw new ResidentDeliveryError(code, reason)
    }

    if (
      message.type === MessageType.AuthzDecision ||
      message.type === MessageType.AuthzRevoke
    ) {
      const payload = message.payload as Record<string, unknown> | null
      const accepted =
        payload !== null &&
        typeof payload === 'object' &&
        Object.keys(payload).length === 1 &&
        (message.type === MessageType.AuthzDecision
          ? this.#authorization?.decision(payload.decision)
          : this.#authorization?.revoke(payload.revoke))
      if (accepted !== true)
        throw new ResidentDeliveryError(
          ProtocolErrorCode.E_CAP_INSUFFICIENT,
          'authorization decision refused',
        )
      return
    }
    if (message.type === MessageType.AuthzRequest) {
      const peer = context.channel.authenticatedPeerNode
      const payload = message.payload as Record<string, unknown> | null
      if (
        !peer ||
        !this.#options.authorization?.approvers.has(peer) ||
        !payload ||
        Object.keys(payload).length !== 1 ||
        payload.subscribe !== true ||
        !context.channel.supports(MessageType.AuthzRequest)
      )
        throw new ResidentDeliveryError(
          ProtocolErrorCode.E_CAP_INSUFFICIENT,
          'approval subscription refused',
        )
      this.#approvalChannels.set(peer, context.channel)
      for (const request of this.#authorization?.pendingFor(peer) ?? [])
        this.#sendAuthz(
          context.channel,
          request,
          this.#authorization!.signed(request),
        )
      return
    }

    if (
      message.type === MessageType.NodeControlResult ||
      message.type === MessageType.HubCall
    ) {
      context.channel.send(
        errorReply(
          message,
          ProtocolErrorCode.E_BAD_TYPE,
          'control message direction refused',
        ),
      )
      return
    }

    if (
      message.type === MessageType.NodeControl ||
      message.type === MessageType.HubSubscribe ||
      message.type === MessageType.HubCallResult
    ) {
      const peer = context.channel.authenticatedPeerNode
      if (
        !peer ||
        !this.#options.controllers?.has(peer) ||
        parseAddress(message.from)?.node !== peer ||
        parseAddress(message.to)?.node !== this.#options.node
      ) {
        const outcome: ControlOutcome = {
          ok: false,
          code: ProtocolErrorCode.E_CAP_INSUFFICIENT,
          message: 'controller is not authorized',
        }
        this.#auditControl(message, context, outcome)
        context.channel.send(
          errorReply(
            message,
            ProtocolErrorCode.E_CAP_INSUFFICIENT,
            outcome.message,
          ),
        )
        if (message.type === MessageType.HubSubscribe)
          throw new ResidentDeliveryError(
            ProtocolErrorCode.E_CAP_INSUFFICIENT,
            outcome.message,
          )
        return
      }
      if (message.type === MessageType.HubCallResult) {
        this.hubCall.receive(
          message,
          context.channel,
          context.connectionGeneration,
        )
        return
      }
      if (message.type === MessageType.HubSubscribe) {
        if (
          !isHubSubscribePayload(message.payload) ||
          !CONTROL_MESSAGE_TYPES.every(type => context.channel.supports(type))
        )
          throw new ResidentDeliveryError(
            ProtocolErrorCode.E_BAD_TYPE,
            'control subscription requires the complete control surface',
          )
        this.hubCall.subscribe(
          peer,
          message.from,
          context.channel,
          context.connectionGeneration,
        )
        return
      }
      if (!isNodeControlPayload(message.payload))
        throw new ResidentDeliveryError(
          ProtocolErrorCode.E_BAD_ENVELOPE,
          'invalid control payload',
        )
      if (!context.channel.supports(MessageType.NodeControlResult)) {
        const outcome: ControlOutcome = {
          ok: false,
          code: ProtocolErrorCode.E_BAD_TYPE,
          message: 'controller cannot receive control results',
        }
        this.#auditControl(message, context, outcome)
        context.channel.send(
          errorReply(message, ProtocolErrorCode.E_BAD_TYPE, outcome.message),
        )
        return
      }
      const agent = parseAddress(message.to)?.agent
      // Keep the logical reply channel alive while the handler runs. A dropped
      // socket must not turn an executed action into a failed receipt/re-execution.
      const release = context.channel.hold()
      const response = createMessage({
        from: message.to,
        to: message.from,
        type: MessageType.NodeControlResult,
        payload: { ok: true, value: null },
        taskId: message.taskId,
        traceId: message.traceId,
      })
      try {
        const result = await this.control.handle(
          message.payload.op,
          message.payload.args,
          {
            peer,
            actor: message.payload.actor,
            resultFits: outcome =>
              Buffer.byteLength(
                JSON.stringify({
                  ...response,
                  hops: [this.#options.node],
                  payload: outcome,
                }),
                'utf8',
              ) <= LIMITS.maxMessageBytes,
            taskId: message.taskId,
            ...(message.payload.operationId === undefined
              ? {}
              : { operationId: message.payload.operationId }),
            ...(this.#options.agents.some(row => row.agent === agent)
              ? { agent }
              : {}),
          },
        )
        this.#auditControl(message, context, result)
        const reply = this.#router.outbound({ ...response, payload: result })
        if (
          reply.ok &&
          context.connectionGeneration ===
            context.channel.connectionGeneration &&
          context.channel.isReady()
        ) {
          try {
            const outgoing =
              messageBytes(reply.message) <= LIMITS.maxMessageBytes
                ? reply.message
                : {
                    ...reply.message,
                    payload: {
                      ok: false,
                      code: 'invalid',
                      message: '控制回执超过 UTF-8 字节上限',
                    },
                  }
            void context.channel
              .sendOnce?.(outgoing)
              .receipt.catch(error => this.#options.onError?.(error))
          } catch (error) {
            this.#options.onError?.(error)
          }
        }
      } finally {
        release()
      }
      return
    }

    // Contact from this peer is the only moment a redelivery can leave, so it
    // is taken here — before the refusals below, which are about *this*
    // message and say nothing about the answers already owed for earlier ones.
    // Fire and forget: an obligation from a previous life must not delay the
    // envelope that just arrived.
    const peerNode =
      this.#options.tenantGate === undefined
        ? parseAddress(message.from)?.node
        : (context.channel.authenticatedPeerNode ?? undefined)
    if (
      peerNode !== undefined &&
      context.channel.supports(MessageType.AuthzRequest)
    ) {
      for (const request of this.#authorization?.pendingFor(peerNode) ?? [])
        this.#sendAuthz(
          context.channel,
          request,
          this.#authorization!.signed(request),
        )
    }
    this.#redeliverOwed(context.channel, peerNode)
    // The other half of the same rule (H-2). A notification produced while the
    // hub was away has been sitting in its ledger; this contact is the only
    // moment it is allowed to leave, and it leaves in the order it was made.
    if (peerNode !== undefined) this.#notifier.drain(context.channel, peerNode)

    // Emergency stop, ahead of the mailbox write for the same rule L-1 reason
    // as the queue check below: a refusal must not spend the recipient's inbox
    // quota. Pause-new-work only — nothing in flight is touched, because a turn
    // that has been admitted has a `task.result` owed to someone.
    if (this.#estop.engaged() || this.#upgradeDraining) {
      const reason = this.#upgradeDraining
        ? 'resident is restarting for an upgrade'
        : 'resident is halted by its ESTOP sentinel'
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
    // sender hears about. A hub-signed answer to the turn running here starts
    // nested at once and never waits in that queue (P36.6).
    const nested =
      message.type === MessageType.TaskRequest &&
      this.#gate.nestsNow(
        askReentry(
          message,
          this.#options.node,
          this.#options.memoryControllers ?? new Map(),
        )?.chain ?? [],
      )
    if (this.#gate.saturated && !nested) {
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
    // P18.20: whether this is a console's local command is decided here, on
    // the verdict this channel produced, before the mailbox write the turn is
    // later assembled from (`residentLocalCommand.ts`).
    if (task !== undefined) {
      task.trust = routed.trust
      task.owner = verifiedTaskOwner(
        message,
        this.#options.memoryControllers ?? new Map(),
      )
      task.background = verifiedBackground(
        message,
        this.#options.memoryControllers ?? new Map(),
      )
      const command = residentLocalCommand(
        message,
        routed,
        this.#localCommandIssuers,
      )
      if (command !== undefined) task.localCommand = command
      // A question that would nest in a turn here right now, with every
      // process its runtime may start held by the turns it would nest in,
      // could only wait for one none of them gives up. Answered at once and
      // before the mailbox write: no turn, nothing left to recover later.
      const crowded = this.#nestedWithoutRoom(message)
      if (crowded !== undefined) {
        task.delivering = false
        void this.#settleTask(
          task,
          createTaskResult(task.envelope, task.envelope.to, {
            outcome: 'failed',
            code: errorCodeForPeer(
              ProtocolErrorCode.E_TASK_FAILED,
              task.channel.peerSupportedTypes,
            ),
            reason: crowded,
          }),
        ).catch(error => this.#options.onError?.(error))
        return
      }
    }
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

  /**
   * `turn.steer` (P38): `text` into the running turn of `task`, where its
   * runtime takes input mid-turn. Only for a turn this very controller asked
   * for and signed (`verified-capability`): the text then carries the same
   * authority as the request it joins, and nobody steers someone else's turn.
   * `steered: false` with a reason otherwise; the hub falls back to the next
   * turn.
   */
  async #steerTurn(
    task: ActiveResidentTask | undefined,
    raw: unknown,
    ctx: { readonly peer: string },
  ): Promise<ControlOutcome> {
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (text === '' || text.length > MAX_STEER_CHARS)
      return {
        ok: false,
        code: 'invalid',
        message: `补充内容需要 1–${MAX_STEER_CHARS} 字`,
      }
    if (
      task === undefined ||
      task.settled ||
      parseAddress(task.envelope.from)?.node !== ctx.peer
    )
      return { ok: true, value: { steered: false, reason: 'not_running' } }
    if (task.trust !== 'verified-capability')
      return { ok: true, value: { steered: false, reason: 'unsigned' } }
    const outcome = await this.#turn.steer(
      task.envelope.msgId,
      `[本轮补充] 来自这一轮的请求方 ${task.envelope.from}，经它签名的控制链路在本轮进行中送达：\n\n${sanitizeRemoteText(text)}`,
    )
    return {
      ok: true,
      value:
        outcome === 'steered'
          ? { steered: true }
          : { steered: false, reason: outcome },
    }
  }

  /** The pool `agent`'s next process comes from (`ResidentRuntimePool`). */
  #poolOf(agent: string): RuntimePool {
    return this.runtimes.effectiveRuntime(agent) === FALLBACK_RUNTIME
      ? 'qianmopi'
      : 'external'
  }

  /** `sessionId`'s turn holds a process of `pool` until `signal` aborts. */
  #hold(sessionId: string, pool: RuntimePool, signal: AbortSignal): void {
    if (signal.aborted) return
    this.#held.set(sessionId, pool)
    signal.addEventListener(
      'abort',
      () => {
        if (this.#held.get(sessionId) === pool) this.#held.delete(sessionId)
      },
      { once: true },
    )
  }

  /**
   * Why a hub-signed question cannot run here now, or undefined (P36.6): it
   * would nest in the running turn, and the turns running already hold every
   * process its agent's runtime may start (`--omp-max-children`).
   */
  #nestedWithoutRoom(message: QianmoMessage): string | undefined {
    const max = this.#options.ompMaxChildren
    if (max === undefined) return undefined
    const agent = parseAddress(message.to)?.agent
    if (
      agent === undefined ||
      !this.#options.agents.some(row => row.agent === agent)
    )
      return undefined
    const chain = askReentry(
      message,
      this.#options.node,
      this.#options.memoryControllers ?? new Map(),
    )?.chain
    if (chain === undefined || !this.#gate.nestsNow(chain)) return undefined
    const pool = this.#poolOf(agent)
    let held = 0
    for (const one of this.#held.values()) if (one === pool) held++
    if (held < max) return undefined
    return `${NESTED_NO_ROOM_REASON}: the turns it would nest in hold all ${max} ${pool} processes this node may start (--omp-max-children)`
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
      settling: false,
      progressQueue: [],
      progressDrain: null,
      delivering: true,
      kept: false,
    }
    this.#tasksByMessage.set(envelope.msgId, task)
    this.#tasksByTask.set(envelope.taskId, task)
    this.#armTaskTimeout(task)
    this.#snapshotBeforeTask(envelope)
    return task
  }

  #sendAuthz(
    channel: TransportChannel,
    request: import('@qianmo/capability').AuthzRequest,
    wire: string,
  ): void {
    const peer =
      request.origin.from === null
        ? undefined
        : parseAddress(request.origin.from)?.node
    channel =
      (peer === undefined ? undefined : this.#approvalChannels.get(peer)) ??
      channel
    if (
      !channel.supports(MessageType.AuthzRequest) ||
      request.origin.from === null
    )
      return
    const routed = this.#router.outbound(
      createMessage({
        from: request.sub,
        to: request.origin.from,
        type: MessageType.AuthzRequest,
        contextId: request.contextId,
        payload: { request: wire },
      }),
    )
    if (routed.ok) channel.send(routed.message)
  }

  /** The console conversation and turn behind a task tool call (P29). */
  #taskOrigin(ctx: {
    readonly agent: string
    readonly sessionId: string
  }): TaskToolOrigin | null {
    const input = this.#turn.activeInput(ctx.sessionId)
    const task = input === undefined ? undefined : this.#taskFor(input)
    if (!task || task.settled || input?.agent !== ctx.agent) return null
    const contextId = task.envelope.contextId
    if (typeof contextId !== 'string' || contextId === '') return null
    return { contextId, taskId: task.envelope.taskId }
  }

  /** The same turn, for a question that waits on other agents (P36.6). */
  #peerOrigin(ctx: {
    readonly agent: string
    readonly sessionId: string
  }): PeerToolOrigin | null {
    const origin = this.#taskOrigin(ctx)
    const input = this.#turn.activeInput(ctx.sessionId)
    const task = input === undefined ? undefined : this.#taskFor(input)
    if (origin === null || task === undefined) return null
    return {
      ...origin,
      remainingMs:
        taskExpiresAt(task.envelope) -
        this.#deadlineClock.nowFor(task.envelope.createdAt),
      keepAlive: () => this.#turn.touch(ctx.sessionId),
    }
  }

  async #approveConnector(
    ctx: ConnectorToolContext,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ contextId: string; requestId: string } | null> {
    const approval = await this.#approveInTurn(ctx, toolName, args)
    return approval.kind === 'allowed'
      ? { contextId: approval.contextId, requestId: approval.requestId }
      : null
  }

  /**
   * One P14 approval of a host tool's exact input, asked in the turn behind
   * `ctx`. A person's no is told apart from a wait that ran out, and an
   * allowed call names the request whose grant let it through — one approved
   * before included, which is how a 批准并继续 turn carries it on to the hub.
   */
  async #approveInTurn(
    ctx: ConnectorToolContext,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<SettingsApproval> {
    const input = this.#turn.activeInput(ctx.sessionId)
    const task = input === undefined ? undefined : this.#taskFor(input)
    if (
      !task ||
      task.settled ||
      !this.#authorization ||
      input?.agent !== ctx.agent
    )
      return { kind: 'refused' }
    const contextId = task.envelope.contextId ?? 'default'
    const outcome = await this.#authorization.requestOutcome(
      { toolName, input: args, agent: ctx.agent, contextId },
      {
        from: task.envelope.from,
        taskId: task.envelope.taskId,
        traceId: task.envelope.traceId,
        trust: task.trust ?? 'untrusted',
      },
      Date.now() +
        taskExpiresAt(task.envelope) -
        this.#deadlineClock.nowFor(task.envelope.createdAt),
      this.#turn.inactivityRemaining(ctx.sessionId),
      (request, wire) => this.#sendAuthz(task.channel, request, wire),
    )
    if (outcome.kind !== 'allowed') return outcome
    if (
      task.settled ||
      this.#turn.activeInput(ctx.sessionId) !== input ||
      (this.#options.tenantGate &&
        !this.#options.tenantGate(task.channel.authenticatedPeerNode ?? null))
    )
      return { kind: 'refused' }
    return { kind: 'allowed', contextId, requestId: outcome.requestId }
  }

  /**
   * Why the turn behind a settings change cannot have it approved (P40
   * §4.1): no approval channel, no running turn, a turn no signed person
   * started, or a hub's background turn (a task's sub-session, a schedule)
   * with nobody there to ask. The hub checks the conversation again.
   */
  #settingsUnavailable(ctx: ConnectorToolContext): SettingsUnavailable | null {
    if (this.#authorization === undefined) return 'no-approver'
    const input = this.#turn.activeInput(ctx.sessionId)
    const task = input === undefined ? undefined : this.#taskFor(input)
    if (!task || task.settled || input?.agent !== ctx.agent) return 'no-turn'
    if (task.trust !== 'verified-capability') return 'unsigned'
    if (task.background === true) return 'background'
    return null
  }

  async #writeMemory(
    sessionId: string,
    raw: unknown,
  ): Promise<{ ok: boolean; text: string }> {
    const denied = {
      ok: false,
      text: 'Memory write was not approved for this running context',
    }
    const input = this.#turn.activeInput(sessionId)
    const task = input === undefined ? undefined : this.#taskFor(input)
    if (
      task === undefined ||
      task.settled ||
      this.#authorization === undefined ||
      input?.agent === undefined
    )
      return denied
    const proposal = parseMemoryWrite(raw)
    if (proposal.scope === 'long' && task.owner === undefined) return denied
    const contextId = task.envelope.contextId ?? 'default'
    const approvalInput = {
      ...proposal,
      ...(proposal.scope === 'long'
        ? { owner: task.owner, destination: `写进 ${task.owner} 的长期记忆` }
        : {}),
    }
    let requestId: string | undefined
    const deadline =
      Date.now() +
      taskExpiresAt(task.envelope) -
      this.#deadlineClock.nowFor(task.envelope.createdAt)
    const approved = await this.#authorization.request(
      {
        toolName: 'qianmo_memory_write',
        input: approvalInput,
        agent: input.agent,
        contextId,
      },
      {
        from: task.envelope.from,
        taskId: task.envelope.taskId,
        traceId: task.envelope.traceId,
        trust: task.trust ?? 'untrusted',
      },
      deadline,
      this.#turn.inactivityRemaining(sessionId),
      (request, wire) => {
        requestId = request.requestId
        this.#sendAuthz(task.channel, request, wire)
      },
    )
    if (
      !approved ||
      requestId === undefined ||
      task.settled ||
      this.#turn.activeInput(sessionId) !== input
    )
      return denied
    if (
      this.#options.tenantGate !== undefined &&
      !this.#options.tenantGate(task.channel.authenticatedPeerNode ?? null)
    )
      return denied
    if (this.#estop.engaged()) return denied
    const entry = writeResidentMemory(
      new FileMemoryStore({ root: this.#memoryRoot }),
      {
        ...proposal,
        ...(task.owner === undefined ? {} : { owner: task.owner }),
        agent: input.agent,
        contextId,
        source: { kind: 'agent', id: requestId },
      },
    )
    return {
      ok: true,
      text: `Memory ${entry.id} was written ${proposal.scope === 'long' ? `for account ${task.owner}` : 'for this context'} with approval ${requestId}. It can be recalled by subsequent turns.`,
    }
  }

  async #requestPermission(
    sessionId: string,
    raw: unknown,
  ): Promise<ResidentPermission> {
    const input = this.#turn.activeInput(sessionId)
    const task = input === undefined ? undefined : this.#taskFor(input)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
    if (task === undefined || task.settled || input?.agent === undefined)
      return {
        ok: false,
        reason:
          '找不到这次调用所属的进行中任务：任务已经结束，或这一回合不是由派发的任务发起的',
      }
    const call = raw as Record<string, unknown>
    if (
      Object.keys(call).length !== 2 ||
      typeof call.toolName !== 'string' ||
      !call.input ||
      typeof call.input !== 'object' ||
      Array.isArray(call.input)
    )
      return false
    if (isDesktopTool(call.toolName)) {
      const live = () =>
        this.#turn.activeInput(sessionId) === input &&
        !task.settled &&
        !this.#stopping &&
        this.#deadlineClock.nowFor(task.envelope.createdAt) <
          taskExpiresAt(task.envelope)
      const deadline =
        Date.now() +
        taskExpiresAt(task.envelope) -
        this.#deadlineClock.nowFor(task.envelope.createdAt)
      return this.desktop.decide(
        input.agent,
        sessionId,
        task.envelope.taskId,
        task.envelope.contextId ?? 'default',
        raw,
        live,
        async (bound, beforeConsume) =>
          this.#authorization === undefined
            ? false
            : this.#authorization.request(
                bound,
                {
                  from: task.envelope.from,
                  taskId: task.envelope.taskId,
                  traceId: task.envelope.traceId,
                  trust: task.trust ?? 'untrusted',
                },
                deadline,
                this.#turn.inactivityRemaining(sessionId),
                (request, wire) => this.#sendAuthz(task.channel, request, wire),
                beforeConsume,
              ),
      )
    }
    if (this.#authorization === undefined) return false
    const agent = this.#options.agents.find(
      agent => agent.agent === input.agent,
    )
    if (agent === undefined) return false
    const tool = {
      toolName: call.toolName,
      input: call.input as Readonly<Record<string, unknown>>,
    }
    // An external-runtime agent started with --agent-shell asks the operator
    // for each shell command; qianmopi agents never get one (P27 §1.3).
    const shellCall =
      tool.toolName === 'bash' &&
      agent.runtime !== undefined &&
      agent.shell === true &&
      typeof tool.input.command === 'string'
    let boundInput: Readonly<Record<string, unknown>> = tool.input
    if (!shellCall) {
      const verdict = residentToolVerdict(
        tool,
        {
          v: 1,
          agent: agent.agent,
          workspace: agent.cwd,
          edits: this.#options.allowWorkspaceEdits ? 'workspace' : 'none',
          protectedRoots: [
            this.#memoryRoot,
            ...(this.#options.protectedRoots ?? []),
          ],
          hostTools: [],
          approvals: true,
        },
        { agentKind: 'main' },
      )
      if (verdict?.approvalEligible !== true) return false
      boundInput = residentApprovalInput(tool, agent.cwd)
      if (
        JSON.stringify(boundInput.__qianmoResolvedTargets) !==
        JSON.stringify(tool.input.__qianmoResolvedTargets)
      )
        return false
    }
    const deadline =
      Date.now() +
      taskExpiresAt(task.envelope) -
      this.#deadlineClock.nowFor(task.envelope.createdAt)
    return await this.#authorization.request(
      {
        ...tool,
        input: boundInput,
        agent: agent.agent,
        contextId: task.envelope.contextId ?? 'default',
      },
      {
        from: task.envelope.from,
        taskId: task.envelope.taskId,
        traceId: task.envelope.traceId,
        trust: task.trust ?? 'untrusted',
      },
      deadline,
      this.#turn.inactivityRemaining(sessionId),
      (request, wire) => this.#sendAuthz(task.channel, request, wire),
    )
  }

  /**
   * Answer one `QIANMO_ELEVATION_V1` gate phase for a high-permission call
   * (P39). Attribution comes from the active turn, never the model; the tiers
   * that ask the operator go through the same P14 one-shot path as the desktop.
   */
  async #requestElevation(sessionId: string, raw: unknown): Promise<boolean> {
    const input = this.#turn.activeInput(sessionId)
    const task = input === undefined ? undefined : this.#taskFor(input)
    if (task === undefined || task.settled || input?.agent === undefined)
      return false
    const contextId = task.envelope.contextId ?? 'default'
    const live = () =>
      this.#turn.activeInput(sessionId) === input &&
      !task.settled &&
      !this.#stopping &&
      this.#deadlineClock.nowFor(task.envelope.createdAt) <
        taskExpiresAt(task.envelope)
    const deadline =
      Date.now() +
      taskExpiresAt(task.envelope) -
      this.#deadlineClock.nowFor(task.envelope.createdAt)
    const approve = async (call: AuthzCall): Promise<boolean> =>
      this.#authorization === undefined
        ? false
        : this.#authorization.request(
            call,
            {
              from: task.envelope.from,
              taskId: task.envelope.taskId,
              traceId: task.envelope.traceId,
              trust: task.trust ?? 'untrusted',
            },
            deadline,
            this.#turn.inactivityRemaining(sessionId),
            (request, wire) => this.#sendAuthz(task.channel, request, wire),
          )
    const decision = await this.elevation.decide(
      input.agent,
      task.envelope.taskId,
      contextId,
      raw,
      live,
      approve,
    )
    return decision.ok
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
  ): string | ResidentAssembledPrompt | Promise<ResidentAssembledPrompt> {
    // A console's local command runs as itself: no teammate block, no memory
    // sidecar. The mailbox entry only names the task; the text comes from the
    // envelope the verdict was reached on (`residentLocalCommand.ts`).
    const msgId = networkMessageId(messages)
    const command =
      msgId === undefined
        ? undefined
        : this.#tasksByMessage.get(msgId)?.localCommand
    if (command !== undefined) return command
    if (this.#options.semanticRecall !== undefined) {
      return this.#assembleTwoStage(messages, scope)
    }
    let memoryIds: readonly string[] = []
    const prompt = assembleResidentPrompt({
      messages,
      // The batch text doubles as the ranking question. It never filters — a
      // watch job that words things differently from the entry it needs still
      // sees that entry, which is the point of full injection.
      renderMemory: base => {
        const memory = this.#memory.renderFrozen(scope, base)
        memoryIds = memory.memoryIds ?? []
        return memory.block
      },
      onFinding: error => this.#options.onError?.(error),
    })
    return { prompt, memoryIds }
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
    try {
      this.#memoryIndex?.prune(
        new FileMemoryStore({ root: this.#memoryRoot, readOnly: true }),
      )
    } catch (error) {
      this.#options.onError?.(error)
    }
    let retrieval: RetrievalMode | undefined
    let memoryIds: readonly string[] = []
    const prompt = await assembleResidentPromptAsync({
      messages,
      renderMemory: async base => {
        const memory = await this.#memory.renderHybrid(scope, base)
        retrieval = memory.retrieval
        memoryIds = memory.memoryIds ?? []
        return memory.block
      },
      onFinding: error => this.#options.onError?.(error),
    })
    return {
      prompt,
      memoryIds,
      ...(retrieval === undefined ? {} : { retrieval }),
    }
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
    if (task.settled || task.settling) return
    const now = this.#deadlineClock.nowFor(task.envelope.createdAt)
    const remaining = taskExpiresAt(task.envelope) - now
    task.timeout = setTimeout(
      () => {
        task.timeout = null
        if (task.settled || task.settling) return
        const adjustedNow = this.#deadlineClock.nowFor(task.envelope.createdAt)
        if (adjustedNow < taskExpiresAt(task.envelope)) {
          this.#armTaskTimeout(task)
          return
        }
        // A background turn is stopped, the way `/stop` stops one, and is
        // answered once it has ended: until then it is still this task's turn,
        // so its `qianmo_task_report` reaches the hub. An ordinary turn is
        // answered at once and keeps running, as it always has.
        if (
          task.background === true &&
          !task.stoppedAtDeadline &&
          this.#turn.stop(task.envelope.msgId)
        ) {
          task.stoppedAtDeadline = true
          task.timeout = setTimeout(() => {
            task.timeout = null
            void this.#settleTask(task, this.#deadlineResult(task))
          }, BACKGROUND_STOP_GRACE_MS)
          task.timeout.unref?.()
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

  /** The answer to a background turn this node stopped at its deadline. */
  #deadlineResult(task: ActiveResidentTask, compacted?: true): QianmoMessage {
    return createTaskResult(task.envelope, task.envelope.to, {
      outcome: 'failed',
      code: ProtocolErrorCode.E_TASK_TIMEOUT,
      reason:
        'background turn reached its task deadline and was stopped; work done so far is kept',
      ...(compacted === undefined ? {} : { compacted }),
    })
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
      task.stoppedAtDeadline === true && result.outcome === 'failed'
        ? this.#deadlineResult(task, result.compacted)
        : createTaskResult(task.envelope, task.envelope.to, result),
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
      task.stoppedAtDeadline === true
        ? this.#deadlineResult(task)
        : createTaskResult(task.envelope, task.envelope.to, {
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
    if (task.settled || task.settling) return
    // Claim once and close the queue synchronously. Success, timeout and
    // teardown may race while the last notifier handoff is still pending.
    task.settling = true
    if (task.timeout !== null) clearTimeout(task.timeout)
    task.timeout = null
    const receipt = (async () => {
      // Keep the task visible and unsettled until its registered rows have
      // been handed to announce(): durable accounting and a sent/queued
      // decision, never notify receipts or another task's backlog.
      await this.#drainTaskProgress(task)
      task.settled = true
      this.#options.usageEndAudit?.(task.envelope.taskId, task.envelope.traceId)
      this.#tasksByMessage.delete(task.envelope.msgId)
      this.#tasksByTask.delete(task.envelope.taskId)
      // Terminal state reached (protocol.md §8.2 rows 19–20).
      this.#router.release(task.envelope.taskId)
      // Written down before the reply goes on the wire so a lost receipt
      // leaves an obligation the next generation can redeliver.
      await this.#awaitReceipt(task, reply, this.#openDelivery(reply))
    })()
    // Teardown awaits a non-rejecting handle in bulk; failures still reach
    // this method's caller through the await below.
    const tracked = receipt.catch(() => {})
    // Registered before the first await in this method: teardown must also
    // retain the transport during the progress drain, before any reply exists.
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
      await task.channel.sendAndWait(
        reply,
        this.#options.replyReceiptTimeoutMs ?? TASK_REPLY_RECEIPT_TIMEOUT_MS,
      )
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
   * Answer `qianmo/notify` from the omp RPC child (design §4.1⑤, §2 end to end).
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
    const peerNode =
      this.#options.tenantGate === undefined
        ? parseAddress(task.envelope.from)?.node
        : (task.channel.authenticatedPeerNode ?? undefined)
    if (
      this.#options.tenantGate !== undefined &&
      (peerNode === undefined ||
        !this.#options.tenantGate(peerNode) ||
        parseAddress(task.envelope.from)?.node !== peerNode)
    )
      return this.#notifyRefusal('requester connection is no longer authorized')
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
   * Put one step of a running turn on its task's queue, synchronously, so a
   * result that settles the task in the same batch of frames still finds the
   * step there and hands it to the notifier first (see {@link #settleTask}).
   * A step for a task already settling or gone, or past the turn's budget, is
   * dropped in silence like any other undeliverable step.
   */
  #queueProgress(progress: ResidentTurnProgress): void {
    const task = this.#tasksByMessage.get(progress.networkMsgId)
    if (
      task === undefined ||
      task.settled ||
      task.settling ||
      task.progressQueue.length >= MAX_RESIDENT_TURN_PROGRESS
    )
      return
    task.progressQueue.push(progress)
    void this.#drainTaskProgress(task)
  }

  /**
   * One FIFO per task; ledger writes always stay outside the RPC frame stack.
   *
   * Never rejects: {@link #settleTask} awaits this before the reply exists, so
   * a row that throws on its way to the notifier is reported and skipped, and
   * can never hold the task's result back.
   */
  #drainTaskProgress(task: ActiveResidentTask): Promise<void> {
    if (task.progressDrain !== null) return task.progressDrain
    if (task.progressQueue.length === 0) return Promise.resolve()
    const drain = Promise.withResolvers<void>()
    task.progressDrain = drain.promise
    setImmediate(() => {
      const send = async () => {
        try {
          let progress: ResidentTurnProgress | undefined
          while ((progress = task.progressQueue.shift()) !== undefined) {
            try {
              await this.#pushProgress(progress)
            } catch (error) {
              this.#options.onError?.(error)
            }
          }
        } finally {
          task.progressDrain = null
        }
      }
      void send().then(drain.resolve, drain.resolve)
    })
    return drain.promise
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
    const peerNode =
      this.#options.tenantGate === undefined
        ? parseAddress(task.envelope.from)?.node
        : (task.channel.authenticatedPeerNode ?? undefined)
    if (
      this.#options.tenantGate !== undefined &&
      (peerNode === undefined ||
        !this.#options.tenantGate(peerNode) ||
        parseAddress(task.envelope.from)?.node !== peerNode)
    )
      return
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
        await channel.sendAndWait(
          reply,
          this.#options.replyReceiptTimeoutMs ?? TASK_REPLY_RECEIPT_TIMEOUT_MS,
        )
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
        // only exists because the listener now outlives the omp RPC child: before
        // that, nothing could arrive between the death and the restart. A task
        // kept during a provider switch is in the same position: on disk,
        // waiting for the next generation.
        .filter(task => !task.delivering && !task.kept)
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
   * Keep the transport alive through progress handoffs and reply receipts.
   *
   * {@link #failActiveTasks} claims active tasks and awaits their receipts.
   * A task already inside {@link #settleTask} cannot be claimed again: its
   * progress may still be reaching the notifier, or its reply may already be
   * awaiting a receipt after leaving both maps. `#settling` tracks both phases
   * so `transport.stop()` cannot cut their channel out from under them.
   *
   * Bounded by the same budget one receipt already gets: teardown will not wait
   * longer for confirmations than a single confirmation is allowed to take. A
   * peer that has gone away therefore costs at most that budget — which is what
   * {@link #failActiveTasks} has always cost on the same path.
   */
  async #drainReplyReceipts(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(
        resolve,
        this.#options.replyReceiptTimeoutMs ?? TASK_REPLY_RECEIPT_TIMEOUT_MS,
      )
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
    this.hubCall.close()
    void this.desktop.close().catch(error => this.#options.onError?.(error))
    this.elevation.close()
    this.#authorization?.close()
    this.#memoryIndex?.close()
    this.#approvalChannels.clear()
    if (this.#stopping) return
    this.#stopping = true
    this.#generationAbort.abort(
      new Error('resident stopped during model initialization'),
    )
    // The supervisor only owns a generation after start() returns. The pool
    // is already available while the default sessions are being registered.
    if (this.#generationStarting)
      void this.#runtimeChild
        ?.stop()
        .catch(error => this.#options.onError?.(error))
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
   * in two windows where it previously could not: while the first omp RPC child is
   * still starting, and during the backoff between restarts. Refusing those
   * deliveries would trade one wrong answer for another — the node is not
   * broken, the agent is seconds away — so they wait.
   *
   * **Parked is different and must not wait**: the supervisor has given up, so
   * no amount of waiting produces a runtime. Answer immediately with the
   * reason, which is what lets a peer tell "agent unavailable" from "node
   * gone". Same for a node already stopping.
   *
   * **A planned provider switch does not wait either**, the other way: it
   * answers `null`, "keep it for the next generation" ({@link #switching}).
   * That generation can be further off than any wait a sender's receipt
   * budget allows — the model probe alone may take longer — and the first
   * message after an apply used to be turned away exactly there.
   */
  async #runtimeForDelivery(): Promise<ResidentNodeRuntime | null> {
    if (this.#runtimeChild?.parkedReason)
      throw new Error(this.#runtimeChild.parkedReason)
    const ready = this.#runtimeIsLive() ? this.#runtime : null
    if (ready !== null) return ready
    if (this.#supervisor.parked || this.#stopping) {
      throw new Error(RESIDENT_AGENT_UNAVAILABLE)
    }
    if (this.#providerCommitting || this.#switching) return null
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
    if (this.#runtimeChild?.parkedReason)
      throw new Error(this.#runtimeChild.parkedReason)
    const runtime = this.#runtimeIsLive() ? this.#runtime : null
    if (runtime !== null) return runtime
    if (this.#supervisor.parked || this.#stopping)
      throw new Error(RESIDENT_AGENT_UNAVAILABLE)
    // A switch that began while this delivery waited.
    if (this.#providerCommitting || this.#switching) return null
    throw new Error(RESIDENT_AGENT_RESTARTING)
  }

  /**
   * Whether `#runtime` still has a live omp RPC child behind it.
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
    if (this.#runtime === null || this.#providerCommitting) return false
    const child = this.#runtimeChild
    if (child === null) return true
    return child.alive
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
      await this.control.close()
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
   * **It is deliberately not owned by the omp RPC child.** It used to be: the
   * listener was created at the end of `#startRuntime`, after `sessions.start()`,
   * and torn down when that child stopped. Two consequences, both bad, both
   * invisible until this repository's CI was first able to run:
   *
   *   · Every omp RPC restart dropped the listener. A peer dialling during the
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
      supportedTypes: [
        ...LEGACY_MESSAGE_TYPES,
        MessageType.AuthzRequest,
        MessageType.AuthzDecision,
        MessageType.AuthzRevoke,
        ...CONTROL_MESSAGE_TYPES,
        CONTROL_OPERATION_ID_CAPABILITY,
        RUNTIME_CATALOG_CAPABILITY,
      ],
      onPeerDisconnect: () => this.hubCall.disconnected(),
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
    // Reported here rather than at the end of `#startRuntime`: reachability is a
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
  async #startRuntime(): Promise<ResidentChildConnection> {
    this.#generation += 1
    this.#generationStarting = true
    try {
      // A commit can have begun during supervisor backoff. Holding starting
      // prevents a later commit; joining this one prevents validating old config.
      await this.#providerCommitFlight
      this.#generationAbort.signal.throwIfAborted()
      await this.#options.beforeModelGeneration?.({
        generation: this.#generation,
        signal: this.#generationAbort.signal,
      })
      if (this.#stopping)
        throw new Error('resident stopped before model generation')
      this.#recordProviderGeneration()
      return await this.#spawnGeneration()
    } finally {
      this.#generationStarting = false
    }
  }

  /**
   * The agents as `qm runtime open` needs them (P36.7, secret-free): the
   * workspace, and the runtime and model their external sessions start with.
   */
  #writeRuntimeRoster(): void {
    try {
      writeResidentRoster(
        this.#options.agents.map(agent => {
          const runtime = this.runtimes.nativeRuntimeOf(agent.agent)
          const state = this.runtimes.state(agent.agent)
          return {
            agent: agent.agent,
            cwd: agent.cwd,
            shell: agent.shell === true,
            runtime,
            bin: runtimeBin(runtime, this.#options.runtimeBins),
            model:
              state?.effective.runtime === runtime
                ? (state.effective.model ?? null)
                : null,
          }
        }),
      )
    } catch (error) {
      this.#options.onError?.(error)
    }
  }

  /**
   * The mailbox entry of `sessionId`'s active turn and its payload, when the
   * turn came as one network message.
   */
  #turnPayload(sessionId: string):
    | {
        readonly pending:
          | ReturnType<FileAdmissionLedger['query']>['pending'][number]
          | undefined
        readonly envelope: ReturnType<typeof networkEnvelope>
        readonly raw: Record<string, unknown> | undefined
      }
    | undefined {
    const active = this.#turn.activeInput(sessionId)
    if (!active) return undefined
    const pending = active.agent
      ? this.#ledger(active.agent)
          .query()
          .pending.find(p => p.messageId === active.messageId)
      : undefined
    const envelope =
      pending?.snapshot.length === 1
        ? networkEnvelope(pending.snapshot[0])
        : undefined
    const payload = envelope?.payload
    const raw =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : undefined
    return { pending, envelope, raw }
  }

  /**
   * The external-runtime half of a generation (P27). It knows every agent:
   * which runtime one runs on is read when its process starts (P36).
   */
  #externalPool(): ExternalRuntimePool {
    const runtimes = this.runtimes
    const agents = this.#options.agents.map(
      (agent): ExternalAgent => ({
        agent: agent.agent,
        cwd: agent.cwd,
        ...(agent.shell === undefined ? {} : { shell: agent.shell }),
        get runtime() {
          return runtimes.externalRuntimeOf(agent.agent)
        },
      }),
    )
    const resolve = this.#options.resolveRuntimeLaunch
    // `runtimeOf` is the pool's spawn-time hook (P36.2); the getter above
    // gives the same answer to a pool without it.
    const options: ConstructorParameters<typeof ExternalRuntimePool>[0] & {
      readonly runtimeOf?: (agent: string) => string
    } = {
      agents,
      runtimeOf: agent => runtimes.externalRuntimeOf(agent),
      resolveLaunch: (agent, session) => {
        if (resolve === undefined)
          throw new Error(
            `${agent.agent} runs on ${agent.runtime}, but this node has no model for it (--agent-model)`,
          )
        return resolve(agent, session)
      },
      ...(this.#options.runtimeBins === undefined
        ? {}
        : { bins: this.#options.runtimeBins }),
      memoryRoot: this.#memoryRoot,
      ...(this.#options.protectedRoots === undefined
        ? {}
        : { protectedRoots: this.#options.protectedRoots }),
      allowWorkspaceEdits: this.#options.allowWorkspaceEdits === true,
      extensions: agent => this.extensions.forAgent(agent),
      desktop: this.desktop,
      hostTools: {
        extraHostTools: [
          ...this.#hubHostTools,
          ...(this.#options.extraHostTools ?? []),
        ],
        ...(this.#authorization === undefined
          ? {}
          : {
              memoryWrite: (sessionId: string, args: unknown) =>
                this.#writeMemory(sessionId, args),
            }),
        memoryAnswer: (sessionId, args) =>
          this.#turn.memoryAnswer(sessionId, args),
        announce: params => this.#announce(params),
      },
      requestPermission: (sessionId, call) =>
        this.#requestPermission(sessionId, call),
      ...(this.#options.spawnRuntime === undefined
        ? {}
        : { spawn: this.#options.spawnRuntime }),
      ...(this.#options.runtimeMcpArgv === undefined
        ? {}
        : { mcpArgv: this.#options.runtimeMcpArgv }),
      ...(this.#options.ompIdleMs === undefined
        ? {}
        : { idleChildMs: this.#options.ompIdleMs }),
      ...(this.#options.ompMaxChildren === undefined
        ? {}
        : { maxChildren: this.#options.ompMaxChildren }),
      onActivity: active => this.#options.onActivity?.(active),
      onError: error => this.#options.onError?.(error),
    }
    return new ExternalRuntimePool(options)
  }

  async #spawnGeneration(): Promise<ResidentChildConnection> {
    const ompPool = new ResidentOmpPool({
      desktop: this.desktop,
      elevation: this.elevation,
      extensions: agent => this.extensions.forAgent(agent),
      extraHostTools: [
        ...this.#hubHostTools,
        ...(this.#options.extraHostTools ?? []),
      ],
      onLaunch: (sessionId, policy, configHash) =>
        (this.#options.runtimeAudit ?? this.#options.authorization?.audit)?.({
          kind: 'authz.posture',
          detail: {
            sessionId,
            agent: policy.agent,
            workspace: policy.workspace,
            home: nodeHomeDir(),
            configDir: qianmoConfigDir(),
            qmcodeHome: qmcodeHome(),
            stateRoots: JSON.stringify(protectedConfigRoots()),
            edits: policy.edits,
            roots: JSON.stringify(policy.protectedRoots),
            hostTools: JSON.stringify(policy.hostTools),
            approvalMode: residentApprovalMode(policy),
            elevation: policy.elevation?.tier ?? 'off',
            configHash,
            policy: JSON.stringify(policy),
          },
        }),
      protectedRoots: this.#options.protectedRoots,
      agents: this.#options.agents,
      // An agent configured on qianmopi with a model or effort of its own
      // (`harness-backends.md` §11.2).
      agentModel: (agent, fallback) =>
        this.runtimes.ompSelection(agent, fallback),
      memoryRoot: this.#memoryRoot,
      allowWorkspaceEdits: this.#options.allowWorkspaceEdits,
      spawn: this.#options.spawnOmp,
      idleChildMs: this.#options.ompIdleMs,
      maxChildren: this.#options.ompMaxChildren,
      maxStartFailures: this.#options.ompRestart?.maxRapidFailures,
      onParked: () => this.#poller?.stop(),
      onActivity: this.#options.onActivity,
      onError: this.#options.onError,
      announce: params => this.#announce(params),
      ...(this.#authorization === undefined
        ? {}
        : {
            memoryWrite: (sessionId: string, args: unknown) =>
              this.#writeMemory(sessionId, args),
          }),
      memoryAnswer: (sessionId, args) =>
        this.#turn.memoryAnswer(sessionId, args),
      requestPermission: (sessionId: string, call: unknown) =>
        this.#requestPermission(sessionId, call),
      requestElevation: (sessionId: string, call: unknown) =>
        this.#requestElevation(sessionId, call),
    })
    const child = new ResidentRuntimePool(ompPool, this.#externalPool(), {
      runtimeOf: agent => this.runtimes.effectiveRuntime(agent),
      onError: error => this.#options.onError?.(error),
    })
    const closed = child.closed
    void closed.catch(() => {})
    // Retire the runtime the moment the child is gone, not when the supervisor
    // gets around to calling `stop()`. With the listener no longer dying with
    // the child, a peer can deliver in that gap, and a runtime whose omp RPC
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
        const reaping = child.stop()
        try {
          await this.#failActiveTasks('resident omp RPC connection closed')
          // Both of these need the transport up. It is: the listener is owned by
          // `run()` now, not by this child, so it outlives every omp RPC restart and
          // every park. Before that change it was torn down here and rebuilt by
          // the next `#startRuntime`, which is why a child that could not start left
          // the node with no listener at all.
          await this.#drainReplyReceipts()
        } finally {
          // Audit/receipt failures must still reap every process before this
          // memoized teardown can reject. Otherwise the supervisor catches
          // that error and starts the next generation beside a live old one.
          await reaping
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
      const connection = child
      this.#runtimeChild = child

      const sessions = new ResidentSessionManager({
        onContextEnd: key => {
          this.#authorization?.store.endContext(
            contextOfSessionKey(key) ?? 'default',
          )
        },
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
          stage: 'runtime_ready',
          generation: this.#generation,
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
        owner: messages => {
          const id = networkMessageId(messages)
          return id === undefined
            ? undefined
            : this.#tasksByMessage.get(id)?.owner
        },
        deadlineOf: message => this.#taskDeadlineOf(message),
        backgroundOf: messages => {
          const id = networkMessageId(messages)
          return (
            id !== undefined &&
            this.#tasksByMessage.get(id)?.background === true
          )
        },
        // A hub-signed question nests in the turn here that asked it (P36.6).
        reentryOf: messages => {
          const task = this.#tasksByMessage.get(
            networkMessageId(messages) ?? '',
          )
          return task === undefined
            ? undefined
            : askReentry(
                task.envelope,
                this.#options.node,
                this.#options.memoryControllers ?? new Map(),
              )
        },
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
          if (stopping === null && !this.#stopping)
            await this.#failTask(error, input)
          this.#checkProviderSoon()
        },
      })
      this.#runtime = runtime
      this.#runtimeChild = child
      const waiters = this.#runtimeWaiters
      this.#runtimeWaiters = []
      for (const wake of waiters) wake()
      // Mail kept during a switch is this generation's now; the poller
      // started below admits it on its first, immediate poll.
      this.#adoptKept(runtime, false)

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
        paused: () =>
          this.#estop.engaged() ||
          this.#providerCommitting ||
          this.#upgradeDraining,
        ...(this.#options.pollIntervalMs === undefined
          ? {}
          : { intervalMs: this.#options.pollIntervalMs }),
        onError: error => {
          if (stopping === null && !this.#stopping)
            this.#options.onError?.(error)
        },
      })
      this.#poller = poller
      poller.start()

      return { closed, stop, isStable: ms => child.isStable(ms) }
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
        qianmoConfigPath('resident', agent, 'admission.ndjson'),
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
   * commit it and recycle the omp RPC child.
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
    if (this.#providerCommitting) {
      this.#providerCheckQueued = true
      return
    }
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
    if (this.#supervisor.parked || this.#runtimeChild?.parkedReason) {
      this.#raiseOnce(
        waiting,
        'parked',
        'a provider configuration is pending, but the omp RPC child is parked and no generation will start to load it; it will be committed when this resident is restarted',
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
            `${Math.round((now - waiting.since) / 60_000)} min for the omp RPC child to go idle ` +
            `(${describeInFlight(inFlight)}). It is not forced: the switch happens when the ` +
            'work in flight ends.',
        )
      }
      this.#writeWaiting(waiting, inFlight)
      return
    }
    this.#providerCommitting = true
    const operation = this.#commitAndRecycle(node, waiting).finally(() => {
      this.#providerCommitting = false
      if (this.#providerCommitFlight === operation)
        this.#providerCommitFlight = undefined
      if (this.#providerCheckQueued) {
        this.#providerCheckQueued = false
        queueMicrotask(() => this.checkProviderConfig())
      }
      // A refused/no-op commit retains the generation: release held deliveries.
      if (this.#runtimeIsLive()) {
        const waiters = this.#runtimeWaiters
        this.#runtimeWaiters = []
        for (const wake of waiters) wake()
        if (this.#runtime !== null) this.#adoptKept(this.#runtime, true)
      }
    })
    this.#providerCommitFlight = operation
    void operation.catch(error => this.#options.onError?.(error))
  }

  /** The idle half of {@link checkProviderConfig}. */
  async #commitAndRecycle(
    node: ResidentProviderNode,
    waiting: ProviderWaiting,
  ): Promise<void> {
    const before = managedHashOf(node)
    let result: ResidentProviderCommit
    try {
      result = await node.commitPendingProviderConfig()
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
    // A model an external runtime needs may have come or gone (P36 §3.3).
    this.runtimes.recompute()
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
    if (via === 'switch') {
      // Before the recycle nulls the runtime: from here deliveries are kept
      // for the next generation rather than turned away (`#switching`).
      this.#switching = true
      this.#supervisor.recycle()
    }
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
          ? 'settings.json did change, so the omp RPC child is recycled anyway, with its sessions reset.'
          : 'It stays pending and is retried on the next check.'),
    )
    this.#writeSwitchStatus({
      last: this.#switchOutcome('write-failed', requestId, null, detail),
    })
    if (changed) {
      this.#applySessionPolicy('reset')
      this.#switching = true
      this.#supervisor.recycle()
    }
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
  async #prepareProviderConfig(): Promise<void> {
    const node = this.#options.providerNode
    if (node === undefined) return
    try {
      const result = await node.commitPendingProviderConfig()
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
        this.#authorization?.store.endContext(
          contextOfSessionKey(key) ?? 'default',
        )
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
   * What stopping the omp RPC child now would cut off, or `null` when nothing.
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
      turns: this.#gate.depth,
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
        readFileSync(
          qianmoConfigPath('resident', PROVIDER_SWITCH_FILE),
          'utf8',
        ),
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
      const path = qianmoConfigPath('resident', PROVIDER_SWITCH_FILE)
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
