// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The frame every management page is drawn in: the settings card.
 *
 * There is no management document of its own any more (P37.13,
 * `qmo-local.md` §3.6). The console's main window is the front — Work at
 * `/` and `/app`, Code at `/code` (`view/front.ts`) — and every area
 * under `/admin` opens as a card over it, the way a desktop app opens its
 * settings: a search line and the areas down the left, the area's title,
 * actions and page on the right. The card is a native modal `<dialog>`:
 * the page behind is inert, focus stays inside, Esc closes it. Drawn closed
 * (and empty) into every front document for a reader who may see the
 * management side; drawn open on an area when the document was asked for
 * that area's address, so a bookmark, a reload and an old link paint the
 * card in the first frame.
 *
 * Everything an area does not own lives here exactly once: the areas'
 * list, the refresh switch, the token box, where the times' zone is said,
 * the title row with the page's actions and the registry's health.
 *
 * ## Every area is in the list, including the ones that are not built
 *
 * A placeholder area is a real URL that renders one line saying the page is
 * not there yet, and its item carries a small 未提供 tag. Leaving it out would
 * make the console's shape change every time a page lands; drawing it as if
 * it worked would make an operator click into an empty page and wonder what
 * failed.
 *
 * 对话 is not in the list at all: it is the window under the card.
 *
 * ## The page loads nothing
 *
 * No stylesheet link, no script src, no font file, no image. CSS and JS are
 * inlined from `../assets/`, every icon is an inline `<svg>`, and the CSP says
 * the same thing in a form the browser enforces: `default-src 'none'` with
 * `connect-src 'self'` for polling. A console that reaches out to a CDN is a
 * console whose contents depend on a third party's good behaviour while it
 * holds a registry token.
 *
 * ## Moving between areas does not load another document (P37.13)
 *
 * The card is drawn once. After that, the navigation runtime
 * (`assets/nav.ts`) asks each next area for its parts — {@link shellPartial}
 * over the same model — and puts them in the card. So the document carries
 * the area's own sheet as the last `<style>` (the one a move replaces), and a
 * policy that also allows the page scripts of every area its reader can move
 * to (`ShellModel.navScripts`, `respond.ts`).
 */

import {
  CONSOLE_CLIENT_JS,
  CONSOLE_CLIENT_JS_ACCOUNTS,
} from '../assets/client.js'
import { CONSOLE_CSS, stripCssComments } from '../assets/css.js'
import { PARTIAL_VERSION, navScript } from '../assets/nav.js'
import type { Lang } from '../i18n.js'
import { cspFor, scriptHash } from '../respond.js'
import { chevron, icon, state, type Tone } from './bits.js'
import { AVATAR_CSS } from './avatar.js'
import { FRONT_CSS } from './frontStyle.js'
import { attr, escapeHtml } from './escape.js'
import { zoneLabel } from './format.js'
import { QIANMO_ICON_HREF, qianmoMark } from './mark.js'
import { type SourceLinks, sourceFooter } from './source.js'

/**
 * The product mark. The instance name sits beside it, never merged into it.
 *
 * Every document puts it in its `<title>`, and one string spelled in several
 * places is several strings.
 */
export const BRAND = '阡陌控制台'

export const WORDMARK_CN = '阡陌'

/**
 * The `<head>` every document shares.
 *
 * `pageCss` is the active page's own styles (`routes/types.ts`), appended to
 * the shared sheet in the same `<style>` so a page carries what it needs and
 * nothing that another page needs.
 */
/** Each page's own sheet, stripped once (G1): there are a handful of them. */
const strippedPageCss = new Map<string, string>()

function pageSheet(css: string): string {
  if (css === '') return ''
  let stripped = strippedPageCss.get(css)
  if (stripped === undefined) {
    stripped = stripCssComments(css)
    strippedPageCss.set(css, stripped)
  }
  return stripped
}

/**
 * `scripts` are the inline scripts the document will carry, exactly, then
 * any it may run later (a management page's swappable page scripts): the
 * policy allows those by hash and nothing else (`respond.ts`, H2).
 *
 * `apart` draws the page's own sheet as a second `<style>` after the shared
 * one (with `shared`, more rules every page of this frame has): the shell's
 * documents, where moving to another page replaces that second sheet.
 */
export function documentHead(
  title: string,
  pageCss = '',
  scripts: readonly string[] = [],
  apart?: { readonly shared: string },
): string {
  const sheets =
    apart === undefined
      ? `<style>${CONSOLE_CSS}${pageSheet(pageCss)}</style>\n`
      : `<style>${CONSOLE_CSS}${pageSheet(apart.shared)}</style>\n` +
        `<style>${pageSheet(pageCss)}</style>\n`
  return (
    `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta name="color-scheme" content="light dark">\n` +
    `<meta name="referrer" content="no-referrer">\n` +
    `<meta http-equiv="Content-Security-Policy" content="${attr(cspFor(scripts))}">\n` +
    `<link rel="icon" href="${attr(QIANMO_ICON_HREF)}">\n` +
    `<title>${escapeHtml(title)}</title>\n` +
    sheets +
    `</head>\n`
  )
}

/** One step of the breadcrumb. The last one is the page and carries no link. */
export interface Crumb {
  readonly label: string
  readonly href?: string
}

/** One item of the card's list, already decided on (visibility is the caller's call). */
export interface ShellNavItem {
  readonly id: string
  readonly label: string
  readonly href: string
  readonly icon: string
  /** A count beside the label; absent when there is nothing honest to show. */
  readonly count?: number
  /** A placeholder area: the item carries the 未提供 tag. */
  readonly pending?: boolean
  /** Something there worth a glance, as a dot (see {@link ShellNavState}). */
  readonly state?: ShellNavState
  /** Opens a new cluster in its group: space above it, nothing drawn. */
  readonly gap?: boolean
}

/**
 * An item's state, as a dot beside the label: 待你处理 in the warning
 * colour with how many, 运行中 in grey, 未读 in the accent. The words are
 * the dot's name for a screen reader and its tooltip; only the number shows.
 */
export interface ShellNavState {
  readonly tone: 'attention' | 'running' | 'unread'
  /** The whole state in words, `2 项待你处理`. */
  readonly label: string
  /** Drawn beside the dot when there is one. */
  readonly count?: number
}

/**
 * One group of the list: the everyday areas, or the operator's. A group is
 * drawn as a break of space before its first item, with no heading.
 */
export interface ShellNavGroup {
  readonly items: readonly ShellNavItem[]
}

/** One badge in the title row's health strip. */
export interface ShellHealth {
  readonly label: string
  readonly tone: Tone
}

export interface ShellModel {
  /** The instance's own name (`--label`), so two consoles are never confused. */
  readonly label: string
  readonly nav: readonly ShellNavGroup[]
  /** The item to mark current; absent on a page that is no area's. */
  readonly active?: string
  /** The whole breadcrumb, from the group down to the page. */
  readonly crumbs: readonly Crumb[]
  /** The card's title, and the head of the document title. */
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
   * The public edition's source and terms links (AGPL §13, `source.ts`),
   * under the page body and outside every polled region. Absent — the
   * default edition — the card is what it was.
   */
  readonly source?: SourceLinks
  /**
   * The page scripts of the other areas this reader can move to in place
   * (`assets/nav.ts`): the document's policy allows them by hash, so the one
   * a move brings runs. Only the areas the card offers this reader.
   */
  readonly navScripts?: readonly string[]
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
    `<div class="refresh-row">` +
    `<label class="sw"><input type="checkbox" id="auto-refresh" checked>` +
    `<span class="trk"></span>自动刷新</label>` +
    `<span class="sel"><select class="input btn-small" id="refresh-interval" ` +
    `aria-label="刷新间隔">${options}</select></span>` +
    `<span id="refresh-state"></span></div>`
  )
}

/**
 * The token box, folded away at the foot of the card.
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
    `<div class="adv-body single-column">` +
    `<div class="field"><label for="token">令牌</label>` +
    `<input class="input" type="password" id="token" autocomplete="off" ` +
    `spellcheck="false" placeholder="粘贴新令牌"></div>` +
    `<div class="rowx gap-2">` +
    `<button type="button" class="btn btn-primary btn-small" ` +
    `data-action="token-save">保存</button>` +
    `<button type="button" class="btn btn-secondary btn-small" ` +
    `data-action="token-clear">清除</button>` +
    `<span id="token-state"></span></div>` +
    `</div></details>`
  )
}

function navState(state: ShellNavState | undefined): string {
  if (state === undefined) return ''
  return (
    `<span class="nav-state nav-state-${state.tone}" title="${attr(state.label)}">` +
    `<span class="nav-dot" aria-hidden="true"></span>` +
    (state.count === undefined
      ? ''
      : `<span aria-hidden="true">${escapeHtml(String(state.count))}</span>`) +
    `<span class="sr-only">${escapeHtml(state.label)}</span></span>`
  )
}

function navItem(item: ShellNavItem, active: string | undefined): string {
  const current = item.id === active ? ' aria-current="page"' : ''
  const tail =
    item.pending === true
      ? `<span class="nav-tag">未提供</span>`
      : navState(item.state) +
        (item.count === undefined
          ? ''
          : `<span class="cnt">${escapeHtml(String(item.count))}</span>`)
  // `data-nav` marks the links the runtime signs with the stored token when
  // there is one: a top-level navigation carries no `Authorization` header
  // (`console.md` §6.8). A cookie session needs none of it.
  return (
    `<a class="nav-item${item.gap === true ? ' nav-gap' : ''}" id="nav-${attr(item.id)}" href="${attr(
      item.href,
    )}" data-nav${current}>` +
    icon(item.icon) +
    `<span class="nav-label">${escapeHtml(item.label)}</span>` +
    tail +
    `</a>`
  )
}

/**
 * The card's list, the inside of its `<nav>`: every area this reader may
 * open, the everyday ones first and the operator's after them, in one list.
 * Clusters are breaks of space with nothing drawn (the operator's start one
 * of their own), the way a desktop app breaks its settings list.
 */
function cardNav(model: ShellModel): string {
  return model.nav
    .filter(group => group.items.length > 0)
    .map((group, index) =>
      group.items
        .map((item, at) =>
          navItem(
            index > 0 && at === 0 && item.gap !== true
              ? { ...item, gap: true }
              : item,
            model.active,
          ),
        )
        .join(''),
    )
    .join('')
}

/** The inside of the card's page: the page, then the public edition's footer. */
function mainBody(model: ShellModel): string {
  return (
    model.body + (model.source === undefined ? '' : sourceFooter(model.source))
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

/** What the top bar holds on the right: the page's actions, the health strip. */
function topTail(model: ShellModel): string {
  return (
    (model.actions === undefined || model.actions === ''
      ? ''
      : `<div class="top-actions">${model.actions}</div>`) +
    healthStrip(model.health)
  )
}

/**
 * What a page says when its credential stops working under it (C1)./**
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
const EXPIRED_TEXT: Readonly<
  Record<
    Lang,
    { readonly title: string; readonly body: string; readonly login: string }
  >
> = {
  'zh-CN': {
    title: '会话已失效',
    body: '凭据已过期或已被吊销 · 重新登录后回到这一页',
    login: '重新登录',
  },
  en: {
    title: 'Session expired',
    body: 'The credential has expired or was revoked · sign in again to come back to this page',
    login: 'Sign in again',
  },
  ja: {
    title: 'セッションが切れました',
    body: '資格情報の期限切れか失効です · もう一度ログインするとこのページに戻ります',
    login: 'もう一度ログイン',
  },
}

export function sessionExpired(relogin: string, lang: Lang = 'zh-CN'): string {
  const text = EXPIRED_TEXT[lang]
  return (
    `<dialog class="dialog" id="session-expired" ` +
    `aria-labelledby="session-expired-title">` +
    `<div class="dlg-top"><span class="dlg-icon">` +
    icon('log-out') +
    `</span><div class="dialog-title" id="session-expired-title">` +
    `${escapeHtml(text.title)}</div></div>` +
    `<div class="dialog-body">` +
    `<p>${escapeHtml(text.body)}</p></div>` +
    `<div class="dialog-actions">` +
    `<a class="btn btn-primary" id="session-expired-login" ` +
    `href="${attr(relogin)}">${escapeHtml(text.login)}</a>` +
    `</div></dialog>`
  )
}

/**
 * Which frame a document is: the sheet and both runtimes it carries, and the
 * navigation runtime without its key. A page's parts name it
 * ({@link shellPartial}), and the navigation runtime loads a whole document
 * for parts that name another (a release with another sheet or runtime).
 */
const SHELL_KEY = new Bun.CryptoHasher('sha256')
  .update(
    [
      CONSOLE_CSS,
      FRONT_CSS,
      AVATAR_CSS,
      CONSOLE_CLIENT_JS,
      CONSOLE_CLIENT_JS_ACCOUNTS,
      navScript(''),
    ].join('\u0000'),
  )
  .digest('hex')
  .slice(0, 16)

/** The navigation runtime every document with the card carries (`assets/nav.ts`). */
export const CONSOLE_NAV_JS = navScript(SHELL_KEY)

/** The area's title as the document's `<title>` says it. */
export function documentTitle(model: ShellModel): string {
  return `${BRAND} · ${model.title} · ${model.label}`
}

/**
 * The scripts a document with the card allows beyond the one it carries:
 * the open area's page script on its own (moving back to it runs it again
 * alone), then those of the areas its reader can move to. What `html()`
 * must be handed with the document, so the header and the `<meta>` state
 * one policy (`respond.ts`).
 */
export function shellScripts(model: ShellModel): readonly string[] {
  return [model.pageScript ?? '', ...(model.navScripts ?? [])].filter(
    script => script !== '',
  )
}

/** The card's own words, in the reader's language (`view/frontText.ts`). */
export interface SettingsWords {
  readonly settings: string
  readonly search: string
  readonly close: string
  readonly noMatch: string
  readonly desktop: string
  /** The skip link's words: past the list to the area. */
  readonly skip: string
}

/** The card a front document carries (`view/front.ts`). */
export interface SettingsCard {
  readonly model: ShellModel
  /**
   * The document is this area's (`/admin/…`): the card is drawn open with
   * the page in it. Otherwise it is drawn closed, with the list and nothing
   * else, for the page to open.
   */
  readonly open: boolean
  /** The token box at the foot: legacy tokens only, the accounts runtime keeps none. */
  readonly tokens: boolean
}

/**
 * The card: a native `<dialog>` the size of the window, which is the scrim,
 * around the card itself. `open` is drawn as the attribute, so the first
 * paint has it; the runtime makes it modal as soon as it starts.
 * `workTitle` is the document's title under the card, put back when it
 * closes.
 */
export function renderSettings(
  card: SettingsCard,
  words: SettingsWords,
  workTitle: string,
): string {
  const { model, open } = card
  const page = open ? model : undefined
  return (
    `<dialog class="set" id="settings" aria-labelledby="page-title" data-work-title="${attr(workTitle)}"${open ? ' open data-shown' : ''}>` +
    `<div class="set-card">` +
    // The way past the list (F1); the search, not this, is where the card
    // opens (autofocus).
    `<a class="skip-link" href="#main">${escapeHtml(words.skip)}</a>` +
    `<div class="set-side">` +
    `<label class="set-search">${icon('search', { small: true })}` +
    `<span class="sr-only">${escapeHtml(words.search)}</span>` +
    `<input type="search" id="set-search" placeholder="${attr(words.search)}" autocomplete="off" spellcheck="false" autofocus></label>` +
    `<nav class="nav set-nav" id="set-nav" aria-label="${attr(words.settings)}">${cardNav(model)}</nav>` +
    `<p class="set-none" id="set-none" hidden>${escapeHtml(words.noMatch)}</p>` +
    // The desktop app's own window (shortcuts, start at login, sign out),
    // shown by the runtime only inside the app (`qmo_open_local_settings`).
    `<button type="button" class="nav-item nav-gap set-desktop" id="set-desktop" data-action="settings-desktop" hidden>` +
    `${icon('laptop')}<span class="nav-label">${escapeHtml(words.desktop)}</span></button>` +
    `<div class="set-foot">` +
    (page?.poll === true ? refreshControl() : '') +
    // Which zone the page's times are in: the server's as drawn, the
    // reader's once the runtime has redrawn them (时区).
    `<p class="note set-zone" id="tz-note">时间 · ${escapeHtml(zoneLabel(Date.now()))} · 服务器时区</p>` +
    (card.tokens ? tokenControl() : '') +
    `</div></div>` +
    `<div class="set-body">` +
    `<header class="set-top">` +
    `<div class="set-lead">${page === undefined ? '' : breadcrumb(page.crumbs)}` +
    `<h2 class="page-title set-title" id="page-title">${page === undefined ? '' : escapeHtml(page.title)}</h2></div>` +
    `<div class="top-tail set-tail" id="set-tail">${page === undefined ? '' : topTail(page)}</div>` +
    `<button type="button" class="fx-icon-btn set-close" data-action="settings-close" aria-label="${attr(words.close)}">` +
    `${icon('x', { small: true })}</button></header>` +
    // Lit by the runtime when a refresh fails, with how old the page is (C2).
    // Outside every polled region, so the failure it reports cannot take it.
    `<p class="bar bar-warn conn" id="conn" role="status" hidden></p>` +
    `<div class="main set-main" id="main" tabindex="-1" role="region" aria-labelledby="page-title">` +
    (page === undefined ? '' : mainBody(page)) +
    `</div></div></div></dialog>`
  )
}

/**
 * One area's parts, for a move inside the card (`assets/nav.ts`): what
 * {@link renderSettings} draws open that changes from area to area, and
 * nothing it draws once. Markup fields are the same view output the document carries.
 */
export interface ShellPartial {
  /** {@link PARTIAL_VERSION}: the client loads a whole document for another. */
  readonly v: number
  /** {@link SHELL_KEY}: the frame these parts belong in. */
  readonly shell: string
  /** The document's `<title>`. */
  readonly documentTitle: string
  /** The card's title, as text. */
  readonly title: string
  /** The breadcrumb's `<nav>`, or empty for none. */
  readonly crumbs: string
  /** The inside of the title row's tail: the page's actions and the health strip. */
  readonly actions: string
  /** The inside of the card's page: the page, then the public edition's footer. */
  readonly main: string
  /** The inside of the card's list, the current item marked. */
  readonly nav: string
  /** The current item, or empty. */
  readonly active: string
  /** True when the page has polled regions: the refresh switch is shown. */
  readonly poll: boolean
  /** The refresh switch, for a document that has not drawn it yet; else empty. */
  readonly refresh: string
  /** The page's own sheet, comments stripped. */
  readonly css: string
  /** The page's own script, exactly as the policy hashed it; empty for none. */
  readonly script: string
  /** `'sha256-…'` of {@link ShellPartial.script}, empty for none. */
  readonly hash: string
}

/** The parts of the area {@link renderSettings} would draw open for `model`. */
export function shellPartial(model: ShellModel): ShellPartial {
  const script = model.pageScript ?? ''
  return {
    v: PARTIAL_VERSION,
    shell: SHELL_KEY,
    documentTitle: documentTitle(model),
    title: model.title,
    crumbs: breadcrumb(model.crumbs),
    actions: topTail(model),
    main: mainBody(model),
    nav: cardNav(model),
    active: model.active ?? '',
    poll: model.poll === true,
    refresh: model.poll === true ? refreshControl() : '',
    css: pageSheet(model.pageCss ?? ''),
    script,
    hash: script === '' ? '' : scriptHash(script),
  }
}

/** What a page outside the card says: an error with nowhere else to go. */
interface StandaloneModel {
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
    `<div class="brand">${qianmoMark(28)}<div class="brand-cn">${escapeHtml(WORDMARK_CN)}</div></div>` +
    `<p class="inst"><b>${escapeHtml(model.label)}</b></p>` +
    `<h1 class="page-title" id="page-title">${escapeHtml(model.title)}</h1>` +
    `<p class="note">${escapeHtml(model.line)}</p>` +
    detail +
    `<a class="btn btn-secondary" href="${attr(model.link.href)}">` +
    `${escapeHtml(model.link.label)}</a>` +
    `</main>\n</div>\n</body>\n</html>\n`
  )
}
