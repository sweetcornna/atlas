// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { appendFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { IDENTITY_MODE, type IdentityMode } from '../../constants/identity.js'
import { QianmoResident } from '../../services/qianmo/resident.js'
import {
  DEFAULT_RESIDENT_ACTIVITY_TIME_JUMP_FACTOR,
  ResidentActivityReporter,
} from '@qianmo/resident/activity'
import type { ResidentTimingEvent } from '@qianmo/resident/timings'
import { assertTeamName, isReservedDeviceName } from '@qianmo/adapter/names'
import { remoteSnapshotWriter } from '@qianmo/backup'
import {
  openAuditTrail,
  routerTrailSink,
  transportTrailSink,
} from '../../services/qianmo/auditTrail.js'
import {
  NodeCapabilities,
  SIGNED_TASK_POLICY,
  StaticPublicKeyDirectory,
} from '@qianmo/capability'
import { isValidSegment } from '@qianmo/protocol'
import { pskFromEnv } from '@qianmo/transport'
import {
  loadOrCreateNodeKeys,
  parseTrustedKey,
} from '../../services/qianmo/nodeIdentity.js'
import { residentOptionValue } from './residentArgs.js'

export const MAX_PENDING_TIMING_EVENTS = 1_024

interface ResidentNdjsonWriter<T> {
  write(record: T): void
  close(): Promise<void>
}

/**
 * 一条内存采样。P7.3 的**进程内**通道，与 `demo/lib/p73-sample.ts` 的外部
 * `/proc` 通道互为对照：外部那条看得见 RSS 与 cgroup，看不见 JS 堆；这条相反。
 *
 * **`heapSize` 来自 `bun:jsc`，不是 `process.memoryUsage().heapUsed`。**
 * `docs/zh/memory-peak-analysis.md`「测量方法上的五个坑」第 1 条：Bun 1.3.13 下
 * `heapUsed` 是**冻结常量**——分配 5 万个字符串前后都报 ~212 KB。用它采 24 h，
 * 得到的是一条完美的平线和一个完全错误的结论。这一条钉在这里，别再改回去。
 *
 * 同一份文档第 4 条补了另一半：`heapSize` **不计大字符串的 backing store**，
 * 所以 `rss` 必须同时采——两条线一起看才知道涨的是对象还是字节。
 *
 * **读这些样本前先看 `docs/dev/baseline-m0.md` §2.3 ④**：`heapSize` 与 `objectCount`
 * 是**滞后**指标（实测分配 30 万个对象之后它们纹丝不动，而 `rss` 已经涨了 59 MB），
 * 单点持平说明不了任何事，要按多点斜率读。
 */
interface ResidentMemSample {
  /** Epoch ms。 */
  readonly at: number
  /** 常驻进程的 RSS，字节。JS 堆之外的一切都只在这条线上。 */
  readonly rss: number
  /** `heapStats().heapSize`，字节。 */
  readonly heapSize: number
  /** `heapStats().heapCapacity`，字节。 */
  readonly heapCapacity: number
  /** `heapStats().objectCount`。 */
  readonly objectCount: number
  /** `process.uptime()`，秒。用来把采样对齐到「跑了多久」而不是墙上时刻。 */
  readonly uptime: number
}

function createNdjsonWriter<T>(
  path: string,
  onError: (error: unknown) => void,
  overflowMessage: string,
): ResidentNdjsonWriter<T> {
  let queue: string[] = []
  let pending = 0
  let writing: Promise<void> | null = null
  let closed = false
  let overflowReported = false

  const drain = (): void => {
    if (writing !== null || queue.length === 0) return
    const batch = queue
    queue = []
    writing = appendFile(path, batch.join(''))
      .catch(onError)
      .finally(() => {
        pending -= batch.length
        writing = null
        drain()
      })
  }

  return {
    write(record): void {
      if (closed) return
      if (pending >= MAX_PENDING_TIMING_EVENTS) {
        if (!overflowReported) {
          overflowReported = true
          onError(new Error(overflowMessage))
        }
        return
      }
      queue.push(`${JSON.stringify(record)}\n`)
      pending++
      queueMicrotask(drain)
    },
    async close(): Promise<void> {
      closed = true
      drain()
      while (pending > 0) {
        const current = writing
        if (current !== null) await current
        else drain()
      }
    },
  }
}

export function createResidentTimingWriter(
  path: string,
  onError: (error: unknown) => void,
): ResidentNdjsonWriter<ResidentTimingEvent> {
  return createNdjsonWriter(
    path,
    onError,
    'resident timing writer queue overflow',
  )
}

/**
 * 内存采样的落盘 writer —— 与 `--timings` 同一形状：同一个 1024 队列上限、同一条
 * 「只报一次」的溢出警告、同一个 close 语义。
 *
 * 上限对内存采样这条路径其实绰绰有余（默认 60 s 一条），保留它不是为了防溢出，
 * 而是为了让**溢出这件事仍然可见**：一条溢出警告意味着这个数据集缺了不知道多少条，
 * P7.3 的判据据此把整份数据判为不可用（`demo/lib/p73-report-core.ts`）。
 */
export function createResidentMemWriter(
  path: string,
  onError: (error: unknown) => void,
): ResidentNdjsonWriter<ResidentMemSample> {
  return createNdjsonWriter(
    path,
    onError,
    'resident memory writer queue overflow',
  )
}

/**
 * `bun:jsc` 只在**运行期**解析，绝不进静态模块图。
 *
 * 这个文件被 `src/entrypoints/cli.tsx` 动态 import，所以它在 vite 的打包图里；
 * 而 `vite.config.ts` 的 `ssr.noExternal: true` 要求 rollup 把一切内联，一个
 * `bun:` specifier 它解析不了。写成不可静态折叠的形式，rollup 就只会原样留着它。
 * 常驻模式本来就断言了 Bun 运行时（`assertResidentRuntime`），所以真到用的时候
 * 模块一定在。
 */
const JSC_MODULE = ['bun', 'jsc'].join(':')

interface HeapStatsSnapshot {
  readonly heapSize: number
  readonly heapCapacity: number
  readonly objectCount: number
}

async function loadHeapStats(): Promise<() => HeapStatsSnapshot> {
  const loaded: unknown = await import(JSC_MODULE)
  const heapStats = (loaded as { heapStats?: unknown }).heapStats
  if (typeof heapStats !== 'function') {
    throw new Error('bun:jsc did not export heapStats')
  }
  return heapStats as () => HeapStatsSnapshot
}

/** `--mem-sample` 的默认采样间隔：与 P7.3 的 24 h 长跑节拍一致。 */
export const DEFAULT_RESIDENT_MEM_INTERVAL_MS = 60_000

interface ResidentCliConfig {
  readonly node: string
  readonly team: string
  readonly agents: readonly { agent: string; cwd: string }[]
  readonly port?: number
  readonly hostname?: string
  readonly unix?: string
  readonly activityUrl?: string
  readonly activityReconnectFactor?: number
  readonly timings?: string
  /** P7.3 内存基线的落盘路径（NDJSON）。 */
  readonly memSample?: string
  /** 采样间隔，仅在 `memSample` 存在时有意义。 */
  readonly memIntervalMs?: number
  /** `<node>=<publicKey>` pairs this node will accept capabilities from. */
  readonly trusted: readonly (readonly [string, string])[]
  /** Require `write-limited` for work, rather than admitting unsigned tasks. */
  readonly requireSignedTasks: boolean
  /** Base URL of the host-side backup service (P4.4). */
  readonly backupUrl?: string
  /** Gap between scheduled workspace snapshots. */
  readonly backupIntervalMs?: number
}

export function parseResidentArgs(
  args: readonly string[],
  identity: IdentityMode = IDENTITY_MODE,
): ResidentCliConfig {
  let node: string | undefined
  let team: string | undefined
  let port: number | undefined
  let hostname: string | undefined
  let unix: string | undefined
  let activityUrl: string | undefined
  let activityReconnectFactor: number | undefined
  let timings: string | undefined
  let memSample: string | undefined
  let memIntervalMs: number | undefined
  let requireSignedTasks = false
  let backupUrl: string | undefined
  let backupIntervalMs: number | undefined
  const trusted: Array<readonly [string, string]> = []
  const agents: Array<{ agent: string; cwd: string }> = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--node' || arg?.startsWith('--node=')) {
      const parsed = residentOptionValue(args, index, '--node')
      node = parsed.value
      index = parsed.next
    } else if (arg === '--team' || arg?.startsWith('--team=')) {
      const parsed = residentOptionValue(args, index, '--team')
      team = parsed.value
      index = parsed.next
    } else if (arg === '--agent' || arg?.startsWith('--agent=')) {
      const parsed = residentOptionValue(args, index, '--agent')
      const separator = parsed.value.indexOf('=')
      if (separator <= 0) {
        throw new Error('--agent must be <name>=<absolute-cwd>')
      }
      const agent = parsed.value.slice(0, separator)
      const cwd = parsed.value.slice(separator + 1)
      if (!isValidSegment(agent) || isReservedDeviceName(agent)) {
        throw new Error(`invalid resident agent ${JSON.stringify(agent)}`)
      }
      if (!isAbsolute(cwd))
        throw new Error('resident agent cwd must be absolute')
      agents.push({ agent, cwd: resolve(cwd) })
      index = parsed.next
    } else if (arg === '--port' || arg?.startsWith('--port=')) {
      const parsed = residentOptionValue(args, index, '--port')
      const number = Number(parsed.value)
      if (!Number.isInteger(number) || number < 0 || number > 65_535) {
        throw new Error('--port must be an integer from 0 to 65535')
      }
      port = number
      index = parsed.next
    } else if (arg === '--hostname' || arg?.startsWith('--hostname=')) {
      const parsed = residentOptionValue(args, index, '--hostname')
      if (parsed.value.trim() === '')
        throw new Error('--hostname must not be empty')
      hostname = parsed.value
      index = parsed.next
    } else if (arg === '--unix' || arg?.startsWith('--unix=')) {
      const parsed = residentOptionValue(args, index, '--unix')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--unix must be an absolute path')
      }
      unix = resolve(parsed.value)
      index = parsed.next
    } else if (arg === '--activity-url' || arg?.startsWith('--activity-url=')) {
      const parsed = residentOptionValue(args, index, '--activity-url')
      const url = new URL(parsed.value)
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        throw new Error('--activity-url must use ws or wss')
      }
      activityUrl = url.toString()
      index = parsed.next
    } else if (
      arg === '--activity-reconnect-factor' ||
      arg?.startsWith('--activity-reconnect-factor=')
    ) {
      const parsed = residentOptionValue(
        args,
        index,
        '--activity-reconnect-factor',
      )
      const factor = Number(parsed.value)
      if (!Number.isFinite(factor) || factor <= 1) {
        throw new Error('--activity-reconnect-factor must be greater than 1')
      }
      activityReconnectFactor = factor
      index = parsed.next
    } else if (arg === '--trust' || arg?.startsWith('--trust=')) {
      const parsed = residentOptionValue(args, index, '--trust')
      trusted.push(parseTrustedKey(parsed.value))
      index = parsed.next
    } else if (arg === '--require-signed-tasks') {
      requireSignedTasks = true
    } else if (arg === '--backup-url' || arg?.startsWith('--backup-url=')) {
      const parsed = residentOptionValue(args, index, '--backup-url')
      const url = new URL(parsed.value)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('--backup-url must use http or https')
      }
      backupUrl = url.toString()
      index = parsed.next
    } else if (
      arg === '--backup-interval-ms' ||
      arg?.startsWith('--backup-interval-ms=')
    ) {
      const parsed = residentOptionValue(args, index, '--backup-interval-ms')
      const interval = Number(parsed.value)
      if (!Number.isInteger(interval) || interval < 1_000) {
        throw new Error('--backup-interval-ms must be an integer >= 1000')
      }
      backupIntervalMs = interval
      index = parsed.next
    } else if (arg === '--timings' || arg?.startsWith('--timings=')) {
      const parsed = residentOptionValue(args, index, '--timings')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--timings must be an absolute path')
      }
      timings = resolve(parsed.value)
      index = parsed.next
    } else if (arg === '--mem-sample' || arg?.startsWith('--mem-sample=')) {
      const parsed = residentOptionValue(args, index, '--mem-sample')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--mem-sample must be an absolute path')
      }
      memSample = resolve(parsed.value)
      index = parsed.next
    } else if (
      arg === '--mem-interval-ms' ||
      arg?.startsWith('--mem-interval-ms=')
    ) {
      const parsed = residentOptionValue(args, index, '--mem-interval-ms')
      const interval = Number(parsed.value)
      if (!Number.isInteger(interval) || interval < 1_000) {
        throw new Error('--mem-interval-ms must be an integer >= 1000')
      }
      memIntervalMs = interval
      index = parsed.next
    } else {
      throw new Error(`unknown resident option ${String(arg)}`)
    }
  }

  if (identity !== 'qianmo') {
    throw new Error('resident mode requires OCC_IDENTITY=qianmo')
  }
  if (!isValidSegment(node) || isReservedDeviceName(node)) {
    throw new Error('resident --node must be a valid non-reserved segment')
  }
  if (team === undefined) throw new Error('resident --team is required')
  assertTeamName(team)
  if (agents.length === 0)
    throw new Error('resident requires at least one --agent')
  if (new Set(agents.map(agent => agent.agent)).size !== agents.length) {
    throw new Error('resident agent names must be unique')
  }
  if (port !== undefined && unix !== undefined) {
    throw new Error('resident takes either --port or --unix, not both')
  }
  if (port === undefined && unix === undefined) {
    throw new Error('resident requires --port or --unix')
  }
  if (port !== undefined && hostname === undefined) {
    throw new Error('resident TCP listen requires explicit --hostname')
  }
  if (unix !== undefined && hostname !== undefined) {
    throw new Error('--hostname is only valid with --port')
  }
  if (activityReconnectFactor !== undefined && activityUrl === undefined) {
    throw new Error('--activity-reconnect-factor requires --activity-url')
  }
  if (backupIntervalMs !== undefined && backupUrl === undefined) {
    throw new Error('--backup-interval-ms requires --backup-url')
  }
  if (memIntervalMs !== undefined && memSample === undefined) {
    throw new Error('--mem-interval-ms requires --mem-sample')
  }
  return {
    node,
    team,
    agents,
    ...(port === undefined ? {} : { port }),
    ...(hostname === undefined ? {} : { hostname }),
    ...(unix === undefined ? {} : { unix }),
    ...(activityUrl === undefined
      ? {}
      : {
          activityUrl,
          activityReconnectFactor:
            activityReconnectFactor ??
            DEFAULT_RESIDENT_ACTIVITY_TIME_JUMP_FACTOR,
        }),
    ...(timings === undefined ? {} : { timings }),
    ...(memSample === undefined
      ? {}
      : {
          memSample,
          memIntervalMs: memIntervalMs ?? DEFAULT_RESIDENT_MEM_INTERVAL_MS,
        }),
    trusted,
    requireSignedTasks,
    ...(backupUrl === undefined ? {} : { backupUrl }),
    ...(backupIntervalMs === undefined ? {} : { backupIntervalMs }),
  }
}

export function assertResidentRuntime(
  bunAvailable: boolean = typeof Bun !== 'undefined',
): void {
  if (!bunAvailable) {
    throw new Error('resident mode requires the Bun runtime')
  }
}

export async function runResident(args: readonly string[]): Promise<void> {
  assertResidentRuntime()
  const config = parseResidentArgs(args)
  const psk = pskFromEnv()
  const activity =
    config.activityUrl === undefined
      ? null
      : new ResidentActivityReporter({
          node: config.node,
          endpoint: { url: config.activityUrl },
          psk,
          ...(config.activityReconnectFactor === undefined
            ? {}
            : {
                reconnectTimeJumpFactor: config.activityReconnectFactor,
              }),
        })
  if (activity !== null) {
    void activity.connect().catch(error => {
      console.error('[resident activity]', error)
    })
  }
  let timingWriteFailed = false
  const reportTimingError = (error: unknown): void => {
    if (timingWriteFailed) return
    timingWriteFailed = true
    console.error('[resident timing]', error)
  }
  const timingWriter =
    config.timings === undefined
      ? null
      : createResidentTimingWriter(config.timings, reportTimingError)

  // P7.3 内存基线的进程内通道。与上面的 timing writer 同一形状，同一「只报一次」。
  //
  // **不做任何 GC。**一次 `Bun.gc(true)` 会把被测对象本身改掉：24 h 长跑要观测的
  // 正是「不干预时堆怎么走」，采样器替它清一遍，测到的就是采样器的节拍而不是常驻
  // 进程的行为。GC 检查点由跑批方在需要时手动触发，不进这个包。
  let memWriteFailed = false
  const reportMemError = (error: unknown): void => {
    if (memWriteFailed) return
    memWriteFailed = true
    console.error('[resident mem]', error)
  }
  const memWriter =
    config.memSample === undefined
      ? null
      : createResidentMemWriter(config.memSample, reportMemError)
  let memTimer: ReturnType<typeof setInterval> | null = null
  if (memWriter !== null) {
    const heapStats = await loadHeapStats()
    const sample = (): void => {
      const stats = heapStats()
      memWriter.write({
        at: Date.now(),
        rss: process.memoryUsage.rss(),
        heapSize: stats.heapSize,
        heapCapacity: stats.heapCapacity,
        objectCount: stats.objectCount,
        uptime: process.uptime(),
      })
    }
    // 先采一条，让数据集有 t=0：24 h 曲线的第一个间隔缺了，斜率就从第二个点起算。
    sample()
    memTimer = setInterval(
      sample,
      config.memIntervalMs ?? DEFAULT_RESIDENT_MEM_INTERVAL_MS,
    )
    // 采样器不该是让进程活着的理由。
    memTimer.unref?.()
  }
  // The node's own identity, created on first run and never replaced (P4.3).
  // Its public half is printed rather than published: M0 has no key
  // distribution, so whoever registers this agent copies the key into the
  // registry by hand, and a node that quietly learned keys from its peers
  // would be a node any peer could impersonate.
  const keys = loadOrCreateNodeKeys(config.node)
  const directory = new StaticPublicKeyDirectory(config.trusted)
  // Its own key is always trusted: rule S-1 accepts `user-confirmed` only when
  // this node signed it, which means verifying its own signature.
  directory.put(config.node, keys.publicKey)
  const capability = new NodeCapabilities({
    node: config.node,
    directory,
    keys,
    ...(config.requireSignedTasks ? { policy: SIGNED_TASK_POLICY } : {}),
  })
  process.stdout.write(
    `${JSON.stringify({
      node: config.node,
      publicKey: keys.publicKey,
      requireSignedTasks: config.requireSignedTasks,
      trusts: config.trusted.map(([node]) => node),
    })}\n`,
  )

  // The write-only backup credential comes from the environment, never from a
  // flag: a token on a command line is a token in every process listing on the
  // machine. Same injection point discipline as the transport PSK.
  const backupToken = process.env['QIANMO_BACKUP_WRITE_TOKEN']
  if (config.backupUrl !== undefined && (backupToken ?? '') === '') {
    throw new Error('--backup-url requires QIANMO_BACKUP_WRITE_TOKEN')
  }
  const backup =
    config.backupUrl === undefined
      ? undefined
      : {
          writer: remoteSnapshotWriter({
            url: config.backupUrl,
            token: backupToken as string,
          }),
          ...(config.backupIntervalMs === undefined
            ? {}
            : { intervalMs: config.backupIntervalMs }),
        }

  // The durable trail (P7.2). Opened here rather than inside the node because
  // this is the layer that owns paths, and because a trail is per *process*:
  // two residents on one machine each continue their own file.
  const trail = openAuditTrail()

  const resident = new QianmoResident({
    node: config.node,
    team: config.team,
    agents: config.agents,
    psk,
    capability,
    auditSink: routerTrailSink(trail, config.node),
    transportEvents: transportTrailSink(trail, config.node),
    ...(backup === undefined ? {} : { backup }),
    listen: {
      ...(config.port === undefined ? {} : { port: config.port }),
      ...(config.hostname === undefined ? {} : { hostname: config.hostname }),
      ...(config.unix === undefined ? {} : { unix: config.unix }),
    },
    onActivity: async active => {
      try {
        await activity?.report(active)
      } catch (error) {
        console.error('[resident activity]', error)
      }
    },
    ...(config.activityUrl === undefined
      ? {}
      : {
          activityReconnectFactor:
            config.activityReconnectFactor ??
            DEFAULT_RESIDENT_ACTIVITY_TIME_JUMP_FACTOR,
        }),
    ...(timingWriter === null
      ? {}
      : {
          onTiming: (event: ResidentTimingEvent) => timingWriter.write(event),
        }),
    onError: error => {
      console.error('[resident]', error)
    },
  })

  const stop = (): void => resident.stop()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    await resident.run()
  } finally {
    if (memTimer !== null) clearInterval(memTimer)
    trail.close()
    await timingWriter?.close()
    await memWriter?.close()
    await activity?.close()
  }
}
