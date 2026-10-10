// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { subjectOf } from './access.js'
import type { UsageScope, UsageAdmission } from './governance.js'
import { json } from './respond.js'
import type { RouteContext } from './routes/types.js'

export function usageScopeOf(ctx: RouteContext): UsageScope {
  return { subject: subjectOf(ctx.access), kind: 'person' }
}
export function reserveUsage(
  ctx: RouteContext,
  input?: {
    sessionId?: string
    newSession?: boolean
    operation?: 'message' | 'wake' | 'session'
  },
): string | Response | undefined {
  const result = ctx.deps.usage?.reserve(usageScopeOf(ctx), input)
  if (result === undefined) return undefined
  if (result.ok) return result.reservationId
  return usageDenial(result, ctx.now)
}

export function usageDenial(
  result: Extract<UsageAdmission, { ok: false }>,
  now: number,
): Response {
  const response = json(
    {
      error: {
        code: result.reason,
        message:
          result.reason === 'quota'
            ? '已达到配额，请在重置后重试'
            : '用量记录不可用，任务已暂停',
      },
      used: result.snapshot.rows,
      resetsAt: result.snapshot.resetsAt,
    },
    result.reason === 'quota' ? 429 : 503,
  )
  if (result.reason === 'quota')
    response.headers.set(
      'retry-after',
      String(Math.max(1, Math.ceil((result.snapshot.resetsAt - now) / 1000))),
    )
  return response
}
