// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 网关 (P34): the platform's magpie model gateway.
 *
 * | Route | Who |
 * |---|---|
 * | `GET /admin/magpie`, `GET /fragments/magpie`, `GET /fragments/magpie/agents`, `GET /fragments/magpie/usage?period=` | view and up |
 * | `GET /fragments/magpie/form?kind=&id=` | gateway writers (`kind=ext&id=<node>/<agent>`: an agent's native extension, P36.7) |
 *
 * The JSON behind the buttons is `/v0/magpie` (`routes/magpieApi.ts`).
 */

import {
  MAGPIE_USAGE_PERIODS,
  type MagpieUsagePeriod,
} from '../directionPorts.js'
import { fail, html, methodNotAllowed, notFound } from '../respond.js'
import { KIT_CSS } from '../view/kit.js'
import {
  MAGPIE_PAGE_CSS,
  type MagpieModel,
  type MagpieUsageSide,
  magpieDialogs,
  renderMagpie,
  renderMagpieForm,
  renderMagpieUsage,
} from '../view/magpie.js'
import {
  MAGPIE_AGENTS_CSS,
  type MagpieAgentsModel,
  renderMagpieAgents,
  renderMagpieExtensionForm,
} from '../view/magpieAgents.js'
import { MAGPIE_PAGE_JS } from '../view/magpieScript.js'
import { guardRead } from './directionShared.js'
import {
  bindingKey,
  bindingOf,
  magpieAgentsForReader,
  magpieApi,
  magpieForReader,
  magpieWriter,
} from './magpieApi.js'
import { failureResponse, preferredMainAgent } from './shared.js'
import type { RouteContext, RouteModule } from './types.js'

const DEFAULT_PERIOD: MagpieUsagePeriod = '7d'

async function modelOf(ctx: RouteContext): Promise<MagpieModel> {
  const port = ctx.deps.magpie
  const writer = magpieWriter(ctx)
  if (port === undefined) return { side: { kind: 'unwired' }, writer }
  const snapshot = await port.snapshot()
  return {
    side: snapshot.ok
      ? { kind: 'ok', value: magpieForReader(snapshot.value, writer) }
      : { kind: 'failed', failure: snapshot.failure },
    writer,
  }
}

async function agentsOf(ctx: RouteContext): Promise<MagpieAgentsModel> {
  const writer = magpieWriter(ctx)
  const mainAgent = preferredMainAgent(ctx.deps) ?? null
  const agents = ctx.deps.magpie?.agents
  if (agents === undefined)
    return { side: { kind: 'unwired' }, writer, mainAgent }
  const snapshot = await agents.snapshot()
  return {
    side: snapshot.ok
      ? { kind: 'ok', value: magpieAgentsForReader(snapshot.value, writer) }
      : { kind: 'failed', failure: snapshot.failure },
    writer,
    mainAgent,
  }
}

function periodOf(ctx: RouteContext): MagpieUsagePeriod | null {
  const asked = ctx.url.searchParams.get('period') ?? DEFAULT_PERIOD
  return (MAGPIE_USAGE_PERIODS as readonly string[]).includes(asked)
    ? (asked as MagpieUsagePeriod)
    : null
}

async function usageOf(
  ctx: RouteContext,
  period: MagpieUsagePeriod,
): Promise<MagpieUsageSide> {
  const port = ctx.deps.magpie
  if (port === undefined) return { kind: 'unwired' }
  const usage = await port.usage(period)
  return usage.ok
    ? { kind: 'ok', value: usage.value }
    : { kind: 'failed', failure: usage.failure }
}

async function formFragment(ctx: RouteContext): Promise<Response> {
  if (!magpieWriter(ctx))
    return fail(403, 'forbidden', '修改模型网关需要平台运维的个人账号')
  const port = ctx.deps.magpie
  if (port === undefined)
    return fail(501, 'unsupported', '该控制台没有接入模型网关')
  const kind = ctx.url.searchParams.get('kind') ?? ''
  const id = ctx.url.searchParams.get('id')
  if (kind === 'ext') {
    // An agent's native extension (P36.7): `id` is `<node>/<agent>`.
    const match =
      /^([a-z0-9][a-z0-9_-]{0,63})\/([a-z0-9][a-z0-9_-]{0,63})$/.exec(id ?? '')
    if (match === null || port.agents === undefined)
      return notFound('没有这个智能体')
    return html(
      renderMagpieExtensionForm({
        node: match[1] ?? '',
        agent: match[2] ?? '',
      }),
    )
  }
  const snapshot = await port.snapshot()
  if (!snapshot.ok) return failureResponse(snapshot.failure)
  if (kind === 'connect' || kind === 'provider')
    return html(renderMagpieForm({ kind, snapshot: snapshot.value }))
  if (kind === 'group') {
    const group =
      id === null
        ? null
        : (snapshot.value.groups.find(one => one.id === id) ?? null)
    if (id !== null && group === null) return notFound('没有这个路由组')
    return html(renderMagpieForm({ kind, snapshot: snapshot.value, group }))
  }
  if (kind === 'key') {
    const binding = id === null ? null : bindingOf(id)
    const key =
      binding === null
        ? null
        : (snapshot.value.keys.find(
            one => bindingKey(one.binding) === bindingKey(binding),
          ) ?? null)
    if (id !== null && key === null) return notFound('没有这把网关密钥')
    return html(renderMagpieForm({ kind, snapshot: snapshot.value, key }))
  }
  return fail(400, 'invalid', '表单种类无效')
}

async function magpieFragment(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const denied = guardRead(ctx)
  if (denied !== null) return denied
  if (rest.length === 0) return html(renderMagpie(await modelOf(ctx)))
  if (rest.length === 1 && rest[0] === 'agents')
    return html(renderMagpieAgents(await agentsOf(ctx)))
  if (rest.length === 1 && rest[0] === 'usage') {
    const period = periodOf(ctx)
    if (period === null)
      return fail(400, 'invalid', '用量周期只能是 today 7d 30d all')
    return html(renderMagpieUsage(await usageOf(ctx, period), period))
  }
  if (rest.length === 1 && rest[0] === 'form') return formFragment(ctx)
  return notFound(`unknown path: ${ctx.url.pathname}`)
}

export const magpieRoute: RouteModule = {
  area: {
    id: 'magpie',
    label: '网关',
    group: 'main',
    href: '/admin/magpie',
    icon: 'waypoints',
  },
  page: {
    match: segments =>
      segments.length === 1 && segments[0] === 'magpie' ? [] : null,
    guard: 'view',
    available: ctx => ctx.deps.magpie !== undefined,
    async render(ctx) {
      if (ctx.deps.magpie === undefined)
        return notFound(`unknown path: ${ctx.url.pathname}`)
      const [model, agents, usage] = await Promise.all([
        modelOf(ctx),
        agentsOf(ctx),
        usageOf(ctx, DEFAULT_PERIOD),
      ])
      return {
        title: '网关',
        body:
          `<div class="kit-pane" id="magpie" data-poll="/fragments/magpie">${renderMagpie(model)}</div>` +
          `<div class="kit-pane" id="magpie-agents" data-poll="/fragments/magpie/agents">${renderMagpieAgents(agents)}</div>` +
          `<div class="kit-pane" id="magpie-usage" data-poll="/fragments/magpie/usage?period=${DEFAULT_PERIOD}">` +
          `${renderMagpieUsage(usage, DEFAULT_PERIOD)}</div>` +
          (model.writer ? magpieDialogs() : ''),
      }
    },
    css: KIT_CSS + MAGPIE_PAGE_CSS + MAGPIE_AGENTS_CSS,
    script: MAGPIE_PAGE_JS,
  },
  api: magpieApi,
  fragments: {
    heads: ['magpie'],
    handle: (ctx, _head, rest) => magpieFragment(ctx, rest),
  },
}
