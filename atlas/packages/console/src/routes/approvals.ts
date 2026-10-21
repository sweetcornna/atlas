// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { usageDenial } from '../quota.js'
import { approvalReport } from './approvalReport.js'
import { approvalCookie, approvalSessions } from '../approvalSession.js'
import {
  fail,
  html,
  json,
  methodNotAllowed,
  notFound,
  readJsonObject,
} from '../respond.js'
import { agentAvatarKey } from '../avatar.js'
import {
  APPROVALS_PAGE_CSS,
  APPROVALS_PAGE_JS,
  approvalsFrame,
  renderApprovals,
  renderApprovalsAudit,
} from '../view/approvals.js'
import { facesFor } from './avatars.js'
import { failureResponse, guard, guardChat, underPath } from './shared.js'
import type { RouteContext, RouteModule } from './types.js'

/** Whether this reader decides: a personal member or operator account. */
function decides(ctx: RouteContext): boolean {
  return (
    ctx.deps.approvals !== undefined &&
    ctx.access.principal?.kind === 'user' &&
    ctx.access.principal.role !== 'viewer'
  )
}

/** The polled region (`view/approvals.ts`). */
async function content(ctx: RouteContext): Promise<string> {
  const port = ctx.deps.approvals
  if (port === undefined)
    return '<p class="bar bar-muted">审批未接入 · 没有可提交的审批动作</p>'
  const principal = ctx.access.principal
  if (principal?.kind !== 'user' || principal.role === 'viewer')
    return renderApprovalsAudit(await approvalReport(ctx))
  const result = await port.list(principal)
  if (!result.ok)
    return '<p class="bar bar-bad" role="alert">审批来源不可用</p>'
  const faces = await facesFor(
    ctx,
    result.value.map(item => agentAvatarKey(item.agent)),
  )
  return renderApprovals({
    items: result.value,
    role: principal.role,
    now: ctx.now,
    face: agent => faces.spec(agentAvatarKey(agent)),
  })
}

export const approvalsRoute: RouteModule = {
  area: {
    id: 'approvals',
    label: '审批',
    group: 'manage',
    href: '/admin/approvals',
    icon: 'list-checks',
  },
  page: {
    match: underPath('approvals'),
    guard: 'view',
    async render(ctx) {
      return {
        title: '审批',
        body: approvalsFrame(await content(ctx), decides(ctx)),
        poll: true,
      }
    },
    css: APPROVALS_PAGE_CSS,
    script: APPROVALS_PAGE_JS,
  },
  api: {
    heads: ['approvals'],
    async handle(ctx, _head, rest) {
      if (rest.length === 1 && rest[0] === 'report') {
        const denied = guard(ctx.access.credential, 'view', 'guarded')
        if (denied) return denied
        if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
        return json(await approvalReport(ctx))
      }
      const denied = guardChat(ctx.access, 'guarded')
      if (denied) return denied
      const principal = ctx.access.principal
      if (principal?.kind !== 'user')
        return fail(403, 'forbidden', '审批需要个人账号')
      if (rest.length === 1 && rest[0] === 'auth') {
        if (ctx.request.method !== 'POST') return methodNotAllowed(['POST'])
        if (ctx.accounts === undefined)
          return fail(403, 'forbidden', '个人账号未接入')
        const body = await readJsonObject(ctx.request)
        if (typeof body?.['credential'] !== 'string')
          return fail(400, 'invalid', '先验证个人凭据')
        const blocked = await ctx.admit()
        if (blocked) return blocked
        const secret = approvalSessions(ctx.accounts.book).issue(
          principal,
          body['credential'],
          ctx.now,
        )
        if (secret === null) return fail(403, 'forbidden', '个人凭据验证失败')
        await ctx.record('approval.auth', principal.subject, 'ok')
        const response = json({ verified: true, expiresAt: ctx.now + 1800000 })
        response.headers.append(
          'set-cookie',
          approvalCookie(ctx.request, secret),
        )
        return response
      }
      const continuation = rest.length === 2 && rest[1] === 'continue'
      if (rest.length > 1 && !continuation)
        return notFound(`unknown path: ${ctx.url.pathname}`)
      if (continuation && ctx.request.method !== 'POST')
        return methodNotAllowed(['POST'])
      if (rest.length === 0 && ctx.request.method !== 'GET')
        return methodNotAllowed(['GET'])
      if (rest.length === 1 && !['POST', 'DELETE'].includes(ctx.request.method))
        return methodNotAllowed(['POST', 'DELETE'])
      const port = ctx.deps.approvals
      if (port === undefined) return fail(501, 'unsupported', '审批未接入')
      if (rest.length === 0) {
        if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
        const result = await port.list(principal)
        // `?mine=1` (the front's prompt, P39): only what waits on this person
        // as the session's owner, not everything an ops account may see.
        const mine = ctx.url.searchParams.get('mine') === '1'
        return result.ok
          ? json({
              approvals: mine
                ? result.value.filter(
                    item =>
                      item.owner === principal.subject &&
                      item.status === 'pending',
                  )
                : result.value,
            })
          : failureResponse(result.failure)
      }
      if (rest.length !== 1 && !continuation)
        return notFound(`unknown path: ${ctx.url.pathname}`)
      if (!['POST', 'DELETE'].includes(ctx.request.method))
        return methodNotAllowed(['POST', 'DELETE'])
      let requestId: string
      try {
        requestId = decodeURIComponent(rest[0]!)
      } catch {
        return fail(400, 'invalid', '审批标识无效')
      }
      const visible = await port.list(principal)
      if (!visible.ok) return failureResponse(visible.failure)
      const item = visible.value.find(v => v.requestId === requestId)
      if (!item) return notFound('资源不存在')
      const approving =
        ctx.accounts === undefined
          ? principal.credential === 'bearer'
            ? principal
            : null
          : approvalSessions(ctx.accounts.book).principal(
              ctx.request,
              principal,
              ctx.now,
            )
      if (approving === null) return fail(403, 'forbidden', '先验证个人凭据')
      const blocked = await ctx.admit()
      if (blocked) return blocked
      if (ctx.request.method === 'DELETE') {
        const r = await port.revoke(approving, requestId)
        await ctx.record('approval.revoke', requestId, r.ok ? 'ok' : 'refused')
        return r.ok ? json(r.value) : failureResponse(r.failure)
      }
      const body = await readJsonObject(ctx.request)
      if (continuation) {
        if (typeof body?.['digest'] !== 'string')
          return fail(400, 'invalid', '审批摘要无效')
        if (port.continue === undefined)
          return fail(501, 'unsupported', '审批继续未接入')
        const r = await port.continue(approving, {
          requestId,
          digest: body['digest'],
        })
        await ctx.record(
          'approval.continue',
          requestId,
          r.ok ? 'ok' : 'refused',
        )
        if (!r.ok && 'quota' in r) return usageDenial(r.quota, ctx.now)
        return r.ok ? json(r.value) : failureResponse(r.failure)
      }
      if (
        body === null ||
        typeof body['digest'] !== 'string' ||
        !['allow-once', 'allow-window', 'deny'].includes(
          String(body['decision']),
        )
      )
        return fail(400, 'invalid', '审批决定无效')
      if (
        body['windowMs'] !== undefined &&
        (typeof body['windowMs'] !== 'number' ||
          !Number.isSafeInteger(body['windowMs']) ||
          body['windowMs'] < 1 ||
          body['windowMs'] > 3600000)
      )
        return fail(400, 'invalid', '授权窗口应为 1 到 3600000 毫秒')
      if (
        item.toolName === 'qianmo_memory_write' &&
        body['decision'] === 'allow-window'
      )
        return fail(400, 'invalid', '记忆写入要逐次批准 · 不支持授权窗口')
      const result = await port.decide(approving, {
        requestId,
        digest: body['digest'],
        decision: body['decision'] as 'allow-once' | 'allow-window' | 'deny',
        ...(typeof body['windowMs'] === 'number'
          ? { windowMs: body['windowMs'] }
          : {}),
      })
      await ctx.record(
        'approval.decide',
        requestId,
        result.ok ? 'ok' : 'refused',
      )
      return result.ok ? json(result.value) : failureResponse(result.failure)
    },
  },
  fragments: {
    heads: ['approvals'],
    async handle(ctx, _head, rest) {
      const denied = guard(ctx.access.credential, 'view', 'guarded')
      if (denied) return denied
      if (rest.length) return notFound(`unknown path: ${ctx.url.pathname}`)
      if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
      return html(await content(ctx))
    },
  },
}
