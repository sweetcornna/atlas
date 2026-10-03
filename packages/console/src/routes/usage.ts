// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 用量 — placeholder (J7 用量).
 *
 * The page package that builds this area replaces the `stubRoute(...)` call
 * below with a module of its own (`routes/types.ts`) and changes no other
 * route file. Until then `/usage` is the one-line placeholder of `stub.ts`.
 */

import { stubRoute } from './stub.js'

export const usageRoute = stubRoute(
  { id: 'usage', label: '用量', group: 'admin', icon: 'chart-column' },
  '按节点与模型服务统计的调用量',
)
