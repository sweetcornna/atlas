// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { HandoffTool } from '@qianmo/handoff'

/** A transcript prefix that has been checked complete. */
export interface SessionSnapshot {
  readonly tool: HandoffTool
  readonly sessionId: string
  readonly file: string
  readonly content: Buffer
}
