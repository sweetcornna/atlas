// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { X509Certificate, createPrivateKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { invokedBinName } from '../../constants/brand.js'
import { IDENTITY_MODE, type IdentityMode } from '../../constants/identity.js'
import { QianmoResident } from '../../services/qianmo/resident.js'
import {
  DEFAULT_RESIDENT_ACTIVITY_TIME_JUMP_FACTOR,
  ResidentActivityReporter,
} from '@qianmo/resident/activity'
import type { ResidentTimingEvent } from '@qianmo/resident/timings'
import { assertTeamName, isReservedDeviceName } from '@qianmo/adapter/names'
import {
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  remoteSnapshotWriter,
} from '@qianmo/backup'
import {
  capabilityShadowTrailSink,
  certificateDirectoryTrailSink,
  openAuditTrail,
  residentNotifyTrailSink,
  routerTrailSink,
  transportTrailSink,
} from '../../services/qianmo/auditTrail.js'
import {
  NodeCapabilities,
  SIGNED_TASK_POLICY,
  StaticPublicKeyDirectory,
  type NodeKeyPair,
  type PublicKeyDirectory,
} from '@qianmo/capability'
import type { TLSOptions } from 'bun'
import { isValidSegment } from '@qianmo/protocol'
import {
  PSK_ENV_VAR,
  mutualTlsServerOptions,
  pskFromEnv,
  type ListenerIdentity,
} from '@qianmo/transport'
import {
  CertificateDirectory,
  assertOwnCertificateMatchesIdentity,
  type CertificateDirectoryAuditSink,
} from '../../services/qianmo/certificateDirectory.js'
import {
  loadOrCreateNodeKeys,
  parseTrustedKey,
} from '../../services/qianmo/nodeIdentity.js'
import { residentOptionValue } from './residentArgs.js'

export const MAX_PENDING_TIMING_EVENTS = 1_024

/**
 * The write-only backup credential's only entrance.
 *
 * Hoisted rather than inlined at its one use site because the help text names
 * it too, and an environment variable whose name is spelled twice is an
 * environment variable that can be spelled two ways.
 */
const BACKUP_TOKEN_ENV_VAR = 'QIANMO_BACKUP_WRITE_TOKEN'

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
/**
 * How often the certificate directory re-reads the registry.
 *
 * One hour is §6.4's own number for the revocation list, and the same poll
 * carries the certificates, so there is one clock rather than two. It bounds
 * the window in which a revoked node is still accepted — the design accepts
 * that hour explicitly (§11 T-C) in exchange for not asking anyone to do a
 * weekly chore.
 */
export const DEFAULT_REGISTRY_POLL_INTERVAL_MS = 3_600_000

export interface ResidentCliConfig {
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
  /**
   * Path to the CA root certificate (key-distribution.md §8.1's `--trust-ca`,
   * §8.2 phase ①). When given, peer keys are resolved through a
   * `CertificateDirectory` instead of only `StaticPublicKeyDirectory`;
   * `--trust` entries continue to work and take priority on conflict.
   */
  readonly trustCa?: string
  /** Path to this node's own certificate (§4.1's `<node>.tls.crt`). */
  readonly cert?: string
  /** Path to this node's own TLS private key (§4.1's `<node>.tls.key`). */
  readonly key?: string
  /**
   * Base URL of the registry's HTTP v0 API, polled for peer certificates and
   * the revocation list (§5.1 / §6.4). Requires `--trust-ca`: without a CA
   * root there is nothing to check a published certificate against, and a
   * directory that polls but believes nothing is a network call pretending to
   * be a feature.
   */
  readonly registryUrl?: string
  /**
   * Sign this node's half of every handshake and check a peer's when it signs
   * one (§7.1 / §7.1.1, §8.2 phase ①).
   *
   * Off by default, and that default is the whole of "this package only makes
   * it possible to turn on": with it off the node behaves exactly as it did
   * before, pre-shared key and all.
   */
  readonly signHandshake?: boolean
  /**
   * Refuse a peer that does not sign (§8.2 phase ③). Implies
   * {@link ResidentCliConfig.signHandshake} — this is the switch that retires
   * the pre-shared key on this node, and there is no other.
   */
  readonly requireSignedHandshake?: boolean
  /** Require `write-limited` for work, rather than admitting unsigned tasks. */
  readonly requireSignedTasks: boolean
  /**
   * Observation mode (§9.2 phase ①): record what the enforcing policy would
   * have refused, and refuse nothing.
   *
   * A separate switch from {@link ResidentCliConfig.requireSignedTasks} on
   * purpose, and the separation is the feature — "拿指令进来" and "把数据发出去"
   * are two decisions here too. One knob doing both could not be used to cost
   * the switch without also making it.
   */
  readonly auditSignedTasks: boolean
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
  let auditSignedTasks = false
  let backupUrl: string | undefined
  let backupIntervalMs: number | undefined
  let trustCa: string | undefined
  let cert: string | undefined
  let key: string | undefined
  let registryUrl: string | undefined
  let signHandshake = false
  let requireSignedHandshake = false
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
    } else if (arg === '--trust-ca' || arg?.startsWith('--trust-ca=')) {
      const parsed = residentOptionValue(args, index, '--trust-ca')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--trust-ca must be an absolute path')
      }
      trustCa = resolve(parsed.value)
      index = parsed.next
    } else if (arg === '--cert' || arg?.startsWith('--cert=')) {
      const parsed = residentOptionValue(args, index, '--cert')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--cert must be an absolute path')
      }
      cert = resolve(parsed.value)
      index = parsed.next
    } else if (arg === '--key' || arg?.startsWith('--key=')) {
      const parsed = residentOptionValue(args, index, '--key')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--key must be an absolute path')
      }
      key = resolve(parsed.value)
      index = parsed.next
    } else if (arg === '--registry-url' || arg?.startsWith('--registry-url=')) {
      const parsed = residentOptionValue(args, index, '--registry-url')
      const url = new URL(parsed.value)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('--registry-url must use http or https')
      }
      registryUrl = url.toString()
      index = parsed.next
    } else if (arg === '--sign-handshake') {
      signHandshake = true
    } else if (arg === '--require-signed-handshake') {
      requireSignedHandshake = true
    } else if (arg === '--require-signed-tasks') {
      requireSignedTasks = true
    } else if (arg === '--audit-signed-tasks') {
      auditSignedTasks = true
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
      // 指一下帮助：走到这一支的人多半是拼错了选项名，而在 `--help` 存在之前
      // 他没有任何地方可以去查那张表。
      throw new Error(
        `unknown resident option ${String(arg)}` +
          ` (run \`${invokedBinName()} resident --help\` for the list)`,
      )
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
  // A certificate names a public key; a key backs one. Either alone is
  // almost certainly a copy-paste mistake, not a deliberate configuration —
  // same reasoning as pairing `--activity-reconnect-factor` with
  // `--activity-url`.
  if (cert !== undefined && key === undefined) {
    throw new Error('--cert requires --key')
  }
  if (key !== undefined && cert === undefined) {
    throw new Error('--key requires --cert')
  }
  if (registryUrl !== undefined && trustCa === undefined) {
    throw new Error('--registry-url requires --trust-ca')
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
    ...(trustCa === undefined ? {} : { trustCa }),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
    ...(registryUrl === undefined ? {} : { registryUrl }),
    // `--require-signed-handshake` implies the other: refusing unsigned peers
    // while sending an unsigned frame yourself is a configuration nobody means
    // to write, and it would fail only against the peers that had upgraded.
    ...(signHandshake || requireSignedHandshake ? { signHandshake: true } : {}),
    ...(requireSignedHandshake ? { requireSignedHandshake: true } : {}),
    requireSignedTasks,
    auditSignedTasks,
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

/**
 * `--help` / `-h` 出现在任何位置都算请求帮助。
 *
 * 位置不限，是因为「敲到一半发现忘了选项名」正是人会做的事：
 * `qm resident --port 7321 --help` 必须答帮助，而不是先解析出一个配置再抛。
 * 判定用**全等**，所以 `--team=--help` 这种把它当值的写法不会被当成请求。
 *
 * 为什么不落回 commander：`resident` 的子命令注册
 * （`cli/program/commands/qianmo.tsx`）**刻意不复制选项表**（那个文件的顶部注释
 * 写着这条），落回去只会打印一行描述加一个空的选项列表。选项的唯一出处是本文件
 * 的解析器，帮助文本因此也在这里——两份会漂移的选项表比一份不好看的要糟得多。
 */
export function isResidentHelpRequest(args: readonly string[]): boolean {
  return args.some(arg => arg === '--help' || arg === '-h')
}

/**
 * `occ resident --help` 打印的全文。
 *
 * 常驻节点没有一份对应的选项表文档（`console.md` §3 只管控制台），所以这里是
 * 内测用户手上**唯一**的自助入口：凡是不看源码就会配错的事——三组互斥/依赖关系
 * （`--port` 与 `--unix`、`--hostname` 只跟 `--port`、三个 `*-ms` 各自依赖谁）、
 * 路径必须绝对、以及两枚密钥只走环境变量——都必须在这里说全。
 *
 * 默认值一律插值，不抄数字：它们的出处是各自的常量（CLAUDE.md §1.1⑧）。
 */
export const RESIDENT_HELP_TEXT = `Usage: ${invokedBinName()} resident [options]

Run a Qianmo resident agent node: an inbound-only endpoint that accepts wake
and task messages over the transport and runs them in its agents' workspaces.
Requires OCC_IDENTITY=qianmo, the Bun runtime, and a transport key in
$${PSK_ENV_VAR}.

Options (each accepts both --name value and --name=value):

Identity and workspaces, all required:

  --node <segment>         This node's name, one address segment; it becomes
                           the <node> half of qianmo://<node>/<agent>.
                           Reserved device names are refused.
  --team <name>            The team this node belongs to.
  --agent <name>=<abs cwd>
                           An agent this node serves and the absolute working
                           directory it runs in. Repeatable, one agent per
                           flag; at least one is required and two agents may
                           not share a name.

Listener, exactly one of --port and --unix:

  --port <0-65535>         Listen on TCP. Requires --hostname; 0 lets the
                           kernel pick the port.
  --unix <abs path>        Listen on a Unix socket instead of TCP.
  --hostname <host>        Address to bind, only valid with --port. Never
                           guessed: which interface a node answers on has to
                           be an explicit choice.

Authorization:

  --trust <node>=<publicKey>
                           Accept capability tokens issued by <node>.
                           Repeatable, one peer per flag. There is no
                           trust-on-first-use, so an issuer never named here
                           is refused. This node's own key is always trusted,
                           and its public half is the first line this command
                           prints. Still works with --trust-ca given (§8.2
                           phase ①) and always wins on conflict.
  --trust-ca <abs path>    PEM root certificate of the offline CA
                           (key-distribution.md §5.1, produced by
                           \`${invokedBinName()} ca init\`). Peer keys are then
                           resolved through a certificate directory instead
                           of only --trust: a certificate not signed by this
                           root, expired, or on the revocation list is
                           refused for that peer. An RL that has never been
                           fetched or has gone stale degrades to exactly the
                           --trust entries above, not to full-open or a dead
                           node (§6.4).
  --cert <abs path>        This node's own certificate. Checked at startup
                           against this node's own identity key — a
                           certificate naming a different node or a
                           different key is refused before the node ever
                           opens a listener (K-2). Requires --key.
  --key <abs path>         This node's own TLS private key
                           (\`${invokedBinName()} cert request\` writes one).
                           Requires --cert.
                           With --cert, --key and --trust-ca all present and
                           a TCP listener, mTLS is switched on: the three TLS
                           settings that only work together are applied
                           together (F-10). Missing any of the three, this
                           listener serves plaintext ws:// and says so on
                           stderr rather than looking configured.
  --registry-url <url>     Base URL of the registry's HTTP v0 API, polled
                           every ${DEFAULT_REGISTRY_POLL_INTERVAL_MS / 60_000} minutes for peer certificates and the
                           revocation list. Requires --trust-ca: without a
                           root there is nothing to check a published
                           certificate against. Without this flag the
                           certificate directory has no network source and
                           answers from --trust alone.
  --sign-handshake         Sign this node's half of every handshake with its
                           Ed25519 identity, and check a peer's when it signs
                           one (§7.1.1: both directions, so a redirected
                           endpoint cannot answer for the node it redirected).
                           Peers that do not sign still connect on the
                           pre-shared key — that coexistence is what lets a
                           fleet be upgraded one node at a time.
  --require-signed-handshake
                           Refuse peers that do not sign. Implies
                           --sign-handshake. This is the switch that retires
                           the pre-shared key on this node, and there is no
                           other; turn it on only once every peer signs.
  --require-signed-tasks   Refuse task requests that present no capability
                           token. The default admits them, because M0 has no
                           key distribution, while still verifying in full
                           every token that is presented.
  --audit-signed-tasks     Observation mode: record every message that
                           --require-signed-tasks would have refused, and
                           refuse nothing. Nothing about what this node
                           accepts changes; what appears is one audit line
                           per message, so "what would enforcing cost" is a
                           number before it is an outage. A no-op when
                           --require-signed-tasks is already in force, since
                           the two policies then agree on everything.

Backup:

  --backup-url <url>       Base URL of the host-side backup service, http or
                           https. Also requires $${BACKUP_TOKEN_ENV_VAR}.
  --backup-interval-ms <ms>
                           Gap between scheduled workspace snapshots, an
                           integer >= 1000. Requires --backup-url.
                           Default ${DEFAULT_SNAPSHOT_INTERVAL_MS}.

Activity reporting:

  --activity-url <ws url>  Report this node's idle and active spells to a
                           watcher over ws or wss.
  --activity-reconnect-factor <number>
                           Reconnect backoff growth factor, greater than 1.
                           Requires --activity-url.
                           Default ${DEFAULT_RESIDENT_ACTIVITY_TIME_JUMP_FACTOR}.

Measurement:

  --timings <abs path>     Append per-message timings to an NDJSON file.
  --mem-sample <abs path>  Append heap and RSS samples to an NDJSON file.
  --mem-interval-ms <ms>   Sampling gap, an integer >= 1000.
                           Requires --mem-sample.
                           Default ${DEFAULT_RESIDENT_MEM_INTERVAL_MS}.

  -h, --help               Print this and exit.

Every path above must be absolute. A resident node outlives the shell that
started it, so a relative path means something different to whoever restarts
it from another directory.

Environment:

  OCC_IDENTITY             Must be "qianmo". A resident node is part of the
                           Qianmo node identity, it does not run under plain
                           occ.
  ${PSK_ENV_VAR}     Transport pre-shared key, required — still, even
                           with --require-signed-handshake, because this node
                           also dials out. Environment only, never a
                           command-line option: a key on a command line is a
                           key in every process listing on this machine.
  ${BACKUP_TOKEN_ENV_VAR}
                           Write-only backup credential, required whenever
                           --backup-url is given. Environment only, for the
                           same reason.
  OCC_CONFIG_DIR           Config root the node identity, the audit trail and
                           the session table are derived from.
`

/**
 * Both directory implementations this command can build are mutable in the
 * same way `--trust`'s "this node's own key is always trusted" line needs
 * (`directory.put(config.node, keys.publicKey)` below) — a small local
 * interface rather than importing `StaticPublicKeyDirectory`'s and
 * `CertificateDirectory`'s concrete types side by side at every call site.
 */
interface MutablePublicKeyDirectory extends PublicKeyDirectory {
  put(node: string, publicKey: string): void
}

/**
 * `--trust-ca` replaces `StaticPublicKeyDirectory` with a
 * `CertificateDirectory`; `--trust` entries are handed to either one the same
 * way and, per §8.2 phase ①, always win on conflict with a CA-derived key —
 * `CertificateDirectory` enforces that itself, so there is nothing extra to
 * do here for that *precedence* half of the coexistence rule.
 *
 * The other half is the sink: §8.2 says the conflict is recorded, "不是静默
 * 覆盖". `onAudit` is where that lands, and it is optional here only because
 * the two static callers that build a directory to inspect it (tests) have no
 * trail to write to — the running node always passes one.
 */
export function buildPublicKeyDirectory(
  config: ResidentCliConfig,
  onAudit?: CertificateDirectoryAuditSink,
): MutablePublicKeyDirectory {
  if (config.trustCa === undefined) {
    return new StaticPublicKeyDirectory(config.trusted)
  }
  return new CertificateDirectory({
    caCertificatePem: readFileSync(config.trustCa, 'utf8'),
    trusted: config.trusted,
    ...(config.registryUrl === undefined
      ? {}
      : { registryUrl: config.registryUrl }),
    ...(onAudit === undefined ? {} : { onAudit }),
  })
}

/**
 * `--cert`/`--key` startup self-check (K-2, one of the DoD's four negative
 * cases), run before this node opens a listener.
 *
 * Three separate questions, and each of them fails in a way that would
 * otherwise surface as somebody else's outage days later: does the
 * certificate name this node's own identity key, was it signed by the CA this
 * node trusts, and is the key an EC one Bun will actually accept.
 */
export function assertOwnCertificateAndKey(
  config: ResidentCliConfig,
  ownPublicKey: string,
): void {
  if (config.cert !== undefined) {
    const certificatePem = readFileSync(config.cert, 'utf8')
    assertOwnCertificateMatchesIdentity(
      certificatePem,
      config.node,
      ownPublicKey,
    )
    if (config.trustCa !== undefined) {
      // The check `CertificateDirectory` performs on every *peer* (F-2),
      // turned on this node's own file. A certificate from a CA this node
      // does not trust is not a subtle misconfiguration — the node would
      // present it happily and every peer would refuse it — but without this
      // it survives until the first handshake, which is the worst place to
      // find out.
      const caCertificate = new X509Certificate(
        readFileSync(config.trustCa, 'utf8'),
      )
      if (
        !new X509Certificate(certificatePem).verify(caCertificate.publicKey)
      ) {
        throw new Error(
          '--cert was not signed by the CA in --trust-ca ' +
            '(key-distribution.md F-2); check that the two files belong to ' +
            'the same CA generation',
        )
      }
    }
  }
  if (config.key !== undefined) {
    let keyType: string | undefined
    try {
      keyType = createPrivateKey(
        readFileSync(config.key, 'utf8'),
      ).asymmetricKeyType
    } catch (error) {
      throw new Error(
        `--key does not parse as a private key: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (keyType !== 'ec') {
      // F-5: Bun refuses an Ed25519 TLS leaf outright, so the node's own key
      // must be EC — same constraint `qm ca issue` enforces on the CSR.
      throw new Error(
        `--key must be an EC private key (F-5); this one is ${String(keyType)}`,
      )
    }
  }
}

/**
 * L0 materials for this node's listener, or `null` with a printed reason.
 *
 * All three files or none: `mutualTlsServerOptions` is what makes
 * `requestCert`/`rejectUnauthorized` inseparable from `ca` (F-10), and this
 * function is what makes the *files* inseparable from each other. The reason
 * is printed rather than swallowed because the failure it prevents is a node
 * that came up looking configured and is serving plaintext — the operator has
 * to be told which file is missing, on the machine where it is missing.
 */
export function buildListenerTls(
  config: ResidentCliConfig,
  warn: (message: string) => void = message => {
    process.stderr.write(`${message}\n`)
  },
): { readonly tls: TLSOptions; readonly certificateNotAfter: number } | null {
  if (config.cert === undefined || config.key === undefined) return null
  if (config.unix !== undefined) {
    // Not an error: a unix-socket node has legitimate uses for a certificate
    // (it is how the registry publishes its Ed25519 key), and the file
    // permissions on the socket are the boundary TLS would have been.
    warn(
      '[resident] --cert/--key are not used for TLS on a unix socket; the ' +
        'certificate is still checked against this node identity',
    )
    return null
  }
  if (config.trustCa === undefined) {
    warn(
      '[resident] --cert/--key given without --trust-ca: mTLS is NOT enabled ' +
        '(the CA root is one of the three settings that only work together, ' +
        'key-distribution.md F-10). This listener is serving plaintext ws://',
    )
    return null
  }
  const certificatePem = readFileSync(config.cert, 'utf8')
  return {
    tls: mutualTlsServerOptions({
      cert: certificatePem,
      key: readFileSync(config.key, 'utf8'),
      ca: readFileSync(config.trustCa, 'utf8'),
    }),
    // Read off the certificate rather than configured separately: two places
    // to say when a certificate expires is two places that can disagree, and
    // the one that would be wrong is the one nobody looks at (§6.3).
    certificateNotAfter: Date.parse(
      new X509Certificate(certificatePem).validTo,
    ),
  }
}

/**
 * L1 material for this node's listener (§7.1 / §7.1.1), or `undefined` when
 * `--sign-handshake` was not given.
 *
 * The directory is the one the capability gate already reads — deliberately
 * the same object, not a second copy. A node that would accept a token from a
 * peer but not that peer's handshake (or the reverse) has two answers to one
 * question, and the failure shows up as "some peers work and some do not"
 * with nothing in either log naming the difference.
 */
export function buildHandshakeSigning(
  config: ResidentCliConfig,
  keys: NodeKeyPair,
  directory: PublicKeyDirectory,
): ListenerIdentity | undefined {
  if (config.signHandshake !== true) return undefined
  return {
    node: config.node,
    keys,
    directory,
    ...(config.requireSignedHandshake === true ? { required: true } : {}),
  }
}

export async function runResident(args: readonly string[]): Promise<void> {
  // 帮助排在最前面，**在身份校验与运行时断言之前**：问「这个命令怎么用」的人
  // 恰恰是还没把 `OCC_IDENTITY=qianmo` 和 PSK 配对的那个人，让他先撞一条错误
  // 再去查源码是把唯一的自助入口挡在门外。
  if (isResidentHelpRequest(args)) {
    process.stdout.write(RESIDENT_HELP_TEXT)
    return
  }
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
  assertOwnCertificateAndKey(config, keys.publicKey)
  // The durable trail (P7.2). Opened here rather than inside the node because
  // this is the layer that owns paths, and because a trail is per *process*:
  // two residents on one machine each continue their own file.
  //
  // Ahead of the directory rather than beside the node, because the very first
  // refresh below can already produce a §8.2 conflict record, and a trail
  // opened after it would lose exactly the line that explains why this node
  // resolves a peer's key differently from the registry.
  const trail = openAuditTrail()
  const directory = buildPublicKeyDirectory(
    config,
    certificateDirectoryTrailSink(trail, config.node),
  )
  if (directory instanceof CertificateDirectory) {
    // Awaited, once, before anything listens: `publicKeyOf` is synchronous by
    // contract, so a directory that has not converged yet answers `null` — and
    // for the first peer to dial in that is indistinguishable from "no such
    // node". The call is bounded by the directory's own timeout and never
    // throws, so an unreachable registry costs a few seconds of startup and
    // degrades to the `--trust` entries (§6.4), which is the designed
    // fail-closed state rather than a failure to start.
    await directory.refresh()
    directory.startPolling(DEFAULT_REGISTRY_POLL_INTERVAL_MS)
  }
  // Its own key is always trusted: rule S-1 accepts `user-confirmed` only when
  // this node signed it, which means verifying its own signature.
  directory.put(config.node, keys.publicKey)
  const capability = new NodeCapabilities({
    node: config.node,
    directory,
    keys,
    ...(config.requireSignedTasks ? { policy: SIGNED_TASK_POLICY } : {}),
    // §9.2 phase ①. Both halves or neither — the gate refuses the
    // half-configuration too, and this is the only place that supplies them.
    ...(config.auditSignedTasks
      ? {
          shadowPolicy: SIGNED_TASK_POLICY,
          onShadowRefusal: capabilityShadowTrailSink(trail, config.node),
        }
      : {}),
  })
  const listenerTls = buildListenerTls(config)
  const handshakeSigning = buildHandshakeSigning(config, keys, directory)
  process.stdout.write(
    `${JSON.stringify({
      node: config.node,
      publicKey: keys.publicKey,
      requireSignedTasks: config.requireSignedTasks,
      auditSignedTasks: config.auditSignedTasks,
      trusts: config.trusted.map(([node]) => node),
      // Which of the three layers this node actually has up (§7.3). Reported
      // as three fields rather than one "secure: true", for the reason §7.3
      // gives: collapsed into one, "TLS is on but nothing is signed" and
      // "everything is signed over plaintext" read identically afterwards.
      mtls: listenerTls !== null,
      signedHandshake: config.signHandshake === true,
      requireSignedHandshake: config.requireSignedHandshake === true,
    })}\n`,
  )

  // The write-only backup credential comes from the environment, never from a
  // flag: a token on a command line is a token in every process listing on the
  // machine. Same injection point discipline as the transport PSK.
  const backupToken = process.env[BACKUP_TOKEN_ENV_VAR]
  if (config.backupUrl !== undefined && (backupToken ?? '') === '') {
    throw new Error(`--backup-url requires ${BACKUP_TOKEN_ENV_VAR}`)
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

  const resident = new QianmoResident({
    node: config.node,
    team: config.team,
    agents: config.agents,
    psk,
    capability,
    auditSink: routerTrailSink(trail, config.node),
    transportEvents: transportTrailSink(trail, config.node),
    // The one sink whose successes matter (P13.6): a watch job's whole output
    // is "the operator was told, and the console receipted it", and no other
    // layer records that.
    notifyAudit: residentNotifyTrailSink(trail, config.node),
    ...(backup === undefined ? {} : { backup }),
    listen: {
      ...(config.port === undefined ? {} : { port: config.port }),
      ...(config.hostname === undefined ? {} : { hostname: config.hostname }),
      ...(config.unix === undefined ? {} : { unix: config.unix }),
    },
    ...(listenerTls === null
      ? {}
      : {
          tls: listenerTls.tls,
          certificateNotAfter: listenerTls.certificateNotAfter,
        }),
    ...(handshakeSigning === undefined ? {} : { handshakeSigning }),
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
    if (directory instanceof CertificateDirectory) directory.stopPolling()
    if (memTimer !== null) clearInterval(memTimer)
    trail.close()
    await timingWriter?.close()
    await memWriter?.close()
    await activity?.close()
  }
}
