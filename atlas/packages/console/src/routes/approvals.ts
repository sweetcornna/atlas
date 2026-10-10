// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { usageDenial } from '../quota.js'
import { approvalReport } from './approvalReport.js'
import { approvalCookie, approvalSessions } from '../approvalSession.js'
import type { ApprovalItem } from '../governance.js'
import {
  fail,
  html,
  json,
  methodNotAllowed,
  notFound,
  readJsonObject,
} from '../respond.js'
import { attr, escapeHtml as htmlEscape } from '../view/escape.js'
import { failureResponse, guard, guardChat, underPath } from './shared.js'
import type { RouteContext, RouteModule } from './types.js'

/** Show invisible controls as literal codepoints, including inside paths and JSON. */
function escapeHtml(value: string): string {
  return htmlEscape(
    [...String(value)]
      .map(char => {
        const code = char.codePointAt(0)!
        return (code < 32 && code !== 10 && code !== 9) ||
          (code >= 0x7f && code <= 0x9f) ||
          code === 0x61c ||
          code === 0x200e ||
          code === 0x200f ||
          (code >= 0x202a && code <= 0x202e) ||
          (code >= 0x2066 && code <= 0x2069)
          ? `\\u${code.toString(16).padStart(4, '0')}`
          : char
      })
      .join(''),
  )
}

function render(items: readonly ApprovalItem[]): string {
  return `<p>每次决定绑定目标节点、工具、参数摘要与会话。授权窗口最长 60 分钟；需要最近 30 分钟内验证过的个人凭据。「批准并继续」仅在节点已确认原任务结束后发送新任务；本地超时不能代替节点终态。</p>${items.length === 0 ? '<p class="bar">当前没有可见审批</p>' : items.map(item => `<article class="sec"><h2>${escapeHtml(item.toolName)} · ${escapeHtml(({ pending: '待审批', allowed: '已批准', denied: '已拒绝或撤销', expired: '已过期', 'delivery-unknown': '投递未确认' } as const)[item.status])}</h2><p>节点 ${escapeHtml(item.node)} · 智能体 ${escapeHtml(item.agent)} · 会话 ${escapeHtml(item.contextId)}</p><p>到期 ${escapeHtml(new Date(item.expiresAt).toISOString())} · <a href="/chat?active=${encodeURIComponent(item.contextId)}">查看原会话</a></p>${item.origin ? `<p>来源 ${escapeHtml(item.origin.from ?? '本地')} · 信任 ${escapeHtml(item.origin.trust)} · 任务 ${escapeHtml(item.origin.taskId ?? '无')} · 追踪 ${escapeHtml(item.origin.traceId ?? '无')}</p>` : ''}<details><summary>查看完整参数与摘要</summary><pre>${escapeHtml(JSON.stringify(item.input, null, 2))}</pre><code>${escapeHtml(item.digest)}</code></details>${item.continuation ? '<p class="bar">继续请求已记录，请查看原会话；不会自动重发。</p>' : ''}${item.status === 'pending' && !item.continuation ? `<form data-approval="${attr(item.requestId)}" data-digest="${attr(item.digest)}"><button class="btn btn-primary" name="decision" value="allow-once">仅批准本次</button>${item.toolName === 'qianmo_memory_write' ? '<span class="quiet">记忆写入每次单独审批</span>' : '<button class="btn" name="decision" value="allow-window">批准 5 分钟</button>'}<button class="btn" name="decision" value="continue">批准并继续</button><button class="btn" name="decision" value="deny">拒绝</button></form>` : (item.status === 'allowed' || item.status === 'delivery-unknown') ? `<button class="btn" data-revoke="${attr(item.requestId)}">撤销授权窗口</button>` : ''}</article>`).join('')}`
}
async function content(ctx: RouteContext): Promise<string> {
  if (ctx.deps.approvals === undefined)
    return '<p class="bar">审批未接入 · 没有可提交的审批动作</p>'
  if (
    ctx.access.principal?.kind !== 'user' ||
    ctx.access.principal.role === 'viewer'
  ) {
    const report = await approvalReport(ctx)
    return `<p class="bar">审批需要个人成员或运维账号 · 旧令牌与应急身份不能审批</p><h2>审计汇总</h2><p>每节点最近 500 条审计记录 · 只汇总完整审计链</p>${'summary' in report ? (report.summary ?? []).map(row => `<p>${escapeHtml(row.node)} · 请求 ${row.requests} · 已使用 ${row.used} · 拒绝 ${row.refused} · 待批 ${row.pending}</p>`).join('') : ''}${report.sources.map(source => `<p>${escapeHtml(source.node)} · ${source.integrity === 'intact' || source.integrity === 'empty' ? '审计链完整' : '审计不可用或未通过校验'}${source.truncated ? ' · 仅显示近期记录' : ''}</p>`).join('')}`
  }
  const result = await ctx.deps.approvals.list(ctx.access.principal)
  return result.ok
    ? render(result.value)
    : '<p class="bar bar-bad" role="alert">审批来源不可用</p>'
}
const SCRIPT = `(function(){document.addEventListener('submit',function(e){var f=e.target;if(f.id==='approval-auth'){e.preventDefault();var credential=f.elements.credential.value;f.elements.credential.value='';window.qianmoConsole.sendJson('POST','/v0/approvals/auth',{credential:credential}).then(function(){document.getElementById('approval-status').textContent='已验证 · 可提交审批';}).catch(function(){document.getElementById('approval-status').textContent='验证失败 · 请使用当前账号的个人凭据';});return;}if(!f.matches('[data-approval]'))return;e.preventDefault();var button=e.submitter;if(!button)return;var decision=button.value;var continuation=decision==='continue';var buttons=f.querySelectorAll('button');buttons.forEach(function(b){b.disabled=true;});window.qianmoConsole.sendJson('POST','/v0/approvals/'+encodeURIComponent(f.dataset.approval)+(continuation?'/continue':''),{digest:f.dataset.digest,decision:decision,...(decision==='allow-window'?{windowMs:300000}:{})}).then(function(){location.reload();}).catch(function(){document.getElementById('approval-status').textContent='审批未完成 · 请刷新后重试';buttons.forEach(function(b){b.disabled=false;});});});document.addEventListener('click',function(e){var b=e.target.closest('[data-revoke]');if(!b)return;b.disabled=true;window.qianmoConsole.sendJson('DELETE','/v0/approvals/'+encodeURIComponent(b.dataset.revoke)).then(function(){location.reload();}).catch(function(){document.getElementById('approval-status').textContent='撤销未完成 · 请刷新后重试';b.disabled=false;});});})();`
export const approvalsRoute: RouteModule = {
  area: {
    id: 'approvals',
    label: '审批',
    group: 'run',
    href: '/approvals',
    icon: 'list-checks',
  },
  page: {
    match: underPath('approvals'),
    guard: 'view',
    async render(ctx) {
      const authForm =
        ctx.deps.approvals !== undefined &&
        ctx.access.principal?.kind === 'user' &&
        ctx.access.principal.role !== 'viewer'
          ? `<form id="approval-auth"><label for="approval-credential">验证个人凭据后批准（30 分钟内有效）</label><input id="approval-credential" name="credential" type="password" class="input" autocomplete="off" required><button class="btn" type="submit">验证凭据</button></form>`
          : ''
      return {
        title: '审批',
        body: `${authForm}<p id="approval-status" role="status"></p><div data-poll="/fragments/approvals">${await content(ctx)}</div>`,
        poll: true,
      }
    },
    script: SCRIPT,
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
          return fail(400, 'invalid', '请验证个人凭据')
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
        return result.ok
          ? json({ approvals: result.value })
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
      if (approving === null) return fail(403, 'forbidden', '请先验证个人凭据')
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
        return fail(400, 'invalid', '记忆写入必须逐次批准，不支持授权窗口')
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
