// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { LIMITS } from '@qianmo/protocol'

/** What a caller says about the turn it is handing to the gate. */
export interface NodeTurnRequest {
  /**
   * When the task behind this turn stops being worth running, **on this
   * process's clock**.
   *
   * A caller holding a protocol deadline has to shift it first — the same
   * shift `InboundAdapter` already does for `InboundDelivered.deadlineAt` —
   * because the freeze-aware clock subtracts paused time and a raw envelope
   * deadline compared against `Date.now()` would kill everything in flight the
   * moment a node thaws (protocol.md §5.3).
   *
   * Absent means there is no envelope behind this turn and nothing to expire.
   */
  readonly deadlineAt?: number
  /**
   * Which omp RPC session the turn will run in. Carried so a queued turn can be
   * described without asking the reader that submitted it; `''` when the
   * caller has no session to name.
   */
  readonly sessionId?: string
  /**
   * The turn is a hub's background sub-agent turn (P29). When the gate frees
   * up it takes the oldest turn that is not one of these first, so a person's
   * next message does not wait behind a queue of background work. A running
   * turn is never interrupted. Absent means interactive.
   */
  readonly background?: boolean
}

/**
 * The queue is at {@link LIMITS.maxQueuedTurns} and this turn was not taken.
 *
 * A refusal, not a failure: nothing was started, so a caller is free to tell
 * its peer to come back later (`E_BUSY`, protocol.md §11).
 */
export class NodeTurnQueueFullError extends Error {
  readonly capacity: number

  constructor(capacity: number) {
    super(`node turn queue is full at ${capacity} waiting turns`)
    this.name = 'NodeTurnQueueFullError'
    this.capacity = capacity
  }
}

/**
 * The turn reached the head of the queue after its task deadline had passed,
 * so it was dropped **without being started**.
 *
 * This is the resource the queue bound exists to recover: before it, a node
 * that had already answered `E_TASK_TIMEOUT` still burned a full turn on the
 * task afterwards (design §4.2(a)).
 */
export class NodeTurnExpiredError extends Error {
  readonly sessionId: string
  readonly deadlineAt: number

  constructor(sessionId: string, deadlineAt: number, waitedMs: number) {
    super(
      `node turn for session ${sessionId || '<none>'} passed its task deadline after ${waitedMs}ms in the queue`,
    )
    this.name = 'NodeTurnExpiredError'
    this.sessionId = sessionId
    this.deadlineAt = deadlineAt
  }
}

interface QueuedTurn {
  readonly work: () => Promise<unknown>
  readonly deadlineAt: number
  readonly enqueuedAt: number
  readonly sessionId: string
  readonly background: boolean
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

/**
 * Node-level turn serialization, as an explicit bounded FIFO queue.
 *
 * It used to be a promise tail chain, which serialized correctly but kept no
 * queue anyone could look at — so an upper bound, deadline culling and depth
 * instrumentation were all equally impossible. The queue below is the whole of
 * what changed; arrival order and "a failed turn still releases the next one"
 * are the same properties they always were.
 *
 * **Two classes, not a priority table.** Turns a hub marked as background
 * sub-agent work ({@link NodeTurnRequest.background}) yield to every other
 * turn when the gate frees up; within each class the order is arrival order.
 * Nothing is preempted: a background turn already running finishes its turn
 * (the hub keeps those short, and its deadline stops one that is not). Watch
 * jobs, peers and local mail stay in the interactive class, so their relative
 * order is the FIFO it always was. A background turn can wait as long as
 * interactive turns keep arriving; at a person's pace that is a pause, not
 * starvation, and its own deadline still culls it at the head.
 */
export class NodeTurnGate {
  readonly #queue: QueuedTurn[] = []
  readonly #now: () => number
  #active = false

  constructor(
    options: {
      /**
       * Reads the clock {@link NodeTurnRequest.deadlineAt} is stated on.
       * Defaults to `Date.now`, the same seam every other clock-reading class
       * in this package already carries (`lifecycle.ts`, `sessions.ts`,
       * `notify.ts`, `acp-turn.ts`, …).
       *
       * It exists because "the deadline is read at the head of the queue"
       * is a statement about **order**, and the only way to prove an order
       * without a clock you control is to race a real one — which is what the
       * test used to do, on a 15 ms margin, against a wall clock no shared
       * runner promises to advance monotonically.
       */
      readonly now?: () => number
    } = {},
  ) {
    this.#now = options.now ?? Date.now
  }

  /** A turn is running right now. */
  get active(): boolean {
    return this.#active
  }

  /** Turns waiting behind the running one. Excludes the running one. */
  get queued(): number {
    return this.#queue.length
  }

  /**
   * The next {@link run} would be refused.
   *
   * Exposed so a caller can refuse **ahead of its own persistent side
   * effects** rather than finding out after them: a resident that has already
   * written the envelope into its mailbox has spent the recipient's inbox
   * quota on a message it is about to reject (rule L-1).
   */
  get saturated(): boolean {
    return this.#queue.length >= LIMITS.maxQueuedTurns
  }

  run<T>(work: () => Promise<T>, request: NodeTurnRequest = {}): Promise<T> {
    if (this.saturated) {
      return Promise.reject(new NodeTurnQueueFullError(LIMITS.maxQueuedTurns))
    }
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({
        work: work as () => Promise<unknown>,
        deadlineAt: request.deadlineAt ?? Number.POSITIVE_INFINITY,
        enqueuedAt: this.#now(),
        sessionId: request.sessionId ?? '',
        background: request.background === true,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      this.#pump()
    })
  }

  /**
   * Start the next runnable turn, dropping expired ones on the way.
   *
   * The deadline is read **here**, at the head of the queue, and not at
   * enqueue: however deep a turn sits, it is worth keeping as long as its
   * deadline is still ahead, and only the moment its slot comes up can say
   * whether it outlived it. "The head" is the oldest interactive turn when
   * there is one, else the oldest background turn.
   */
  #pump(): void {
    if (this.#active) return
    for (;;) {
      const interactive = this.#queue.findIndex(turn => !turn.background)
      const next = this.#queue.splice(Math.max(0, interactive), 1)[0]
      if (next === undefined) return
      const now = this.#now()
      if (now >= next.deadlineAt) {
        next.reject(
          new NodeTurnExpiredError(
            next.sessionId,
            next.deadlineAt,
            now - next.enqueuedAt,
          ),
        )
        continue
      }
      this.#start(next)
      return
    }
  }

  #start(turn: QueuedTurn): void {
    if (this.#active) throw new Error('node turn gate overlap')
    this.#active = true
    void (async () => {
      try {
        turn.resolve(await turn.work())
      } catch (error) {
        turn.reject(error)
      } finally {
        // Released before pumping, and in a `finally`, because a node whose
        // first failing turn never releases the gate stops for good.
        this.#active = false
        this.#pump()
      }
    })()
  }
}
