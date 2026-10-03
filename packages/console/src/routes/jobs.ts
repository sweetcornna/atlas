// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 值守作业 — placeholder (J6 值守作业).
 *
 * The page package that builds this area replaces the `stubRoute(...)` call
 * below with a module of its own (`routes/types.ts`) and changes no other
 * route file. Until then `/jobs` is the one-line placeholder of `stub.ts`.
 */

import { stubRoute } from './stub.js'

export const jobsRoute = stubRoute(
  { id: 'jobs', label: '值守作业', group: 'run', icon: 'calendar-clock' },
  '定时与值守任务的列表 · 最近一次运行 · 下一次运行',
)
