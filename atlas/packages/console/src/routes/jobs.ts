// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 主动执行 — the turns the hub starts by itself: the schedules a person sets
 * up here (P24, `directions-2026-10.md` §7) and, under them, the watch jobs
 * the hub fires from `qm watch` (J6), which stay read-only.
 *
 * Owns the `/jobs` page, `/v0/jobs` and `/fragments/jobs` (the watch jobs),
 * `/fragments/schedules` (the schedules, runs and channels) and, through
 * {@link schedulesApi} when the host wires it, `/v0/schedules` and
 * `/v0/channels`. The emergency stop is still pulled and released by creating
 * and removing its file (`console.md` §10.2); this page states which way it is
 * set rather than offering a switch.
 *
 * ## The API heads are a table
 *
 * `/v0/<head>` handlers of this area are looked up by head in {@link API},
 * so a second head of the area — P17.4's `handoff` — is one more line in that
 * table rather than a second `api` field to reconcile with this one
 * (`routes/types.ts`: a module has exactly one).
 */

import { fail, html, json, methodNotAllowed, notFound } from '../respond.js'
import {
  JOBS_PAGE_CSS,
  renderJobs,
  renderJobsUnavailable,
} from '../view/jobs.js'
import { KIT_CSS, actionButton } from '../view/kit.js'
import {
  channelDialog,
  renderSchedules,
  renderSchedulesUnavailable,
  SCHEDULES_PAGE_CSS,
  scheduleConfirms,
  scheduleDialog,
} from '../view/schedules.js'
import { SCHEDULES_PAGE_JS } from '../view/schedulesScript.js'
import { canMember, canOps } from './directionShared.js'
import { handoffApi } from './handoff.js'
import { schedulesApi } from './schedulesApi.js'
import { failureResponse, guard, readOnlyNote, underPath } from './shared.js'
import type { RouteContext, RouteModule } from './types.js'

const JOBS_UNSUPPORTED = '该控制台没有接入值守作业的调度器状态'

/** The jobs fragment: the scheduler card and the table, or why there is none. */
async function jobsFragment(ctx: RouteContext): Promise<string> {
  const port = ctx.deps.scheduler
  if (port === undefined) return renderJobsUnavailable(null)
  const result = await port.read()
  return result.ok
    ? renderJobs(result.value, ctx.now)
    : renderJobsUnavailable(result.failure)
}

/** The schedules fragment: cards, schedules, runs and channels, or why not. */
async function schedulesFragment(ctx: RouteContext): Promise<string> {
  const port = ctx.deps.schedules
  if (port === undefined) return renderSchedulesUnavailable(null)
  const result = await port.snapshot()
  return result.ok
    ? renderSchedules(result.value, ctx.now, {
        member: canMember(ctx),
        ops: canOps(ctx),
      })
    : renderSchedulesUnavailable(result.failure)
}

async function handleJobs(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  if (rest.length !== 0) return notFound(`unknown path: ${ctx.url.pathname}`)
  const denied = guard(ctx.access.credential, 'view', 'guarded')
  if (denied !== null) return denied
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const port = ctx.deps.scheduler
  if (port === undefined) return fail(501, 'unsupported', JOBS_UNSUPPORTED)
  const result = await port.read()
  return result.ok ? json(result.value) : failureResponse(result.failure)
}

type HeadHandler = (
  ctx: RouteContext,
  rest: readonly string[],
) => Promise<Response>

/** `/v0/<head>` → handler, for every head this area answers. */
const API: Readonly<Record<string, HeadHandler>> = {
  jobs: handleJobs,
  // The local-to-cloud handoff (P17.4, `routes/handoff.ts`): a task the hub
  // holds, so it is answered by the area of tasks.
  handoff: (ctx, rest) => handoffApi.handle(ctx, 'handoff', rest),
  // P24: the schedules and their push channels.
  ...Object.fromEntries(
    schedulesApi.heads.map(head => [
      head,
      (ctx: RouteContext, rest: readonly string[]) =>
        schedulesApi.handle(ctx, head, rest),
    ]),
  ),
}

/** The dialogs, rendered once with the page and outside every polled region. */
async function dialogs(ctx: RouteContext): Promise<string> {
  const port = ctx.deps.schedules
  if (port === undefined || !canMember(ctx)) return ''
  const result = await port.snapshot()
  const snapshot = result.ok
    ? result.value
    : { targets: [], channels: [], templates: [] }
  return (
    scheduleDialog(snapshot) +
    (canOps(ctx) ? channelDialog() : '') +
    scheduleConfirms()
  )
}

export const jobsRoute: RouteModule = {
  area: {
    id: 'jobs',
    label: '主动执行',
    group: 'main',
    href: '/jobs',
    icon: 'calendar-clock',
  },
  page: {
    match: underPath('jobs'),
    guard: 'view',
    async render(ctx) {
      const wired = ctx.deps.schedules !== undefined
      const actions =
        wired && canMember(ctx)
          ? actionButton('schedule-new', '新建定时任务', {
              glyph: 'plus',
              tone: 'primary',
              small: false,
            })
          : wired
            ? readOnlyNote(ctx.accounts !== undefined)
            : undefined
      return {
        title: '主动执行',
        ...(actions === undefined ? {} : { actions }),
        body:
          `<div class="kit-pane" id="schedules" data-poll="/fragments/schedules">` +
          `${await schedulesFragment(ctx)}</div>` +
          `<section class="sec jobs-legacy" id="jobs-section" aria-labelledby="h-watch">` +
          `<div class="sec-head"><div><div class="kicker">值守作业</div>` +
          `<h2 id="h-watch">由 qm watch 触发的作业</h2></div>` +
          `<span class="note">只读 · 作业定义在中枢的作业文件里</span></div>` +
          `<div id="jobs" data-poll="/fragments/jobs">${await jobsFragment(
            ctx,
          )}</div></section>` +
          (await dialogs(ctx)),
        poll: true,
      }
    },
    css: JOBS_PAGE_CSS + KIT_CSS + SCHEDULES_PAGE_CSS,
    script: SCHEDULES_PAGE_JS,
  },
  api: {
    heads: Object.keys(API),
    async handle(ctx, head, rest) {
      const handler = API[head]
      return handler === undefined
        ? notFound(`unknown path: ${ctx.url.pathname}`)
        : await handler(ctx, rest)
    },
  },
  fragments: {
    heads: ['jobs', 'schedules'],
    async handle(ctx, head, rest) {
      if (rest.length !== 0) {
        return notFound(`unknown path: ${ctx.url.pathname}`)
      }
      const denied = guard(ctx.access.credential, 'view', 'guarded')
      if (denied !== null) return denied
      if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
      return html(
        head === 'schedules'
          ? await schedulesFragment(ctx)
          : await jobsFragment(ctx),
      )
    },
  },
}
