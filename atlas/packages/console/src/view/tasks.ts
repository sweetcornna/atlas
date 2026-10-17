// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 后台任务 — the work a main agent handed to a background sub-agent (P29,
 * `runtimes-channels.md` §3), on the 主动执行 page beside the schedules: the
 * other turns the hub drives by itself.
 *
 * Read-only but for 取消, which is the cancel the conversation has: the task
 * stops and the node stops the turn it is running. A row says what the hub
 * knows — the phase (排队中 while it waits for its node, 已安排 with the next
 * start for a delayed or repeating one, and the runs a repeating one has
 * left), the turns so far, the last report and the last interruption — and
 * links the worker session, where the whole exchange is. Labels and states
 * only; what a task was asked to do is in that session, not repeated here.
 */

import type {
  BackgroundTaskStatus,
  BackgroundTaskView,
} from '../directionPorts.js'
import type { ConsoleFailure } from '../deps.js'
import {
  absent,
  address,
  failureBar,
  hint,
  scroll,
  sectionHead,
  state,
  type Tone,
  withTimes,
} from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatRelative } from './format.js'
import { actionButton, dialogActions, dialogTop, unwiredCard } from './kit.js'

/** Finished tasks shown under the unfinished ones. */
const FINISHED_SHOWN = 20

const STATUS_TONE: Readonly<Record<BackgroundTaskStatus, Tone>> = {
  scheduled: 'muted',
  queued: 'muted',
  running: 'ok',
  interrupted: 'warn',
  completion_pending: 'ok',
  needs_input_pending: 'warn',
  needs_input: 'warn',
  completed: 'ok',
  cancelled: 'muted',
}

const FINISHED: ReadonlySet<BackgroundTaskStatus> = new Set([
  'completed',
  'cancelled',
])

function clipped(text: string, length: number): string {
  const chars = [...text]
  return chars.length <= length ? text : `${chars.slice(0, length).join('')}…`
}

function textCell(text: string, tone?: 'bad'): string {
  if (text === '') return `<td>${absent()}</td>`
  return (
    `<td class="tk-text" title="${attr(clipped(text, 600))}">` +
    `<span class="${tone === 'bad' ? 'tk-bad' : 'note'}">${escapeHtml(clipped(text, 120))}</span></td>`
  )
}

/** Within a day the next start reads as a clock time; further off, with its date. */
const DAY_MS = 24 * 60 * 60_000

/** 已安排 · 下次 HH:MM, and · 剩 N 次 for a repeating task. */
function phaseCell(task: BackgroundTaskView, now: number): string {
  const left = task.runsLeft === null ? '' : ` · 剩 ${task.runsLeft} 次`
  const text =
    task.status === 'scheduled' && task.nextAt !== null
      ? withTimes(
          `${task.phase} · 下次 `,
          {
            at: task.nextAt,
            fmt: task.nextAt - now < DAY_MS ? 'hm' : 'minute',
          },
          left,
        )
      : `${task.phase}${left}`
  return `<td>${state(STATUS_TONE[task.status], text)}</td>`
}

function taskRow(
  task: BackgroundTaskView,
  now: number,
  options: { readonly owners: boolean; readonly cancel: boolean },
): string {
  const session =
    task.workerSession === null
      ? absent()
      : `<a class="jump" href="${attr(`/?session=${encodeURIComponent(task.workerSession)}`)}" data-nav>查看会话</a>`
  const cancel =
    options.cancel && !FINISHED.has(task.status)
      ? actionButton('task-cancel', '取消', {
          tone: 'ghost',
          data: { id: task.id, title: task.title },
        })
      : ''
  return (
    `<tr data-key="${attr(task.id)}">` +
    `<td class="tk-name"><b>${escapeHtml(task.title)}</b>` +
    `<span class="kit-mono note">${escapeHtml(task.id)}</span></td>` +
    (options.owners
      ? `<td><span class="kit-mono">${escapeHtml(task.owner)}</span></td>`
      : '') +
    `<td>${address(task.target)}</td>` +
    phaseCell(task, now) +
    `<td class="num">${task.turns}</td>` +
    textCell(task.progress) +
    textCell(task.lastError, 'bad') +
    `<td class="when"><span class="note">${escapeHtml(formatRelative(task.updatedAt, now))}</span></td>` +
    `<td>${session}</td>` +
    `<td class="acts"><span class="kit-acts">${cancel}</span></td>` +
    `</tr>`
  )
}

/**
 * The tasks this reader may see: the unfinished first, then the latest
 * finished ones. `owners` adds whose task it is (the reader sees others');
 * `cancel` offers 取消 on the unfinished.
 */
export function renderTasks(
  tasks: readonly BackgroundTaskView[],
  now: number,
  options: { readonly owners: boolean; readonly cancel: boolean },
): string {
  const open = tasks.filter(
    task => !FINISHED.has(task.status) && task.status !== 'scheduled',
  )
  // Planned ones after the running ones, the next to start first.
  const planned = tasks
    .filter(task => task.status === 'scheduled')
    .sort((a, b) => (a.nextAt ?? 0) - (b.nextAt ?? 0))
  const done = tasks
    .filter(task => FINISHED.has(task.status))
    .slice(0, FINISHED_SHOWN)
  const shown = [...open, ...planned, ...done]
  const head = [
    '任务',
    ...(options.owners ? ['发起人'] : []),
    '智能体',
    '阶段',
    '轮数',
    '最近汇报',
    '最近中断',
    '更新',
    '会话',
    '',
  ]
    .map(name => `<th scope="col">${escapeHtml(name)}</th>`)
    .join('')
  const body =
    shown.length === 0
      ? hint('还没有后台任务')
      : scroll(
          `<table class="trail tasks"><caption class="sr-only">后台任务</caption>` +
            `<thead><tr>${head}</tr></thead><tbody>` +
            shown.map(task => taskRow(task, now, options)).join('') +
            `</tbody></table>`,
        )
  return (
    `<section class="sec" aria-labelledby="h-tasks">` +
    sectionHead('Tasks', '后台任务', {
      headingId: 'h-tasks',
      tail: `<span class="note">进行中 ${open.length}${
        planned.length === 0 ? '' : ` · 已安排 ${planned.length}`
      } · 最近结束 ${done.length}</span>`,
    }) +
    body +
    `</section>`
  )
}

/** The fragment when the tasks port is absent or failed. */
export function renderTasksUnavailable(failure: ConsoleFailure | null): string {
  if (failure !== null) return failureBar(failure, '后台任务')
  return (
    `<section class="sec" aria-labelledby="h-tasks">` +
    sectionHead('Tasks', '后台任务', { headingId: 'h-tasks' }) +
    unwiredCard(
      '后台任务',
      '中枢接上节点的控制链路后 · 主智能体交给后台子智能体的任务列在这里',
      'qm console --chat-url <节点>=<地址> --control <节点>=<地址>',
    ) +
    `</section>`
  )
}

/** The 取消 confirmation, rendered once with the page outside the polled region. */
export function taskConfirm(): string {
  const id = 'confirm-task-cancel'
  return (
    `<dialog class="dialog" id="${id}" aria-labelledby="${id}-title">` +
    dialogTop(`${id}-title`, 'x', '取消后台任务') +
    `<div class="dialog-body"><div class="recap"><div class="recap-row"><span class="k">任务</span>` +
    `<span id="${id}-name"></span></div></div>` +
    `<p>${escapeHtml('停在当前这一轮 · 已经做完的操作不会撤回')}</p></div>` +
    dialogActions('取消任务', { danger: true, action: id, cancel: '保留' }) +
    `</dialog>`
  )
}

export const TASKS_PAGE_CSS = `
.trail.tasks td { vertical-align: middle; }
.tk-name { display: flex; flex-direction: column; gap: 2px; min-width: 10em; }
.tk-text { max-width: 22em; }
.tk-bad { color: var(--color-critical); font-size: var(--text-12-5); }
.trail.tasks td.num { font-variant-numeric: tabular-nums; }
`
