// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { buildAuthorizationReport, type AuditRecord } from '@qianmo/audit'
import type { RouteContext } from './types.js'

/** Bounded verified trail projection. Summary readers never receive context or arguments. */
export async function approvalReport(ctx: RouteContext) {
  const records: AuditRecord[] = []
  const sources: { node: string; integrity: string; truncated: boolean }[] = []
  for (const source of ctx.deps.audits ?? []) {
    const result = await source.audit.read({ limit: 500 })
    if (!result.ok) {
      sources.push({
        node: source.node,
        integrity: 'unavailable',
        truncated: false,
      })
      continue
    }
    const page = result.value
    sources.push({
      node: source.node,
      integrity: page.witness?.tampered === true ? 'tampered' : page.chain,
      truncated: page.earlier != null,
    })
    if (
      page.intact &&
      page.witness?.tampered !== true &&
      (page.chain === 'intact' || page.chain === 'empty')
    )
      records.push(
        ...page.records.filter(record => record.node === source.node),
      )
  }
  const principal = ctx.access.principal
  const detailed = principal?.kind === 'user' && principal.role !== 'viewer'
  const report = buildAuthorizationReport(records)
  if (!detailed)
    return { sources, summary: report.summary, window: 'latest-500-per-node' }
  const rows =
    principal.role === 'ops'
      ? report.rows
      : report.rows.filter(
          row =>
            row.contextId !== null &&
            ctx.accounts?.book.ownerOf(row.contextId) === principal.subject,
        )
  return { sources, rows, window: 'latest-500-per-node' }
}
