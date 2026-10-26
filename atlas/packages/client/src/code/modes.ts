// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The four permission modes of a local session (qmo-local.md §4.4) and what
 * each agent calls them. Each mode is said in the agent's own setting; where
 * an agent has none, the runner answers its questions by the mode instead
 * (P37.14b, c). This version drives Claude Code, Codex and the ACP agents.
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

/** What a Codex thread is opened with in a mode (§4.4). */
export interface CodexPolicy {
  /** `thread/start`'s `approvalPolicy`. */
  readonly approvalPolicy: 'untrusted' | 'on-request' | 'never'
  /** `thread/start`'s `sandbox`. */
  readonly sandbox: 'workspace-write' | 'danger-full-access'
  /** Its approvals must reach the person (`approvalsReviewer: 'user'`). */
  readonly reviewer: boolean
}

/**
 * Codex's own settings for each mode. 「自动接受编辑」 is 「人工确认」's, and
 * the runner answers `accept` to an edit inside the session's folder.
 */
export const CODEX_MODES: Readonly<Record<Mode, CodexPolicy>> = {
  off: {
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
    reviewer: true,
  },
  'accept-edits': {
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
    reviewer: true,
  },
  auto: {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    reviewer: false,
  },
  'full-access': {
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    reviewer: false,
  },
}

/**
 * The ACP mode ids of Gemini CLI and Qwen Code for each mode (§4.4), matched
 * against the ids their `session/new` answer offers (Gemini CLI 0.64 says
 * `autoEdit`, Qwen Code is expected to say `auto-edit`; either is taken).
 * Neither has a tier between edits and `yolo` with a safety net, so `auto`
 * is `accept-edits`: commands are still asked. opencode and dsh have no
 * permission modes (opencode's ACP modes are its agents): the runner answers
 * their questions by the mode instead.
 */
export const ACP_MODES: Readonly<Record<Mode, readonly string[]>> = {
  off: ['default'],
  'accept-edits': ['autoEdit', 'auto-edit'],
  auto: ['autoEdit', 'auto-edit'],
  'full-access': ['yolo'],
}
