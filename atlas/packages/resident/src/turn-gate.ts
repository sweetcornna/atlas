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
   * Which omp RPC session the turn will run in: the gate never runs two turns
   * of one session at once (P38). Also carried so a queued turn can be
   * described without asking the reader that submitted it; `''` when the
   * caller has no session to name, and such a turn waits for no session.
   */
  readonly sessionId?: string
  /**
   * The turn is a hub's background sub-agent turn (P29). Such turns take at
   * most the gate's background share of its places (P38), and when a place
   * frees up the gate takes the oldest turn that is not one of these first,
   * so a person's next message does not wait behind background work. A
   * running turn is never interrupted. Absent means interactive.
   */
  readonly background?: boolean
  /**
   * What a later request's {@link chain} calls this turn (P36.6). The host
   * gives the `taskId` of the hub-signed request behind the turn; absent for
   * a turn nobody can be asked from.
   */
  readonly key?: string
  /**
   * The verified call chain of a synchronous question (P36.6,
   * `harness-backends.md` §6.2): the {@link key}s of the turns on this node
   * that asked the question this turn answers, outermost first. The host
   * passes only what it verified (`verifiedChain`); absent or empty means
   * none. While a running turn is in it, that turn is blocked on this one's
   * answer, so this one starts at once, nested inside it and without a place
   * of its own, instead of queueing behind it until the question times out.
   * That is re-entry, not concurrency: the turn it nests in is waiting on its
   * tool call and does nothing until it ends.
   */
  readonly chain?: readonly string[]
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
  readonly key: string | undefined
  readonly chain: readonly string[]
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

/** A turn the gate started and that has not ended yet. */
interface RunningTurn {
  readonly key: string | undefined
  readonly sessionId: string
  readonly background: boolean
  /**
   * The running turn this one nested in (P36.6), or undefined for a turn that
   * holds a place of its own. A turn whose asker ended first is moved up to
   * the asker's own host, so it holds the place its asker held.
   */
  host: RunningTurn | undefined
}

/** How many turns the gate runs at once; see {@link NodeTurnGate}. */
interface NodeTurnGateLimits {
  /** Turns running at once, nested answers not counted. */
  readonly maxTurns: number
  /**
   * Of those, background turns at most. Below {@link maxTurns} whenever that
   * is two or more, so a foreground turn always finds a place.
   */
  readonly maxBackgroundTurns: number
}

/**
 * The background share of `maxTurns`: what was asked for, but always one
 * less than the whole when there is more than one place, so a person's turn
 * never waits behind background work. With one place there is nothing to
 * keep back: background turns share it and yield at the gate.
 */
function backgroundShare(maxTurns: number, asked: number | undefined): number {
  if (maxTurns === 1) return 1
  return Math.min(asked ?? maxTurns - 1, maxTurns - 1)
}

function positive(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
    throw new Error(`node turn gate ${name} must be a positive integer`)
}

/**
 * Node-level turn scheduling, as an explicit bounded queue.
 *
 * It used to be a promise tail chain, which serialized correctly but kept no
 * queue anyone could look at — so an upper bound, deadline culling and depth
 * instrumentation were all equally impossible. A failed turn still releases
 * the next one, and a turn whose deadline passed while it waited is dropped
 * when its place comes up.
 *
 * **One session, one turn (P38).** A session never runs two turns at once:
 * its next turn waits until the running one ends, in arrival order. Turns of
 * different sessions run side by side, up to {@link NodeTurnGateLimits.maxTurns}
 * of them; a session that is busy does not hold up the turns queued behind it
 * for other sessions.
 *
 * **Two classes, not a priority table.** Turns a hub marked as background
 * sub-agent work ({@link NodeTurnRequest.background}) take at most
 * {@link NodeTurnGateLimits.maxBackgroundTurns} places, which is always fewer
 * than all of them when there are two or more: the rest is the foreground's,
 * so a person's turn starts while background work fills its share. When a
 * place frees up the gate takes the oldest turn that may run and is not
 * background first; within each class the order is arrival order. Nothing is
 * preempted: a background turn already running finishes its turn (the hub
 * keeps those short, and its deadline stops one that is not). Watch jobs,
 * peers and local mail stay in the interactive class. With a single place
 * (`maxTurns` 1, the default) this is the serial gate it always was:
 * background turns share the one place and yield to every other turn.
 *
 * **Re-entry along a call chain (P36.6).** A turn that asks another agent on
 * this node waits inside its tool call for that agent's turn, which would
 * otherwise queue behind it until the question times out when every place
 * is taken. A request whose verified {@link NodeTurnRequest.chain} names a
 * running turn that has no nested turn of its own running (the innermost of
 * its nest) starts at once, nested in it, without a place of its own; at most
 * `LIMITS.maxAskChain` turns nest inside the outermost. When a nested turn
 * ends the asker is the innermost again, so the asker's other answers come
 * before anything else that waits for a place. An asker that ends before its
 * answer hands its place to the answer.
 */
export class NodeTurnGate {
  readonly #queue: QueuedTurn[] = []
  readonly #now: () => number
  readonly #maxTurns: number
  readonly #maxBackground: number
  /** Turns started and not ended, in start order. */
  readonly #running: RunningTurn[] = []

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
      /** Turns running at once (nested answers aside). Default 1: serial. */
      readonly maxTurns?: number
      /**
       * Background turns among them. Default and ceiling: one fewer than
       * {@link maxTurns} when that is two or more; 1 when it is 1.
       */
      readonly maxBackgroundTurns?: number
    } = {},
  ) {
    positive('maxTurns', options.maxTurns)
    positive('maxBackgroundTurns', options.maxBackgroundTurns)
    this.#now = options.now ?? Date.now
    this.#maxTurns = options.maxTurns ?? 1
    this.#maxBackground = backgroundShare(
      this.#maxTurns,
      options.maxBackgroundTurns,
    )
  }

  /** The places in force, background share as applied. */
  get limits(): NodeTurnGateLimits {
    return {
      maxTurns: this.#maxTurns,
      maxBackgroundTurns: this.#maxBackground,
    }
  }

  /** A turn is running right now. */
  get active(): boolean {
    return this.#running.length > 0
  }

  /** Turns running now, nested ones included. */
  get depth(): number {
    return this.#running.length
  }

  /** Places taken: running turns that are not nested in another. */
  get running(): number {
    return this.#running.filter(turn => turn.host === undefined).length
  }

  /** Places taken by background turns. */
  get backgroundRunning(): number {
    return this.#running.filter(
      turn => turn.host === undefined && turn.background,
    ).length
  }

  /** Turns waiting for a place or for their session. Excludes running ones. */
  get queued(): number {
    return this.#queue.length
  }

  /** A turn of `sessionId` is running now. */
  sessionBusy(sessionId: string): boolean {
    return (
      sessionId !== '' &&
      this.#running.some(turn => turn.sessionId === sessionId)
    )
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

  /**
   * A request carrying this verified {@link NodeTurnRequest.chain} would
   * start right now, nested in the innermost turn of a running nest (P36.6).
   *
   * Exposed for the same reason as {@link saturated}: a host that cannot give
   * such a turn what it needs to run (a process, when every one it may start
   * is held by the turns it would nest in) refuses it before writing it down,
   * instead of starting a turn that can only wait for them.
   */
  nestsNow(chain: readonly string[]): boolean {
    return this.#hostFor(chain) !== undefined
  }

  run<T>(work: () => Promise<T>, request: NodeTurnRequest = {}): Promise<T> {
    if (this.saturated && !this.nestsNow(request.chain ?? [])) {
      return Promise.reject(new NodeTurnQueueFullError(LIMITS.maxQueuedTurns))
    }
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({
        work: work as () => Promise<unknown>,
        deadlineAt: request.deadlineAt ?? Number.POSITIVE_INFINITY,
        enqueuedAt: this.#now(),
        sessionId: request.sessionId ?? '',
        background: request.background === true,
        key: request.key,
        chain: request.chain ?? [],
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      this.#pump()
    })
  }

  /**
   * Start every turn that may run now, dropping expired ones on the way.
   *
   * The deadline is read **here**, when a turn is picked, and not at enqueue:
   * however long a turn waits, it is worth keeping as long as its deadline is
   * still ahead, and only the moment its place comes up can say whether it
   * outlived it. The pick is the oldest turn that would nest
   * ({@link #hostFor}), else the oldest interactive turn that may run, else
   * the oldest background one ({@link #place}).
   */
  #pump(): void {
    for (;;) {
      const picked = this.#pick()
      if (picked === undefined) return
      const next = this.#queue.splice(picked.index, 1)[0]
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
      this.#start(next, picked.host)
    }
  }

  #pick(): { index: number; host: RunningTurn | undefined } | undefined {
    let interactive: number | undefined
    let background: number | undefined
    for (let index = 0; index < this.#queue.length; index++) {
      const turn = this.#queue[index]!
      if (this.sessionBusy(turn.sessionId)) continue
      const host = this.#hostFor(turn.chain)
      if (host !== undefined) return { index, host }
      if (!this.#place(turn)) continue
      if (turn.background) background ??= index
      else interactive ??= index
    }
    const index = interactive ?? background
    return index === undefined ? undefined : { index, host: undefined }
  }

  /** There is a place for `turn` of its own. */
  #place(turn: QueuedTurn): boolean {
    if (this.running >= this.#maxTurns) return false
    return !turn.background || this.backgroundRunning < this.#maxBackground
  }

  /**
   * The running turn a request with `chain` nests in: one the chain names
   * that has no nested turn of its own running, with the nesting still within
   * `LIMITS.maxAskChain`. A chain longer than that is no chain: the host never
   * passes one, and the gate does not read one.
   */
  #hostFor(chain: readonly string[]): RunningTurn | undefined {
    if (chain.length === 0 || chain.length > LIMITS.maxAskChain)
      return undefined
    return this.#running.find(
      turn =>
        turn.key !== undefined &&
        chain.includes(turn.key) &&
        !this.#running.some(other => other.host === turn) &&
        this.#depthOf(turn) <= LIMITS.maxAskChain,
    )
  }

  /** 1 for a turn with a place of its own, one more per asker above it. */
  #depthOf(turn: RunningTurn): number {
    let depth = 1
    for (let host = turn.host; host !== undefined; host = host.host) depth++
    return depth
  }

  #start(turn: QueuedTurn, host: RunningTurn | undefined): void {
    if (
      this.sessionBusy(turn.sessionId) ||
      (host === undefined && !this.#place(turn))
    )
      throw new Error('node turn gate overlap')
    const running: RunningTurn = {
      key: turn.key,
      sessionId: turn.sessionId,
      background: turn.background,
      host,
    }
    this.#running.push(running)
    void (async () => {
      try {
        turn.resolve(await turn.work())
      } catch (error) {
        turn.reject(error)
      } finally {
        // Released before pumping, and in a `finally`, because a node whose
        // first failing turn never releases the gate stops for good. By
        // identity: an asker stopped while its answer is still running ends
        // first, and the answer takes over the asker's place.
        this.#running.splice(this.#running.indexOf(running), 1)
        for (const other of this.#running)
          if (other.host === running) other.host = running.host
        this.#pump()
      }
    })()
  }
}
