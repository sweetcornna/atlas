// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A failure while qm starts says so and exits non-zero (P18.12, follow-up
 * F5).
 *
 * A rejection out of the entry's top-level `main()` must never leave the
 * process silent and alive: a supervisor reads the silence as a run that has
 * not finished, or (after a kill) as one that has. `qm`'s entry catches it
 * here: `Error: <message>` on stderr — the error's own message, never a
 * stack — and exit 1.
 */

/** What the reader sees: the error's own message, never a stack. */
export function startupFailureMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error ?? 'unknown error')
  return `Error: ${message}`
}

export function exitOnStartupFailure(error: unknown): never {
  process.stderr.write(`${startupFailureMessage(error)}\n`)
  process.exit(1)
}
