// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 快速输入 — `/app/quick`, the desktop app's quick entry (`docs/dev/qmo-app.md`
 * §4.3, P37.11).
 *
 * One floating card and nothing around it: the agent the line goes to (the
 * main agent; its figure opens the roster to pick another), one line that
 * grows to four, and send. In the desktop app the page is transparent and
 * the card is the whole window; in a browser it sits on the page's own
 * ground, near the top. The card is a top-anchored block, so a window taller
 * than the card leaves the rest of it clear for the line to grow and the
 * roster to open.
 *
 * Sending opens a conversation and sends the line through the chat routes
 * the front uses (`POST /v0/chat/sessions`, then `…/messages`), then asks the
 * desktop app to show it in the main window (`qmo_open_session`); a browser
 * goes to `/app?session=<id>` instead (`assets/quickClient.ts`). The page
 * reads the roster and the figures and nothing else — no transcript, no
 * session list — and is behind the front's own door (`http.ts`).
 *
 * The card's measures follow the reference studied for the desktop app
 * (`desktop-ref/claude-desktop.md` §1.3): about 606 px wide, a 16 px corner,
 * a 56 px row with the figure in a 56 px cell, 16/24 text, a hairline edge.
 */

import {
  CONSOLE_CLIENT_JS,
  CONSOLE_CLIENT_JS_ACCOUNTS,
} from '../assets/client.js'
import { QUICK_JS } from '../assets/quickClient.js'
import type { ChatTarget } from '../deps.js'
import type { Lang } from '../i18n.js'
import { AVATAR_CSS, avatarSvg } from './avatar.js'
import { icon } from './bits.js'
import { type ChatFaces, MAX_CHAT_TEXT_LENGTH } from './chat.js'
import { attr, escapeHtml } from './escape.js'
import { FRONT_TEXT, frontClientText } from './frontText.js'
import { documentHead, sessionExpired, WORDMARK_CN } from './shell.js'

interface QuickModel {
  readonly label: string
  /** The roster; `null` when nobody could ask the registry. */
  readonly targets: readonly ChatTarget[] | null
  /** The main agent's address, when there is one. */
  readonly main: string | null
  readonly faces: ChatFaces
  /** The login door with the way back here. */
  readonly relogin: string
  readonly lang: Lang
  /** Personal accounts are on: the runtime that keeps no credential. */
  readonly accounts: boolean
}

/** The roster under the figure: the main agent first, then the rest as listed. */
function quickRoster(model: QuickModel): string {
  const t = FRONT_TEXT[model.lang]
  const targets = model.targets ?? []
  const ordered = [
    ...targets.filter(target => target.address === model.main),
    ...targets.filter(target => target.address !== model.main),
  ]
  const items = ordered.map(
    target =>
      `<button type="button" class="fx-quick-item" role="menuitemradio" ` +
      `aria-checked="${target.address === model.main ? 'true' : 'false'}" ` +
      `data-agent-pick="${attr(target.address)}" data-name="${attr(target.agent)}"` +
      `${target.dialable ? '' : ' disabled'}>` +
      `<span class="fx-quick-item-face">${avatarSvg(
        model.faces.agent(target.address),
        { size: 24, state: target.dialable ? 'idle' : 'sleep' },
      )}</span>` +
      `<span class="fx-quick-item-name">${escapeHtml(target.agent)}</span>` +
      `<small>${escapeHtml(target.node)}</small>` +
      icon('check', { small: true }) +
      `</button>`,
  )
  return (
    `<div class="fx-quick-menu" id="fx-quick-menu" role="menu" aria-label="${attr(t.pickAgent)}" hidden>` +
    (items.length === 0
      ? `<p class="fx-quick-none">${escapeHtml(
          model.targets === null ? t.rosterDown : t.noAgents,
        )}</p>`
      : items.join('')) +
    `</div>`
  )
}

/** The whole quick-entry document. */
export function renderQuickDocument(model: QuickModel): string {
  const t = FRONT_TEXT[model.lang]
  const script =
    (model.accounts ? CONSOLE_CLIENT_JS_ACCOUNTS : CONSOLE_CLIENT_JS) + QUICK_JS
  const main =
    model.main === null
      ? null
      : ((model.targets ?? []).find(target => target.address === model.main) ??
        null)
  const name = main?.agent ?? ''
  const ready = main?.dialable === true
  const face =
    model.main === null
      ? icon('bot', { small: true })
      : avatarSvg(model.faces.agent(model.main), { size: 28 })
  return (
    documentHead(
      `${WORDMARK_CN} · ${t.quickEntry} · ${model.label}`,
      FRONT_QUICK_CSS + AVATAR_CSS,
      [script],
    ).replace('<html lang="zh-CN">', `<html lang="${attr(model.lang)}">`) +
    `<body class="fx-quick-body">\n` +
    `<h1 class="sr-only">${escapeHtml(`${WORDMARK_CN} · ${t.quickEntry}`)}</h1>` +
    `<main class="fx-quick" id="fx-quick" data-main="${attr(model.main ?? '')}" ` +
    `data-text="${attr(frontClientText(model.lang))}">` +
    `<form class="fx-quick-card" id="fx-quick-form" novalidate data-tauri-drag-region>` +
    `<div class="fx-quick-who">` +
    `<button type="button" class="fx-quick-face" id="fx-quick-agent" aria-haspopup="menu" ` +
    `aria-expanded="false" aria-controls="fx-quick-menu" ` +
    `aria-label="${attr(name === '' ? t.switchAgent : `${t.switchAgent} · ${name}`)}">${face}</button>` +
    quickRoster(model) +
    `</div>` +
    `<label class="sr-only" for="fx-quick-text">${escapeHtml(t.message)}</label>` +
    `<textarea id="fx-quick-text" rows="1" spellcheck="false" ` +
    `maxlength="${attr(String(MAX_CHAT_TEXT_LENGTH))}" aria-describedby="fx-quick-status" ` +
    `placeholder="${attr(t.placeholder)}"${ready ? '' : ' disabled'}></textarea>` +
    `<button type="submit" class="fx-quick-send" id="fx-quick-send" aria-label="${attr(t.send)}" disabled>` +
    `${icon('arrow-up', { small: true })}</button>` +
    `<p class="fx-quick-status" id="fx-quick-status" role="status"></p>` +
    `</form></main>\n` +
    sessionExpired(model.relogin, model.lang) +
    `<div class="toasts" id="toasts" aria-live="polite" aria-relevant="additions"></div>\n` +
    `<script>${script}</script>\n` +
    `</body>\n</html>\n`
  )
}

/**
 * The card's sheet. Its tokens are the console's (`assets/css.ts`); in the
 * desktop app (`<html data-shell>`) the page around the card is transparent.
 */
const FRONT_QUICK_CSS = `
html:has(body.fx-quick-body), body.fx-quick-body { height: 100%; }
body.fx-quick-body { margin: 0; overflow: hidden; background: var(--color-bg); -webkit-font-smoothing: antialiased; }
/* The desktop app's quick window is transparent: only the card is drawn.
   A dark scheme on the root would paint the canvas dark, so the root keeps a
   light one and the card takes the theme's scheme for its own controls. */
:root[data-shell]:has(body.fx-quick-body) { background: transparent; color-scheme: only light; }
:root[data-shell] body.fx-quick-body { background: transparent; }
:root[data-shell] .fx-quick { color-scheme: light dark; }
:root[data-shell][data-theme="dark"] .fx-quick { color-scheme: dark; }
:root[data-shell][data-theme="light"] .fx-quick { color-scheme: light; }
.fx-quick-body [hidden], .fx-quick-body dialog:not([open]) { display: none !important; }
.fx-quick {
  display: flex; justify-content: center; padding: max(16px, 18vh) 16px 16px;
}
:root[data-shell] .fx-quick { padding: 16px 16px 32px; }
/* The card's size and corner are the quick window's own (qmo-app.md §4.3);
   its ground, shadow, type and motion are the shared tokens. */
.fx-quick-card {
  position: relative; display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; align-items: start;
  width: min(606px, 100%); min-height: 56px;
  border-radius: var(--radius-quick); background: var(--ui-menu); color: var(--color-text); box-shadow: var(--shadow-lg);
}
.fx-quick-who { position: relative; width: 56px; height: 56px; }
.fx-quick-face {
  display: grid; place-items: center; width: 56px; height: 56px; padding: 0; border: 0;
  border-radius: var(--radius-quick) 0 0 var(--radius-quick); background: none; color: var(--color-muted); cursor: pointer;
}
.fx-quick-face .avatar { display: block; transition: transform var(--motion-snap) var(--ease-out); }
.fx-quick-face:hover .avatar, .fx-quick-face[aria-expanded="true"] .avatar { transform: scale(1.06); }
.fx-quick-face:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -4px; }
.fx-quick-card textarea {
  display: block; width: 100%; min-height: 56px; max-height: 128px; margin: 0; padding: 16px 4px; resize: none;
  border: 0; background: none; color: var(--color-text); outline: none;
  font: inherit; font-size: var(--text-prose); line-height: var(--lh-prose);
}
.fx-quick-card textarea::placeholder { color: var(--color-muted); }
.fx-quick-send {
  display: inline-grid; place-items: center; width: 32px; height: 32px; margin: 12px 12px 12px 8px; padding: 0;
  border: 0; border-radius: 50%; cursor: pointer;
  background: var(--color-accent-fill); color: var(--color-on-accent-fill);
  transition: opacity var(--motion-snap) var(--ease-out), transform var(--motion-snap) var(--ease-out);
}
.fx-quick-send .i-sm { width: 16px; height: 16px; stroke-width: 2.4; }
.fx-quick-send:active:not(:disabled) { transform: scale(0.94); }
.fx-quick-send:disabled { opacity: 0.22; cursor: not-allowed; }
.fx-quick-send:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
.fx-quick[aria-busy="true"] .fx-quick-send { opacity: 0.5; }
.fx-quick-status { grid-column: 2 / -1; margin: -6px 16px 12px 4px; font-size: var(--text-small); line-height: var(--lh-small); }
.fx-quick-status:empty { display: none; }
.fx-quick-menu {
  position: absolute; left: 6px; top: calc(100% + 4px); z-index: 30;
  display: flex; flex-direction: column; gap: 1px; width: 260px; max-height: min(280px, calc(100vh - 96px)); overflow-y: auto;
  padding: 6px; border-radius: var(--radius-panel); background: var(--ui-menu); box-shadow: var(--shadow-lg);
}
.fx-quick-item {
  display: grid; grid-template-columns: 24px minmax(0, 1fr) auto 14px; align-items: center; gap: 10px;
  height: 36px; padding: 0 8px; border: 0; border-radius: var(--radius-control); background: none; color: var(--color-text);
  cursor: pointer; font: inherit; font-size: var(--text-ui); text-align: left;
}
.fx-quick-item:hover:not(:disabled), .fx-quick-item:focus-visible { background: var(--ui-hover); outline: none; }
.fx-quick-item:disabled { cursor: default; color: var(--color-muted); }
.fx-quick-item:disabled .fx-quick-item-face { opacity: 0.5; }
.fx-quick-item-face { display: inline-flex; }
.fx-quick-item-face .avatar { display: block; }
.fx-quick-item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-quick-item small { font-size: var(--text-small); color: var(--color-muted); }
.fx-quick-item .i-sm { width: 14px; height: 14px; visibility: hidden; color: var(--color-interactive); }
.fx-quick-item[aria-checked="true"] .i-sm { visibility: visible; }
.fx-quick-none { margin: 4px 8px; font-size: var(--text-small); color: var(--color-muted); }
@media (prefers-reduced-motion: reduce) {
  .fx-quick-face .avatar, .fx-quick-send { transition: none; }
}
`
