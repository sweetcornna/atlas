// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto'
import type {
  AdmissionLedger,
  DetectedAdmissionRecord,
  PendingAdmission,
  ResidentMailboxMessage,
  ResidentMailboxPort,
  ResidentTurnInput,
  ResidentTurnPort,
  ResidentTurnResult,
} from './contracts.js'
import { readCountsByIdentity } from './mailbox-identity.js'
import { NodeTurnGate } from './turn-gate.js'
import type { ResidentTimingRecorder } from './timings.js'

export interface ResidentMailboxReaderOptions {
  readonly agent: string
  readonly team: string
  /**
   * Which ACP session this batch belongs to.
   *
   * A function rather than a fixed id because the answer depends on the batch:
   * a snapshot carrying a remote `contextId` belongs to that requester's
   * session, not to the agent's single one (design §4.3). The resolved value is
   * still written verbatim into `DetectedAdmissionRecord.sessionId`, so crash
   * recovery does not have to resolve anything a second time.
   */
  readonly resolveSession: (
    messages: readonly ResidentMailboxMessage[],
  ) => string | Promise<string>
  /**
   * Called once the turn started for a resolved session has settled, however
   * it settled. Pairs with {@link resolveSession} so a session source can hold
   * a session exempt from garbage collection while its turn is running.
   *
   * Recovered pending records deliberately do not go through this pair: they
   * carry their session id from the ledger, and the ledger's own pending set
   * is what keeps those sessions exempt.
   */
  readonly onSessionRelease?: (sessionId: string) => void
  readonly mailbox: ResidentMailboxPort
  readonly turn: ResidentTurnPort
  readonly ledger: AdmissionLedger
  readonly formatPrompt: (messages: readonly ResidentMailboxMessage[]) => string
  readonly accepts?: (message: ResidentMailboxMessage) => boolean
  readonly selectSnapshot?: (
    messages: readonly ResidentMailboxMessage[],
  ) => readonly ResidentMailboxMessage[]
  readonly correlationId?: (
    messages: readonly ResidentMailboxMessage[],
  ) => string | undefined
  /**
   * When the task behind one mailbox entry stops being worth a turn, on the
   * wall clock (`Date.now`) — **not** on this reader's injected `now`, which
   * stamps ledger records and is free to be fictional. Deadlines travel to the
   * node-wide gate, so they all have to be on one clock. `undefined` for an
   * entry with no task deadline — local teammate mail, most of it.
   *
   * Injected rather than parsed here for the same reason `correlationId` is:
   * this package knows nothing about envelopes, and the entry that carries one
   * is the host's business.
   *
   * Used twice, and the first use is the one that recovers real work:
   *
   * 1. **Eligibility.** An entry whose deadline has passed is not detected at
   *    all. That is where a node actually burns turns on dead tasks today —
   *    the queue that matters is the mailbox, and a message can sit unread in
   *    it through many turns before its own comes up. Dropping it from
   *    eligibility (rather than skipping the batch) also keeps it from
   *    blocking everything behind it forever.
   * 2. **The gate.** The batch's earliest deadline rides along so a turn that
   *    expires *while queued* is dropped at the head of the queue instead of
   *    being run.
   */
  readonly deadlineOf?: (message: ResidentMailboxMessage) => number | undefined
  readonly timings?: ResidentTimingRecorder
  readonly gate?: NodeTurnGate
  readonly now?: () => number
  readonly newMessageId?: () => string
  readonly onRead?: (
    input: ResidentTurnInput,
    readAt: number,
  ) => void | Promise<void>
  readonly onTurnResult?: (
    input: ResidentTurnInput,
    result: ResidentTurnResult,
  ) => void | Promise<void>
  readonly onTurnError?: (
    error: unknown,
    input: ResidentTurnInput,
  ) => void | Promise<void>
}

export interface ResidentPollResult {
  readonly detected: number
  readonly recovered: number
  readonly read: number
}

export class ResidentMailboxReader {
  readonly #options: ResidentMailboxReaderOptions
  readonly #gate: NodeTurnGate
  #polling: Promise<ResidentPollResult> | null = null

  constructor(options: ResidentMailboxReaderOptions) {
    this.#options = options
    this.#gate = options.gate ?? new NodeTurnGate()
  }

  get gate(): NodeTurnGate {
    return this.#gate
  }

  poll(): Promise<ResidentPollResult> {
    if (this.#polling !== null) return this.#polling
    this.#polling = this.#poll().finally(() => {
      this.#polling = null
    })
    return this.#polling
  }

  async #poll(): Promise<ResidentPollResult> {
    const queried = this.#options.ledger.query()
    if (queried.integrityIssues.length > 0) {
      throw new Error('resident admission ledger contains integrity issues')
    }

    let recovered = 0
    let read = 0
    for (const pending of queried.pending) {
      const recoveredCount = await this.#recover(pending)
      recovered += 1
      read += recoveredCount
    }

    if (queried.pending.length > 0) {
      return { detected: 0, recovered, read }
    }

    const mailbox = await this.#options.mailbox.readAll(
      this.#options.agent,
      this.#options.team,
    )
    // `Date.now()`, deliberately, and not this reader's injected clock: the
    // same deadline is handed to the node-wide gate below, and a gate shared
    // by every reader cannot adopt one reader's notion of the time. One clock
    // for deadlines, the injected one for the stamps that go in the ledger.
    const now = Date.now()
    const eligible = mailbox.filter(
      message =>
        !message.read &&
        (this.#options.accepts?.(message) ?? true) &&
        now < (this.#options.deadlineOf?.(message) ?? Number.POSITIVE_INFINITY),
    )
    const snapshot = this.#options.selectSnapshot?.(eligible) ?? eligible
    if (snapshot.length === 0) return { detected: 0, recovered, read }

    const prompt = this.#options.formatPrompt(snapshot)
    if (prompt.length === 0) {
      throw new Error('resident mailbox formatter returned an empty prompt')
    }
    const networkMsgId = this.#options.correlationId?.(snapshot)
    const batchDeadlineAt = this.#earliestDeadline(snapshot)
    const sessionId = await this.#options.resolveSession(snapshot)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.#options.onSessionRelease?.(sessionId)
    }

    try {
      const record: DetectedAdmissionRecord = {
        kind: 'detected',
        messageId: (this.#options.newMessageId ?? randomUUID)(),
        sessionId,
        detectedAt: (this.#options.now ?? Date.now)(),
        agent: this.#options.agent,
        team: this.#options.team,
        readBefore: Object.fromEntries(readCountsByIdentity(mailbox)),
        snapshot,
        prompt,
        ...(networkMsgId === undefined ? {} : { networkMsgId }),
      }
      this.#options.ledger.append(record)
      this.#options.timings?.record({
        stage: 'detected',
        at: record.detectedAt,
        sessionId: record.sessionId,
        inputMessageId: record.messageId,
        ...(record.networkMsgId === undefined
          ? {}
          : { networkMsgId: record.networkMsgId }),
        agent: record.agent,
      })
      const marked = await this.#submit(
        { ...record, phase: 'detected' },
        {
          onSettled: release,
          ...(batchDeadlineAt === undefined
            ? {}
            : { deadlineAt: batchDeadlineAt }),
        },
      )
      return {
        detected: snapshot.length,
        recovered,
        read: read + marked,
      }
    } catch (error) {
      release()
      throw error
    }
  }

  #turnInput(pending: PendingAdmission): ResidentTurnInput {
    return {
      sessionId: pending.sessionId,
      messageId: pending.messageId,
      prompt: pending.prompt,
      ...(pending.networkMsgId === undefined
        ? {}
        : { networkMsgId: pending.networkMsgId }),
      agent: pending.agent,
    }
  }

  /** Earliest task deadline in the batch, or `undefined` when none has one. */
  #earliestDeadline(
    messages: readonly ResidentMailboxMessage[],
  ): number | undefined {
    const deadlineOf = this.#options.deadlineOf
    if (deadlineOf === undefined) return undefined
    let earliest: number | undefined
    for (const message of messages) {
      const at = deadlineOf(message)
      if (at === undefined) continue
      earliest = earliest === undefined ? at : Math.min(earliest, at)
    }
    return earliest
  }

  async #recover(pending: PendingAdmission): Promise<number> {
    if (pending.phase === 'admitted') {
      return await this.#markRead(pending)
    }

    const accepted = await this.#gate.run(
      () => this.#options.turn.isAccepted(this.#turnInput(pending)),
      { sessionId: pending.sessionId },
    )
    if (accepted) {
      const admittedAt = this.#markAdmitted(pending)
      return await this.#markRead({ ...pending, phase: 'admitted', admittedAt })
    }

    // No deadline on the recovery path, and this is the reason: the ledger
    // already holds a `detected` record for this batch, and the ledger has no
    // way to retire one other than reaching `read` (an `abandoned` state is
    // P13.5's). Dropping the turn here would leave that record pending
    // forever, and every poll from then on would re-recover it, drop it again
    // and report the failure — a 500 ms error loop in place of one wasted
    // turn. Expiry is honoured where it costs nothing instead: eligibility,
    // above, before anything is written down.
    return await this.#submit(pending)
  }

  async #submit(
    pending: PendingAdmission,
    options: {
      readonly deadlineAt?: number
      readonly onSettled?: () => void
    } = {},
  ): Promise<number> {
    const input = this.#turnInput(pending)
    let resolveAdmission!: (marked: number) => void
    let rejectAdmission!: (error: unknown) => void
    let settled = false
    const admission = new Promise<number>((resolve, reject) => {
      resolveAdmission = marked => {
        if (settled) return
        settled = true
        resolve(marked)
      }
      rejectAdmission = error => {
        if (settled) return
        settled = true
        reject(error)
      }
    })
    this.#options.timings?.record({
      stage: 'queued',
      at: (this.#options.now ?? Date.now)(),
      sessionId: pending.sessionId,
      inputMessageId: pending.messageId,
      ...(pending.networkMsgId === undefined
        ? {}
        : { networkMsgId: pending.networkMsgId }),
      agent: pending.agent,
      // Read before the hand-off, plus this turn — its position in the queue.
      // Asking afterwards would report zero for the very turn being recorded,
      // because the gate may have started it synchronously.
      queueDepth: this.#gate.queued + 1,
    })
    void this.#gate
      .run(
        async () => {
          const result = await this.#options.turn.execute(input, async () => {
            try {
              const admittedAt = this.#markAdmitted(pending)
              resolveAdmission(
                await this.#markRead({
                  ...pending,
                  phase: 'admitted',
                  admittedAt,
                }),
              )
            } catch (error) {
              rejectAdmission(error)
              throw error
            }
          })
          if (!settled) {
            throw new Error(
              `resident ACP turn ${pending.messageId} completed before input admission`,
            )
          }
          await this.#options.onTurnResult?.(input, result)
        },
        {
          sessionId: pending.sessionId,
          ...(options.deadlineAt === undefined
            ? {}
            : { deadlineAt: options.deadlineAt }),
        },
      )
      .catch(async error => {
        rejectAdmission(error)
        await this.#options.onTurnError?.(error, input)
      })
      .finally(() => {
        options.onSettled?.()
      })
    return await admission
  }

  #markAdmitted(pending: PendingAdmission): number {
    const at = (this.#options.now ?? Date.now)()
    this.#options.ledger.append({
      kind: 'admitted',
      messageId: pending.messageId,
      at,
    })
    this.#options.timings?.record({
      stage: 'admitted',
      at,
      sessionId: pending.sessionId,
      inputMessageId: pending.messageId,
      ...(pending.networkMsgId === undefined
        ? {}
        : { networkMsgId: pending.networkMsgId }),
      agent: pending.agent,
    })
    return at
  }

  async #markRead(pending: PendingAdmission): Promise<number> {
    const marked = await this.#options.mailbox.markRead(
      pending.agent,
      pending.team,
      pending.snapshot,
      pending.readBefore,
    )
    if (marked !== pending.snapshot.length) {
      throw new Error(
        `resident mailbox read flip marked ${marked} of ${pending.snapshot.length} messages`,
      )
    }
    const readAt = (this.#options.now ?? Date.now)()
    this.#options.ledger.append({
      kind: 'read',
      messageId: pending.messageId,
      at: readAt,
    })
    this.#options.timings?.record({
      stage: 'read',
      at: readAt,
      sessionId: pending.sessionId,
      inputMessageId: pending.messageId,
      ...(pending.networkMsgId === undefined
        ? {}
        : { networkMsgId: pending.networkMsgId }),
      agent: pending.agent,
    })
    await this.#options.onRead?.(this.#turnInput(pending), readAt)
    return pending.snapshot.length
  }
}
