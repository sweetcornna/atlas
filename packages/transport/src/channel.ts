// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import type { QianmoMessage } from '@qianmo/protocol'
import type { SuccessfulReceiptStatus } from './outbox.js'

/** Send side of one authenticated logical transport channel. */
export interface TransportChannel {
  /** Stable across physical WebSocket reconnects. */
  readonly id: string
  /** Authenticated audit label when known; not an authorization identity. */
  readonly peerNode: string | null
  /** Envelopes retained until their transport receipt arrives. */
  readonly pending: number
  isReady(): boolean
  isClosed(): boolean
  send(message: QianmoMessage): void
  sendAndWait(
    message: QianmoMessage,
    timeoutMs?: number,
  ): Promise<SuccessfulReceiptStatus>
  waitForDrain(timeoutMs?: number): Promise<void>
  /** Keep a disconnected server-side channel available for a later reply. */
  hold(): () => void
}

/** What a delivered envelope brings with it beyond the envelope itself. */
export interface InboundContext {
  readonly peerNode: string | null
  readonly receivedAt: number
  readonly channel: TransportChannel
}

/** Application handler on either endpoint of a bidirectional channel. */
export type InboundHandler = (
  message: QianmoMessage,
  context: InboundContext,
) => void | Promise<void>
