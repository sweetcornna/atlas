// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which ACP session a piece of asynchronous work belongs to.
 *
 * An ACP process serves several sessions, one turn at a time
 * (`sessionWorkspace.ts`), but work a turn starts can outlive it: a
 * backgrounded command, an async subagent. When that work finishes it posts a
 * task notification to the base's command queue, which is one queue for the
 * whole process, and the next loop to drain it — whichever session's turn is
 * running then — used to receive it. Session B was handed session A's
 * background result, output-file path included (review E-8).
 *
 * The process-wide "current session" cannot answer this: by the time the work
 * finishes, it names whoever is running now. AsyncLocalStorage can, the same
 * way `agentContext.ts` and `workloadContext.ts` carry their own identities:
 * the scope entered around a turn is captured by every continuation the turn
 * creates, so a child process's exit handler registered during session A's
 * turn still reports A when it fires during session B's.
 *
 * Nothing sets a scope outside the ACP prompt path, so a REPL or print-mode
 * process sees `undefined` everywhere and the queue behaves as it always did.
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
