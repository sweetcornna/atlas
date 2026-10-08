// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 审批 — placeholder (J8 审批).
 *
 * The page package that builds this area replaces the `stubRoute(...)` call
 * below with a module of its own (`routes/types.ts`) and changes no other
 * route file. Until then `/approvals` is the one-line placeholder of `stub.ts`.
 */

import { stubRoute } from './stub.js'

export const approvalsRoute = stubRoute(
  { id: 'approvals', label: '审批', group: 'run', icon: 'list-checks' },
  '需要人工确认的动作在这里排队 · 批准或拒绝',
)
