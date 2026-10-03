// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 告警与值守作业两个端口的生产实现（P18.15），全部对着真文件：真的审计链
 * （`@qianmo/audit` 的 `AuditTrail`）、真的调度状态（`@qianmo/scheduler` 的
 * `SchedulerStore` 写出来的 `state.json`）、真的急停哨兵与作业文件。
 *
 * **零 `mock.module`**：这两个端口的全部价值在于「读的是 `qm watch` 写下的那几份
 * 文件」，假的 fs 恰好测不到这一点。审计记录的形状照 `watch.ts` 的
 * `recordNotify` / `recordResult` / 派发处逐字段写。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditSource, AuditTrail } from '@qianmo/audit'
import {
  SchedulerStore,
  assertJob,
  backoffMs,
  planFire,
} from '@qianmo/scheduler'
import { AlertAcksStore, consoleAlertAcksPath } from '../consoleAlertAcks.js'
import {
  consoleWatchDeps,
  createNotifyPort,
  createSchedulerPort,
} from '../consolePorts.js'
import { parseWatchArgs } from '../watch.js'
import { openAuditTrail } from '../../../services/qianmo/auditTrail.js'

const roots: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-watch-ports-'))
  roots.push(dir)
  return dir
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const NOW = 1_700_000_000_000

/** One notification exactly as `watch.ts` `recordNotify` writes it. */
function appendNotice(
  trail: AuditTrail,
  over: {
    readonly at?: number
    readonly msgId?: string
    readonly severity?: string
    readonly summary?: string
    readonly kind?: string
    readonly toPerson?: boolean
    readonly redelivered?: boolean
  } = {},
): void {
  trail.append({
    at: over.at ?? NOW,
    source: AuditSource.Scheduler,
    kind:
      over.toPerson === false ? 'watch_step_received' : 'watch_notify_received',
    outcome: 'ok',
    node: 'hub',
    peer: 'qianmo://beta-1/reviewer',
    taskId: 'task-1',
    msgId: over.msgId ?? '6f9619ff-8b86-4d01-b42d-00cf4fc964ff',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    detail: {
      contextId: 'disk-watch',
      kind: over.kind ?? 'watch',
      severity: over.severity ?? 'warn',
      summary: over.summary ?? '根分区使用率 91%',
      redelivered: over.redelivered ?? false,
    },
  })
}

function notifyPort(dir: string) {
  const trailPath = join(dir, 'trail.ndjson')
  const acksPath = join(dir, 'console', 'alert-acks.ndjson')
  let clock = NOW
  const port = createNotifyPort({
    trailPath,
    acks: new AlertAcksStore(acksPath),
    now: () => clock,
  })
  return {
    trailPath,
    acksPath,
    port,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('NotifyPort: the hub trail', () => {
  test('reads the notifications meant for a person, newest first, field for field', async () => {
    const dir = tempDir()
    const { trailPath, port } = notifyPort(dir)
    const trail = new AuditTrail(trailPath)
    appendNotice(trail, {
      at: NOW - 2_000,
      msgId: 'a',
      severity: 'info',
      summary: '巡检完成',
    })
    // A process step is not a notification (`classifyWatchNotify`).
    appendNotice(trail, { at: NOW - 1_500, msgId: 'step', toPerson: false })
    appendNotice(trail, {
      at: NOW - 1_000,
      msgId: 'b',
      severity: 'error',
      kind: 'health',
      redelivered: true,
    })
    const read = await port.notices(10)
    expect(read).toEqual({
      ok: true,
      value: {
        notices: [
          {
            id: 'n:b',
            at: NOW - 1_000,
            level: 'error',
            kind: 'health',
            from: 'qianmo://beta-1/reviewer',
            job: 'disk-watch',
            summary: '根分区使用率 91%',
            redelivered: true,
          },
          {
            id: 'n:a',
            at: NOW - 2_000,
            level: 'info',
            kind: 'watch',
            from: 'qianmo://beta-1/reviewer',
            job: 'disk-watch',
            summary: '巡检完成',
          },
        ],
        total: 2,
        intact: true,
        present: true,
      },
    })
  })

  test('the limit keeps the newest, and the total still counts all of them', async () => {
    const { trailPath, port } = notifyPort(tempDir())
    const trail = new AuditTrail(trailPath)
    for (let index = 0; index < 5; index++) {
      appendNotice(trail, { at: NOW + index, msgId: `m${index}` })
    }
    const read = await port.notices(2)
    if (!read.ok) throw new Error('read failed')
    expect(read.value.notices.map(one => one.id)).toEqual(['n:m4', 'n:m3'])
    expect(read.value.total).toBe(5)
  })

  test('no trail file: zero notices and present=false, not an error', async () => {
    const read = await notifyPort(tempDir()).port.notices(10)
    expect(read).toEqual({
      ok: true,
      value: { notices: [], total: 0, intact: true, present: false },
    })
  })

  test('a trail that does not verify still yields its notices, marked', async () => {
    const { trailPath, port } = notifyPort(tempDir())
    const trail = new AuditTrail(trailPath)
    appendNotice(trail, { msgId: 'x' })
    writeFileSync(trailPath, `${readFileSync(trailPath, 'utf8')}not json\n`)
    const read = await port.notices(10)
    if (!read.ok) throw new Error('read failed')
    expect(read.value.intact).toBe(false)
    expect(read.value.notices.map(one => one.id)).toEqual(['n:x'])
  })

  test('a severity it does not know reads as warn, never quieter', async () => {
    const { trailPath, port } = notifyPort(tempDir())
    appendNotice(new AuditTrail(trailPath), { severity: 'fatal' })
    const read = await port.notices(10)
    if (!read.ok) throw new Error('read failed')
    expect(read.value.notices[0]?.level).toBe('warn')
  })

  test('a trail path that cannot be read is a failure, not a throw', async () => {
    const dir = tempDir()
    const port = createNotifyPort({
      // A directory where the file should be: EISDIR.
      trailPath: dir,
      acks: new AlertAcksStore(join(dir, 'acks.ndjson')),
    })
    const read = await port.notices(10)
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.failure.code).toBe('unreachable')
  })
})

describe('NotifyPort: acknowledgements', () => {
  test('persist 0600 in a 0700 directory and survive a restart', async () => {
    const dir = tempDir()
    const first = notifyPort(dir)
    const done = await first.port.ack('n:a', 'u:0123456789abcdef')
    expect(done).toEqual({
      ok: true,
      value: { id: 'n:a', at: NOW, by: 'u:0123456789abcdef' },
    })
    expect(statSync(first.acksPath).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'console')).mode & 0o777).toBe(0o700)
    const restarted = notifyPort(dir)
    expect(await restarted.port.acks()).toEqual({
      ok: true,
      value: [{ id: 'n:a', at: NOW, by: 'u:0123456789abcdef' }],
    })
  })

  test('a second acknowledgement of an id keeps the first and writes nothing', async () => {
    const dir = tempDir()
    const h = notifyPort(dir)
    await h.port.ack('n:a', 'legacy:admin')
    h.advance(5_000)
    const again = await h.port.ack('n:a', 'u:0123456789abcdef')
    expect(again).toEqual({
      ok: true,
      value: { id: 'n:a', at: NOW, by: 'legacy:admin' },
    })
    expect(readFileSync(h.acksPath, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  test('replay keeps the first line for an id and skips the lines it cannot read', () => {
    const dir = tempDir()
    const path = join(dir, 'acks.ndjson')
    writeFileSync(
      path,
      [
        JSON.stringify({
          kind: 'ack',
          ack: { id: 'x', at: 1, by: 'legacy:admin' },
        }),
        '{torn',
        JSON.stringify({
          kind: 'ack',
          ack: { id: 'x', at: 2, by: 'u:0123456789abcdef' },
        }),
        JSON.stringify({
          kind: 'note',
          ack: { id: 'y', at: 3, by: 'legacy:admin' },
        }),
        JSON.stringify({
          kind: 'ack',
          ack: { id: 'z', at: 'later', by: 'legacy:admin' },
        }),
        '',
      ].join('\n'),
    )
    expect(new AlertAcksStore(path).load()).toEqual([
      { id: 'x', at: 1, by: 'legacy:admin' },
    ])
  })

  test('a write that fails is reported and not remembered', async () => {
    const dir = tempDir()
    const blocker = join(dir, 'console')
    writeFileSync(blocker, 'a file where the directory should be')
    const port = createNotifyPort({
      trailPath: join(dir, 'trail.ndjson'),
      acks: new AlertAcksStore(join(blocker, 'alert-acks.ndjson')),
      now: () => NOW,
    })
    const failed = await port.ack('n:a', 'legacy:admin')
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.failure.code).toBe('unreachable')
    expect(await port.acks()).toEqual({ ok: true, value: [] })
  })
})

// ---------------------------------------------------------------------------
// SchedulerPort
// ---------------------------------------------------------------------------

const JOB = {
  id: 'disk-watch',
  title: '每十分钟看一次磁盘',
  target: 'qianmo://beta-1/reviewer',
  url: 'ws://127.0.0.1:38611',
  prompt: '检查 / 的使用率',
  schedule: { everyMs: 600_000, anchorMs: NOW - 3_600_000 },
  taskTtlMs: 900_000,
  notifyPolicy: 'agent-initiated',
}

interface Hub {
  readonly stateDir: string
  readonly estopPath: string
  readonly trailPath: string
  readonly jobsPath: string
}

function hub(jobs: readonly unknown[] = [JOB]): Hub {
  const dir = tempDir()
  const stateDir = join(dir, 'qianmo', 'scheduler')
  const jobsPath = join(dir, 'jobs.json')
  writeFileSync(jobsPath, JSON.stringify(jobs))
  return {
    stateDir,
    estopPath: join(stateDir, 'ESTOP'),
    trailPath: join(dir, 'qianmo', 'audit', 'trail.ndjson'),
    jobsPath,
  }
}

function port(h: Hub, withJobs = true, now = NOW) {
  return createSchedulerPort({
    stateDir: h.stateDir,
    estopPath: h.estopPath,
    trailPath: h.trailPath,
    ...(withJobs ? { jobsPath: h.jobsPath } : {}),
    now: () => now,
  })
}

/** The state `qm watch` leaves behind, written by the scheduler's own store. */
function retire(
  h: Hub,
  jobId: string,
  fireAtMs: number,
  outcome: 'completed' | 'failed' | 'skipped' | 'preempted',
  at: number,
): void {
  new SchedulerStore(h.stateDir, { now: () => at }).recordFire(
    jobId,
    fireAtMs,
    outcome,
  )
}

async function snapshot(p: ReturnType<typeof port>) {
  const read = await p.read()
  if (!read.ok) throw new Error(`read failed: ${read.failure.message}`)
  return read.value
}

describe('SchedulerPort', () => {
  test('a job: its definition, the slot it last retired, and the next one the runner would act on', async () => {
    const h = hub()
    const lastSlot = NOW - 600_000
    retire(h, 'disk-watch', lastSlot, 'completed', lastSlot + 2_000)
    const value = await snapshot(port(h))
    expect(value.tick).toEqual({
      state: 'unwired',
      reason: 'qm watch 是独立进程 · 最后一次运行只在它的内存里',
    })
    expect(value.estop).toEqual({ state: 'released' })
    expect(value.definitions).toEqual({ state: 'wired', source: h.jobsPath })
    const expected = planFire({
      job: assertJob(JOB),
      lastFiredAt: lastSlot,
      now: NOW,
    })
    expect(value.jobs).toEqual([
      {
        id: 'disk-watch',
        title: '每十分钟看一次磁盘',
        everyMs: 600_000,
        notifyPolicy: 'agent-initiated',
        target: 'qianmo://beta-1/reviewer',
        listed: true,
        last: {
          at: lastSlot,
          outcome: 'completed',
          recordedAt: lastSlot + 2_000,
        },
        consecutiveFailures: 0,
        next: expected.fireAtMs,
      },
    ])
    // The anchored grid: the slot at NOW is due.
    expect(expected.fireAtMs).toBe(NOW)
  })

  test('a failing job carries the hold its backoff imposes', async () => {
    const h = hub()
    retire(h, 'disk-watch', NOW - 1_200_000, 'failed', NOW - 20_000)
    retire(h, 'disk-watch', NOW - 600_000, 'failed', NOW - 10_000)
    const job = (await snapshot(port(h))).jobs[0]
    expect(job?.consecutiveFailures).toBe(2)
    expect(job?.holdUntil).toBe(NOW - 10_000 + backoffMs(2))
  })

  test('the emergency stop: absent, then present with its mtime', async () => {
    const h = hub()
    expect((await snapshot(port(h))).estop).toEqual({ state: 'released' })
    mkdirSync(h.stateDir, { recursive: true })
    writeFileSync(h.estopPath, '')
    const engaged = (await snapshot(port(h))).estop
    expect(engaged).toEqual({
      state: 'engaged',
      since: Math.floor(statSync(h.estopPath).mtimeMs),
    })
  })

  test('a job the state remembers and the file no longer lists, with its target and result from the trail', async () => {
    const h = hub()
    retire(h, 'old-job', NOW - 7_200_000, 'completed', NOW - 7_100_000)
    const trail = new AuditTrail(h.trailPath)
    trail.append({
      at: NOW - 7_100_000,
      source: AuditSource.Scheduler,
      kind: 'watch_fire',
      outcome: 'ok',
      node: 'hub',
      peer: 'qianmo://beta-2/writer',
      detail: { jobId: 'old-job', fireAtMs: NOW - 7_200_000, attempt: 1 },
    })
    trail.append({
      at: NOW - 7_000_000,
      source: AuditSource.Scheduler,
      kind: 'watch_result_received',
      outcome: 'ok',
      node: 'hub',
      peer: 'qianmo://beta-2/writer',
      code: 'E_TASK_FAILED',
      detail: { contextId: 'old-job', result: 'failed' },
    })
    const jobs = (await snapshot(port(h))).jobs
    expect(jobs.map(job => job.id)).toEqual(['disk-watch', 'old-job'])
    expect(jobs[1]).toEqual({
      id: 'old-job',
      target: 'qianmo://beta-2/writer',
      listed: false,
      last: {
        at: NOW - 7_200_000,
        outcome: 'completed',
        recordedAt: NOW - 7_100_000,
      },
      consecutiveFailures: 0,
      result: { at: NOW - 7_000_000, result: 'failed', code: 'E_TASK_FAILED' },
    })
  })

  test('without the jobs file: definitions unwired, no period, no next fire', async () => {
    const h = hub()
    retire(h, 'disk-watch', NOW - 600_000, 'completed', NOW - 598_000)
    const value = await snapshot(port(h, false))
    expect(value.definitions.state).toBe('unwired')
    expect(value.jobs).toEqual([
      {
        id: 'disk-watch',
        listed: false,
        last: {
          at: NOW - 600_000,
          outcome: 'completed',
          recordedAt: NOW - 598_000,
        },
        consecutiveFailures: 0,
      },
    ])
  })

  test('a state file that does not parse is a failure, not an empty table', async () => {
    const h = hub()
    mkdirSync(h.stateDir, { recursive: true })
    writeFileSync(join(h.stateDir, 'state.json'), '{not json')
    const read = await port(h).read()
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.failure.code).toBe('unreachable')
  })

  test('a jobs file qm watch would refuse is refused here too', async () => {
    const h = hub([{ ...JOB, notifyPolicy: 'loud' }])
    const read = await port(h).read()
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.failure.code).toBe('invalid')
  })

  test('reading never writes into the scheduler directory', async () => {
    const h = hub()
    retire(h, 'disk-watch', NOW - 600_000, 'completed', NOW - 598_000)
    chmodSync(h.stateDir, 0o700)
    const before = readdirSync(h.stateDir).sort()
    const stateBefore = readFileSync(join(h.stateDir, 'state.json'), 'utf8')
    for (let index = 0; index < 3; index++) await snapshot(port(h))
    expect(readdirSync(h.stateDir).sort()).toEqual(before)
    expect(readFileSync(join(h.stateDir, 'state.json'), 'utf8')).toBe(
      stateBefore,
    )
  })
})

describe('the production wiring', () => {
  test('reads exactly where qm watch writes, all derived from the config root', async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR
    const root = join(tempDir(), 'config')
    process.env.CLAUDE_CONFIG_DIR = root
    try {
      // CLAUDE.md §1.1②: OCC_CONFIG_DIR / CLAUDE_CONFIG_DIR must hold for it.
      expect(consoleAlertAcksPath()).toBe(
        join(root, 'qianmo', 'console', 'alert-acks.ndjson'),
      )
      // What qm watch itself would use on this root: its default state
      // directory, its ESTOP and its trail (`openAuditTrail`).
      const watch = parseWatchArgs(
        ['--jobs', '/dev/null', '--from', 'qianmo://hub/console'],
        'qianmo',
      )
      if (watch.mode !== 'run') throw new Error('unexpected mode')
      new SchedulerStore(watch.stateDir, { now: () => NOW }).recordFire(
        'disk-watch',
        NOW - 600_000,
        'completed',
      )
      writeFileSync(join(watch.stateDir, 'ESTOP'), '')
      appendNotice(openAuditTrail(), { msgId: 'from-watch' })

      const deps = consoleWatchDeps()
      const value = await deps.scheduler.read()
      if (!value.ok) throw new Error(value.failure.message)
      expect(value.value.estop.state).toBe('engaged')
      expect(value.value.jobs.map(job => job.id)).toEqual(['disk-watch'])
      const notices = await deps.notify.notices(10)
      if (!notices.ok) throw new Error(notices.failure.message)
      expect(notices.value.notices.map(one => one.id)).toEqual(['n:from-watch'])
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
  })
})
