// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 告警 — placeholder (J5 告警中心).
 *
 * The page package that builds this area replaces the `stubRoute(...)` call
 * below with a module of its own (`routes/types.ts`) and changes no other
 * route file. Until then `/alerts` is the one-line placeholder of `stub.ts`.
 */

import { stubRoute } from './stub.js'

export const alertsRoute = stubRoute(
  { id: 'alerts', label: '告警', group: 'run', icon: 'bell' },
  '节点失联 · 链路断裂 · 证书到期 · 集中在这里确认与处理',
)
