// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The conversation front's own sheet, on top of the console's sheet
 * (`assets/css.ts`), for both of its faces: 智能体 at `/` and 对话 at `/app`
 * (`view/front.ts`, `docs/dev/qmo-app.md` §4).
 *
 * The palette is the console's own (`assets/css.ts`): near white and ink,
 * the logo's sage for working and delivered, amber for a warning, and the
 * reader's 主题色 for what is theirs or alive (`accent.ts`). The front's few
 * colours of its own — the bubbles and the unread dot's seal red — are
 * tokens of that sheet too (`--color-seal`, `--color-agent-bubble`,
 * `--color-user-block`, light and dark); this sheet only names them.
 *
 * ## One set of measures for the fronts and /admin
 *
 * The faces and the management pages must read as one product, so every
 * measure is a token of the console's sheet (`assets/css.ts` `:root`,
 * `docs/dev/qmo-local.md` §3.4), which every document inlines ahead of this
 * one: `--side-w` 288 (a drawer at 700 px and below), `--top-h` 48,
 * `--control-h` 32 with `--radius-control` 8, `--radius-panel` 12 for a
 * panel or a menu, `--radius-composer` 14 and 20 on the welcome page,
 * `--column-w` 768, type in `--text-ui` 14/20, `--text-prose` 16/24,
 * `--text-small` 12/17 and `--text-title` 22/28, motion in `--motion-*`
 * 60 / 120 / 200 / 300 ms on `--ease-out`. This sheet defines none of them.
 * The look — colours, fonts, figures — stays ours.
 *
 * ## The desktop app
 *
 * `<html data-shell>` (`preferences.ts`) is set only inside the desktop app.
 * On macOS the window's traffic lights sit at the top left of the header
 * row, so the side list's head, and the bar while the side list is closed,
 * keep `--shell-lights-x` (80 px) clear there. A browser has no such
 * attribute and nothing moves.
 *
 * The layout: a full-height app frame instead of a scrolling document, a side
 * list that collapses on a wide screen and becomes a drawer on a narrow one,
 * one centred column for the transcript and the composer, and the welcome
 * state that lifts the composer to the middle under the greeting.
 */

/**
 * At this width and below the side list is a drawer (`qmo-app.md` §4.4; 700
 * as the reference collapses its sidebar). The sheets and the scripts read
 * this one number.
 */
export const FRONT_NARROW_PX = 700

export const FRONT_CSS = `
body.fx-body {
  --fx-accent: var(--color-accent-fill);
  --fx-accent-ink: var(--color-on-accent-fill);
  --fx-live: var(--fx-accent);
  --fx-user-bubble: var(--fx-accent);
  --fx-user-ink: var(--fx-accent-ink);
  --fx-seal: var(--color-seal);
  --fx-hover: var(--ui-hover);
  --fx-selected: var(--ui-selected);
  --fx-field: var(--ui-field);
  --fx-line: var(--ui-line);
  --fx-agent-bubble: var(--color-agent-bubble);
  --fx-user-block: var(--color-user-block);
  --fx-composer: var(--ui-menu);

  /* The measures (side list, header row, controls, corners, reading column,
     type, motion) are the console sheet's tokens (assets/css.ts :root), the
     same ones /admin draws with; nothing here redefines them. */
  /* Clear room for the desktop app's window controls (macOS, below). */
  --fx-shell-x: 0px;
}
:root[data-shell="macos"] body.fx-body { --fx-shell-x: var(--shell-lights-x); }

html:has(body.fx-body), body.fx-body { height: 100%; }
.fx [hidden], .fx-body dialog:not([open]) { display: none !important; }
body.fx-body {
  margin: 0; overflow: hidden; background: var(--color-bg); color: var(--color-text);
  -webkit-font-smoothing: antialiased;
}
.fx-body svg.i, .fx-body svg.i-sm { stroke-width: 1.9; }
.fx {
  display: grid; grid-template-columns: var(--side-w) minmax(0, 1fr);
  height: 100vh; height: 100dvh; transition: grid-template-columns var(--motion-base) var(--ease-out);
}
.fx[data-side="closed"] { grid-template-columns: 0 minmax(0, 1fr); }
.fx[data-side="closed"] .fx-side { visibility: hidden; opacity: 0; }

/* ---- shared controls: the icon button, the menu and the account row are
   in the console's sheet, drawn the same on both sides ---- */
.fx-agent:focus-visible, .fx-hitem:focus-visible, .fx-ritem:focus-visible, .fx-row:focus-visible,
.fx-mode-item:focus-visible, .fx-stack-row:focus-visible, .fx-send:focus-visible,
.fx-steps-head:focus-visible, .fx-stack-head:focus-visible, .fx-chip:focus-visible {
  outline: 2px solid var(--color-focus); outline-offset: 1px;
}
.fx-body .fx-menu { border-radius: var(--radius-panel); }
.fx-pulse {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: var(--fx-live); animation: fx-pulse 1.6s ease-in-out infinite;
}
@keyframes fx-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.fx-none { margin: 4px 0; padding: 6px 10px; font-size: var(--text-small); color: var(--color-muted); }

/* ---- the side list's frame, the same on both faces ---- */
.fx-side {
  display: flex; flex-direction: column; gap: 8px; min-height: 0; min-width: 0;
  padding: 0 8px 8px; background: var(--color-side); overflow: hidden;
  box-shadow: inset -0.5px 0 0 var(--color-divider);
  transition: opacity var(--motion-snap) var(--ease-out);
}
/* The header row: the window's drag strip in the desktop app. */
.fx-side-top {
  display: flex; align-items: center; gap: 2px; flex: none;
  height: var(--top-h); padding: 0 0 0 calc(6px + var(--fx-shell-x)); box-sizing: border-box;
}
.fx-brand { display: inline-flex; align-items: center; gap: 9px; margin-right: auto; color: inherit; text-decoration: none; min-width: 0; }
.fx-brand-name { font-size: var(--text-ui); font-weight: 600; letter-spacing: 0.06em; }
/* The logo (its colours are the console's, assets/css.ts): the ridges between
   its plots widened in the panel's own ground so they stay open at this size. */
.fx-brand .qm-mark path { stroke: var(--color-side); stroke-width: 18px; stroke-linejoin: round; }

/* Work | Code (P37.13, qmo-local.md §3.6): one switch the width of the
   side list, under the brand, the same on every face. */
.fx-switch {
  display: grid; grid-template-columns: 1fr 1fr; gap: 2px; flex: none;
  height: var(--control-h); padding: 2px; box-sizing: border-box;
  border-radius: var(--radius-control); background: var(--fx-hover);
}
.fx-switch-item {
  display: inline-flex; align-items: center; justify-content: center; min-width: 0;
  border-radius: var(--radius-sm); color: var(--color-muted); text-decoration: none;
  font-size: var(--text-ui); font-weight: var(--weight-medium);
  transition: background-color var(--motion-snap) var(--ease-out), color var(--motion-snap) var(--ease-out);
}
.fx-switch-item:hover { color: var(--color-text); }
.fx-switch-item[aria-current="page"] { background: var(--ui-raised); color: var(--color-text); box-shadow: var(--shadow-sm); }
.fx-switch-item:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; }

/* Over the list: what it lists; on Work, 对话 and 智能体 as two small icons. */
.fx-list-head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex: none;
  min-height: var(--control-h-sm); padding: 0 var(--space-1) 0 10px;
}
.fx-list-title { font-size: var(--text-small); line-height: var(--lh-small); font-weight: var(--weight-medium); color: var(--color-muted); }
.fx-mode { display: inline-flex; gap: 2px; flex: none; }
.fx-mode-item {
  display: inline-grid; place-items: center; width: var(--control-h-xs); height: var(--control-h-xs);
  border-radius: var(--radius-xs); color: var(--color-muted); text-decoration: none;
  transition: background-color var(--motion-snap) var(--ease-out), color var(--motion-snap) var(--ease-out);
}
.fx-mode-item .i-sm { width: 14px; height: 14px; }
.fx-mode-item:hover { background: var(--fx-hover); color: var(--color-text); }
.fx-mode-item[aria-current="page"] { background: var(--fx-selected); color: var(--color-text); }

/* 新对话 and 搜索: rows, the height of every control. */
.fx-side-rows { display: flex; flex-direction: column; gap: 1px; flex: none; }
.fx-row {
  display: flex; align-items: center; gap: 10px; height: var(--control-h); padding: 0 10px; box-sizing: border-box;
  border: 0; border-radius: var(--radius-control); background: none; color: var(--color-text);
  font: inherit; font-size: var(--text-ui); text-align: left; cursor: pointer;
  transition: background-color var(--motion-snap) var(--ease-out);
}
.fx-row:hover { background: var(--fx-hover); }
.fx-row:disabled { color: var(--color-quiet); cursor: default; background: none; }
.fx-row > .i-sm { flex: none; width: var(--icon-sm); height: var(--icon-sm); color: var(--color-quiet); }
.fx-row-word { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-row-keys { display: inline-flex; gap: 2px; flex: none; opacity: 0; transition: opacity var(--motion-snap) var(--ease-out); }
.fx-row:hover .fx-row-keys, .fx-search:focus-within .fx-row-keys { opacity: 1; }
.fx-row-keys kbd, .fx-key kbd {
  display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 4px; box-sizing: border-box;
  border-radius: var(--radius-xs); background: var(--fx-field); box-shadow: inset 0 0 0 0.5px var(--fx-line);
  font-family: inherit; font-size: var(--text-small); line-height: 1; color: var(--color-muted);
}
.fx-search { cursor: text; }
.fx-search:focus-within { background: var(--color-field); box-shadow: inset 0 0 0 1px var(--color-focus); }
.fx-search input {
  flex: 1; min-width: 0; height: 100%; border: 0; padding: 0; background: none; color: var(--color-text);
  font: inherit; font-size: var(--text-ui); outline: none;
}
.fx-search input::placeholder { color: var(--color-quiet); }
.fx-search input::-webkit-search-cancel-button { display: none; }
.fx-side-scroll {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  margin: 0 -4px; padding: 0 4px 8px; scrollbar-width: thin;
}
.fx-agents { display: flex; flex-direction: column; gap: 1px; }
.fx-side-link {
  display: inline-flex; align-items: center; gap: 8px; margin-top: 6px; min-height: var(--control-h); padding: 0 10px;
  border-radius: var(--radius-control); font-size: var(--text-small); color: var(--color-quiet); text-decoration: none;
}
.fx-side-link:hover { background: var(--fx-hover); color: var(--color-text); }

/* An agent (智能体): one row, its menu over the row's right end. */
.fx-agent-row { position: relative; border-radius: var(--radius-control); transition: background-color var(--motion-snap) var(--ease-out); }
.fx-agent-row:hover { background: var(--fx-hover); }
.fx-agent-row.is-current { background: var(--fx-selected); }
.fx-agent-row.is-off .fx-agent-face, .fx-agent-row.is-off .fx-agent-name { opacity: 0.5; }
.fx-agent {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 52px;
  padding: 8px 10px 8px 8px; border: 0; border-radius: var(--radius-control); background: none; color: inherit;
  cursor: pointer; font: inherit; text-align: left;
}
.fx-agent-face { position: relative; display: inline-flex; flex: none; }
.fx-agent-face .avatar { display: block; }
/* The roster's verdict on the agent, a dot on its figure (P37.17): the
   success colour when it is online, the quiet neutral otherwise. */
.fx-presence {
  position: absolute; right: -1px; bottom: -1px; width: 8px; height: 8px; border-radius: 50%;
  background: var(--color-neutral-500); box-shadow: 0 0 0 2px var(--color-side);
}
.fx-presence[data-tone="ok"] { background: var(--color-success-fill); }
.fx-presence[data-tone="warn"] { background: var(--color-warning-fill); }
.fx-agent-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.fx-agent-line { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.fx-agent-name { font-size: var(--text-ui); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-agent-node { font-size: var(--text-small); color: var(--color-muted); white-space: nowrap; }
.fx-agent-tag {
  flex: none; padding: 0 5px; border-radius: var(--radius-xs); font-size: var(--text-small); line-height: var(--lh-small); font-style: normal;
  background: var(--fx-field); color: var(--color-muted);
}
.fx-agent-when { margin-left: auto; padding-left: 6px; flex: none; font-size: var(--text-small); color: var(--color-muted); white-space: nowrap; }
.fx-agent-sub {
  padding-right: 14px; font-size: var(--text-small); color: var(--color-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fx-agent-row.is-busy .fx-agent-sub { color: var(--color-quiet); }
.fx-agent-sub .fx-live-dots { margin-right: 6px; vertical-align: 1px; }
.fx-unread {
  position: absolute; right: 12px; bottom: 16px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--color-interactive); opacity: 0; transform: scale(0.4);
  transition: opacity var(--motion-base) var(--ease-out), transform var(--motion-base) var(--ease-out);
}
.fx-agent-row.is-unread .fx-unread { opacity: 1; transform: none; }
.fx-agent-row.is-unread .fx-agent-name { font-weight: 600; }
.fx-agent-row.is-unread .fx-agent-sub { color: var(--color-quiet); }
.fx-agent-row > .fx-more { position: absolute; right: 6px; top: 6px; }
.fx-agent-row .fx-more-btn, .fx-ritem-row .fx-more-btn { width: 26px; height: 26px; opacity: 0; background: var(--color-side); }
.fx-agent-row.is-current .fx-more-btn, .fx-ritem-row.is-current .fx-more-btn { background: transparent; }
.fx-agent-row:hover .fx-more-btn, .fx-agent-row:focus-within .fx-more-btn, .fx-agent-row .fx-more[open] .fx-more-btn,
.fx-ritem-row:hover .fx-more-btn, .fx-ritem-row:focus-within .fx-more-btn, .fx-ritem-row .fx-more[open] .fx-more-btn { opacity: 1; }
.fx-agent-row:hover .fx-agent-when, .fx-agent-row:focus-within .fx-agent-when { visibility: hidden; }
@media (hover: none) {
  .fx-agent-row .fx-more-btn, .fx-ritem-row .fx-more-btn { opacity: 1; }
  .fx-agent-row .fx-agent-when { visibility: hidden; }
}

/* A conversation (对话): one row of the list, by day. */
.fx-recents { display: flex; flex-direction: column; }
.fx-rgroup { display: flex; flex-direction: column; gap: 1px; }
.fx-rgroup + .fx-rgroup:not([hidden]), .fx-rgroup:not([hidden]) ~ .fx-rgroup:not([hidden]) { margin-top: 12px; }
.fx-rgroup-name {
  margin: 8px 0 4px; padding: 0 10px; font-size: var(--text-small); line-height: var(--lh-small);
  font-weight: 500; color: var(--color-muted);
}
.fx-ritem-row { position: relative; border-radius: var(--radius-control); transition: background-color var(--motion-snap) var(--ease-out); }
.fx-ritem-row:hover { background: var(--fx-hover); }
.fx-ritem-row.is-current { background: var(--fx-selected); }
.fx-ritem {
  display: flex; align-items: center; gap: 8px; width: 100%; height: var(--control-h);
  padding: 0 32px 0 10px; box-sizing: border-box; border: 0; border-radius: var(--radius-control);
  background: none; color: var(--color-text); cursor: pointer; font: inherit; font-size: var(--text-ui); text-align: left;
}
.fx-ritem-face { display: inline-flex; flex: none; margin-left: -1px; }
.fx-ritem-face .avatar { display: block; }
.fx-ritem-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-ritem-live { display: inline-flex; flex: none; }
.fx-ritem-row .fx-unread { right: 13px; top: 13px; bottom: auto; }
.fx-ritem-row.is-unread .fx-unread { opacity: 1; transform: none; }
.fx-ritem-row.is-unread .fx-ritem-title { font-weight: 600; }
.fx-ritem-row.is-busy .fx-ritem { padding-right: 32px; }
.fx-ritem-row:hover .fx-ritem-live, .fx-ritem-row:focus-within .fx-ritem-live,
.fx-ritem-row:hover .fx-unread, .fx-ritem-row:focus-within .fx-unread { visibility: hidden; }
.fx-ritem-row > .fx-more { position: absolute; right: 3px; top: 3px; }
.fx-ritem-row.is-busy .fx-ritem-live { position: absolute; right: 13px; top: 13px; }

/* ---- the bar ---- */
.fx-main { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--color-bg); }
.fx-top {
  position: relative; z-index: 3; display: flex; align-items: center; gap: 6px;
  height: var(--top-h); padding: 0 10px; flex: none; box-sizing: border-box;
}
/* The transcript slides under the bar through a short fade, not a hard cut. */
.fx-top::after {
  content: ""; position: absolute; left: 0; right: 0; top: 100%; height: 14px; pointer-events: none;
  background: linear-gradient(var(--color-bg), color-mix(in srgb, var(--color-bg) 0%, transparent));
}
.fx-side-open { display: none; }
.fx[data-side="closed"] .fx-side-open { display: inline-grid; }
.fx[data-side="closed"] .fx-top { padding-left: calc(10px + var(--fx-shell-x)); }
.fx-head-mount { flex: 1; min-width: 0; align-self: stretch; display: flex; align-items: center; }
.fx-head { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
.fx-head-face { display: inline-flex; align-items: center; justify-content: center; padding: 2px; margin: -2px; border: 0; background: none; border-radius: var(--radius-control); flex: none; }
.fx-head-face .avatar { display: block; }
button.fx-head-face, button.fx-welcome-face { cursor: pointer; }
button.fx-head-face:hover, button.fx-welcome-face:hover { background: var(--fx-hover); }
.fx-head-name { font-size: var(--text-ui); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.fx-head-sub { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: var(--text-small); color: var(--color-muted); white-space: nowrap; overflow: hidden; }
.fx-head-sub .mono { font-size: var(--text-small); }
.fx-head-sub .state { font-size: var(--text-small); }
.fx-head-sub .dot { width: 7px; height: 7px; }
.fx-model:empty { display: none; }
.fx-info .fx-info-card { width: min(320px, 86vw); padding: 12px; gap: 10px; left: 0; right: auto; }
.fx-facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; margin: 0; font-size: var(--text-small); }
.fx-facts dt { color: var(--color-muted); }
.fx-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.fx-info-links { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: var(--text-small); padding-top: 8px; border-top: 0.5px solid var(--color-divider); }
.fx-info-links a { color: var(--color-text); text-decoration: none; }
.fx-info-links a:hover { text-decoration: underline; }
.fx-top-tail { display: flex; align-items: center; gap: 2px; flex: none; }
.fx-live { margin-right: 6px; font-size: var(--text-small); color: var(--color-muted); }
.fx-live:empty { display: none; }
/* 云端电脑 in use: the panel's way in, lit in the reader's 主题色. */
.fx-computer { color: var(--fx-live); position: relative; }
.fx-computer::after {
  content: ""; position: absolute; right: 5px; top: 5px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--fx-live); box-shadow: 0 0 0 2px var(--color-bg); animation: fx-pulse 1.6s ease-in-out infinite;
}

/* /app's head: the conversation's title and the agent as a chip. */
.fx-head-title {
  margin: 0; min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--text-ui); line-height: var(--lh-ui); font-weight: 500;
}
.fx-head-chat .fx-info { min-width: 0; flex: 0 1 auto; }
.fx-chip {
  display: inline-flex; align-items: center; gap: 6px; height: var(--control-h-sm); max-width: 100%; padding: 0 6px 0 4px; box-sizing: border-box;
  border-radius: var(--radius-control); color: var(--color-quiet); cursor: pointer; list-style: none;
  font-size: var(--text-ui); transition: background-color var(--motion-snap) var(--ease-out);
}
.fx-chip::-webkit-details-marker { display: none; }
.fx-chip:hover, .fx-info[open] > .fx-chip { background: var(--fx-hover); color: var(--color-text); }
.fx-chip .fx-head-face { padding: 0; margin: 0; }
.fx-chip-name { font-weight: 500; color: var(--color-text); white-space: nowrap; }
.fx-chip-sub { display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; white-space: nowrap; color: var(--color-muted); font-size: var(--text-small); }
.fx-chip-sub .mono { font-size: var(--text-small); }
.fx-chip-model:empty { display: none; }
.fx-chip-model::before { content: "·"; margin-right: 6px; }
.fx-chip-model .tag { all: unset; font-family: var(--font-mono); font-size: var(--text-small); }
.fx-chip .chev { width: 12px; height: 12px; flex: none; color: var(--color-muted); }
.fx-chip .state { font-size: var(--text-small); }

/* 其他对话 (P37.17): an agent's other conversations, in a dialog its ⋯ opens. */
dialog.dialog.fx-others { width: min(400px, calc(100% - var(--space-8))); padding: var(--space-1) var(--space-1) var(--space-4); gap: var(--space-2); overflow: hidden; }
.fx-others > .btn { align-self: flex-end; margin-right: var(--space-3); }
/* The dialog sits outside .fx, whose [hidden] rule the list's flex rows would beat. */
.fx-others [hidden] { display: none !important; }
.fx-history { display: flex; flex-direction: column; min-height: 0; max-height: min(62vh, 520px); }
.fx-menu-count { margin-left: auto; padding-left: var(--space-3); color: var(--color-muted); font-size: var(--text-small); }
.fx-sec-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 10px 6px 12px; }
.fx-sec-title { margin: 0; font-size: var(--text-ui); font-weight: 600; }
.fx-hist-list { overflow-y: auto; padding: 0 5px 6px; scrollbar-width: thin; }
.fx-seg { display: inline-flex; padding: 2px; border-radius: var(--radius-control); background: var(--fx-field); }
.fx-seg button {
  border: 0; background: none; color: var(--color-muted); cursor: pointer;
  padding: 2px 8px; border-radius: var(--radius-sm); font: inherit; font-size: var(--text-small);
}
.fx-seg button[aria-pressed="true"] { background: var(--fx-composer); color: var(--color-text); box-shadow: var(--shadow-sm); }
.fx-hgroup { display: flex; flex-direction: column; gap: 1px; }
.fx-hgroup-name { margin: 8px 0 2px; padding: 0 8px; font-size: var(--text-small); color: var(--color-muted); }
.fx-hitem {
  display: flex; flex-direction: column; gap: 1px; width: 100%; padding: 6px 8px;
  border: 0; border-radius: var(--radius-control); background: none; color: inherit; cursor: pointer;
  font: inherit; text-align: left;
}
.fx-hitem:hover { background: var(--fx-hover); }
.fx-hitem.is-active { background: var(--fx-selected); }
.fx-hitem-title { font-size: var(--text-ui); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-hitem-meta { display: flex; align-items: center; gap: 6px; font-size: var(--text-small); color: var(--color-muted); }
.fx-history:not([data-scope="all"]) .fx-hitem-who { display: none; }
.fx-hitem-who::after { content: "·"; margin-left: 6px; }

/* A conversation read here and not written in (P37.17): the line takes the
   composer's place, held at the foot of the transcript however far it is read. */
.fx-main:has(#fx-thread[data-readonly="1"]) .fx-composer { display: none; }
.fx-readonly {
  position: sticky; bottom: 0; z-index: 1;
  display: flex; align-items: center; justify-content: center; gap: var(--space-3);
  margin-top: var(--space-4); padding: var(--space-3) 0 var(--space-4); background: var(--color-bg);
  font-size: var(--text-small); color: var(--color-muted);
}
.fx-readonly .btn { display: inline-flex; align-items: center; gap: var(--space-2); }
.fx-readonly .avatar { display: block; flex: none; }

/* The thin lines under the bar: offline, and a view on its way. */
.fx-offline {
  flex: none; margin: 0; padding: 5px 16px; text-align: center;
  font-size: var(--text-small); line-height: var(--lh-small); color: var(--color-warning-text);
  background: var(--color-warning-bg); box-shadow: inset 0 -0.5px 0 var(--color-warning-border);
}
.fx-progress {
  position: absolute; left: 0; right: 0; top: var(--top-h); height: 2px; z-index: 2; pointer-events: none;
  opacity: 0; overflow: hidden;
}
.fx-progress::before {
  content: ""; position: absolute; inset: 0 auto 0 0; width: 36%; border-radius: var(--radius-2xs);
  background: var(--fx-live); transform: translateX(-100%);
}
.fx-main[aria-busy="true"] .fx-progress { opacity: 1; transition: opacity var(--motion-snap) linear var(--motion-base); }
.fx-main[aria-busy="true"] .fx-progress::before { animation: fx-progress 1.1s var(--ease-out) infinite; }
@keyframes fx-progress { from { transform: translateX(-100%); } to { transform: translateX(290%); } }
.fx-main[aria-busy="true"] .fx-thread { opacity: 0.55; transition: opacity var(--motion-base) var(--ease-out) var(--motion-base); }

/* ---- the conversation ---- */
.fx-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
.fx-column { width: 100%; max-width: calc(var(--column-w) + 2 * var(--space-6)); margin: 0 auto; padding: 0 var(--space-6); box-sizing: border-box; }
.fx-dock { flex: none; position: relative; padding: 4px 0 14px; }
.fx-main.is-welcome .fx-scroll { flex: 1 1 0; display: flex; flex-direction: column; justify-content: flex-end; }
.fx-main.is-welcome .fx-dock { flex: 1 1 0; }

.fx-msgs { display: flex; flex-direction: column; gap: 6px; padding: 12px 0 24px; }
.fx-msg { min-width: 0; }
.fx-sep { display: flex; justify-content: center; margin: 14px 0 6px; }
.fx-sep-time { font-size: var(--text-small); color: var(--color-muted); font-variant-numeric: tabular-nums; }
.fx-bubble {
  width: fit-content; max-width: 100%; box-sizing: border-box; padding: 8px 14px; border-radius: var(--radius-bubble);
  font-size: var(--text-prose); line-height: var(--lh-prose); overflow-wrap: anywhere;
}
.fx-bubble .turn-p { margin: 0; }
.fx-bubble .turn-p + .turn-p, .fx-bubble .turn-list, .fx-bubble .turn-code { margin-top: 8px; }
/* A line after a list or a code block opens the next part (often its bold
   heading): a little more room than between two paragraphs. */
.fx-bubble .turn-list + .turn-p, .fx-bubble .turn-code + .turn-p { margin-top: 12px; }
.fx-msg-user {
  position: relative; align-self: flex-end; display: flex; flex-direction: column; align-items: flex-end;
  max-width: min(78%, 560px); margin-top: 6px;
}
.fx-msg-user .fx-bubble { background: var(--fx-user-bubble); color: var(--fx-user-ink); }
.fx-msg-user .fx-bubble code.mono { background: color-mix(in srgb, var(--fx-user-ink) 14%, transparent); }
/* Not delivered: the words stay readable, the fill does not, so it reads as
   a draft that is still the reader's rather than a message that went out. */
.fx-msg-user.is-failed .fx-bubble {
  background: transparent; color: var(--color-text); border: 1px dashed var(--fx-line);
}
.fx-msg-user.is-failed .fx-bubble code.mono { background: var(--fx-hover); }
.fx-msg-user.is-sending .fx-bubble { opacity: 0.7; }
.fx-msg-agent { align-self: flex-start; max-width: min(88%, 680px); margin-top: 6px; }
.fx-msg-body { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; }
.fx-bubble-agent { background: var(--fx-agent-bubble); color: var(--color-text); }
.fx-msg-agent.is-failed .fx-text { color: var(--color-quiet); }
.fx-msg-head { display: flex; align-items: baseline; gap: 8px; padding: 0 2px 2px; }
.fx-cmd-name { font-size: var(--text-small); color: var(--color-muted); }
.fx-msg-cmd { max-width: 100%; }
.fx-text { overflow-wrap: anywhere; }
.fx-text code.mono, .fx-bubble code.mono {
  padding: 1px 5px; border-radius: var(--radius-xs); font-size: 0.88em;
  background: color-mix(in srgb, var(--color-text) 7%, transparent);
}
.fx-pre {
  margin: 0; padding: 10px 14px; border-radius: var(--radius-panel); overflow-x: auto; max-width: 100%; box-sizing: border-box;
  background: var(--fx-agent-bubble);
  font-family: var(--font-mono); font-size: var(--text-code); line-height: var(--lh-code);
}
.fx-pre > code { white-space: pre; }
.fx-pre-quiet { margin-top: 6px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--text-small); max-height: 240px; overflow-y: auto; }

/* What sits under a line: shown on hover, except where it matters. */
.fx-meta {
  display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; min-height: 22px; padding: 0 4px;
  font-size: var(--text-small); color: var(--color-muted);
}
.fx-msg-user .fx-meta { justify-content: flex-end; }
.fx-msg-user:not(.is-last):not(.is-failed):not(.is-sending):not(.is-queued) .fx-meta {
  position: absolute; right: calc(100% + 6px); bottom: 2px; min-height: 0; white-space: nowrap; flex-wrap: nowrap;
  opacity: 0; pointer-events: none; transition: opacity var(--motion-snap) var(--ease-out);
}
.fx-msg-user:not(.is-last):not(.is-failed):hover .fx-meta { opacity: 1; pointer-events: auto; }
.fx-when { font-family: var(--font-mono); font-size: var(--text-small); color: var(--color-muted); }
.fx-id { font-size: var(--text-small); color: var(--color-muted); text-decoration: none; }
a.fx-id:hover { color: var(--color-text); text-decoration: underline; }
.fx-fail { color: var(--color-critical); font-weight: 500; }
.fx-queued { color: var(--color-quiet); }
.fx-chain { display: inline-flex; gap: 3px; align-items: center; }
.fx-chain i { width: 5px; height: 5px; border-radius: 50%; background: color-mix(in srgb, var(--color-text) 16%, transparent); }
.fx-chain i.on { background: var(--color-accent-2-500); }
.fx-meta-more { display: inline-flex; align-items: center; gap: 10px; opacity: 0; transition: opacity var(--motion-snap) var(--ease-out); }
.fx-msg:hover .fx-meta-more, .fx-msg:focus-within .fx-meta-more { opacity: 1; transition-delay: 100ms; }
.fx-mini {
  display: inline-grid; place-items: center; width: 24px; height: 22px; padding: 0; margin-left: -4px;
  border: 0; border-radius: var(--radius-sm); background: none; color: var(--color-muted); cursor: pointer;
  opacity: 0; transition: opacity var(--motion-snap) var(--ease-out), background-color var(--motion-snap) var(--ease-out);
}
.fx-msg-agent:hover .fx-mini, .fx-mini:focus-visible { opacity: 1; transition-delay: 100ms; }
.fx-mini:hover { background: var(--fx-selected); color: var(--color-text); }
@media (hover: none) { .fx-meta-more { display: none; } .fx-mini { opacity: 1; } }

/* A step group: one checklist line that unfolds. */
.fx-steps { align-self: flex-start; max-width: min(88%, 680px); margin-top: 6px; }
.fx-steps-head {
  display: inline-flex; align-items: center; gap: 8px; max-width: 100%; box-sizing: border-box; padding: 6px 12px;
  border-radius: var(--radius-panel); cursor: pointer; list-style: none; font-size: var(--text-small); color: var(--color-quiet);
  background: var(--fx-agent-bubble);
}
.fx-steps-head::-webkit-details-marker { display: none; }
.fx-steps-head:hover { color: var(--color-text); }
.fx-steps-label { flex: none; font-weight: 500; }
.fx-steps-last { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted); }
.fx-steps[open] .fx-steps-last { display: none; }
.fx-steps-head .chev { transition: transform var(--motion-base) var(--ease-out); flex: none; color: var(--color-muted); }
.fx-steps[open] .fx-steps-head .chev { transform: rotate(180deg); }
.fx-steps-warn .fx-steps-head > .i-sm { color: var(--color-accent-600); }
.fx-steps-bad .fx-steps-head > .i-sm { color: var(--color-critical); }
.fx-step-list {
  list-style: none; margin: 4px 0 0; padding: 8px 12px; border-radius: var(--radius-panel); background: var(--fx-agent-bubble);
  display: flex; flex-direction: column; gap: 6px;
}
.fx-step { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 8px; align-items: start; font-size: var(--text-small); }
.fx-step-mark { display: inline-flex; padding-top: 2px; color: var(--color-accent-2-600); }
.fx-step-warn .fx-step-mark { color: var(--color-accent-600); }
.fx-step-error .fx-step-mark { color: var(--color-critical); }
.fx-step-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.fx-step-text { min-width: 0; overflow-wrap: anywhere; color: var(--color-quiet); }
.fx-step-line .fx-when { margin-left: auto; flex: none; }
.fx-step-detail > summary { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; font-size: var(--text-small); color: var(--color-muted); list-style: none; }
.fx-step-detail > summary::-webkit-details-marker { display: none; }
.fx-spin {
  width: 12px; height: 12px; border-radius: 50%; flex: none; box-sizing: border-box;
  border: 1.5px solid color-mix(in srgb, var(--color-text) 18%, transparent); border-top-color: var(--color-text);
  animation: fx-spin 0.8s linear infinite;
}
@keyframes fx-spin { to { transform: rotate(360deg); } }

/* The live mark: three dots, small to large, a wave running through them. */
.fx-live-dots { display: inline-flex; align-items: center; gap: 2.5px; height: 8px; flex: none; }
.fx-live-dots i {
  display: block; width: 3px; height: 3px; border-radius: 50%; background: var(--fx-live);
  animation: fx-wave 1.35s cubic-bezier(0.45, 0, 0.55, 1) infinite;
}
.fx-live-dots i:nth-child(2) { width: 4px; height: 4px; animation-delay: 0.15s; }
.fx-live-dots i:nth-child(3) { width: 6px; height: 6px; animation-delay: 0.3s; }
@keyframes fx-wave { 0%, 100% { opacity: 0.35; transform: scale(0.75); } 45% { opacity: 1; transform: scale(1.12); } }

/* The live status line: the wave, what the agent is doing now, how long. */
.fx-pending { margin-top: 8px; }
.fx-typing {
  display: inline-flex; align-items: center; gap: 9px; max-width: 100%; padding: 4px 4px;
  font-size: var(--text-ui); color: var(--color-quiet);
}
.fx-typing-word { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-typing-fail { color: var(--color-accent-700); }

/* Each kind of work has its own mark, in the line's ink, moving its own way. */
.fx-act-slot { display: inline-grid; place-items: center; width: 18px; height: 16px; flex: none; color: var(--fx-live); }
.fx-act-slot.is-swap { animation: fx-swap var(--motion-sheet) var(--ease-out); }
.fx-typing-fail .fx-act-slot { color: var(--color-accent-600); }
.fx-act { display: block; overflow: visible; }
.fx-act * { transform-box: fill-box; transform-origin: center; }
.fx-act-faint { opacity: 0.3; }
.fx-act-cursor { animation: fx-blink 1s steps(1, end) infinite; }
@keyframes fx-blink { 50% { opacity: 0; } }
.fx-act-scan { opacity: 0.55; animation: fx-scan 1.6s cubic-bezier(0.45, 0, 0.55, 1) infinite; }
@keyframes fx-scan { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(8px); } }
.fx-act-ink { stroke-dasharray: 1; animation: fx-ink 1.8s cubic-bezier(0.45, 0, 0.55, 1) infinite; }
@keyframes fx-ink { 0% { stroke-dashoffset: 1; opacity: 1; } 60% { stroke-dashoffset: 0; opacity: 1; } 85%, 100% { stroke-dashoffset: 0; opacity: 0; } }
.fx-act-wave1, .fx-act-wave2 { animation: fx-radiate 1.5s ease-in-out infinite; }
.fx-act-wave2 { animation-delay: 0.25s; }
@keyframes fx-radiate { 0%, 100% { opacity: 0.2; } 45% { opacity: 1; } }
.fx-act-pointer { animation: fx-point 2.4s cubic-bezier(0.45, 0, 0.55, 1) infinite; }
@keyframes fx-point { 0%, 100% { transform: translate(0, 0); } 30% { transform: translate(5px, 1px); } 55% { transform: translate(5px, -1.5px) scale(0.75); } 62% { transform: translate(5px, -1.5px); } 80% { transform: translate(2px, 2px); } }
.fx-act-packet { animation: fx-packet 1.3s cubic-bezier(0.45, 0, 0.55, 1) infinite; }
@keyframes fx-packet { 0% { transform: translateX(0); opacity: 0; } 20% { opacity: 1; } 80% { opacity: 1; } 100% { transform: translateX(4px); opacity: 0; } }
.fx-typing-word.is-swap { animation: fx-swap var(--motion-sheet) var(--ease-out); }
@keyframes fx-swap { from { opacity: 0; transform: translateY(5px); filter: blur(1px); } to { opacity: 1; transform: none; filter: none; } }
.fx-typing-time { flex: none; font-family: var(--font-mono); font-size: var(--text-small); color: var(--color-muted); font-variant-numeric: tabular-nums; }
.fx-steps.is-running .fx-steps-last { display: none; }

/* What arrives while the conversation is open eases in, once. */
.fx-msgs > .is-arriving { animation: fx-arrive var(--motion-sheet) var(--ease-out); }
@keyframes fx-arrive { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

/* The welcome: the agent and its greeting. */
.fx-welcome { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; padding: 24px 0 18px; }
.fx-welcome-face { display: inline-flex; padding: 4px; border: 0; background: none; border-radius: 22px; }
.fx-welcome-face .avatar { display: block; }
.fx-welcome-title { margin: 8px 0 0; font-size: var(--text-title); line-height: var(--lh-title); font-weight: var(--weight-semibold); }
.fx-welcome-sub { margin: 0; font-size: var(--text-small); color: var(--color-muted); }
.fx-welcome-note { margin: 0; font-size: var(--text-small); color: var(--color-muted); max-width: 520px; }

/* The other conversations still running: one line above the composer. */
.fx-stack[hidden] { display: none; }
.fx-stack { margin-bottom: 8px; }
.fx-stack-head {
  display: inline-flex; align-items: center; gap: 8px; padding: 4px 10px 4px 6px; border-radius: var(--radius-pill);
  cursor: pointer; list-style: none; font-size: var(--text-small); color: var(--color-quiet);
  background: var(--fx-field);
}
.fx-stack-head::-webkit-details-marker { display: none; }
.fx-stack-head:hover { color: var(--color-text); }
.fx-stack-faces { display: inline-flex; }
.fx-stack-faces .avatar { display: block; border-radius: var(--radius-sm); box-shadow: 0 0 0 1.5px var(--color-bg); }
.fx-stack-faces .avatar + .avatar { margin-left: -5px; }
.fx-stack-head .chev { color: var(--color-muted); transition: transform var(--motion-base) var(--ease-out); }
.fx-stack-card[open] .fx-stack-head .chev { transform: rotate(180deg); }
.fx-stack-rows {
  display: flex; flex-direction: column; margin-top: 6px; padding: 4px;
  border-radius: var(--radius-panel); background: var(--fx-composer); box-shadow: var(--shadow-lg);
}
.fx-stack-row {
  display: grid; grid-template-columns: 20px auto auto minmax(0, 1fr) auto; align-items: center; gap: 8px;
  padding: 6px 8px; border: 0; border-radius: var(--radius-control); background: none; color: inherit; cursor: pointer;
  font: inherit; font-size: var(--text-small); text-align: left;
}
.fx-stack-row:hover { background: var(--fx-hover); }
.fx-stack-face .avatar { display: block; }
.fx-stack-who { font-weight: 500; }
.fx-stack-node, .fx-stack-when { font-size: var(--text-small); color: var(--color-muted); }
.fx-stack-what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-quiet); }
.fx-stack-more { margin: 2px 8px 2px; font-size: var(--text-small); color: var(--color-muted); }

/* The composer: + · the line · voice · send. */
.fx-composer {
  position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: end; gap: 2px 4px;
  padding: 7px; border-radius: var(--radius-composer); background: var(--fx-composer);
  box-shadow: inset 0 0 0 0.5px var(--fx-line), var(--shadow-sm);
  transition: box-shadow var(--motion-base) var(--ease-out);
}
.fx-composer:focus-within { box-shadow: inset 0 0 0 1px var(--color-neutral-400), var(--shadow-md); }
.fx-composer .fx-icon-btn { width: 34px; height: 34px; border-radius: 50%; }
.fx-plus[aria-expanded="true"] { background: var(--fx-selected); color: var(--color-text); }
.fx-mic[aria-pressed="true"] { background: color-mix(in srgb, var(--fx-seal) 14%, transparent); color: var(--fx-seal); }
.fx-composer textarea {
  width: 100%; min-height: 24px; max-height: 240px; resize: none; border: 0; padding: 6px 4px; margin: 0;
  background: none; color: var(--color-text); outline: none;
  font: inherit; font-size: var(--text-prose); line-height: var(--lh-prose);
}
.fx-composer textarea::placeholder { color: var(--color-muted); }
.fx-composer textarea:disabled { cursor: not-allowed; }
.fx-send {
  display: inline-grid; place-items: center; width: 34px; height: 34px; flex: none; padding: 0;
  border: 0; border-radius: 50%; cursor: pointer;
  background: var(--color-accent-fill); color: var(--fx-accent-ink);
  transition: background-color var(--motion-snap) var(--ease-out), transform var(--motion-snap) var(--ease-out), opacity var(--motion-snap) var(--ease-out);
}
.fx-send .i-sm { width: var(--icon-sm); height: var(--icon-sm); stroke-width: 2.4; }
.fx-send:hover:not(:disabled) { background: var(--color-accent-fill-hover); }
.fx-send:active:not(:disabled) { transform: scale(0.94); }
.fx-send:disabled { opacity: 0.22; cursor: not-allowed; }
.fx-composer[aria-busy="true"] .fx-send { opacity: 0.5; }
.fx-status { grid-column: 1 / -1; margin: 0; padding: 0 10px 2px; font-size: var(--text-small); }
.fx-status:empty { display: none; }
.fx-cmds {
  position: absolute; left: 0; right: 0; bottom: calc(100% + 8px); z-index: var(--z-menu);
  display: flex; flex-direction: column; padding: 5px; max-height: 280px; overflow-y: auto;
  background: var(--fx-composer); border-radius: var(--radius-panel); box-shadow: var(--shadow-lg);
}
.fx-cmds[hidden] { display: none; }
.fx-cmd {
  display: flex; align-items: baseline; gap: 12px; padding: 7px 10px; border: 0; border-radius: var(--radius-control);
  background: none; color: inherit; cursor: pointer; font: inherit; font-size: var(--text-ui); text-align: left;
}
.fx-cmd code { min-width: 104px; font-weight: 500; }
.fx-cmd span { color: var(--color-muted); font-size: var(--text-small); }
.fx-cmd[aria-selected="true"], .fx-cmd:hover { background: var(--fx-selected); }
.fx-cmd[hidden] { display: none; }
.fx-jump {
  position: absolute; left: 50%; top: -40px; transform: translateX(-50%);
  display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 50%;
  background: var(--fx-composer); color: var(--color-text); cursor: pointer; box-shadow: var(--shadow-md);
}
.fx-jump[hidden] { display: none; }
.fx-main > .bar { margin: 0 16px 8px; }
.fx-scrim { display: none; }

/* ---- 对话 (/app) and Code: the answer is text in the reading column ---- */
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-msgs { gap: 10px; padding: 16px 0 32px; }
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-sep { margin: 18px 0 2px; }
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-msg-user { max-width: min(80%, 620px); margin-top: 14px; }
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-msg-user .fx-bubble {
  background: var(--fx-user-block); color: var(--color-text);
  padding: 10px 16px; border-radius: var(--radius-bubble); font-size: var(--text-prose); line-height: var(--lh-prose);
}
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-msg-user .fx-bubble code.mono { background: color-mix(in srgb, var(--color-text) 8%, transparent); }
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-msg-user.is-failed .fx-bubble { background: transparent; }
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-run {
  display: flex; align-items: center; gap: 8px; margin-top: 18px;
  font-size: var(--text-ui); line-height: var(--lh-ui); font-weight: 600;
}
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-run .avatar { display: block; flex: none; }
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-msg-agent, .fx:is([data-layout="chat"], [data-layout="code"]) .fx-steps { max-width: 100%; margin-top: 0; }
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-msg-agent { align-self: stretch; }
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-msg-agent .fx-msg-body { gap: 4px; }
/* The answer is the column's width, like a page: a code block runs from
   edge to edge and scrolls inside itself when a line is longer. */
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-bubble-agent {
  align-self: stretch; width: auto; padding: 0; border-radius: 0; background: none;
  font-size: var(--text-prose); line-height: var(--lh-prose);
}
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-bubble-agent .fx-text > * + * { margin-top: 12px; }
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-bubble-agent .fx-text > .turn-list + .turn-p,
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-bubble-agent .fx-text > .turn-code + .turn-p { margin-top: 20px; }
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-bubble-agent .turn-list { padding-left: 22px; }
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-bubble-agent .turn-list li + li { margin-top: 4px; }
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-bubble-agent .turn-code {
  display: block; width: 100%; box-sizing: border-box; overflow-x: auto;
  padding: 12px 16px; border-radius: var(--radius-panel); font-size: var(--text-code); line-height: var(--lh-code);
  background: var(--fx-user-block);
}
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-msg-agent .fx-meta { padding: 0; margin-left: -4px; min-height: 26px; }
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-msg-agent .fx-mini { margin-left: 0; width: 26px; height: 26px; }
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-msg-agent .fx-meta-more { order: 2; }
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-steps-head {
  padding: 3px 8px 3px 6px; margin-left: -6px; border-radius: var(--radius-control); background: none;
  font-size: var(--text-ui); color: var(--color-quiet);
}
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-steps-head:hover { background: var(--fx-hover); }
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-step-list {
  margin: 4px 0 4px 1px; padding: 4px 0 4px 16px; border-radius: 0; background: none;
  box-shadow: inset 1.5px 0 0 var(--color-divider);
}
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-pending { margin-top: 0; }
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-typing { padding: 2px 0; font-size: var(--text-ui); }
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-pre { background: var(--fx-user-block); }
.fx:is([data-layout="chat"], [data-layout="code"]) .fx-msg-cmd .fx-pre { background: var(--fx-agent-bubble); }

/* /app's welcome: the greeting beside the agent, the large composer under it. */
.fx-greet { gap: 10px; padding: 0 0 28px; }
.fx-greet-line { display: flex; align-items: center; justify-content: center; gap: 14px; min-width: 0; }
.fx-greet .fx-welcome-face { padding: 2px; border-radius: 14px; }
.fx-greet-title {
  margin: 0; font-size: var(--text-display); line-height: var(--lh-display); font-weight: var(--weight-medium); letter-spacing: -0.01em; color: var(--color-text);
}
.fx[data-layout="chat"] .fx-main.is-welcome .fx-scroll { flex: 1 1 0; }
.fx[data-layout="chat"] .fx-main.is-welcome .fx-dock { flex: 1.25 1 0; }
.fx[data-layout="chat"] .fx-main.is-welcome .fx-composer textarea { min-height: 52px; }
.fx[data-layout="chat"] .fx-main.is-welcome .fx-composer { padding: 12px 10px 8px; }
/* The welcome page's composer is the large one: its corner opens up. */
.fx-main.is-welcome .fx-composer { border-radius: var(--radius-composer-lg); }

/* The agent picker under /app's composer line. */
.fx-agent-pick .fx-agent-btn { gap: 6px; padding: 0 6px 0 4px; color: var(--color-text); }
.fx-agent-btn-face { display: inline-flex; flex: none; }
.fx-agent-btn-face:empty { display: none; }
.fx-agent-btn-face .avatar { display: block; }
.fx-agent-btn-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.fx-agent-pick .fx-agent-menu { left: 0; right: auto; width: 300px; }
.fx-pick-item.fx-agent-item { grid-template-columns: 24px minmax(0, 1fr) 14px; column-gap: 10px; padding: 6px 8px; }
.fx-agent-item-face { grid-row: span 2; display: inline-flex; }
.fx-agent-item-face .avatar { display: block; }
.fx-agent-item-name { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.fx-agent-item small { grid-column: 2; }
.fx-agent-item > .i-sm { grid-column: 3; grid-row: 1 / span 2; align-self: center; }
.fx-agent-item:disabled .fx-agent-item-face { opacity: 0.5; }

/* ---- the desktop app: the traffic lights' corner, the drag strip ---- */
:root[data-shell] .fx-top, :root[data-shell] .fx-side-top { -webkit-user-select: none; user-select: none; }

/* ---- narrow: the side list is a drawer ---- */
@media (max-width: ${FRONT_NARROW_PX}px) {
  .fx, .fx[data-side="closed"] { grid-template-columns: minmax(0, 1fr); }
  .fx-side {
    position: fixed; inset: 0 auto 0 0; z-index: 35; width: min(var(--side-w), 86vw);
    visibility: hidden; opacity: 1; transform: translateX(-102%);
    transition: transform var(--motion-sheet) var(--ease-out), visibility 0s linear var(--motion-sheet);
    box-shadow: var(--shadow-lg);
  }
  .fx[data-drawer="open"] .fx-side { visibility: visible; transform: none; transition: transform var(--motion-sheet) var(--ease-out); }
  .fx[data-side="closed"] .fx-side { opacity: 1; }
  .fx-scrim {
    display: block; position: fixed; inset: 0; z-index: 34; border: 0; padding: 0;
    background: color-mix(in srgb, var(--color-scrim) 30%, transparent);
    opacity: 0; pointer-events: none; transition: opacity var(--motion-sheet) var(--ease-out);
  }
  .fx[data-drawer="open"] .fx-scrim { opacity: 1; pointer-events: auto; }
  .fx-side-open, .fx[data-side="closed"] .fx-side-open { display: inline-grid; }
  .fx-top, .fx[data-side="closed"] .fx-top { padding: 0 8px 0 calc(8px + var(--fx-shell-x)); }
  .fx-column { padding: 0 var(--space-4); }
  .fx-msg-user { max-width: 86%; }
  .fx-msg-agent, .fx-steps { max-width: 94%; }
  .fx-head-sub .mono { display: none; }
  .fx-chip-sub, .fx-chip-name { display: none; }
  .fx-chip { padding: 0 4px; }
  .fx-live { display: none; }
  .fx-stack-row { grid-template-columns: 20px auto minmax(0, 1fr); }
  .fx-stack-node, .fx-stack-when { display: none; }
  .fx-greet-title { font-size: var(--text-title); line-height: var(--lh-title); }
  .fx-agent-btn-name { display: none; }
}
/* 主题色: the presets as swatches, and the picker for any other colour. */
.fx-accent-field { flex-direction: column; align-items: stretch; gap: 8px; cursor: default; }
.fx-accent-field:hover { background: none; }
.fx-swatches { display: flex; align-items: center; gap: 6px; }
.fx-swatch {
  position: relative; display: inline-grid; place-items: center; width: 20px; height: 20px; padding: 0;
  border: 0; border-radius: 50%; cursor: pointer; background: var(--fx-swatch, transparent);
  box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.12);
}
.fx-swatch[aria-pressed="true"], .fx-swatch-custom.is-picked { box-shadow: 0 0 0 2px var(--fx-composer), 0 0 0 3.5px var(--fx-swatch); }
.fx-swatch-custom {
  background: conic-gradient(#c96b5a, #c9a65a, #7fa86a, #5a9ec9, #8a6ac9, #c96b9e, #c96b5a);
  --fx-swatch: var(--color-text);
}
.fx-swatch-custom input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; border: 0; padding: 0; }
.fx-swatch:focus-visible, .fx-swatch-custom:focus-within { outline: 2px solid var(--color-focus); outline-offset: 2px; }
.fx-me-menu .fx-menu { min-width: 212px; }

/* The keyboard help: what each shortcut does, its keys at the right. */
.fx-keys { width: min(420px, 92vw); }
.fx-key-list { display: flex; flex-direction: column; gap: 2px; margin: 4px 0 16px; }
.fx-key { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: var(--control-h); font-size: var(--text-ui); }
.fx-key dt { color: var(--color-text); }
.fx-key dd { display: inline-flex; gap: 3px; margin: 0; color: var(--color-muted); }
.fx-key[hidden], :root[data-shell] .fx-key-web, :root:not([data-shell]) .fx-key-shell { display: none; }

/* ---- the settings card (P37.13, qmo-local.md §3.6, view/shell.ts): the
   dialog is the window-sized scrim, the card sits in its middle ---- */
.set {
  position: fixed; inset: 0; z-index: var(--z-menu); box-sizing: border-box;
  width: 100%; height: 100%; max-width: none; max-height: none; margin: 0; padding: 0; border: 0;
  display: grid; place-items: center; overflow: hidden;
  background: transparent; color: var(--color-text);
  transition: background-color var(--motion-base) var(--ease-out);
}
.set::backdrop { background: transparent; }
.set[data-shown] { background: var(--settings-scrim); }
.set-card {
  display: grid; grid-template-columns: var(--settings-side-w) minmax(0, 1fr);
  width: min(var(--settings-w), calc(100vw - var(--settings-inset)));
  height: min(var(--settings-h), calc(100vh - var(--settings-inset)));
  border-radius: var(--radius-panel); background: var(--color-surface); box-shadow: var(--shadow-lg);
  position: relative; overflow: hidden; opacity: 0; transform: scale(var(--settings-from));
  transition: opacity var(--motion-base) var(--ease-out), transform var(--motion-base) var(--ease-out);
}
.set[data-shown] .set-card { opacity: 1; transform: none; }
.set-side {
  display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; min-height: 0;
  padding: var(--space-3) var(--space-2) var(--space-2); background: var(--color-side);
  box-shadow: inset -0.5px 0 0 var(--color-divider);
}
.set-search {
  display: flex; align-items: center; gap: var(--space-2); flex: none; height: var(--control-h);
  padding: 0 10px; box-sizing: border-box; border-radius: var(--radius-control);
  background: var(--ui-field); color: var(--color-quiet); cursor: text;
}
.set-search:focus-within { background: var(--color-field); box-shadow: inset 0 0 0 1px var(--color-focus); }
.set-search input {
  flex: 1; min-width: 0; height: 100%; border: 0; padding: 0; background: none; color: var(--color-text);
  font: inherit; font-size: var(--text-ui); outline: none;
}
.set-search input::placeholder { color: var(--color-quiet); }
.set-search input::-webkit-search-cancel-button { display: none; }
.set-side [hidden] { display: none !important; }
.set-nav { gap: 1px; }
.set-nav.is-filtering .nav-gap { margin-top: 0; }
.set-none { margin: 0; padding: 6px 10px; font-size: var(--text-small); color: var(--color-muted); }
.set-desktop { flex: none; width: 100%; border: 0; background: none; font: inherit; text-align: left; cursor: pointer; }
.set-foot { display: flex; flex-direction: column; gap: var(--space-2); flex: none; padding-top: var(--space-2); border-top: var(--hairline); }
.set-zone { margin: 0; padding: 0 6px; font-size: var(--text-small); line-height: var(--lh-small); }
.set-foot .adv { margin: 0; }
.set-foot .adv > summary { padding: 0 6px; }
.set-body { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.set-top {
  display: flex; align-items: center; gap: var(--space-3); flex: none; flex-wrap: wrap;
  min-height: var(--top-h); padding: var(--space-2) var(--space-3) var(--space-2) var(--space-6); box-sizing: border-box;
}
.set-lead { display: flex; align-items: baseline; gap: var(--space-2); flex: 1; min-width: 0; }
.set-lead > nav:has(li:only-child) { display: none; }
.set-title { margin: 0; font-size: var(--text-page); line-height: var(--lh-page); font-weight: var(--weight-semibold); }
.set-close { flex: none; margin-left: auto; }
.set-body > .conn { margin: 0 var(--space-6); }
.set-main {
  flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin;
  padding: var(--space-2) var(--space-6) var(--space-8); outline: none;
  transition: opacity var(--motion-snap) var(--ease-out);
}
/* While the next area is on its way it dims; the one swapped in comes up
   from there (assets/nav.ts, fade). */
.set[data-busy] .set-main { opacity: var(--opacity-busy); }
.set[data-arriving] .set-main { opacity: var(--opacity-busy); transition: none; }
@media (max-width: ${FRONT_NARROW_PX}px) {
  /* Narrow: the card is the window. Over the area, the search and one row
     of areas that scrolls sideways; the foot goes under the area. */
  .set-card {
    width: 100vw; height: 100vh; height: 100dvh; border-radius: 0;
    display: flex; flex-direction: column;
  }
  .set-side { display: contents; }
  .set-search { margin: var(--space-3) var(--space-3) 0; }
  .set-nav {
    flex: none; flex-direction: row; gap: var(--space-1); margin: var(--space-2) 0 0; padding: 0 var(--space-3) var(--space-2);
    overflow-x: auto; overflow-y: hidden; scrollbar-width: none; box-shadow: inset 0 -0.5px 0 var(--color-divider);
  }
  .set-nav .nav-item { flex: none; }
  .set-nav .nav-gap { margin-top: 0; margin-left: var(--space-2); }
  .set-none, .set-desktop { margin: 0 var(--space-3); width: auto; }
  .set-body { flex: 1; }
  .set-foot { order: 1; flex-direction: row; flex-wrap: wrap; align-items: center; column-gap: var(--space-3); padding: var(--space-2) var(--space-3); }
  .set-top, .set-main { padding-left: var(--space-4); padding-right: var(--space-4); }
  .set-top { row-gap: var(--space-2); }
  .set-tail { order: 1; flex-basis: 100%; justify-content: flex-start; }
  .set-body > .conn { margin: 0 var(--space-4); }
  :root[data-shell="macos"] .set-search { margin-top: var(--top-h); }
}

/* ---- Code (/code, view/frontCode.ts): local sessions ---- */
.fx-code-web { margin: auto; padding: var(--space-8) var(--space-6); text-align: center; font-size: var(--text-prose); line-height: var(--lh-prose); color: var(--color-quiet); }
.fx-code-local { position: relative; flex: 1 1 auto; min-height: 0; display: flex; }
.fx-code-chat { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
/* A new session: the box alone, a little above the middle. */
.fx-code-local[data-view="blank"] .fx-scroll { flex: 1 1 0; }
.fx-code-local[data-view="blank"] .fx-dock { flex: 1.4 1 0; }
.fx-code-local[data-view="blank"] .fx-code-box { border-radius: var(--radius-composer-lg); padding: var(--space-3) var(--space-3) var(--space-2); }
.fx-code-local[data-view="blank"] .fx-code-box textarea { min-height: calc(var(--lh-prose) * 3); }
.fx-code-local[data-view="session"] .fx-code-blank-only { display: none; }
.fx-code-box { grid-template-columns: minmax(0, 1fr); row-gap: var(--space-1); }
.fx-code-tools { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-1); min-width: 0; }
.fx-code-gap { flex: 1 1 auto; }
.fx-code-pill { display: inline-flex; min-width: 0; }
.fx-code-pill > select {
  height: var(--control-h-sm); max-width: calc(var(--side-w) - var(--space-8)); padding: 0 var(--space-6) 0 var(--space-2);
  border: 0; border-radius: var(--radius-control); background: transparent; color: var(--color-quiet);
  font: inherit; font-size: var(--text-ui); text-overflow: ellipsis; cursor: pointer;
}
.fx-code-pill > select:hover:not(:disabled), .fx-code-pill > select:focus-visible { background: var(--ui-hover); color: var(--color-text); }
.fx-code-pill > select:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; }
.fx-code-pill > .chev { right: var(--space-2); }
.fx-code-remote { padding: 0 var(--space-2); font-size: var(--text-ui); color: var(--color-quiet); }
.fx-code-stop { background: var(--color-text); color: var(--color-bg); }
.fx-code-stop:hover:not(:disabled) { background: var(--color-quiet); }
.fx-code-confirm {
  display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); margin: var(--space-2) 0 0; padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control); background: var(--color-danger-bg); color: var(--color-danger-text); font-size: var(--text-ui);
}
.fx-code-confirm > span { flex: 1 1 auto; min-width: 0; }
/* The side list: a dot for the state, the title, the agent. */
.fx-code-row .fx-ritem { padding-right: var(--space-3); }
.fx-code-dot { box-sizing: border-box; }
.fx-code-dot.is-running { background: var(--fx-live); animation: fx-pulse 1.6s ease-in-out infinite; }
.fx-code-dot.is-waiting { background: var(--color-warning-fill); }
.fx-code-dot.is-idle { background: var(--color-success-fill); }
.fx-code-dot.is-interrupted { background: var(--color-neutral-400); }
.fx-code-dot.is-failed { background: var(--color-danger-fill); }
.fx-code-tag { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-small); color: var(--color-muted); }
/* A tool line's counts and diff, a line sent that did not arrive. */
.fx-stat { display: inline-flex; gap: var(--space-1); flex: none; font-family: var(--font-mono); font-size: var(--text-small); }
.fx-add { color: var(--color-success-text); }
.fx-del { color: var(--color-danger-text); }
.fx-diff { white-space: pre; overflow-x: auto; padding-left: 0; padding-right: 0; }
.fx-diff > span { display: block; min-width: max-content; padding: 0 var(--space-3); }
.fx-diff-add { background: var(--color-success-bg); color: var(--color-success-text); }
.fx-diff-del { background: var(--color-danger-bg); color: var(--color-danger-text); }
.fx-diff-hunk { color: var(--color-muted); }
.fx-retry {
  padding: 0 var(--space-1); border: 0; border-radius: var(--radius-xs); background: none; color: var(--color-interactive-text);
  font: inherit; font-size: var(--text-small); cursor: pointer;
}
.fx-retry:hover { text-decoration: underline; }
/* An ask waiting for the person, where its tool line would be. */
.fx-perm {
  display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-1); padding: var(--space-3) var(--space-4);
  border: var(--hairline); border-radius: var(--radius-panel); background: var(--color-surface); box-shadow: var(--shadow-sm);
  font-size: var(--text-ui); line-height: var(--lh-ui);
}
.fx-perm-head { display: flex; align-items: center; gap: var(--space-2); min-width: 0; font-weight: var(--weight-medium); }
.fx-perm-head > .i-sm { flex: none; color: var(--color-warning-text); }
.fx-perm-title { min-width: 0; overflow-wrap: anywhere; }
.fx-perm-tool { flex: none; font-size: var(--text-small); font-weight: var(--weight-regular); color: var(--color-muted); }
.fx-perm-paths { margin: 0; padding: 0; list-style: none; font-size: var(--text-small); color: var(--color-quiet); overflow-wrap: anywhere; }
.fx-perm .fx-pre-quiet { margin: 0; }
.fx-perm-acts, .fx-perm-note { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.fx-perm-note .input { flex: 1 1 12em; min-width: 0; }
.fx-perm-say { margin: 0; font-size: var(--text-small); }
.fx-perm-say:empty { display: none; }
/* The changes panel: the files, a diff under the one opened. */
.fx-code-toggle[aria-pressed="true"] { background: var(--ui-selected); color: var(--color-text); }
.fx-code-changes {
  flex: none; width: min(40%, calc(var(--side-w) * 1.5)); min-height: 0; display: flex; flex-direction: column;
  border-left: var(--hairline); background: var(--color-surface-1);
}
.fx-code-changes-head { display: flex; align-items: center; gap: var(--space-2); min-height: var(--control-h-lg); padding: 0 var(--space-2) 0 var(--space-4); }
.fx-code-changes-head h2 { margin: 0; font-size: var(--text-ui); line-height: var(--lh-ui); font-weight: var(--weight-semibold); }
.fx-code-count { flex: 1 1 auto; font-size: var(--text-small); color: var(--color-muted); }
.fx-code-shut { display: none; }
.fx-code-note { margin: 0; padding: 0 var(--space-4) var(--space-2); font-size: var(--text-small); color: var(--color-muted); }
.fx-code-note:empty { display: none; }
.fx-code-files { flex: 1 1 auto; min-height: 0; overflow-y: auto; margin: 0; padding: 0 var(--space-2) var(--space-4); list-style: none; }
.fx-code-frow {
  display: flex; align-items: center; gap: var(--space-2); width: 100%; min-height: var(--control-h); padding: 0 var(--space-2);
  border: 0; border-radius: var(--radius-control); background: none; color: var(--color-text); font: inherit; font-size: var(--text-ui); text-align: left; cursor: pointer;
}
.fx-code-frow:hover { background: var(--ui-hover); }
.fx-code-frow[aria-expanded="true"] { background: var(--ui-selected); }
.fx-code-frow:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; }
.fx-code-fstat { flex: none; width: 1.2em; text-align: center; font-size: var(--text-small); color: var(--color-quiet); }
.fx-code-fpath { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; font-size: var(--text-small); }
.fx-code-file .fx-diff { margin: var(--space-1) 0 var(--space-2); max-height: 60vh; background: var(--color-surface); font-size: var(--text-small); line-height: var(--lh-small); }
@media (max-width: ${FRONT_NARROW_PX}px) {
  .fx-code-changes { position: absolute; inset: 0; z-index: 4; width: auto; border-left: 0; box-shadow: var(--shadow-lg); }
  .fx-code-shut { display: inline-grid; }
  .fx-code-head .fx-head-sub { display: none; }
  .fx-code-pill > select { max-width: calc(50vw - var(--space-8)); }
}

@media (prefers-reduced-motion: reduce) {
  .set, .set-card, .set-main, .fx-switch-item { transition: none; }
  .fx, .fx-side, .fx-scrim, .fx-unread, .fx-mode-item, .fx-row, .fx-meta-more, .fx-mini { transition: none; }
  .fx-pulse, .fx-spin, .fx-live-dots i, .fx-typing-word.is-swap, .fx-msgs > .is-arriving,
  .fx-act-slot.is-swap, .fx-act *, .fx-computer::after, .fx-main[aria-busy="true"] .fx-progress::before { animation: none; }
  .fx-main[aria-busy="true"] .fx-progress::before { transform: none; width: 100%; opacity: 0.5; }
  .fx-steps-head .chev, .fx-stack-head .chev { transition: none; }
  .fx-code-dot.is-running { animation: none; }
}
`
