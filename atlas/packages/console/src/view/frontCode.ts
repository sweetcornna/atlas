// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Code — the second mode of the console's main window (`/code`, P37.13,
 * `docs/dev/qmo-local.md` §3.6 and §4.1): work on this computer, with the
 * agents installed on it.
 *
 * The sessions themselves are P37.14's (the local node); this is the face
 * they will live in. Its side list has 新代码会话 and the code sessions, of
 * which there are none yet. Its page, inside the desktop app, lists the
 * agents the app found on this computer (the shell's `qmo_local_agents`,
 * which runs `qmo agents --json`; `assets/codeClient.ts` asks and draws) and
 * the shape of a new session — a folder and an agent — with 开始 held shut
 * and the one word why. In a browser, and in an app too old to have the
 * command, it says Code is the desktop app's, and nothing else: no download
 * link.
 *
 * What the server cannot know is whether the page has the app around it;
 * the app's cookie (`preferences.ts`, `qianmo_shell`) is the best guess, so
 * the first paint draws the panel for it and the line for a browser, and the
 * page script settles it.
 */

import { chevron, icon } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import type { FrontText } from './frontText.js'

/** The side list's rows and list under Work | Code. */
export function codeSide(t: FrontText): string {
  return (
    `<div class="fx-side-rows">` +
    `<button type="button" class="fx-row fx-code-new" id="code-new" data-action="code-new">` +
    `${icon('square-pen', { small: true })}<span class="fx-row-word">${escapeHtml(t.newCodeSession)}</span></button>` +
    `</div>` +
    `<div class="fx-list-head"><span class="fx-list-title">${escapeHtml(t.codeSessions)}</span></div>` +
    `<div class="fx-side-scroll" id="fx-side-scroll">` +
    `<section class="fx-code-sessions" id="code-sessions" aria-label="${attr(t.codeSessions)}">` +
    `<p class="fx-none">${escapeHtml(t.noCodeSessions)}</p></section></div>`
  )
}

/** The page: the local agents and a new session's shape, or the browser's one line. */
export function codeMain(t: FrontText, desktop: boolean): string {
  return (
    `<div class="fx-scroll" id="fx-scroll"><div class="fx-column fx-code-column">` +
    `<p class="fx-code-web" id="code-web"${desktop ? ' hidden' : ''}>${escapeHtml(t.codeInApp)}</p>` +
    `<section class="fx-code-local" id="code-local" aria-labelledby="code-local-title"${desktop ? '' : ' hidden'}>` +
    `<div class="fx-code-head"><h2 id="code-local-title">${escapeHtml(t.localAgents)}</h2>` +
    `<button type="button" class="btn btn-secondary btn-small" id="code-rescan" data-action="code-rescan">` +
    `${escapeHtml(t.rescan)}</button></div>` +
    `<p class="fx-code-state" id="code-state" role="status"></p>` +
    `<ul class="fx-code-agents" id="code-agents"></ul>` +
    `<form class="fx-code-start" id="code-start" novalidate>` +
    `<label class="fx-code-field"><span>${escapeHtml(t.folder)}</span>` +
    `<input class="input" id="code-folder" placeholder="${attr(t.pickFolder)}" readonly></label>` +
    `<label class="fx-code-field"><span>${escapeHtml(t.agentWord)}</span>` +
    `<span class="sel"><select class="input" id="code-agent" disabled></select>${chevron()}</span></label>` +
    `<div class="fx-code-go"><button type="submit" class="btn btn-primary" id="code-go" disabled>` +
    `${escapeHtml(t.startSession)}</button>` +
    `<span class="fx-code-closed">${escapeHtml(t.localClosed)}</span></div>` +
    `</form></section>` +
    `</div></div>`
  )
}
