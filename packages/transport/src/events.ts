// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * What the transport records about itself.
 *
 * A refused handshake has to leave a trace — that is half of P2.2's third
 * acceptance criterion, and an operator with no record of rejected dials
 * cannot tell a misconfigured peer from an attack. The records live in this
 * package instead of the base's telemetry for two reasons: the base's logging
 * is wired to session analytics (a cross-node dial is not a session event),
 * and a leaf package with no `src/` imports cannot pull the CLI's module graph
 * into a headless node.
 *
 * Nothing here may carry a secret or payload content: records are meant to be
 * printable.
 */

export enum TransportEventType {
  /** A socket was accepted, before any handshake. */
  ConnectionOpened = 'connection_opened',
  /** A socket went away, for any reason. */
  ConnectionClosed = 'connection_closed',
  /** Handshake passed. */
  AuthAccepted = 'auth_accepted',
  /** Handshake refused — wrong key, replayed nonce, malformed frame. */
  AuthRejected = 'auth_rejected',
  /** An envelope was taken in for the first time. */
  MessageAccepted = 'message_accepted',
  /** An envelope was recognised as a duplicate and not handled again. */
  MessageDuplicate = 'message_duplicate',
  /** An envelope was refused (validation, or the handler threw). */
  MessageRejected = 'message_rejected',
  /** A retry was scheduled. */
  ReconnectScheduled = 'reconnect_scheduled',
  /** The retry budget ran out. */
  ReconnectGaveUp = 'reconnect_gave_up',
  /** A gap in the wall clock was read as a freeze; the budget was reset. */
  TimeJumpDetected = 'time_jump_detected',
}

/** Values a record may carry. Deliberately narrow — no objects, no payloads. */
export type EventDetail = Record<string, string | number | boolean>

export interface TransportEvent {
  readonly type: TransportEventType
  /** Epoch ms, from the owner's injected clock. */
  readonly at: number
  readonly detail: EventDetail
}

/** Where records go. */
export type TransportEventSink = (event: TransportEvent) => void

/** Default retained records, per server or client. */
export const DEFAULT_EVENT_CAPACITY = 256

/**
 * A bounded in-memory record of what happened.
 *
 * Bounded because a node under a dial flood must not answer it by exhausting
 * its own heap; the oldest records are the ones an operator needs least.
 */
export class EventRecorder {
  private readonly events: TransportEvent[] = []

  constructor(
    private readonly capacity: number = DEFAULT_EVENT_CAPACITY,
    private readonly sink?: TransportEventSink,
  ) {}

  record(event: TransportEvent): void {
    this.events.push(event)
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity)
    }
    this.sink?.(event)
  }

  /** Every retained record, oldest first. */
  all(): readonly TransportEvent[] {
    return [...this.events]
  }

  /** Retained records of one kind, oldest first. */
  byType(type: TransportEventType): readonly TransportEvent[] {
    return this.events.filter(event => event.type === type)
  }

  clear(): void {
    this.events.length = 0
  }
}
