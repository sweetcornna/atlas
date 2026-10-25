// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a session asks of a driver (one per native protocol, qmo-local.md
 * §4.3.5) and what the driver tells it back. A driver speaks its agent's
 * protocol and its own mode table; the session writes the records, keeps the
 * queue and the process budget, and talks to the page.
 */

import type { Mode } from '../modes.js'
import type { AskDecision } from '../protocol.js'

/** A tool call as its process line shows it. */
export interface ToolView {
  readonly id: string
  /** The agent's own tool name (`Edit`, `Bash`, …). */
  readonly name: string
  /** One line: what it does (`编辑 src/app.ts`). */
  readonly text: string
  readonly paths?: readonly string[]
  readonly command?: string
  readonly detailKind: 'output' | 'diff'
  /** Known from the input: what an edit changes. */
  readonly diff?: {
    readonly text: string
    readonly added: number
    readonly removed: number
  }
}

/** A permission question as its card shows it. */
export interface AskView {
  /** The tool call it is about, when the agent says. */
  readonly toolId?: string
  readonly tool: string
  readonly title: string
  readonly paths?: readonly string[]
  /** A summary of the input, at most 2 KiB. */
  readonly input?: string
  readonly options: readonly AskDecision[]
  /** For the process line: the diff, or the input. */
  readonly detail?: string
}

export interface AskAnswer {
  readonly decision: AskDecision
  readonly message?: string
}

/** A child process the runner must be able to find again after a crash. */
export interface ChildInfo {
  readonly pid: number
  readonly startedAt: number
  readonly program: string
}

/** What a driver reports while it runs. */
export interface AgentHooks {
  /** A whole message of the agent's. */
  message(text: string): void
  /** Text as it streams, before its message. */
  delta(text: string): void
  /** For the waiting line: thinking, or a tool of a sub-agent's. */
  activity(kind: 'thinking' | 'tool', words: string): void
  toolStart(tool: ToolView): void
  toolEnd(id: string, isError: boolean, output: string): void
  /** Settles with the person's answer; a `signal` abort means it was denied already. */
  ask(ask: AskView, signal: AbortSignal): Promise<AskAnswer>
  /** A line of the runner's own in the conversation. */
  notice(text: string, severity: 'info' | 'warn' | 'error'): void
  /** The agent's own conversation exists: the next process resumes it. */
  started(): void
  /** The mode in effect changed by itself (a fallback). */
  modeChanged(mode: Mode): void
  /** The agent has no mode `auto` (this program, for the runner's life). */
  noAuto(): void
  childStarted(child: ChildInfo): void
  childGone(pid: number): void
}

export interface TurnOutcome {
  readonly status: 'completed' | 'error' | 'aborted'
  readonly message?: string
}

/** One agent of one session; its process may come and go between turns. */
export interface AgentProcess {
  /** The process is running. */
  readonly alive: boolean
  /** Runs one turn to its end; starts the process first when it is not running. */
  turn(text: string): Promise<TurnOutcome>
  /** Changes the mode; the answer says when it applies and what is in effect. */
  setMode(
    mode: Mode,
  ): Promise<{ readonly mode: Mode; readonly applies: 'now' | 'next-turn' }>
  /** Stops the turn: the native way, then the process group. */
  abort(): void
  /** Ends the process (idle, out of room, shutdown). */
  stop(): Promise<void>
}
