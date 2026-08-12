// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `@qianmo/activator` — one component with two faces, both host-side, both
 * acting on a sandboxed node's behalf against the sandbox daemon.
 *
 * **The activator face** (`activator.ts`) catches a request for a sleeping
 * node, wakes it, waits for it to actually be ready, and forwards. Nothing
 * else provides this: the kernel's accept queue buffers a connection only on
 * the machine the service lives on, and the sandbox daemon listens on loopback
 * and offers no cross-machine equivalent (E1).
 *
 * **The keepalive face** (`keepalive.ts`) beats against the daemon API on a
 * period strictly under the sandbox's freeze threshold. It has to be external
 * and it has to reach the API, because work done *inside* the sandbox is
 * invisible to the idle judgement: a 100 %-CPU process was frozen at 110 s and
 * made no progress for the following 411 s (E3). And it must not be replaced by
 * `stopAfterSeconds: null`, which trades a recoverable failure for a permanent
 * silent one — {@link assertResidencyPolicy} refuses that configuration.
 *
 * **Why one package.** Both faces hold the same credential, and that credential
 * has no privilege tiers: the bearer that touches a sandbox is the bearer that
 * destroys it. One component means one capability surface (`capability.ts`) —
 * `touch`, `acquire`, `status`, and nothing else, unreachable rather than
 * merely unconfigured. AC-6(c) rests on that surface staying this small.
 *
 * **What the tests here do and do not show.** The daemon is an external system,
 * modelled as a port with a local stand-in (`test/stub-daemon.ts`). Every line
 * of scheduling, retry, allowlist, journal and recovery logic is exercised for
 * real against it, over a real socket; none of it is evidence about how the
 * real daemon behaves.
 *
 * Two of P2.5's four acceptance criteria therefore have **no coverage in this
 * package and are not claimed**:
 *
 * - **DoD ①** — ten consecutive catch/wake/forward round trips against a
 *   genuinely dormant node, with stage timings. Needs a real sandbox on the
 *   Linux host. The ports to fill in are {@link SandboxDaemon} (already
 *   implemented over HTTP by {@link HttpSandboxDaemon}), {@link ReadyProbe} and
 *   {@link ForwardTarget}; nothing in this package changes for the real run.
 * - **DoD ②** — a busy in-sandbox process surviving several multiples of the
 *   freeze threshold with the heartbeat on, and being frozen with it off. The
 *   control half is the load-bearing half: "it did not break" without the
 *   negative case is not evidence.
 *
 * Covered here instead: **DoD ③** (`capability.test.ts`,
 * `destroy-unreachable.test.ts`, `surface-invariant.test.ts`) and **DoD ④**
 * (`crash-recovery.test.ts`, real child process, real SIGKILL).
 */

export {
  Activator,
  DEFAULT_MAX_IN_FLIGHT,
  DEFAULT_READY_POLL_INTERVAL_MS,
  DEFAULT_READY_TIMEOUT_MS,
  type ActivationOutcome,
  type ActivationRequest,
  type ActivatorOptions,
  type FailureSink,
  type ForwardTarget,
  type ReadyProbe,
  type RecoveryReport,
} from './activator.js'

export {
  ActivatorEventType,
  AuditLog,
  DEFAULT_AUDIT_CAPACITY,
  type AuditEvent,
  type AuditSink,
} from './audit.js'

export {
  ALLOWED_METHODS,
  CapabilityDeniedError,
  DAEMON_CAPABILITY_SURFACE,
  DESTRUCTIVE_WORDS,
  DaemonOp,
  assertSurfaceIsSafe,
  capabilitySurface,
  resolveRoute,
  type DaemonRoute,
  type DenialReason,
} from './capability.js'

export {
  DEFAULT_GRACE_MS,
  DEFAULT_MIN_JUMP_GAP_MS,
  DEFAULT_TIME_JUMP_FACTOR,
  TimeJumpGate,
  systemClock,
  timerScheduler,
  type CancelTimer,
  type Clock,
  type Scheduler,
  type TimeJumpGateOptions,
  type TimeJumpObservation,
} from './clock.js'

export {
  DAEMON_TOKEN_ENV_VAR,
  DEFAULT_DAEMON_TIMEOUT_MS,
  DaemonRequestError,
  HttpSandboxDaemon,
  assertLoopbackBaseUrl,
  assertSandboxId,
  tokenFromEnv,
  type DaemonResponse,
  type FetchLike,
  type HttpSandboxDaemonOptions,
  type SandboxDaemon,
  type SandboxState,
  type SandboxStatus,
} from './daemon.js'

export {
  FileRequestJournal,
  MemoryRequestJournal,
  defaultJournalPath,
  type AcceptedRecord,
  type JournalRecord,
  type RequestJournal,
  type TerminalRecord,
} from './journal.js'

export {
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_PERIOD_RATIO,
  KeepaliveLoop,
  MAX_PERIOD_RATIO,
  MIN_RETRY_DELAY_MS,
  ResidencyPolicyError,
  assertResidencyPolicy,
  keepalivePeriodMs,
  type KeepaliveBeat,
  type KeepaliveDegraded,
  type KeepaliveOptions,
  type ResidencyPolicy,
} from './keepalive.js'

export {
  DEFAULT_TIMING_CAPACITY,
  StageTimeline,
  TimingRecorder,
  durationsOf,
  type ActivationOutcomeKind,
  type StageDurations,
  type StageStats,
  type StageTimings,
  type TimingReport,
} from './stages.js'
