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
#prov-chat-label { flex: none; }
.prov-chat-divider {
  display: flex; align-items: center; gap: var(--space-3);
  font-size: 12px; color: var(--color-muted); margin: var(--space-2) 0;
}
.prov-chat-divider::before, .prov-chat-divider::after {
  content: ""; flex: 1; height: 1px; background: var(--color-divider);
}
@media (max-width: 1000px) {
  .chat-layout { grid-template-columns: minmax(0, 1fr); }
  .chat-rail { position: static; max-height: none; }
  .chat-pane { min-height: 0; }
}
`

/**
 * The target's model (§6.3.8, P18.9): a read-only label in the thread head,
 * and a divider in the transcript where the node last switched.
 *
 * Both come from `/fragments/providers/chat?target=<address>`, the model
 * service area's answer built from what the node reported (`effective`,
 * `applied.at`), never from the conversation store, which is not touched.
 * The thread is replaced on every poll and stream event, so this repaints
 * after each replacement from the last answer, and asks again at most every
 * 30 s or when the target changes. An empty answer — no model service on
 * this console, or a node it does not manage — draws nothing.
 *
 * The divider goes before the first turn whose `data-at` is after the switch;
 * a switch older than the first turn on the page draws no divider, because
 * there is no "here" for it in what is shown.
 */
const CHAT_MODEL_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  var mount = document.getElementById('thread-mount');
  if (!qc || !mount) return;
  var REUSE_MS = 30000;
  var known = { target: '', html: '', at: 0 };
  var asking = false;
  var painting = false;

  function paint() {
    var thread = document.getElementById('chat-thread');
    var old = document.querySelectorAll('[data-prov-chat]');
    for (var i = 0; i < old.length; i++) old[i].remove();
    if (!thread || known.html === '' ||
        thread.getAttribute('data-target') !== known.target) return;
    var tpl = document.createElement('template');
    tpl.innerHTML = known.html;
    var label = tpl.content.querySelector('#prov-chat-label');
    var tail = thread.querySelector('.chat-tail');
    if (label && tail) {
      label.setAttribute('data-prov-chat', '');
      tail.insertBefore(label, tail.firstChild);
    }
    var divider = tpl.content.querySelector('#prov-chat-divider');
    var transcript = thread.querySelector('.transcript');
    if (!divider || !transcript) return;
    var at = Number(divider.getAttribute('data-at'));
    var turns = transcript.querySelectorAll('article.turn');
    var first = turns.length > 0 ? turns[0].querySelector('time[data-at]') : null;
    if (!first || !(Number(first.getAttribute('data-at')) < at)) return;
    for (var j = 0; j < turns.length; j++) {
      var when = turns[j].querySelector('time[data-at]');
      if (when && Number(when.getAttribute('data-at')) >= at) {
        divider.setAttribute('data-prov-chat', '');
        transcript.insertBefore(divider, turns[j]);
        return;
      }
    }
  }

  function ask() {
    var thread = document.getElementById('chat-thread');
    var target = thread ? thread.getAttribute('data-target') || '' : '';
    if (target === '') { known = { target: '', html: '', at: 0 }; return; }
    if (asking || (target === known.target && Date.now() - known.at < REUSE_MS)) return;
    asking = true;
    qc.loadHtml('/fragments/providers/chat?target=' + encodeURIComponent(target))
      .then(function (html) { known = { target: target, html: html.trim(), at: Date.now() }; })
      .catch(function () { known = { target: target, html: '', at: Date.now() }; })
      .then(function () { asking = false; repaint(); });
  }

  function repaint() {
    if (painting) return;
    painting = true;
    try { paint(); } finally { painting = false; }
  }

  // Only a change this script did not make: its own label and divider going
  // in and out would otherwise be a loop.
  function foreign(records) {
    for (var i = 0; i < records.length; i++) {
      var lists = [records[i].addedNodes, records[i].removedNodes];
      for (var k = 0; k < lists.length; k++) {
        for (var n = 0; n < lists[k].length; n++) {
          var node = lists[k][n];
          if (!(node.nodeType === 1 && node.hasAttribute('data-prov-chat'))) return true;
        }
      }
    }
    return false;
  }

  new MutationObserver(function (records) {
    if (!foreign(records)) return;
    repaint();
    ask();
  }).observe(mount, { childList: true, subtree: true });
  ask();
})();
`

/** The page's script. Runs after the shared runtime (`assets/client.ts`). */
export const CHAT_PAGE_SCRIPT = CONSOLE_CHAT_JS + CHAT_MODEL_JS

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
