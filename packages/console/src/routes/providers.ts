// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 模型服务 — placeholder (J1 模型服务).
 *
 * The page package that builds this area replaces the `stubRoute(...)` call
 * below with a module of its own (`routes/types.ts`) and changes no other
 * route file. Until then `/providers` is the one-line placeholder of `stub.ts`.
 */

import { stubRoute } from './stub.js'

export const providersRoute = stubRoute(
  { id: 'providers', label: '模型服务', group: 'config', icon: 'cpu' },
  '每个节点用哪家模型服务 · 新增 · 测连 · 切换',
)
