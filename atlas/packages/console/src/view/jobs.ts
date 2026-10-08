// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 值守作业 — the jobs the hub fires, and whether the thing that fires them is
 * alive (J6).
 *
 * ## Absence is drawn, never left blank
 *
 * The hub is the single point that times every watch job (`console.md`
 * §10.3): a node never wakes itself. So the one failure this page exists to
 * show is the scheduler not running — and a scheduler that is not running
 * looks exactly like one with nothing due. The heartbeat row therefore has a
 * sentence for each of its three states, and the two that are not "seen
 * recently" also put a strip above the table:
 *
 * - 未接入 — this console cannot see the scheduler's last run at all. Today's
 *   production state: the runner lives in `qm watch`, another process, and
 *   keeps `lastTickAt` in memory. The strip says so and says what that costs.
 * - 从未运行 — the scheduler is there and has never run a pass.
 * - N 分钟前 · 可能已停止 — seen, but longer ago than a live runner allows.
 *
 * ## Two different "last" facts, kept apart
 *
 * 上次触发 is the scheduled instant the scheduler last retired and how it
 * ended (`state.json`): 已投递 means the node acknowledged receipt. 最近结果
 * is what the node said when the turn finished (`watch_result_received`).
 * A job can be 已投递 and 失败 at once; one column for both would hide it.
 */

import type {
  ConsoleFailure,
  SchedulerEstop,
  SchedulerSnapshot,
  SchedulerTick,
  WatchFireOutcome,
  WatchJobStatus,
} from '../deps.js'
import {
  absent,
  address,
  bar,
  failureBar,
  hint,
  railSep,
  reasonOf,
  scroll,
  sectionHead,
  state,
  tag,
  toned,
  type Tone,
  timeTag,
  withTimes,
} from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatDuration, formatRelative } from './format.js'

/**
 * How many of the scheduler's own longest gaps (`SchedulerTick.everyMs`) may
 * pass without a new pass before it reads as stopped. Two: one late pass —
 * a slow dispatch, a busy host — is not an outage, and the yardstick is the
 * scheduler's, so a hub configured to pass less often is not called stopped.
 */
const TICK_STALE_GAPS = 2

/** The word that marks a value this console has no source for. */
const UNWIRED = '未接入'

/** The one sentence the absent heartbeat is always stated with. */
const TICK_UNWIRED_LEAD = '调度器心跳未接入'

const OUTCOME_WORD: Readonly<Record<WatchFireOutcome, string>> = {
  completed: '已投递',
  failed: '投递失败',
  skipped: '已跳过',
  preempted: '被另一进程认领',
}

const OUTCOME_TONE: Readonly<Record<WatchFireOutcome, Tone>> = {
  completed: 'ok',
  failed: 'bad',
  skipped: 'warn',
  preempted: 'muted',
}

const RESULT_WORD: Readonly<Record<string, string | undefined>> = {
  completed: '完成',
  failed: '失败',
  error: '被拒',
}

const RESULT_TONE: Readonly<Record<string, Tone | undefined>> = {
  completed: 'ok',
  failed: 'bad',
  error: 'bad',
}

function unwired(): string {
  return `<span class="note" data-unwired>${UNWIRED}</span>`
}

function when(at: number, now: number): string {
  return (
    timeTag(at, 'datetime') +
    `<span class="note">${escapeHtml(formatRelative(at, now))}</span>`
  )
}

/** One `dt`/`dd` line of the scheduler card. */
function row(label: string, value: string, id: string): string {
  return (
    `<div class="lim-row" id="${attr(id)}"><dt>${escapeHtml(label)}</dt>` +
    `<dd class="sched-v">${value}</dd></div>`
  )
}

interface Said {
  readonly value: string
  readonly strip?: string
}

function tickSaid(tick: SchedulerTick, now: number): Said {
  switch (tick.state) {
    case 'seen': {
      const ago = formatRelative(tick.at, now)
      if (now - tick.at > TICK_STALE_GAPS * tick.everyMs) {
        return {
          value: state('critical', `${ago} · 可能已停止`),
          strip: bar(
            'critical',
            `调度器可能已停止 · 最后一次运行 ${ago} · 到期的作业不会触发`,
          ),
        }
      }
      return { value: state('ok', `刚运行过 · ${ago}`) }
    }
    case 'never':
      return {
        value: state('critical', '从未运行'),
        strip: bar('critical', '调度器从未运行 · 作业不会触发'),
      }
    case 'unwired':
      return {
        value: state('warn', UNWIRED),
        strip: reasonBar(
          'warn',
          TICK_UNWIRED_LEAD,
          tick.reason,
          '无法判断调度器是否在运行',
        ),
      }
  }
}

/**
 * A strip around a reason the scheduler port handed up: the port's words are
 * shown only when they keep the copy rules, and folded under 详情 otherwise
 * (`view/errors.ts`, C5).
 */
function reasonBar(
  tone: Tone,
  lead: string,
  reason: string,
  tail: string,
): string {
  const said = reasonOf(reason)
  const text = [lead, said.text, tail].filter(part => part !== '').join(' · ')
  return bar(tone, text, '', said.detail)
}

function estopSaid(estop: SchedulerEstop): Said {
  switch (estop.state) {
    case 'released':
      return { value: state('ok', '未拉下') }
    case 'engaged':
      return {
        value: state(
          'critical',
          estop.since === undefined
            ? '已拉下'
            : withTimes('已拉下 · 自 ', { at: estop.since, fmt: 'datetime' }),
        ),
        strip: bar(
          'critical',
          '急停已拉下 · 不再发起新的触发 · 进行中的作业不受影响',
        ),
      }
    case 'unknown':
      return {
        value: state('warn', '读不出来'),
        strip: reasonBar(
          'warn',
          '急停状态读不出来 · 调度器按未拉下处理',
          estop.reason,
          '',
        ),
      }
  }
}

/** The latest instant anything was recorded for any job: a weaker sign of life. */
function lastActivity(jobs: readonly WatchJobStatus[]): number | undefined {
  let latest: number | undefined
  for (const job of jobs) {
    const at = job.last?.recordedAt
    if (at !== undefined && (latest === undefined || at > latest)) latest = at
  }
  return latest
}

function schedulerCard(snapshot: SchedulerSnapshot, now: number): string {
  const tick = tickSaid(snapshot.tick, now)
  const estop = estopSaid(snapshot.estop)
  const activity = lastActivity(snapshot.jobs)
  const definitions =
    snapshot.definitions.state === 'wired'
      ? state('ok', '已接入')
      : state('warn', UNWIRED)
  const strips =
    (tick.strip ?? '') +
    (estop.strip ?? '') +
    (snapshot.definitions.state === 'unwired'
      ? reasonBar(
          'muted',
          '作业定义未接入',
          snapshot.definitions.reason,
          '周期与下次触发无从计算',
        )
      : '')
  return (
    sectionHead('Scheduler', '调度器', { headingId: 'h-scheduler' }) +
    `<div class="pane">${strips}` +
    `<div class="card elev-sm sched"><dl class="dl">` +
    row('调度器心跳', tick.value, 'sched-tick') +
    row(
      '最近落账',
      activity === undefined
        ? `<span class="note">无记录</span>`
        : `<span class="sched-when">${when(activity, now)}</span>`,
      'sched-activity',
    ) +
    row('急停', estop.value, 'sched-estop') +
    row('作业定义', definitions, 'sched-defs') +
    `</dl></div></div>`
  )
}

function jobCell(job: WatchJobStatus, wired: boolean): string {
  const name =
    job.title === undefined
      ? `<b class="mono">${escapeHtml(job.id)}</b>`
      : `<b>${escapeHtml(job.title)}</b>` +
        `<span class="note mono">${escapeHtml(job.id)}</span>`
  const gone = wired && !job.listed ? tag('已移出调度', 'muted') : ''
  return `<td class="job"><span class="job-name">${name}</span>${gone}</td>`
}

function lastCell(job: WatchJobStatus, now: number): string {
  const last = job.last
  if (last === undefined)
    return `<td class="when"><span class="note">尚未触发</span></td>`
  return (
    `<td class="when"><span class="sched-when">${when(last.at, now)}</span>` +
    `${toned(OUTCOME_TONE[last.outcome], OUTCOME_WORD[last.outcome])}</td>`
  )
}

function nextCell(
  job: WatchJobStatus,
  snapshot: SchedulerSnapshot,
  now: number,
): string {
  if (snapshot.definitions.state === 'unwired') return `<td>${unwired()}</td>`
  if (!job.listed) return `<td><span class="note">不再调度</span></td>`
  const next = job.next
  if (next === undefined) return `<td>${absent()}</td>`
  const time = timeTag(next, 'datetime')
  let note: string
  if (snapshot.estop.state === 'engaged') {
    note = toned('critical', '急停中 · 不会触发')
  } else if (job.holdUntil !== undefined && job.holdUntil > now) {
    note = toned(
      'warn',
      withTimes('退避至 ', { at: job.holdUntil, fmt: 'datetime' }),
    )
  } else if (next <= now) {
    note = toned('warn', `已到期 · ${formatRelative(next, now)}`)
  } else {
    note = `<span class="note">${escapeHtml(formatRelative(next, now))}</span>`
  }
  return `<td class="when"><span class="sched-when">${time}${note}</span></td>`
}

function resultCell(job: WatchJobStatus, now: number): string {
  const result = job.result
  if (result === undefined) return `<td>${absent()}</td>`
  const word = RESULT_WORD[result.result] ?? result.result
  const code =
    result.code === undefined
      ? ''
      : `<code class="mono note">${escapeHtml(result.code)}</code>`
  return (
    `<td class="when">${toned(RESULT_TONE[result.result] ?? 'muted', word)}` +
    `${code}<span class="note">${escapeHtml(formatRelative(result.at, now))}</span></td>`
  )
}

function periodCell(job: WatchJobStatus, wired: boolean): string {
  if (job.everyMs !== undefined) {
    return `<td>${escapeHtml(formatDuration(job.everyMs))}</td>`
  }
  return `<td>${wired ? absent() : unwired()}</td>`
}

function targetCell(job: WatchJobStatus, wired: boolean): string {
  if (job.target !== undefined) return `<td>${address(job.target)}</td>`
  return `<td>${wired ? absent() : unwired()}</td>`
}

function failuresCell(job: WatchJobStatus): string {
  const count = String(job.consecutiveFailures)
  return `<td>${
    job.consecutiveFailures > 0 ? toned('bad', count) : escapeHtml(count)
  }</td>`
}

const JOB_HEADERS = [
  '作业',
  '目标',
  '周期',
  '上次触发',
  '下次触发',
  '最近结果',
  '连续失败',
]

function jobsTable(snapshot: SchedulerSnapshot, now: number): string {
  const wired = snapshot.definitions.state === 'wired'
  const head = JOB_HEADERS.map(
    name => `<th scope="col">${escapeHtml(name)}</th>`,
  ).join('')
  const rows = snapshot.jobs
    .map(
      job =>
        `<tr data-key="${attr(job.id)}">` +
        jobCell(job, wired) +
        targetCell(job, wired) +
        periodCell(job, wired) +
        lastCell(job, now) +
        nextCell(job, snapshot, now) +
        resultCell(job, now) +
        failuresCell(job) +
        `</tr>`,
    )
    .join('')
  return scroll(
    `<table class="trail jobs"><caption class="sr-only">值守作业</caption>` +
      `<thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`,
  )
}

function jobsSection(snapshot: SchedulerSnapshot, now: number): string {
  const failing = snapshot.jobs.filter(
    job => job.consecutiveFailures > 0,
  ).length
  const tail =
    `<div class="rowx note">` +
    `<span class="total">${escapeHtml(String(snapshot.jobs.length))}</span>` +
    railSep() +
    `<span>连续失败 ${escapeHtml(String(failing))}</span>` +
    `</div>`
  const body =
    snapshot.jobs.length === 0
      ? hint(
          snapshot.definitions.state === 'wired'
            ? '调度器里没有作业'
            : '没有作业记录',
        )
      : jobsTable(snapshot, now)
  return (
    sectionHead('Jobs', '作业', {
      headingId: 'h-jobs',
      tail,
      stats: { jobs: snapshot.jobs.length, failing },
    }) + `<div class="pane">${body}</div>`
  )
}

/** The polled fragment: the scheduler card and the job table. */
export function renderJobs(snapshot: SchedulerSnapshot, now: number): string {
  return schedulerCard(snapshot, now) + jobsSection(snapshot, now)
}

/**
 * The fragment when there is no scheduler port at all, or when it failed.
 *
 * The card is still drawn with each of its rows saying 未接入, so the absent
 * heartbeat is stated in the same words and the same place as when only the
 * heartbeat is missing.
 */
export function renderJobsUnavailable(failure: ConsoleFailure | null): string {
  const lead =
    failure === null
      ? bar('warn', '值守作业未接入 · 控制台没有读取调度器状态')
      : failureBar(failure, '调度器状态')
  return (
    sectionHead('Scheduler', '调度器', { headingId: 'h-scheduler' }) +
    `<div class="pane">${lead}` +
    bar('warn', `${TICK_UNWIRED_LEAD} · 无法判断调度器是否在运行`) +
    `<div class="card elev-sm sched"><dl class="dl">` +
    row('调度器心跳', state('warn', UNWIRED), 'sched-tick') +
    row('急停', state('warn', UNWIRED), 'sched-estop') +
    row('作业定义', state('warn', UNWIRED), 'sched-defs') +
    `</dl></div></div>`
  )
}

/** The page's own rules (`routes/types.ts`, `PageRoute.css`). */
export const JOBS_PAGE_CSS = `
.sched { padding: var(--space-1) var(--space-4); }
.sched .lim-row dd { margin: 0; text-align: right; }
.sched-when { display: inline-flex; flex-direction: column; gap: 2px; }
.trail.jobs td { vertical-align: top; }
.trail.jobs td.when { white-space: nowrap; }
.trail.jobs td.when time { font-family: var(--font-mono); font-size: 12px; }
.job-name { display: inline-flex; flex-direction: column; gap: 2px; margin-right: var(--space-2); }
`
