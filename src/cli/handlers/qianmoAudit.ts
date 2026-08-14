// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `occ audit` — the query CLI P7.2 asks for.
 *
 *   occ audit --trace <traceparent-or-segment>
 *   occ audit --agent qianmo://node-a/planner --from 2026-08-14T00:00:00Z
 *   occ audit --verify
 *
 * Three shapes on purpose, because they are the three questions people actually
 * bring: *what happened to this task*, *what has this agent been doing*, and
 * *is this trail still intact*.
 *
 * ## What it never prints
 *
 * Message payloads. The trail does not carry them (records hold ids, codes and
 * counts), and this command adds nothing — a support engineer pasting a chain
 * into a ticket should not have to redact it first.
 */

import {
  formatChain,
  queryTrail,
  readTrail,
  reconstructChain,
  type AuditRecord,
} from '@qianmo/audit'
import { auditTrailPath } from '../../services/qianmo/auditTrail.js'
import { residentOptionValue } from './residentArgs.js'

export interface QianmoAuditConfig {
  readonly path: string
  readonly trace?: string
  readonly agent?: string
  readonly task?: string
  readonly from?: number
  readonly to?: number
  readonly json: boolean
  readonly verify: boolean
  readonly limit: number
}

/** Accepts an ISO timestamp or raw epoch ms — both turn up in tickets. */
function parseInstant(raw: string, flag: string): number {
  if (/^\d+$/.test(raw)) return Number(raw)
  const parsed = Date.parse(raw)
  if (Number.isNaN(parsed)) {
    throw new Error(`${flag} must be an ISO timestamp or epoch milliseconds`)
  }
  return parsed
}

export function parseQianmoAuditArgs(
  args: readonly string[],
): QianmoAuditConfig {
  let path = auditTrailPath()
  let trace: string | undefined
  let agent: string | undefined
  let task: string | undefined
  let from: number | undefined
  let to: number | undefined
  let json = false
  let verify = false
  let limit = 200

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--path' || arg?.startsWith('--path=')) {
      const parsed = residentOptionValue(args, index, '--path')
      path = parsed.value
      index = parsed.next
    } else if (arg === '--trace' || arg?.startsWith('--trace=')) {
      const parsed = residentOptionValue(args, index, '--trace')
      trace = parsed.value
      index = parsed.next
    } else if (arg === '--agent' || arg?.startsWith('--agent=')) {
      const parsed = residentOptionValue(args, index, '--agent')
      agent = parsed.value
      index = parsed.next
    } else if (arg === '--task' || arg?.startsWith('--task=')) {
      const parsed = residentOptionValue(args, index, '--task')
      task = parsed.value
      index = parsed.next
    } else if (arg === '--from' || arg?.startsWith('--from=')) {
      const parsed = residentOptionValue(args, index, '--from')
      from = parseInstant(parsed.value, '--from')
      index = parsed.next
    } else if (arg === '--to' || arg?.startsWith('--to=')) {
      const parsed = residentOptionValue(args, index, '--to')
      to = parseInstant(parsed.value, '--to')
      index = parsed.next
    } else if (arg === '--limit' || arg?.startsWith('--limit=')) {
      const parsed = residentOptionValue(args, index, '--limit')
      const value = Number(parsed.value)
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--limit must be a positive integer')
      }
      limit = value
      index = parsed.next
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--verify') {
      verify = true
    } else {
      throw new Error(`unknown audit option ${String(arg)}`)
    }
  }

  if (
    !verify &&
    trace === undefined &&
    agent === undefined &&
    task === undefined &&
    from === undefined &&
    to === undefined
  ) {
    // Printing the whole trail by default would be the least useful thing this
    // command could do with a file that grows forever.
    throw new Error(
      'audit needs at least one of --trace / --agent / --task / --from / --to, or --verify',
    )
  }

  return {
    path,
    ...(trace === undefined ? {} : { trace }),
    ...(agent === undefined ? {} : { agent }),
    ...(task === undefined ? {} : { task }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    json,
    verify,
    limit,
  }
}

/** One line per record, for the non-chain queries. */
function formatRecord(record: AuditRecord): string {
  const mark =
    record.outcome === 'ok' ? ' ' : record.outcome === 'refused' ? '✗' : '·'
  return (
    `${mark} #${String(record.seq).padStart(4, '0')} ` +
    `${new Date(record.at).toISOString()} ${record.source}/${record.kind}` +
    `${record.code === undefined ? '' : ` [${record.code}]`}` +
    `${record.taskId === undefined ? '' : ` task=${record.taskId}`}`
  )
}

export function runQianmoAudit(args: readonly string[]): void {
  const config = parseQianmoAuditArgs(args)
  const { records, issues, intact } = readTrail(config.path)

  if (config.verify) {
    const summary = {
      path: config.path,
      records: records.length,
      intact,
      issues,
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    // A broken chain is a finding, and a command that reported it with exit 0
    // would be a command nobody could put in a cron job.
    process.exitCode = intact ? 0 : 1
    return
  }

  // Integrity is reported even when it was not asked for: reading a chain out
  // of a trail somebody has edited, and not saying so, is the one failure this
  // command must not have.
  if (!intact) {
    process.stderr.write(
      `warning: this trail has ${issues.length} integrity issue(s); run with --verify\n`,
    )
  }

  if (config.trace !== undefined) {
    const chain = reconstructChain(records, config.trace)
    if (chain === null) {
      process.stderr.write(`no records for trace ${config.trace}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(
      config.json
        ? `${JSON.stringify(chain, null, 2)}\n`
        : `${formatChain(chain)}\n`,
    )
    return
  }

  const matched = queryTrail(records, {
    ...(config.agent === undefined ? {} : { agent: config.agent }),
    ...(config.task === undefined ? {} : { taskId: config.task }),
    ...(config.from === undefined ? {} : { from: config.from }),
    ...(config.to === undefined ? {} : { to: config.to }),
  }).slice(-config.limit)

  if (config.json) {
    process.stdout.write(`${JSON.stringify(matched, null, 2)}\n`)
    return
  }
  if (matched.length === 0) {
    process.stdout.write('no records matched\n')
    return
  }
  process.stdout.write(`${matched.map(formatRecord).join('\n')}\n`)
}
