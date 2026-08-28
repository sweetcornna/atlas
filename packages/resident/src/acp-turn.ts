// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import type { SessionNotification } from '@agentclientprotocol/sdk'
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
import type { ResidentTimingRecorder } from './timings.js'

/**
 * ACP stop reasons that are **not** a completed answer.
 *
 * Only `end_turn` means "the agent said what it had to say". The rest end the
 * turn with a body that is empty or cut short, and reporting those as
 * `outcome: 'completed'` would hand the requesting node a well-formed success
 * envelope it has no way to tell apart from a real one. Anything unknown is
 * left alone: a stop reason this build has never heard of is not evidence of
 * failure, and inventing one would be worse than the silence.
 */
const FAILED_STOP_REASONS = new Map<string, string>([
  ['cancelled', 'ACP turn was cancelled'],
  ['refusal', 'ACP turn ended in a refusal'],
  ['max_tokens', 'ACP turn hit the token ceiling before finishing'],
  ['max_turn_requests', 'ACP turn hit the request ceiling before finishing'],
])

/**
 * The `_meta` a watchdog cancel carries, so the agent on the other end can
 * record the turn as aborted by a machine rather than interrupted by a user.
 *
 * The base agent reads exactly this shape (`src/services/acp/agent/AcpAgent.ts`)
 * and writes `[Request aborted by the resident watchdog: …]` into the
 * transcript instead of `[Request interrupted by user]`. Before it existed,
 * every unattended timeout left a session record claiming a human had
 * cancelled it — while `timings.jsonl` recorded the truth two files away
 * (issue #39).
 */
export const RESIDENT_INACTIVITY_CANCEL_META: Record<string, unknown> = {
  qianmo: { cancelReason: 'inactivity' },
}

export const ACP_INPUT_ACCEPTED_METHOD = 'qianmo/input-accepted'
export const ACP_INPUT_STATUS_METHOD = 'qianmo/input-status'
export const ACP_SESSION_ACTIVITY_METHOD = 'qianmo/session-activity'
/**
 * Agent → host: the model endpoint answered a request with this HTTP status.
 *
 * One-way and failure-only. The host cannot see the agent's upstream traffic,
 * and without this the only thing a refused credential produces out here is
 * silence — which the watchdog then reports as "no activity", pointing every
 * reader at the model instead of the key (issue #37).
 */
export const ACP_UPSTREAM_STATUS_METHOD = 'qianmo/upstream-status'

export interface AcpPromptConnection {
  /**
   * Ask the agent to end the turn running in `sessionId` (ACP `session/cancel`).
   *
   * Optional because the only caller is the inactivity watchdog, and a
   * connection that cannot cancel still serves every other path — the watchdog
   * degrades to "fail the turn, let the old prompt wind down on its own",
   * which is what every other mid-flight failure already does.
   */
  cancel?(params: {
    readonly sessionId: string
    /**
     * ACP `_meta`, carrying **why**. `session/cancel` has no reason field of
     * its own, so the one piece of information that separates "a person
     * pressed Ctrl+C" from "this node's watchdog gave up" travels here — see
     * {@link RESIDENT_INACTIVITY_CANCEL_META}. An agent that ignores `_meta`
     * (as ACP allows) still cancels; it just records the turn the old way.
     */
    readonly _meta?: Record<string, unknown>
  }): Promise<void>
  extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>>
  prompt(params: {
    readonly sessionId: string
    readonly messageId: string
    readonly prompt: readonly [{ readonly type: 'text'; readonly text: string }]
  }): Promise<{
    readonly userMessageId?: string | null
    readonly stopReason?: string
  }>
}

/**
 * One step of a turn, on its way to whoever asked for the turn.
 *
 * The port raises these; **wiring them to the network is the host's job** —
 * this package knows nothing about envelopes, channels or peers, and the one
 * message type that can carry a step (`notify`) is addressed from facts only
 * the host holds (who sent the task, on which channel).
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
 * How many steps one turn may report.
 *
 * **A cap rather than a time window**, and the difference matters. The ceiling
 * that actually protects the person is `LIMITS.notifyRatePerMinute` downstream,
 * and it does not drop what it refuses — it *queues* it. So a turn that fires
 * a hundred steps does not flood the console; it makes the console show the
 * fortieth step two minutes after the answer already arrived. Stale progress is
 * worse than absent progress: it describes work that visibly finished.
 *
 * A sliding window would need a timer inside this class to flush what it held,
 * and this class is constructed by a dozen unit tests that have no business
 * growing one (see the constructor). A hard cap needs no clock at all.
 *
 * 24 is chosen against the budget, not against taste: at one step per tool a
 * turn under this cap cannot on its own exhaust a minute's worth of the human
 * budget, even when two sessions run at once.
 */
const MAX_PROGRESS_PER_TURN = 24

/**
 * File paths carried with one step.
 *
 * Bounded because a single edit tool can name a hundred files and the summary
 * beside it is one line: the point of the list is "which corner of the tree is
 * this touching", and the first few answer that as well as all of them do.
 */
const MAX_LOCATIONS_PER_STEP = 8

/** ACP tool kinds rendered as a verb. Anything unlisted keeps the bare title. */
const TOOL_KIND_VERBS: Readonly<Record<string, string>> = {
  read: '读',
  edit: '改',
  delete: '删',
  move: '移动',
  search: '搜',
  execute: '执行',
  fetch: '取',
}

function progressText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

export class AcpResidentTurnPort implements ResidentTurnPort {
  #connection: AcpPromptConnection
  readonly #accepted = new Map<string, () => Promise<void>>()
  readonly #active = new Map<
    string,
    {
      readonly input: ResidentTurnInput
      readonly content: string[]
      firstContent: boolean
      /** Steps already reported for this turn; stops at {@link MAX_PROGRESS_PER_TURN}. */
      progressCount: number
      /** Tool calls already announced, so an update never repeats a start. */
      readonly announcedTools: Set<string>
    }
  >()
  readonly #onProgress: ((progress: ResidentTurnProgress) => void) | undefined
  readonly #timings: ResidentTimingRecorder | undefined
  readonly #now: () => number
  readonly #inactivity: ResidentInactivityWatchdog | undefined
  readonly #upstreamHealth: ResidentUpstreamHealth

  constructor(
    connection: AcpPromptConnection,
    options: {
      readonly timings?: ResidentTimingRecorder
      readonly now?: () => number
      /**
       * Turn on the inactivity watchdog (design §3.B10). **Off when absent**,
       * on purpose: this port is constructed by a dozen unit tests that have no
       * business growing a timer, and the production host passes it explicitly.
       */
      readonly inactivity?: ResidentInactivityOptions
      /**
       * Where upstream statuses are remembered. Injectable so a test can pin
       * the clock the staleness window is measured against; the port makes its
       * own when the caller does not care.
       */
      readonly upstreamHealth?: ResidentUpstreamHealth
      /**
       * Where a turn's steps go. **Absent means the port reports none**, which
       * is what every unit test and every non-networked caller wants: raising
       * steps nobody consumes would only cost the work of formatting them.
       */
      readonly onProgress?: (progress: ResidentTurnProgress) => void
    } = {},
  ) {
    this.#connection = connection
    this.#onProgress = options.onProgress
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
            // Wired here rather than by the caller because "how to stop an ACP
            // turn" is knowledge this port has and the watchdog deliberately
            // does not.
            onExpired: turn => {
              void this.#connection.cancel?.({
                sessionId: turn.sessionId,
                _meta: RESIDENT_INACTIVITY_CANCEL_META,
              })
            },
          })
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
   * Record one upstream HTTP status reported by the ACP child.
   *
   * Called from the `qianmo/upstream-status` notification handler and from the
   * host's own startup credential probe — the two are the same fact arriving
   * from different directions, so they share one memory rather than producing
   * two answers that can disagree.
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
   * The turn running in `sessionId` right now, or `undefined`.
   *
   * The one consumer is outbound `notify`: an agent asking to announce
   * something has to be attributed to the task that is paying for its turn, or
   * the host has no address to send to and no `contextId` to group by. Asking
   * *per session* rather than "whatever is running" matters even though the
   * node gate is currently global — invariant #15 says a correctness claim
   * must not lean on the gate's granularity, and this is one of those claims.
   *
   * Read-only by construction: the entry disappears in `execute`'s `finally`,
   * so a notification arriving after its turn ended finds nothing and is
   * refused rather than charged to whichever task happens to be next.
   */
  activeTurn(sessionId: string): ResidentTurnInput | undefined {
    return this.#active.get(sessionId)?.input
  }

  replaceConnection(connection: AcpPromptConnection): void {
    this.#connection = connection
  }

  async isAccepted(input: ResidentTurnInput): Promise<boolean> {
    const result = await this.#connection.extMethod(ACP_INPUT_STATUS_METHOD, {
      sessionId: input.sessionId,
      messageId: input.messageId,
    })
    return result.accepted === true
  }

  async execute(
    input: ResidentTurnInput,
    onAccepted: () => Promise<void>,
  ): Promise<ResidentTurnResult> {
    let admission: Promise<void> | null = null
    const accept = (): Promise<void> => {
      admission ??= onAccepted()
      return admission
    }
    this.#accepted.set(input.messageId, accept)
    const active = {
      input,
      content: [],
      firstContent: false,
      progressCount: 0,
      announcedTools: new Set<string>(),
    }
    this.#active.set(input.sessionId, active)
    try {
      const ask = async () =>
        await this.#connection.prompt({
          sessionId: input.sessionId,
          messageId: input.messageId,
          prompt: [{ type: 'text', text: input.prompt }],
        })
      // Guarded, not raced by hand: a rejection from the watchdog travels the
      // same path an ACP transport error already does, so it reaches the
      // sender as a `task.result{failed}` carrying the watchdog's reason
      // rather than a bare timeout.
      const response =
        this.#inactivity === undefined
          ? await ask()
          : await this.#inactivity.guard(
              { sessionId: input.sessionId, messageId: input.messageId },
              ask,
            )
      if (response.userMessageId === input.messageId) await accept()
      else if (admission !== null) await admission
      const failure = FAILED_STOP_REASONS.get(response.stopReason ?? '')
      if (failure !== undefined) {
        this.#timings?.record({
          stage: 'turn_failed',
          at: this.#now(),
          sessionId: input.sessionId,
          inputMessageId: input.messageId,
          ...(input.networkMsgId === undefined
            ? {}
            : { networkMsgId: input.networkMsgId }),
          ...(input.agent === undefined ? {} : { agent: input.agent }),
          error: response.stopReason ?? 'unknown',
        })
        return {
          outcome: 'failed',
          code: ProtocolErrorCode.E_TASK_FAILED,
          reason: failure,
        }
      }
      this.#timings?.record({
        stage: 'turn_completed',
        at: this.#now(),
        sessionId: input.sessionId,
        inputMessageId: input.messageId,
        ...(input.networkMsgId === undefined
          ? {}
          : { networkMsgId: input.networkMsgId }),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
      })
      return { outcome: 'completed', content: active.content.join('') }
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
      this.#accepted.delete(input.messageId)
      if (this.#active.get(input.sessionId) === active) {
        this.#active.delete(input.sessionId)
      }
    }
  }

  handleSessionUpdate(params: SessionNotification): void {
    // Every update counts as a sign of life, including ones for a session this
    // port is not currently running a turn for (a no-op on the watchdog) and
    // including `agent_thought_chunk` — a model thinking out loud is exactly
    // the long-running turn B10 must not kill.
    this.#inactivity?.touch(params.sessionId)
    const active = this.#active.get(params.sessionId)
    if (active === undefined) return
    const kind = params.update.sessionUpdate
    if (kind === 'agent_message_chunk') {
      const content = params.update.content
      if (content.type === 'text') active.content.push(content.text)
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.#reportToolStep(active, params.update as Record<string, unknown>)
      return
    }
    if (kind !== 'agent_message_chunk' && kind !== 'agent_thought_chunk') {
      return
    }
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

  /**
   * Turn one tool-call update into at most one step.
   *
   * **A tool is announced when it starts, and again only if it fails.** The
   * successful end of a tool needs no line of its own — the next tool's start
   * already says the previous one finished, and spending a second message on
   * "…and it worked" halves how many tools fit under the cap.
   *
   * `agent_thought_chunk` and `agent_message_chunk` are deliberately not steps:
   * they arrive per token, and the one message type that can carry a step is
   * metered as an interruption of a person (`notify.ts`). Progress here is
   * discrete by construction, never streamed.
   */
  #reportToolStep(
    active: {
      readonly input: ResidentTurnInput
      progressCount: number
      readonly announcedTools: Set<string>
    },
    update: Record<string, unknown>,
  ): void {
    const onProgress = this.#onProgress
    const networkMsgId = active.input.networkMsgId
    // No consumer, or a turn nobody asked for over the network (local mail):
    // there is no peer this step belongs to, so there is nothing to raise.
    if (onProgress === undefined || networkMsgId === undefined) return

    const toolCallId = progressText(update['toolCallId'])
    if (toolCallId === undefined) return
    const status = progressText(update['status'])
    const failed = status === 'failed'
    const started = !active.announcedTools.has(toolCallId)
    if (!started && !failed) return
    // A failure re-announces once; a second `failed` update for the same call
    // does not. The key carries the phase so the two are distinct records.
    const phase = failed ? 'failed' : 'start'
    const dedupKey = `${networkMsgId}:${toolCallId}:${phase}`
    if (failed && active.announcedTools.has(`${toolCallId}#failed`)) return

    if (active.progressCount >= MAX_PROGRESS_PER_TURN) {
      // Silently stop rather than queue: see MAX_PROGRESS_PER_TURN on why a
      // step delivered after the answer is worse than one never sent.
      return
    }
    const title = progressText(update['title'])
    const verb = TOOL_KIND_VERBS[String(update['kind'])]
    const summary =
      title === undefined
        ? failed
          ? '一个工具失败了'
          : '开始跑一个工具'
        : verb === undefined
          ? title
          : `${verb}：${title}`

    // 工具报了它碰哪些文件就带上，报了才带——**不去猜**，也不去正则解析模型
    // 说了什么。带上的是路径本身，不是一个宣称有结构的东西：`notify` 的载荷
    // 只有字符串，把「改了哪些文件」硬编成一种格式，等于在没有协议支持的地方
    // 私自定义一个，而下一个读它的人无从知道那是约定还是巧合。
    const locations = Array.isArray(update['locations'])
      ? (update['locations'] as unknown[])
          .map(one =>
            typeof one === 'object' && one !== null
              ? progressText((one as Record<string, unknown>)['path'])
              : undefined,
          )
          .filter((one): one is string => one !== undefined)
          .slice(0, MAX_LOCATIONS_PER_STEP)
      : []

    active.progressCount += 1
    active.announcedTools.add(toolCallId)
    if (failed) active.announcedTools.add(`${toolCallId}#failed`)
    onProgress({
      sessionId: active.input.sessionId,
      networkMsgId,
      summary: failed ? `${summary} — 失败` : summary,
      severity: failed ? 'warn' : 'info',
      dedupKey,
      ...(locations.length === 0 ? {} : { detail: locations.join('\n') }),
    })
  }

  async handleInputAccepted(params: Record<string, unknown>): Promise<void> {
    // Admission is itself a sign of life, and it is the step most likely to be
    // slow on a loaded agent. Touching an unarmed session is a no-op, so an
    // unrecognized notification still flips nothing — the invariant that
    // `#accepted` below enforces is untouched.
    if (typeof params.sessionId === 'string') {
      this.#inactivity?.touch(params.sessionId)
    }
    const messageId = params.messageId
    if (typeof messageId !== 'string') return
    await this.#accepted.get(messageId)?.()
  }
}
