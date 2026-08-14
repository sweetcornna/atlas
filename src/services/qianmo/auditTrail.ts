// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * Where the trail lives, and how each layer's events get onto it (P7.2).
 *
 * `@qianmo/audit` deliberately knows nothing about the layers that write to it —
 * it would otherwise depend on every package in the tree, and the dependency
 * would run the wrong way. So the translation lives here, in the wiring layer,
 * next to the path derivation it also owns.
 *
 * ## One mapping decision, applied everywhere
 *
 * Each layer's own event name goes through **unchanged** as `kind`. The
 * temptation is to normalise them into a tidy vocabulary; the reason not to is
 * that an operator reading the trail is usually holding a log line from one of
 * those layers, and a trail that renamed everything makes them do the
 * translation instead. What is normalised is only `outcome` — `ok` / `refused`
 * / `dropped` — because "did this go ahead" is the one question the trail must
 * answer uniformly, and the per-layer names for refusal are not comparable.
 */

import { AuditSource, AuditTrail, type AuditInput } from '@qianmo/audit'
import {
  RouterEventType,
  type RouterAuditEvent,
  type RouterAuditSink,
} from '@qianmo/router'
import {
  TransportEventType,
  type TransportEvent,
  type TransportEventSink,
} from '@qianmo/transport'
import { occConfigPath } from '../../config/paths.js'

/** Default location of this node's trail, derived from the config root. */
export function auditTrailPath(): string {
  return occConfigPath('qianmo', 'audit', 'trail.ndjson')
}

/** Open (or resume) the node's trail. */
export function openAuditTrail(path: string = auditTrailPath()): AuditTrail {
  return new AuditTrail(path)
}

function stringOf(
  detail: RouterAuditEvent['detail'],
  key: string,
): string | undefined {
  const value = detail[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Turn the router's events into trail records.
 *
 * Every router event that reaches this sink is a refusal — the router only
 * records loops, rate limits and capability denials, never the messages it
 * waved through. That is worth knowing when reading the trail: the router's
 * lines are the *exceptions*, and the successes are recorded by the layers that
 * did the work.
 */
export function routerTrailSink(
  trail: AuditTrail,
  node: string,
): RouterAuditSink {
  return (event: RouterAuditEvent): void => {
    const source =
      event.type === RouterEventType.CapabilityDenied
        ? AuditSource.Capability
        : AuditSource.Router
    const input: AuditInput = {
      at: event.at,
      source,
      kind: event.type,
      outcome: 'refused',
      node,
      ...(stringOf(event.detail, 'traceId') === undefined
        ? {}
        : { traceId: stringOf(event.detail, 'traceId') as string }),
      ...(stringOf(event.detail, 'taskId') === undefined
        ? {}
        : { taskId: stringOf(event.detail, 'taskId') as string }),
      ...(stringOf(event.detail, 'msgId') === undefined
        ? {}
        : { msgId: stringOf(event.detail, 'msgId') as string }),
      ...(stringOf(event.detail, 'from') === undefined
        ? {}
        : { peer: stringOf(event.detail, 'from') as string }),
      ...(stringOf(event.detail, 'code') === undefined
        ? {}
        : { code: stringOf(event.detail, 'code') as string }),
      detail: event.detail,
    }
    try {
      trail.append(input)
    } catch {
      // A trail that cannot be written must not take the node down with it.
      // The in-memory ring still has the event, and the next write will try
      // again; losing the node because its logbook is full would be a strictly
      // worse outcome than losing the line.
    }
  }
}

/** How each transport event answers "did this message go ahead". */
const TRANSPORT_OUTCOMES: Partial<
  Record<TransportEventType, 'ok' | 'refused' | 'dropped'>
> = {
  [TransportEventType.MessageAccepted]: 'ok',
  [TransportEventType.MessageRejected]: 'refused',
  // A retransmission the receiver absorbed. Recorded as `dropped` rather than
  // omitted: "why did the sender see two receipts" is unanswerable without it,
  // and P7.2's DoD names deduplicated messages explicitly.
  [TransportEventType.MessageDuplicate]: 'dropped',
}

/** Turn transport events into trail records. Only the message-level ones. */
export function transportTrailSink(
  trail: AuditTrail,
  node: string,
): TransportEventSink {
  return (event: TransportEvent): void => {
    const outcome = TRANSPORT_OUTCOMES[event.type]
    // Handshakes, keep-alives and reconnects stay in the transport's own ring:
    // the trail is for the life of a *message*, and a file that also carried
    // every keep-alive would bury the lines somebody is looking for.
    if (outcome === undefined) return
    const detail = event.detail as Record<string, unknown>
    const text = (key: string): string | undefined => {
      const value = detail[key]
      return typeof value === 'string' && value.length > 0 ? value : undefined
    }
    try {
      trail.append({
        at: event.at,
        source: AuditSource.Transport,
        kind: event.type,
        outcome,
        node,
        ...(text('traceId') === undefined
          ? {}
          : { traceId: text('traceId') as string }),
        ...(text('taskId') === undefined
          ? {}
          : { taskId: text('taskId') as string }),
        ...(text('msgId') === undefined
          ? {}
          : { msgId: text('msgId') as string }),
        ...(text('node') === undefined ? {} : { peer: text('node') as string }),
        ...(text('code') === undefined ? {} : { code: text('code') as string }),
        detail: event.detail,
      })
    } catch {
      // Same reason as the router sink: a full logbook must not stop the node.
    }
  }
}
