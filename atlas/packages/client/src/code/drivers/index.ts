// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The drivers by protocol (qmo-local.md §4.3.5): one line each. The
 * protocols the page may offer are `FEATURES.protocols` (`protocol.ts`),
 * which names exactly these.
 */

import { CodeError } from '../protocol.js'
import { ACP_DRIVER } from './acp.js'
import type { Driver } from './agent.js'
import { CLAUDE_DRIVER } from './claude.js'
import { CODEX_DRIVER } from './codex.js'

export const DRIVERS: Readonly<Record<string, Driver>> = {
  'claude-stream': CLAUDE_DRIVER,
  'codex-app-server': CODEX_DRIVER,
  // Gemini CLI, Qwen Code, opencode, dsh: one driver, a profile each (`acp.ts`).
  acp: ACP_DRIVER,
}

/** The driver of an agent's protocol; one this runner has none for is refused. */
export function driverFor(protocol: string): Driver {
  const driver = Object.hasOwn(DRIVERS, protocol)
    ? DRIVERS[protocol]
    : undefined
  if (driver === undefined) throw new CodeError('E_AGENT', '后续版本支持')
  return driver
}
