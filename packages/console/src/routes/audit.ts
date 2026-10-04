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
 * write it.
 *
 * ## Newest first, a page at a time, and a poll that carries only news (D5, G2)
 *
 * The page shows the newest {@link AUDIT_PAGE_LIMIT} matches, newest on top.
 * 加载更早 is a link with `before=<seq>` — the cursor `AuditPort` hands out
 * as `earlier` — so older pages work without script and never repeat or skip
 * a line, however much is appended meanwhile. `node=` narrows a page of
 * several trails to one, which is what a cursor needs: a `seq` belongs to
 * one chain.
 *
 * The poll asks for what arrived since the page was drawn — `since=<head>`,
 * or `since=<node>:<head>` once per trail — and gets the header and those
 * rows (`renderAuditFresh`), never the page again. The cursor in the poll URL
 * does not move, so the page needs no script to keep one; a burst of more
 * than a page, or a trail that got shorter, turns into a reload link. A port
 * that does not page (no `head`; a test double) gets the old whole-fragment
 * poll.
 */

import { AUDIT_PAGE_JS } from '../assets/pageScripts.js'
import type {
  AuditFilter,
  AuditPort,
  ConsoleAuditSource,
  ConsoleDeps,
} from '../deps.js'
import { fail, html, json, methodNotAllowed, notFound } from '../respond.js'
import { agentFilterOptions, wakeAvailable } from '../view/agents.js'
import {
  AUDIT_PAGE_LIMIT,
  AUDIT_WINDOWS,
  renderAudit,
  renderAuditFresh,
  renderAuditRail,
  renderAuditSources,
  renderAuditSourcesRail,
  renderChain,
  type AuditSourceRender,
  type TrailArrival,
  type TrailPaging,
} from '../view/audit.js'
import { failureBar } from '../view/bits.js'
import { attr } from '../view/escape.js'
import {
  auditSourceOf,
  canWrite,
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
 * A cursor: an audit `seq`, digits only. Anything else reads as "not given",
 * for the same reason a half-typed date does — and the port refuses the
 * negative and fractional values a script might send.
 */
function parseSeq(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return Number.isSafeInteger(value) ? value : undefined
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
    q?: string
    before?: number
    since?: number
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

  const q = textParam(params, 'q')
  if (q !== undefined) filter.q = q
  // The cursors (D5). `since` here is the bare form, one trail's; the
  // several-trail page writes `since=<node>:<seq>`, read by `sinceByNode`.
  const before = parseSeq(params.get('before'))
  if (before !== undefined) filter.before = before
  const since = parseSeq(params.get('since'))
  if (since !== undefined) filter.since = since

  return filter
}

/** `since=<node>:<seq>`, once per trail of a several-trail page. */
function sinceByNode(params: URLSearchParams): ReadonlyMap<string, number> {
  const out = new Map<string, number>()
  for (const raw of params.getAll('since')) {
    const cut = raw.lastIndexOf(':')
    if (cut <= 0) continue
    const seq = parseSeq(raw.slice(cut + 1))
    if (seq !== undefined) out.set(raw.slice(0, cut), seq)
  }
  return out
}

/** One trail the page can show, with its position among the configured ones. */
interface Trail {
  readonly source: ConsoleAuditSource
  /** Absent for the single legacy trail (`deps.audit` alone). */
  readonly slot?: number
}

/**
 * The trails a view shows: the single legacy one, every configured one, or
 * the one `node=` names. `null` when `node=` names none of them.
 */
function trailsOf(deps: ConsoleDeps, node: string | undefined): Trail[] | null {
  if (singleLegacyAudit(deps)) {
    return [{ source: { node: '', audit: deps.audit, kind: 'authoritative' } }]
  }
  const all = (deps.audits ?? []).map((source, slot) => ({ source, slot }))
  if (node === undefined) return all
  const one = all.filter(trail => trail.source.node === node)
  return one.length === 0 ? null : one
}

/** One trail read for a view: the page's tail, unless the filter names one. */
async function readTrailFor(
  trail: Trail,
  filter: AuditFilter,
): Promise<AuditSourceRender> {
  const { source } = trail
  const audit: AuditPort = source.audit
  const result = await audit.read({
    ...filter,
    limit: filter.limit ?? AUDIT_PAGE_LIMIT,
  })
  return {
    node: source.node,
    kind: source.kind,
    ...(source.maxLagMinutes === undefined
      ? {}
      : { maxLagMinutes: source.maxLagMinutes }),
    ...(trail.slot === undefined ? {} : { slot: trail.slot }),
    page: valueOf(result),
    failure: failureOf(result),
  }
}

/** What a paged view of the trail renders into, and how it is kept fresh. */
interface TrailRegion {
  readonly html: string
  /** The fragment URL the page polls. */
  readonly poll: string
  /** The ids the poll swaps (`data-swap`). */
  readonly swap: string
  readonly status?: number
}

/** The parameters of a view that are not the filter: which trail, which page. */
function viewOf(url: URL, now: number) {
  const filter = parseAuditFilter(url, now)
  const node = textParam(url.searchParams, 'node')
  const { since: _since, ...rest } = filter
  return { filter: rest, node }
}

/**
 * The trail as a page shows it, and the poll that keeps it current.
 *
 * `before` pages back. On a view of several trails it needs `node=`, because
 * a `seq` belongs to one chain; without it the newest page of every trail is
 * shown and the cursor is ignored.
 */
async function trailRegion(
  deps: ConsoleDeps,
  url: URL,
  now: number,
  agentOptions?: string,
  wake?: string,
): Promise<TrailRegion> {
  const view = viewOf(url, now)
  const legacy = singleLegacyAudit(deps)
  const trails = trailsOf(deps, view.node)
  const query = auditQuery(view.filter, legacy ? undefined : view.node)
  if (trails === null) {
    return {
      html: failureBar(
        { code: 'not_found', message: '未配置该审计节点' },
        '读取审计链失败',
      ),
      poll: '',
      swap: '',
      status: 404,
    }
  }
  const { before, ...newest } = view.filter
  const narrowed = legacy || view.node !== undefined
  const filter: AuditFilter =
    narrowed && before !== undefined ? { ...newest, before } : newest
  const reads = await Promise.all(
    trails.map(trail => readTrailFor(trail, filter)),
  )
  const paging: TrailPaging = {
    query,
    fresh: filter.before === undefined,
    ...(wake === undefined ? {} : { wake }),
  }
  const body = legacy
    ? renderAudit(
        reads[0]?.page ?? null,
        reads[0]?.failure ?? null,
        view.filter,
        agentOptions,
        paging,
      )
    : renderAuditSources(reads, view.filter, agentOptions, paging)

  // The increment needs every trail's head; a port that does not page gets
  // the whole fragment polled, as before.
  const heads = reads.map(read => read.page?.head)
  const paged = reads.every(
    read => read.page === null || read.page.head !== undefined,
  )
  if (!paged) {
    return {
      html: body,
      poll: `/fragments/audit${query === '' ? '' : `?${query}`}`,
      swap: 'audit-rail audit-results',
    }
  }
  const params = new URLSearchParams(query)
  for (const [index, read] of reads.entries()) {
    const head = heads[index]
    if (head === undefined) continue
    params.append('since', legacy ? String(head) : `${read.node}:${head}`)
  }
  const fresh = paging.fresh
    ? reads
        .filter(read => read.page !== null)
        .map(read =>
          read.slot === undefined ? 'audit-fresh' : `audit-fresh-${read.slot}`,
        )
    : []
  return {
    html: body,
    poll: `/fragments/audit?${params.toString()}`,
    swap: ['audit-rail', ...fresh].join(' '),
  }
}

/** The poll's answer: the header, and what arrived on each trail since `since`. */
async function trailIncrement(
  deps: ConsoleDeps,
  url: URL,
  now: number,
): Promise<string> {
  const view = viewOf(url, now)
  const legacy = singleLegacyAudit(deps)
  const trails = trailsOf(deps, view.node) ?? []
  const bare = parseAuditFilter(url, now).since
  const byNode = sinceByNode(url.searchParams)
  const { before: _before, ...filter } = view.filter
  const reads = await Promise.all(
    trails.map(async trail => {
      const since = legacy ? bare : byNode.get(trail.source.node)
      // A trail the page holds no head for is read for its header only.
      const read = await readTrailFor(
        trail,
        since === undefined ? { ...filter, limit: 1 } : { ...filter, since },
      )
      return { read, since }
    }),
  )
  const arrivals: TrailArrival[] = []
  for (const { read, since } of reads) {
    if (since === undefined) continue
    arrivals.push({
      ...(read.slot === undefined ? {} : { slot: read.slot }),
      ...(legacy ? {} : { node: read.node }),
      page: read.page,
      since,
    })
  }
  const query = auditQuery(view.filter, legacy ? undefined : view.node)
  const rail = legacy
    ? renderAuditRail(reads[0]?.read.page ?? null)
    : renderAuditSourcesRail(reads.map(({ read }) => read))
  return (
    rail +
    renderAuditFresh(arrivals, `/audit${query === '' ? '' : `?${query}`}`)
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
function auditQuery(filter: AuditFilter, node?: string): string {
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
  put('q', filter.q)
  put('node', node)
  return params.toString()
}

/** Where an empty trail may send this reader to wake an agent, if anywhere (C6). */
function wakeEntry(ctx: RouteContext): string | undefined {
  return canWrite(ctx.access) && wakeAvailable(ctx.deps) ? '/nodes' : undefined
}

/**
 * The trail page. Only the header and the fresh rows are polled
 * (`data-swap`): the filter form must survive a refresh with whatever the
 * operator was halfway through typing, and the rows already on the page —
 * 加载更早 included — are not fetched again. The node filter offers the
 * addresses that exist, from the same registry read as the sidebar.
 */
async function auditPage(ctx: RouteContext): Promise<PageRender> {
  const { url, now } = ctx
  const filter = parseAuditFilter(url, now)
  const roster = await ctx.roster()
  const options = agentFilterOptions(valueOf(roster), filter.agent)
  const region = await trailRegion(ctx.deps, url, now, options, wakeEntry(ctx))
  return {
    title: '消息链',
    body:
      `<section class="sec" id="trail-section">` +
      (region.poll === ''
        ? `<div id="audit">${region.html}</div>`
        : `<div id="audit" data-poll="${attr(region.poll)}" data-swap="${attr(
            region.swap,
          )}">${region.html}</div>`) +
      `<div class="chain-panel" id="chain" hidden></div>` +
      `</section>`,
    poll: region.poll !== '',
    ...(region.status === undefined ? {} : { status: region.status }),
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
 *
 * The rest is paging (D5): the rows that arrived since the page was drawn
 * carry a rule on their left edge, 加载更早 sits centred under its table, and
 * an empty trail's waiting table stays out of sight until a row lands in it.
 */
const AUDIT_PAGE_CSS = `
.trace-page [data-action="chain-close"] { display: none; }
.audit-search { min-width: 14rem; flex: 1 1 14rem; }
.trail-fresh tr td:first-child { box-shadow: inset 2px 0 0 var(--color-accent-2-400); }
.trail-fresh .fresh-note td { color: var(--color-muted); text-align: center; }
.trail-more, .trail-end { display: flex; justify-content: center; margin: var(--space-3) 0 0; }
.trail-more[aria-busy="true"] { opacity: .6; }
.fresh-only:has(tbody.trail-fresh:empty) { display: none; }
.fresh-only:not(:has(tbody.trail-fresh:empty)) + .empty { display: none; }
`

/**
 * 加载更早 with script on: the link's own view, fetched as a fragment, and
 * its rows and its new 加载更早 put under the ones already on the page —
 * parsed in a detached `<template>` (inert) and moved, never re-serialised,
 * the same way the runtime swaps a polled region. With script off the link
 * is a link, and the older page is a page.
 */
const AUDIT_PAGING_JS = `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  if (!qc) return;

  function earlier(el) {
    var url = el.getAttribute('data-fragment') || '';
    var slot = el.getAttribute('data-slot');
    var suffix = slot === null ? '' : '-' + slot;
    var more = el.closest('.trail-more');
    if (!url || !more) return;
    if (more.getAttribute('aria-busy') === 'true') return;
    more.setAttribute('aria-busy', 'true');
    qc.loadHtml(url).then(function (html) {
      var tpl = document.createElement('template');
      tpl.innerHTML = html;
      var rows = tpl.content.querySelector('#audit-rows' + suffix);
      var next = tpl.content.querySelector('#audit-more' + suffix);
      var target = qc.byId('audit-rows' + suffix);
      if (!rows || !target) throw new Error('没有找到这一页的记录');
      while (rows.firstChild) target.appendChild(rows.firstChild);
      if (next) more.replaceWith(next);
      else more.remove();
    }).catch(function (err) {
      more.removeAttribute('aria-busy');
      qc.toast('加载更早失败 · ' + qc.message(err), 'bad');
    });
  }

  qc.onAction('audit-earlier', earlier);
})();
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
    script: AUDIT_PAGE_JS + AUDIT_PAGING_JS,
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
      if (ctx.url.searchParams.has('since')) {
        return html(await trailIncrement(ctx.deps, ctx.url, ctx.now))
      }
      const region = await trailRegion(
        ctx.deps,
        ctx.url,
        ctx.now,
        undefined,
        wakeEntry(ctx),
      )
      return html(region.html, region.status ?? 200)
    },
  },
}
