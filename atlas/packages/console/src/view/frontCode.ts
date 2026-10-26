// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Code — the second mode of the console's main window (`/code`, P37.13,
 * P37.14a and P37.14d, `docs/dev/qmo-local.md` §3.6, §4.1 and §4.5): work on
 * this computer, with the agents installed on it.
 *
 * Local sessions live on this computer, run by the desktop app's runner; the
 * hub never sees them. So the server draws only empty frames — the side
 * list's container and the line a deleted session can come back from, the
 * box a session starts from and continues in (folder, agent, permission
 * mode, a worktree of its own, Remote, send and stop), the transcript's
 * container, the changes panel's — and the page scripts fill them through
 * the shell (`assets/codeClient.ts`, `assets/codeRender.ts`,
 * `assets/codeManage.ts`). The icons the
 * script needs are the server's own SVG in a `<template>`, cloned, never
 * parsed from a string.
 *
 * In a browser, and in an app too old for local sessions, it says Code is
 * the desktop app's (or that the app wants updating), and nothing else: no
 * download link. What the server cannot know is whether the page has the app
 * around it; the app's cookie (`preferences.ts`, `qianmo_shell`) is the best
 * guess, so the first paint draws the box for it and the line for a browser,
 * and the page script settles it.
 *
 * On a hub with Remote (P37.15) a personal account's page also carries
 * `data-remote="1"` and `CODE_HUB_JS` (`assets/codeHub.ts`): the browser
 * draws the copies of the account's sessions on its other computers in the
 * same frames, and so does a desktop app beside its own sessions.
 */

import type { Lang } from '../i18n.js'
import { chevron, icon } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import {
  CODE_REMOTE_TEXT,
  codeClientText,
  type FrontText,
} from './frontText.js'

/** The four permission modes, in the order the menu lists them (§4.4). */
const MODES = ['off', 'accept-edits', 'auto', 'full-access'] as const

/** A new session's mode until the person picks another (§4.4). */
const DEFAULT_MODE = 'auto'

/** Longest line the runner takes (`qmo-local.md` §4.5.1). */
const MAX_LINE = 65_536

/** The side list's rows and list under Work | Code. */
export function codeSide(t: FrontText): string {
  return (
    `<div class="fx-side-rows">` +
    `<button type="button" class="fx-row fx-code-new" id="code-new" data-action="code-new">` +
    `${icon('square-pen', { small: true })}<span class="fx-row-word">${escapeHtml(t.newCodeSession)}</span></button>` +
    `</div>` +
    `<div class="fx-list-head"><span class="fx-list-title">${escapeHtml(t.codeSessions)}</span></div>` +
    `<div class="fx-side-scroll" id="fx-side-scroll">` +
    `<section class="fx-recents fx-code-sessions" id="code-sessions" aria-label="${attr(t.codeSessions)}">` +
    `<p class="fx-none">${escapeHtml(t.noCodeSessions)}</p></section></div>` +
    `<div class="fx-code-undo" id="code-undo" role="status" hidden><span class="fx-code-undo-word"></span>` +
    `<button type="button" class="btn btn-ghost btn-small" data-action="code-undo">${escapeHtml(t.undo)}</button></div>`
  )
}

/** The bar's head over an open session: its title, and folder · agent. */
export function codeHead(): string {
  return (
    `<div class="fx-head fx-code-head" id="code-head" hidden>` +
    `<span class="fx-head-name" id="code-title"></span>` +
    `<span class="fx-head-sub" id="code-sub"></span></div>`
  )
}

/**
 * Over an open session, Remote (P37.15): on this computer's own session the
 * switch and the link's state; on a copy from another computer whose Remote
 * is off, 「从中枢删除副本」. The page script shows what applies.
 */
function remoteTail(lang: Lang): string {
  const r = CODE_REMOTE_TEXT[lang]
  return (
    `<span class="fx-code-link" id="code-link" role="status" hidden></span>` +
    `<label class="sw fx-code-remote-head" id="code-remote-head" title="${attr(r.remoteHint)}" hidden>` +
    `<input type="checkbox" role="switch" id="code-remote-on"><span class="trk"></span><span>Remote</span></label>` +
    `<button type="button" class="btn btn-ghost btn-small" id="code-drop" data-action="code-drop" hidden>` +
    `${escapeHtml(r.drop)}</button>`
  )
}

/** The bar's button for the changes panel, over an open session. */
export function codeTail(t: FrontText, lang: Lang): string {
  return (
    remoteTail(lang) +
    `<button type="button" class="fx-icon-btn fx-code-toggle" id="code-changes-btn" data-action="code-changes" ` +
    `aria-label="${attr(t.changes)}" aria-controls="code-changes" aria-pressed="false" hidden>` +
    `${icon('git-branch', { small: true })}</button>`
  )
}

/** The icons the page script clones (`assets/codeRender.ts`). */
function icons(): string {
  const one = (name: string, svg: string): string =>
    `<i data-i="${attr(name)}">${svg}</i>`
  return (
    `<template id="code-icons">` +
    [
      'check',
      'x',
      'alert-triangle',
      'list-checks',
      'copy',
      'ellipsis',
      'pencil',
      'trash-2',
    ]
      .map(name => one(name, icon(name, { small: true })))
      .join('') +
    one('chev', chevron()) +
    `</template>`
  )
}

function box(t: FrontText): string {
  const modes = MODES.map(
    mode =>
      `<option value="${attr(mode)}"${mode === DEFAULT_MODE ? ' selected' : ''}>${escapeHtml(t.permModes[mode])}</option>`,
  ).join('')
  return (
    `<form class="fx-composer fx-code-box" id="code-box" novalidate>` +
    `<label class="sr-only" for="code-text">${escapeHtml(t.message)}</label>` +
    `<textarea id="code-text" rows="1" spellcheck="false" maxlength="${attr(String(MAX_LINE))}" ` +
    `aria-describedby="code-say" placeholder="${attr(t.codeFirst)}" ` +
    `data-first="${attr(t.codeFirst)}" data-reply="${attr(t.codeReply)}"></textarea>` +
    `<div class="fx-code-tools">` +
    `<span class="sel fx-code-pill fx-code-blank-only"><select id="code-folder" aria-label="${attr(t.folder)}"></select>${chevron()}</span>` +
    `<span class="sel fx-code-pill fx-code-blank-only"><select id="code-agent" aria-label="${attr(t.agentWord)}"></select>${chevron()}</span>` +
    `<button type="button" class="fx-icon-btn fx-code-blank-only" id="code-rescan" data-action="code-rescan" ` +
    `aria-label="${attr(t.rescan)}" title="${attr(t.rescan)}">${icon('refresh-cw', { small: true })}</button>` +
    `<span class="sel fx-code-pill"><select id="code-mode" aria-label="${attr(t.permission)}">${modes}</select>${chevron()}</span>` +
    `<span class="fx-code-gap"></span>` +
    `<label class="sw fx-code-remote fx-code-blank-only" title="${attr(t.worktreeHint)}">` +
    `<input type="checkbox" role="switch" id="code-worktree" aria-describedby="code-wt-hint" disabled>` +
    `<span class="trk"></span><span>${escapeHtml(t.worktree)}</span></label>` +
    `<label class="sw fx-code-remote fx-code-blank-only" title="${attr(t.remoteLater)}">` +
    `<input type="checkbox" role="switch" id="code-remote" disabled><span class="trk"></span><span>Remote</span></label>` +
    `<button type="button" class="fx-send fx-code-stop" id="code-stop" data-action="code-stop" aria-label="${attr(t.stop)}" hidden>` +
    `${icon('square', { small: true })}</button>` +
    `<button type="submit" class="fx-send" id="code-go" aria-label="${attr(t.send)}">${icon('arrow-up', { small: true })}</button>` +
    `</div>` +
    `<p class="fx-status" id="code-say" role="status"></p>` +
    `<p class="fx-code-hint fx-code-blank-only" id="code-wt-hint" hidden>${escapeHtml(t.worktreeHint)}</p>` +
    `</form>` +
    `<p class="fx-code-confirm" id="code-bypass" role="alert" hidden>` +
    `<span>${escapeHtml(t.bypassLine)}</span>` +
    `<button type="button" class="btn btn-small btn-danger" data-action="code-bypass-ok">${escapeHtml(t.confirm)}</button>` +
    `<button type="button" class="btn btn-ghost btn-small" data-action="code-bypass-no">${escapeHtml(t.cancel)}</button></p>`
  )
}

function changesPanel(t: FrontText): string {
  return (
    `<aside class="fx-code-changes" id="code-changes" aria-labelledby="code-changes-title" hidden>` +
    `<header class="fx-code-changes-head"><h2 id="code-changes-title">${escapeHtml(t.changes)}</h2>` +
    `<span class="fx-code-count" id="code-count"></span>` +
    `<button type="button" class="fx-icon-btn" data-action="code-refresh" aria-label="${attr(t.refresh)}" title="${attr(t.refresh)}">` +
    `${icon('refresh-cw', { small: true })}</button>` +
    `<button type="button" class="fx-icon-btn fx-code-shut" data-action="code-changes" aria-label="${attr(t.close)}">` +
    `${icon('x', { small: true })}</button></header>` +
    `<p class="fx-code-note" id="code-note" role="status"></p>` +
    `<ul class="fx-code-files" id="code-files"></ul></aside>`
  )
}

/**
 * The page: in the desktop app the box a session starts from, the
 * transcript and the changes panel, all empty until the page script fills
 * them; in a browser the one line.
 */
export function codeMain(
  t: FrontText,
  lang: Lang,
  desktop: boolean,
  remote = false,
): string {
  return (
    `<p class="fx-code-web" id="code-web"${desktop ? ' hidden' : ''}>${escapeHtml(t.codeInApp)}</p>` +
    `<div class="fx-code-local" id="code-local" data-view="blank" data-text="${attr(codeClientText(lang))}"` +
    `${remote ? ' data-remote="1"' : ''}${desktop ? '' : ' hidden'}>` +
    `<div class="fx-code-chat">` +
    `<div class="fx-scroll" id="code-scroll"><div class="fx-column"><div class="fx-msgs" id="code-msgs"></div></div></div>` +
    `<div class="fx-dock"><div class="fx-column">${box(t)}</div></div>` +
    `</div>` +
    changesPanel(t) +
    icons() +
    `</div>`
  )
}
