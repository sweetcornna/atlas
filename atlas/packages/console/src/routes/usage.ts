// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { subjectOf } from '../access.js'
import type { UsageSnapshot } from '../governance.js'
import { fail, html, json, methodNotAllowed, notFound } from '../respond.js'
import { escapeHtml } from '../view/escape.js'
import { guard, underPath } from './shared.js'
import type { RouteContext, RouteModule } from './types.js'

async function snapshot(ctx: RouteContext): Promise<UsageSnapshot | null> {
  const principal = ctx.access.principal
  return (
    ctx.deps.usage?.read(
      principal?.kind === 'user' && principal.role !== 'ops'
        ? subjectOf(ctx.access)
        : undefined,
    ) ?? null
  )
}
function render(value: UsageSnapshot | null): string {
  if (value === null)
    return '<p class="bar" role="status">用量未接入 · 当前没有可验证的计量数据</p>'
  const body = value.rows
    .map(
      row =>
        `<tr><th scope="row">${escapeHtml(row.bucket)}</th><td>${row.messages}</td><td>${row.wakes}</td><td>${row.input}</td><td>${row.output}</td><td>${row.cacheWrite}</td><td>${row.cacheRead}</td><td>${row.charged}${row.limits.tokens === undefined ? '' : ` / ${row.limits.tokens}`}</td><td>${row.inFlight}${row.limits.inFlight === undefined ? '' : ` / ${row.limits.inFlight}`}</td><td>${row.sessions}${row.limits.sessions === undefined ? '' : ` / ${row.limits.sessions}`}</td></tr>`,
    )
    .join('')
  return `<section class="sec"><h2>${escapeHtml(value.day)} · 东八区自然日</h2><p>${value.mode === 'shadow' ? '影子观察 · 超限只记录' : '配额执行 · 达到上限后拒绝新任务'} · 下次重置 ${escapeHtml(new Date(value.resetsAt).toISOString())}</p><p class="bar bar-warn">统计为可观测调用的下界；后台与压缩调用可能未完整覆盖。计费额度计入输入、输出与缓存写入，缓存读取单独展示。</p>${value.problem === null ? '' : '<p class="bar bar-bad" role="alert">用量存储不可用，新任务已暂停</p>'}<div class="table-wrap"><table><caption class="sr-only">各主体今日用量与配额</caption><thead><tr><th scope="col">主体</th><th scope="col">消息</th><th scope="col">唤醒</th><th scope="col">输入</th><th scope="col">输出</th><th scope="col">缓存写入</th><th scope="col">缓存读取</th><th scope="col">计入配额</th><th scope="col">进行中</th><th scope="col">会话</th></tr></thead><tbody>${body || '<tr><td colspan="10">今天暂无可见用量</td></tr>'}</tbody></table></div></section>`
}
export const usageRoute: RouteModule = {
  area: {
    id: 'usage',
    label: '用量',
    group: 'admin',
    href: '/usage',
    icon: 'chart-column',
  },
  page: {
    match: underPath('usage'),
    guard: 'view',
    async render(ctx) {
      return {
        title: '用量',
        body: `<div data-poll="/fragments/usage">${render(await snapshot(ctx))}</div>`,
        poll: true,
      }
    },
  },
  api: {
    heads: ['usage'],
    async handle(ctx, _head, rest) {
      const denied = guard(ctx.access.credential, 'view', 'guarded')
      if (denied) return denied
      if (rest.length) return notFound(`unknown path: ${ctx.url.pathname}`)
      if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
      const value = await snapshot(ctx)
      return value === null
        ? fail(501, 'unsupported', '用量未接入')
        : json(value)
    },
  },
  fragments: {
    heads: ['usage'],
    async handle(ctx, _head, rest) {
      const denied = guard(ctx.access.credential, 'view', 'guarded')
      if (denied) return denied
      if (rest.length) return notFound(`unknown path: ${ctx.url.pathname}`)
      if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
      return html(render(await snapshot(ctx)))
    },
  },
}
