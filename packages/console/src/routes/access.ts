// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 账号与访问 — placeholder (H3 账号与访问 · H4 操作记录).
 *
 * The page package that builds this area replaces the `stubRoute(...)` call
 * below with a module of its own (`routes/types.ts`) and changes no other
 * route file. Until then `/access` is the one-line placeholder of `stub.ts`.
 */

import { stubRoute } from './stub.js'

export const accessRoute = stubRoute(
  { id: 'access', label: '账号与访问', group: 'admin', icon: 'users' },
  '成员 · 邀请 · 会话 · 操作记录',
)
