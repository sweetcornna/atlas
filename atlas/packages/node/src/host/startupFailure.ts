// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A failure while the CLI starts says so and exits non-zero (P18.12,
 * follow-up F5).
 *
 * The entrypoint awaits `main()` at the top level. A rejection there became
 * an uncaught exception, and the global handler `gracefulShutdown.ts`
 * installs for observability logs it and returns — so the process neither
 * printed anything nor exited. `-p` sat until something killed it, and a
 * supervisor read the silence as a run that had not finished, or (after a
 * kill) as one that had. Measured: `CI=1` with no Anthropic key, `-p hello`
 * — `getCommands` → the `/login` command → `getAnthropicApiKeyWithSource`
 * throws; zero bytes on stdout and stderr, still alive after 45 s.
 *
 * Now the entrypoint catches it here: `Error: <message>` on stderr, exit 1,
 * through the existing `exitWithError`. An installed tree replaced under a
 * running process keeps its own handling — rethrown to the handler that
 * explains it.
 */
import { isInstallTreeReplacedError } from '../../utils/process/gracefulShutdown.js'
import { exitWithError } from '../../utils/process/process.js'

/** What the reader sees: the error's own message, never a stack. */
export function startupFailureMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error ?? 'unknown error')
  return `Error: ${message}`
}

export function exitOnStartupFailure(error: unknown): never {
  if (isInstallTreeReplacedError(error)) throw error
  exitWithError(startupFailureMessage(error))
}
