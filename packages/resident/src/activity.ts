// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import {
  MessageType,
  createMessage,
  formatAddress,
  parseAddress,
} from '@qianmo/protocol'
import { TransportClient, type TransportEndpoint } from '@qianmo/transport'

export const RESIDENT_ACTIVITY_AGENT = 'resident-activity'
export const DEFAULT_RESIDENT_ACTIVITY_TIME_JUMP_FACTOR = 1.1

export interface ResidentActivityPayload {
  readonly active: boolean
}

export function isResidentActivityPayload(
  value: unknown,
): value is ResidentActivityPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 1 && typeof record.active === 'boolean'
}

export class ResidentActivityReporter {
  readonly #client: TransportClient
  readonly #node: string
  readonly #to: string

  constructor(options: {
    readonly node: string
    readonly endpoint: TransportEndpoint
    readonly psk: string
    readonly reconnectTimeJumpFactor?: number
  }) {
    this.#node = options.node
    this.#to = formatAddress({
      node: options.node,
      agent: RESIDENT_ACTIVITY_AGENT,
    })
    this.#client = new TransportClient({
      endpoint: options.endpoint,
      node: options.node,
      psk: options.psk,
      backoff: {
        timeJumpFactor:
          options.reconnectTimeJumpFactor ??
          DEFAULT_RESIDENT_ACTIVITY_TIME_JUMP_FACTOR,
      },
    })
  }

  async connect(): Promise<void> {
    await this.#client.connect()
  }

  async report(active: boolean): Promise<void> {
    await this.#client.sendAndWait(
      createMessage({
        from: formatAddress({
          node: this.#node,
          agent: RESIDENT_ACTIVITY_AGENT,
        }),
        to: this.#to,
        type: MessageType.Ping,
        payload: { active },
      }),
    )
  }

  async close(): Promise<void> {
    await this.#client.close()
  }
}

export function isResidentActivityMessage(message: {
  readonly to: string
  readonly type: MessageType
  readonly payload: unknown
}): message is typeof message & { readonly payload: ResidentActivityPayload } {
  return (
    parseAddress(message.to)?.agent === RESIDENT_ACTIVITY_AGENT &&
    message.type === MessageType.Ping &&
    isResidentActivityPayload(message.payload)
  )
}
