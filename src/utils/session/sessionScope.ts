// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which ACP session a piece of asynchronous work belongs to.
 *
 * An ACP process serves several sessions, one turn at a time
 * (`sessionWorkspace.ts`), but work a turn starts can outlive it: a
 * backgrounded command, an async subagent. Two process-wide pieces of the base
 * used to mix that work up between sessions (review E-8):
 *
 *   - the command queue: a finished task posts its notification there, and
 *     the next loop to drain it — whichever session's turn was running then —
 *     received it, output-file path included (`messageQueueManager.ts`);
 *   - the task output directory: memoised at first use, so every agent's
 *     output landed in the first agent's project temp directory, which that
 *     agent reads and lists without asking (`task/diskOutput.ts`).
 *
 * The process-wide "current session" cannot answer this: by the time the work
 * finishes, it names whoever is running now. AsyncLocalStorage can, the same
 * way `agentContext.ts` and `workloadContext.ts` carry their own identities:
 * the scope entered around a turn is captured by every continuation the turn
 * creates, so a child process's exit handler registered during session A's
 * turn still reports A when it fires during session B's.
 *
 * Nothing sets a scope outside the ACP prompt path, so a REPL or print-mode
 * process sees `undefined` everywhere and both behave as they always did.
 */

import { AsyncLocalStorage } from 'async_hooks'

const sessionScope = new AsyncLocalStorage<string>()

/**
 * Run `work` as part of session `sessionId`'s turn.
 *
 * Always a new boundary: a turn whose lock was handed over by the previous
 * turn's release starts inside that turn's context, and must not keep it.
 */
export function runInSessionScope<T>(sessionId: string, work: () => T): T {
  return sessionScope.run(sessionId, work)
}

/** The ACP session the calling work belongs to, if any. */
export function currentSessionScope(): string | undefined {
  return sessionScope.getStore()
}
