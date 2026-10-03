// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Hand-written stand-ins for the ports of the job page, and a console wired
 * with them on top of `pageHarness`'s small network.
 *
 * Plain objects with counters, like every other suite here: "the store was
 * not touched" is an assertion about a count staying at zero.
 */

import type { ConsoleTokens } from '../src/auth.js'
import type {
  ActionLedgerPort,
  ConsoleDeps,
  ConsoleResult,
  SchedulerPort,
  SchedulerSnapshot,
} from '../src/deps.js'
import { createConsoleHandler } from '../src/http.js'
import { NOW, TOKENS, pageHarness, type PageHarness } from './pageHarness.js'

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
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
