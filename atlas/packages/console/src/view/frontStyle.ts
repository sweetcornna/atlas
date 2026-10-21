// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The conversation front's own sheet, on top of the console's sheet
 * (`assets/css.ts`).
 *
 * The palette is the console's own (`assets/css.ts`): near white and ink,
 * the logo's sage for working and delivered, amber for a warning, and the
 * reader's 主题色 for what is theirs or alive (`accent.ts`). This sheet adds
 * the front's few tokens of its own — bubbles, fields, the unread dot's seal
 * red — in both dark selectors of the console's sheet.
 *
 * The layout: a full-height app frame instead of a scrolling document, a side
 * list that collapses on a wide screen and becomes a drawer on a narrow one,
 * one centred column for the transcript and the composer, and the welcome
 * state that lifts the composer to the middle under the agent's greeting.
 */
export const FRONT_CSS = `
body.fx-body {
  --fx-accent: var(--color-accent-fill);
  --fx-accent-ink: var(--color-on-accent-fill);
  --fx-live: var(--fx-accent);
  --fx-user-bubble: var(--fx-accent);
  --fx-user-ink: var(--fx-accent-ink);
  --fx-seal: #d9462b;
  --fx-hover: var(--ui-hover);
  --fx-selected: var(--ui-selected);
  --fx-field: var(--ui-field);
  --fx-line: var(--ui-line);
  --fx-agent-bubble: rgba(16, 16, 0, 0.045);
  --fx-composer: var(--ui-menu);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) body.fx-body {
    --fx-seal: #f0644a;
    --fx-agent-bubble: rgba(255, 255, 255, 0.065);
  }
}
:root[data-theme="dark"] body.fx-body {
  --fx-seal: #f0644a;
  --fx-agent-bubble: rgba(255, 255, 255, 0.065);
}

html:has(body.fx-body), body.fx-body { height: 100%; }
.fx [hidden], .fx-body dialog:not([open]) { display: none !important; }
body.fx-body {
  margin: 0; overflow: hidden; background: var(--color-bg); color: var(--color-text);
  -webkit-font-smoothing: antialiased;
}
.fx-body svg.i, .fx-body svg.i-sm { stroke-width: 1.9; }
.fx {
  --fx-side-w: 272px;
  display: grid; grid-template-columns: var(--fx-side-w) minmax(0, 1fr);
  height: 100vh; height: 100dvh; transition: grid-template-columns 180ms ease;
}
.fx[data-side="closed"] { grid-template-columns: 0 minmax(0, 1fr); }
.fx[data-side="closed"] .fx-side { visibility: hidden; opacity: 0; }

/* ---- shared controls: the icon button, the menu and the account row are
   in the console's sheet, drawn the same on both sides ---- */
.fx-agent:focus-visible, .fx-hitem:focus-visible,
.fx-stack-row:focus-visible, .fx-send:focus-visible,
.fx-steps-head:focus-visible, .fx-stack-head:focus-visible {
  outline: 2px solid var(--color-focus); outline-offset: 1px;
}
.fx-pulse {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: var(--fx-live); animation: fx-pulse 1.6s ease-in-out infinite;
}
@keyframes fx-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.fx-none { margin: 4px 0; padding: 6px 10px; font-size: var(--text-12-5); color: var(--color-muted); }

/* ---- the side list ---- */
.fx-side {
  display: flex; flex-direction: column; gap: 10px; min-height: 0; min-width: 0;
  padding: 10px 8px 8px; background: var(--color-side); overflow: hidden;
  box-shadow: inset -0.5px 0 0 var(--color-divider);
  transition: opacity 140ms ease;
}
.fx-side-top { display: flex; align-items: center; gap: 2px; padding: 2px 0 0 6px; min-height: 32px; }
.fx-brand { display: inline-flex; align-items: center; gap: 9px; margin-right: auto; color: inherit; text-decoration: none; min-width: 0; }
.fx-brand-name { font-size: var(--text-15, 15px); font-weight: 600; letter-spacing: 0.06em; }
/* The logo (its colours are the console's, assets/css.ts): the ridges between
   its plots widened in the panel's own ground so they stay open at this size. */
.fx-brand .qm-mark path { stroke: var(--color-side); stroke-width: 18px; stroke-linejoin: round; }
.fx-search {
  display: flex; align-items: center; gap: 7px; height: 32px; padding: 0 10px; border-radius: 10px;
  background: var(--fx-field); box-shadow: inset 0 0 0 0.5px var(--fx-line); color: var(--color-muted);
}
.fx-search:focus-within { background: var(--color-field); box-shadow: inset 0 0 0 1px var(--color-focus); }
.fx-search input {
  flex: 1; min-width: 0; border: 0; background: none; color: var(--color-text);
  font: inherit; font-size: var(--text-13); outline: none;
}
.fx-search input::placeholder { color: var(--color-muted); }
.fx-side-scroll {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  margin: 0 -4px; padding: 0 4px 8px; scrollbar-width: thin;
}
.fx-agents { display: flex; flex-direction: column; gap: 1px; }
.fx-side-link {
  display: inline-flex; align-items: center; gap: 8px; margin-top: 6px; padding: 7px 10px;
  border-radius: 8px; font-size: var(--text-12-5); color: var(--color-quiet); text-decoration: none;
}
.fx-side-link:hover { background: var(--fx-hover); color: var(--color-text); }

/* An agent: one row, its menu over the row's right end. */
.fx-agent-row { position: relative; border-radius: 10px; transition: background-color 120ms ease; }
.fx-agent-row:hover { background: var(--fx-hover); }
.fx-agent-row.is-current { background: var(--fx-selected); }
.fx-agent-row.is-off .fx-agent-face, .fx-agent-row.is-off .fx-agent-name { opacity: 0.5; }
.fx-agent {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 52px;
  padding: 8px 10px 8px 8px; border: 0; border-radius: 10px; background: none; color: inherit;
  cursor: pointer; font: inherit; text-align: left;
}
.fx-agent-face { display: inline-flex; flex: none; }
.fx-agent-face .avatar { display: block; }
.fx-agent-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.fx-agent-line { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.fx-agent-name { font-size: var(--text-14); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-agent-node { font-size: var(--text-11); color: var(--color-muted); white-space: nowrap; }
.fx-agent-tag {
  flex: none; padding: 0 5px; border-radius: 4px; font-size: var(--text-10-5); line-height: 16px;
  background: var(--fx-field); color: var(--color-muted);
}
.fx-agent-when { margin-left: auto; padding-left: 6px; flex: none; font-size: var(--text-12); color: var(--color-muted); white-space: nowrap; }
.fx-agent-sub {
  padding-right: 14px; font-size: var(--text-12); color: var(--color-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fx-agent-row.is-busy .fx-agent-sub { color: var(--color-quiet); }
.fx-agent-sub .fx-live-dots { margin-right: 6px; vertical-align: 1px; }
.fx-unread {
  position: absolute; right: 12px; bottom: 16px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--color-interactive); opacity: 0; transform: scale(0.4); transition: opacity 160ms ease, transform 160ms ease;
}
.fx-agent-row.is-unread .fx-unread { opacity: 1; transform: none; }
.fx-agent-row.is-unread .fx-agent-name { font-weight: 600; }
.fx-agent-row.is-unread .fx-agent-sub { color: var(--color-quiet); }
.fx-agent-row > .fx-more { position: absolute; right: 6px; top: 6px; }
.fx-agent-row .fx-more-btn { width: 26px; height: 26px; opacity: 0; background: var(--color-side); }
.fx-agent-row.is-current .fx-more-btn { background: transparent; }
.fx-agent-row:hover .fx-more-btn, .fx-agent-row:focus-within .fx-more-btn, .fx-agent-row .fx-more[open] .fx-more-btn { opacity: 1; }
.fx-agent-row:hover .fx-agent-when, .fx-agent-row:focus-within .fx-agent-when { visibility: hidden; }
@media (hover: none) { .fx-agent-row .fx-more-btn { opacity: 1; } .fx-agent-row .fx-agent-when { visibility: hidden; } }


/* ---- the bar ---- */
.fx-main { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--color-bg); }
.fx-top { display: flex; align-items: center; gap: 6px; min-height: 52px; padding: 0 12px; flex: none; }
.fx-side-open { display: none; }
.fx[data-side="closed"] .fx-side-open { display: inline-grid; }
.fx-head-mount { flex: 1; min-width: 0; }
.fx-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.fx-head-face { display: inline-flex; padding: 2px; margin: -2px; border: 0; background: none; border-radius: 8px; flex: none; }
.fx-head-face .avatar { display: block; }
button.fx-head-face, button.fx-welcome-face { cursor: pointer; }
button.fx-head-face:hover, button.fx-welcome-face:hover { background: var(--fx-hover); }
.fx-head-name { font-size: var(--text-14); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.fx-head-sub { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: var(--text-12); color: var(--color-muted); white-space: nowrap; overflow: hidden; }
.fx-head-sub .mono { font-size: var(--text-11-5); }
.fx-head-sub .state { font-size: var(--text-12); }
.fx-head-sub .dot { width: 7px; height: 7px; }
.fx-model:empty { display: none; }
.fx-info .fx-info-card { width: min(320px, 86vw); padding: 12px; gap: 10px; left: 0; right: auto; }
.fx-facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; margin: 0; font-size: var(--text-12-5); }
.fx-facts dt { color: var(--color-muted); }
.fx-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.fx-info-links { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: var(--text-12-5); padding-top: 8px; border-top: 0.5px solid var(--color-divider); }
.fx-info-links a { color: var(--color-text); text-decoration: none; }
.fx-info-links a:hover { text-decoration: underline; }
.fx-top-tail { display: flex; align-items: center; gap: 2px; flex: none; }
.fx-live { margin-right: 6px; font-size: var(--text-11-5); color: var(--color-muted); }
.fx-live:empty { display: none; }

/* The history menu. */
.fx-hist-pop { width: min(340px, 88vw); max-height: min(62vh, 520px); padding: 0; overflow: hidden; }
.fx-history { display: flex; flex-direction: column; min-height: 0; max-height: inherit; }
.fx-sec-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 10px 6px 12px; }
.fx-sec-title { margin: 0; font-size: var(--text-13); font-weight: 600; }
.fx-hist-list { overflow-y: auto; padding: 0 5px 6px; scrollbar-width: thin; }
.fx-seg { display: inline-flex; padding: 2px; border-radius: 8px; background: var(--fx-field); }
.fx-seg button {
  border: 0; background: none; color: var(--color-muted); cursor: pointer;
  padding: 2px 8px; border-radius: 6px; font: inherit; font-size: var(--text-11-5);
}
.fx-seg button[aria-pressed="true"] { background: var(--fx-composer); color: var(--color-text); box-shadow: var(--shadow-sm); }
.fx-hgroup { display: flex; flex-direction: column; gap: 1px; }
.fx-hgroup-name { margin: 8px 0 2px; padding: 0 8px; font-size: var(--text-11); color: var(--color-muted); }
.fx-hitem {
  display: flex; flex-direction: column; gap: 1px; width: 100%; padding: 6px 8px;
  border: 0; border-radius: 8px; background: none; color: inherit; cursor: pointer;
  font: inherit; text-align: left;
}
.fx-hitem:hover { background: var(--fx-hover); }
.fx-hitem.is-active { background: var(--fx-selected); }
.fx-hitem-title { font-size: var(--text-13); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-hitem-meta { display: flex; align-items: center; gap: 6px; font-size: var(--text-11); color: var(--color-muted); }
.fx-history:not([data-scope="all"]) .fx-hitem-who { display: none; }
.fx-hitem-who::after { content: "·"; margin-left: 6px; }

/* ---- the conversation ---- */
.fx-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
.fx-column { width: 100%; max-width: 760px; margin: 0 auto; padding: 0 24px; box-sizing: border-box; }
.fx-dock { flex: none; position: relative; padding: 4px 0 14px; }
.fx-main.is-welcome .fx-scroll { flex: 1 1 0; display: flex; flex-direction: column; justify-content: flex-end; }
.fx-main.is-welcome .fx-dock { flex: 1 1 0; }

.fx-msgs { display: flex; flex-direction: column; gap: 6px; padding: 12px 0 24px; }
.fx-msg { min-width: 0; }
.fx-sep { display: flex; justify-content: center; margin: 14px 0 6px; }
.fx-sep-time { font-size: var(--text-12); color: var(--color-muted); font-variant-numeric: tabular-nums; }
.fx-bubble {
  width: fit-content; max-width: 100%; box-sizing: border-box; padding: 9px 14px; border-radius: 18px;
  font-size: var(--text-14-5); line-height: 1.6; overflow-wrap: anywhere;
}
.fx-bubble .turn-p { margin: 0; }
.fx-bubble .turn-p + .turn-p, .fx-bubble .turn-list, .fx-bubble .turn-code { margin-top: 8px; }
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
.fx-cmd-name { font-size: var(--text-12); color: var(--color-muted); }
.fx-msg-cmd { max-width: 100%; }
.fx-text { overflow-wrap: anywhere; }
.fx-text code.mono, .fx-bubble code.mono {
  padding: 1px 5px; border-radius: 5px; font-size: 0.88em;
  background: color-mix(in srgb, var(--color-text) 7%, transparent);
}
.fx-pre {
  margin: 0; padding: 10px 14px; border-radius: 12px; overflow-x: auto; max-width: 100%; box-sizing: border-box;
  background: var(--fx-agent-bubble);
  font-family: var(--font-mono); font-size: var(--text-12-5); line-height: 1.55;
}
.fx-pre > code { white-space: pre; }
.fx-pre-quiet { margin-top: 6px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--text-12); max-height: 240px; overflow-y: auto; }

/* What sits under a line: shown on hover, except where it matters. */
.fx-meta {
  display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; min-height: 22px; padding: 0 4px;
  font-size: var(--text-11-5); color: var(--color-muted);
}
.fx-msg-user .fx-meta { justify-content: flex-end; }
.fx-msg-user:not(.is-last):not(.is-failed):not(.is-sending):not(.is-queued) .fx-meta {
  position: absolute; right: calc(100% + 6px); bottom: 2px; min-height: 0; white-space: nowrap; flex-wrap: nowrap;
  opacity: 0; pointer-events: none; transition: opacity 120ms ease;
}
.fx-msg-user:not(.is-last):not(.is-failed):hover .fx-meta { opacity: 1; pointer-events: auto; }
.fx-when { font-family: var(--font-mono); font-size: var(--text-11); color: var(--color-muted); }
.fx-id { font-size: var(--text-11); color: var(--color-muted); text-decoration: none; }
a.fx-id:hover { color: var(--color-text); text-decoration: underline; }
.fx-fail { color: var(--color-critical); font-weight: 500; }
.fx-queued { color: var(--color-quiet); }
.fx-chain { display: inline-flex; gap: 3px; align-items: center; }
.fx-chain i { width: 5px; height: 5px; border-radius: 50%; background: color-mix(in srgb, var(--color-text) 16%, transparent); }
.fx-chain i.on { background: var(--color-accent-2-500); }
.fx-meta-more { display: inline-flex; align-items: center; gap: 10px; opacity: 0; transition: opacity 120ms ease; }
.fx-msg:hover .fx-meta-more, .fx-msg:focus-within .fx-meta-more { opacity: 1; }
.fx-mini {
  display: inline-grid; place-items: center; width: 24px; height: 22px; padding: 0; margin-left: -4px;
  border: 0; border-radius: 6px; background: none; color: var(--color-muted); cursor: pointer;
  opacity: 0; transition: opacity 120ms ease, background-color 120ms ease;
}
.fx-msg-agent:hover .fx-mini, .fx-mini:focus-visible { opacity: 1; }
.fx-mini:hover { background: var(--fx-selected); color: var(--color-text); }
@media (hover: none) { .fx-meta-more { display: none; } .fx-mini { opacity: 1; } }

/* A step group: one checklist line that unfolds. */
.fx-steps { align-self: flex-start; max-width: min(88%, 680px); margin-top: 6px; }
.fx-steps-head {
  display: inline-flex; align-items: center; gap: 8px; max-width: 100%; box-sizing: border-box; padding: 6px 12px;
  border-radius: 14px; cursor: pointer; list-style: none; font-size: var(--text-12-5); color: var(--color-quiet);
  background: var(--fx-agent-bubble);
}
.fx-steps-head::-webkit-details-marker { display: none; }
.fx-steps-head:hover { color: var(--color-text); }
.fx-steps-label { flex: none; font-weight: 500; }
.fx-steps-last { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted); }
.fx-steps[open] .fx-steps-last { display: none; }
.fx-steps-head .chev { transition: transform 150ms ease; flex: none; color: var(--color-muted); }
.fx-steps[open] .fx-steps-head .chev { transform: rotate(180deg); }
.fx-steps-warn .fx-steps-head > .i-sm { color: var(--color-accent-600); }
.fx-steps-bad .fx-steps-head > .i-sm { color: var(--color-critical); }
.fx-step-list {
  list-style: none; margin: 4px 0 0; padding: 8px 12px; border-radius: 14px; background: var(--fx-agent-bubble);
  display: flex; flex-direction: column; gap: 6px;
}
.fx-step { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 8px; align-items: start; font-size: var(--text-12-5); }
.fx-step-mark { display: inline-flex; padding-top: 2px; color: var(--color-accent-2-600); }
.fx-step-warn .fx-step-mark { color: var(--color-accent-600); }
.fx-step-error .fx-step-mark { color: var(--color-critical); }
.fx-step-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.fx-step-text { min-width: 0; overflow-wrap: anywhere; color: var(--color-quiet); }
.fx-step-line .fx-when { margin-left: auto; flex: none; }
.fx-step-detail > summary { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; font-size: var(--text-11-5); color: var(--color-muted); list-style: none; }
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
  font-size: var(--text-13); color: var(--color-quiet);
}
.fx-typing-word { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-typing-fail { color: var(--color-accent-700); }

/* Each kind of work has its own mark, in the line's ink, moving its own way. */
.fx-act-slot { display: inline-grid; place-items: center; width: 18px; height: 16px; flex: none; color: var(--fx-live); }
.fx-act-slot.is-swap { animation: fx-swap 280ms cubic-bezier(0.2, 0.7, 0.2, 1); }
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
.fx-typing-word.is-swap { animation: fx-swap 280ms cubic-bezier(0.2, 0.7, 0.2, 1); }
@keyframes fx-swap { from { opacity: 0; transform: translateY(5px); filter: blur(1px); } to { opacity: 1; transform: none; filter: none; } }
.fx-typing-time { flex: none; font-family: var(--font-mono); font-size: var(--text-11-5); color: var(--color-muted); font-variant-numeric: tabular-nums; }
.fx-steps.is-running .fx-steps-last { display: none; }

/* What arrives while the conversation is open eases in, once. */
.fx-msgs > .is-arriving { animation: fx-arrive 260ms cubic-bezier(0.2, 0.7, 0.2, 1); }
@keyframes fx-arrive { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

/* The welcome: the agent and its greeting. */
.fx-welcome { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; padding: 24px 0 18px; }
.fx-welcome-face { display: inline-flex; padding: 4px; border: 0; background: none; border-radius: 22px; }
.fx-welcome-face .avatar { display: block; }
.fx-welcome-title { margin: 8px 0 0; font-size: var(--text-22); font-weight: 600; letter-spacing: 0.01em; }
.fx-welcome-sub { margin: 0; font-size: var(--text-13); color: var(--color-muted); }
.fx-welcome-note { margin: 0; font-size: var(--text-12-5); color: var(--color-muted); max-width: 520px; }

/* The other conversations still running: one line above the composer. */
.fx-stack[hidden] { display: none; }
.fx-stack { margin-bottom: 8px; }
.fx-stack-head {
  display: inline-flex; align-items: center; gap: 8px; padding: 4px 10px 4px 6px; border-radius: 999px;
  cursor: pointer; list-style: none; font-size: var(--text-12); color: var(--color-quiet);
  background: var(--fx-field);
}
.fx-stack-head::-webkit-details-marker { display: none; }
.fx-stack-head:hover { color: var(--color-text); }
.fx-stack-faces { display: inline-flex; }
.fx-stack-faces .avatar { display: block; border-radius: 6px; box-shadow: 0 0 0 1.5px var(--color-bg); }
.fx-stack-faces .avatar + .avatar { margin-left: -5px; }
.fx-stack-head .chev { color: var(--color-muted); transition: transform 150ms ease; }
.fx-stack-card[open] .fx-stack-head .chev { transform: rotate(180deg); }
.fx-stack-rows {
  display: flex; flex-direction: column; margin-top: 6px; padding: 4px;
  border-radius: 14px; background: var(--fx-composer); box-shadow: var(--shadow-md);
}
.fx-stack-row {
  display: grid; grid-template-columns: 20px auto auto minmax(0, 1fr) auto; align-items: center; gap: 8px;
  padding: 6px 8px; border: 0; border-radius: 9px; background: none; color: inherit; cursor: pointer;
  font: inherit; font-size: var(--text-12-5); text-align: left;
}
.fx-stack-row:hover { background: var(--fx-hover); }
.fx-stack-face .avatar { display: block; }
.fx-stack-who { font-weight: 500; }
.fx-stack-node, .fx-stack-when { font-size: var(--text-11); color: var(--color-muted); }
.fx-stack-what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-quiet); }
.fx-stack-more { margin: 2px 8px 2px; font-size: var(--text-11); color: var(--color-muted); }

/* The composer: + · the line · voice · send. */
.fx-composer {
  position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: end; gap: 2px 4px;
  padding: 7px; border-radius: 24px; background: var(--fx-composer);
  box-shadow: inset 0 0 0 0.5px var(--fx-line), var(--shadow-sm);
  transition: box-shadow 150ms ease;
}
.fx-composer:focus-within { box-shadow: inset 0 0 0 1px var(--color-neutral-400), var(--shadow-md); }
.fx-composer .fx-icon-btn { width: 34px; height: 34px; border-radius: 50%; }
.fx-plus[aria-expanded="true"] { background: var(--fx-selected); color: var(--color-text); }
.fx-mic[aria-pressed="true"] { background: color-mix(in srgb, var(--fx-seal) 14%, transparent); color: var(--fx-seal); }
.fx-composer textarea {
  width: 100%; min-height: 24px; max-height: 240px; resize: none; border: 0; padding: 6px 4px; margin: 0;
  background: none; color: var(--color-text); outline: none;
  font: inherit; font-size: var(--text-15, 15px); line-height: 1.5;
}
.fx-composer textarea::placeholder { color: var(--color-muted); }
.fx-composer textarea:disabled { cursor: not-allowed; }
.fx-send {
  display: inline-grid; place-items: center; width: 34px; height: 34px; flex: none; padding: 0;
  border: 0; border-radius: 50%; cursor: pointer;
  background: var(--color-accent-fill); color: var(--fx-accent-ink);
  transition: background-color 120ms ease, transform 120ms ease, opacity 120ms ease;
}
.fx-send .i-sm { width: 16px; height: 16px; stroke-width: 2.4; }
.fx-send:hover:not(:disabled) { background: var(--color-accent-fill-hover); }
.fx-send:active:not(:disabled) { transform: scale(0.94); }
.fx-send:disabled { opacity: 0.22; cursor: not-allowed; }
.fx-composer[aria-busy="true"] .fx-send { opacity: 0.5; }
.fx-status { grid-column: 1 / -1; margin: 0; padding: 0 10px 2px; font-size: var(--text-12); }
.fx-status:empty { display: none; }
.fx-cmds {
  position: absolute; left: 0; right: 0; bottom: calc(100% + 8px); z-index: var(--z-menu);
  display: flex; flex-direction: column; padding: 5px; max-height: 280px; overflow-y: auto;
  background: var(--fx-composer); border-radius: 14px; box-shadow: var(--shadow-lg);
}
.fx-cmds[hidden] { display: none; }
.fx-cmd {
  display: flex; align-items: baseline; gap: 12px; padding: 7px 10px; border: 0; border-radius: 8px;
  background: none; color: inherit; cursor: pointer; font: inherit; font-size: var(--text-13); text-align: left;
}
.fx-cmd code { min-width: 104px; font-weight: 500; }
.fx-cmd span { color: var(--color-muted); font-size: var(--text-12); }
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

/* ---- narrow: the side list is a drawer ---- */
@media (max-width: 900px) {
  .fx, .fx[data-side="closed"] { grid-template-columns: minmax(0, 1fr); }
  .fx-side {
    position: fixed; inset: 0 auto 0 0; z-index: 35; width: min(300px, 86vw);
    visibility: hidden; opacity: 1; transform: translateX(-102%);
    transition: transform 200ms ease, visibility 0s linear 200ms;
    box-shadow: var(--shadow-lg);
  }
  .fx[data-drawer="open"] .fx-side { visibility: visible; transform: none; transition: transform 200ms ease; }
  .fx[data-side="closed"] .fx-side { opacity: 1; }
  .fx-scrim {
    display: block; position: fixed; inset: 0; z-index: 34; border: 0; padding: 0;
    background: color-mix(in srgb, var(--color-scrim) 30%, transparent);
    opacity: 0; pointer-events: none; transition: opacity 200ms ease;
  }
  .fx[data-drawer="open"] .fx-scrim { opacity: 1; pointer-events: auto; }
  .fx-side-open, .fx[data-side="closed"] .fx-side-open { display: inline-grid; }
  .fx-top { padding: 0 8px; min-height: 48px; }
  .fx-column { padding: 0 14px; }
  .fx-msg-user { max-width: 86%; }
  .fx-msg-agent, .fx-steps { max-width: 94%; }
  .fx-head-sub .mono { display: none; }
  .fx-live { display: none; }
  .fx-stack-row { grid-template-columns: 20px auto minmax(0, 1fr); }
  .fx-stack-node, .fx-stack-when { display: none; }
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
@media (prefers-reduced-motion: reduce) {
  .fx, .fx-side, .fx-scrim, .fx-unread { transition: none; }
  .fx-pulse, .fx-spin, .fx-live-dots i, .fx-typing-word.is-swap, .fx-msgs > .is-arriving,
  .fx-act-slot.is-swap, .fx-act * { animation: none; }
}
`
