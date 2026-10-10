// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AuditSource, type AuditRecord } from './record.js'

/** The console ledger has its own chain; callers verify it before joining. */
export interface AuthorizationAction {
  readonly at: number
  readonly requestId: string
  readonly subject: string
  readonly action: string
  readonly target: string
  readonly outcome: string
}

export interface AuthorizationRow {
  readonly requestId: string
  readonly node: string
  agent: string | null
  contextId: string | null
  from: string | null
  taskId: string | null
  traceId: string | null
  trust: string | null
  tool: string | null
  digest: string | null
  status: string
  approver: string | null
  readonly approverAuthority: 'console-backed'
  requestedAt: number | null
  decidedAt: number | null
  decisionLatencyMs: number | null
  scope: string | null
  expiresAt: number | null
  usedAt: number | null
  refusals: number
  actions: readonly AuthorizationAction[]
}

/** No tool input, free-form detail or unrelated console actions leave this projection. */
export function buildAuthorizationReport(
  records: readonly AuditRecord[],
  actions: readonly AuthorizationAction[] = [],
) {
  const rows = new Map<string, AuthorizationRow>()
  const postures = new Map<string, Record<string, string | number | boolean>>()
  const string = (v: unknown) => (typeof v === 'string' ? v : null)
  const number = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  for (const record of records) {
    if (
      record.source !== AuditSource.Capability ||
      !record.kind.startsWith('authz.')
    )
      continue
    const node = record.node ?? 'unknown'
    const detail = record.detail ?? {}
    if (record.kind === 'authz.posture') {
      const posture: Record<string, string | number | boolean> = {
        at: record.at,
      }
      for (const key of [
        'mode',
        'allowWorkspaceEdits',
        'policy',
        'trustSet',
        'approverSet',
        'safeMode',
        'managedHook',
        'remoteEmbedding',
      ]) {
        if (detail[key] !== undefined) posture[key] = detail[key]!
      }
      postures.set(node, posture)
      continue
    }
    const requestId = string(detail['requestId'])
    if (!requestId) continue
    const key = JSON.stringify([node, requestId])
    let row = rows.get(key)
    if (!row) {
      row = {
        requestId,
        node,
        agent: null,
        contextId: null,
        from: null,
        taskId: null,
        traceId: null,
        trust: null,
        tool: null,
        digest: null,
        status: 'unknown',
        approver: null,
        approverAuthority: 'console-backed',
        requestedAt: null,
        decidedAt: null,
        decisionLatencyMs: null,
        scope: null,
        expiresAt: null,
        usedAt: null,
        refusals: 0,
        actions: [],
      }
      rows.set(key, row)
    }
    for (const field of [
      'agent',
      'contextId',
      'from',
      'trust',
      'tool',
      'approver',
      'scope',
    ] as const)
      row[field] = string(detail[field]) ?? row[field]
    row.taskId = record.taskId ?? row.taskId
    row.traceId = record.traceId ?? row.traceId
    row.digest = string(detail['digest'])?.slice(0, 12) ?? row.digest
    row.expiresAt = number(detail['expiresAt']) ?? row.expiresAt
    const kind = record.kind.slice('authz.'.length)
    if (kind === 'requested' || kind === 'asked') {
      row.requestedAt ??= record.at
      if (row.status === 'unknown') row.status = 'pending'
    } else if (
      kind === 'decision' ||
      kind === 'approved' ||
      kind === 'denied'
    ) {
      row.status = string(detail['status']) ?? kind
      row.decidedAt ??= record.at
    } else if (kind === 'grant_used') {
      row.usedAt = record.at
      row.status = 'used'
    } else if (kind === 'revoked' || kind === 'expired') row.status = kind
    if (kind === 'refused' || kind === 'hardline_denied') row.refusals++
  }
  // request IDs are globally random, but refuse an ambiguous node join anyway.
  const counts = new Map<string, number>()
  for (const row of rows.values())
    counts.set(row.requestId, (counts.get(row.requestId) ?? 0) + 1)
  for (const row of rows.values()) {
    if (row.requestedAt !== null && row.decidedAt !== null)
      row.decisionLatencyMs = Math.max(0, row.decidedAt - row.requestedAt)
    if (counts.get(row.requestId) === 1)
      row.actions = actions
        .filter(
          action =>
            action.target === row.requestId &&
            (action.action === 'approval.decide' ||
              action.action === 'approval.revoke'),
        )
        .map(action => ({
          at: action.at,
          requestId: action.requestId,
          subject: action.subject,
          action: action.action,
          target: action.target,
          outcome: action.outcome,
        }))
  }
  const summary = new Map<
    string,
    {
      node: string
      requests: number
      used: number
      refused: number
      pending: number
    }
  >()
  for (const row of rows.values()) {
    const entry = summary.get(row.node) ?? {
      node: row.node,
      requests: 0,
      used: 0,
      refused: 0,
      pending: 0,
    }
    entry.requests++
    if (row.usedAt !== null) entry.used++
    entry.refused += row.refusals
    if (row.status === 'pending') entry.pending++
    summary.set(row.node, entry)
  }
  return {
    rows: [...rows.values()],
    summary: [...summary.values()],
    postures: [...postures].map(
      ([node, posture]): {
        node: string
        [key: string]: string | number | boolean
      } => ({ node, ...posture }),
    ),
  }
}
