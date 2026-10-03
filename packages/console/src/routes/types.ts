// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The contract every area of the console is written against.
 *
 * ## Why an area owns its API and its fragments, not only its page
 *
 * The page packages that come after the shell (`providers-console-m1.md`
 * §9.3) may change their own route file and their own view files, and nothing
 * else — `http.ts` is not in any of their scopes. An area whose JSON routes
 * lived in `http.ts` could therefore not grow a route without a second package
 * editing a file it does not own. So a module states all three of its entry
 * points:
 *
 * - **`page`** — the document(s) under the area's path, rendered inside the
 *   shell (`view/shell.ts`).
 * - **`api`** — the `/v0/<head>/…` heads it answers.
 * - **`fragments`** — the `/fragments/<head>/…` heads it answers.
 *
 * `http.ts` keeps what is not an area: the credential plumbing, the login and
 * invitation doors, the account API, `/v0/health`, the two assets, the shell
 * itself, the HTML error pages and the last-resort 500. A head is claimed by
 * exactly one module (`test/routes.test.ts` pins that), and the built-in heads
 * are dispatched first, so no module can shadow them.
 *
 * ## What a handler may assume
 *
 * Nothing about the credential. Every handler calls the guard that fits its
 * route (`shared.ts`) before it reads a port — the same "role before method
 * before existence" order the console has always kept (`http.ts` module
 * note). The context hands it the request, the parsed URL, the ports, who is
 * asking and the clock, so a handler is a pure function of those and testable
 * with a plain `Request`.
 */

import type { Access, ConsoleAccounts } from '../access.js'
import type { ConsoleAgent, ConsoleDeps, ConsoleResult } from '../deps.js'
import type { PageViewer } from '../view/bits.js'
import type { Crumb } from '../view/shell.js'

/** Every area the console has a place for (`providers-console-m1.md` §6.1). */
export type AreaId =
  | 'overview'
  | 'nodes'
  | 'chat'
  | 'audit'
  | 'alerts'
  | 'jobs'
  | 'approvals'
  | 'providers'
  | 'servers'
  | 'access'
  | 'usage'
  | 'settings'

/** The three sidebar groups, in the order the sidebar draws them. */
export type AreaGroup = 'run' | 'config' | 'admin'

/** An area as the sidebar and the breadcrumb name it. */
export interface Area {
  readonly id: AreaId
  /** The noun on the sidebar and at the head of the breadcrumb. */
  readonly label: string
  readonly group: AreaGroup
  /** Where the sidebar item points. Always a path this module's page answers. */
  readonly href: string
  /** One of the inline Lucide shapes in `view/bits.ts`. */
  readonly icon: string
  /**
   * True while the area is a placeholder. The sidebar marks it, and the page
   * says so in one line rather than pretending to be empty.
   */
  readonly pending?: true
}

/** Everything a handler is handed. Built once per request by `http.ts`. */
export interface RouteContext {
  readonly request: Request
  readonly url: URL
  readonly deps: ConsoleDeps
  readonly access: Access
  /** The account book, when this console has personal accounts. */
  readonly accounts: ConsoleAccounts | undefined
  /** `deps.now()` read once, so one request renders one instant. */
  readonly now: number
  /** Who a page is rendered for, when personal accounts are on. */
  readonly viewer: PageViewer | undefined
  /**
   * The roster, read at most once per request: the shell's sidebar count and
   * the page under it ask the same registry the same question, and two reads
   * could disagree with each other on one screen.
   */
  roster(): Promise<ConsoleResult<readonly ConsoleAgent[]>>
}

/** What a page hands the shell. Markup fields are view output, already escaped. */
export interface PageRender {
  /** The `<h1>` and the head of the document title. */
  readonly title: string
  /**
   * Crumbs after the area's own, the last one being this page. Absent on an
   * area's landing page, where the area's own crumb is the page.
   */
  readonly crumbs?: readonly Crumb[]
  /** The page's main actions, rendered on the right of the top bar. */
  readonly actions?: string
  readonly body: string
  /**
   * True when the body carries regions the shared runtime polls
   * (`data-poll`). The shell then shows the refresh control; a page with
   * nothing to refresh does not offer a switch that does nothing.
   */
  readonly poll?: boolean
  /** Defaults to 200. */
  readonly status?: number
  /**
   * Overrides the active sidebar item. Absent means the module's own area,
   * which is the only sensible answer for every page today.
   */
  readonly active?: AreaId
}

/** The document half of a module. */
export interface PageRoute {
  /**
   * The segments after the area's own path when this module answers the path,
   * `null` when it does not. `[]` is the area's landing page. Usually
   * `underPath(...)` from `shared.ts`. Never claims `v0`, `fragments`,
   * `assets`, `login`, `logout` or `invite` (`test/routes.test.ts`).
   */
  match(segments: readonly string[]): readonly string[] | null
  /**
   * Which guard runs before the page: `view` for every read-only area, `chat`
   * for the conversation face, which has its own rule (`shared.ts`).
   */
  readonly guard: 'view' | 'chat'
  /**
   * False when the page does not exist on this console at all — `/chat` with
   * no channel wired. Checked after the guard and before the method, so the
   * answer is the same 404 it has always been.
   */
  available?(ctx: RouteContext): boolean
  render(
    ctx: RouteContext,
    rest: readonly string[],
  ): Promise<PageRender | Response>
  /**
   * Styles only this page needs, inlined after the shared sheet. A page's
   * own rules live here, never in `assets/css.ts` (§6.1): that is how two page
   * packages avoid editing one file.
   */
  readonly css?: string
  /**
   * Script only this page needs, inlined after the shared runtime and talking
   * to it through `window.qianmoConsole` (`assets/client.ts`).
   */
  readonly script?: string
}

/** A set of `/v0/<head>` or `/fragments/<head>` heads and their handler. */
export interface HeadRoute {
  readonly heads: readonly string[]
  /** `rest` is everything after the head; `[]` for the head itself. */
  handle(
    ctx: RouteContext,
    head: string,
    rest: readonly string[],
  ): Promise<Response>
}

/** One area of the console. */
export interface RouteModule {
  readonly area: Area
  readonly page?: PageRoute
  readonly api?: HeadRoute
  readonly fragments?: HeadRoute
}
