// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The document the three fragments hang on.
 *
 * `renderPage` owns everything that must survive a refresh: the sidebar, the
 * register form, the wake form, the mount points, the stylesheet and the
 * script. The fragments own everything that changes. Splitting it that way lets
 * a five-second poller run without taking the keyboard focus out of a
 * half-typed address.
 *
 * ## The shell: a sidebar, not a top bar
 *
 * The page used to open with 44px of sticky chrome across the top. It is now a
 * fixed 15rem sidebar down the left — wordmark, then five anchors to the
 * sections below, then the instance label, the clock and the token input at the
 * foot. The shell locks the viewport height; the sidebar and the content pane
 * scroll independently, so a long node roster never pushes the navigation out of
 * reach. Under 900px the sidebar collapses into a horizontal strip above the
 * content, because there is no room left on a phone-width screen for a rail down
 * the side.
 *
 * ## The page is a ledger
 *
 * Every row below the overview is `[rail][pane]`: a 140px left column holding
 * the section noun and one dense line of digits, and the rest holding the table
 * or the form. The sections are 节点 · 注册 · 消息链 · 限额 · 唤醒 and there is
 * no explanatory line under any of them — a sentence telling an operator what a
 * table of nodes is gets read exactly once and occupies the page forever. What
 * replaced those sentences is the digits: `4 · 在线 2`, `512 · 断裂 2`. Two
 * places are still allowed a line of their own, and both are places where the
 * page has to name an action rather than a fact: the empty state (`还没有节点 ·
 * 在下面注册第一个`) and the disabled wake face (the missing variable).
 *
 * Two of the rails are rendered by the fragments rather than here, because
 * their digits come from the same data as their tables and have to be replaced
 * by the same poll. See the module note in `agents.ts`.
 *
 * ## The overview cards read the rails, not a second copy of the data
 *
 * `renderRoster` and `renderAudit` already compute the counts their rails
 * print; `renderLimits` already computes the rate and the lease TTL. Rather
 * than give `PageModel` a second, raw shape of the same numbers just so the
 * four cards at the top of the page can have them, the rail markup carries
 * them out as `data-*` attributes (see the `stats` option on {@link rail} in
 * `bits.ts`) and {@link overviewSection} reads those back off the already-
 * rendered fragment strings. One source of truth for each number, even though
 * it crosses a module boundary as a string rather than as a value.
 *
 * ## There is no alert banner
 *
 * A broken audit chain used to pin a full-bleed dark red banner above the whole
 * page. It now reads `断裂 2` in destructive on the 消息链 rail, with a one-line
 * alert strip at the top of the results — and the same number is the hint under
 * the 消息链 stat card. A banner that wide gets classified as chrome and stops
 * being read; two red characters in a column of black ones do not.
 *
 * ## The page loads nothing
 *
 * No stylesheet link, no script src, no font file, no image. CSS and JS are
 * inlined from `../assets/`, and the CSP says the same thing in a form the
 * browser enforces: `default-src 'none'` with `connect-src 'self'` for polling.
 * Inter is reached for by name in the stylesheet, never `@import`ed or linked —
 * if the machine has it, the page uses it; if not, the system sans stack takes
 * over and nothing was fetched either way. A console that reaches out to a CDN
 * is a console whose contents depend on a third party's good behaviour while it
 * holds a registry token.
 *
 * ## The wake form when there is no PSK
 *
 * `ConsoleDeps.wake` is optional. When it is absent the fields render inside a
 * disabled `<fieldset>` with the reason, and **no submit button at all**. A
 * greyed-out button still invites a click; a missing one, next to the name of
 * the variable, says what to go and do.
 */

import { CONSOLE_CLIENT_JS } from '../assets/client.js'
import { CONSOLE_CSS } from '../assets/css.js'
import { rail, type Tone } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatDateTime, formatDuration } from './format.js'
import type { AuditFilter } from '../deps.js'

export interface PageModel {
  readonly label: string
  readonly now: number
  /** Output of `renderRoster`. */
  readonly roster: string
  /** Output of `renderAudit`. */
  readonly audit: string
  /** Output of `renderLimits`. */
  readonly limits: string
  readonly wakeEnabled: boolean
  readonly auditFilter: AuditFilter
}

/**
 * Content-Security-Policy, as strict as an inline-everything page can be.
 *
 * `'unsafe-inline'` is unavoidable for the one style and the one script — but
 * every *host* directive stays `'none'`, which is the half that matters: no
 * origin other than this one can contribute anything, and `connect-src 'self'`
 * keeps the token from being sent anywhere else.
 */
const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "img-src 'none'",
  "font-src 'none'",
].join('; ')

const REFRESH_CHOICES: readonly (readonly [string, string])[] = [
  ['2000', '2s'],
  ['5000', '5s'],
  ['10000', '10s'],
  ['30000', '30s'],
]

const DEFAULT_REFRESH = '5000'

/** The product mark. The instance name sits beside it, never merged into it. */
const BRAND = '阡陌 console'

/**
 * The filter, as the query string the poller replays.
 *
 * Instants go out as epoch milliseconds — exact and zone-free. The filter form
 * beside it can only emit `datetime-local` strings, so the HTTP side has to
 * read both shapes anyway; given that, the poller uses the precise one.
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
  put('from', filter.from)
  put('to', filter.to)
  put('limit', filter.limit)
  return params.toString()
}

function field(
  name: string,
  label: string,
  placeholder: string,
  options: { readonly required?: boolean; readonly wide?: boolean } = {},
): string {
  const cls = options.wide === true ? 'field field-wide' : 'field'
  // Required is a bare asterisk after the label, not a red tag. Colour on this
  // page means state, and "you have not typed this yet" is not a state of the
  // network.
  const mark = options.required === true ? '<i class="req">*</i>' : ''
  const required = options.required === true ? ' required' : ''
  return (
    `<label class="${cls}"><span>${escapeHtml(label)}${mark}</span>` +
    `<input type="text" name="${attr(name)}" placeholder="${attr(
      placeholder,
    )}" autocomplete="off" spellcheck="false"${required}></label>`
  )
}

/** One `[rail][pane]` row. The rail is a noun; the pane is the thing itself. */
function row(
  name: string,
  pane: string,
  options: {
    readonly id?: string
    readonly headingId?: string
    readonly sub?: boolean
  } = {},
): string {
  const id = options.id === undefined ? '' : ` id="${attr(options.id)}"`
  return (
    `<div class="row"${id}>` +
    rail(name, { id: options.headingId, sub: options.sub }) +
    `<div class="pane">${pane}</div></div>`
  )
}

function registerForm(): string {
  return (
    `<form id="register-form" class="form" novalidate>` +
    field('address', '地址', 'qianmo://node-a/reviewer', { required: true }) +
    // The registry's isValidEndpoint takes a schemed URL (ws:// et al.) or a
    // qianmo:// address — a bare host:port is refused with a 400. The
    // placeholder must teach a format that will actually be accepted.
    field('endpoint', '端点', 'ws://主机:端口', { required: true }) +
    field('capabilities', '能力', '逗号分隔') +
    `<label class="field field-narrow"><span>状态</span>` +
    `<select name="status">` +
    `<option value="online" selected>在线</option>` +
    `<option value="dormant">休眠</option>` +
    `</select></label>` +
    `<label class="field field-wide"><span>公钥</span>` +
    `<textarea name="publicKey" rows="2" spellcheck="false" ` +
    `placeholder="可选"></textarea></label>` +
    `<div class="field field-actions">` +
    `<button type="submit" class="btn btn-primary">注册</button></div>` +
    `</form>` +
    `<p class="status" id="register-status" role="status"></p>`
  )
}

/**
 * The one disabled-state sentence the page is allowed.
 *
 * Both halves are load-bearing: what is unavailable, and the exact name of the
 * thing to go and set. "唤醒不可用" on its own sends somebody to the docs.
 */
const WAKE_DISABLED_REASON = '唤醒不可用 · 未设置 QIANMO_TRANSPORT_PSK'

function wakeBody(enabled: boolean): string {
  const fields =
    field('from', '发起方', 'qianmo://node-a/console', { required: true }) +
    field('to', '目标', 'qianmo://node-b/reviewer', { required: true }) +
    field('url', '回调', '可选') +
    `<label class="field field-narrow"><span>延迟</span>` +
    `<input type="number" name="afterMs" min="0" placeholder="0"></label>` +
    `<label class="field field-wide"><span>提示词<i class="req">*</i></span>` +
    `<textarea name="prompt" rows="3"></textarea></label>`

  if (enabled) {
    return (
      `<form id="wake-form" class="form" novalidate>${fields}` +
      `<div class="field field-actions">` +
      `<button type="submit" class="btn btn-primary">唤醒</button></div>` +
      `</form><p class="status" id="wake-status" role="status"></p>`
    )
  }
  return (
    `<p class="note" id="wake-why">${escapeHtml(WAKE_DISABLED_REASON)}</p>` +
    `<fieldset disabled aria-describedby="wake-why">` +
    `<div class="form">${fields}</div></fieldset>`
  )
}

function refreshControl(): string {
  const options = REFRESH_CHOICES.map(
    ([value, label]) =>
      `<option value="${attr(value)}"${
        value === DEFAULT_REFRESH ? ' selected' : ''
      }>${escapeHtml(label)}</option>`,
  ).join('')
  return (
    `<span class="group">` +
    `<label><input type="checkbox" id="auto-refresh" checked> 刷新</label>` +
    `<select id="refresh-interval" aria-label="刷新间隔">${options}</select>` +
    `<span id="refresh-state"></span></span>`
  )
}

function tokenControl(): string {
  return (
    `<span class="group">` +
    `<label class="sr-only" for="token">令牌</label>` +
    `<input type="password" id="token" autocomplete="off" spellcheck="false" ` +
    `placeholder="令牌">` +
    `<button type="button" class="btn" data-action="token-save">保存</button>` +
    `<button type="button" class="btn" data-action="token-clear">清除</button>` +
    `<span id="token-state"></span></span>`
  )
}

/** Anchors down the sidebar. Each targets a section id that already exists. */
const NAV_ITEMS: readonly (readonly [string, string])[] = [
  ['#overview', '总览'],
  ['#nodes-section', '节点'],
  ['#trail-section', '消息链'],
  ['#limits-section', '限额'],
  ['#wake-section', '唤醒'],
]

function sidebarNav(): string {
  const items = NAV_ITEMS.map(
    ([href, label]) =>
      `<a class="nav-item" href="${attr(href)}">${escapeHtml(label)}</a>`,
  ).join('')
  return `<nav class="sidebar-nav" aria-label="章节">${items}</nav>`
}

/**
 * The left rail of the shell: wordmark, section anchors, then the instance
 * identity and the two controls that used to live in the top bar.
 *
 * `:target`/scroll-position highlighting on the active anchor was explicitly
 * left undone — the anchors are a jump list, not a router, and the section
 * the operator is looking at is already obvious from the content beside it.
 */
function sidebar(model: PageModel, iso: string): string {
  return (
    `<aside class="sidebar">` +
    `<div class="sidebar-header">` +
    `<a class="wordmark" href="#overview">阡陌</a>` +
    `</div>` +
    sidebarNav() +
    `<div class="sidebar-footer">` +
    `<span class="sidebar-inst">${escapeHtml(model.label)}</span>` +
    `<time class="sidebar-clock" id="clock" datetime="${attr(iso)}">` +
    `${escapeHtml(formatDateTime(model.now))}</time>` +
    refreshControl() +
    tokenControl() +
    `</div>` +
    `</aside>`
  )
}

function statCard(card: {
  readonly label: string
  readonly value: string
  readonly hint: string
  readonly tone?: Tone
}): string {
  const toneCls = card.tone === undefined ? '' : ` tone-${card.tone}`
  return (
    `<div class="stat-card">` +
    `<p class="stat-label">${escapeHtml(card.label)}</p>` +
    `<p class="stat-value">${escapeHtml(card.value)}</p>` +
    `<p class="stat-hint${toneCls}">${escapeHtml(card.hint)}</p>` +
    `</div>`
  )
}

/**
 * Read one `data-*` number back off a fragment this module did not render.
 *
 * The key is always one of our own literals (see the `stats` note on
 * {@link rail}), so this is not parsing hostile input — it is one module
 * reading a value another module already computed and escaped, rather than
 * `PageModel` growing a second, raw copy of every count on the page.
 */
function fragmentStat(html: string, key: string): string | null {
  const match = html.match(new RegExp(`data-${key}="([^"]*)"`))
  return match === null ? null : match[1]
}

const OVERVIEW_HEADING_ID = 'h-overview'

/**
 * The four cards above the ledger: how many nodes, how much trail (and
 * whether it still verifies), how long a lease lasts, and the protocol rate
 * ceiling. Every number here already exists on the page one scroll down —
 * this section is a summary, not a second source, which is why it reads its
 * numbers off the rendered fragments rather than being handed raw data.
 */
function overviewSection(model: PageModel): string {
  const nodesTotal = fragmentStat(model.roster, 'total')
  const nodesOnline = fragmentStat(model.roster, 'online')
  const trailTotal = fragmentStat(model.audit, 'total')
  const trailIssues = fragmentStat(model.audit, 'issues')
  const ttlMs = fragmentStat(model.limits, 'ttl-ms')
  const rate = fragmentStat(model.limits, 'rate')
  const issues = trailIssues === null ? 0 : Number(trailIssues)

  const cards = [
    statCard({
      label: '节点',
      value: nodesTotal ?? '—',
      hint: nodesOnline === null ? '—' : `在线 ${nodesOnline}`,
    }),
    statCard({
      label: '消息链',
      value: trailTotal ?? '—',
      hint: issues > 0 ? `断裂 ${issues}` : '完整',
      tone: issues > 0 ? 'bad' : undefined,
    }),
    statCard({
      label: '租约 TTL',
      value: ttlMs === null ? '—' : formatDuration(Number(ttlMs)),
      hint: '注册租约',
    }),
    statCard({
      label: '速率',
      value: rate === null ? '—' : `${rate} / 分`,
      hint: '节点 × 节点',
    }),
  ].join('')

  return (
    `<section class="block overview" id="overview" aria-labelledby="${OVERVIEW_HEADING_ID}">` +
    `<h2 class="section-label" id="${OVERVIEW_HEADING_ID}">总览</h2>` +
    `<div class="stat-grid">${cards}</div>` +
    `</section>`
  )
}

/** The whole document. Self-contained: nothing is fetched from anywhere. */
export function renderPage(model: PageModel): string {
  const title = `${BRAND} · ${model.label}`
  const iso = Number.isFinite(model.now)
    ? new Date(model.now).toISOString()
    : ''

  const overview = overviewSection(model)

  const nodes =
    `<section class="block" id="nodes-section" aria-labelledby="h-nodes">` +
    `<div class="row" id="roster">${model.roster}</div>` +
    row('注册', registerForm(), { id: 'register', sub: true }) +
    `</section>`

  const trail =
    `<section class="block" id="trail-section" aria-labelledby="h-trail">` +
    `<div class="row" id="audit" data-query="${attr(
      auditQuery(model.auditFilter),
    )}">${model.audit}</div>` +
    // The chain panel is opened by a trace cell and is page-owned, so it is a
    // row of its own with an empty rail rather than part of the polled region.
    `<div class="row"><div class="rail"></div><div class="pane">` +
    `<div class="chain" id="chain" hidden></div></div></div>` +
    `</section>`

  const limits =
    `<section class="block" id="limits-section" aria-labelledby="h-limits">` +
    `<div class="row">` +
    rail('限额', { id: 'h-limits' }) +
    `<div class="pane" id="limits">${model.limits}</div></div>` +
    `</section>`

  const wake =
    `<section class="block" id="wake-section" aria-labelledby="h-wake">` +
    row('唤醒', wakeBody(model.wakeEnabled), { headingId: 'h-wake' }) +
    `</section>`

  return (
    `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta name="color-scheme" content="light dark">\n` +
    `<meta name="referrer" content="no-referrer">\n` +
    `<meta http-equiv="Content-Security-Policy" content="${attr(CSP)}">\n` +
    `<title>${escapeHtml(title)}</title>\n` +
    `<style>${CONSOLE_CSS}</style>\n` +
    `</head>\n<body>\n` +
    `<div class="shell">\n` +
    sidebar(model, iso) +
    `\n<div class="content">\n<main>\n${overview}\n${nodes}\n${trail}\n${limits}\n${wake}\n</main>\n</div>\n` +
    `</div>\n` +
    `<script>${CONSOLE_CLIENT_JS}</script>\n` +
    `</body>\n</html>\n`
  )
}
