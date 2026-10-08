// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 值守作业 — the watch jobs the hub fires (J6): last and next fire, the
 * emergency stop, and whether the scheduler is visibly alive.
 *
 * Owns the `/jobs` page, `/v0/jobs` and `/fragments/jobs`. Read-only on
 * purpose: the emergency stop is still pulled and released by creating and
 * removing its file (`console.md` §10.2), and this page states which way it
 * is set rather than offering a switch.
 *
 * ## The API heads are a table
 *
 * `/v0/<head>` handlers of this area are looked up by head in {@link API},
 * so a second head of the 值守作业 area — P17.4's `handoff` — is one more
 * line in that table rather than a second `api` field to reconcile with this
 * one (`routes/types.ts`: a module has exactly one).
 */

import { fail, html, json, methodNotAllowed, notFound } from '../respond.js'
import {
  JOBS_PAGE_CSS,
  renderJobs,
  renderJobsUnavailable,
} from '../view/jobs.js'
import { handoffApi } from './handoff.js'
import { failureResponse, guard, underPath } from './shared.js'
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
}

export const jobsRoute: RouteModule = {
  area: {
    id: 'jobs',
    label: '值守作业',
    group: 'run',
    href: '/jobs',
    icon: 'calendar-clock',
  },
  page: {
    match: underPath('jobs'),
    guard: 'view',
    async render(ctx) {
      return {
        title: '值守作业',
        body:
          `<section class="sec" id="jobs-section">` +
          `<div id="jobs" data-poll="/fragments/jobs">${await jobsFragment(
            ctx,
          )}</div></section>`,
        poll: true,
      }
    },
    css: JOBS_PAGE_CSS,
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
    heads: ['jobs'],
    async handle(ctx, _head, rest) {
      if (rest.length !== 0) {
        return notFound(`unknown path: ${ctx.url.pathname}`)
      }
      const denied = guard(ctx.access.credential, 'view', 'guarded')
      if (denied !== null) return denied
      if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
      return html(await jobsFragment(ctx))
    },
  },
}
