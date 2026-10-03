// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `status.json` (`status.ts`): written after every pass, whole or not at all,
 * and read back as exactly one of absent / ok / invalid.
 *
 * The runner here is the real one with the real store; only the timer is
 * injected, so "two passes" means two calls of the callback the runner armed,
 * each followed by the re-arm that ends `#tick` — after which the file has
 * been written. No test waits on a real timer.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type BackoffOptions, backoffMs } from '../src/backoff.js'
import { type FireDispatch, SchedulerRunner } from '../src/fire.js'
import {
  SCHEDULER_STATUS_FILE,
  type SchedulerStatusFile,
  describeSchedule,
  readSchedulerStatus,
  schedulerStatusOf,
  writeSchedulerStatus,
} from '../src/status.js'
import { SchedulerStore } from '../src/store.js'

const MINUTE = 60_000
const ANCHOR = 1_700_000_000_000

let directory: string
let clock = ANCHOR

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-scheduler-status-'))
  clock = ANCHOR
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

const JOB = {
  id: 'disk-watch',
  title: 'look at the disk',
  target: 'qianmo://beta-1/reviewer',
  prompt: 'df -P /',
  schedule: { everyMs: 10 * MINUTE, anchorMs: ANCHOR },
  taskTtlMs: 900_000,
  notifyPolicy: 'agent-initiated' as const,
}

/**
 * The real runner with an injected timer. `pass()` runs the armed callback
 * and resolves once the runner has re-armed, which is after `onTick`.
 */
function harness(
  dispatch: (input: FireDispatch) => Promise<void>,
  backoff?: BackoffOptions,
) {
  const errors: unknown[] = []
  let armed: (() => void) | null = null
  let rearmed: (() => void) | null = null
  const runner: SchedulerRunner = new SchedulerRunner({
    store: new SchedulerStore(directory, { now: () => clock }),
    dispatch,
    jobs: [JOB],
    now: () => clock,
    maxDelayMs: MINUTE,
    ...(backoff === undefined ? {} : { backoff }),
    onError: error => {
      errors.push(error)
    },
    onTick: () => {
      writeSchedulerStatus(directory, schedulerStatusOf(runner, 4242))
    },
    schedule: (_delayMs, callback) => {
      armed = callback
      rearmed?.()
      return { cancel: () => {} }
    },
  })
  runner.start()
  return {
    runner,
    errors,
    async pass(): Promise<void> {
      const callback = armed
      if (callback === null) throw new Error('nothing armed')
      armed = null
      const done = new Promise<void>(resolveDone => {
        rearmed = resolveDone
      })
      callback()
      await done
    },
  }
}

function readOk(): SchedulerStatusFile {
  const read = readSchedulerStatus(directory)
  if (read.state !== 'ok') throw new Error(`status is ${read.state}`)
  return read.status
}

describe('a running scheduler writes its status after every pass', () => {
  test('two passes: lastTickAt moves, and each job carries its last and next fire', async () => {
    const h = harness(async () => {})
    await h.pass()
    const first = readOk()
    expect(first).toEqual({
      version: 1,
      pid: 4242,
      lastTickAt: ANCHOR,
      tickMs: MINUTE,
      jobs: [
        {
          id: 'disk-watch',
          title: 'look at the disk',
          target: 'qianmo://beta-1/reviewer',
          schedule: `every 10m anchored at ${new Date(ANCHOR).toISOString()}`,
          everyMs: 10 * MINUTE,
          lastFireAt: ANCHOR,
          lastResult: 'completed',
          nextFireAt: ANCHOR + 10 * MINUTE,
          consecutiveFailures: 0,
        },
      ],
    })

    clock += MINUTE
    await h.pass()
    const second = readOk()
    expect(second.lastTickAt).toBe(ANCHOR + MINUTE)
    expect(second.lastTickAt).toBeGreaterThan(first.lastTickAt)
    // Nothing was due on the second pass: the plan is unchanged.
    expect(second.jobs[0]?.nextFireAt).toBe(ANCHOR + 10 * MINUTE)
    expect(h.errors).toEqual([])
    h.runner.stop()
  })

  test("a failing job's next fire is the end of its backoff hold, the runner's own value", async () => {
    // A hold longer than the period, so the next slot is due and held.
    const slow: BackoffOptions = { baseMs: 30 * MINUTE, capMs: 60 * MINUTE }
    const h = harness(async () => {
      throw new Error('node unreachable')
    }, slow)
    await h.pass()
    clock += 10 * MINUTE
    await h.pass()
    const job = readOk().jobs[0]
    expect(job?.lastResult).toBe('failed')
    expect(job?.consecutiveFailures).toBe(1)
    // Recorded at ANCHOR, held for backoffMs(1) from then — not the slot.
    expect(job?.nextFireAt).toBe(ANCHOR + backoffMs(1, slow))
    expect(job?.nextFireAt).toBe(h.runner.status().jobs[0]?.nextFireAt)
    h.runner.stop()
  })

  test('a status that cannot be written is reported and the scheduler keeps firing', async () => {
    const fired: FireDispatch[] = []
    // status.json is a non-empty directory: rename cannot replace it.
    mkdirSync(join(directory, SCHEDULER_STATUS_FILE, 'x'), { recursive: true })
    const h = harness(async input => {
      fired.push(input)
    })
    await h.pass()
    expect(fired).toHaveLength(1)
    expect(h.errors).toHaveLength(1)
    // And it re-armed: the next pass happens.
    clock += 10 * MINUTE
    await h.pass()
    expect(fired).toHaveLength(2)
    h.runner.stop()
    // A pass driven directly — `qm watch --once` — does not fail on it either.
    clock += 10 * MINUTE
    await h.runner.runDue(clock)
    expect(fired).toHaveLength(3)
    expect(h.errors).toHaveLength(3)
  })
})

describe('the file itself', () => {
  function sample(lastTickAt: number): SchedulerStatusFile {
    return {
      version: 1,
      pid: 1,
      lastTickAt,
      tickMs: MINUTE,
      jobs: [
        {
          id: 'a',
          title: 't',
          target: 'qianmo://n/a',
          schedule: 'every 1m',
          everyMs: MINUTE,
          consecutiveFailures: 0,
        },
      ],
    }
  }

  test('0600 in a 0700 directory, and no temporary left behind', () => {
    const root = join(directory, 'scheduler')
    writeSchedulerStatus(root, sample(1))
    writeSchedulerStatus(root, sample(2))
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, SCHEDULER_STATUS_FILE)).mode & 0o777).toBe(0o600)
    expect(readdirSync(root)).toEqual([SCHEDULER_STATUS_FILE])
    expect(readSchedulerStatus(root)).toEqual({
      state: 'ok',
      status: sample(2),
    })
  })

  test('absent, not JSON, another version, a job missing a field: each says which', () => {
    expect(readSchedulerStatus(directory)).toEqual({ state: 'absent' })
    const path = join(directory, SCHEDULER_STATUS_FILE)
    writeFileSync(path, '{"version":1,')
    expect(readSchedulerStatus(directory)).toEqual({
      state: 'invalid',
      reason: 'not JSON',
    })
    writeFileSync(path, JSON.stringify({ ...sample(1), version: 2 }))
    expect(readSchedulerStatus(directory)).toEqual({
      state: 'invalid',
      reason: 'version 2',
    })
    const { title: _title, ...untitled } = sample(1).jobs[0] ?? {}
    writeFileSync(path, JSON.stringify({ ...sample(1), jobs: [untitled] }))
    expect(readSchedulerStatus(directory)).toEqual({
      state: 'invalid',
      reason: 'job 0',
    })
  })

  test('the schedule in words', () => {
    expect(describeSchedule({ everyMs: 10 * MINUTE })).toBe('every 10m')
    expect(describeSchedule({ everyMs: 90 * MINUTE })).toBe('every 1h30m')
    expect(describeSchedule({ everyMs: 86_400_000 })).toBe('every 1d')
    expect(describeSchedule({ everyMs: 1_500 })).toBe('every 1s500ms')
    expect(describeSchedule({ everyMs: MINUTE, anchorMs: 0 })).toBe(
      'every 1m anchored at 1970-01-01T00:00:00.000Z',
    )
  })
})

describe('a reader never sees half a file', () => {
  test('another process rewrites it four hundred times while this one reads', async () => {
    const root = join(directory, 'concurrent')
    const done = join(directory, 'done')
    const writes = 400
    const statusModule = resolve(import.meta.dir, '../src/status.ts')
    // A big file, so an in-place write would leave a reader plenty of window.
    const writer = `
      import { writeFileSync } from 'node:fs'
      import { writeSchedulerStatus } from ${JSON.stringify(statusModule)}
      const root = ${JSON.stringify(root)}
      for (let i = 1; i <= ${writes}; i++) {
        const jobs = []
        for (let k = 0; k < 300 + (i % 7) * 40; k++) {
          jobs.push({ id: 'job-' + k, title: 'x'.repeat(200), target: 'qianmo://n/a',
            schedule: 'every 1m', everyMs: 60000, nextFireAt: i, consecutiveFailures: 0 })
        }
        writeSchedulerStatus(root, { version: 1, pid: process.pid, lastTickAt: i, tickMs: 60000, jobs })
      }
      writeFileSync(${JSON.stringify(done)}, 'done')
    `
    const child = Bun.spawn([process.execPath, '-e', writer], {
      stdout: 'ignore',
      stderr: 'pipe',
    })

    const seen = new Set<number>()
    const invalid: string[] = []
    let reads = 0
    let previous = 0
    const deadline = Date.now() + 60_000
    while (!existsSync(done) && Date.now() < deadline) {
      const read = readSchedulerStatus(root)
      reads += 1
      if (read.state === 'invalid') invalid.push(read.reason)
      if (read.state !== 'ok') continue
      const { lastTickAt, jobs } = read.status
      // Whole: every job of this write is there and from this write.
      expect(jobs.every(job => job.nextFireAt === lastTickAt)).toBe(true)
      expect(jobs).toHaveLength(300 + (lastTickAt % 7) * 40)
      // And never older than one already seen.
      expect(lastTickAt).toBeGreaterThanOrEqual(previous)
      previous = lastTickAt
      seen.add(lastTickAt)
    }
    expect(await child.exited).toBe(0)
    expect(invalid).toEqual([])
    // The reads overlapped the writes rather than all landing after them.
    expect(seen.size).toBeGreaterThan(5)
    expect([...seen].some(at => at < writes)).toBe(true)
    expect(reads).toBeGreaterThan(seen.size)
  }, 90_000)
})
