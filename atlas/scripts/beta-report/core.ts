// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AuditRecord } from '@qianmo/audit'

export interface Probe {
  t: string
  node: string
  probe: string
  ok: boolean
  ms: number
  detail: string
}
export interface Timing {
  node: string
  stage: string
  at: number
  networkMsgId?: string
}
export interface Window {
  from: number
  to: number
  bucketMs: number
  workerNodes: string[]
  lanes: { node: string; probe: string; intervalMs: number }[]
}

export function validateWindow(w: Window): void {
  if (
    !Number.isSafeInteger(w.from) ||
    !Number.isSafeInteger(w.to) ||
    w.to <= w.from ||
    !Number.isSafeInteger(w.bucketMs) ||
    w.bucketMs <= 0 ||
    (w.to - w.from) / w.bucketMs > 10000 ||
    !Array.isArray(w.workerNodes) ||
    !w.workerNodes.length ||
    w.workerNodes.some(n => typeof n !== 'string' || !n) ||
    new Set(w.workerNodes).size !== w.workerNodes.length ||
    !Array.isArray(w.lanes) ||
    !w.lanes.length
  )
    throw new Error('invalid measurement window/cohort')
  const keys = new Set<string>()
  for (const lane of w.lanes) {
    const key = JSON.stringify([lane.node, lane.probe])
    if (
      !lane.node ||
      !lane.probe ||
      keys.has(key) ||
      !Number.isSafeInteger(lane.intervalMs) ||
      lane.intervalMs <= 0 ||
      (w.to - w.from) / lane.intervalMs > 1000000
    )
      throw new Error('invalid/duplicate sampling lane')
    keys.add(key)
  }
}

const applicationTypes = new Set([
  'task.request',
  'task.result',
  'wake',
  'notify',
  'resource.request',
  'resource.offer',
  'resource.grant',
  'resource.release',
])
const controlTypes = new Set([
  'ack',
  'ping',
  'pong',
  'error',
  'authz.request',
  'authz.decision',
  'authz.revoke',
])
const nodeOf = (address: unknown) =>
  typeof address === 'string'
    ? /^qianmo:\/\/([^/]+)\/[^/]+$/.exec(address)?.[1]
    : undefined
const quantile = (values: number[], q: number): number | 'infinite' | null => {
  if (!values.length) return null
  const value = [...values].sort((a, b) => a - b)[
    Math.ceil(values.length * q) - 1
  ]!
  return Number.isFinite(value) ? value : 'infinite'
}

/** Read-only statistics. Missing samples and metadata never manufacture a pass. */
export function betaReport(
  w: Window,
  probes: Probe[],
  timings: Timing[],
  records: readonly AuditRecord[],
) {
  validateWindow(w)
  for (const p of probes)
    if (
      !Number.isFinite(Date.parse(p.t)) ||
      typeof p.node !== 'string' ||
      typeof p.probe !== 'string' ||
      typeof p.ok !== 'boolean' ||
      !Number.isSafeInteger(p.ms) ||
      p.ms < 0 ||
      typeof p.detail !== 'string'
    )
      throw new Error('invalid probe sample')
  for (const t of timings)
    if (
      !Number.isSafeInteger(t.at) ||
      typeof t.stage !== 'string' ||
      !t.node ||
      (t.networkMsgId !== undefined && typeof t.networkMsgId !== 'string')
    )
      throw new Error('invalid timing sample')
  const inside = (at: number) => at >= w.from && at < w.to
  const sampled = probes.filter(p => inside(Date.parse(p.t)))
  const availability = w.lanes.map(lane => {
    const expected = Math.ceil((w.to - w.from) / lane.intervalMs)
    const slots = new Map<number, boolean>()
    let duplicates = 0
    for (const p of sampled.filter(
      p => p.node === lane.node && p.probe === lane.probe,
    )) {
      const slot = Math.floor((Date.parse(p.t) - w.from) / lane.intervalMs)
      if (slots.has(slot)) duplicates++
      // A failed retry in a slot must not disappear behind a later success.
      slots.set(
        slot,
        (slots.get(slot) ?? true) && p.ok && !p.detail.startsWith('skipped:'),
      )
    }
    const success = [...slots.values()].filter(Boolean).length
    return {
      ...lane,
      expected,
      observed: slots.size,
      success,
      failed: slots.size - success,
      missing: expected - slots.size,
      duplicates,
      coverage: slots.size / expected,
      availability: success / expected,
    }
  })

  const wakeProbes = sampled.filter(p => p.probe === 'wake')
  // Include probes outside the report window when excluding their later replies.
  const probeIds = new Set(
    probes
      .filter(p => p.probe === 'wake')
      .flatMap(p => /(?:^|\s)msgId=([^\s]+)/.exec(p.detail)?.[1] ?? []),
  )
  const excludedTasks = new Set(
    records
      .filter(r => r.msgId && probeIds.has(r.msgId))
      .flatMap(r => r.taskId ?? []),
  )
  const wake = wakeProbes.map(p => {
    const msgId = /(?:^|\s)msgId=([^\s]+)/.exec(p.detail)?.[1]
    const startLower = Date.parse(p.t) - p.ms
    const matches =
      p.ok && msgId
        ? timings.filter(
            t =>
              t.node === p.node &&
              t.networkMsgId === msgId &&
              t.stage === 'first_content',
          )
        : []
    const first = matches.length
      ? Math.min(...matches.map(t => t.at))
      : undefined
    const upper = first === undefined ? undefined : first - startLower
    // Legacy probe t is floored to a second, so this is a conservative upper bound.
    return {
      node: p.node,
      at: p.t,
      msgId: msgId ?? null,
      accepted: p.ok,
      status: !p.ok
        ? 'request-failed'
        : first === undefined
          ? 'missing-content'
          : upper! < 0
            ? 'clock-invalid'
            : 'observed',
      latencyLowerMs:
        upper === undefined || upper < 0 ? null : Math.max(0, upper - 999),
      latencyUpperMs: upper === undefined || upper < 0 ? null : upper,
    }
  })
  const wakeLanes = w.lanes.filter(l => l.probe === 'wake')
  const wakeSlots = wakeLanes.flatMap(lane =>
    Array.from(
      { length: Math.ceil((w.to - w.from) / lane.intervalMs) },
      (_, i) => ({
        node: lane.node,
        from: w.from + i * lane.intervalMs,
        to: Math.min(w.to, w.from + (i + 1) * lane.intervalMs),
        observed: 0,
        latencyUpperMs: null as number | null,
      }),
    ),
  )
  const observedWakeIds = new Set<string>()
  let duplicateWakeSamples = 0,
    unplannedWakeSamples = 0
  for (const p of [...wake].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  )) {
    const key = p.msgId ? JSON.stringify([p.node, p.msgId]) : undefined
    if (key && observedWakeIds.has(key)) {
      duplicateWakeSamples++
      continue
    }
    if (key) observedWakeIds.add(key)
    const at = Date.parse(p.at),
      slot = wakeSlots.find(s => s.node === p.node && at >= s.from && at < s.to)
    if (!slot) {
      unplannedWakeSamples++
      continue
    }
    if (slot.observed === 0) slot.latencyUpperMs = p.latencyUpperMs
    else if (slot.latencyUpperMs === null || p.latencyUpperMs === null)
      slot.latencyUpperMs = null
    else slot.latencyUpperMs = Math.max(slot.latencyUpperMs, p.latencyUpperMs)
    slot.observed++
  }
  const latencies = wakeSlots.map(
    p => p.latencyUpperMs ?? Number.POSITIVE_INFINITY,
  )

  const buckets = Array.from(
    { length: Math.ceil((w.to - w.from) / w.bucketMs) },
    (_, i) => ({
      from: w.from + i * w.bucketMs,
      to: Math.min(w.to, w.from + (i + 1) * w.bucketMs),
      total: 0,
      collaboration: 0,
      control: 0,
      probes: 0,
      unknown: 0,
    }),
  )
  const seen = new Map<
    string,
    { at: number; fingerprint: string; record: AuditRecord }
  >()
  let duplicateMessages = 0
  for (const r of records) {
    if (
      r.source !== 'transport' ||
      r.kind !== 'message_accepted' ||
      r.outcome !== 'ok' ||
      !r.msgId
    )
      continue
    // Receipt-level transport events have no task ID; they are not envelopes.
    if (!r.taskId) continue
    const fingerprint = JSON.stringify([
      r.taskId,
      r.detail?.messageType,
      r.detail?.from,
      r.detail?.to,
    ])
    const old = seen.get(r.msgId)
    if (old) {
      duplicateMessages++
      if (old.fingerprint !== fingerprint)
        throw new Error('conflicting accepted-message metadata')
      if (r.at < old.at) seen.set(r.msgId, { at: r.at, fingerprint, record: r })
    } else seen.set(r.msgId, { at: r.at, fingerprint, record: r })
  }
  const workers = new Set(w.workerNodes)
  const messages: {
    msgId: string
    taskId: string
    at: number
    classification: string
  }[] = []
  for (const [msgId, { at, record: r }] of seen) {
    if (!inside(at)) continue
    const b = buckets[Math.floor((at - w.from) / w.bucketMs)]!
    const type = r.detail?.messageType
    let classification: string
    if (probeIds.has(msgId) || excludedTasks.has(r.taskId!)) {
      b.probes++
      classification = 'probe'
    } else if (typeof type === 'string' && controlTypes.has(type)) {
      b.control++
      classification = 'control'
    } else {
      const from = nodeOf(r.detail?.from),
        to = nodeOf(r.detail?.to)
      if (
        typeof type !== 'string' ||
        !applicationTypes.has(type) ||
        !from ||
        !to
      ) {
        b.unknown++
        classification = 'unknown'
      } else {
        b.total++
        const collaborative =
          from !== to && workers.has(from) && workers.has(to)
        if (collaborative) b.collaboration++
        classification = collaborative ? 'collaboration' : 'application'
      }
    }
    messages.push({ msgId, taskId: r.taskId!, at, classification })
  }
  const trend = buckets.map(b => ({
    ...b,
    ratio: b.total ? b.collaboration / b.total : null,
    evaluable: b.total > 0 && b.unknown === 0,
  }))
  return {
    schemaVersion: 1,
    window: w,
    availability,
    wake: {
      samples: wake,
      slots: wakeSlots,
      count: wakeSlots.length,
      sampleCount: wake.length,
      duplicateWakeSamples,
      unplannedWakeSamples,
      missing: wakeSlots.filter(s => s.observed === 0).length,
      p50UpperMs: quantile(latencies, 0.5),
      p95UpperMs: quantile(latencies, 0.95),
      timestampPrecisionMs: 1000,
      evaluable:
        wakeSlots.length > 0 &&
        unplannedWakeSamples === 0 &&
        wakeSlots.every(p => p.latencyUpperMs !== null),
    },
    collaboration: {
      trend,
      duplicateMessages,
      messages,
      continuouslyRising:
        trend.length >= 3 && trend.every(b => b.evaluable)
          ? trend.slice(1).every((b, i) => b.ratio! > trend[i]!.ratio!)
          : null,
    },
    limitations: [
      'Operator-selected cohort and sampling window must be fixed before the run.',
      'Hash-chain integrity does not prove collection completeness or replace off-host witnesses.',
      'Wake wall-clock differences require synchronized clocks; legacy probe timestamps have 1 second precision.',
      'No samples, old metadata, missing periods or a local fixture cannot establish a production SLA.',
    ],
  }
}
