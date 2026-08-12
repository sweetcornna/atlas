// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The activator face: catch the request, wake the node, forward once it is
 * ready.
 *
 * ## Why this layer has to exist at all
 *
 * The single-machine answer to "a request arrived for a process that is not
 * running" is socket activation: the kernel's accept queue holds the connection
 * while the service starts. **That buffer is local to the machine.** A request
 * arriving from another node has nothing holding it, and the sandbox daemon
 * listens on loopback only and offers no such layer either (measured, E1). So
 * something host-side has to hold the request, issue the wake, wait for
 * readiness, and only then forward — the role Knative gives its activator and
 * `systemd-socket-proxyd` gives a local socket. Nothing in the base does this;
 * it is the one piece of M0 with no precedent to copy.
 *
 * ## The two rules everything else follows from
 *
 * 1. **Write-ahead before acceptance.** The journal record is fsynced before
 *    this component admits it has the request. A crash before that point leaves
 *    the request with the sender, who retries; a crash after it leaves a record
 *    that recovery drives to a terminal state. There is no window in which the
 *    request is nobody's.
 * 2. **Act first, then record the terminal state.** Forwarding — or telling the
 *    sender it failed — happens *before* the terminal journal line. Crash in
 *    between and recovery replays, so the sender may hear twice; the transport
 *    is at-least-once and dedups on `msgId`, so a duplicate is absorbed. Record
 *    first and the crash costs a silent drop instead, which nothing downstream
 *    can absorb. DoD ④ asks for "forwarded or explicitly failed, never silently
 *    dropped", and that is a choice about this ordering, not about uptime.
 */

import {
  ProtocolErrorCode,
  type QianmoMessage,
  deliveryExpiresAt,
  errorReply,
  newId,
} from '@qianmo/protocol'
import { ActivatorEventType, type AuditLog } from './audit.js'
import {
  type Clock,
  type Scheduler,
  TimeJumpGate,
  systemClock,
  timerScheduler,
} from './clock.js'
import type { SandboxDaemon } from './daemon.js'
import type { AcceptedRecord, RequestJournal } from './journal.js'
import {
  StageTimeline,
  type StageTimings,
  TimingRecorder,
  type TimingReport,
} from './stages.js'

/** Asks the target whether it can take work yet. */
export interface ReadyProbe {
  /**
   * True when the agent inside the sandbox is answering — not merely when the
   * container is unpaused. E2 measured the difference: `unpause` returns in
   * 46.6–55.5 ms, but a 400 MiB working set needed a further 9.0–10.2 s before
   * code that touches it ran at speed. Forwarding on "unpaused" alone hands the
   * envelope to a node that cannot yet act on it.
   */
  isReady(sandboxId: string): Promise<boolean>
}

/** Where a forwarded envelope goes — the last hop, or the next one. */
export interface ForwardTarget {
  forward(envelope: QianmoMessage): Promise<void>
}

/** How the sender is told that its request will not be delivered. */
export interface FailureSink {
  /** `reply` is a protocol `error` envelope addressed back at the sender. */
  fail(reply: QianmoMessage): Promise<void> | void
}

/** One request for a possibly-sleeping target. */
export interface ActivationRequest {
  readonly envelope: QianmoMessage
  /**
   * Which sandbox hosts the target. Resolved by the caller from the registry:
   * this component deliberately does not do name lookup, so it depends on no
   * registry and cannot be the reason one is unavailable.
   */
  readonly sandboxId: string
}

/** How one call to {@link Activator.handle} ended. */
export type ActivationOutcome =
  | {
      readonly status: 'forwarded'
      readonly requestId: string
      readonly timings: StageTimings
    }
  | {
      readonly status: 'failed'
      readonly requestId: string
      readonly code: ProtocolErrorCode
      readonly reason: string
      readonly timings: StageTimings
    }
  | {
      /** Turned away before acceptance: never journalled, still the sender's. */
      readonly status: 'refused'
      readonly code: ProtocolErrorCode
      readonly reason: string
    }

/** What one {@link Activator.recover} pass did. */
export interface RecoveryReport {
  readonly replayed: number
  readonly forwarded: number
  readonly failed: number
}

/** Knobs of {@link Activator}. */
export interface ActivatorOptions {
  readonly daemon: SandboxDaemon
  readonly readyProbe: ReadyProbe
  readonly forward: ForwardTarget
  readonly failures: FailureSink
  readonly journal: RequestJournal
  readonly audit: AuditLog
  readonly clock?: Clock
  readonly scheduler?: Scheduler
  readonly timings?: TimingRecorder
  /** Requests held at once. Over the cap, callers are refused, never dropped. */
  readonly maxInFlight?: number
  /** Ceiling on wake + warm-up before the request is failed explicitly. */
  readonly readyTimeoutMs?: number
  readonly readyPollIntervalMs?: number
  /** Injected in tests so request ids are readable. */
  readonly newRequestId?: () => string
}

/** Default ceiling on how long a wake may take before the request fails. */
export const DEFAULT_READY_TIMEOUT_MS = 45_000

/** Default gap between readiness probes. */
export const DEFAULT_READY_POLL_INTERVAL_MS = 200

/** Default number of requests held at once. */
export const DEFAULT_MAX_IN_FLIGHT = 64

/** Wait `ms` on the injected scheduler. */
function delay(scheduler: Scheduler, ms: number): Promise<void> {
  return new Promise(resolve => {
    scheduler.after(ms, resolve)
  })
}

/**
 * Catch → wake → forward, with a journal underneath it.
 *
 * Note what is absent: no name resolution, no loop detection, no rate
 * accounting beyond a hard in-flight cap, no mailbox writing. Those belong to
 * the registry, the router and `@qianmo/adapter`. This component's whole job is
 * the gap between "a request exists" and "its target is awake".
 */
export class Activator {
  readonly #daemon: SandboxDaemon
  readonly #readyProbe: ReadyProbe
  readonly #forward: ForwardTarget
  readonly #failures: FailureSink
  readonly #journal: RequestJournal
  readonly #audit: AuditLog
  readonly #clock: Clock
  readonly #scheduler: Scheduler
  readonly #timings: TimingRecorder
  readonly #maxInFlight: number
  readonly #readyTimeoutMs: number
  readonly #pollIntervalMs: number
  readonly #newRequestId: () => string
  readonly #gate: TimeJumpGate

  /** One shared wake per sandbox, so N requests do not issue N wakes. */
  readonly #wakes = new Map<string, Promise<void>>()
  readonly #inFlight = new Set<string>()

  constructor(options: ActivatorOptions) {
    this.#daemon = options.daemon
    this.#readyProbe = options.readyProbe
    this.#forward = options.forward
    this.#failures = options.failures
    this.#journal = options.journal
    this.#audit = options.audit
    this.#clock = options.clock ?? systemClock
    this.#scheduler = options.scheduler ?? timerScheduler
    this.#timings = options.timings ?? new TimingRecorder()
    this.#maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT
    this.#readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    this.#pollIntervalMs =
      options.readyPollIntervalMs ?? DEFAULT_READY_POLL_INTERVAL_MS
    this.#newRequestId = options.newRequestId ?? newId
    // The gate's period is the probe cadence: a gap of several probe intervals
    // between two probes means this process was not running, not that the
    // target is slow. Same rule as protocol.md §5.3 T-2, applied to our own
    // wait loop instead of to a mailbox deadline.
    this.#gate = new TimeJumpGate({ periodMs: this.#pollIntervalMs })
  }

  /** Requests currently held. */
  get inFlight(): number {
    return this.#inFlight.size
  }

  /** Per-stage timings of recent requests, for the P3.1 / P4.1 baselines. */
  report(): TimingReport {
    return this.#timings.report()
  }

  /** Raw timelines behind {@link report}. */
  samples(): readonly StageTimings[] {
    return this.#timings.samples()
  }

  /**
   * Take one request through to a terminal state.
   *
   * Resolves — it does not reject — for every terminal state, because a
   * rejection at this boundary is indistinguishable to the caller from a drop,
   * and "never silently dropped" is the property being defended.
   */
  async handle(request: ActivationRequest): Promise<ActivationOutcome> {
    const { envelope, sandboxId } = request
    const now = this.#clock.now()

    // T-1 rule 2: an envelope already past its delivery deadline is refused
    // rather than taken in. Gated, so a node that just thawed does not refuse
    // everything it was holding (T-2).
    if (this.#gate.expired(deliveryExpiresAt(envelope), now)) {
      return await this.#refuse(
        envelope,
        ProtocolErrorCode.E_TTL_EXPIRED,
        'delivery deadline passed before the activator could take the request',
        now,
      )
    }

    if (this.#inFlight.size >= this.#maxInFlight) {
      // Backpressure has to be visible. Queueing without a bound turns memory
      // pressure into the drop this component exists to prevent, and dropping
      // silently is worse than saying no.
      return await this.#refuse(
        envelope,
        ProtocolErrorCode.E_RATE_LIMITED,
        `activator is holding ${this.#inFlight.size} requests, its configured maximum`,
        now,
      )
    }

    const requestId = this.#newRequestId()
    const record: AcceptedRecord = {
      kind: 'accepted',
      requestId,
      sandboxId,
      acceptedAt: now,
      envelope,
    }
    // Rule 1. Durable before the caller is told anything.
    this.#journal.append(record)
    this.#inFlight.add(requestId)
    this.#audit.record(ActivatorEventType.RequestAccepted, now, {
      requestId,
      sandboxId,
      msgId: envelope.msgId,
      taskId: envelope.taskId,
    })

    try {
      return await this.#drive(record)
    } finally {
      this.#inFlight.delete(requestId)
    }
  }

  /**
   * Replay everything the journal still owes an answer for.
   *
   * Called at startup. Each surviving request is driven exactly as a fresh one
   * would be; whatever the outcome, it reaches a terminal record. A request the
   * previous process caught and never finished therefore ends up forwarded or
   * explicitly failed — the shape DoD ④ asks for.
   */
  async recover(): Promise<RecoveryReport> {
    const pending = this.#journal.pending()
    let forwarded = 0
    let failed = 0
    for (const record of pending) {
      this.#audit.record(
        ActivatorEventType.RecoveryReplayed,
        this.#clock.now(),
        {
          requestId: record.requestId,
          sandboxId: record.sandboxId,
          msgId: record.envelope.msgId,
          acceptedAt: record.acceptedAt,
        },
      )
      this.#inFlight.add(record.requestId)
      try {
        const outcome = await this.#drive(record)
        if (outcome.status === 'forwarded') forwarded += 1
        else failed += 1
      } finally {
        this.#inFlight.delete(record.requestId)
      }
    }
    this.#journal.compact()
    return { replayed: pending.length, forwarded, failed }
  }

  async #refuse(
    envelope: QianmoMessage,
    code: ProtocolErrorCode,
    reason: string,
    now: number,
  ): Promise<ActivationOutcome> {
    this.#audit.record(ActivatorEventType.RequestRefused, now, {
      msgId: envelope.msgId,
      taskId: envelope.taskId,
      code,
      reason,
    })
    await this.#tell(envelope, code, reason, now)
    return { status: 'refused', code, reason }
  }

  /** Send the sender an explicit `error` envelope. Never throws. */
  async #tell(
    envelope: QianmoMessage,
    code: ProtocolErrorCode,
    reason: string,
    now: number,
  ): Promise<void> {
    try {
      await this.#failures.fail(errorReply(envelope, code, reason, now))
    } catch (error) {
      // The sink being down does not entitle us to forget: the journal still
      // holds the request until a terminal record is written, and the audit
      // trail records that the notification itself failed.
      this.#audit.record(ActivatorEventType.RequestFailed, now, {
        msgId: envelope.msgId,
        code,
        reason,
        notifyFailed: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async #drive(record: AcceptedRecord): Promise<ActivationOutcome> {
    const { requestId, sandboxId, envelope } = record
    const timeline = new StageTimeline({
      requestId,
      sandboxId,
      msgId: envelope.msgId,
      taskId: envelope.taskId,
      acceptedAt: record.acceptedAt,
    })

    try {
      const status = await this.#daemon.status(sandboxId)
      if (status.state !== 'running') {
        const at = this.#clock.now()
        timeline.markWakeStarted(at)
        this.#audit.record(ActivatorEventType.WakeStarted, at, {
          requestId,
          sandboxId,
          from: status.state,
        })
        await this.#wake(sandboxId, requestId)
      }

      const { readyAt, deliveryDeadline } = await this.#awaitReady(
        sandboxId,
        record,
      )
      timeline.markReady(readyAt)
      this.#audit.record(ActivatorEventType.TargetReady, readyAt, {
        requestId,
        sandboxId,
        waitedMs: readyAt - record.acceptedAt,
      })

      const beforeForward = this.#clock.now()
      // The rebased deadline, not the envelope's raw one: the time the host
      // spent frozen is not time the sender's budget was meant to cover (T-2).
      if (this.#gate.expired(deliveryDeadline, beforeForward)) {
        return await this.#fail(
          timeline,
          envelope,
          ProtocolErrorCode.E_TTL_EXPIRED,
          'delivery deadline passed while the target was waking',
          beforeForward,
        )
      }

      // Act, then record. See rule 2 in the module header.
      await this.#forward.forward(envelope)
      const forwardedAt = this.#clock.now()
      timeline.markForwarded(forwardedAt)
      this.#journal.append({
        kind: 'terminal',
        requestId,
        at: forwardedAt,
        outcome: 'forwarded',
      })
      this.#audit.record(ActivatorEventType.RequestForwarded, forwardedAt, {
        requestId,
        sandboxId,
        msgId: envelope.msgId,
        totalMs: forwardedAt - record.acceptedAt,
      })
      const timings = timeline.snapshot()
      this.#timings.record(timings)
      return { status: 'forwarded', requestId, timings }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return await this.#fail(
        timeline,
        envelope,
        ProtocolErrorCode.E_UNDELIVERABLE,
        reason,
        this.#clock.now(),
      )
    }
  }

  /**
   * One wake per sandbox, shared by everyone waiting on it.
   *
   * Without this, ten requests for one sleeping node issue ten `acquire` calls
   * at the daemon in the same millisecond — which is both wasteful and, on a
   * daemon whose credential has no rate story, an easy way to be the reason the
   * daemon stops answering.
   */
  async #wake(sandboxId: string, requestId: string): Promise<void> {
    const existing = this.#wakes.get(sandboxId)
    if (existing !== undefined) {
      this.#audit.record(ActivatorEventType.WakeCoalesced, this.#clock.now(), {
        requestId,
        sandboxId,
      })
      await existing
      return
    }
    const wake = (async () => {
      await this.#daemon.acquire(sandboxId)
    })()
    this.#wakes.set(sandboxId, wake)
    try {
      await wake
    } finally {
      this.#wakes.delete(sandboxId)
    }
  }

  /**
   * Poll until the target answers, or until the request runs out of time.
   *
   * Two deadlines apply and the earlier one wins: our own wake ceiling, and the
   * envelope's delivery deadline. Both pass through the time-jump gate, so a
   * freeze *of this host* during the wait extends them by the frozen interval
   * instead of expiring everything at once (T-2).
   *
   * The gate is consulted **across the sleep and only across the sleep**. That
   * is the one interval whose expected length is known exactly — we asked for
   * `pollIntervalMs` — so a wildly longer one is evidence about the process,
   * not about the target. Measuring across the probe instead would call every
   * slow probe a freeze, and a probe *should* be slow while a 400 MiB working
   * set warms up (E2: 9.0–10.2 s). Known limitation: a freeze that lands inside
   * a probe rather than inside the sleep is not distinguished from a slow probe.
   *
   * The gate is shared by every in-flight request on purpose: a freeze happens
   * to the process, not to a request, so whichever request notices it first
   * opens the grace window for all of them.
   */
  async #awaitReady(
    sandboxId: string,
    record: AcceptedRecord,
  ): Promise<{ readyAt: number; deliveryDeadline: number }> {
    let ceiling = record.acceptedAt + this.#readyTimeoutMs
    let deliveryDeadline = deliveryExpiresAt(record.envelope)

    for (;;) {
      if (await this.#readyProbe.isReady(sandboxId)) {
        return { readyAt: this.#clock.now(), deliveryDeadline }
      }

      const after = this.#clock.now()
      if (this.#gate.expired(Math.min(ceiling, deliveryDeadline), after)) {
        throw new Error(
          `target ${sandboxId} did not become ready within ${after - record.acceptedAt}ms`,
        )
      }

      await delay(this.#scheduler, this.#pollIntervalMs)
      const afterSleep = this.#clock.now()
      const observation = this.#gate.observeGap(afterSleep - after, afterSleep)
      if (observation.jumped) {
        ceiling = this.#gate.rebase(ceiling, observation)
        deliveryDeadline = this.#gate.rebase(deliveryDeadline, observation)
        this.#audit.record(ActivatorEventType.TimeJumpDetected, afterSleep, {
          requestId: record.requestId,
          sandboxId,
          gapMs: observation.gapMs,
          thresholdMs: this.#gate.thresholdMs,
          face: 'activator',
        })
      }
    }
  }

  async #fail(
    timeline: StageTimeline,
    envelope: QianmoMessage,
    code: ProtocolErrorCode,
    reason: string,
    now: number,
  ): Promise<ActivationOutcome> {
    timeline.markFailed(reason)
    // Act, then record — same ordering as the success path, for the same
    // reason: a crash between the two costs a duplicate error, not a silence.
    await this.#tell(envelope, code, reason, now)
    this.#journal.append({
      kind: 'terminal',
      requestId: timeline.requestId,
      at: now,
      outcome: 'failed',
      reason,
    })
    this.#audit.record(ActivatorEventType.RequestFailed, now, {
      requestId: timeline.requestId,
      sandboxId: timeline.sandboxId,
      msgId: envelope.msgId,
      code,
      reason,
    })
    const timings = timeline.snapshot()
    this.#timings.record(timings)
    return {
      status: 'failed',
      requestId: timeline.requestId,
      code,
      reason,
      timings,
    }
  }
}
