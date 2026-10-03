// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 消息链 — the trail, one reconstructed chain out of it, and the filter that
 * drives both.
 *
 * Owns the `/audit` and `/audit/trace/<traceId>` pages, `/v0/audit`,
 * `/v0/audit/chain/<traceId>`, `/fragments/audit` and
 * `/fragments/chain/<traceId>`. The filter parser lives here rather than in
 * `http.ts` because the trail is the one area whose query string is a real
 * interface: the page's own form, the poller and a hand-edited bookmark all
 * write it, and the next change to it (a cursor, `providers-console-m1.md`
 * §6.4 D5) belongs to this area alone.
 */

import { AUDIT_PAGE_JS } from '../assets/pageScripts.js'
import type { AuditFilter, ConsoleDeps } from '../deps.js'
import { fail, html, json, methodNotAllowed, notFound } from '../respond.js'
import { agentFilterOptions } from '../view/agents.js'
import {
  AUDIT_WINDOWS,
  renderAudit,
  renderAuditSources,
  renderChain,
} from '../view/audit.js'
import { failureBar } from '../view/bits.js'
import { attr } from '../view/escape.js'
import {
  auditSourceOf,
  failureResponse,
  guard,
  readAuditSources,
  safeDecode,
  singleLegacyAudit,
  textParam,
  valueOf,
  failureOf,
} from './shared.js'
import type { PageRender, RouteContext, RouteModule } from './types.js'

/**
 * Hard ceiling on the audit tail, whatever the query string asks for.
 *
 * The trail is an append-only file that grows for as long as the network runs.
 * A page that renders all of it is a page that stops rendering.
 */
export const MAX_AUDIT_LIMIT = 500

/**
 * Epoch milliseconds or an ISO string, whichever the caller typed.
 *
 * An unparseable value reads as "not given" rather than as an error: these
 * come from a text box on a page that reloads itself, and a filter that 400s
 * on a half-typed date is a filter nobody finishes typing. All-digit input is
 * always epoch ms — `2026` means 1970, not the year.
 */
function parseTimestamp(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  if (/^-?\d+$/.test(trimmed)) {
    const epoch = Number(trimmed)
    return Number.isSafeInteger(epoch) ? epoch : undefined
  }
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * Tail size, clamped rather than rejected.
 *
 * Anything present but not a positive integer — `0`, `-3`, `abc`, `12.5` — and
 * anything above {@link MAX_AUDIT_LIMIT} becomes the ceiling. An absent (or
 * empty) parameter stays absent so the port applies its own default.
 */
function parseLimit(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value <= 0) return MAX_AUDIT_LIMIT
  return Math.min(value, MAX_AUDIT_LIMIT)
}

/**
 * The relative windows the trail filter's segmented control can submit.
 *
 * Resolved here rather than in the browser because the filter form is a plain
 * `method="get"` that has to keep working with script disabled, and a radio
 * button cannot compute `now - 24h`. Anything else in the parameter is ignored
 * rather than refused — it arrives from a URL somebody may have edited by hand,
 * and a 400 on a filter is a filter nobody finishes typing.
 *
 * Derived from the view's own table rather than restated: the segmented control
 * and this parser have to agree on both the spelling and the span, and two
 * hand-kept lists agree only until one of them is edited.
 */
const AUDIT_WINDOW_MS: ReadonlyMap<string, number> = new Map(
  AUDIT_WINDOWS.map(([value, , span]) => [value, span]),
)

/**
 * Read the audit filter out of a query string.
 *
 * Exported and pure so the clamping rules can be tested without a request:
 * they are the part of this area most likely to be quietly wrong. `now` is a
 * parameter for the same reason every other clock in this package is: a window
 * of "the last hour" has to be reproducible in a test.
 */
export function parseAuditFilter(
  url: URL,
  now: number = Date.now(),
): AuditFilter {
  const params = url.searchParams
  const filter: {
    source?: string
    outcome?: string
    traceId?: string
    taskId?: string
    agent?: string
    from?: number
    to?: number
    window?: string
    limit?: number
  } = {}

  const source = textParam(params, 'source')
  if (source !== undefined) filter.source = source
  const outcome = textParam(params, 'outcome')
  if (outcome !== undefined) filter.outcome = outcome
  const traceId = textParam(params, 'traceId')
  if (traceId !== undefined) filter.traceId = traceId
  const taskId = textParam(params, 'taskId')
  if (taskId !== undefined) filter.taskId = taskId
  const agent = textParam(params, 'agent')
  if (agent !== undefined) filter.agent = agent

  const from = parseTimestamp(params.get('from'))
  if (from !== undefined) filter.from = from
  const to = parseTimestamp(params.get('to'))
  if (to !== undefined) filter.to = to

  // An explicit instant wins over a relative window: the advanced panel's
  // from/to pair *is* what the 自定义 segment means, and a window that quietly
  // overrode a hand-typed timestamp would make the two controls fight.
  const windowKey = textParam(params, 'window')
  const span =
    windowKey === undefined ? undefined : AUDIT_WINDOW_MS.get(windowKey)
  if (
    span !== undefined &&
    windowKey !== undefined &&
    from === undefined &&
    to === undefined
  ) {
    filter.window = windowKey
    filter.from = now - span
  }

  const limit = parseLimit(params.get('limit'))
  if (limit !== undefined) filter.limit = limit

  return filter
}

/** The trail fragment for a filter: one source the legacy way, or several. */
async function auditFragment(
  deps: ConsoleDeps,
  filter: AuditFilter,
  agentOptions?: string,
): Promise<string> {
  if (singleLegacyAudit(deps)) {
    const result = await deps.audit.read(filter)
    return renderAudit(valueOf(result), failureOf(result), filter, agentOptions)
  }
  return renderAuditSources(
    await readAuditSources(deps, filter),
    filter,
    agentOptions,
  )
}

async function chainFragment(
  deps: ConsoleDeps,
  traceId: string,
  node: string | undefined,
): Promise<string> {
  const source = auditSourceOf(deps, node)
  if (source === undefined) {
    return failureBar(
      {
        code: node === undefined ? 'invalid' : 'not_found',
        message:
          node === undefined ? '多链审计详情必须给出 node' : '未配置该审计节点',
      },
      '读取消息链失败',
    )
  }
  const result = await source.audit.chain(traceId)
  // `renderChain` takes no failure argument — a chain either reconstructs or
  // it does not — so an unreadable trail borrows the same red strip the other
  // two fragments show. Answering this route with JSON instead would hand the
  // client something it cannot put in the DOM.
  return result.ok
    ? renderChain(result.value)
    : failureBar(result.failure, '读取消息链失败')
}

async function handleAudit(ctx: RouteContext): Promise<Response> {
  const { request, deps, url, now } = ctx
  const denied = guard(ctx.access.credential, 'view', 'guarded')
  if (denied !== null) return denied
  if (request.method !== 'GET') return methodNotAllowed(['GET'])
  const requestedNode = textParam(url.searchParams, 'node')
  const source = auditSourceOf(deps, requestedNode)
  if (source !== undefined) {
    const result = await source.audit.read(parseAuditFilter(url, now))
    return result.ok ? json(result.value) : failureResponse(result.failure)
  }
  if (requestedNode !== undefined) {
    return fail(404, 'not_found', '未配置该审计节点')
  }
  const sources = await readAuditSources(deps, parseAuditFilter(url, now))
  return json({ audits: sources })
}

async function handleChain(
  ctx: RouteContext,
  traceId: string,
  node: string | undefined,
): Promise<Response> {
  const denied = guard(ctx.access.credential, 'view', 'guarded')
  if (denied !== null) return denied
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const source = auditSourceOf(ctx.deps, node)
  if (source === undefined) {
    return fail(
      node === undefined ? 400 : 404,
      node === undefined ? 'invalid' : 'not_found',
      node === undefined ? '多链审计详情必须给出 node' : '未配置该审计节点',
    )
  }
  const result = await source.audit.chain(traceId)
  // A trace with no records is `{ chain: null }` and a 200: "that trace is not
  // in this trail" is an answer, not a failure of the lookup.
  return result.ok
    ? json({ chain: result.value })
    : failureResponse(result.failure)
}

/**
 * The query string that reproduces a filter: what the poller replays.
 *
 * The *window* is replayed rather than the instant it resolved to, so "the
 * last hour" keeps meaning the last hour five minutes later.
 */
function auditQuery(filter: AuditFilter): string {
  const params = new URLSearchParams()
  const put = (key: string, value: string | number | undefined) => {
    if (value === undefined) return
    const text = String(value)
    if (text !== '') params.set(key, text)
  }
  put('source', filter.source)
  put('outcome', filter.outcome)
  put('traceId', filter.traceId)
  put('taskId', filter.taskId)
  put('agent', filter.agent)
  if (filter.window === undefined) {
    put('from', filter.from)
    put('to', filter.to)
  } else {
    put('window', filter.window)
  }
  put('limit', filter.limit)
  return params.toString()
}

/**
 * The trail page. Only the header digits and the results are polled
 * (`data-swap`): the filter form between them must survive a refresh with
 * whatever the operator was halfway through typing. The node filter offers
 * the addresses that exist, from the same registry read as the sidebar.
 */
async function auditPage(ctx: RouteContext): Promise<PageRender> {
  const { deps, url, now } = ctx
  const filter = parseAuditFilter(url, now)
  const [roster, trails] = await Promise.all([
    ctx.roster(),
    readAuditSources(deps, filter),
  ])
  const options = agentFilterOptions(valueOf(roster), filter.agent)
  const trail = singleLegacyAudit(deps)
    ? renderAudit(
        trails[0]?.page ?? null,
        trails[0]?.failure ?? null,
        filter,
        options,
      )
    : renderAuditSources(trails, filter, options)
  const query = auditQuery(filter)
  return {
    title: '消息链',
    body:
      `<section class="sec" id="trail-section">` +
      `<div id="audit" data-poll="${attr(
        `/fragments/audit${query === '' ? '' : `?${query}`}`,
      )}" data-swap="audit-rail audit-results">${trail}</div>` +
      `<div class="chain-panel" id="chain" hidden></div>` +
      `</section>`,
    poll: true,
  }
}

/**
 * One reconstructed chain, at its own address: what the inline panel shows,
 * as a page that can be linked and read without script. A trace the trail
 * does not hold is a 404 with the same "未找到" line the panel would show.
 */
async function tracePage(
  ctx: RouteContext,
  traceId: string,
): Promise<PageRender> {
  const node = textParam(ctx.url.searchParams, 'node')
  const source = auditSourceOf(ctx.deps, node)
  const crumbs = [{ label: traceId }]
  if (source === undefined) {
    return {
      title: '消息链详情',
      crumbs,
      body: `<section class="sec chain-panel trace-page">${await chainFragment(
        ctx.deps,
        traceId,
        node,
      )}</section>`,
      status: node === undefined ? 400 : 404,
    }
  }
  const result = await source.audit.chain(traceId)
  return {
    title: '消息链详情',
    crumbs,
    body: `<section class="sec chain-panel trace-page">${
      result.ok
        ? renderChain(result.value)
        : failureBar(result.failure, '读取消息链失败')
    }</section>`,
    ...(result.ok && result.value === null ? { status: 404 } : {}),
  }
}

/**
 * The chain view carries a 关闭 for the inline panel on the trail page; on
 * the trace's own page there is nothing to close it into, so it is not shown.
 */
const AUDIT_PAGE_CSS = `
.trace-page [data-action="chain-close"] { display: none; }
`

export const auditRoute: RouteModule = {
  area: {
    id: 'audit',
    label: '消息链',
    group: 'run',
    href: '/audit',
    icon: 'activity',
  },
  page: {
    match(segments) {
      if (segments[0] !== 'audit') return null
      if (segments.length === 1) return []
      return segments.length === 3 && segments[1] === 'trace'
        ? segments.slice(1)
        : null
    },
    guard: 'view',
    async render(ctx, rest) {
      if (rest.length === 0) return await auditPage(ctx)
      const traceId = safeDecode(rest[1] ?? '')
      return traceId === null
        ? notFound(`unknown trace: ${ctx.url.pathname}`)
        : await tracePage(ctx, traceId)
    },
    css: AUDIT_PAGE_CSS,
    script: AUDIT_PAGE_JS,
  },
  api: {
    heads: ['audit'],
    async handle(ctx, _head, rest) {
      if (rest.length === 0) return await handleAudit(ctx)
      if (rest.length === 2 && rest[0] === 'chain') {
        return await handleChain(
          ctx,
          decodeURIComponent(rest[1] ?? ''),
          textParam(ctx.url.searchParams, 'node'),
        )
      }
      return notFound(`unknown path: ${ctx.url.pathname}`)
    },
  },
  fragments: {
    heads: ['audit', 'chain'],
    async handle(ctx, head, rest) {
      const isChain = head === 'chain' && rest.length === 1
      if (!isChain && !(head === 'audit' && rest.length === 0)) {
        return notFound(`unknown path: ${ctx.url.pathname}`)
      }
      const denied = guard(ctx.access.credential, 'view', 'guarded')
      if (denied !== null) return denied
      if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
      if (isChain) {
        return html(
          await chainFragment(
            ctx.deps,
            decodeURIComponent(rest[0] ?? ''),
            textParam(ctx.url.searchParams, 'node'),
          ),
        )
      }
      return html(
        await auditFragment(ctx.deps, parseAuditFilter(ctx.url, ctx.now)),
      )
    },
  },
}
