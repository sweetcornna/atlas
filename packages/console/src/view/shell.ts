// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The frame every console page is drawn in.
 *
 * One sand panel down the left with the areas in three groups, a top bar over
 * the page with where you are, what the page is called, its main actions and
 * who you are, and the page itself under that. Everything a page does not own
 * lives here exactly once: the navigation, the role, the way out, the refresh
 * switch, the document head (`providers-console-m1.md` §6.1).
 *
 * ## Every area is in the sidebar, including the ones that are not built
 *
 * A placeholder area is a real URL that renders one line saying the page is
 * not there yet (`routes/stub.ts`), and its sidebar item carries a small
 * 未提供 tag. Leaving it out would make the console's shape change every time
 * a page lands; drawing it as if it worked would make an operator click into
 * an empty page and wonder what failed.
 *
 * The one item that is hidden rather than marked is 对话: a view token must
 * not even learn that a conversation channel exists (`routes/chat.ts`), so the
 * route table hands the shell a nav without it.
 *
 * ## The role is always on screen
 *
 * The chip in the top bar states which credential this page was rendered for.
 * The admin token is a strict superset of the view token, so without it an
 * operator holding the smaller one cannot tell "restricted" from "broken"
 * until a control they remember is not there (`console.md` §4.1).
 *
 * ## The page loads nothing
 *
 * No stylesheet link, no script src, no font file, no image. CSS and JS are
 * inlined from `../assets/`, every icon is an inline `<svg>`, and the CSP says
 * the same thing in a form the browser enforces: `default-src 'none'` with
 * `connect-src 'self'` for polling. A console that reaches out to a CDN is a
 * console whose contents depend on a third party's good behaviour while it
 * holds a registry token.
 */

import {
  CONSOLE_CLIENT_JS,
  CONSOLE_CLIENT_JS_ACCOUNTS,
} from '../assets/client.js'
import { CONSOLE_CSS } from '../assets/css.js'
import type { ConsoleRole } from '../auth.js'
import { CSP } from '../respond.js'
import {
  chevron,
  icon,
  state,
  viewerNotice,
  type PageViewer,
  type Tone,
} from './bits.js'
import { attr, escapeHtml } from './escape.js'

/**
 * The product mark. The instance name sits beside it, never merged into it.
 *
 * Every document puts it in its `<title>`, and one string spelled in several
 * places is several strings.
 */
export const BRAND = '阡陌 console'

const WORDMARK_CN = '阡陌'
const WORDMARK_EN = 'AgentNest'

/**
 * The tab mark: 阡 on a terracotta ground, as a data URI.
 *
 * Written out rather than fetched, like everything else on this page. The
 * `xmlns` is mandatory for an SVG that arrives through a `data:` URI — inside
 * the document body an inline `<svg>` inherits the HTML parser's namespace,
 * but a standalone document has nothing to inherit from.
 */
const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="9" fill="#c67139"/>' +
      '<text x="16" y="23" font-size="21" font-family="serif" ' +
      'text-anchor="middle" fill="#f5ead8">阡</text></svg>',
  )

/**
 * The `<head>` every document shares.
 *
 * `pageCss` is the active page's own styles (`routes/types.ts`), appended to
 * the shared sheet in the same `<style>` so a page carries what it needs and
 * nothing that another page needs.
 */
export function documentHead(title: string, pageCss = ''): string {
  return (
    `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta name="color-scheme" content="light dark">\n` +
    `<meta name="referrer" content="no-referrer">\n` +
    `<meta http-equiv="Content-Security-Policy" content="${attr(CSP)}">\n` +
    `<link rel="icon" href="${attr(FAVICON)}">\n` +
    `<title>${escapeHtml(title)}</title>\n` +
    `<style>${CONSOLE_CSS}${pageCss}</style>\n` +
    `</head>\n`
  )
}

/** One step of the breadcrumb. The last one is the page and carries no link. */
export interface Crumb {
  readonly label: string
  readonly href?: string
}

/** One sidebar item, already decided on (visibility is the caller's call). */
export interface ShellNavItem {
  readonly id: string
  readonly label: string
  readonly href: string
  readonly icon: string
  /** A count beside the label; absent when there is nothing honest to show. */
  readonly count?: number
  /** A placeholder area: the item carries the 未提供 tag. */
  readonly pending?: boolean
}

export interface ShellNavGroup {
  readonly label: string
  readonly items: readonly ShellNavItem[]
}

/** One badge in the top bar's health strip. */
export interface ShellHealth {
  readonly label: string
  readonly tone: Tone
}

export interface ShellModel {
  /** The instance's own name (`--label`), so two consoles are never confused. */
  readonly label: string
  /** Which credential this render is for; the chip in the top bar states it. */
  readonly role: ConsoleRole
  /**
   * Who this page is for, when personal accounts are on. Its presence also
   * picks the runtime that refuses to keep a personal credential
   * (`assets/client.ts`).
   */
  readonly viewer?: PageViewer
  readonly nav: readonly ShellNavGroup[]
  /** The sidebar item to mark current; absent on a page that is no area's. */
  readonly active?: string
  /** The whole breadcrumb, from the group down to the page. */
  readonly crumbs: readonly Crumb[]
  /** The `<h1>`, and the head of the document title. */
  readonly title: string
  /** The page's main actions, markup the page rendered. */
  readonly actions?: string
  /** The page itself, markup the page rendered. */
  readonly body: string
  readonly health?: readonly ShellHealth[]
  /** True when the body has polled regions: the refresh switch is drawn. */
  readonly poll?: boolean
  readonly pageCss?: string
  readonly pageScript?: string
  /**
   * The login door with the way back to this page (`routes/shared.ts`,
   * `loginHref`): where the session-expired dialog sends the operator.
   * Absent draws no such dialog.
   */
  readonly relogin?: string
}

const REFRESH_CHOICES: readonly (readonly [string, string])[] = [
  ['2000', '2s'],
  ['5000', '5s'],
  ['10000', '10s'],
  ['30000', '30s'],
]

const DEFAULT_REFRESH = '5000'

function refreshControl(): string {
  const options = REFRESH_CHOICES.map(
    ([value, label]) =>
      `<option value="${attr(value)}"${
        value === DEFAULT_REFRESH ? ' selected' : ''
      }>${escapeHtml(label)}</option>`,
  ).join('')
  return (
    `<div class="stack" style="gap:var(--space-2)">` +
    `<div class="flabel">刷新</div>` +
    `<div class="fblock">` +
    `<label class="sw"><input type="checkbox" id="auto-refresh" checked>` +
    `<span class="trk"></span>自动刷新</label>` +
    `<span class="sel"><select class="input btn-small" id="refresh-interval" ` +
    `aria-label="刷新间隔">${options}</select></span>` +
    `</div><span id="refresh-state"></span></div>`
  )
}

/**
 * The token box, folded away inside the user menu.
 *
 * A console reached with a cookie never needs it, and one reached with a
 * `?token=` link has already stored the token by the time the page paints — so
 * an always-open password field is a field whose only everyday function is to
 * be ignored. Folded, it is still one click from "look at this console as the
 * other role for a minute".
 */
function tokenControl(): string {
  return (
    `<details class="adv"><summary>${chevron()}换令牌</summary>` +
    `<div class="adv-body" style="grid-template-columns:minmax(0,1fr)">` +
    `<div class="field"><label for="token">令牌</label>` +
    `<input class="input" type="password" id="token" autocomplete="off" ` +
    `spellcheck="false" placeholder="粘贴新令牌"></div>` +
    `<div class="rowx" style="gap:var(--space-2)">` +
    `<button type="button" class="btn btn-primary btn-small" ` +
    `data-action="token-save">保存</button>` +
    `<button type="button" class="btn btn-secondary btn-small" ` +
    `data-action="token-clear">清除</button>` +
    `<span id="token-state"></span></div>` +
    `</div></details>`
  )
}

/** The two legacy roles, in the console's own words. */
const ROLE_TEXT: Readonly<Record<ConsoleRole, string>> = {
  admin: '管理',
  view: '只读',
  none: '',
}

/**
 * The role chip, and the menu behind it.
 *
 * The chip is the summary of a native `<details>`, so it is always visible and
 * the menu opens with script disabled. `退出` is a native `POST /logout` form
 * rather than a button the script wires up: it has to work on the same terms
 * as the login page it leads back to (`view/login.ts`).
 */
function userMenu(role: ConsoleRole, viewer: PageViewer | undefined): string {
  if (role === 'none') return ''
  return (
    `<details class="usermenu">` +
    `<summary aria-label="身份与退出">` +
    `<span class="tag tag-accent" id="role">` +
    icon('shield', { small: true }) +
    `${escapeHtml(viewer?.roleText ?? ROLE_TEXT[role])}</span>` +
    chevron() +
    `</summary>` +
    `<div class="usermenu-body">` +
    tokenControl() +
    `<div class="divider"></div>` +
    `<form id="logout-form" method="post" action="/logout">` +
    `<button type="submit" class="btn btn-ghost">` +
    icon('log-out', { small: true }) +
    `退出</button></form>` +
    `</div></details>`
  )
}

function navItem(item: ShellNavItem, active: string | undefined): string {
  const current = item.id === active ? ' aria-current="page"' : ''
  const tail =
    item.pending === true
      ? `<span class="nav-tag">未提供</span>`
      : item.count === undefined
        ? ''
        : `<span class="cnt">${escapeHtml(String(item.count))}</span>`
  // `data-nav` marks the links the runtime signs with the stored token when
  // there is one: a top-level navigation carries no `Authorization` header
  // (`console.md` §6.8). A cookie session needs none of it.
  return (
    `<a class="nav-item" id="nav-${attr(item.id)}" href="${attr(
      item.href,
    )}" data-nav${current}>` +
    icon(item.icon) +
    `<span class="nav-label">${escapeHtml(item.label)}</span>` +
    tail +
    `</a>`
  )
}

function sidebar(model: ShellModel): string {
  const groups = model.nav
    .filter(group => group.items.length > 0)
    .map(
      group =>
        `<div class="nav-group">` +
        `<p class="nav-group-name">${escapeHtml(group.label)}</p>` +
        group.items.map(item => navItem(item, model.active)).join('') +
        `</div>`,
    )
    .join('')
  return (
    `<aside class="side">` +
    `<div class="brand">` +
    `<div class="brand-en">${escapeHtml(WORDMARK_EN)}</div>` +
    `<a class="brand-cn" href="/" data-nav>${escapeHtml(WORDMARK_CN)}</a>` +
    `</div>` +
    `<nav class="nav" aria-label="导航">${groups}</nav>` +
    `<div class="side-foot">` +
    `<p class="inst"><b>${escapeHtml(model.label)}</b></p>` +
    (model.poll === true
      ? `<div class="divider"></div>${refreshControl()}`
      : '') +
    `</div></aside>`
  )
}

function breadcrumb(crumbs: readonly Crumb[]): string {
  if (crumbs.length === 0) return ''
  const last = crumbs.length - 1
  return (
    `<nav aria-label="位置"><ol class="crumbs">` +
    crumbs
      .map((crumb, index) => {
        if (index === last) {
          return `<li aria-current="page">${escapeHtml(crumb.label)}</li>`
        }
        return crumb.href === undefined
          ? `<li>${escapeHtml(crumb.label)}</li>`
          : `<li><a href="${attr(crumb.href)}" data-nav>${escapeHtml(
              crumb.label,
            )}</a></li>`
      })
      .join('') +
    `</ol></nav>`
  )
}

function healthStrip(health: readonly ShellHealth[] | undefined): string {
  if (health === undefined || health.length === 0) return ''
  return (
    `<div class="health" role="group" aria-label="健康">` +
    health.map(badge => state(badge.tone, badge.label)).join('') +
    `</div>`
  )
}

function topBar(model: ShellModel): string {
  return (
    `<header class="top">` +
    `<div class="top-lead">` +
    breadcrumb(model.crumbs) +
    `<h1 class="page-title" id="page-title">${escapeHtml(model.title)}</h1>` +
    `</div>` +
    `<div class="top-tail">` +
    (model.actions === undefined || model.actions === ''
      ? ''
      : `<div class="top-actions">${model.actions}</div>`) +
    healthStrip(model.health) +
    userMenu(model.role, model.viewer) +
    `</div></header>`
  )
}

/**
 * What a page says when its credential stops working under it (C1).
 *
 * Rendered closed on every page, outside every polled region. The runtime
 * opens it on the first 401, after it has stopped every poller and stream —
 * so a lapsed session reads as one sentence and one way back, not as a
 * sidebar line saying 刷新失败 · HTTP 401 every five seconds forever. The
 * link is the login door with this page as the way back; the runtime writes
 * the address bar's current path into it when it opens, since a page that
 * switches conversations in place has moved on from what the server drew.
 */
function sessionExpired(relogin: string): string {
  return (
    `<dialog class="dialog" id="session-expired" ` +
    `aria-labelledby="session-expired-title">` +
    `<div class="dlg-top"><span class="dlg-icon">` +
    icon('log-out') +
    `</span><div class="dialog-title" id="session-expired-title">` +
    `会话已失效</div></div>` +
    `<div class="dialog-body">` +
    `<p>凭据已过期或已被吊销 · 重新登录后回到这一页</p></div>` +
    `<div class="dialog-actions">` +
    `<a class="btn btn-primary" id="session-expired-login" ` +
    `href="${attr(relogin)}">重新登录</a>` +
    `</div></dialog>`
  )
}

/** A whole console document. Self-contained: nothing is fetched from anywhere. */
export function renderShell(model: ShellModel): string {
  const runtime =
    model.viewer === undefined ? CONSOLE_CLIENT_JS : CONSOLE_CLIENT_JS_ACCOUNTS
  return (
    documentHead(`${BRAND} · ${model.title} · ${model.label}`, model.pageCss) +
    `<body>\n` +
    `<div class="shell">\n` +
    sidebar(model) +
    `\n<div class="frame">\n` +
    topBar(model) +
    viewerNotice(model.viewer) +
    `\n<main class="main" id="main" aria-labelledby="page-title">\n` +
    model.body +
    `\n</main>\n</div>\n</div>\n` +
    (model.relogin === undefined ? '' : sessionExpired(model.relogin)) +
    `<script>${runtime}${model.pageScript ?? ''}</script>\n` +
    `</body>\n</html>\n`
  )
}

/** What a page outside the shell says: an error with nowhere else to go. */
export interface StandaloneModel {
  readonly label: string
  readonly title: string
  readonly line: string
  /** Developer detail, folded away; escaped like everything else. */
  readonly detail?: string
  /** The one way on: the login door, or the overview. */
  readonly link: { readonly href: string; readonly label: string }
}

/**
 * A document without the shell, on the login page's panel: for a caller the
 * shell must not be drawn for — nobody signed in yet, or a console whose
 * ports just threw (the shell reads the registry, and drawing it would be a
 * second chance to fail). No script: there is nothing on it to run.
 */
export function renderStandalone(model: StandaloneModel): string {
  const detail =
    model.detail === undefined || model.detail === ''
      ? ''
      : `<details class="adv"><summary>${chevron()}详情</summary>` +
        `<pre class="mono note">${escapeHtml(model.detail)}</pre></details>`
  return (
    documentHead(`${BRAND} · ${model.title} · ${model.label}`) +
    `<body>\n<div class="stage">\n` +
    `<main class="card elev-lg panel" aria-labelledby="page-title">` +
    `<div class="brand"><div class="brand-en">${escapeHtml(WORDMARK_EN)}</div>` +
    `<div class="brand-cn">${escapeHtml(WORDMARK_CN)}</div></div>` +
    `<p class="inst"><b>${escapeHtml(model.label)}</b></p>` +
    `<h1 class="page-title" id="page-title">${escapeHtml(model.title)}</h1>` +
    `<p class="note">${escapeHtml(model.line)}</p>` +
    detail +
    `<a class="btn btn-secondary" href="${attr(model.link.href)}">` +
    `${escapeHtml(model.link.label)}</a>` +
    `</main>\n</div>\n</body>\n</html>\n`
  )
}
