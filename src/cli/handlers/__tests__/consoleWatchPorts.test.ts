// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 告警与值守作业两个端口的生产实现（P18.15），全部对着真文件：真的审计链
 * （`@qianmo/audit` 的 `AuditTrail`）、真的调度状态（`@qianmo/scheduler` 的
 * `SchedulerStore` 写出来的 `state.json` 与 `writeSchedulerStatus` 写出来的
 * `status.json`）、真的急停哨兵；最后一组跑真的 `qm watch --once` 再读真的作业页。
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
import { createConsoleHandler } from '@qianmo/console'
import {
  SCHEDULER_STATUS_FILE,
  SchedulerStore,
  backoffMs,
  describeSchedule,
  readSchedulerStatus,
  writeSchedulerStatus,
  type SchedulerStatusFile,
  type SchedulerStatusJob,
} from '@qianmo/scheduler'
import { PSK_ENV_VAR } from '@qianmo/transport'
import { AlertAcksStore, consoleAlertAcksPath } from '../consoleAlertAcks.js'
import {
  consoleLimits,
  consoleWatchDeps,
  createNotifyPort,
  createSchedulerPort,
} from '../consolePorts.js'
import { parseWatchArgs, runWatchJobs } from '../watch.js'
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
  prompt: '检查 / 的使用率',
  schedule: { everyMs: 600_000, anchorMs: NOW - 3_600_000 },
  taskTtlMs: 900_000,
  notifyPolicy: 'agent-initiated' as const,
}

interface Hub {
  readonly stateDir: string
  readonly estopPath: string
  readonly trailPath: string
}

function hub(): Hub {
  const dir = tempDir()
  const stateDir = join(dir, 'qianmo', 'scheduler')
  return {
    stateDir,
    estopPath: join(stateDir, 'ESTOP'),
    trailPath: join(dir, 'qianmo', 'audit', 'trail.ndjson'),
  }
}

function port(h: Hub, now = NOW) {
  return createSchedulerPort({
    stateDir: h.stateDir,
    estopPath: h.estopPath,
    trailPath: h.trailPath,
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

/** `status.json` as `qm watch` writes it, through the scheduler's own writer. */
function writeStatus(
  h: Hub,
  over: Partial<SchedulerStatusFile> = {},
  job: Partial<SchedulerStatusJob> = {},
): SchedulerStatusFile {
  const status: SchedulerStatusFile = {
    version: 1,
    pid: 4242,
    lastTickAt: NOW - 20_000,
    tickMs: 60_000,
    jobs: [
      {
        id: JOB.id,
        title: JOB.title,
        target: JOB.target,
        schedule: describeSchedule(JOB.schedule),
        everyMs: JOB.schedule.everyMs,
        lastFireAt: NOW - 600_000,
        lastResult: 'completed',
        nextFireAt: NOW,
        consecutiveFailures: 0,
        ...job,
      },
    ],
    ...over,
  }
  writeSchedulerStatus(h.stateDir, status)
  return status
}

async function snapshot(p: ReturnType<typeof port>) {
  const read = await p.read()
  if (!read.ok) throw new Error(`read failed: ${read.failure.message}`)
  return read.value
}

describe('SchedulerPort with status.json', () => {
  test('heartbeat and its yardstick, the job as the runner saw it, the landing time from state.json', async () => {
    const h = hub()
    retire(h, 'disk-watch', NOW - 600_000, 'completed', NOW - 598_000)
    writeStatus(h)
    const value = await snapshot(port(h))
    expect(value.tick).toEqual({
      state: 'seen',
      at: NOW - 20_000,
      everyMs: 60_000,
    })
    expect(value.estop).toEqual({ state: 'released' })
    expect(value.definitions).toEqual({
      state: 'wired',
      source: join(h.stateDir, SCHEDULER_STATUS_FILE),
    })
    expect(value.jobs).toEqual([
      {
        id: 'disk-watch',
        title: '每十分钟看一次磁盘',
        target: 'qianmo://beta-1/reviewer',
        everyMs: 600_000,
        listed: true,
        last: {
          at: NOW - 600_000,
          outcome: 'completed',
          recordedAt: NOW - 598_000,
        },
        consecutiveFailures: 0,
        next: NOW,
      },
    ])
  })

  test('a failing job: its next fire from the file, and the hold its backoff imposes', async () => {
    const h = hub()
    retire(h, 'disk-watch', NOW - 1_200_000, 'failed', NOW - 20_000)
    retire(h, 'disk-watch', NOW - 600_000, 'failed', NOW - 10_000)
    const holdUntil = NOW - 10_000 + backoffMs(2)
    writeStatus(
      h,
      {},
      { lastResult: 'failed', consecutiveFailures: 2, nextFireAt: holdUntil },
    )
    const job = (await snapshot(port(h))).jobs[0]
    expect(job?.consecutiveFailures).toBe(2)
    expect(job?.next).toBe(holdUntil)
    expect(job?.holdUntil).toBe(holdUntil)
  })

  test('a job the state remembers and the running scheduler does not, with its target and result from the trail', async () => {
    const h = hub()
    writeStatus(h)
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
})

describe('SchedulerPort without status.json', () => {
  test('absent: heartbeat and definitions unwired, saying why, and the job from state.json alone', async () => {
    const h = hub()
    retire(h, 'disk-watch', NOW - 600_000, 'completed', NOW - 598_000)
    const value = await snapshot(port(h))
    expect(value.tick).toEqual({
      state: 'unwired',
      reason: 'qm watch 没有写出状态文件',
    })
    expect(value.definitions).toEqual({
      state: 'unwired',
      reason: 'qm watch 没有写出状态文件 · 作业定义只在它的内存里',
    })
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

  test('unreadable: the same fallback, and the reason is the file', async () => {
    const h = hub()
    mkdirSync(h.stateDir, { recursive: true })
    writeFileSync(join(h.stateDir, SCHEDULER_STATUS_FILE), '{"version":1,')
    expect((await snapshot(port(h))).tick).toEqual({
      state: 'unwired',
      reason: '状态文件读不出来 · not JSON',
    })
    writeStatus(h, { version: 2 as 1 })
    expect((await snapshot(port(h))).tick).toEqual({
      state: 'unwired',
      reason: '状态文件读不出来 · version 2',
    })
  })
})

describe('SchedulerPort, either way', () => {
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

  test('a state file that does not parse is a failure, not an empty table', async () => {
    const h = hub()
    writeStatus(h)
    writeFileSync(join(h.stateDir, 'state.json'), '{not json')
    const read = await port(h).read()
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.failure.code).toBe('unreachable')
  })

  test('reading never writes into the scheduler directory', async () => {
    const h = hub()
    retire(h, 'disk-watch', NOW - 600_000, 'completed', NOW - 598_000)
    writeStatus(h)
    chmodSync(h.stateDir, 0o700)
    const before = readdirSync(h.stateDir).sort()
    const files = ['state.json', SCHEDULER_STATUS_FILE].map(name =>
      readFileSync(join(h.stateDir, name), 'utf8'),
    )
    for (let index = 0; index < 3; index++) await snapshot(port(h))
    expect(readdirSync(h.stateDir).sort()).toEqual(before)
    expect(
      ['state.json', SCHEDULER_STATUS_FILE].map(name =>
        readFileSync(join(h.stateDir, name), 'utf8'),
      ),
    ).toEqual(files)
  })
})

// ---------------------------------------------------------------------------
// The production wiring: a real `qm watch`, a real console
// ---------------------------------------------------------------------------

/** A console on this config root: the production watch ports, nothing else. */
function consoleOnThisRoot() {
  const empty = { ok: true as const, value: [] }
  const refused = {
    ok: false as const,
    failure: { code: 'unsupported' as const, message: 'not in this test' },
  }
  const handle = createConsoleHandler(
    {
      registry: {
        list: () => Promise.resolve(empty),
        register: () => Promise.resolve(refused),
        deregister: () => Promise.resolve(refused),
        heartbeat: () => Promise.resolve(refused),
      },
      audit: {
        read: () => Promise.resolve(refused),
        chain: () => Promise.resolve({ ok: true as const, value: null }),
      },
      limits: consoleLimits(),
      ...consoleWatchDeps(),
    },
    { view: 'view-token-000000000001', admin: 'admin-token-00000000001' },
  )
  return async (path: string): Promise<string> => {
    const response = await handle(
      new Request(`http://console.test${path}`, {
        headers: {
          accept: 'text/html',
          authorization: 'Bearer view-token-000000000001',
        },
      }),
    )
    expect(response.status).toBe(200)
    return await response.text()
  }
}

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

  test('qm watch writes status.json every pass; the jobs page reads it, and says 未接入 again once it is gone', async () => {
    const previousRoot = process.env.CLAUDE_CONFIG_DIR
    const previousPsk = process.env[PSK_ENV_VAR]
    const dir = tempDir()
    const root = join(dir, 'config')
    process.env.CLAUDE_CONFIG_DIR = root
    process.env[PSK_ENV_VAR] = 'qianmo-watch-status-test-psk-000000000000'
    try {
      // A job whose first slot is five minutes out: every pass plans it and
      // none dials anything, so the two passes below touch no network.
      const everyMs = 600_000
      const start = Date.now() + 300_000
      const jobsPath = join(dir, 'jobs.json')
      writeFileSync(
        jobsPath,
        JSON.stringify([
          {
            ...JOB,
            schedule: { everyMs, anchorMs: start },
            url: 'ws://127.0.0.1:9',
          },
        ]),
      )
      // Parsed as the qianmo identity would parse it, so the state directory
      // is qm watch's own default on this root — the one the console reads.
      const config = parseWatchArgs(
        ['--jobs', jobsPath, '--from', 'qianmo://hub/console', '--once'],
        'qianmo',
      )
      if (config.mode !== 'run') throw new Error('unexpected mode')
      const statusPath = join(
        root,
        'qianmo',
        'scheduler',
        SCHEDULER_STATUS_FILE,
      )
      const read = (): SchedulerStatusFile => {
        const status = readSchedulerStatus(join(root, 'qianmo', 'scheduler'))
        if (status.state !== 'ok') throw new Error(`status ${status.state}`)
        return status.status
      }

      // Two real passes of the real scheduler, each its own `qm watch --once`.
      await runWatchJobs(config)
      const first = read()
      expect(statSync(statusPath).mode & 0o777).toBe(0o600)
      expect(first.pid).toBe(process.pid)
      expect(first.tickMs).toBe(60_000)
      expect(first.jobs).toEqual([
        {
          id: 'disk-watch',
          title: JOB.title,
          target: JOB.target,
          schedule: `every 10m anchored at ${new Date(start).toISOString()}`,
          everyMs,
          nextFireAt: start,
          consecutiveFailures: 0,
        },
      ])
      // Long enough for the clock to move between the two passes.
      const firstTick = first.lastTickAt
      while (Date.now() <= firstTick) {
        await new Promise<void>(resolveTurn => setImmediate(resolveTurn))
      }
      await runWatchJobs(config)
      const second = read()
      expect(second.lastTickAt).toBeGreaterThan(first.lastTickAt)
      expect(second.jobs[0]?.nextFireAt).toBe(start)

      const page = consoleOnThisRoot()
      const live = await page('/jobs')
      expect(live).toContain('刚运行过')
      expect(live).not.toContain('调度器心跳未接入')
      const row = live.slice(live.indexOf('<tr data-key="disk-watch">'))
      expect(row).toContain('<td>10 分</td>')
      expect(row).toContain(`datetime="${new Date(start).toISOString()}"`)
      expect(row).toContain('尚未触发')

      rmSync(statusPath)
      const gone = await page('/jobs')
      expect(gone).toContain(
        '调度器心跳未接入 · qm watch 没有写出状态文件 · 无法判断调度器是否在运行',
      )
      expect(gone).not.toContain('刚运行过')
    } finally {
      if (previousRoot === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousRoot
      if (previousPsk === undefined) delete process.env[PSK_ENV_VAR]
      else process.env[PSK_ENV_VAR] = previousPsk
    }
  })
})
