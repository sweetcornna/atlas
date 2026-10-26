// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 分栏与侧栏 (P37.18, `docs/dev/qmo-app.md` §11): what the server draws for
 * the panes and for the side list's peek, on every face — `/`, `/app` and
 * `/code` — and the sheet for both. The page script is
 * `assets/frontSplit.ts`.
 *
 * - **A pane is a document.** `?pane=1` on a face's address is that face
 *   drawn to sit in a frame of the window's: the same document with
 *   `data-pane="1"` on `#fx`, no settings card, the side list hidden, and
 *   two more things in its bar — ⌄, the conversation's menu, after the
 *   title, and × at the end. Only these documents may be framed, and only
 *   by this origin (`respond.ts`, `documentHeaders`).
 * - **A row opens beside.** `#fx-split-ctx` is the window's right-click
 *   menu for a side row, and its two items, 在右侧打开 and 在下方打开, are
 *   what the script copies into a row's ⋯ as it opens, on Work and Code
 *   alike: one copy in the document, not two buttons in every row.
 * - **The words** travel as `data-split-text` on `#fx`, in the reader's
 *   language; the keyboard help's rows are the front's (`view/front.ts`).
 *
 * Nothing here is a string the page turns into markup: the script clones
 * these nodes and sets text.
 */

import type { Lang } from '../i18n.js'
import { icon, chevron } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { FRONT_NARROW_PX } from './frontStyle.js'

interface SplitKeyWords {
  readonly right: string
  readonly below: string
  readonly next: string
  readonly prev: string
  readonly close: string
}

interface SplitText {
  readonly openRight: string
  readonly openBelow: string
  readonly paneMenu: string
  readonly closePane: string
  readonly soloPane: string
  readonly paneFailed: string
  readonly paneFull: string
  readonly resize: string
  readonly pane: string
  readonly close: string
  readonly keys: SplitKeyWords
}

export const SPLIT_TEXT: Readonly<Record<Lang, SplitText>> = {
  'zh-CN': {
    openRight: '在右侧打开',
    openBelow: '在下方打开',
    paneMenu: '会话菜单',
    closePane: '关闭分栏',
    soloPane: '只留这一栏',
    paneFailed: '这个会话打不开',
    paneFull: '放不下更多分栏',
    resize: '调整分栏大小',
    pane: '分栏',
    close: '关闭',
    keys: {
      right: '在右侧新开分栏',
      below: '在下方新开分栏',
      next: '下一个分栏',
      prev: '上一个分栏',
      close: '关闭分栏',
    },
  },
  en: {
    openRight: 'Open to the right',
    openBelow: 'Open below',
    paneMenu: 'Conversation menu',
    closePane: 'Close pane',
    soloPane: 'Close other panes',
    paneFailed: 'This conversation can’t be opened',
    paneFull: 'No room for another pane',
    resize: 'Resize panes',
    pane: 'Pane',
    close: 'Close',
    keys: {
      right: 'New pane to the right',
      below: 'New pane below',
      next: 'Next pane',
      prev: 'Previous pane',
      close: 'Close pane',
    },
  },
  ja: {
    openRight: '右側で開く',
    openBelow: '下に開く',
    paneMenu: '会話メニュー',
    closePane: 'ペインを閉じる',
    soloPane: '他のペインを閉じる',
    paneFailed: 'この会話は開けません',
    paneFull: 'これ以上ペインを置けません',
    resize: 'ペインのサイズを変更',
    pane: 'ペイン',
    close: '閉じる',
    keys: {
      right: '右側に新しいペイン',
      below: '下に新しいペイン',
      next: '次のペイン',
      prev: '前のペイン',
      close: 'ペインを閉じる',
    },
  },
}

/** The words the page script says (`assets/frontSplit.ts`), as JSON. */
export function splitText(lang: Lang): string {
  const t = SPLIT_TEXT[lang]
  return JSON.stringify({
    paneFailed: t.paneFailed,
    paneFull: t.paneFull,
    resize: t.resize,
    pane: t.pane,
    close: t.close,
  })
}

function splitItem(
  to: 'right' | 'below',
  query: string,
  label: string,
): string {
  return (
    `<button type="button" class="fx-menu-item fx-split-item" role="menuitem" data-action="fx-split" ` +
    `data-split-to="${to}" data-split-q="${attr(query)}">` +
    `${icon(to === 'right' ? 'columns-2' : 'rows-2', { small: true })}${escapeHtml(label)}</button>`
  )
}

/**
 * ⌄ in a pane's bar, after the title: the conversation's own menu (its
 * row's ⋯ items, cloned in by the script) and the two that are the pane's.
 */
export function paneMenu(lang: Lang): string {
  const t = SPLIT_TEXT[lang]
  return (
    `<details class="fx-more fx-pane-more" id="fx-pane-more">` +
    `<summary class="fx-icon-btn fx-more-btn fx-pane-more-btn" aria-label="${attr(t.paneMenu)}" title="${attr(t.paneMenu)}">` +
    `${chevron()}</summary>` +
    `<div class="fx-menu" role="menu">` +
    `<div class="fx-pane-items" id="fx-pane-items" role="none"></div>` +
    `<button type="button" class="fx-menu-item" role="menuitem" data-action="fx-pane-solo">` +
    `${icon('square', { small: true })}${escapeHtml(t.soloPane)}</button>` +
    `<button type="button" class="fx-menu-item" role="menuitem" data-action="fx-pane-close">` +
    `${icon('x', { small: true })}${escapeHtml(t.closePane)}</button>` +
    `</div></details>`
  )
}

/** × at the end of a pane's bar. */
export function paneClose(lang: Lang): string {
  const t = SPLIT_TEXT[lang]
  return (
    `<button type="button" class="fx-icon-btn fx-pane-close" data-action="fx-pane-close" ` +
    `aria-label="${attr(t.closePane)}" title="${attr(t.closePane)}">${icon('x', { small: true })}</button>`
  )
}

/**
 * The window's right-click menu for a row: the row's own ⋯ items, cloned
 * in, then where it opens. Hidden until the script places it.
 */
export function splitFrame(lang: Lang): string {
  const t = SPLIT_TEXT[lang]
  return (
    `<div class="fx-menu fx-split-ctx" id="fx-split-ctx" role="menu" hidden>` +
    `<div class="fx-split-ctx-items" id="fx-split-ctx-items" role="none"></div>` +
    splitItem('right', '', t.openRight) +
    splitItem('below', '', t.openBelow) +
    `</div>`
  )
}

const WIDE = `(min-width: ${FRONT_NARROW_PX + 1}px)`

/**
 * The sheet: the side list's peek, the window's panes and their dividers,
 * the drop hint and the right-click menu, and a pane document's own frame.
 * Measures are the console's tokens (`assets/css.ts`).
 */
export const FRONT_SPLIT_CSS = `
/* ---- the collapsed side list and its peek (qmo-app.md §11.4) ---- */
@media ${WIDE} {
  .fx[data-side="closed"]:not([data-pane]) > .fx-main { grid-column: 2; }
  .fx[data-side="closed"]:not([data-pane]) > .fx-panel { grid-column: 3; }
  .fx[data-side="closed"]:not([data-pane]) .fx-side {
    position: fixed; z-index: 36; top: var(--top-h); bottom: 8px; left: 8px; width: var(--side-w);
    padding-top: 8px; border-radius: var(--radius-panel); box-shadow: var(--shadow-lg);
    transform: translateX(-12px); visibility: hidden; opacity: 0; pointer-events: none;
    transition: opacity var(--motion-snap) var(--ease-out), transform var(--motion-snap) var(--ease-out),
      visibility 0s linear var(--motion-snap);
  }
  .fx[data-side="closed"][data-peek]:not([data-pane]) .fx-side {
    transform: none; visibility: visible; opacity: 1; pointer-events: auto;
    transition: opacity var(--motion-base) var(--ease-out), transform var(--motion-base) var(--ease-out);
  }
  .fx[data-side="closed"] .fx-side-top { display: none; }
  .fx[data-peek="drawer"] .fx-scrim {
    display: block; position: fixed; inset: 0; z-index: 35; border: 0; padding: 0;
    background: color-mix(in srgb, var(--color-scrim) 18%, transparent);
  }
}

/* ---- the window's panes (§11.3) ---- */
.fx-split { position: absolute; inset: 0; z-index: 1; background: var(--color-bg); }
.fx[data-split] > .fx-main > :not(.fx-split):not(.fx-top):not(.fx-offline):not(.fx-drop) { display: none !important; }
.fx[data-split] .fx-top {
  position: absolute; top: 0; left: 0; z-index: 4; padding: 0 0 0 calc(10px + var(--fx-shell-x));
  background: none; pointer-events: none;
}
.fx[data-split] .fx-top::after, .fx[data-split] .fx-top > :not(.fx-side-open) { display: none; }
.fx[data-split] .fx-side-open { pointer-events: auto; }
.fx[data-split] .fx-panel { display: none !important; }
.fx[data-split] .fx-offline { position: absolute; z-index: 5; top: 8px; left: 50%; transform: translateX(-50%); }
@media ${WIDE} {
  .fx[data-split], .fx[data-split][data-panel="open"] { grid-template-columns: var(--side-w) minmax(0, 1fr); }
  .fx[data-split][data-side="closed"], .fx[data-split][data-panel="open"][data-side="closed"] { grid-template-columns: 0 minmax(0, 1fr); }
}
.fx-pane { position: absolute; box-sizing: border-box; overflow: hidden; background: var(--color-bg); }
.fx-pane.is-right { border-left: 1px solid var(--color-divider); }
.fx-pane.is-lower { border-top: 1px solid var(--color-divider); }
.fx-pane-frame { display: block; width: 100%; height: 100%; border: 0; background: var(--color-bg); }
.fx[data-dragging] .fx-pane-frame, .fx[data-resizing] .fx-pane-frame { pointer-events: none; }
.fx-split[data-many] .fx-pane[data-focus]::after {
  content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 1;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fx-accent) 45%, transparent);
}
.fx-split-bar { position: absolute; z-index: 2; touch-action: none; outline: none; }
.fx-split-bar[aria-orientation="vertical"] { top: 0; bottom: 0; width: 9px; margin-left: -4px; cursor: col-resize; }
.fx-split-bar[aria-orientation="horizontal"] { height: 9px; margin-top: -4px; cursor: row-resize; }
.fx-split-bar::after {
  content: ""; position: absolute; background: var(--fx-accent); opacity: 0;
  transition: opacity var(--motion-snap) var(--ease-out);
}
.fx-split-bar[aria-orientation="vertical"]::after { left: 4px; width: 1px; top: 0; bottom: 0; }
.fx-split-bar[aria-orientation="horizontal"]::after { top: 4px; height: 1px; left: 0; right: 0; }
.fx-split-bar:hover::after, .fx-split-bar:focus-visible::after, .fx-split-bar.is-active::after { opacity: 0.7; }
.fx-pane-fail {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--space-3); padding: var(--space-6); text-align: center; background: var(--color-bg);
  color: var(--color-muted); font-size: var(--text-ui);
}
.fx-pane-fail p { margin: 0; }
.fx-drop {
  position: absolute; z-index: 6; pointer-events: none; box-sizing: border-box; border-radius: var(--radius-panel);
  background: color-mix(in srgb, var(--fx-accent) 10%, transparent);
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--fx-accent) 55%, transparent);
  transition: left var(--motion-snap) var(--ease-out), top var(--motion-snap) var(--ease-out),
    width var(--motion-snap) var(--ease-out), height var(--motion-snap) var(--ease-out);
}
.fx-body .fx-menu.fx-split-ctx { position: fixed; right: auto; top: 0; left: 0; z-index: 45; }
.fx-body .fx-menu.fx-split-ctx[hidden] { display: none; }
.fx-split-ctx-items:empty, .fx-pane-items:empty { display: none; }
.fx-split-ctx-items, .fx-pane-items { display: flex; flex-direction: column; }
.fx[data-split] .fx-agent-row.is-current, .fx[data-split] .fx-ritem-row.is-current { background: none; }
.fx[data-split] .fx-side [data-split-current] { background: var(--fx-selected); }
.fx[data-split] .fx-side [data-split-current] .fx-more-btn { background: transparent; }
@media (max-width: ${FRONT_NARROW_PX}px) {
  .fx-split-item { display: none; }
}

/* ---- a pane's own document ---- */
.fx[data-pane], .fx[data-pane][data-side="closed"] { grid-template-columns: minmax(0, 1fr) !important; }
.fx[data-pane][data-panel="open"] { grid-template-columns: minmax(0, 1fr) var(--fx-panel-w) !important; }
.fx[data-pane] .fx-side, .fx[data-pane] .fx-side-open, .fx[data-pane] .fx-scrim { display: none !important; }
.fx[data-pane] .fx-top { padding-left: calc(10px + var(--fx-pane-inset, 0px)) !important; }
.fx[data-pane] .fx-head-mount, .fx[data-pane] .fx-head { flex: 0 1 auto; }
.fx[data-pane] .fx-top-tail { margin-left: auto; }
.fx[data-pane][data-pane-dim] .fx-head-name, .fx[data-pane][data-pane-dim] .fx-chip-name,
.fx[data-pane][data-pane-dim] .fx-head-title { color: var(--color-muted); }
/* The title is the agent's chip on Work: its facts open from the chip, and
   the one ⌄ after it is the pane's menu. */
.fx[data-pane] .fx-chip > .chev { display: none; }
.fx[data-pane] .fx-chip-name { display: inline; }
.fx-pane-more .fx-menu { left: 0; right: auto; }
.fx-pane-doc .skip-link, .fx-pane-doc #session-expired { display: none !important; }

@media (prefers-reduced-motion: reduce) {
  .fx[data-side="closed"]:not([data-pane]) .fx-side,
  .fx[data-side="closed"][data-peek]:not([data-pane]) .fx-side {
    transform: none; transition: opacity var(--motion-snap) linear, visibility 0s linear var(--motion-snap);
  }
  .fx[data-side="closed"][data-peek]:not([data-pane]) .fx-side { transition: opacity var(--motion-snap) linear; }
  .fx-drop, .fx-split-bar::after { transition: none; }
}
`
