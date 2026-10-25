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
 * This file also turns a page's {@link PageRender} into what the settings
 * card shows (`view/shell.ts`): the list (which areas this caller may see,
 * with their counts), the breadcrumb (group, area, then the page's own), the
 * health strip, and the page's own CSS and script. A page module therefore
 * never draws any of the frame, and two page packages never edit the same
 * file to change their own page.
 *
 * The same model is drawn two ways (P37.13): the whole document — the Work
 * face with the card open on the area (`routes/front.ts`, `renderUnderCard`)
 * — for a browser that navigates, and the area's parts, for the card's
 * runtime that moves between areas in place (`assets/nav.ts`,
 * `X-Qianmo-Partial`). Who may see what is decided once, before either: the
 * guard, the card's areas and the page itself are the same for both.
 */

import type { ConsoleAgent, ConsoleResult } from '../deps.js'
import { nodeCount } from '../view/agents.js'
import type { Tone } from '../view/bits.js'
import { escapeHtml } from '../view/escape.js'
import type { SourceLinks } from '../view/source.js'
import type { BackgroundTaskStatus } from '../directionPorts.js'
import {
  shellPartial,
  type Crumb,
  type SettingsCard,
  type ShellHealth,
  type ShellModel,
  type ShellNavGroup,
  type ShellNavState,
  type ShellPartial,
} from '../view/shell.js'
import { accessRoute } from './access.js'
import { alertsRoute } from './alerts.js'
import { approvalsRoute } from './approvals.js'
import { auditRoute } from './audit.js'
import { billingRoute } from './billing.js'
import { channelsRoute } from './im.js'
import { chatRoute } from './chat.js'
import { connectRoute } from './connect.js'
import { desktopRoute } from './desktop.js'
import { elevationRoute } from './elevation.js'
import { extensionsRoute } from './extensions.js'
import { filesRoute } from './files.js'
import { jobsRoute } from './jobs.js'
import { magpieRoute } from './magpie.js'
import { memoryRoute } from './memory.js'
import { nodesRoute } from './nodes.js'
import { overviewRoute } from './overview.js'
import { providersRoute } from './providers.js'
import { serversRoute } from './servers.js'
import { settingsRoute } from './settings.js'
import { setupPending, setupRoute } from './setup.js'
import { taskActorOf } from './tasksApi.js'
import { frontAvailable, renderUnderCard } from './front.js'
import { ADMIN_HOME, DEFAULT_LABEL, guard, guardChat } from './shared.js'
import type {
  AreaGroup,
  AreaId,
  HeadRoute,
  PageRender,
  PageRoute,
  RouteContext,
  RouteModule,
} from './types.js'
import { updatesRoute } from './updates.js'
import { usageRoute } from './usage.js'

/**
 * Every area, in the order the settings card lists them: what a person uses
 * every day first (对话 is the conversation front at `/`, the Work face under
 * the card, and not in its list; the rest live under `/admin`), then the
 * operator's areas, the ones looked at most often first. The page matcher
 * walks the same order, on the segments after `/admin`.
 */
export const ROUTES: readonly RouteModule[] = [
  chatRoute,
  jobsRoute,
  memoryRoute,
  channelsRoute,
  extensionsRoute,
  desktopRoute,
  providersRoute,
  magpieRoute,
  setupRoute,
  overviewRoute,
  nodesRoute,
  approvalsRoute,
  elevationRoute,
  alertsRoute,
  auditRoute,
  connectRoute,
  filesRoute,
  serversRoute,
  accessRoute,
  usageRoute,
  billingRoute,
  updatesRoute,
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
  'admin',
  'app',
  'code',
  'v0',
  'fragments',
  'assets',
  'login',
  'logout',
  'invite',
  'plans',
  'subscription',
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

/** The breadcrumb's first step for an area of the group, none for the everyday ones. */
const GROUP_LABELS: Readonly<Record<AreaGroup, string>> = {
  main: '',
  manage: '管理',
}

const GROUP_ORDER: readonly AreaGroup[] = ['main', 'manage']

/**
 * Whether this caller sees an area in the card at all.
 *
 * Decided by the page's own rules, so the card and the URL cannot
 * disagree: an area whose page does not exist here (`available`) or whose
 * guard would refuse this caller is not offered. 对话 is the case that matters
 * — a view token must not learn that a conversation channel exists
 * (`routes/chat.ts`), and a link that 403s on click leaks exactly that.
 */
function visibleTo(module: RouteModule, ctx: RouteContext): boolean {
  if (module.area.front === true) return frontAvailable(ctx)
  if (module.area.moved === true) return false
  const page = module.page
  if (page === undefined) return false
  if (page.available?.(ctx) === false) return false
  if (page.guard === 'chat' && guardChat(ctx.access, 'document') !== null)
    return false
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

/** Background tasks that are working, not waiting or done (P29). */
const RUNNING: ReadonlySet<BackgroundTaskStatus> = new Set([
  'running',
  'completion_pending',
  'needs_input_pending',
])

/**
 * 主动执行's dot: a task that waits for this reader (待你处理) before any
 * that run. The list is the port's in-memory one, so asking costs nothing on
 * every page.
 */
function tasksState(ctx: RouteContext): ShellNavState | undefined {
  const port = ctx.deps.tasks
  if (port === undefined) return undefined
  const tasks = port.list(taskActorOf(ctx))
  const waiting = tasks.filter(task => task.status === 'needs_input').length
  if (waiting > 0)
    return { tone: 'attention', label: `${waiting} 项待你处理`, count: waiting }
  const running = tasks.filter(task => RUNNING.has(task.status)).length
  return running > 0
    ? { tone: 'running', label: `${running} 个运行中` }
    : undefined
}

/**
 * 审批's dot: requests this member may decide. Only a personal member or
 * operator decides (`routes/approvals.ts`), so nobody else is shown one, and
 * a source that cannot answer shows nothing rather than a 0.
 */
async function approvalsState(
  ctx: RouteContext,
): Promise<ShellNavState | undefined> {
  const port = ctx.deps.approvals
  const principal = ctx.access.principal
  if (port === undefined || principal?.kind !== 'user') return undefined
  if (principal.role === 'viewer') return undefined
  const listed = await port.list(principal)
  if (!listed.ok) return undefined
  const pending = listed.value.filter(
    item => item.status === 'pending' && item.continuation === undefined,
  ).length
  return pending > 0
    ? { tone: 'attention', label: `${pending} 项待你处理`, count: pending }
    : undefined
}

async function stateOf(
  module: RouteModule,
  ctx: RouteContext,
): Promise<ShellNavState | undefined> {
  if (module.area.id === 'jobs') return tasksState(ctx)
  if (module.area.id === 'approvals') return approvalsState(ctx)
  return undefined
}

/**
 * The areas that open a new cluster in their group: a little space above
 * them, no heading and no rule, the way a desktop app breaks its settings
 * list (the operator's group starts one of its own, `view/shell.ts`). 渠道 starts what the agents reach; 审批 the oversight; 应用连接 the
 * hub's own connections; 用量 the books and the instance itself.
 */
const CLUSTER_STARTS: ReadonlySet<AreaId> = new Set<AreaId>([
  'im',
  'approvals',
  'connect',
  'usage',
])

/**
 * The card's list for this caller, with the counts that are honest to show.
 * 对话 is not in it: it is the main window's Work face, under the card.
 *
 * 初始化配置还有能在页面上做的必需项时（`setupCount` > 0），它挪到日常一组的
 * 第一项并带上「还差 N 步」；做完了回到「管理」一组里。
 */
async function navFor(
  ctx: RouteContext,
  listed: ConsoleResult<readonly ConsoleAgent[]>,
  modules: readonly RouteModule[] = ROUTES,
  setupCount?: number,
): Promise<readonly ShellNavGroup[]> {
  const promoted = setupCount !== undefined && setupCount > 0
  const groupOf = (module: RouteModule): AreaGroup =>
    module.area.id === 'setup' && promoted ? 'main' : module.area.group
  return Promise.all(
    GROUP_ORDER.map(async group => ({
      items: await Promise.all(
        modules
          .filter(
            module =>
              module.area.front !== true &&
              groupOf(module) === group &&
              visibleTo(module, ctx),
          )
          .sort(
            (a, b) =>
              Number(promoted && b.area.id === 'setup') -
              Number(promoted && a.area.id === 'setup'),
          )
          .map(async (module, index) => {
            const count =
              module.area.id === 'nodes' ? nodesCount(listed) : undefined
            const state: ShellNavState | undefined =
              module.area.id === 'setup' && promoted
                ? {
                    tone: 'attention',
                    label: `还差 ${setupCount} 步`,
                    count: setupCount,
                  }
                : await stateOf(module, ctx)
            return {
              id: module.area.id,
              label: module.area.label,
              href: module.area.href,
              icon: module.area.icon,
              ...(count === undefined ? {} : { count }),
              ...(state === undefined ? {} : { state }),
              ...(module.area.pending === true ? { pending: true } : {}),
              ...(index > 0 && CLUSTER_STARTS.has(module.area.id)
                ? { gap: true }
                : {}),
            }
          }),
      ),
    })),
  )
}

/**
 * The title row's health strip. The registry is the one dependency every page
 * already read for the list, so it is the one badge that costs nothing and
 * is never stale against the page under it.
 */
function healthOf(
  listed: ConsoleResult<readonly ConsoleAgent[]>,
): readonly ShellHealth[] {
  const tone: Tone = listed.ok ? 'ok' : 'bad'
  return [{ label: listed.ok ? '注册中心' : '注册中心不可达', tone }]
}

/**
 * The breadcrumb: the group when it has a name, the area, then whatever the
 * page adds.
 */
function crumbsOf(module: RouteModule, render: PageRender): readonly Crumb[] {
  const label = GROUP_LABELS[module.area.group]
  const group: readonly Crumb[] = label === '' ? [] : [{ label }]
  if (render.crumbs === undefined || render.crumbs.length === 0) {
    return [...group, { label: module.area.label }]
  }
  return [
    ...group,
    { label: module.area.label, href: module.area.href },
    ...render.crumbs,
  ]
}

/**
 * The public edition's source footer for a page in the card (AGPL §13,
 * `view/source.ts`): there whenever the billing port is, which is exactly
 * the public edition, where a subscriber without a chat channel lands here.
 */
function shellSource(ctx: RouteContext): { readonly source?: SourceLinks } {
  const billing = ctx.deps.billing
  return billing === undefined ? {} : { source: billing.site() }
}

/**
 * The page scripts of the areas this reader can move to in place: the ones
 * the card offers them (`visibleTo`), so a document's policy names no
 * script for a page its reader cannot open.
 */
function navScriptsFor(ctx: RouteContext): readonly string[] {
  return ROUTES.filter(
    module =>
      module.area.front !== true &&
      module.page?.script !== undefined &&
      visibleTo(module, ctx),
  ).map(module => module.page?.script ?? '')
}

/** A document, with the scripts its policy allows beyond its own. */
interface CardDocument {
  readonly body: string
  /** Hand to `html()` with the body (`respond.ts`, `documentHeaders`). */
  readonly allow: readonly string[]
}

/** The card's frame for this caller: the list, and nothing open in it. */
async function frameModel(ctx: RouteContext): Promise<ShellModel> {
  const listed = await ctx.roster()
  return {
    label: ctx.deps.label ?? DEFAULT_LABEL,
    nav: await navFor(ctx, listed, ROUTES, await setupPending(ctx)),
    crumbs: [],
    title: '',
    body: '',
    health: healthOf(listed),
    ...shellSource(ctx),
    navScripts: navScriptsFor(ctx),
  }
}

async function areaModel(
  ctx: RouteContext,
  module: RouteModule,
  render: PageRender,
): Promise<ShellModel> {
  const frame = await frameModel(ctx)
  return {
    ...frame,
    active: render.active ?? module.area.id,
    crumbs: crumbsOf(module, render),
    title: render.title,
    ...(render.actions === undefined ? {} : { actions: render.actions }),
    body: render.body,
    ...(render.poll === true ? { poll: true } : {}),
    ...(module.page?.css === undefined ? {} : { pageCss: module.page.css }),
    ...(module.page?.script === undefined
      ? {}
      : { pageScript: module.page.script }),
  }
}

/** The token box goes into the card only for the two legacy tokens. */
function card(
  ctx: RouteContext,
  model: ShellModel,
  open: boolean,
): SettingsCard {
  return { model, open, tokens: ctx.viewer === undefined }
}

/**
 * The card a front document carries, closed (`/`, `/app`, `/code`): for a
 * reader the management side's guard lets in, else none.
 */
export async function settingsCard(
  ctx: RouteContext,
): Promise<SettingsCard | undefined> {
  if (guard(ctx.access.credential, 'view', 'document') !== null)
    return undefined
  return card(ctx, await frameModel(ctx), false)
}

async function underCard(
  ctx: RouteContext,
  model: ShellModel,
  status: number,
): Promise<CardDocument> {
  const drawn = await renderUnderCard(ctx, card(ctx, model, true), status)
  return { body: drawn.html, allow: drawn.allow }
}

/** One area's address as a document: the Work face, the card open on the area. */
export async function areaDocument(
  ctx: RouteContext,
  module: RouteModule,
  render: PageRender,
  status: number,
): Promise<CardDocument> {
  return await underCard(ctx, await areaModel(ctx, module, render), status)
}

/** One area's parts, for a move inside the card (`assets/nav.ts`). */
export async function areaPartial(
  ctx: RouteContext,
  module: RouteModule,
  render: PageRender,
): Promise<ShellPartial> {
  return shellPartial(await areaModel(ctx, module, render))
}

/** One error, in the card: the title, one line, the way back. */
export async function errorDocument(
  ctx: RouteContext,
  title: string,
  line: string,
  status: number,
): Promise<CardDocument> {
  const frame = await frameModel(ctx)
  return await underCard(
    ctx,
    {
      ...frame,
      crumbs: [{ label: title }],
      title,
      body:
        `<section class="card elev-sm stub" aria-labelledby="page-title">` +
        `<p class="note">${escapeHtml(line)}</p>` +
        `<p><a class="jump" href="${ADMIN_HOME}" data-nav>回到总览</a></p>` +
        `</section>`,
    },
    status,
  )
}
