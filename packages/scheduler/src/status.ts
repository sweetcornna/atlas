// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from './atomic.js'
import type { SchedulerRunner } from './fire.js'
import type { JobSchedule } from './job.js'
import { FIRE_OUTCOMES, type FireOutcome, isCount } from './store.js'

/**
 * `status.json`: what a running scheduler knows that is not on disk anywhere
 * else, written after every pass so another process can read it.
 *
 * ## Why this file exists
 *
 * The runner lives inside `qm watch`, and the console is another process. The
 * one signal that tells a stopped scheduler from an idle one — `lastTickAt`
 * (§4.1 point 6, `fire.ts`) — and the plans of the pass (when each job fires
 * next, held back by its backoff or not) were only ever in that process's
 * memory. `state.json` cannot carry them: it is the store's record of what
 * happened, written when a fire retires, not when a pass runs.
 *
 * ## Written whole or not at all
 *
 * `writeFileAtomically` (`atomic.ts`): the console reads this file while
 * `qm watch` replaces it, and a reader must get the old status or the new one.
 * Half a file would parse as nothing and read as "the scheduler is gone",
 * which is the one thing this file is there to say only when it is true.
 *
 * ## What it is not
 *
 * Not a lock, a heartbeat that anything waits on, or a second store. Nothing
 * in this package reads it back; a scheduler that cannot write it keeps firing
 * (`SchedulerRunnerOptions.onTick`). A file left behind by a scheduler that
 * stopped keeps its last `lastTickAt`, and that age is what the reader judges.
 */

export const SCHEDULER_STATUS_FILE = 'status.json'

export const SCHEDULER_STATUS_VERSION = 1

/** One job as the runner saw it at the end of a pass. */
export interface SchedulerStatusJob {
  readonly id: string
  readonly title: string
  readonly target: string
  /** For a person reading the file: `every 10m`. `everyMs` is the number. */
  readonly schedule: string
  readonly everyMs: number
  /** Latest **scheduled** instant retired. Absent before the first. */
  readonly lastFireAt?: number
  /** How that instant was retired. */
  readonly lastResult?: FireOutcome
  /**
   * The instant the runner will act on next: `planFire`'s, or the end of the
   * backoff hold when that is later — the runner's own value, not a second
   * computation of it.
   */
  readonly nextFireAt?: number
  readonly consecutiveFailures: number
}

export interface SchedulerStatusFile {
  readonly version: typeof SCHEDULER_STATUS_VERSION
  /** The `qm watch` process that wrote it. */
  readonly pid: number
  /** When the pass this file describes began (`SchedulerRunner.lastTickAt`). */
  readonly lastTickAt: number
  /**
   * The longest the runner waits between passes (`maxDelayMs`). A reader
   * judges "stopped" against this rather than a number of its own.
   */
  readonly tickMs: number
  readonly jobs: readonly SchedulerStatusJob[]
}

const UNITS: readonly (readonly [string, number])[] = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1_000],
  ['ms', 1],
]

/** `every 1h30m`; with an anchor, `every 24h anchored at <ISO instant>`. */
export function describeSchedule(schedule: JobSchedule): string {
  let rest = schedule.everyMs
  const parts: string[] = []
  for (const [unit, size] of UNITS) {
    const count = Math.floor(rest / size)
    if (count === 0) continue
    parts.push(`${count}${unit}`)
    rest -= count * size
  }
  const period = `every ${parts.join('')}`
  return schedule.anchorMs === undefined
    ? period
    : `${period} anchored at ${new Date(schedule.anchorMs).toISOString()}`
}

/**
 * The file for a runner that has run at least one pass: its jobs, each with
 * the store's memory of it and the runner's plan for it.
 */
export function schedulerStatusOf(
  runner: SchedulerRunner,
  pid: number,
): SchedulerStatusFile {
  const status = runner.status()
  if (status.lastTickAt === undefined) {
    throw new Error('scheduler status: the runner has not run a pass yet')
  }
  const byId = new Map(status.jobs.map(job => [job.jobId, job]))
  return {
    version: SCHEDULER_STATUS_VERSION,
    pid,
    lastTickAt: status.lastTickAt,
    tickMs: runner.maxDelayMs,
    jobs: runner.jobs.map((job): SchedulerStatusJob => {
      const seen = byId.get(job.id)
      return {
        id: job.id,
        title: job.title,
        target: job.target,
        schedule: describeSchedule(job.schedule),
        everyMs: job.schedule.everyMs,
        ...(seen?.lastFiredAt === undefined
          ? {}
          : { lastFireAt: seen.lastFiredAt }),
        ...(seen?.lastOutcome === undefined
          ? {}
          : { lastResult: seen.lastOutcome }),
        ...(seen?.nextFireAt === undefined
          ? {}
          : { nextFireAt: seen.nextFireAt }),
        consecutiveFailures: seen?.consecutiveFailures ?? 0,
      }
    }),
  }
}

/** Replace `<root>/status.json` atomically. Throws when it cannot. */
export function writeSchedulerStatus(
  root: string,
  status: SchedulerStatusFile,
): void {
  writeFileAtomically(
    join(root, SCHEDULER_STATUS_FILE),
    `${JSON.stringify(status)}\n`,
    Date.now(),
  )
}

export type SchedulerStatusRead =
  | { readonly state: 'absent' }
  | { readonly state: 'ok'; readonly status: SchedulerStatusFile }
  | { readonly state: 'invalid'; readonly reason: string }

function isPositive(value: unknown): value is number {
  return isCount(value) && value > 0
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function parseJob(value: unknown): SchedulerStatusJob | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const raw = value as Record<string, unknown>
  if (!isText(raw.id) || !isText(raw.title) || !isText(raw.target)) return null
  if (!isText(raw.schedule) || !isPositive(raw.everyMs)) return null
  if (!isCount(raw.consecutiveFailures)) return null
  if (raw.lastFireAt !== undefined && !isCount(raw.lastFireAt)) return null
  if (raw.nextFireAt !== undefined && !isCount(raw.nextFireAt)) return null
  if (
    raw.lastResult !== undefined &&
    (typeof raw.lastResult !== 'string' ||
      !FIRE_OUTCOMES.includes(raw.lastResult))
  ) {
    return null
  }
  return {
    id: raw.id,
    title: raw.title,
    target: raw.target,
    schedule: raw.schedule,
    everyMs: raw.everyMs,
    ...(raw.lastFireAt === undefined ? {} : { lastFireAt: raw.lastFireAt }),
    ...(raw.lastResult === undefined
      ? {}
      : { lastResult: raw.lastResult as FireOutcome }),
    ...(raw.nextFireAt === undefined ? {} : { nextFireAt: raw.nextFireAt }),
    consecutiveFailures: raw.consecutiveFailures,
  }
}

/**
 * Read `<root>/status.json`. A missing file is `absent` — a scheduler that has
 * not run here, or one older than this file — and anything that does not read
 * as version 1 is `invalid` with the reason, never a guess.
 */
export function readSchedulerStatus(root: string): SchedulerStatusRead {
  let text: string
  try {
    text = readFileSync(join(root, SCHEDULER_STATUS_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'absent' }
    }
    return { state: 'invalid', reason: String(error) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { state: 'invalid', reason: 'not JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { state: 'invalid', reason: 'not an object' }
  }
  const raw = parsed as Record<string, unknown>
  if (raw.version !== SCHEDULER_STATUS_VERSION) {
    return { state: 'invalid', reason: `version ${String(raw.version)}` }
  }
  if (
    !isCount(raw.pid) ||
    !isCount(raw.lastTickAt) ||
    !isPositive(raw.tickMs)
  ) {
    return { state: 'invalid', reason: 'pid, lastTickAt or tickMs' }
  }
  if (!Array.isArray(raw.jobs)) {
    return { state: 'invalid', reason: 'jobs is not a list' }
  }
  const jobs: SchedulerStatusJob[] = []
  for (const [index, value] of raw.jobs.entries()) {
    const job = parseJob(value)
    if (job === null) return { state: 'invalid', reason: `job ${index}` }
    jobs.push(job)
  }
  return {
    state: 'ok',
    status: {
      version: SCHEDULER_STATUS_VERSION,
      pid: raw.pid,
      lastTickAt: raw.lastTickAt,
      tickMs: raw.tickMs,
      jobs,
    },
  }
}
