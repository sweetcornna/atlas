// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 告警 — the inbox (J5): notices from watch jobs and the conditions this
 * console can see, with an unread badge, a level filter and acknowledgement.
 *
 * Owns the `/alerts` page, `/v0/alerts`, `/v0/alerts/<id>/ack` and
 * `/fragments/alerts`. What goes into the inbox and why is `view/alerts.ts`;
 * this file reads the ports and enforces who may do what.
 *
 * ## An id is acknowledged only if it is in the inbox right now
 *
 * `POST /v0/alerts/<id>/ack` recomputes the inbox and answers 404 for an id
 * that is not in it, before the ledger is asked and before anything is
 * written. The same rule the server notes keep with their allowlist: a caller
 * holding a writer's credential cannot grow the acknowledgement store by typing
 * strings into a URL. The refusal is recorded (`alert.ack`, `refused`), the
 * role-gate refusals are not (`deps.ts`, `ActionOutcome`).
 *
 * ## Without script
 *
 * The inbox is server-rendered and the filter is a `GET` form, so reading and
 * filtering work with script off. Acknowledging needs the console header that
 * only a script can add (`auth.ts`), so the page says so where the buttons are.
 */

import type { Access } from '../access.js'
import { fail, html, json, methodNotAllowed, notFound } from '../respond.js'
import {
  ALERTS_PAGE_CSS,
  NOTICE_LIMIT,
  alertBoard,
  alertQuery,
  filterAlerts,
  parseAlertFilter,
  renderAlertFilter,
  renderAlertInbox,
  renderAlertSources,
  type AlertBoard,
} from '../view/alerts.js'
import { attr } from '../view/escape.js'
import type { ConsoleFailure } from '../deps.js'
import {
  canWrite,
  failureOf,
  failureResponse,
  guard,
  outcomeOf,
  readAuditSources,
  readOnlyNote,
  safeDecode,
  underPath,
} from './shared.js'
import type { PageRender, RouteContext, RouteModule } from './types.js'

/**
 * Longest id the acknowledge route will look up. Every id the inbox mints is
 * far shorter; anything longer is not one of them and is refused as input
 * before the inbox is computed.
 */
const MAX_ALERT_ID = 256

const ACKS_UNSUPPORTED = '该控制台没有接入告警存储 · 不能确认告警'

const ACKS_UNREADABLE = '确认记录读不出来 · 暂时不能确认'

const ALERT_GONE = '这条告警不在当前列表里 · 它描述的情况可能已经消失'

/** The inbox, and the registry failure the page states above it. */
interface Inbox {
  readonly board: AlertBoard
  readonly rosterFailure: ConsoleFailure | null
}

/**
 * Read every source the inbox is made of, overlapped: none depends on
 * another, and the slowest of them (a trail with a witness) sets the pace.
 * The registry is `ctx.roster()`, the read the sidebar shares.
 */
async function inboxOf(ctx: RouteContext): Promise<Inbox> {
  const { deps, now } = ctx
  const notify = deps.notify
  const certificates = deps.certificates
  const [roster, snapshot, audits, notices, acks] = await Promise.all([
    ctx.roster(),
    certificates?.read(),
    // Only the verdicts are wanted; the port still reads the whole trail.
    readAuditSources(deps, { limit: 1 }),
    notify?.notices(NOTICE_LIMIT),
    notify?.acks(),
  ])
  const board = alertBoard({
    now,
    ttlMs: deps.limits.registryTtlMs,
    roster,
    ...(certificates === undefined || snapshot === undefined
      ? {}
      : { certificates: { snapshot, roots: certificates.roots() } }),
    audits,
    ...(notices === undefined ? {} : { notices }),
    ...(acks === undefined ? {} : { acks }),
  })
  return { board, rosterFailure: failureOf(roster) }
}

/** The acknowledge buttons are drawn for a writer, on a console that records them. */
function canAck(access: Access, board: AlertBoard): boolean {
  return canWrite(access) && board.ackable
}

function inboxFragment(ctx: RouteContext, inbox: Inbox): string {
  return renderAlertInbox({
    board: inbox.board,
    filter: parseAlertFilter(ctx.url.searchParams),
    now: ctx.now,
    canAck: canAck(ctx.access, inbox.board),
    rosterFailure: inbox.rosterFailure,
  })
}

/** What a writer is told where the buttons are, when script is off. */
const NO_SCRIPT_LINE = '确认需要启用脚本 · 阅读与筛选不受影响'

async function alertsPage(ctx: RouteContext): Promise<PageRender> {
  const filter = parseAlertFilter(ctx.url.searchParams)
  const inbox = await inboxOf(ctx)
  const query = alertQuery(filter)
  const ackable = canAck(ctx.access, inbox.board)
  return {
    title: '告警',
    ...(canWrite(ctx.access)
      ? {}
      : { actions: readOnlyNote(ctx.accounts !== undefined) }),
    body:
      `<section class="sec" id="alerts-section">` +
      renderAlertFilter(filter) +
      (ackable
        ? `<noscript><p class="note">${NO_SCRIPT_LINE}</p></noscript>`
        : '') +
      `<div id="alerts" data-poll="${attr(
        `/fragments/alerts${query === '' ? '' : `?${query}`}`,
      )}">${inboxFragment(ctx, inbox)}</div>` +
      `</section>` +
      renderAlertSources(inbox.board.sources),
    poll: true,
  }
}

async function handleList(ctx: RouteContext): Promise<Response> {
  const denied = guard(ctx.access.credential, 'view', 'guarded')
  if (denied !== null) return denied
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const { board } = await inboxOf(ctx)
  const filter = parseAlertFilter(ctx.url.searchParams)
  return json({
    unread: board.unread,
    total: board.alerts.length,
    alerts: filterAlerts(board.alerts, filter),
    sources: board.sources,
  })
}

/** Who an acknowledgement is recorded under: the ledger's spelling. */
function subjectOf(access: Access): string {
  return access.principal?.subject ?? 'legacy:admin'
}

async function handleAck(ctx: RouteContext, raw: string): Promise<Response> {
  const denied = guard(ctx.access.credential, 'admin', 'guarded')
  if (denied !== null) return denied
  if (ctx.request.method !== 'POST') return methodNotAllowed(['POST'])
  const notify = ctx.deps.notify
  if (notify === undefined) return fail(501, 'unsupported', ACKS_UNSUPPORTED)
  const id = safeDecode(raw)
  if (id === null || id === '' || id.length > MAX_ALERT_ID) {
    await ctx.record(
      'alert.ack',
      (id ?? raw).slice(0, MAX_ALERT_ID),
      'refused',
      'invalid',
    )
    return fail(400, 'invalid', '告警 id 不合法')
  }
  const { board } = await inboxOf(ctx)
  const alert = board.alerts.find(one => one.id === id)
  if (alert === undefined) {
    await ctx.record('alert.ack', id, 'refused', 'not_found')
    return fail(404, 'not_found', ALERT_GONE)
  }
  if (!board.ackable) return fail(503, 'unreachable', ACKS_UNREADABLE)
  const blocked = await ctx.admit()
  if (blocked !== null) return blocked
  const result = await notify.ack(id, subjectOf(ctx.access))
  await ctx.record('alert.ack', id, ...outcomeOf(result))
  if (!result.ok) return failureResponse(result.failure)
  return json({
    ack: { id: result.value.id, at: result.value.at },
    unread: board.unread - (alert.ackedAt === undefined ? 1 : 0),
  })
}

/** 告警: acknowledge one entry, and keep the badge in step with the list. */
const ALERTS_PAGE_JS = `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  if (!qc) return;

  function paintUnread(count) {
    var badge = qc.byId('alerts-unread');
    if (!badge || typeof count !== 'number') return;
    badge.textContent = '未确认 ' + count;
    badge.setAttribute('data-unread', String(count));
    if (count === 0) badge.setAttribute('data-zero', '');
    else badge.removeAttribute('data-zero');
  }

  // The row goes away with the refresh that follows (the default view is the
  // unacknowledged ones), so the result is said in the corner, and the badge
  // is painted from the answer at once rather than after the round trip.
  function onAck(el) {
    var id = el.getAttribute('data-alert') || '';
    if (!id) return;
    el.disabled = true;
    qc.sendJson('POST', '/v0/alerts/' + encodeURIComponent(id) + '/ack')
      .then(function (data) {
        paintUnread(data ? data.unread : undefined);
        qc.toast('已确认', 'ok');
        var mount = qc.byId('alerts');
        return mount ? qc.refreshRegion(mount) : null;
      })
      .catch(function (err) {
        el.disabled = false;
        qc.toast('确认失败 · ' + qc.message(err), 'bad');
      });
  }

  qc.onAction('alert-ack', onAck);

  // The filter is a native GET and stays one. All that is added is leaving
  // out an unset level, so the URL is the shortest one for this view.
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || form.id !== 'alerts-filter') return;
    var level = form.querySelector('input[name="level"]:checked');
    if (level && level.value === '') level.disabled = true;
  });
})();
`

export const alertsRoute: RouteModule = {
  area: {
    id: 'alerts',
    label: '告警',
    group: 'run',
    href: '/alerts',
    icon: 'bell',
  },
  page: {
    match: underPath('alerts'),
    guard: 'view',
    async render(ctx) {
      return await alertsPage(ctx)
    },
    css: ALERTS_PAGE_CSS,
    script: ALERTS_PAGE_JS,
  },
  api: {
    heads: ['alerts'],
    async handle(ctx, _head, rest) {
      if (rest.length === 0) return await handleList(ctx)
      if (rest.length === 2 && rest[1] === 'ack') {
        return await handleAck(ctx, rest[0] ?? '')
      }
      return notFound(`unknown path: ${ctx.url.pathname}`)
    },
  },
  fragments: {
    heads: ['alerts'],
    async handle(ctx, _head, rest) {
      if (rest.length !== 0) {
        return notFound(`unknown path: ${ctx.url.pathname}`)
      }
      const denied = guard(ctx.access.credential, 'view', 'guarded')
      if (denied !== null) return denied
      if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
      return html(inboxFragment(ctx, await inboxOf(ctx)))
    },
  },
}
