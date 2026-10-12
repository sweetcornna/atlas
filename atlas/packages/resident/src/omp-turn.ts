// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ProtocolErrorCode } from '@qianmo/protocol'
import type {
  ResidentTurnInput,
  ResidentTurnPort,
  ResidentTurnResult,
} from './contracts.js'
import {
  ResidentInactivityWatchdog,
  ResidentUpstreamHealth,
  type ResidentInactivityOptions,
} from './inactivity.js'
import type { OmpRpcChannel, OmpRpcFrame, OmpTurnRouter } from './omp-rpc.js'
import type { ResidentTimingRecorder } from './timings.js'
import { stripMemoryCitations } from './memory-sidecar.js'

/**
 * The reasons a turn fails with when the agent reports a model error, spelled
 * here and nowhere else.
 *
 * `task.result{failed}` has one error code for every execution failure
 * (`E_TASK_FAILED`) and one free-text `reason`. A new protocol code would make
 * every older peer refuse the whole result (rule N-1, `@qianmo/protocol`
 * errors.ts), so the kind of failure travels as the start of `reason` instead,
 * and {@link turnFailureKind} is the only code that reads it back — the same
 * arrangement as {@link turnStepDedupKey}.
 */
const MODEL_EMPTY_RESPONSE_REASON = 'Model returned only empty responses'
const MODEL_ERROR_REASON = 'Model request failed'

/** How much of the agent's error text a reason carries. */
const MAX_MODEL_ERROR_DETAIL = 300

/**
 * omp has no dedicated code for an empty completion that outlived its
 * retries; its providers raise it as an error whose text says so ("returned an
 * empty response"). Matching the text is the only handle, and it fails safe:
 * an unmatched empty-response error is still a `model_error`.
 */
const EMPTY_RESPONSE_PATTERN = /\bempty (model )?response\b/i

const CANCELLED_REASON = 'resident turn was aborted before it finished'
const TOKEN_CEILING_REASON =
  'resident turn hit the token ceiling before finishing'

/**
 * What kind of failure a `task.result` reason records, when it is one this
 * package wrote for a model error; `undefined` for every other reason.
 */
export function turnFailureKind(
  reason: string,
): 'model_empty_response' | 'model_error' | undefined {
  if (reason.startsWith(MODEL_EMPTY_RESPONSE_REASON)) {
    return 'model_empty_response'
  }
  if (reason.startsWith(MODEL_ERROR_REASON)) return 'model_error'
  return undefined
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function modelFailure(message: unknown): {
  readonly kind: 'model_empty_response' | 'model_error'
  readonly reason: string
} {
  const text = typeof message === 'string' ? message : ''
  const empty = EMPTY_RESPONSE_PATTERN.test(text)
  const prefix = empty ? MODEL_EMPTY_RESPONSE_REASON : MODEL_ERROR_REASON
  const detail = text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MODEL_ERROR_DETAIL)
  return {
    kind: empty ? 'model_empty_response' : 'model_error',
    reason: detail === '' ? prefix : `${prefix}: ${detail}`,
  }
}

/**
 * The one tool that must not spend a progress row on itself: its whole
 * purpose is to put a line in the operator's transcript, so reporting the call
 * as well says the same thing twice. Matched on the RPC tool name, which on
 * omp is the real registered name; pinned against the host's constant by
 * `test/host/notifyToolName.test.ts`.
 */
export const SELF_REPORTING_TOOL_TITLE = 'qianmo_notify'

/**
 * One step of a turn, on its way to whoever asked for the turn.
 *
 * The port raises these; **wiring them to the network is the host's job** —
 * this package knows nothing about envelopes, channels or peers.
 */
export interface ResidentTurnProgress {
  readonly sessionId: string
  /** The network message whose turn this step belongs to. */
  readonly networkMsgId: string
  /** One line, already human-readable. */
  readonly summary: string
  readonly severity: 'info' | 'warn' | 'error'
  /** Sender-side idempotency key, stable across a redelivery of the same step. */
  readonly dedupKey: string
  /** File paths the tool named, when it named any. Folded away by the reader. */
  readonly detail?: string
}

/**
 * How many steps one turn may report. A cap rather than a time window: the
 * downstream notify limiter queues what it refuses, so a chatty turn would
 * otherwise deliver its fortieth step minutes after the answer — stale
 * progress is worse than absent progress.
 */
const MAX_PROGRESS_PER_TURN = 24

/**
 * Failures get their own, smaller budget so a turn that starts many tools
 * cannot spend the whole cap on "started" lines and drop the one failure the
 * operator has to act on.
 */
const MAX_FAILURES_PER_TURN = 8

/** File paths carried with one step. */
const MAX_LOCATIONS_PER_STEP = 8

/** Longest argument excerpt a step summary carries. */
const MAX_STEP_DETAIL = 160

/**
 * omp tool names rendered as a verb. Anything unlisted keeps the bare name.
 * Looked up with `Object.hasOwn`: the key comes off the wire, and a plain
 * lookup would reach `Object.prototype` for a tool named `constructor`.
 */
const TOOL_VERBS: Record<string, string> = {
  read: '读',
  write: '改',
  edit: '改',
  ast_edit: '改',
  bash: '执行',
  eval: '执行',
  grep: '搜',
  glob: '搜',
  find: '搜',
  ast_grep: '搜',
  fetch: '取',
  web_search: '取',
}

/** Argument fields that name what a tool is working on, in preference order. */
const TOOL_SUBJECT_FIELDS = [
  'path',
  'file_path',
  'command',
  'pattern',
  'url',
  'query',
] as const

/** Argument fields that hold file paths. */
const TOOL_PATH_FIELDS = ['path', 'file_path', 'paths', 'files'] as const

/** The two moments a tool call is reported in; see {@link turnStepDedupKey}. */
export type TurnStepPhase = 'start' | 'failed'

/** A step's `dedupKey`, taken apart. */
export interface TurnStepKey {
  /** The network message whose turn raised the step. */
  readonly networkMsgId: string
  readonly toolCallId: string
  readonly phase: TurnStepPhase
}

/**
 * The `dedupKey` every step carries, spelled here and nowhere else. Its shape
 * is also what tells a receiver (`qm watch`) a node-raised step apart from a
 * `notify` the agent sent itself.
 */
export function turnStepDedupKey(
  networkMsgId: string,
  toolCallId: string,
  phase: TurnStepPhase,
): string {
  return `${networkMsgId}:${toolCallId}:${phase}`
}

/**
 * Take a {@link turnStepDedupKey} apart, or `undefined` when `key` does not
 * have that shape. The first colon ends the message id and the last colon
 * starts the phase, so a tool call id containing colons still parses.
 */
export function parseTurnStepDedupKey(key: string): TurnStepKey | undefined {
  const first = key.indexOf(':')
  const last = key.lastIndexOf(':')
  if (first <= 0 || last <= first + 1) return undefined
  const phase = key.slice(last + 1)
  if (phase !== 'start' && phase !== 'failed') return undefined
  return {
    networkMsgId: key.slice(0, first),
    toolCallId: key.slice(first + 1, last),
    phase,
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function stepSubject(
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (args === undefined) return undefined
  for (const field of TOOL_SUBJECT_FIELDS) {
    const value = text(args[field])
    if (value === undefined) continue
    const flat = value.replace(/\s+/g, ' ')
    return flat.length > MAX_STEP_DETAIL
      ? `${flat.slice(0, MAX_STEP_DETAIL - 1)}…`
      : flat
  }
  return undefined
}

function stepLocations(args: Record<string, unknown> | undefined): string[] {
  if (args === undefined) return []
  const paths: string[] = []
  for (const field of TOOL_PATH_FIELDS) {
    const value = args[field]
    const values = Array.isArray(value) ? value : [value]
    for (const one of values) {
      const path = text(one)
      if (path !== undefined && !paths.includes(path)) paths.push(path)
    }
  }
  return paths.slice(0, MAX_LOCATIONS_PER_STEP)
}

/** Text blocks of an RPC message, joined. */
function messageText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let joined = ''
  for (const block of content) {
    const record = recordOf(block)
    if (record?.type === 'text' && typeof record.text === 'string') {
      joined += record.text
    }
  }
  return joined
}

interface ActiveTurn {
  memoryAnswer?: unknown
  usageSequence: number
  readonly input: ResidentTurnInput
  /** Final text of each assistant message, in order. */
  readonly content: string[]
  firstContent: boolean
  successfulTool: boolean
  /** Tool starts reported; stops at {@link MAX_PROGRESS_PER_TURN}. */
  progressCount: number
  /** Tool failures reported; stops at {@link MAX_FAILURES_PER_TURN}. */
  failureCount: number
  /** Tool calls already announced, so a repeat never re-announces a start. */
  readonly announcedTools: Set<string>
  /** The last assistant message's stop reason. */
  lastStopReason: string | undefined
}

/**
 * The resident's turn port on omp RPC (design `base-switch-omp.md` §4.3).
 *
 * One turn is one RPC `prompt` on the session's own child, completed by the
 * `prompt_result` that carries the prompt's request id:
 *
 * | resident signal   | RPC source                                                  |
 * |-------------------|-------------------------------------------------------------|
 * | input accepted    | the first user `message_end` after the prompt was sent       |
 * | answer            | text of the assistant `message_end`s, then `prompt_result`   |
 * | failure           | `prompt_result.status` `aborted`/`error`, or `stopReason: length` |
 * | upstream status   | `message_end.errorStatus`, `prompt_result.error.httpStatus`  |
 * | sign of life      | every frame on the session's channel during the turn          |
 * | watchdog cancel   | RPC `abort`; the reason stays host-side (timings, task.result)|
 * | crash recovery    | {@link OmpTurnRouter.isAccepted} (identity entry scan)        |
 *
 * The node gate already serializes turns, so a channel carries at most one
 * turn of ours at a time; frames that arrive while no turn is active (a late
 * frame of an aborted run) are ignored apart from touching the watchdog.
 */
export class OmpResidentTurnPort implements ResidentTurnPort {
  readonly #router: OmpTurnRouter
  readonly #active = new Map<string, ActiveTurn>()
  readonly #onProgress: ((progress: ResidentTurnProgress) => void) | undefined
  readonly #onUsage:
    | ((
        input: ResidentTurnInput,
        usage: Readonly<
          Record<'input' | 'output' | 'cacheWrite' | 'cacheRead', number>
        >,
        sequence: number,
      ) => void)
    | undefined
  readonly #memoryAnswer:
    | ((
        input: ResidentTurnInput,
        args: unknown,
      ) => { ok: boolean; text: string })
    | undefined
  readonly #timings: ResidentTimingRecorder | undefined
  readonly #now: () => number
  readonly #inactivity: ResidentInactivityWatchdog | undefined
  readonly #upstreamHealth: ResidentUpstreamHealth
  /** Channels of turns still running, for the watchdog's abort. */
  readonly #channels = new Map<string, OmpRpcChannel>()

  constructor(
    router: OmpTurnRouter,
    options: {
      readonly timings?: ResidentTimingRecorder
      readonly now?: () => number
      /**
       * Turn on the inactivity watchdog (design §3.B10). **Off when absent**,
       * so unit tests do not grow a timer; the production host passes it.
       */
      readonly inactivity?: ResidentInactivityOptions
      /** Where upstream statuses are remembered; made here when absent. */
      readonly upstreamHealth?: ResidentUpstreamHealth
      /** Where a turn's steps go. Absent means none are raised. */
      readonly onProgress?: (progress: ResidentTurnProgress) => void
      readonly onUsage?: (
        input: ResidentTurnInput,
        usage: Readonly<
          Record<'input' | 'output' | 'cacheWrite' | 'cacheRead', number>
        >,
        sequence: number,
      ) => void
      readonly memoryAnswer?: (
        input: ResidentTurnInput,
        args: unknown,
      ) => { ok: boolean; text: string }
    } = {},
  ) {
    this.#router = router
    this.#onProgress = options.onProgress
    this.#onUsage = options.onUsage
    this.#memoryAnswer = options.memoryAnswer
    this.#timings = options.timings
    this.#now = options.now ?? Date.now
    this.#upstreamHealth =
      options.upstreamHealth ?? new ResidentUpstreamHealth()
    this.#inactivity =
      options.inactivity === undefined
        ? undefined
        : new ResidentInactivityWatchdog({
            upstreamHealth: this.#upstreamHealth,
            ...options.inactivity,
            // How to stop an omp turn is this port's knowledge, not the
            // watchdog's. omp's transcript records its own abort marker; the
            // reason (inactivity, and the upstream status behind it) is what
            // the watchdog's rejection carries into timings and task.result.
            onExpired: turn => {
              void this.#channels
                .get(turn.sessionId)
                ?.abort()
                .catch(() => {})
            },
          })
  }

  inactivityRemaining(sessionId: string): number {
    return this.#inactivity?.remaining(sessionId) ?? Infinity
  }

  /** The inactivity budget in force, or `0` when the watchdog is off. */
  get inactivityMs(): number {
    return this.#inactivity?.timeoutMs ?? 0
  }

  /** What this node last heard from its model endpoint. Observation only. */
  get upstreamHealth(): ResidentUpstreamHealth {
    return this.#upstreamHealth
  }

  /**
   * Record one upstream HTTP status. Called from the RPC stream (below) and
   * from the host's startup credential probe: the same fact from two
   * directions, kept in one memory.
   */
  handleUpstreamStatus(params: Record<string, unknown>): void {
    const status = params.status
    if (typeof status !== 'number') return
    const detail = params.detail
    this.#upstreamHealth.record(
      status,
      typeof detail === 'string' && detail.length > 0 ? detail : undefined,
    )
  }

  /**
   * The turn running in `sessionId` right now, or `undefined`. Used to
   * attribute an agent's `qianmo_notify` call to the task paying for the turn;
   * the entry disappears when the turn ends, so a late call is refused rather
   * than charged to the next task.
   */
  activeTurn(sessionId: string): ResidentTurnInput | undefined {
    return this.#active.get(sessionId)?.input
  }

  async isAccepted(input: ResidentTurnInput): Promise<boolean> {
    return await this.#router.isAccepted(input.sessionId, input.messageId)
  }

  memoryAnswer(
    sessionId: string,
    args: unknown,
  ): { ok: boolean; text: string } {
    const active = this.#active.get(sessionId)
    if (active === undefined || this.#memoryAnswer === undefined)
      return { ok: false, text: 'No active memory-enabled turn.' }
    const result = this.#memoryAnswer(active.input, args)
    if (result.ok) active.memoryAnswer = structuredClone(args)
    return result
  }

  activeInput(sessionId: string): ResidentTurnInput | undefined {
    return this.#active.get(sessionId)?.input
  }

  async execute(
    input: ResidentTurnInput,
    onAccepted: () => Promise<void>,
  ): Promise<ResidentTurnResult> {
    let admission: Promise<void> | null = null
    const accept = (): Promise<void> => {
      admission ??= (async () => {
        const channel = this.#channels.get(input.sessionId)
        let closed = false
        void channel?.closed.then(
          () => {
            closed = true
          },
          () => {
            closed = true
          },
        )
        const deadline = Date.now() + 30_000
        while (
          !(await this.#router.isAccepted(input.sessionId, input.messageId))
        ) {
          if (closed || !this.#active.has(input.sessionId))
            throw new Error('omp closed before durable input admission')
          if (Date.now() >= deadline)
            throw new Error('omp durable input admission timed out')
          await new Promise(resolve => setTimeout(resolve, 5))
        }
        if (!this.#active.has(input.sessionId))
          throw new Error('omp turn ended before durable input admission')
        await onAccepted()
      })()
      return admission
    }
    const active: ActiveTurn = {
      usageSequence: 0,
      input,
      content: [],
      firstContent: false,
      successfulTool: false,
      progressCount: 0,
      failureCount: 0,
      announcedTools: new Set<string>(),
      lastStopReason: undefined,
    }
    this.#active.set(input.sessionId, active)
    let unsubscribe: (() => void) | undefined
    try {
      const run = async (): Promise<ResidentTurnResult> => {
        const channel = await this.#router.channelFor(input.sessionId)
        this.#channels.set(input.sessionId, channel)
        const outcome = this.#awaitOutcome(channel, active, accept)
        unsubscribe = outcome.unsubscribe
        const admitted = await channel.prompt({
          messageId: input.messageId,
          text: input.prompt,
        })
        outcome.admitted(admitted.requestId)
        if (!admitted.agentInvoked) {
          // A local completion writes no user message, so nothing else will
          // admit it; it is admitted by having run.
          admission ??= onAccepted()
          await admission
          return { outcome: 'completed', content: admitted.output ?? '' }
        }
        const frame = await outcome.result
        if (admission !== null) await admission
        return this.#resultOf(active, frame)
      }
      // Guarded, not raced by hand: a rejection from the watchdog travels the
      // same path a transport error does, so it reaches the sender as a
      // `task.result{failed}` carrying the watchdog's reason.
      const result =
        this.#inactivity === undefined
          ? await run()
          : await this.#inactivity.guard(
              { sessionId: input.sessionId, messageId: input.messageId },
              run,
            )
      this.#recordEnd(input, result)
      return result
    } catch (error) {
      this.#timings?.record({
        stage: 'turn_failed',
        at: this.#now(),
        sessionId: input.sessionId,
        inputMessageId: input.messageId,
        ...(input.networkMsgId === undefined
          ? {}
          : { networkMsgId: input.networkMsgId }),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        error: error instanceof Error ? error.name : 'unknown',
      })
      throw error
    } finally {
      unsubscribe?.()
      if (this.#active.get(input.sessionId) === active) {
        this.#active.delete(input.sessionId)
        this.#channels.delete(input.sessionId)
      }
    }
  }

  /**
   * Subscribe before the prompt is sent, so nothing the child says about this
   * turn is missed, and resolve on this prompt's `prompt_result`. Results are
   * buffered by id until the prompt's own id is known: the response that
   * carries it and the `prompt_result` can be dispatched in the same tick.
   */
  #awaitOutcome(
    channel: OmpRpcChannel,
    active: ActiveTurn,
    accept: () => Promise<void>,
  ): {
    readonly result: Promise<OmpRpcFrame>
    readonly admitted: (requestId: string) => void
    readonly unsubscribe: () => void
  } {
    const sessionId = active.input.sessionId
    const results = new Map<string, OmpRpcFrame>()
    let requestId: string | undefined
    let resolve!: (frame: OmpRpcFrame) => void
    let reject!: (error: unknown) => void
    const result = new Promise<OmpRpcFrame>((res, rej) => {
      resolve = res
      reject = rej
    })
    result.catch(() => {})
    const unsubscribe = channel.onFrame(frame => {
      this.#inactivity?.touch(sessionId)
      if (frame.type === 'prompt_result') {
        if (typeof frame.id !== 'string') return
        if (requestId === undefined) results.set(frame.id, frame)
        else if (frame.id === requestId) resolve(frame)
        return
      }
      this.#handleFrame(active, frame, accept)
    })
    void channel.closed.then(
      () => reject(new Error('resident omp child exited during the turn')),
      error =>
        reject(
          new Error(
            `resident omp child exited during the turn: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
    )
    return {
      result,
      admitted: id => {
        requestId = id
        const early = results.get(id)
        if (early !== undefined) resolve(early)
        results.clear()
      },
      unsubscribe,
    }
  }

  #handleFrame(
    active: ActiveTurn,
    frame: OmpRpcFrame,
    accept: () => Promise<void>,
  ): void {
    if (frame.type === 'message_end') {
      const message = recordOf(frame.message)
      if (message === undefined) return
      if (message.role === 'user') {
        void accept().catch(() => {})
        return
      }
      if (message.role !== 'assistant') return
      const rawUsage = recordOf(message.usage)
      if (rawUsage !== undefined) {
        const usage = Object.fromEntries(
          ['input', 'output', 'cacheWrite', 'cacheRead'].map(key => [
            key,
            rawUsage[key] ?? 0,
          ]),
        ) as Record<'input' | 'output' | 'cacheWrite' | 'cacheRead', number>
        if (
          Object.values(usage).every(
            value => Number.isSafeInteger(value) && value >= 0,
          )
        )
          this.#onUsage?.(active.input, usage, ++active.usageSequence)
      }
      const status = message.errorStatus
      if (typeof status === 'number') {
        this.#upstreamHealth.record(
          status,
          typeof message.errorMessage === 'string'
            ? message.errorMessage.slice(0, MAX_MODEL_ERROR_DETAIL)
            : undefined,
        )
      }
      active.lastStopReason =
        typeof message.stopReason === 'string' ? message.stopReason : undefined
      const body = messageText(message)
      if (body.length > 0) {
        active.content.push(body)
        this.#markFirstContent(active)
      }
      return
    }
    if (frame.type === 'message_update') {
      const message = recordOf(frame.message)
      if (message?.role === 'assistant') this.#markFirstContent(active)
      return
    }
    if (frame.type === 'tool_execution_start') {
      this.#reportToolStep(active, frame, false)
      return
    }
    if (frame.type === 'tool_execution_end') {
      if (frame.isError === true) this.#reportToolStep(active, frame, true)
      else active.successfulTool = true
    }
  }

  #markFirstContent(active: ActiveTurn): void {
    if (active.firstContent) return
    active.firstContent = true
    const input = active.input
    this.#timings?.record({
      stage: 'first_content',
      at: this.#now(),
      sessionId: input.sessionId,
      inputMessageId: input.messageId,
      ...(input.networkMsgId === undefined
        ? {}
        : { networkMsgId: input.networkMsgId }),
      ...(input.agent === undefined ? {} : { agent: input.agent }),
    })
  }

  #resultOf(active: ActiveTurn, frame: OmpRpcFrame): ResidentTurnResult {
    const status = frame.status
    if (status === 'error') {
      const error = recordOf(frame.error)
      if (typeof error?.httpStatus === 'number') {
        this.#upstreamHealth.record(
          error.httpStatus,
          typeof error.message === 'string'
            ? error.message.slice(0, MAX_MODEL_ERROR_DETAIL)
            : undefined,
        )
      }
      const failure = modelFailure(error?.message)
      return {
        outcome: 'failed',
        code: ProtocolErrorCode.E_TASK_FAILED,
        reason: failure.reason,
      }
    }
    if (status === 'aborted') {
      return {
        outcome: 'failed',
        code: ProtocolErrorCode.E_TASK_FAILED,
        reason: CANCELLED_REASON,
      }
    }
    if (active.lastStopReason === 'length') {
      return {
        outcome: 'failed',
        code: ProtocolErrorCode.E_TASK_FAILED,
        reason: TOKEN_CEILING_REASON,
      }
    }
    let content = stripMemoryCitations(active.content.join('\n\n'))
    if (active.memoryAnswer !== undefined) {
      const answer = this.#memoryAnswer?.(active.input, active.memoryAnswer)
      if (answer?.ok !== true)
        return {
          outcome: 'failed',
          code: ProtocolErrorCode.E_TASK_FAILED,
          reason: 'Memory citations are no longer valid for this turn',
        }
      content = answer.text
    }
    if (content.trim().length === 0 && !active.successfulTool) {
      return {
        outcome: 'failed',
        code: ProtocolErrorCode.E_TASK_FAILED,
        reason: MODEL_EMPTY_RESPONSE_REASON,
      }
    }
    return { outcome: 'completed', content }
  }

  #recordEnd(input: ResidentTurnInput, result: ResidentTurnResult): void {
    const base = {
      at: this.#now(),
      sessionId: input.sessionId,
      inputMessageId: input.messageId,
      ...(input.networkMsgId === undefined
        ? {}
        : { networkMsgId: input.networkMsgId }),
      ...(input.agent === undefined ? {} : { agent: input.agent }),
    }
    if (result.outcome === 'completed') {
      this.#timings?.record({ stage: 'turn_completed', ...base })
      return
    }
    this.#timings?.record({
      stage: 'turn_failed',
      ...base,
      error:
        turnFailureKind(result.reason) ??
        (result.reason === CANCELLED_REASON
          ? 'aborted'
          : result.reason === TOKEN_CEILING_REASON
            ? 'length'
            : 'unknown'),
    })
  }

  /**
   * Turn one tool execution event into at most one step: a tool is announced
   * when it starts, and again only if it fails. Token streams are never steps —
   * the one message type that can carry a step is metered as an interruption
   * of a person.
   */
  #reportToolStep(
    active: ActiveTurn,
    frame: OmpRpcFrame,
    failed: boolean,
  ): void {
    const onProgress = this.#onProgress
    const networkMsgId = active.input.networkMsgId
    // No consumer, or a turn nobody asked for over the network: there is no
    // peer this step belongs to.
    if (onProgress === undefined || networkMsgId === undefined) return
    const toolCallId = text(frame.toolCallId)
    if (toolCallId === undefined) return
    const toolName = text(frame.toolName)
    if (toolName === SELF_REPORTING_TOOL_TITLE) return
    if (!failed && active.announcedTools.has(toolCallId)) return
    if (failed && active.announcedTools.has(`${toolCallId}#failed`)) return
    // Silently stop rather than queue (see MAX_PROGRESS_PER_TURN).
    if (failed) {
      if (active.failureCount >= MAX_FAILURES_PER_TURN) return
    } else if (active.progressCount >= MAX_PROGRESS_PER_TURN) {
      return
    }
    const args = recordOf(frame.args)
    const subject = stepSubject(args)
    const verb =
      toolName !== undefined && Object.hasOwn(TOOL_VERBS, toolName)
        ? TOOL_VERBS[toolName]
        : undefined
    const summary =
      toolName === undefined
        ? failed
          ? '一个工具失败了'
          : '开始跑一个工具'
        : verb !== undefined
          ? `${verb}：${subject ?? toolName}`
          : subject === undefined
            ? toolName
            : `${toolName}：${subject}`
    // 工具参数里点名了哪些文件就带上哪些——不猜，也不解析模型说了什么。
    const locations = stepLocations(args)
    if (failed) active.failureCount += 1
    else active.progressCount += 1
    active.announcedTools.add(toolCallId)
    if (failed) active.announcedTools.add(`${toolCallId}#failed`)
    onProgress({
      sessionId: active.input.sessionId,
      networkMsgId,
      summary: failed ? `${summary} — 失败` : summary,
      severity: failed ? 'warn' : 'info',
      dedupKey: turnStepDedupKey(
        networkMsgId,
        toolCallId,
        failed ? 'failed' : 'start',
      ),
      ...(locations.length === 0 ? {} : { detail: locations.join('\n') }),
    })
  }
}
