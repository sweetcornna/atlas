// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The action ledger in memory: what the console's tests write against until
 * P15.9's hash-chained one exists, and a working statement of what `list`
 * is expected to answer (`deps.ts`, `ActionLedgerPort`).
 */

import type {
  ActionLedgerPort,
  ActionPage,
  ActionQuery,
  ActionRecord,
  ConsoleAction,
  ConsoleResult,
} from '../src/deps.js'

const OK: ConsoleResult<void> = { ok: true, value: undefined }

/** The page size when a query names none, and the most one page may hold. */
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

export class MemoryActionLedger implements ActionLedgerPort {
  readonly entries: ActionRecord[] = []
  /** What `admit` answers; set a failure to close the ledger. */
  admitResult: ConsoleResult<void> = OK
  /** What `record` answers; a failure records nothing. */
  recordResult: ConsoleResult<void> = OK
  admitCalls = 0

  admit(): Promise<ConsoleResult<void>> {
    this.admitCalls += 1
    return Promise.resolve(this.admitResult)
  }

  record(entry: ConsoleAction): Promise<ConsoleResult<void>> {
    if (!this.recordResult.ok) return Promise.resolve(this.recordResult)
    this.entries.push({ ...entry, seq: this.entries.length + 1 })
    return Promise.resolve(OK)
  }

  list(query: ActionQuery): Promise<ConsoleResult<ActionPage>> {
    const limit = Math.min(
      Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)),
      MAX_LIMIT,
    )
    const matching = this.entries
      .filter(
        entry =>
          (query.subject === undefined || entry.subject === query.subject) &&
          (query.targets === undefined ||
            query.targets.includes(entry.target)) &&
          (query.actionPrefix === undefined ||
            entry.action.startsWith(query.actionPrefix)) &&
          (query.beforeSeq === undefined || entry.seq < query.beforeSeq),
      )
      .reverse()
    const entries = matching.slice(0, limit)
    const last = entries[entries.length - 1]
    return Promise.resolve({
      ok: true,
      value: {
        entries,
        nextBeforeSeq:
          matching.length > limit && last !== undefined ? last.seq : null,
      },
    })
  }

  /** The entries as `action target outcome`, the shape most assertions read. */
  lines(): readonly string[] {
    return this.entries.map(
      entry =>
        `${entry.action} ${entry.target} ${entry.outcome}${
          entry.code === undefined ? '' : ` ${entry.code}`
        }`,
    )
  }
}
