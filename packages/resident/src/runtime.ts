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
import type { ResidentTimingRecorder } from './timings.js'

export interface ResidentAgentBinding {
  readonly agent: string
  readonly sessionId: string
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
    for (const binding of options.agents) {
      if (this.#readers.has(binding.agent)) {
        throw new Error(`duplicate resident agent ${binding.agent}`)
      }
      this.#readers.set(
        binding.agent,
        new ResidentMailboxReader({
          agent: binding.agent,
          team: this.#team,
          sessionId: binding.sessionId,
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
