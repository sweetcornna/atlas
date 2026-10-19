// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two pickers under the composer's line, the way Claude Desktop has them:
 * 模型 and 权限模式. Drawn here; `assets/frontTools.ts` opens them and does
 * what a pick asks.
 *
 * ## 模型
 *
 * A pick is one of the conversation's own local commands (P18.20), sent as a
 * line: `/model <provider>/<id>`, `/model auto`, `/effort <level>`. The node
 * runs it on this conversation's session and answers in the transcript, so a
 * switch is visible where it happened and nothing new is trusted. The list
 * of models is the target node's own, from the model service's chat fragment
 * (`providersForm.ts`, `#prov-chat-models`); with no model service the menu
 * offers 推理强度 alone.
 *
 * ## 权限模式
 *
 * The four modes of P39 (`/v0/elevation`): 人工确认 is `off`; the other three
 * open a mode on the agent for the node's default time and number of calls.
 * Only an operator who signed in within half an hour may open one; anyone
 * may read which is on. 跳过权限确认 asks first. Where the hub has no such
 * port the picker says 未接入 and stays at 人工确认.
 */

import { chevron, icon } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import type { FrontText } from './frontText.js'
import { dialogActions, dialogTop } from './kit.js'

/** `/effort` levels, in the order the menu lists them. */
const EFFORT_LEVELS = [
  'inherit',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

/** P39 modes, as `/v0/elevation` names them. */
const PERMISSION_TIERS = ['off', 'accept-edits', 'auto', 'full-access'] as const

function pickButton(
  id: string,
  menu: string,
  label: string,
  inner: string,
  enabled: boolean,
): string {
  return (
    `<button type="button" class="fx-pick-btn" id="${attr(id)}" aria-haspopup="menu" ` +
    `aria-expanded="false" aria-controls="${attr(menu)}" title="${attr(label)}"${enabled ? '' : ' disabled'}>` +
    `${inner}${chevron()}</button>`
  )
}

/** 模型: the target's models (filled in by the page), 自动, 推理强度. */
function modelPicker(t: FrontText, admin: boolean, enabled: boolean): string {
  const levels = EFFORT_LEVELS.map(
    level =>
      `<button type="button" class="fx-pick-item" role="menuitemradio" aria-checked="false" ` +
      `data-effort="${level}">${icon('check', { small: true })}` +
      `<span>${escapeHtml(t.effortLevels[level])}</span></button>`,
  ).join('')
  return (
    `<div class="fx-pick" id="fx-model-pick"><span id="fx-model-data" hidden></span>` +
    pickButton(
      'fx-model-btn',
      'fx-model-menu',
      t.model,
      `<span class="fx-model" id="fx-model"></span>` +
        `<span class="fx-pick-word">${escapeHtml(t.model)}</span>`,
      enabled,
    ) +
    `<div class="fx-menu fx-pick-menu" id="fx-model-menu" role="menu" aria-label="${attr(t.model)}" hidden>` +
    `<div class="fx-pick-group" id="fx-model-group" role="group" aria-label="${attr(t.model)}" hidden>` +
    `<p class="fx-pick-head">${escapeHtml(t.model)}</p>` +
    `<div id="fx-model-list"></div>` +
    `<button type="button" class="fx-pick-item" role="menuitem" data-model-auto>` +
    `${icon('sparkles', { small: true })}<span>${escapeHtml(t.modelAuto)}</span>` +
    `<small>${escapeHtml(t.modelAutoNote)}</small></button></div>` +
    `<div class="fx-pick-group" role="group" aria-label="${attr(t.effort)}">` +
    `<p class="fx-pick-head">${escapeHtml(t.effort)}</p>${levels}</div>` +
    (admin
      ? `<a class="fx-pick-link" href="/admin/providers">${escapeHtml(t.modelSettings)}</a>`
      : '') +
    `</div></div>`
  )
}

/** 权限模式: the four modes; the page reads which is on. */
function permissionPicker(
  t: FrontText,
  ops: boolean,
  enabled: boolean,
): string {
  const items = PERMISSION_TIERS.map(
    tier =>
      `<button type="button" class="fx-pick-item fx-perm-item${
        tier === 'full-access' ? ' is-danger' : ''
      }" role="menuitemradio" aria-checked="${tier === 'off'}" data-perm="${tier}" disabled>` +
      `${icon('check', { small: true })}<span>${escapeHtml(t.permModes[tier])}</span>` +
      `<small>${escapeHtml(t.permNotes[tier])}</small></button>`,
  ).join('')
  return (
    `<div class="fx-pick" id="fx-perm-pick" data-tier="off"${ops ? ' data-ops="1"' : ''}>` +
    pickButton(
      'fx-perm-btn',
      'fx-perm-menu',
      t.permission,
      `${icon('shield', { small: true })}<span class="fx-perm-word" id="fx-perm-word">${escapeHtml(
        t.permModes.off,
      )}</span>`,
      enabled,
    ) +
    `<div class="fx-menu fx-pick-menu fx-perm-menu" id="fx-perm-menu" role="menu" aria-label="${attr(t.permission)}" hidden>` +
    `<p class="fx-pick-head">${escapeHtml(t.permission)}</p>${items}` +
    `<p class="fx-pick-note" id="fx-perm-note" data-defaults="${attr(t.permDefaults)}">` +
    `${escapeHtml(ops ? t.permDefaults : '')}</p>` +
    `</div></div>`
  )
}

/** The row under the composer's line: + on the left, the pickers on the right. */
export function composerPickers(
  t: FrontText,
  admin: boolean,
  enabled: boolean,
): string {
  return (
    `<span class="fx-tools-gap"></span>` +
    modelPicker(t, admin, enabled) +
    permissionPicker(t, admin, enabled)
  )
}

/** 跳过权限确认 asks first: what it lets through, and until when. */
export function permissionConfirm(t: FrontText): string {
  return (
    `<dialog class="dialog" id="fx-perm-confirm" aria-labelledby="fx-perm-confirm-title">` +
    dialogTop('fx-perm-confirm-title', 'shield', t.bypassTitle) +
    `<div class="dialog-body"><p>${escapeHtml(t.bypassBody)}</p></div>` +
    dialogActions(t.bypassConfirm, {
      danger: true,
      action: 'confirm-fx-perm',
      cancel: t.cancel,
    }) +
    `</dialog>`
  )
}

/** The pickers' own rules, after the front's sheet. */
export const FRONT_TOOLS_CSS = `
/* ---- composer pickers (view/frontTools.ts) ---- */
/* The line on top, the row of controls under it. */
.fx-composer { display: flex; flex-direction: column; align-items: stretch; gap: 2px; padding: 8px 8px 6px; border-radius: 20px; }
.fx-composer textarea { padding: 4px 8px; }
.fx-tools { display: flex; align-items: center; gap: 2px; min-width: 0; }
.fx-composer .fx-tools .fx-icon-btn, .fx-composer .fx-send { width: 30px; height: 30px; }
.fx-tools-gap { flex: 1 1 auto; }
.fx-pick { position: relative; flex: none; }
.fx-pick-btn {
  display: inline-flex; align-items: center; gap: 4px; height: 28px; max-width: 220px; padding: 0 6px 0 8px;
  border: 0; border-radius: 8px; background: none; color: var(--color-quiet); cursor: pointer;
  font: inherit; font-size: var(--text-12);
}
.fx-pick-btn:hover:not(:disabled), .fx-pick-btn[aria-expanded="true"] { background: var(--fx-hover); color: var(--color-text); }
.fx-pick-btn:disabled { opacity: .5; cursor: not-allowed; }
.fx-pick-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; }
.fx-pick-btn .chev { width: 12px; height: 12px; color: var(--color-muted); }
.fx-pick-btn .i-sm { width: 14px; height: 14px; }
.fx-model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-model .tag { all: unset; font-family: var(--font-mono); font-size: var(--text-12); }
.fx-model:not(:empty) + .fx-pick-word { display: none; }
.fx-pick[data-tier="full-access"] .fx-pick-btn { color: var(--color-danger-text); }
.fx-pick[data-tier="auto"] .fx-pick-btn, .fx-pick[data-tier="accept-edits"] .fx-pick-btn { color: var(--color-warning-text); }
.fx-pick-menu {
  position: absolute; right: 0; top: auto; bottom: calc(100% + 8px); z-index: var(--z-menu);
  display: flex; flex-direction: column; gap: 1px; width: 280px; max-height: 420px; overflow-y: auto; padding: 6px;
  background: var(--fx-composer); border-radius: 12px; box-shadow: var(--shadow-lg);
}
.fx-pick-menu[hidden] { display: none; }
.fx-pick-group { display: flex; flex-direction: column; gap: 1px; }
.fx-pick-group:not([hidden]) + .fx-pick-group { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--color-divider); }
.fx-pick-head { margin: 4px 8px 2px; font-size: var(--text-11); color: var(--color-muted); }
.fx-pick-item {
  display: grid; grid-template-columns: 16px minmax(0, 1fr); align-items: center; column-gap: 8px;
  padding: 6px 8px; border: 0; border-radius: 8px; background: none; color: var(--color-text); cursor: pointer;
  font: inherit; font-size: var(--text-13); text-align: left;
}
.fx-pick-item > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-pick-item small { grid-column: 2; font-size: var(--text-11); color: var(--color-muted); white-space: normal; }
.fx-pick-item .i-sm { width: 14px; height: 14px; visibility: hidden; }
.fx-pick-item[aria-checked="true"] .i-sm, .fx-pick-item[data-model-auto] .i-sm { visibility: visible; }
.fx-pick-item[aria-checked="true"] .i-sm { color: var(--color-interactive); }
.fx-pick-item:hover:not(:disabled), .fx-pick-item:focus-visible { background: var(--fx-hover); outline: none; }
.fx-pick-item:disabled { cursor: default; color: var(--color-muted); }
.fx-pick-item.is-danger > span { color: var(--color-danger-text); }
.fx-pick-item.is-danger:disabled > span { color: var(--color-muted); }
.fx-pick-note { margin: 4px 8px 2px; font-size: var(--text-11); color: var(--color-muted); }
.fx-pick-note:empty { display: none; }
.fx-pick-link { margin: 4px 0 0; padding: 6px 8px; border-top: 1px solid var(--color-divider); font-size: var(--text-12); color: var(--color-interactive-text); text-decoration: none; }
.fx-pick-link:hover { text-decoration: underline; }
@media (max-width: 600px) {
  .fx-pick-btn { max-width: 132px; }
  .fx-pick-menu { position: fixed; left: 8px; right: 8px; bottom: 88px; width: auto; }
}
`
