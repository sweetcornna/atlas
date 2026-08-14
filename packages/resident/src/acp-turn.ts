// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import type { SessionNotification } from '@agentclientprotocol/sdk'
import { ProtocolErrorCode } from '@qianmo/protocol'
import type {
  ResidentTurnInput,
  ResidentTurnPort,
  ResidentTurnResult,
} from './contracts.js'
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

export const ACP_INPUT_ACCEPTED_METHOD = 'qianmo/input-accepted'
export const ACP_INPUT_STATUS_METHOD = 'qianmo/input-status'
export const ACP_SESSION_ACTIVITY_METHOD = 'qianmo/session-activity'

export interface AcpPromptConnection {
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

export class AcpResidentTurnPort implements ResidentTurnPort {
  #connection: AcpPromptConnection
  readonly #accepted = new Map<string, () => Promise<void>>()
  readonly #active = new Map<
    string,
    {
      readonly input: ResidentTurnInput
      readonly content: string[]
      firstContent: boolean
    }
  >()
  readonly #timings: ResidentTimingRecorder | undefined
  readonly #now: () => number

  constructor(
    connection: AcpPromptConnection,
    options: {
      readonly timings?: ResidentTimingRecorder
      readonly now?: () => number
    } = {},
  ) {
    this.#connection = connection
    this.#timings = options.timings
    this.#now = options.now ?? Date.now
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
    const active = { input, content: [], firstContent: false }
    this.#active.set(input.sessionId, active)
    try {
      const response = await this.#connection.prompt({
        sessionId: input.sessionId,
        messageId: input.messageId,
        prompt: [{ type: 'text', text: input.prompt }],
      })
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
    const active = this.#active.get(params.sessionId)
    if (active === undefined) return
    const kind = params.update.sessionUpdate
    if (kind === 'agent_message_chunk') {
      const content = params.update.content
      if (content.type === 'text') active.content.push(content.text)
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

  async handleInputAccepted(params: Record<string, unknown>): Promise<void> {
    const messageId = params.messageId
    if (typeof messageId !== 'string') return
    await this.#accepted.get(messageId)?.()
  }
}
