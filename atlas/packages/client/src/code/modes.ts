// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The four permission modes of a local session (qmo-local.md §4.4) and what
 * each agent calls them. Each mode is said in the agent's own setting; where
 * an agent has none, the runner answers its questions by the mode instead
 * (P37.14b, c). This version drives Claude Code only.
 */

export const MODES = ['off', 'accept-edits', 'auto', 'full-access'] as const

export type Mode = (typeof MODES)[number]

/** The default: 「自动审批」 (owner, 10-24). */
export const DEFAULT_MODE: Mode = 'auto'

export function isMode(value: unknown): value is Mode {
  return MODES.some(mode => mode === value)
}

/** Claude Code's `--permission-mode` for each mode. */
export const CLAUDE_MODES: Readonly<Record<Mode, string>> = {
  off: 'default',
  'accept-edits': 'acceptEdits',
  auto: 'auto',
  'full-access': 'bypassPermissions',
}
