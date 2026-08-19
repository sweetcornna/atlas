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
import {
  ActivatorEventType,
  type AuditEvent as ActivatorAuditEvent,
} from '@qianmo/activator'
import {
  NegotiationEventType,
  type NegotiationAuditSink,
  type NegotiationEvent,
} from '@qianmo/negotiation'
import {
  TunnelEventType,
  type TunnelAuditSink,
  type TunnelEvent,
} from '@qianmo/tunnel'
import {
  BackupEventType,
  type BackupAuditEvent,
  type BackupAuditSink,
} from '@qianmo/backup'
import {
  CapacityEventType,
  type CapacityAuditSink,
  type CapacityEvent,
} from '@qianmo/capacity'
import {
  ResidentNotifyEventType,
  type ResidentNotifyAuditSink,
  type ResidentNotifyEvent,
} from '@qianmo/resident'
import { occConfigPath } from '../../config/paths.js'

/** Default location of this node's trail, derived from the config root. */
export function auditTrailPath(): string {
  return occConfigPath('qianmo', 'audit', 'trail.ndjson')
}

/** Open (or resume) the node's trail. */
export function openAuditTrail(path: string = auditTrailPath()): AuditTrail {
  return new AuditTrail(path)
}

/** One layer's event, as every one of them happens to be shaped. */
interface LayerEvent {
  readonly type: string
  readonly at: number
  readonly detail: Readonly<Record<string, string | number | boolean>>
}

function stringOf(
  detail: LayerEvent['detail'],
  key: string,
): string | undefined {
  const value = detail[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The shared translation: correlation keys out of the detail, the layer's own
 * event name through unchanged, and the caller's verdict on the outcome.
 *
 * Every layer names its peer differently — `from`, `borrower`, `sandboxName` —
 * so the peer key is a parameter rather than a guess. Guessing would put the
 * wrong address on an audit line, which is worse than leaving it empty.
 */
function toRecord(
  event: LayerEvent,
  source: AuditSource,
  node: string,
  outcome: AuditInput['outcome'],
  peerKeys: readonly string[] = ['from'],
): AuditInput {
  const peer = peerKeys
    .map(key => stringOf(event.detail, key))
    .find(value => value !== undefined)
  return {
    at: event.at,
    source,
    kind: event.type,
    outcome,
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
    ...(peer === undefined ? {} : { peer }),
    ...(stringOf(event.detail, 'code') === undefined
      ? {}
      : { code: stringOf(event.detail, 'code') as string }),
    detail: event.detail,
  }
}

/** Append without letting a full or unwritable logbook stop the node. */
function safeAppend(trail: AuditTrail, input: AuditInput): void {
  try {
    trail.append(input)
  } catch {
    // The layer's own ring still has the event, and the next write will try
    // again. Losing the node because its logbook is full would be a strictly
    // worse outcome than losing the line.
  }
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
    safeAppend(trail, toRecord(event, source, node, 'refused'))
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
    safeAppend(
      trail,
      toRecord(
        { type: event.type, at: event.at, detail: event.detail },
        AuditSource.Transport,
        node,
        outcome,
        // The transport calls the other end `node`.
        ['node'],
      ),
    )
  }
}

/**
 * The remaining four layers.
 *
 * Each maps its own refusal events onto `refused` and everything else onto
 * `ok`; the one exception is a lease or route that lapsed on a timer, which is
 * `dropped` — nobody refused it, it simply ran out, and an audit that called
 * that a refusal would send the reader looking for a decision nobody made.
 */
export function activatorTrailSink(
  trail: AuditTrail,
  node: string,
): (event: ActivatorAuditEvent) => void {
  const refusals: ReadonlySet<ActivatorEventType> = new Set([
    ActivatorEventType.RequestRefused,
    ActivatorEventType.RequestFailed,
    ActivatorEventType.CapabilityDenied,
    ActivatorEventType.TaskReplyRejected,
  ])
  const lapses: ReadonlySet<ActivatorEventType> = new Set([
    ActivatorEventType.TaskRouteExpired,
    ActivatorEventType.JournalTorn,
  ])
  return (event: ActivatorAuditEvent): void => {
    const outcome = refusals.has(event.type)
      ? 'refused'
      : lapses.has(event.type)
        ? 'dropped'
        : 'ok'
    safeAppend(
      trail,
      toRecord(event, AuditSource.Activator, node, outcome, [
        'from',
        'sandboxName',
      ]),
    )
  }
}

export function negotiationTrailSink(
  trail: AuditTrail,
  node: string,
): NegotiationAuditSink {
  return (event: NegotiationEvent): void => {
    const outcome =
      event.type === NegotiationEventType.Refused ? 'refused' : 'ok'
    safeAppend(
      trail,
      toRecord(event, AuditSource.Negotiation, node, outcome, [
        'borrower',
        'lender',
      ]),
    )
  }
}

export function tunnelTrailSink(
  trail: AuditTrail,
  node: string,
): TunnelAuditSink {
  return (event: TunnelEvent): void => {
    const outcome = event.type === TunnelEventType.Refused ? 'refused' : 'ok'
    safeAppend(
      trail,
      toRecord(event, AuditSource.Tunnel, node, outcome, ['borrower', 'from']),
    )
  }
}

/**
 * The capacity planner's decisions.
 *
 * A suppressed trigger is `dropped`, not `refused` — same distinction the
 * activator's expired routes get, and for the same reason: **no one refused
 * it, it was simply held back by a rule** (the cooldown had not lapsed, or the
 * calendar path had already bought capacity for that window). Filing it as a
 * refusal would send a reader looking for a decision nobody made.
 */
const CAPACITY_DROPPED: ReadonlySet<CapacityEventType> = new Set([
  CapacityEventType.Suppressed,
])

export function capacityTrailSink(
  trail: AuditTrail,
  node: string,
): CapacityAuditSink {
  return (event: CapacityEvent): void => {
    safeAppend(
      trail,
      toRecord(
        event,
        AuditSource.Capacity,
        node,
        CAPACITY_DROPPED.has(event.type) ? 'dropped' : 'ok',
        // The other end of a scale-up is whoever ends up lending the room.
        // Empty until an executor that provisions exists (charter N-7).
        ['lender'],
      ),
    )
  }
}

export function backupTrailSink(
  trail: AuditTrail,
  node: string,
): BackupAuditSink {
  const refusals: ReadonlySet<BackupEventType> = new Set([
    BackupEventType.MutationDenied,
    BackupEventType.ReadDenied,
    BackupEventType.AccessDenied,
  ])
  return (event: BackupAuditEvent): void => {
    safeAppend(
      trail,
      toRecord(
        event,
        AuditSource.Backup,
        node,
        refusals.has(event.type) ? 'refused' : 'ok',
        ['workspace'],
      ),
    )
  }
}

/**
 * Outbound `notify` (P13.6), the only layer whose **successes** are the point.
 *
 * Every other sink here files a refusal or a delivery of somebody else's
 * traffic. This one files the evidence a watch job exists to produce: that at
 * 03:14 this node told a person something, and that the console receipted it.
 * A trail without those lines cannot answer "did anyone actually get told",
 * which is the only question asked of an unattended run after the fact.
 *
 * Three outcomes, and the middle one is why `outcome` is three-valued:
 * `refused` is a peer saying no (it does not implement the type), while a
 * notification merely *held* — no channel, or the sliding window shut — is
 * `dropped`, because nobody refused it and nothing is wrong. Filing a hold as
 * a refusal would send a reader looking for a decision that was never made.
 *
 * The `schemaVersion` the notifier stamps rides through in `detail` untouched
 * (hermes B9): three days from now, a record missing a field has to be
 * separable from a record that was edited, and the hash chain alone cannot
 * tell those apart.
 */
const NOTIFY_OUTCOMES: Readonly<
  Record<ResidentNotifyEventType, 'ok' | 'refused' | 'dropped'>
> = {
  [ResidentNotifyEventType.Sent]: 'ok',
  [ResidentNotifyEventType.Delivered]: 'ok',
  [ResidentNotifyEventType.Held]: 'dropped',
  [ResidentNotifyEventType.Suppressed]: 'dropped',
  [ResidentNotifyEventType.Unsupported]: 'refused',
  [ResidentNotifyEventType.Abandoned]: 'dropped',
}

export function residentNotifyTrailSink(
  trail: AuditTrail,
  node: string,
): ResidentNotifyAuditSink {
  return (event: ResidentNotifyEvent): void => {
    safeAppend(
      trail,
      toRecord(
        event,
        AuditSource.Resident,
        node,
        NOTIFY_OUTCOMES[event.type] ?? 'ok',
        // The other end of a notification is whoever the node is telling.
        ['peer'],
      ),
    )
  }
}
