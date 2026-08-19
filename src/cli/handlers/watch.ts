// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `qm watch` —— 中枢侧的值守作业跑手（P13.6）。
 *
 * 这是「定时反转」那条设计的入口：**定时全部住在中枢，节点侧零调度状态**。
 * 本进程按 `@qianmo/scheduler` 算出的一次性预约到点拨号目标节点、发一条
 * `task.request`，然后**把连接握住**——因为 notify 走的正是这条已存在通道的
 * 反方向（`resident-botization.md` §1 那张图的 ③），节点一次都不拨号。
 *
 * ## 三条不能顺手改掉的东西
 *
 * - **拨号的是中枢，不是节点。**H-2 说的是节点纯入站，中枢当然要拨号——它是
 *   客户端那一侧。把这段逻辑「挪到节点里去省一次连接」正好把 H-2 作废。
 * - **连接跑完不关。**`resident-wake` 发完就退是对的（一次调用一条消息），
 *   这里不是：作业跑出来的 notify 要顺着同一条通道回来，关掉就等于让节点把
 *   通知压进台账等下一次拨号——一个周期的延迟，且是白白的。
 * - **`contextId = jobId`**（§4.1③）。它把「值守作业」和「多会话隔离」焊死：
 *   一个作业在节点侧就是一条独立 ACP 会话，跑七天也不会把人工对话撑爆。
 *   `taskTtlMs` 同理由作业指定，不吃协议默认的 5 分钟（§4.1④）。
 *
 * ## 作业文件长什么样
 *
 * 一个 JSON 数组，每项是 `@qianmo/scheduler` 的 `ScheduledJob` 再加一个
 * `url`（目标节点的入站 ws / unix 地址，本文件读，调度器不读）：
 *
 * ```json
 * [
 *   {
 *     "id": "disk-watch",
 *     "title": "每十分钟看一次磁盘",
 *     "target": "qianmo://beta-1/reviewer",
 *     "url": "ws://127.0.0.1:38611",
 *     "prompt": "检查 / 与 /var 的使用率。超过 90% 就调用 qianmo_notify 告诉运维，否则什么都不用做。",
 *     "schedule": { "everyMs": 600000 },
 *     "taskTtlMs": 900000,
 *     "notifyPolicy": "agent-initiated"
 *   }
 * ]
 * ```
 *
 * `notifyPolicy` 目前只被记录与透传，**打不打扰人由 agent 自己决定**——产出
 * 默认静默，只有它显式调 `qianmo_notify` 才有人被叫醒（§4.1⑤）。
 */

import { readFileSync } from 'node:fs'
import { AuditSource, type AuditTrail } from '@qianmo/audit'
import {
  MessageType,
  assertAddress,
  createMessage,
  isNotifyPayload,
  type QianmoMessage,
} from '@qianmo/protocol'
import { ResidentEstop } from '@qianmo/resident'
import {
  SchedulerRunner,
  SchedulerStore,
  assertJob,
  type ScheduledJob,
} from '@qianmo/scheduler'
import { PSK_ENV_VAR, TransportClient, pskFromEnv } from '@qianmo/transport'
import { invokedBinName } from '../../constants/brand.js'
import { IDENTITY_MODE } from '../../constants/identity.js'
import { occConfigPath } from '../../config/paths.js'
import { openAuditTrail } from '../../services/qianmo/auditTrail.js'
import { residentOptionValue } from './residentArgs.js'

/**
 * 一次投递等回执的预算。
 *
 * 与常驻侧回复用的是同一个数（5 s），理由也同一条：回执只承诺「已落盘」，
 * 一个正在跑 turn 的节点也该在这个预算内答上来（P13.3 把这条解耦了）。
 * 作业本身能跑多久由 `taskTtlMs` 说了算，不由这个数。
 */
const DISPATCH_RECEIPT_TIMEOUT_MS = 5_000

/** 连接一次的上限，与 `resident-wake` 同源。 */
const CONNECT_TIMEOUT_MS = 30_000

export interface WatchConfig {
  readonly jobsPath: string
  readonly from: string
  readonly stateDir: string
  /** 只跑一遍到点的作业就退出——给冒烟与联调用，不是常态。 */
  readonly once: boolean
}

/** 作业文件里那一项：调度器认识的部分 + 本文件认识的 `url`。 */
interface WatchJobEntry {
  readonly job: ScheduledJob
  readonly url: string
}

export const WATCH_HELP_TEXT = `Usage: ${invokedBinName()} watch --jobs <file> --from <address> [options]

Run the hub-side watch-job scheduler. Timing lives here so the nodes hold none:
each job fires on a one-shot reservation, dials its target node, sends one
task.request, and keeps the connection so the node can push notifications back
down it. Requires OCC_IDENTITY=qianmo and a key in $${PSK_ENV_VAR} shared with
every node named in the jobs file.

Options (each accepts both --name value and --name=value):

  --jobs <file>        JSON array of job definitions. Required. Each entry is a
                       scheduler job plus a "url" naming the target node's
                       inbound WebSocket.
  --from <address>     This hub's address, qianmo://<node>/<agent>. Required —
                       it is the head of the audit chain and the address every
                       notification is addressed back to.
  --state-dir <dir>    Where claims and job state live. Defaults to
                       <config>/qianmo/scheduler. Two hubs pointed at one
                       directory is a supported (and tested) arrangement: the
                       claim files make it at-most-once.
  --once               Run whatever is due right now, then exit. For smoke
                       tests; a real watch job wants the process to stay up.
  -h, --help           Print this and exit.

Environment:

  OCC_IDENTITY         Must be "qianmo".
  ${PSK_ENV_VAR}   Transport pre-shared key, required. Environment only —
                       a key on a command line is a key in every process
                       listing on this machine.

Emergency stop:

  touch <config>/qianmo/scheduler/ESTOP stops new fires and nothing else.
  Anything already dispatched keeps running: the node owes a task.result to
  whoever is waiting, and killing it in flight turns a slow answer into a lost
  one. Remove the file to resume; the schedule picks up with nothing to
  restart.`

export function isWatchHelpRequest(args: readonly string[]): boolean {
  return args.some(arg => arg === '--help' || arg === '-h')
}

export function parseWatchArgs(
  args: readonly string[],
  identity: string = IDENTITY_MODE,
): WatchConfig {
  let jobsPath: string | undefined
  let from: string | undefined
  let stateDir: string | undefined
  let once = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--jobs' || arg?.startsWith('--jobs=')) {
      const parsed = residentOptionValue(args, index, '--jobs')
      jobsPath = parsed.value
      index = parsed.next
    } else if (arg === '--from' || arg?.startsWith('--from=')) {
      const parsed = residentOptionValue(args, index, '--from')
      assertAddress(parsed.value, '--from')
      from = parsed.value
      index = parsed.next
    } else if (arg === '--state-dir' || arg?.startsWith('--state-dir=')) {
      const parsed = residentOptionValue(args, index, '--state-dir')
      stateDir = parsed.value
      index = parsed.next
    } else if (arg === '--once') {
      once = true
    } else {
      throw new Error(
        `unknown watch option ${String(arg)}` +
          ` (run \`${invokedBinName()} watch --help\` for the list)`,
      )
    }
  }

  if (identity !== 'qianmo') {
    throw new Error('watch requires OCC_IDENTITY=qianmo')
  }
  if (jobsPath === undefined) throw new Error('watch requires --jobs')
  if (from === undefined) throw new Error('watch requires --from')

  return {
    jobsPath,
    from,
    stateDir: stateDir ?? occConfigPath('qianmo', 'scheduler'),
    once,
  }
}

/**
 * 读作业文件。
 *
 * 校验一律在这里，而不是等到 fire 的时候——一个作业写一次要跑一周，缺陷若只在
 * fire 路径上暴露，就会每个周期无人值守地重犯一次，而且是往一条设计成静默的
 * 通道里犯。文件读进来的这一刻是最后一次有人在看。
 */
export function parseWatchJobs(source: string): readonly WatchJobEntry[] {
  const parsed: unknown = JSON.parse(source)
  if (!Array.isArray(parsed)) {
    throw new TypeError('jobs file must be a JSON array')
  }
  const seen = new Set<string>()
  return parsed.map((raw, index) => {
    const job = assertJob(raw)
    if (seen.has(job.id)) {
      // 两条同 id 的作业会共用同一把 dedupKey，于是「同一时刻的两个作业」被
      // CAS 判成同一次预约，其中一条永远不跑——而且一声不吭。
      throw new Error(`jobs file has two jobs with id ${job.id}`)
    }
    seen.add(job.id)
    const url = (raw as Record<string, unknown>).url
    if (typeof url !== 'string' || url.trim() === '') {
      throw new TypeError(`job ${job.id} (index ${index}) needs a "url"`)
    }
    return { job, url }
  })
}

/** 一个目标节点的长连接，跑完不关。 */
interface NodeLink {
  readonly client: TransportClient
  connected: Promise<void> | null
}

function detailOf(
  entries: Readonly<Record<string, string | number | boolean | undefined>>,
): Record<string, string | number | boolean> {
  const detail: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) detail[key] = value
  }
  return detail
}

/**
 * 把一次 notify 落到审计链与 stdout。
 *
 * stdout 那一半不是调试残留：`qm watch` 现在就是值守场景唯一的人机界面，控制台
 * 的通知页还没做（见 §5 遗留）。审计链那一半才是留档的依据。
 */
function recordNotify(
  trail: AuditTrail,
  node: string,
  message: QianmoMessage,
): void {
  const payload = message.payload
  if (!isNotifyPayload(payload)) return
  const line = `[notify] ${new Date(payload.observedAt).toISOString()} ${payload.severity} ${message.contextId ?? '-'} ${payload.summary}`
  process.stdout.write(`${line}\n`)
  if (payload.detail !== undefined) {
    process.stdout.write(`         ${payload.detail}\n`)
  }
  try {
    trail.append({
      at: Date.now(),
      source: AuditSource.Scheduler,
      kind: 'watch_notify_received',
      outcome: 'ok',
      node,
      peer: message.from,
      taskId: message.taskId,
      msgId: message.msgId,
      traceId: message.traceId,
      detail: detailOf({
        contextId: message.contextId,
        kind: payload.kind,
        severity: payload.severity,
        summary: payload.summary,
        redelivered: payload.redelivered === true,
        causeTaskId: payload.causeTaskId,
      }),
    })
  } catch {
    // 与其他几个 sink 同一条纪律：日志本写不动不该把值守作业停掉。
  }
}

export async function runWatch(args: readonly string[]): Promise<void> {
  if (isWatchHelpRequest(args)) {
    process.stdout.write(`${WATCH_HELP_TEXT}\n`)
    return
  }
  const config = parseWatchArgs(args)
  const psk = pskFromEnv()
  const entries = parseWatchJobs(readFileSync(config.jobsPath, 'utf8'))
  const hub = assertAddress(config.from, '--from')
  const trail = openAuditTrail()

  const urls = new Map(entries.map(entry => [entry.job.id, entry.url]))
  const links = new Map<string, NodeLink>()

  const linkTo = async (url: string): Promise<TransportClient> => {
    let link = links.get(url)
    if (link === undefined) {
      const client = new TransportClient({
        endpoint: { url },
        node: hub.node,
        psk,
        // 声明全量类型，否则节点按能力发现（§2.7）会认定这个中枢不收 notify，
        // 一条都不发——而这正是本进程存在的理由。
        supportedTypes: [...Object.values(MessageType)],
        onMessage: message => {
          if (message.type === MessageType.Notify) {
            recordNotify(trail, hub.node, message)
          }
        },
      })
      link = { client, connected: null }
      links.set(url, link)
    }
    link.connected ??= link.client.connect(CONNECT_TIMEOUT_MS)
    try {
      await link.connected
    } catch (error) {
      // 下一次 fire 重新拨；`connected` 清空是为了不把一次失败缓存成永久失败。
      link.connected = null
      throw error
    }
    return link.client
  }

  const store = new SchedulerStore(config.stateDir, {
    onError: error => {
      process.stderr.write(`[watch] store: ${String(error)}\n`)
    },
  })
  const estop = new ResidentEstop({
    path: occConfigPath('qianmo', 'scheduler', 'ESTOP'),
    onError: error => {
      process.stderr.write(`[watch] estop: ${String(error)}\n`)
    },
  })

  const runner = new SchedulerRunner({
    store,
    jobs: entries.map(entry => entry.job),
    paused: () => estop.engaged(),
    onError: error => {
      process.stderr.write(`[watch] ${String(error)}\n`)
    },
    dispatch: async fire => {
      const url = urls.get(fire.job.id)
      if (url === undefined) throw new Error(`job ${fire.job.id} has no url`)
      const client = await linkTo(url)
      const message = createMessage({
        from: config.from,
        to: fire.job.target,
        type: MessageType.TaskRequest,
        // §4.1③：一个作业 = 一条 contextId = 节点侧一条独立会话。
        contextId: fire.job.id,
        // §4.1④：截止时间由作业说了算，不吃 LIMITS.defaultTaskTtlMs。
        taskTtlMs: fire.job.taskTtlMs,
        payload: { ask: fire.job.prompt },
      })
      trail.append({
        at: Date.now(),
        source: AuditSource.Scheduler,
        kind: 'watch_fire',
        outcome: 'ok',
        node: hub.node,
        peer: fire.job.target,
        taskId: message.taskId,
        msgId: message.msgId,
        traceId: message.traceId,
        detail: detailOf({
          jobId: fire.job.id,
          dedupKey: fire.dedupKey,
          fireAtMs: fire.fireAtMs,
          attempt: fire.attempt,
          notifyPolicy: fire.job.notifyPolicy,
        }),
      })
      await client.sendAndWait(message, DISPATCH_RECEIPT_TIMEOUT_MS)
    },
  })

  process.stdout.write(
    `[watch] ${entries.length} job(s) from ${config.jobsPath}, state in ${config.stateDir}\n`,
  )

  if (config.once) {
    await runner.runDue(Date.now())
    for (const link of links.values()) await link.client.close()
    return
  }

  runner.start()
  const stop = (): void => {
    runner.stop()
    void (async () => {
      for (const link of links.values()) await link.client.close()
    })()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  // 一直跑下去。停手由上面两个信号负责——值守作业的常态就是这个进程不退。
  await new Promise<void>(() => {})
}
