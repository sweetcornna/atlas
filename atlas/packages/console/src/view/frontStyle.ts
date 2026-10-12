// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The conversation front's own sheet, on top of the console's tokens
 * (`assets/css.ts`).
 *
 * Every colour, radius and space is a token of the Organic system, so the
 * dark scheme is the same token flip as everywhere else and this sheet has no
 * dark block of its own. What it adds is layout: a full-height app frame
 * instead of a scrolling document, a side panel that collapses on a wide
 * screen and becomes a drawer on a narrow one, one centred column for the
 * transcript and the composer, and the welcome state that lifts the composer
 * to the middle under the agent's greeting.
 *
 * Flat, not boxed (hermes desktop's first rule, and this console's): the
 * panel is one surface with whitespace between its groups, agents and
 * sessions are rows rather than cards, the agent's answer has no bubble, and
 * a step group is a line that unfolds rather than a card per tool call.
 */
export const FRONT_CSS = `
html:has(body.fx-body), body.fx-body { height: 100%; }
.fx [hidden], .fx-body dialog:not([open]) { display: none !important; }
body.fx-body { margin: 0; overflow: hidden; background: var(--color-bg); color: var(--color-text); }
.fx {
  --fx-side-w: 296px;
  display: grid; grid-template-columns: var(--fx-side-w) minmax(0, 1fr);
  height: 100vh; height: 100dvh; transition: grid-template-columns 180ms ease;
}
.fx[data-side="closed"] { grid-template-columns: 0 minmax(0, 1fr); }
.fx[data-side="closed"] .fx-side { visibility: hidden; opacity: 0; }

/* ---- the side panel ---- */
.fx-side {
  display: flex; flex-direction: column; gap: var(--space-3); min-height: 0; min-width: 0;
  padding: var(--space-3) var(--space-3) var(--space-2);
  background: var(--color-surface); overflow: hidden;
  transition: opacity 140ms ease;
}
.fx-side-top { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: 2px 2px 0 4px; }
.fx-brand { display: inline-flex; align-items: center; gap: 10px; color: inherit; text-decoration: none; min-width: 0; }
.fx-mark {
  display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; flex: none;
  background: var(--color-accent-fill); color: var(--color-bg);
  font-family: serif; font-size: 19px; line-height: 1;
}
.fx-brand-text { display: flex; flex-direction: column; line-height: 1.15; min-width: 0; }
.fx-brand-text b { font-size: var(--text-16); font-weight: 650; letter-spacing: 0.04em; }
.fx-brand-text span { font-size: var(--text-10-5); color: var(--color-muted); letter-spacing: 0.12em; text-transform: uppercase; }
.fx-icon-btn {
  display: inline-grid; place-items: center; width: 34px; height: 34px; flex: none;
  border: 0; border-radius: 10px; background: none; color: var(--color-quiet);
  cursor: pointer; list-style: none; text-decoration: none;
  transition: background-color 120ms ease, color 120ms ease;
}
.fx-icon-btn::-webkit-details-marker { display: none; }
.fx-icon-btn:hover, details[open] > .fx-icon-btn { background: color-mix(in srgb, var(--color-text) 8%, transparent); color: var(--color-text); }
.fx-icon-btn:focus-visible, .fx-agent:focus-visible, .fx-hitem:focus-visible, .fx-chip:focus-visible,
.fx-new:focus-visible, .fx-stack-row:focus-visible, .fx-menu-item:focus-visible, .fx-send:focus-visible {
  outline: 2px solid var(--color-accent); outline-offset: 2px;
}
.fx-new {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 10px 14px; border: 0; border-radius: 14px; cursor: pointer;
  background: var(--color-bg); color: var(--color-text);
  font: inherit; font-size: var(--text-14); font-weight: 600; box-shadow: var(--shadow-sm);
  transition: transform 120ms ease, box-shadow 120ms ease;
}
.fx-new:hover { box-shadow: var(--shadow-md); }
.fx-new:active { transform: translateY(1px); }
.fx-search {
  display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 36px; border-radius: 12px;
  background: color-mix(in srgb, var(--color-text) 5%, transparent); color: var(--color-muted);
}
.fx-search:focus-within { background: var(--color-bg); outline: 1.5px solid var(--color-accent-300); }
.fx-search input {
  flex: 1; min-width: 0; border: 0; background: none; color: var(--color-text);
  font: inherit; font-size: var(--text-13-5); outline: none;
}
.fx-search input::-webkit-search-cancel-button { cursor: pointer; }
.fx-side-scroll {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: var(--space-4);
  margin: 0 calc(var(--space-2) * -1); padding: 2px var(--space-2) var(--space-3);
  scrollbar-width: thin;
}
.fx-sec { display: flex; flex-direction: column; gap: 2px; }
.fx-sec-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.fx-sec-title {
  display: flex; align-items: center; gap: 6px; margin: 8px 0 4px; padding: 0 8px;
  font-size: var(--text-11-5); font-weight: 600; letter-spacing: 0.08em; color: var(--color-muted);
}
.fx-count {
  padding: 0 6px; border-radius: 999px; font-size: var(--text-10-5); letter-spacing: 0;
  background: color-mix(in srgb, var(--color-text) 8%, transparent); color: var(--color-quiet);
}
.fx-none { margin: 4px 0; padding: 6px 10px; font-size: var(--text-12-5); color: var(--color-muted); }
.fx-none-center { text-align: center; padding: var(--space-8) 0; }
.fx-side-link {
  display: inline-flex; align-items: center; gap: 8px; margin-top: 6px; padding: 7px 10px;
  border-radius: 10px; font-size: var(--text-12-5); color: var(--color-quiet); text-decoration: none;
}
.fx-side-link:hover { background: color-mix(in srgb, var(--color-text) 6%, transparent); color: var(--color-text); }

/* An agent: a row, with its menu beside it. */
.fx-agent-row { position: relative; display: flex; align-items: center; border-radius: 14px; transition: background-color 120ms ease; }
.fx-agent-row:hover { background: color-mix(in srgb, var(--color-text) 6%, transparent); }
.fx-agent-row.is-current { background: var(--color-bg); box-shadow: var(--shadow-sm); }
.fx-agent-row.is-off .fx-agent-name, .fx-agent-row.is-off .fx-agent-face { opacity: 0.55; }
.fx-agent {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px;
  padding: 6px 8px; border: 0; background: none; color: inherit; cursor: pointer;
  font: inherit; text-align: left; border-radius: 14px;
}
.fx-agent-main .fx-agent { padding: 8px 10px; }
.fx-agent-face { position: relative; display: inline-flex; flex: none; }
.fx-agent-face .avatar { display: block; }
.fx-presence { position: absolute; right: -1px; bottom: -1px; box-shadow: 0 0 0 2px var(--color-surface); }
.fx-agent-row.is-current .fx-presence { box-shadow: 0 0 0 2px var(--color-bg); }
.fx-agent-text { display: flex; flex-direction: column; min-width: 0; flex: 1; line-height: 1.3; }
.fx-agent-name { font-size: var(--text-14); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-agent-main .fx-agent-name { font-size: var(--text-15, 15px); }
.fx-agent-sub { font-size: var(--text-11-5); color: var(--color-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-agent-count { font-size: var(--text-11); color: var(--color-muted); padding-right: 2px; }
.fx-badge {
  display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px;
  font-size: var(--text-10-5); font-weight: 600; white-space: nowrap;
}
.fx-badge-live { background: var(--color-accent-100); color: var(--color-accent-800); }
.fx-pulse {
  display: inline-block; width: 7px; height: 7px; border-radius: 50%; flex: none;
  background: var(--color-accent); animation: fx-pulse 1.4s ease-in-out infinite;
}
@keyframes fx-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.8); } }
.fx-more { position: relative; flex: none; }
.fx-more > summary { list-style: none; }
.fx-more > summary::-webkit-details-marker { display: none; }
.fx-agent-row .fx-more-btn { width: 28px; height: 28px; margin-right: 4px; opacity: 0; }
.fx-agent-row:hover .fx-more-btn, .fx-agent-row:focus-within .fx-more-btn, .fx-agent-row .fx-more[open] .fx-more-btn { opacity: 1; }
@media (hover: none) { .fx-agent-row .fx-more-btn { opacity: 1; } }
.fx-menu {
  position: absolute; right: 0; top: calc(100% + 4px); z-index: var(--z-menu);
  display: flex; flex-direction: column; min-width: 172px; padding: 6px;
  background: var(--color-bg); color: var(--color-text);
  border-radius: 14px; box-shadow: var(--shadow-lg);
  outline: 1px solid var(--color-divider); outline-offset: -1px;
}
.fx-menu-up { top: auto; bottom: calc(100% + 6px); }
.fx-menu-item {
  display: flex; align-items: center; gap: 9px; width: 100%; padding: 8px 10px;
  border: 0; border-radius: 9px; background: none; color: inherit; cursor: pointer;
  font: inherit; font-size: var(--text-13); text-align: left; text-decoration: none; white-space: nowrap;
}
.fx-menu-item:hover { background: color-mix(in srgb, var(--color-text) 7%, transparent); }
.fx-menu-field { justify-content: space-between; cursor: default; }
.fx-menu-field select {
  border: 0; border-radius: 8px; padding: 4px 6px; font: inherit; font-size: var(--text-12-5);
  background: color-mix(in srgb, var(--color-text) 6%, transparent); color: inherit;
}
.fx-menu-form { margin: 0; }

/* Servers: a folding group of sub-agents. */
.fx-server { border-radius: 14px; }
.fx-server-head {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px; margin-top: 2px;
  border-radius: 10px; cursor: pointer; list-style: none; color: var(--color-quiet); font-size: var(--text-12-5);
}
.fx-server-head::-webkit-details-marker { display: none; }
.fx-server-head:hover { background: color-mix(in srgb, var(--color-text) 5%, transparent); }
.fx-server-name { font-weight: 600; color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-server-meta { margin-left: auto; font-size: var(--text-11); color: var(--color-muted); white-space: nowrap; }
.fx-server-head .chev { transition: transform 150ms ease; }
.fx-server:not([open]) .fx-server-head .chev { transform: rotate(-90deg); }
.fx-server-body { display: flex; flex-direction: column; gap: 1px; padding-left: 10px; margin-left: 9px; border-left: 1px solid var(--color-divider); }

/* Sessions. */
.fx-seg { display: inline-flex; padding: 2px; border-radius: 999px; background: color-mix(in srgb, var(--color-text) 6%, transparent); }
.fx-seg button {
  border: 0; background: none; color: var(--color-muted); cursor: pointer;
  padding: 3px 9px; border-radius: 999px; font: inherit; font-size: var(--text-11);
}
.fx-seg button[aria-pressed="true"] { background: var(--color-bg); color: var(--color-text); box-shadow: var(--shadow-sm); }
.fx-hgroup { display: flex; flex-direction: column; gap: 1px; }
.fx-hgroup-name { margin: 8px 0 2px; padding: 0 10px; font-size: var(--text-11); color: var(--color-muted); }
.fx-hitem {
  display: flex; flex-direction: column; gap: 1px; width: 100%; padding: 7px 10px;
  border: 0; border-radius: 10px; background: none; color: inherit; cursor: pointer;
  font: inherit; text-align: left; transition: background-color 120ms ease;
}
.fx-hitem:hover { background: color-mix(in srgb, var(--color-text) 6%, transparent); }
.fx-hitem.is-active { background: var(--color-bg); box-shadow: var(--shadow-sm); }
.fx-hitem-title { font-size: var(--text-13); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-hitem-meta { display: flex; align-items: center; gap: 6px; font-size: var(--text-11); color: var(--color-muted); }
.fx-hitem-meta .fx-pulse { width: 6px; height: 6px; }
.fx-history:not([data-scope="all"]) .fx-hitem-who { display: none; }
.fx-hitem-who::after { content: "·"; margin-left: 6px; }

.fx-side-foot {
  display: flex; align-items: center; gap: 4px; padding: 8px 2px 2px;
  border-top: 1px solid var(--color-divider);
}
.fx-me { display: inline-flex; align-items: center; gap: 9px; flex: 1; min-width: 0; padding: 2px 4px; }
.fx-me-text { display: flex; flex-direction: column; line-height: 1.2; min-width: 0; }
.fx-me-text b { font-size: var(--text-13); }
.fx-me-text span { font-size: var(--text-11); color: var(--color-muted); }

/* ---- the conversation ---- */
.fx-main { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--color-bg); }
.fx-top {
  display: flex; align-items: center; gap: var(--space-2); min-height: 60px;
  padding: 8px var(--space-4); flex: none;
}
.fx-side-open { display: none; }
.fx[data-side="closed"] .fx-side-open { display: inline-grid; }
.fx-head-mount { flex: 1; min-width: 0; }
.fx-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.fx-head-face { display: inline-flex; padding: 0; border: 0; background: none; border-radius: 12px; flex: none; }
button.fx-head-face, button.fx-welcome-face { cursor: pointer; }
button.fx-head-face:hover, button.fx-welcome-face:hover { background: color-mix(in srgb, var(--color-text) 5%, transparent); }
.fx-head-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.fx-head-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
.fx-head-name { font-size: var(--text-16); font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-head-sub { display: flex; align-items: center; gap: 8px; font-size: var(--text-11-5); color: var(--color-muted); min-width: 0; white-space: nowrap; overflow: hidden; }
.fx-head-sub .state { font-size: var(--text-11-5); }
.fx-model:empty { display: none; }
.fx-model .tag { font-size: var(--text-10-5); }
.fx-tag {
  padding: 1px 8px; border-radius: 999px; font-size: var(--text-10-5); font-weight: 600; white-space: nowrap;
  background: var(--color-accent-100); color: var(--color-accent-800);
}
.fx-tag-quiet { background: color-mix(in srgb, var(--color-text) 7%, transparent); color: var(--color-quiet); }
.fx-info .fx-info-card { width: min(340px, 86vw); padding: 14px; gap: 10px; }
.fx-facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; margin: 0; font-size: var(--text-12-5); }
.fx-facts dt { color: var(--color-muted); }
.fx-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.fx-info-links { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: var(--text-12-5); padding-top: 8px; border-top: 1px solid var(--color-divider); }
.fx-info-links a { color: var(--color-accent-700); text-decoration: none; }
.fx-info-links a:hover { text-decoration: underline; }
.fx-top-tail { display: flex; align-items: center; gap: 4px; flex: none; }
.fx-live { font-size: var(--text-11); color: var(--color-muted); }
.fx-live:empty { display: none; }

.fx-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
.fx-column { width: 100%; max-width: 800px; margin: 0 auto; padding: 0 var(--space-6); box-sizing: border-box; }
.fx-dock { flex: none; position: relative; padding: 4px 0 10px; }
.fx-main.is-welcome .fx-scroll { flex: 1 1 0; display: flex; flex-direction: column; justify-content: flex-end; }
.fx-main.is-welcome .fx-dock { flex: 1 1 0; }
.fx-main.is-welcome .fx-fine { display: none; }

.fx-msgs { display: flex; flex-direction: column; gap: 22px; padding: 18px 0 28px; }
.fx-msg { min-width: 0; }
.fx-msg-user { align-self: flex-end; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; max-width: min(84%, 640px); }
.fx-bubble {
  padding: 10px 16px; border-radius: 20px 20px 6px 20px;
  background: var(--color-accent-100); color: var(--color-text);
  font-size: var(--text-14-5); line-height: 1.65; overflow-wrap: anywhere;
}
.fx-msg-user.is-failed .fx-bubble { outline: 1.5px solid var(--color-accent-300); outline-offset: -1.5px; }
.fx-msg-agent { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 12px; align-items: start; }
.fx-msg-face { display: inline-flex; padding-top: 1px; }
.fx-msg-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.fx-msg-head { display: flex; align-items: baseline; gap: 8px; }
.fx-msg-name { font-size: var(--text-13-5); font-weight: 650; }
.fx-cmd-name { font-size: var(--text-12); color: var(--color-muted); }
.fx-text { font-size: var(--text-14-5); line-height: 1.75; overflow-wrap: anywhere; }
.fx-text code.mono, .fx-bubble code.mono {
  padding: 1px 5px; border-radius: 5px; font-size: 0.88em;
  background: color-mix(in srgb, var(--color-text) 7%, transparent);
}
.fx-text .turn-code, .fx-bubble .turn-code { margin-top: 10px; }
.fx-msg-agent.is-failed .fx-text { color: var(--color-quiet); }
.fx-pre {
  margin: 0; padding: 10px 14px; border-radius: 14px; overflow-x: auto;
  background: color-mix(in srgb, var(--color-text) 5%, transparent);
  font-family: var(--font-mono); font-size: var(--text-12-5); line-height: 1.55;
}
.fx-pre > code { white-space: pre; }
.fx-pre-quiet { margin-top: 6px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--text-12); max-height: 240px; overflow-y: auto; }
.fx-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; font-size: var(--text-11-5); color: var(--color-muted); min-height: 22px; }
.fx-when { font-family: var(--font-mono); font-size: var(--text-11); color: var(--color-muted); }
.fx-id { font-size: var(--text-11); color: var(--color-muted); text-decoration: none; }
a.fx-id:hover { color: var(--color-accent-700); text-decoration: underline; }
.fx-fail { color: var(--color-critical); font-weight: 600; }
.fx-chain { display: inline-flex; gap: 3px; align-items: center; }
.fx-chain i { width: 6px; height: 6px; border-radius: 50%; background: color-mix(in srgb, var(--color-text) 18%, transparent); }
.fx-chain i.on { background: var(--color-accent-2-600); }
.fx-mini {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; margin-left: -4px;
  border: 0; border-radius: 8px; background: none; color: var(--color-muted); cursor: pointer;
  font: inherit; font-size: var(--text-11-5); opacity: 0; transition: opacity 120ms ease, background-color 120ms ease;
}
.fx-msg-agent:hover .fx-mini, .fx-mini:focus-visible { opacity: 1; }
.fx-mini:hover { background: color-mix(in srgb, var(--color-text) 7%, transparent); color: var(--color-text); }
@media (hover: none) { .fx-mini { opacity: 1; } }

/* A step group: one line that unfolds. */
.fx-steps { margin-left: 42px; border-radius: 12px; }
.fx-steps-head {
  display: inline-flex; align-items: center; gap: 8px; max-width: 100%; padding: 5px 10px;
  border-radius: 10px; cursor: pointer; list-style: none; font-size: var(--text-12-5); color: var(--color-quiet);
  background: color-mix(in srgb, var(--color-text) 4%, transparent);
}
.fx-steps-head::-webkit-details-marker { display: none; }
.fx-steps-head:hover { background: color-mix(in srgb, var(--color-text) 7%, transparent); color: var(--color-text); }
.fx-steps-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.fx-steps-head .chev { transition: transform 150ms ease; flex: none; }
.fx-steps[open] .fx-steps-head .chev { transform: rotate(180deg); }
.fx-steps-warn .fx-steps-head { color: var(--color-accent-800); }
.fx-steps-bad .fx-steps-head { color: var(--color-critical); }
.fx-step-list { list-style: none; margin: 8px 0 0 6px; padding: 0 0 0 14px; border-left: 1.5px solid var(--color-divider); display: flex; flex-direction: column; gap: 6px; }
.fx-step { display: grid; grid-template-columns: 10px minmax(0, 1fr); gap: 8px; align-items: start; font-size: var(--text-12-5); }
.fx-step > .dot { margin-top: 6px; }
.fx-step-sub { grid-template-columns: 16px minmax(0, 1fr); margin-left: -3px; }
.fx-step-mark { display: inline-flex; color: var(--color-accent); margin-top: 1px; }
.fx-sub-tag { flex: none; font-size: var(--text-11-5); font-weight: 600; color: var(--color-accent); padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--color-accent) 10%, transparent); }
.fx-sub-who { color: var(--color-text); }
.fx-step-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.fx-step-text { min-width: 0; overflow-wrap: anywhere; color: var(--color-quiet); }
.fx-step-line .fx-when { margin-left: auto; flex: none; }
.fx-step-detail > summary { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; font-size: var(--text-11-5); color: var(--color-muted); list-style: none; }
.fx-step-detail > summary::-webkit-details-marker { display: none; }
.fx-spin {
  width: 12px; height: 12px; border-radius: 50%; flex: none;
  border: 2px solid color-mix(in srgb, var(--color-accent) 30%, transparent); border-top-color: var(--color-accent);
  animation: fx-spin 0.8s linear infinite;
}
@keyframes fx-spin { to { transform: rotate(360deg); } }

.fx-typing { display: inline-flex; align-items: center; gap: 10px; padding: 6px 0; font-size: var(--text-13); color: var(--color-quiet); }
.fx-dots { display: inline-flex; gap: 4px; }
.fx-dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--color-accent); animation: fx-dot 1.2s ease-in-out infinite; }
.fx-dots i:nth-child(2) { animation-delay: 0.15s; }
.fx-dots i:nth-child(3) { animation-delay: 0.3s; }
@keyframes fx-dot { 0%, 80%, 100% { opacity: 0.25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-3px); } }

/* The welcome: the agent, its greeting, the openings. */
.fx-welcome { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; padding: var(--space-6) 0 var(--space-4); }
.fx-welcome-face { display: inline-flex; padding: 4px; border: 0; background: none; border-radius: 28px; }
.fx-welcome-title { margin: 6px 0 0; font-size: var(--text-28); font-weight: 650; letter-spacing: 0.01em; }
.fx-welcome-sub { margin: 0; font-size: var(--text-13); color: var(--color-quiet); }
.fx-welcome-note { margin: 0; font-size: var(--text-12-5); color: var(--color-muted); max-width: 520px; }
.fx-chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 10px; max-width: 640px; }
.fx-chip {
  padding: 8px 14px; border: 0; border-radius: 999px; cursor: pointer;
  background: var(--color-surface); color: var(--color-text); font: inherit; font-size: var(--text-13);
  transition: background-color 120ms ease, transform 120ms ease;
}
.fx-chip:hover { background: color-mix(in srgb, var(--color-surface) 70%, var(--color-accent-200)); }
.fx-chip:active { transform: translateY(1px); }

/* The strip of other conversations still running. */
.fx-stack[hidden] { display: none; }
.fx-stack { margin-bottom: 8px; }
.fx-stack-card { border-radius: 16px; background: var(--color-surface); }
.fx-stack-head {
  display: flex; align-items: center; gap: 8px; padding: 8px 14px; cursor: pointer; list-style: none;
  font-size: var(--text-12-5); font-weight: 600; color: var(--color-quiet);
}
.fx-stack-head::-webkit-details-marker { display: none; }
.fx-stack-label { flex: 1; }
.fx-stack-head .chev { transition: transform 150ms ease; }
.fx-stack-card:not([open]) .fx-stack-head .chev { transform: rotate(-90deg); }
.fx-stack-rows { display: flex; flex-direction: column; padding: 0 6px 6px; }
.fx-stack-row {
  display: grid; grid-template-columns: 22px auto auto minmax(0, 1fr) auto 10px; align-items: center; gap: 8px;
  padding: 6px 8px; border: 0; border-radius: 10px; background: none; color: inherit; cursor: pointer;
  font: inherit; font-size: var(--text-12-5); text-align: left;
}
.fx-stack-row:hover { background: color-mix(in srgb, var(--color-text) 6%, transparent); }
.fx-stack-who { font-weight: 600; }
.fx-stack-node, .fx-stack-when { font-size: var(--text-11); color: var(--color-muted); }
.fx-stack-what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-quiet); }
.fx-stack-more { margin: 2px 8px 0; font-size: var(--text-11); color: var(--color-muted); }

/* The composer. */
.fx-composer {
  position: relative; display: flex; flex-direction: column; gap: 4px;
  padding: 12px 12px 10px 16px; border-radius: 24px;
  background: var(--color-surface); box-shadow: var(--shadow-sm);
  transition: box-shadow 150ms ease;
}
.fx-composer:focus-within { box-shadow: var(--shadow-md), 0 0 0 1.5px var(--color-accent-300); }
.fx-composer textarea {
  width: 100%; min-height: 26px; max-height: 240px; resize: none; border: 0; padding: 2px 0;
  background: none; color: var(--color-text); outline: none;
  font: inherit; font-size: var(--text-15, 15px); line-height: 1.6;
}
.fx-composer textarea::placeholder { color: var(--color-muted); }
.fx-composer textarea:disabled { cursor: not-allowed; }
.fx-composer-foot { display: flex; align-items: center; gap: 10px; }
.fx-target {
  display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px;
  background: var(--color-bg); font-size: var(--text-12); font-weight: 600; max-width: 50%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fx-composer-hint { flex: 1; min-width: 0; font-size: var(--text-11-5); color: var(--color-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-send {
  display: inline-grid; place-items: center; width: 36px; height: 36px; flex: none; margin-left: auto;
  border: 0; border-radius: 50%; cursor: pointer;
  background: var(--color-accent-fill); color: var(--color-bg);
  transition: background-color 120ms ease, transform 120ms ease, opacity 120ms ease;
}
.fx-send:hover:not(:disabled) { background: var(--color-accent-fill-hover); }
.fx-send:active:not(:disabled) { transform: scale(0.94); }
.fx-send:disabled { opacity: 0.35; cursor: not-allowed; }
.fx-composer[aria-busy="true"] .fx-send { opacity: 0.6; }
.fx-status { margin: 0; font-size: var(--text-12); }
.fx-status:empty { display: none; }
.fx-cmds {
  position: absolute; left: 8px; right: 8px; bottom: calc(100% + 8px); z-index: var(--z-menu);
  display: flex; flex-direction: column; padding: 6px; max-height: 280px; overflow-y: auto;
  background: var(--color-bg); border-radius: 16px; box-shadow: var(--shadow-lg);
  outline: 1px solid var(--color-divider); outline-offset: -1px;
}
.fx-cmds[hidden] { display: none; }
.fx-cmd {
  display: flex; align-items: baseline; gap: 12px; padding: 8px 10px; border: 0; border-radius: 10px;
  background: none; color: inherit; cursor: pointer; font: inherit; font-size: var(--text-13); text-align: left;
}
.fx-cmd code { min-width: 104px; font-weight: 600; }
.fx-cmd span { color: var(--color-muted); font-size: var(--text-12); }
.fx-cmd[aria-selected="true"], .fx-cmd:hover { background: color-mix(in srgb, var(--color-text) 7%, transparent); }
.fx-cmd[hidden] { display: none; }
.fx-fine { margin: 8px 0 0; text-align: center; font-size: var(--text-11); color: var(--color-muted); }
.fx-jump {
  position: absolute; left: 50%; top: -44px; transform: translateX(-50%);
  display: inline-grid; place-items: center; width: 34px; height: 34px; border: 0; border-radius: 50%;
  background: var(--color-bg); color: var(--color-text); cursor: pointer; box-shadow: var(--shadow-md);
  outline: 1px solid var(--color-divider);
}
.fx-jump[hidden] { display: none; }
.fx-main > .bar { margin: 0 var(--space-4) var(--space-2); }
.fx-scrim { display: none; }

/* ---- narrow: the side panel is a drawer ---- */
@media (max-width: 900px) {
  .fx, .fx[data-side="closed"] { grid-template-columns: minmax(0, 1fr); }
  .fx-side {
    position: fixed; inset: 0 auto 0 0; z-index: 35; width: min(320px, 86vw);
    visibility: hidden; opacity: 1; transform: translateX(-102%);
    transition: transform 200ms ease, visibility 0s linear 200ms;
    box-shadow: var(--shadow-lg); border-radius: 0 22px 22px 0;
  }
  .fx[data-drawer="open"] .fx-side { visibility: visible; transform: none; transition: transform 200ms ease; }
  .fx[data-side="closed"] .fx-side { opacity: 1; }
  .fx-scrim {
    display: block; position: fixed; inset: 0; z-index: 34; border: 0; padding: 0;
    background: color-mix(in srgb, var(--color-scrim, #2e2b25) 45%, transparent);
    opacity: 0; pointer-events: none; transition: opacity 200ms ease;
  }
  .fx[data-drawer="open"] .fx-scrim { opacity: 1; pointer-events: auto; }
  .fx-side-open, .fx[data-side="closed"] .fx-side-open { display: inline-grid; }
  .fx-top { padding: 8px var(--space-3); min-height: 54px; }
  .fx-column { padding: 0 var(--space-3); }
  .fx-msg-user { max-width: 90%; }
  .fx-steps { margin-left: 0; }
  .fx-welcome-title { font-size: var(--text-22); }
  .fx-live, .fx-composer-hint { display: none; }
  .fx-stack-row { grid-template-columns: 22px auto minmax(0, 1fr) 10px; }
  .fx-stack-node, .fx-stack-when { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .fx, .fx-side, .fx-scrim { transition: none; }
  .fx-pulse, .fx-spin, .fx-dots i { animation: none; }
}
`
