// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The route table: every area of the console, in sidebar order.
 *
 * `http.ts` dispatches `/v0/<head>` and `/fragments/<head>` to the one module
 * that claims the head, and every other path to the first module whose page
 * matches it. A head claimed twice is a bug the table refuses at load time
 * rather than a route that silently goes to whichever module came first.
 *
 * This file also turns a page's {@link PageRender} into the whole document:
 * the sidebar (which areas this caller may see, with their counts), the
 * breadcrumb (group, area, then the page's own), the health strip, and the
 * page's own CSS and script. A page module therefore never draws any of the
 * frame, and two page packages never edit the same file to change their own
 * page.
 */

import type { ConsoleAgent, ConsoleResult } from '../deps.js'
import { nodeCount } from '../view/agents.js'
import type { Tone } from '../view/bits.js'
import { escapeHtml } from '../view/escape.js'
import {
  renderShell,
  type Crumb,
  type ShellHealth,
  type ShellNavGroup,
} from '../view/shell.js'
import { accessRoute } from './access.js'
import { alertsRoute } from './alerts.js'
import { approvalsRoute } from './approvals.js'
import { auditRoute } from './audit.js'
import { chatRoute } from './chat.js'
import { jobsRoute } from './jobs.js'
import { nodesRoute } from './nodes.js'
import { overviewRoute } from './overview.js'
import { providersRoute } from './providers.js'
import { serversRoute } from './servers.js'
import { settingsRoute } from './settings.js'
import { DEFAULT_LABEL, guardChat, loginHref } from './shared.js'
import type {
  AreaGroup,
  HeadRoute,
  PageRender,
  PageRoute,
  RouteContext,
  RouteModule,
} from './types.js'
import { usageRoute } from './usage.js'

/** Every area of §6.1, in the order the sidebar draws them. */
export const ROUTES: readonly RouteModule[] = [
  overviewRoute,
  nodesRoute,
  chatRoute,
  auditRoute,
  alertsRoute,
  jobsRoute,
  approvalsRoute,
  providersRoute,
  serversRoute,
  accessRoute,
  usageRoute,
  settingsRoute,
]

/** Index the heads of one kind, refusing a head that two modules claim. */
export function headIndex(
  modules: readonly RouteModule[],
  pick: (module: RouteModule) => HeadRoute | undefined,
  reserved: readonly string[] = [],
): ReadonlyMap<string, HeadRoute> {
  const index = new Map<string, HeadRoute>()
  for (const module of modules) {
    const route = pick(module)
    if (route === undefined) continue
    for (const head of route.heads) {
      if (index.has(head) || reserved.includes(head)) {
        throw new Error(`route head claimed twice: ${head}`)
      }
      index.set(head, route)
    }
  }
  return index
}

/**
 * First path segments no page may answer: the two prefixes and the built-in
 * doors `http.ts` serves before any page is consulted.
 */
export const RESERVED_PAGE_HEADS: readonly string[] = [
  'v0',
  'fragments',
  'assets',
  'login',
  'logout',
  'invite',
]

/** A page that answers a path, and the segments after its area's own. */
export interface PageMatch {
  readonly module: RouteModule
  readonly page: PageRoute
  readonly rest: readonly string[]
}

/** The first module whose page answers `segments`, if any. */
export function pageOf(
  modules: readonly RouteModule[],
  segments: readonly string[],
): PageMatch | undefined {
  const head = segments[0]
  if (head !== undefined && RESERVED_PAGE_HEADS.includes(head)) return undefined
  for (const module of modules) {
    const page = module.page
    if (page === undefined) continue
    const rest = page.match(segments)
    if (rest !== null) return { module, page, rest }
  }
  return undefined
}

const GROUP_LABELS: Readonly<Record<AreaGroup, string>> = {
  run: '运行',
  config: '配置',
  admin: '管理',
}

const GROUP_ORDER: readonly AreaGroup[] = ['run', 'config', 'admin']

/**
 * Whether this caller sees an area in the sidebar at all.
 *
 * Decided by the page's own rules, so the sidebar and the URL cannot
 * disagree: an area whose page does not exist here (`available`) or whose
 * guard would refuse this caller is not offered. 对话 is the case that matters
 * — a view token must not learn that a conversation channel exists
 * (`routes/chat.ts`), and a link that 403s on click leaks exactly that.
 */
function visibleTo(module: RouteModule, ctx: RouteContext): boolean {
  const page = module.page
  if (page === undefined) return false
  if (page.available?.(ctx) === false) return false
  if (page.guard === 'chat') return guardChat(ctx.access, 'document') === null
  return true
}

/**
 * How many nodes the registry lists — nodes, not agents (A5): three agents
 * on two machines is 2 beside 节点. Nothing when the registry could not say,
 * rather than a 0 that reads as "no nodes".
 */
function nodesCount(
  listed: ConsoleResult<readonly ConsoleAgent[]>,
): number | undefined {
  return listed.ok ? nodeCount(listed.value) : undefined
}

/** The sidebar for this caller, with the counts that are honest to show. */
export function navFor(
  ctx: RouteContext,
  listed: ConsoleResult<readonly ConsoleAgent[]>,
  modules: readonly RouteModule[] = ROUTES,
): readonly ShellNavGroup[] {
  return GROUP_ORDER.map(group => ({
    label: GROUP_LABELS[group],
    items: modules
      .filter(module => module.area.group === group && visibleTo(module, ctx))
      .map(module => {
        const count =
          module.area.id === 'nodes' ? nodesCount(listed) : undefined
        return {
          id: module.area.id,
          label: module.area.label,
          href: module.area.href,
          icon: module.area.icon,
          ...(count === undefined ? {} : { count }),
          ...(module.area.pending === true ? { pending: true } : {}),
        }
      }),
  }))
}

/**
 * The top bar's health strip. The registry is the one dependency every page
 * already read for the sidebar, so it is the one badge that costs nothing and
 * is never stale against the page under it.
 */
function healthOf(
  listed: ConsoleResult<readonly ConsoleAgent[]>,
): readonly ShellHealth[] {
  const tone: Tone = listed.ok ? 'ok' : 'bad'
  return [{ label: listed.ok ? '注册中心' : '注册中心不可达', tone }]
}

/** The breadcrumb: the group, the area, then whatever the page adds. */
function crumbsOf(module: RouteModule, render: PageRender): readonly Crumb[] {
  const group: Crumb = { label: GROUP_LABELS[module.area.group] }
  if (render.crumbs === undefined || render.crumbs.length === 0) {
    return [group, { label: module.area.label }]
  }
  return [
    group,
    { label: module.area.label, href: module.area.href },
    ...render.crumbs,
  ]
}

/** One page, drawn in the shell. */
export async function areaDocument(
  ctx: RouteContext,
  module: RouteModule,
  render: PageRender,
): Promise<string> {
  const listed = await ctx.roster()
  return renderShell({
    label: ctx.deps.label ?? DEFAULT_LABEL,
    role: ctx.access.credential.role,
    ...(ctx.viewer === undefined ? {} : { viewer: ctx.viewer }),
    nav: navFor(ctx, listed),
    active: render.active ?? module.area.id,
    crumbs: crumbsOf(module, render),
    title: render.title,
    ...(render.actions === undefined ? {} : { actions: render.actions }),
    body: render.body,
    health: healthOf(listed),
    relogin: loginHref(ctx.url),
    ...(render.poll === true ? { poll: true } : {}),
    ...(module.page?.css === undefined ? {} : { pageCss: module.page.css }),
    ...(module.page?.script === undefined
      ? {}
      : { pageScript: module.page.script }),
  })
}

/** One error, as the shell draws it: the nav, the title, one line, the way back. */
export async function errorDocument(
  ctx: RouteContext,
  title: string,
  line: string,
): Promise<string> {
  const listed = await ctx.roster()
  return renderShell({
    label: ctx.deps.label ?? DEFAULT_LABEL,
    role: ctx.access.credential.role,
    ...(ctx.viewer === undefined ? {} : { viewer: ctx.viewer }),
    nav: navFor(ctx, listed),
    crumbs: [{ label: title }],
    title,
    body:
      `<section class="card elev-sm stub" aria-labelledby="page-title">` +
      `<p class="note">${escapeHtml(line)}</p>` +
      `<p><a class="jump" href="/" data-nav>回到总览</a></p>` +
      `</section>`,
    health: healthOf(listed),
    relogin: loginHref(ctx.url),
  })
}
