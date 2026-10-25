// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The drivers by native protocol (qmo-local.md §4.3.5): what a new session
 * keeps as the agent's own conversation (`session.json`'s `native`), and how
 * one session's agent is made. Only protocols in `FEATURES.protocols` reach
 * here (the runner refuses the rest when a session starts).
 */

import { randomUUID } from 'node:crypto'
import type { Mode } from '../modes.js'
import { CodeError } from '../protocol.js'
import { AcpAgent, acpProfile } from './acp.js'
import type { AgentHooks, AgentProcess } from './agent.js'
import { ClaudeAgent } from './claude.js'

/** What a session hands a driver to make its agent. */
export interface DriverStart {
  /** The runtime catalog's id (`claude-code`, `gemini`, …). */
  readonly agentId: string
  /** The agent's display name. */
  readonly name: string
  readonly program: string
  /** The agent's working folder. */
  readonly root: string
  readonly env: Readonly<Record<string, string>>
  readonly native: { readonly id: string; readonly started: boolean }
  readonly mode: Mode
  /** Known already: this program has no `auto` (Claude Code). */
  readonly noAuto: boolean
  readonly hooks: AgentHooks
  readonly interruptGraceMs: number
  readonly termGraceMs: number
}

export interface Driver {
  /** `native.kind` in `session.json`. */
  readonly nativeKind: string
  /** The native id a new session starts with; `''` when the agent gives it. */
  readonly firstNativeId: () => string
  readonly start: (input: DriverStart) => AgentProcess
}

const DRIVERS: Readonly<Record<string, Driver>> = {
  'claude-stream': {
    nativeKind: 'claude-session',
    firstNativeId: () => randomUUID(),
    start: input =>
      new ClaudeAgent({
        program: input.program,
        root: input.root,
        env: input.env,
        sessionId: input.native.id,
        started: input.native.started,
        mode: input.mode,
        noAuto: input.noAuto,
        hooks: input.hooks,
        interruptGraceMs: input.interruptGraceMs,
        termGraceMs: input.termGraceMs,
      }),
  },
  acp: {
    nativeKind: 'acp-session',
    firstNativeId: () => '',
    start: input =>
      new AcpAgent({
        profile: acpProfile(input.agentId),
        name: input.name,
        program: input.program,
        root: input.root,
        env: input.env,
        nativeId: input.native.id,
        started: input.native.started,
        mode: input.mode,
        hooks: input.hooks,
        interruptGraceMs: input.interruptGraceMs,
        termGraceMs: input.termGraceMs,
      }),
  },
}

/** The driver of `protocol`. */
export function driverFor(protocol: string): Driver {
  if (!Object.hasOwn(DRIVERS, protocol))
    throw new CodeError('E_AGENT', '后续版本支持')
  return DRIVERS[protocol]!
}
