// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import type { QianmoMessage } from '@qianmo/protocol'
import { parseAddress } from '@qianmo/protocol'
import type {
  AdmissionLedger,
  ResidentMailboxMessage,
  ResidentMailboxPort,
  ResidentTurnInput,
  ResidentTurnPort,
  ResidentTurnResult,
} from './contracts.js'
import { NodeTurnGate } from './turn-gate.js'
import { ResidentMailboxReader } from './reader.js'
import type { ResidentSessionResolver } from './sessions.js'
import type { ResidentTimingRecorder } from './timings.js'

export interface ResidentAgentBinding {
  readonly agent: string
  /**
   * A single fixed session for this agent — the pre-multi-session shape, kept
   * for hosts (and tests) that have exactly one context. Mutually exclusive
   * with the node-level `sessions` resolver: exactly one of the two must be
   * present, because "which session does this batch belong to" has to have one
   * answer, not a fallback chain.
   */
  readonly sessionId?: string
  readonly ledger: AdmissionLedger
}

export class ResidentNodeRuntime {
  readonly #node: string
  readonly #team: string
  readonly #mailbox: ResidentMailboxPort
  readonly #turn: ResidentTurnPort
  readonly #formatPrompt: (
    messages: readonly ResidentMailboxMessage[],
  ) => string
  readonly #gate: NodeTurnGate
  readonly #readers = new Map<string, ResidentMailboxReader>()

  constructor(options: {
    readonly node: string
    readonly team: string
    readonly mailbox: ResidentMailboxPort
    readonly turn: ResidentTurnPort
    readonly formatPrompt: (
      messages: readonly ResidentMailboxMessage[],
    ) => string
    readonly accepts?: (message: ResidentMailboxMessage) => boolean
    readonly selectSnapshot?: (
      messages: readonly ResidentMailboxMessage[],
    ) => readonly ResidentMailboxMessage[]
    readonly correlationId?: (
      messages: readonly ResidentMailboxMessage[],
    ) => string | undefined
    /**
     * The requester's context for this batch, in the same shape as
     * `correlationId` and read from the same place — the envelope the adapter
     * already embedded in the mailbox entry. Absent, every batch resolves to
     * `DEFAULT_CONTEXT`, which is byte for byte the behaviour that predates
     * multi-session isolation.
     */
    readonly contextId?: (
      messages: readonly ResidentMailboxMessage[],
    ) => string | undefined
    /** Session source shared by every agent. See {@link ResidentAgentBinding}. */
    readonly sessions?: ResidentSessionResolver
    readonly timings?: ResidentTimingRecorder
    readonly gate?: NodeTurnGate
    readonly agents: readonly ResidentAgentBinding[]
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
  }) {
    this.#node = options.node
    this.#team = options.team
    this.#mailbox = options.mailbox
    this.#turn = options.turn
    this.#formatPrompt = options.formatPrompt
    this.#gate = options.gate ?? new NodeTurnGate()
    const sessions = options.sessions
    for (const binding of options.agents) {
      if (this.#readers.has(binding.agent)) {
        throw new Error(`duplicate resident agent ${binding.agent}`)
      }
      const staticSessionId = binding.sessionId
      if ((sessions === undefined) === (staticSessionId === undefined)) {
        throw new Error(
          `resident agent ${binding.agent} needs exactly one session source`,
        )
      }
      this.#readers.set(
        binding.agent,
        new ResidentMailboxReader({
          agent: binding.agent,
          team: this.#team,
          resolveSession:
            sessions === undefined
              ? () => staticSessionId as string
              : messages =>
                  sessions.sessionFor(
                    binding.agent,
                    options.contextId?.(messages),
                  ),
          ...(sessions === undefined
            ? {}
            : {
                onSessionRelease: (sessionId: string) => {
                  sessions.release(sessionId)
                },
              }),
          mailbox: this.#mailbox,
          turn: this.#turn,
          ledger: binding.ledger,
          formatPrompt: this.#formatPrompt,
          ...(options.accepts === undefined
            ? {}
            : { accepts: options.accepts }),
          ...(options.selectSnapshot === undefined
            ? {}
            : { selectSnapshot: options.selectSnapshot }),
          ...(options.correlationId === undefined
            ? {}
            : { correlationId: options.correlationId }),
          ...(options.timings === undefined
            ? {}
            : { timings: options.timings }),
          gate: this.#gate,
          onRead: options.onRead,
          onTurnResult: options.onTurnResult,
          onTurnError: options.onTurnError,
        }),
      )
    }
  }

  async deliver(message: QianmoMessage): Promise<void> {
    const address = parseAddress(message.to)
    if (address === null || address.node !== this.#node) {
      throw new Error(`message is not addressed to resident node ${this.#node}`)
    }
    const reader = this.#readers.get(address.agent)
    if (reader === undefined) {
      throw new Error(`resident agent ${address.agent} is not configured`)
    }
    await reader.poll()
  }

  async pollAll(): Promise<void> {
    await Promise.all([...this.#readers.values()].map(reader => reader.poll()))
  }
}
