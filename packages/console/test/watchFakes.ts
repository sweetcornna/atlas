// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Hand-written stand-ins for the two ports of the alert and job pages, and a
 * console wired with them on top of `pageHarness`'s small network.
 *
 * Plain objects with counters, like every other suite here: "the store was
 * not touched" is an assertion about a count staying at zero.
 */

import type { ConsoleTokens } from '../src/auth.js'
import type {
  ActionLedgerPort,
  AlertAck,
  CertificatePort,
  ConsoleCaRoot,
  ConsoleDeps,
  ConsoleNotice,
  ConsoleResult,
  CertificateSnapshot,
  NoticeFeed,
  NotifyPort,
  SchedulerPort,
  SchedulerSnapshot,
} from '../src/deps.js'
import { createConsoleHandler } from '../src/http.js'
import {
  NOW,
  TOKENS,
  agentAt,
  pageHarness,
  type PageHarness,
} from './pageHarness.js'

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

/** One notice as `qm watch` would have recorded it. */
export function notice(
  id: string,
  level: ConsoleNotice['level'],
  summary: string,
  over: Partial<ConsoleNotice> = {},
): ConsoleNotice {
  return {
    id,
    at: NOW - 60_000,
    level,
    kind: 'watch',
    from: 'qianmo://tokyo-1/reviewer',
    job: 'disk-watch',
    summary,
    ...over,
  }
}

/** Notices and acknowledgements in memory, counting every write. */
export class MemoryNotify implements NotifyPort {
  list: readonly ConsoleNotice[]
  intact = true
  present = true
  /** Set to make `notices()` fail the way an unreadable trail would. */
  noticesFailure: ConsoleResult<NoticeFeed> | null = null
  /** Set to make `acks()` fail. */
  acksFailure: ConsoleResult<readonly AlertAck[]> | null = null
  readonly stored = new Map<string, AlertAck>()
  ackCalls = 0
  #clock: () => number

  constructor(notices: readonly ConsoleNotice[] = [], clock = () => NOW) {
    this.list = notices
    this.#clock = clock
  }

  notices(limit: number): Promise<ConsoleResult<NoticeFeed>> {
    if (this.noticesFailure !== null) {
      return Promise.resolve(this.noticesFailure)
    }
    return Promise.resolve(
      ok({
        notices: this.list.slice(0, limit),
        total: this.list.length,
        intact: this.intact,
        present: this.present,
      }),
    )
  }

  acks(): Promise<ConsoleResult<readonly AlertAck[]>> {
    if (this.acksFailure !== null) return Promise.resolve(this.acksFailure)
    return Promise.resolve(ok([...this.stored.values()]))
  }

  ack(id: string, by: string): Promise<ConsoleResult<AlertAck>> {
    this.ackCalls += 1
    const existing = this.stored.get(id)
    if (existing !== undefined) return Promise.resolve(ok(existing))
    const record: AlertAck = { id, at: this.#clock(), by }
    this.stored.set(id, record)
    return Promise.resolve(ok(record))
  }
}

/** A scheduler port that answers one snapshot, and counts the reads. */
export class FixedScheduler implements SchedulerPort {
  result: ConsoleResult<SchedulerSnapshot>
  reads = 0
  constructor(snapshot: SchedulerSnapshot) {
    this.result = ok(snapshot)
  }
  read(): Promise<ConsoleResult<SchedulerSnapshot>> {
    this.reads += 1
    return Promise.resolve(this.result)
  }
}

/** A certificate port with a fixed snapshot and roots. */
export function certificatesOf(
  snapshot: CertificateSnapshot,
  roots: readonly ConsoleCaRoot[] = [],
): CertificatePort {
  return {
    read: () => Promise.resolve(ok(snapshot)),
    roots: () => roots,
  }
}

/** A watch job snapshot in its ordinary state: one job, all wired but the tick. */
export function snapshotOf(
  over: Partial<SchedulerSnapshot> = {},
): SchedulerSnapshot {
  return {
    tick: {
      state: 'unwired',
      reason: 'qm watch 是独立进程 · 最后一次运行只在它的内存里',
    },
    estop: { state: 'released' },
    definitions: { state: 'wired', source: '/srv/watch/jobs.json' },
    jobs: [
      {
        id: 'disk-watch',
        title: '每十分钟看一次磁盘',
        target: 'qianmo://tokyo-1/reviewer',
        everyMs: 600_000,
        notifyPolicy: 'agent-initiated',
        listed: true,
        last: {
          at: NOW - 300_000,
          outcome: 'completed',
          recordedAt: NOW - 299_000,
        },
        consecutiveFailures: 0,
        next: NOW + 300_000,
        result: { at: NOW - 280_000, result: 'completed' },
      },
    ],
    ...over,
  }
}

/** `osaka-1/writer` with its lease long gone: the registry's 节点失联. */
export const LOST_OSAKA = agentAt('qianmo://osaka-1/writer', {
  lastHeartbeatAt: NOW - 400_000,
  expiresAt: NOW - 310_000,
})

export interface WatchConsole {
  readonly page: PageHarness
  readonly deps: ConsoleDeps
  readonly handle: (request: Request) => Promise<Response>
}

/** `pageHarness`, with whatever ports and ledger a test passes in. */
export function watchConsole(
  extra: Partial<ConsoleDeps> & { readonly actions?: ActionLedgerPort } = {},
  tokens: ConsoleTokens = TOKENS,
): WatchConsole {
  const page = pageHarness({ chat: true })
  const deps: ConsoleDeps = { ...page.deps, ...extra }
  return { page, deps, handle: createConsoleHandler(deps, tokens) }
}
