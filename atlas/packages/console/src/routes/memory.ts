// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 记忆 (P23): the page, `/v0/memory` and `/fragments/memory`.
 *
 * | Route | Who |
 * |---|---|
 * | `GET /memory?agent=&kind=&q=&retired=`, `GET /fragments/memory?…` | member and up |
 * | `GET /v0/memory?…` | member and up |
 * | `POST /v0/memory` (add) | member and up |
 * | `PUT /v0/memory/<id>` (correct: a new entry supersedes the old) | member and up |
 * | `POST /v0/memory/<id>/forget\|invalidate` | member and up |
 *
 * Long-term memory is per agent and per account (design review D18): every
 * read and write carries the caller, and the port only ever answers with
 * that caller's own. So even the read is a conversation-level right — a view
 * token has nobody's memory to read. Without a memory port the area is not
 * offered at all: a console that does not remember shows no 记忆.
 */

import type { ConsoleResult } from '../contracts.js'
import {
  MEMORY_KINDS,
  type AgentRef,
  type MemoryDraft,
  type MemoryEntryView,
  type MemoryKind,
  type MemoryPort,
} from '../directionPorts.js'
import { fail, html, json, methodNotAllowed, notFound } from '../respond.js'
import { attr } from '../view/escape.js'
import { KIT_CSS } from '../view/kit.js'
import {
  MEMORY_PAGE_CSS,
  MEMORY_SWAP,
  type MemoryFilter,
  memoryDialogs,
  memoryNewButton,
  memoryQuery,
  renderMemoryBar,
  renderMemoryFragment,
  renderMemoryList,
  renderMemoryUnavailable,
} from '../view/memory.js'
import { MEMORY_PAGE_JS } from '../view/memoryScript.js'
import {
  actorOf,
  agentRefOf,
  answer,
  bodyOf,
  canMember,
  guardMemberWrite,
  segment,
  stringField,
  unwired,
  write,
} from './directionShared.js'
import { guardChat } from './shared.js'
import type { RouteContext, RouteModule } from './types.js'

const LIST_LIMIT = 60

const NO_COUNTS: Readonly<Record<MemoryKind, number>> = {
  preference: 0,
  plan: 0,
  project: 0,
  daily: 0,
}

function kindOf(value: unknown): MemoryKind | null {
  return typeof value === 'string' &&
    (MEMORY_KINDS as readonly string[]).includes(value)
    ? (value as MemoryKind)
    : null
}

function filterOf(
  params: URLSearchParams,
  agents: readonly AgentRef[],
): MemoryFilter {
  const asked = agentRefOf(params.get('agent'))
  const agent =
    (asked === null
      ? undefined
      : agents.find(
          one => one.node === asked.node && one.agent === asked.agent,
        )) ??
    agents[0] ??
    null
  return {
    agent,
    kind: kindOf(params.get('kind')),
    text: (params.get('q') ?? '').trim().slice(0, 200),
    retired: params.get('retired') === '1',
  }
}

interface Listed {
  readonly filter: MemoryFilter
  readonly agents: readonly (AgentRef & { readonly reachable: boolean })[]
  readonly entries: readonly MemoryEntryView[]
  readonly total: number
  readonly nextOffset?: number | null
  readonly counts: Readonly<Record<MemoryKind, number>>
}

async function listed(
  ctx: RouteContext,
  port: MemoryPort,
): Promise<ConsoleResult<Listed>> {
  const agents = await port.agents()
  if (!agents.ok) return agents
  const filter = filterOf(ctx.url.searchParams, agents.value)
  if (filter.agent === null) {
    return {
      ok: true,
      value: { filter, agents: [], entries: [], total: 0, counts: NO_COUNTS },
    }
  }
  const offset = Number(ctx.url.searchParams.get('offset') ?? 0)
  if (!Number.isSafeInteger(offset) || offset < 0)
    return { ok: false, failure: { code: 'invalid', message: '记忆分页无效' } }
  const result = await port.list(
    {
      node: filter.agent.node,
      agent: filter.agent.agent,
      scope: 'all',
      ...(filter.kind === null ? {} : { kind: filter.kind }),
      ...(filter.text === '' ? {} : { text: filter.text }),
      includeRetired: filter.retired,
      limit: LIST_LIMIT,
      offset,
    },
    actorOf(ctx),
  )
  if (!result.ok) return result
  return {
    ok: true,
    value: { filter, agents: agents.value, ...result.value },
  }
}

function listHtml(ctx: RouteContext, value: Listed): string {
  return renderMemoryList({
    filter: value.filter,
    entries: value.entries,
    total: value.total,
    counts: value.counts,
    now: ctx.now,
    writer: canMember(ctx),
  })
}

function draftOf(body: Record<string, unknown>): MemoryDraft | Response {
  const kind = kindOf(body.kind)
  const title = stringField(body, 'title') ?? ''
  const summary = stringField(body, 'summary') ?? ''
  const text = stringField(body, 'body') ?? ''
  if (kind === null)
    return fail(400, 'invalid', '类别只能是偏好 计划 项目 日常')
  if (title === '' || title.length > 120) {
    return fail(400, 'invalid', '一句话必填 · 最多 120 字')
  }
  if (summary === '' || summary.length > 400) {
    return fail(400, 'invalid', '摘要必填 · 最多 400 字')
  }
  if (text.length > 4000) return fail(400, 'invalid', '细节最多 4000 字')
  return { kind, title, summary, body: text }
}

async function memoryApi(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  const port = ctx.deps.memory
  const method = ctx.request.method
  const denied = guardChat(ctx.access, 'guarded')
  if (denied !== null) return denied
  if (rest.length === 0 && method === 'GET') {
    if (port === undefined) return unwired('长期记忆')
    const result = await listed(ctx, port)
    if (!result.ok) return answer(result)
    return json({
      agent: result.value.filter.agent,
      entries: result.value.entries,
      total: result.value.total,
      ...(result.value.nextOffset === undefined
        ? {}
        : { nextOffset: result.value.nextOffset }),
      counts: result.value.counts,
    })
  }
  const id = rest.length === 0 ? null : segment(rest[0])
  const verb = rest[1]
  const shape =
    rest.length === 0
      ? 'add'
      : id !== null && rest.length === 1
        ? 'edit'
        : id !== null &&
            rest.length === 2 &&
            (verb === 'forget' || verb === 'invalidate')
          ? verb
          : null
  if (shape === null) return notFound(`unknown path: ${ctx.url.pathname}`)
  const allowed =
    shape === 'add' ? ['GET', 'POST'] : shape === 'edit' ? ['PUT'] : ['POST']
  if (!allowed.includes(method) || (shape === 'add' && method !== 'POST')) {
    return methodNotAllowed(allowed)
  }
  const write_ = guardMemberWrite(ctx)
  if (write_ !== null) return write_
  if (port === undefined) return unwired('长期记忆')
  const body = await bodyOf(ctx)
  if (body instanceof Response) return body
  const ref = agentRefOf(body.agent)
  if (ref === null) return fail(400, 'invalid', 'agent 必须是智能体地址')
  const actor = actorOf(ctx)
  if (shape === 'add' || shape === 'edit') {
    const draft = draftOf(body)
    if (draft instanceof Response) return draft
    return shape === 'add'
      ? await write(
          ctx,
          'memory.add',
          `qianmo://${ref.node}/${ref.agent}`,
          () => port.add(ref, draft, actor),
        )
      : await write(ctx, 'memory.edit', id ?? '-', () =>
          port.edit(ref, id ?? '', draft, actor),
        )
  }
  if (shape === 'forget') {
    const reason = (stringField(body, 'reason') ?? '').slice(0, 200)
    return await write(ctx, 'memory.forget', id ?? '-', () =>
      port.forget(
        ref,
        id ?? '',
        reason === '' ? '用户在控制台删除' : reason,
        actor,
      ),
    )
  }
  return await write(ctx, 'memory.invalidate', id ?? '-', () =>
    port.invalidate(ref, id ?? '', actor),
  )
}

async function memoryFragment(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  if (rest.length !== 0) return notFound(`unknown path: ${ctx.url.pathname}`)
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const denied = guardChat(ctx.access, 'guarded')
  if (denied !== null) return denied
  const port = ctx.deps.memory
  if (port === undefined) {
    return html(renderMemoryFragment(renderMemoryUnavailable(null), null))
  }
  const result = await listed(ctx, port)
  return html(
    result.ok
      ? renderMemoryFragment(listHtml(ctx, result.value), result.value.counts)
      : renderMemoryFragment(renderMemoryUnavailable(result.failure), null),
  )
}

export const memoryRoute: RouteModule = {
  area: {
    id: 'memory',
    label: '记忆',
    group: 'main',
    href: '/memory',
    icon: 'brain',
  },
  page: {
    match: segments =>
      segments.length === 1 && segments[0] === 'memory' ? [] : null,
    guard: 'chat',
    available: ctx => ctx.deps.memory !== undefined,
    async render(ctx) {
      const port = ctx.deps.memory
      if (port === undefined)
        return notFound(`unknown path: ${ctx.url.pathname}`)
      const result = await listed(ctx, port)
      if (!result.ok) {
        return { title: '记忆', body: renderMemoryUnavailable(result.failure) }
      }
      const value = result.value
      const writer = canMember(ctx) && value.filter.agent !== null
      return {
        title: '记忆',
        ...(writer ? { actions: memoryNewButton() } : {}),
        body:
          renderMemoryBar(value.agents, value) +
          `<div class="kit-pane" id="memory" data-poll="${attr(`/fragments/memory${memoryQuery(value.filter)}`)}" ` +
          `data-swap="${MEMORY_SWAP}">` +
          renderMemoryFragment(listHtml(ctx, value), null) +
          `</div>` +
          (writer ? memoryDialogs() : ''),
      }
    },
    css: KIT_CSS + MEMORY_PAGE_CSS,
    script: MEMORY_PAGE_JS,
  },
  api: {
    heads: ['memory'],
    handle: (ctx, _head, rest) => memoryApi(ctx, rest),
  },
  fragments: {
    heads: ['memory'],
    handle: (ctx, _head, rest) => memoryFragment(ctx, rest),
  },
}
