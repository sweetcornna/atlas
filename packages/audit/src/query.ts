// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Reading the trail back: by trace, by agent, by time window.
 *
 * The DoD's sentence is the specification: *"任取一次跨节点任务，用 trace_id 能
 * 还原完整消息链（含被丢弃、被限流、被去重的消息）"*. Two words in it do the
 * work:
 *
 * - **完整** — the reconstruction must include the refusals. A chain that shows
 *   only what succeeded is a chain that answers "what happened?" with "the
 *   parts that worked", which is the opposite of what an investigation needs.
 *   {@link reconstructChain} therefore never filters on outcome, and reports the
 *   refused and dropped counts as first-class numbers.
 * - **trace_id** — matching is on the **trace-id segment**, not the whole
 *   traceparent, because the parent-id changes at every hop by design (§7.1).
 *   Matching the full header would return exactly one hop of the chain and look
 *   like it worked.
 */

import { traceIdSegment, type AuditRecord, type AuditSource } from './record.js'

export interface TrailQuery {
  /** Full traceparent or bare trace-id segment; both match the same chain. */
  readonly traceId?: string
  readonly taskId?: string
  readonly msgId?: string
  /** Matches `node`, `peer`, or an address inside the detail. */
  readonly agent?: string
  readonly source?: AuditSource
  /** Inclusive lower bound, epoch ms. */
  readonly from?: number
  /** Inclusive upper bound, epoch ms. */
  readonly to?: number
  readonly outcome?: AuditRecord['outcome']
  /**
   * Free text: a case-insensitive substring of the kind, the trace, task and
   * message ids, the code, the node, the peer, the source or a string value
   * in the detail. What an operator types into one search box when they have
   * a fragment of an id from a ticket and do not know which field it is.
   */
  readonly text?: string
}

/** The fields {@link TrailQuery.text} looks in. */
function mentionsText(record: AuditRecord, needle: string): boolean {
  for (const value of [
    record.kind,
    record.traceId,
    record.taskId,
    record.msgId,
    record.code,
    record.node,
    record.peer,
    record.source,
  ]) {
    if (value !== undefined && value.toLowerCase().includes(needle)) {
      return true
    }
  }
  for (const value of Object.values(record.detail ?? {})) {
    if (typeof value === 'string' && value.toLowerCase().includes(needle)) {
      return true
    }
  }
  return false
}

function mentionsAgent(record: AuditRecord, agent: string): boolean {
  if (record.node === agent || record.peer === agent) return true
  for (const value of Object.values(record.detail ?? {})) {
    if (typeof value === 'string' && value === agent) return true
  }
  return false
}

/** The query as one predicate, with what can be worked out once worked out once. */
function matcherOf(query: TrailQuery): (record: AuditRecord) => boolean {
  const wantedTrace = traceIdSegment(query.traceId)
  const needle =
    query.text === undefined || query.text === ''
      ? null
      : query.text.toLowerCase()
  return record => {
    if (
      wantedTrace !== null &&
      traceIdSegment(record.traceId) !== wantedTrace
    ) {
      return false
    }
    if (query.taskId !== undefined && record.taskId !== query.taskId) {
      return false
    }
    if (query.msgId !== undefined && record.msgId !== query.msgId) return false
    if (query.source !== undefined && record.source !== query.source) {
      return false
    }
    if (query.outcome !== undefined && record.outcome !== query.outcome) {
      return false
    }
    if (query.from !== undefined && record.at < query.from) return false
    if (query.to !== undefined && record.at > query.to) return false
    if (query.agent !== undefined && !mentionsAgent(record, query.agent)) {
      return false
    }
    if (needle !== null && !mentionsText(record, needle)) return false
    return true
  }
}

/** Filter the trail. Every criterion is an AND; absent criteria match all. */
export function queryTrail(
  records: readonly AuditRecord[],
  query: TrailQuery,
): readonly AuditRecord[] {
  return records.filter(matcherOf(query))
}

/** Where a page of the trail starts and how long it is. */
export interface TrailCursor {
  /** Only records whose `seq` is below this: the page older than one already shown. */
  readonly before?: number
  /** Only records whose `seq` is above this: what arrived after a reader last looked. */
  readonly after?: number
  /** Records per page; anything below one is one. */
  readonly limit: number
  /**
   * The records' `seq` rises in array order (`TrailSnapshot.ordered`), so the
   * page can be found by `seq` instead of by looking at every record. Leave
   * it out for a trail that is out of order: the answer is the same, only
   * slower.
   */
  readonly ordered?: boolean
}

/** One page of the trail. */
export interface TrailPage {
  /** The newest matches under the cursor, at most `limit`, oldest first — file order. */
  readonly records: readonly AuditRecord[]
  /**
   * The `before` that fetches the next older page, or `null` when no match is
   * older than this page. Never a guess: it is set only after an older match
   * was actually found.
   */
  readonly earlier: number | null
}

/** The first index whose `seq` is not below `seq`, in an ordered trail. */
function firstAtOrAbove(records: readonly AuditRecord[], seq: number): number {
  let low = 0
  let high = records.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if ((records[middle]?.seq ?? 0) < seq) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * The newest page of the trail that matches `query` under `cursor`.
 *
 * Scanned from the newest record back, and stopped as soon as the page is
 * full and one older match has been seen. The first screen of an unfiltered
 * trail therefore costs `limit + 1` records whatever the length of the trail;
 * a narrow filter costs as far back as it has to look, and never more than
 * one pass. Walking the pages with `earlier` visits every match exactly once,
 * and lines appended meanwhile cannot shift a page: they are all above every
 * `before` already handed out.
 */
export function pageTrail(
  records: readonly AuditRecord[],
  query: TrailQuery,
  cursor: TrailCursor,
): TrailPage {
  const limit = Math.max(1, Math.floor(cursor.limit))
  const matches = matcherOf(query)
  const { before, after } = cursor
  const ordered = cursor.ordered === true
  let index = records.length - 1
  if (ordered && before !== undefined) {
    index = firstAtOrAbove(records, before) - 1
  }
  const page: AuditRecord[] = []
  let earlier: number | null = null
  for (; index >= 0; index--) {
    const record = records[index]
    if (record === undefined) continue
    if (after !== undefined && record.seq <= after) {
      if (ordered) break
      continue
    }
    if (before !== undefined && record.seq >= before) continue
    if (!matches(record)) continue
    if (page.length === limit) {
      earlier = page[page.length - 1]?.seq ?? null
      break
    }
    page.push(record)
  }
  page.reverse()
  return { records: page, earlier }
}

/** One reconstructed chain. */
export interface MessageChain {
  /** The trace-id segment this chain is keyed on. */
  readonly traceId: string
  readonly records: readonly AuditRecord[]
  /** Distinct `taskId`s seen, in first-appearance order. */
  readonly taskIds: readonly string[]
  /** Distinct `msgId`s seen — one per transmission, retries included. */
  readonly msgIds: readonly string[]
  readonly sources: readonly AuditSource[]
  readonly refused: number
  readonly dropped: number
  readonly firstAt: number
  readonly lastAt: number
}

/**
 * Rebuild one message chain from the trail.
 *
 * Ordered by `seq` rather than by `at`: two nodes' clocks disagree, and a
 * reconstruction sorted by timestamp can put an ack before the message it
 * answers. `seq` is this file's own order, which is the only total order that
 * exists here.
 */
export function reconstructChain(
  records: readonly AuditRecord[],
  traceId: string,
): MessageChain | null {
  const wanted = traceIdSegment(traceId)
  if (wanted === null) return null
  const matched = [...queryTrail(records, { traceId })].sort(
    (a, b) => a.seq - b.seq,
  )
  if (matched.length === 0) return null

  const taskIds: string[] = []
  const msgIds: string[] = []
  const sources: AuditSource[] = []
  let refused = 0
  let dropped = 0
  for (const record of matched) {
    if (record.taskId !== undefined && !taskIds.includes(record.taskId)) {
      taskIds.push(record.taskId)
    }
    if (record.msgId !== undefined && !msgIds.includes(record.msgId)) {
      msgIds.push(record.msgId)
    }
    if (!sources.includes(record.source)) sources.push(record.source)
    if (record.outcome === 'refused') refused += 1
    if (record.outcome === 'dropped') dropped += 1
  }

  return {
    traceId: wanted,
    records: matched,
    taskIds,
    msgIds,
    sources,
    refused,
    dropped,
    firstAt: matched[0]?.at ?? 0,
    lastAt: matched.at(-1)?.at ?? 0,
  }
}

/** One line per record, for a terminal. Never prints payload content. */
export function formatChain(chain: MessageChain): string {
  const lines = [
    `trace ${chain.traceId} — ${chain.records.length} records, ` +
      `${chain.refused} refused, ${chain.dropped} dropped, ` +
      `${chain.lastAt - chain.firstAt}ms end to end`,
  ]
  for (const record of chain.records) {
    const mark =
      record.outcome === 'ok' ? ' ' : record.outcome === 'refused' ? '✗' : '·'
    lines.push(
      `${mark} #${String(record.seq).padStart(4, '0')} ${record.source}/${record.kind}` +
        `${record.code === undefined ? '' : ` [${record.code}]`}` +
        `${record.msgId === undefined ? '' : ` msg=${record.msgId.slice(0, 8)}`}` +
        `${record.peer === undefined ? '' : ` peer=${record.peer}`}`,
    )
  }
  return lines.join('\n')
}
