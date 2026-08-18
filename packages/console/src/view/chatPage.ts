// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The `/chat` document.
 *
 * Same shell as the ledger page — 15rem sidebar, tokens from `assets/css.ts`,
 * everything inlined so the page still loads nothing from anywhere — with a
 * different body: the sidebar carries the session rail instead of section
 * anchors, and the content pane is a transcript above a composer rather than a
 * scrolling column of rows.
 *
 * ## What survives a refresh and what does not
 *
 * The two mount points (`#chat-sessions`, `#chat-thread`) are replaced by the
 * poller and by the stream; the composer is not. That split is the reason the
 * composer's target chips are filled in by the client from `data-*` on the
 * thread rather than rendered here: a `<textarea>` holding half a question must
 * never be inside a region that a stream event can replace.
 *
 * ## The composer with nothing open
 *
 * Rendered disabled, with the reason, and **without a send button** — the same
 * rule the wake form follows on the ledger page. A greyed-out send button next
 * to an empty transcript invites a click that cannot do anything.
 */

import { CONSOLE_CHAT_JS } from '../assets/chatClient.js'
import { CONSOLE_CSS } from '../assets/css.js'
import { identityControl } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatDateTime } from './format.js'
import { MAX_CHAT_TEXT_LENGTH } from './chat.js'
import { BRAND, CSP } from './page.js'
import type { ConsoleRole } from '../auth.js'

export interface ChatPageModel {
  readonly label: string
  readonly now: number
  /** Which credential this render is for. Always `admin` in practice (§4.5). */
  readonly role: ConsoleRole
  /** Output of `renderChatSessions`. */
  readonly sessions: string
  /** Output of `renderChatThread`. */
  readonly thread: string
  /** False when no session is open, which disables the composer. */
  readonly composerEnabled: boolean
}

/** The one disabled-state sentence this page is allowed. */
const COMPOSER_DISABLED_REASON = '先选一条会话，再发消息'

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

/**
 * The composer.
 *
 * `Enter` sends and `Shift+Enter` breaks the line — the convention every chat
 * client on the operator's machine already uses, wired in the client script.
 * The round send button is the page's one filled control, matching the ledger
 * page's rule that `--primary` marks the primary action and nothing else.
 *
 * ## Why this one *is* rendered as a disabled control
 *
 * The wake form on the ledger page drops its submit button entirely when there
 * is no PSK, on the grounds that a greyed-out button invites a click that
 * cannot work. The rule is the same here and the answer is different, because
 * the two absences are: no PSK is a **configuration** state that a click will
 * never fix, while "no session open" is a **transient** state one click away in
 * the rail beside it. So the controls stay, disabled, with the sentence that
 * says which click — and the client re-enables them in place when a session
 * opens, without a navigation (see `assets/chatClient.ts` on why a navigation
 * would drop the credential).
 */
function composer(enabled: boolean): string {
  const chips =
    `<div class="composer-chips">` +
    `<span class="chip mono" id="composer-target">—</span>` +
    `<span class="state" id="composer-state">` +
    `<span class="dot dot-muted" id="composer-dot"></span>` +
    `<span id="composer-state-text">选一条会话</span></span>` +
    `</div>`

  const off = enabled ? '' : ' disabled'
  const box =
    `<textarea id="chat-text" rows="1" spellcheck="false" ` +
    `maxlength="${attr(String(MAX_CHAT_TEXT_LENGTH))}" ` +
    `aria-describedby="composer-why" ` +
    `placeholder="给智能体发消息"${off}></textarea>`

  const foot =
    `<div class="composer-foot">${chips}<span class="spacer"></span>` +
    `<button type="submit" class="send" id="chat-send" aria-label="发送"${off}>` +
    `↑</button></div>`

  return (
    `<form class="composer" id="composer" novalidate>` +
    `<p class="note" id="composer-why"${enabled ? ' hidden' : ''}>` +
    `${escapeHtml(COMPOSER_DISABLED_REASON)}</p>` +
    `<div class="composer-bar">${box}${foot}</div>` +
    `<p class="status" id="chat-status" role="status"></p>` +
    `</form>`
  )
}

/** The whole `/chat` document. Self-contained: nothing is fetched. */
export function renderChatPage(model: ChatPageModel): string {
  const title = `${BRAND} · 对话 · ${model.label}`
  const iso = Number.isFinite(model.now)
    ? new Date(model.now).toISOString()
    : ''

  const sidebar =
    `<aside class="sidebar">` +
    `<div class="sidebar-header"><a class="wordmark" href="/">阡陌</a></div>` +
    `<div class="chat-rail-mount">${model.sessions}</div>` +
    `<div class="sidebar-footer">` +
    // The client rewrites this href to carry the token when it has one in
    // `localStorage`: a top-level navigation cannot send an `Authorization`
    // header. Same trick, and the same accepted exposure, as the `?token=` URL
    // the CLI banner prints. A cookie session needs none of it — the browser
    // attaches the cookie to the navigation by itself, which is exactly why
    // documents accept a cookie alone (`auth.ts`).
    `<a class="nav-item nav-route" id="to-console" href="/">控制台</a>` +
    `<span class="sidebar-inst">${escapeHtml(model.label)}</span>` +
    `<time class="sidebar-clock" id="clock" datetime="${attr(iso)}">` +
    `${escapeHtml(formatDateTime(model.now))}</time>` +
    `<span class="group"><span id="stream-state"></span></span>` +
    identityControl(model.role) +
    tokenControl() +
    `</div></aside>`

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
    sidebar +
    `\n<div class="content chat-content">\n` +
    `<div class="thread-mount" id="thread-mount">${model.thread}</div>\n` +
    composer(model.composerEnabled) +
    `\n</div>\n</div>\n` +
    `<script>${CONSOLE_CHAT_JS}</script>\n` +
    `</body>\n</html>\n`
  )
}
