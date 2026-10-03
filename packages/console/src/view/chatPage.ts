// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `/chat` page: a session rail beside a transcript above a composer.
 *
 * Drawn inside the shell like every other page (`view/shell.ts`). What used to
 * be a second copy of the sidebar, the role chip and the token box is gone —
 * the shell has exactly one of each — and the session rail moved out of the
 * sidebar into the page's own left column, where it no longer competes with
 * the console's navigation for the panel's height.
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
 * Rendered disabled, with the reason, and with the controls left in place.
 * This is the opposite of the wake form's answer on the nodes page, and the
 * two absences are different: no PSK is a **configuration** state that a
 * click will never fix, while "no session open" is a **transient** state one
 * click away in the rail beside it. So the controls stay, disabled, with the
 * sentence that says which click — and the client re-enables them in place
 * when a session opens, without a navigation (see `assets/chatClient.ts` on
 * why a navigation would drop the credential).
 */

import { CONSOLE_CHAT_JS } from '../assets/chatClient.js'
import type { ConsoleRole } from '../auth.js'
import { icon, type PageViewer } from './bits.js'
import { MAX_CHAT_TEXT_LENGTH } from './chat.js'
import { attr, escapeHtml } from './escape.js'
import { renderShell, type ShellNavGroup } from './shell.js'

export interface ChatPageModel {
  readonly label: string
  readonly now: number
  /** Which credential this render is for (`console.md` §4.5). */
  readonly role: ConsoleRole
  /** Output of `renderChatSessions`. */
  readonly sessions: string
  /** Output of `renderChatThread`. */
  readonly thread: string
  /** False when no session is open, which disables the composer. */
  readonly composerEnabled: boolean
  /** Who this page is for, when personal accounts are on. */
  readonly viewer?: PageViewer
  /** The shell's navigation; absent renders the page with an empty sidebar. */
  readonly nav?: readonly ShellNavGroup[]
}

/** The one disabled-state sentence this page is allowed. */
const COMPOSER_DISABLED_REASON = '先选一条会话 · 再发消息'

/**
 * The page's own layout: the rail beside the conversation. Only this page
 * needs it, so it rides with the page rather than in the shared sheet.
 */
export const CHAT_PAGE_CSS = `
.chat-layout {
  display: grid; grid-template-columns: 280px minmax(0, 1fr);
  gap: var(--space-4); align-items: start;
}
.chat-rail {
  display: flex; flex-direction: column; gap: var(--space-3);
  padding: var(--space-4); background: var(--color-surface);
  border-radius: calc(var(--radius-lg) * 1.15);
  position: sticky; top: var(--space-4);
  max-height: calc(100vh - var(--space-8)); overflow-y: auto;
}
.chat-rail-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.chat-pane {
  display: flex; flex-direction: column; gap: var(--space-4); min-width: 0;
  min-height: calc(100vh - 180px);
}
@media (max-width: 1000px) {
  .chat-layout { grid-template-columns: minmax(0, 1fr); }
  .chat-rail { position: static; max-height: none; }
  .chat-pane { min-height: 0; }
}
`

/** The page's script. Runs after the shared runtime (`assets/client.ts`). */
export const CHAT_PAGE_SCRIPT = CONSOLE_CHAT_JS

/**
 * The composer.
 *
 * `Enter` sends and `Shift+Enter` breaks the line — the convention every chat
 * client on the operator's machine already uses, wired in the page script. The
 * round send button is the page's one filled control, matching the console's
 * rule that the accent marks the primary action and nothing else.
 */
function composer(enabled: boolean): string {
  const off = enabled ? '' : ' disabled'
  const box =
    `<textarea id="chat-text" rows="1" spellcheck="false" ` +
    `maxlength="${attr(String(MAX_CHAT_TEXT_LENGTH))}" ` +
    `aria-describedby="composer-why" aria-label="消息" ` +
    `placeholder="写下要让这个智能体做的事 · Enter 发送 · Shift Enter 换行"${off}></textarea>`

  const foot =
    `<div class="composer-foot">` +
    `<span class="tag tag-neutral mono" id="composer-target">—</span>` +
    `<span class="state" id="composer-state">` +
    `<span class="dot dot-muted" id="composer-dot"></span>` +
    `<span id="composer-state-text">选一条会话</span></span>` +
    `<button type="submit" class="btn btn-primary btn-icon send" ` +
    `id="chat-send" data-write aria-label="发送"${off}>` +
    icon('arrow-up') +
    `</button></div>`

  return (
    `<form class="composer" id="composer" novalidate>` +
    `<p class="note" id="composer-why"${enabled ? ' hidden' : ''}>` +
    `${escapeHtml(COMPOSER_DISABLED_REASON)}</p>` +
    box +
    foot +
    `<p class="status" id="chat-status" role="status"></p>` +
    `</form>`
  )
}

/** The page body the shell frames: the rail, the transcript, the composer. */
export function chatPageBody(
  model: Pick<ChatPageModel, 'sessions' | 'thread' | 'composerEnabled'>,
): string {
  return (
    `<div class="chat-layout">` +
    `<aside class="chat-rail" aria-label="会话">` +
    `<div class="chat-rail-head"><span class="flabel">会话</span>` +
    `<span class="fblock"><span class="flabel">连接</span>` +
    `<span id="stream-state"></span></span></div>` +
    `<div class="chat-rail-mount">${model.sessions}</div>` +
    `</aside>` +
    `<div class="chat-pane">` +
    `<div class="thread-mount" id="thread-mount">${model.thread}</div>` +
    composer(model.composerEnabled) +
    `</div></div>`
  )
}

/** The whole `/chat` document, drawn in the shell. */
export function renderChatPage(model: ChatPageModel): string {
  return renderShell({
    label: model.label,
    role: model.role,
    ...(model.viewer === undefined ? {} : { viewer: model.viewer }),
    nav: model.nav ?? [],
    active: 'chat',
    crumbs: [{ label: '运行' }, { label: '对话' }],
    title: '对话',
    body: chatPageBody(model),
    pageCss: CHAT_PAGE_CSS,
    pageScript: CHAT_PAGE_SCRIPT,
  })
}
