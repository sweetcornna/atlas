// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Getting an ACP process's last turn onto disk before it exits.
 *
 * The transcript writer does not append as it goes: entries wait in a queue
 * that a 100 ms timer drains (`Project.scheduleDrain`). The interactive CLI
 * drains it on the way out through `gracefulShutdown` → the cleanup registry.
 * `--acp` mode never installs that path — `entry.ts` handles its own signals —
 * and its handler went straight from closing sessions to `process.exit(0)`.
 * Whatever the turn that had just ended was still holding in the queue went
 * with it, and the next process to resume the session got it one answer short.
 *
 * That is every planned stop of a resident's child: node shutdown, a crash
 * restart, and a provider hot switch recycling the child (P18.3) — each sends
 * SIGTERM the moment the child is idle, which is the moment the queue is most
 * likely to hold the answer.
 *
 * Two properties this keeps, both about the resident that is waiting for the
 * child to go:
 *
 * - **Bounded.** A flush that does not finish (a full disk, a stalled network
 *   filesystem) must not turn a stop into a hang: past the budget the process
 *   exits anyway. The budget covers the whole shutdown, not only the flush.
 * - **Exit code 0, either way.** `QianmoResident` reads any other exit as a
 *   crash.
 *
 * And one about the triggers: SIGTERM, SIGINT and the connection closing all
 * run the same shutdown, and a stop often fires more than one of them. Only
 * the first runs it; a second one exiting immediately would cut the first one's
 * flush short, which is the same loss by another route.
 */
import { flushSessionStorage } from '../../utils/sessionStorage.js'

/** How long a stopping ACP process may spend on its way out. */
const EXIT_BUDGET_MS = 2_000

export interface AcpExitGate {
  /**
   * True for the first caller only, which owns the shutdown. Also starts the
   * budget: once it runs out the process exits whatever is still pending.
   */
  begin(): boolean
  /** Drain the transcript write queue. Never rejects. */
  flush(): Promise<void>
}

export function createAcpExitGate(
  options: {
    flush?: () => Promise<void>
    exit?: (code: number) => void
    budgetMs?: number
    log?: (line: string) => void
  } = {},
): AcpExitGate {
  const flush = options.flush ?? flushSessionStorage
  const exit = options.exit ?? (code => process.exit(code))
  const budgetMs = options.budgetMs ?? EXIT_BUDGET_MS
  const log = options.log ?? (line => console.error(line))
  let begun = false

  return {
    begin() {
      if (begun) return false
      begun = true
      // Not unref'd: this timer is the guarantee that the process goes, so it
      // must not depend on something else holding the event loop open.
      setTimeout(() => {
        log(
          `[ACP] shutdown did not finish within ${budgetMs}ms; exiting without waiting for it`,
        )
        exit(0)
      }, budgetMs)
      return true
    },
    async flush() {
      try {
        await flush()
      } catch (error) {
        log(`[ACP] Failed to flush the session transcript: ${String(error)}`)
      }
    },
  }
}
