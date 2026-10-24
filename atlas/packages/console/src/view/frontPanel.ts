// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The session panel on the front's right (the bar's panel button), the way
 * Claude Desktop keeps what runs beside the conversation.
 *
 * - **后台任务** (P29): the reader's background tasks, the ones that need
 *   them or run first. Each row is a status dot, the title, how long it has
 *   run, and 停止 while it can be stopped; unfolded, what was asked, the
 *   latest report or error, and the worker's own conversation. Finished ones
 *   fold under N 个已完成. The same port and the same ownership rule as the
 *   主动执行 page (`routes/tasksApi.ts`); stopping is the same
 *   `POST /v0/tasks/<id>/cancel`.
 * - **云端电脑** (P21): a way to the agents' browsers and computers, where
 *   the hub has them.
 *
 * Rendered as the fragment `/fragments/chat/front/panel`; the front's panel
 * script (`assets/frontPanel.ts`) fetches it while the panel is open.
 */

import type {
  BackgroundTaskStatus,
  BackgroundTaskView,
} from '../directionPorts.js'
import { chevron, icon } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatShortDuration } from './format.js'
import { FRONT_NARROW_PX } from './frontStyle.js'
import type { FrontText } from './frontText.js'

interface FrontPanelModel {
  /** `null` when the hub has no background tasks. */
  readonly tasks: readonly BackgroundTaskView[] | null
  /** May this reader stop a task (a member; the port still checks ownership). */
  readonly stop: boolean
  /** Where 云端电脑 is, when the hub has it. */
  readonly desktop: string | null
  readonly now: number
  readonly t: FrontText
}

type Tone = 'attention' | 'running' | 'queued' | 'done' | 'failed' | 'quiet'

const TONE: Readonly<Record<BackgroundTaskStatus, Tone>> = {
  needs_input: 'attention',
  running: 'running',
  completion_pending: 'running',
  needs_input_pending: 'running',
  queued: 'queued',
  scheduled: 'queued',
  completed: 'done',
  interrupted: 'failed',
  cancelled: 'quiet',
}

/** Waiting for the reader first, then running, queued, and the rest. */
const ORDER: readonly Tone[] = [
  'attention',
  'running',
  'queued',
  'failed',
  'done',
  'quiet',
]

const FINISHED: ReadonlySet<Tone> = new Set(['done', 'quiet'])

function elapsed(task: BackgroundTaskView, now: number): number {
  const end = FINISHED.has(TONE[task.status]) ? task.updatedAt : now
  return Math.max(0, end - task.createdAt)
}

function taskRow(
  task: BackgroundTaskView,
  model: FrontPanelModel,
  key: string,
): string {
  const t = model.t
  const tone = TONE[task.status]
  const word = t.taskStatus[task.status]
  const live = !FINISHED.has(tone) && tone !== 'failed'
  const stop =
    model.stop && live
      ? `<button type="button" class="fx-task-stop" data-task-stop="${attr(task.id)}" ` +
        `aria-label="${attr(`${t.stop} · ${task.title}`)}">${icon('square', { small: true })}</button>`
      : ''
  const result =
    task.lastError !== ''
      ? `<dt>${escapeHtml(t.taskError)}</dt><dd class="fx-task-err">${escapeHtml(task.lastError)}</dd>`
      : task.progress !== ''
        ? `<dt>${escapeHtml(tone === 'done' ? t.taskResult : t.taskProgress)}</dt><dd>${escapeHtml(task.progress)}</dd>`
        : ''
  const worker =
    task.workerSession === null
      ? ''
      : `<a class="fx-task-open" href="/?session=${encodeURIComponent(task.workerSession)}">` +
        `${escapeHtml(t.openWorker)}</a>`
  return (
    `<details class="fx-task fx-task-${tone}" data-key="${attr(key)}">` +
    `<summary class="fx-task-head">` +
    `<span class="fx-task-dot" aria-hidden="true"></span>` +
    `<span class="fx-task-title">${escapeHtml(task.title)}</span>` +
    `<span class="fx-task-time" title="${attr(word)}">${escapeHtml(
      formatShortDuration(elapsed(task, model.now)),
    )}</span>` +
    `<span class="sr-only">${escapeHtml(word)}</span>` +
    `${stop}${chevron()}</summary>` +
    `<dl class="fx-task-facts">` +
    `<dt>${escapeHtml(t.taskState)}</dt><dd>${escapeHtml(task.phase || word)}</dd>` +
    `<dt>${escapeHtml(t.taskAsk)}</dt><dd>${escapeHtml(task.title)}</dd>` +
    result +
    `</dl>${worker}</details>`
  )
}

function tasksSection(model: FrontPanelModel): string {
  const t = model.t
  const tasks = model.tasks
  if (tasks === null) return ''
  const sorted = [...tasks].sort(
    (a, b) =>
      ORDER.indexOf(TONE[a.status]) - ORDER.indexOf(TONE[b.status]) ||
      b.updatedAt - a.updatedAt,
  )
  const open = sorted.filter(task => !FINISHED.has(TONE[task.status]))
  const done = sorted.filter(task => FINISHED.has(TONE[task.status]))
  const running = tasks.filter(task => TONE[task.status] === 'running').length
  const waiting = tasks.filter(task => TONE[task.status] === 'attention').length
  const count =
    waiting > 0
      ? t.tasksWaiting(waiting)
      : running > 0
        ? t.tasksRunning(running)
        : ''
  const body =
    tasks.length === 0
      ? `<p class="fx-panel-empty">${escapeHtml(t.tasksEmpty)}</p>`
      : open.map(task => taskRow(task, model, `task:${task.id}`)).join('') +
        (done.length === 0
          ? ''
          : `<details class="fx-tasks-finished" data-key="tasks:done">` +
            `<summary class="fx-panel-more">${escapeHtml(t.tasksDone(done.length))}${chevron()}</summary>` +
            done.map(task => taskRow(task, model, `task:${task.id}`)).join('') +
            `</details>`)
  return (
    `<section class="fx-panel-sec" aria-labelledby="fx-panel-tasks-title" ` +
    `data-open-tasks="${open.length}">` +
    `<div class="fx-panel-head"><h2 class="fx-panel-title" id="fx-panel-tasks-title">${escapeHtml(t.backgroundTasks)}</h2>` +
    (count === ''
      ? ''
      : `<span class="fx-panel-count${waiting > 0 ? ' is-attention' : ''}">${escapeHtml(count)}</span>`) +
    `</div>${body}</section>`
  )
}

function desktopSection(model: FrontPanelModel): string {
  if (model.desktop === null) return ''
  const t = model.t
  return (
    `<section class="fx-panel-sec" aria-labelledby="fx-panel-desktop-title">` +
    `<div class="fx-panel-head"><h2 class="fx-panel-title" id="fx-panel-desktop-title">${escapeHtml(t.cloudComputer)}</h2></div>` +
    `<a class="fx-panel-link" href="${attr(model.desktop)}">${icon('monitor', { small: true })}` +
    `<span>${escapeHtml(t.cloudComputerNote)}</span>${icon('arrow-right', { small: true })}</a>` +
    `</section>`
  )
}

/** The panel's body: the one mount the script swaps (`#fx-panel-body`). */
export function renderFrontPanel(model: FrontPanelModel): string {
  const sections = tasksSection(model) + desktopSection(model)
  return (
    `<div class="fx-panel-body" id="fx-panel-body">` +
    (sections === ''
      ? `<p class="fx-panel-empty">${escapeHtml(model.t.panelEmpty)}</p>`
      : sections) +
    `</div>`
  )
}

/** The panel's frame, empty until the script fetches its body. */
export function frontPanelFrame(t: FrontText): string {
  return (
    `<aside class="fx-panel" id="fx-panel" aria-labelledby="fx-panel-name" hidden>` +
    `<div class="fx-panel-top"><b class="fx-panel-name" id="fx-panel-name">${escapeHtml(t.sessionPanel)}</b>` +
    `<button type="button" class="fx-icon-btn" data-action="fx-panel" aria-label="${attr(t.closePanel)}" aria-controls="fx-panel">` +
    `${icon('x', { small: true })}</button></div>` +
    `<div class="fx-panel-body" id="fx-panel-body"></div>` +
    `</aside>`
  )
}

/**
 * The bar's button that opens and closes the panel, and beside it the
 * computer's status (Grok Bot's title-bar mark, `qmo-app.md` §4.2): a dot in
 * the reader's 主题色 while the conversation on screen has its agent working
 * a computer or a browser. The page lights it from the live line
 * (`assets/frontClient.ts`); the panel it opens leads to 云端电脑.
 */
export function frontPanelToggle(t: FrontText): string {
  return (
    `<button type="button" class="fx-icon-btn fx-computer" id="fx-computer" data-action="fx-panel" ` +
    `aria-controls="fx-panel" aria-label="${attr(t.computerInUse)}" title="${attr(t.computerInUse)}" hidden>` +
    `${icon('monitor', { small: true })}</button>` +
    `<button type="button" class="fx-icon-btn fx-panel-toggle" id="fx-panel-toggle" data-action="fx-panel" ` +
    `aria-label="${attr(t.sessionPanel)}" aria-controls="fx-panel" aria-expanded="false">` +
    `${icon('panel-right', { small: true })}<span class="fx-panel-badge" id="fx-panel-badge" hidden></span></button>`
  )
}

/** The panel's own rules, after the front's sheet. */
export const FRONT_PANEL_CSS = `
/* ---- session panel (view/frontPanel.ts) ---- */
.fx { --fx-panel-w: 300px; }
.fx[data-panel="open"] { grid-template-columns: var(--side-w) minmax(0, 1fr) var(--fx-panel-w); }
.fx[data-panel="open"][data-side="closed"] { grid-template-columns: 0 minmax(0, 1fr) var(--fx-panel-w); }
.fx-panel {
  display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden;
  background: var(--color-side); border-left: var(--hairline);
}
.fx-panel-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: var(--top-h); padding: 0 10px 0 16px; flex: none; box-sizing: border-box; }
.fx-panel-name { font-size: var(--text-ui); font-weight: var(--weight-semibold); }
.fx-panel-body { flex: 1 1 auto; overflow-y: auto; padding: 0 8px 16px; display: flex; flex-direction: column; gap: 16px; }
.fx-panel-sec { display: flex; flex-direction: column; gap: 2px; }
.fx-panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 0 8px 4px; }
.fx-panel-title { margin: 0; font-size: var(--text-small); font-weight: 600; color: var(--color-quiet); }
.fx-panel-count { font-size: var(--text-small); color: var(--color-muted); }
.fx-panel-count.is-attention { color: var(--color-warning-text); font-weight: 600; }
.fx-panel-empty { margin: 0; padding: 4px 8px; font-size: var(--text-small); color: var(--color-muted); }
.fx-task { border-radius: var(--radius-control); }
.fx-task[open] { background: var(--fx-hover); }
.fx-task-head {
  display: flex; align-items: center; gap: 8px;
  min-height: var(--control-h); padding: 4px 8px; border-radius: var(--radius-control); cursor: pointer; list-style: none; font-size: var(--text-ui);
}
.fx-task-head::-webkit-details-marker { display: none; }
.fx-task-head:hover { background: var(--fx-hover); }
.fx-task-head:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
.fx-task-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-task-time { font-family: var(--font-mono); font-size: var(--text-small); color: var(--color-muted); }
.fx-task-head .chev { flex: none; width: 12px; height: 12px; color: var(--color-muted); transition: transform var(--motion-base) var(--ease-out); }
.fx-task[open] > .fx-task-head .chev { transform: rotate(180deg); }
.fx-task-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--color-neutral-400); }
.fx-task-attention .fx-task-dot { background: var(--color-warning-fill); }
.fx-task-running .fx-task-dot { background: var(--color-neutral-500); animation: fx-pulse 1.6s ease-in-out infinite; }
.fx-task-queued .fx-task-dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--color-neutral-500); }
.fx-task-done .fx-task-dot { background: var(--color-success-fill); }
.fx-task-failed .fx-task-dot { background: var(--color-danger-fill); }
.fx-task-quiet .fx-task-dot { background: var(--color-neutral-300); }
.fx-task-stop {
  display: inline-grid; place-items: center; flex: none; width: 22px; height: 22px; padding: 0;
  border: 0; border-radius: var(--radius-sm); background: none; color: var(--color-muted); cursor: pointer;
}
.fx-task-stop:hover { background: var(--fx-selected); color: var(--color-danger-text); }
.fx-task-stop:disabled { opacity: .5; cursor: progress; }
.fx-task-stop .i-sm { width: 12px; height: 12px; }
.fx-task-facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 10px; margin: 0; padding: 4px 8px 8px 24px; font-size: var(--text-small); }
.fx-task-facts dt { color: var(--color-muted); }
.fx-task-facts dd { margin: 0; overflow-wrap: anywhere; }
.fx-task-err { color: var(--color-danger-text); }
.fx-task-open { display: inline-block; margin: 0 8px 8px 24px; font-size: var(--text-small); color: var(--color-interactive-text); text-decoration: none; }
.fx-task-open:hover { text-decoration: underline; }
.fx-panel-more {
  display: flex; align-items: center; gap: 4px; padding: 6px 8px; border-radius: var(--radius-control); cursor: pointer; list-style: none;
  font-size: var(--text-small); color: var(--color-muted);
}
.fx-panel-more::-webkit-details-marker { display: none; }
.fx-panel-more:hover { background: var(--fx-hover); color: var(--color-text); }
.fx-panel-more .chev { width: 12px; height: 12px; }
.fx-panel-link {
  display: grid; grid-template-columns: 16px minmax(0, 1fr) 14px; align-items: center; gap: 8px;
  padding: 8px; border-radius: var(--radius-control); color: var(--color-text); text-decoration: none; font-size: var(--text-ui);
}
.fx-panel-link:hover { background: var(--fx-hover); }
.fx-panel-link .i-sm { width: 14px; height: 14px; color: var(--color-muted); }
.fx-panel-toggle { position: relative; }
.fx-panel-toggle[aria-expanded="true"] { background: var(--ui-selected); color: var(--color-text); }
.fx-panel-badge { position: absolute; top: 5px; right: 5px; width: 6px; height: 6px; border-radius: 50%; background: var(--color-neutral-500); }
.fx-panel-badge.is-attention { background: var(--color-warning-fill); }
@media (max-width: 1100px) {
  .fx[data-panel="open"], .fx[data-panel="open"][data-side="closed"] { grid-template-columns: var(--side-w) minmax(0, 1fr); }
  .fx[data-panel="open"][data-side="closed"] { grid-template-columns: 0 minmax(0, 1fr); }
  .fx-panel { position: fixed; inset: 0 0 0 auto; z-index: 36; width: min(320px, 90vw); box-shadow: var(--shadow-lg); }
}
@media (max-width: ${FRONT_NARROW_PX}px) {
  .fx[data-panel="open"], .fx[data-panel="open"][data-side="closed"] { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) { .fx-task-running .fx-task-dot { animation: none; } }
`
