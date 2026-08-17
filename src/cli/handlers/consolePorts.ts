// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `@qianmo/console` 四个端口的生产实现。
 *
 * 控制台包本身是叶子：它不知道注册中心在哪、审计链是哪个文件、唤醒要用哪把
 * PSK（`packages/console/src/deps.ts` 的模块注释）。那些答案全在 host 这一侧，
 * 所以适配层住在这里，和它依赖的 `auditTrailPath()` / `executeResidentWake()`
 * 放在同一层。方向和 tool-runtime 那六个 facade 一致：包声明接口，host 实现。
 *
 * ## 一条贯穿四个端口的规矩：**过得去的失败不抛**
 *
 * `ConsoleResult` 存在的理由就是这个。注册中心挂了，控制台仍然要能打开、仍然
 * 要能看审计链——一个因为下游不可达而 500 的面板，恰好在最需要它的时候没有。
 * 所以这里每一个 `catch` 都落成 `{ ok: false, failure }`，只有**编程错误**
 * （比如注入了一个不是函数的 fetch）才让它继续往上抛。
 *
 * ## 数字一律 import，不抄
 *
 * `LimitsSnapshot` 里的每个数都从拥有它的包取：协议上限归 `@qianmo/protocol`
 * 的 `LIMITS`，运行时速率归 `@qianmo/router` 的 `RUNTIME_RATE`（两者**故意**
 * 分成两列，见 `packages/router/src/rate.ts` 的模块注释），租约 TTL 归
 * `@qianmo/registry`。CLAUDE.md §2.2：协议级数值只允许有一个出处。
 */

import {
  AuditSource,
  queryTrail,
  readTrail,
  reconstructChain,
  type TrailQuery,
  type TrailReadResult,
} from '@qianmo/audit'
import type {
  AuditFilter,
  AuditPort,
  ConsoleAgent,
  ConsoleFailure,
  ConsoleResult,
  LimitsSnapshot,
  RegisterAgentInput,
  RegistryPort,
  WakeInput,
  WakePort,
} from '@qianmo/console'
import { LIMITS, assertAddress } from '@qianmo/protocol'
import { DEFAULT_TTL_MS } from '@qianmo/registry'
import { RUNTIME_RATE } from '@qianmo/router'
import { executeResidentWake } from './residentWake.js'

function fail<T>(
  code: ConsoleFailure['code'],
  message: string,
): ConsoleResult<T> {
  return { ok: false, failure: { code, message } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// RegistryPort —— 注册中心 HTTP v0
// ---------------------------------------------------------------------------

/**
 * 注册中心的默认请求超时。
 *
 * 有超时这件事本身比这个数字重要：`fetch` 默认永不超时，而控制台的每个页面
 * 加载都要问一次注册中心——一台不回包（不是拒连）的注册中心会让面板永远停在
 * 转圈上，而那正是「注册中心挂了也要能打开」要防的那一种挂法。
 */
const DEFAULT_REGISTRY_TIMEOUT_MS = 5_000

/** 注入点：测试里换成假的，生产是全局 `fetch`。 */
type ConsoleFetch = (input: string, init: RequestInit) => Promise<Response>

interface RegistryPortOptions {
  /** HTTP v0 基址，不带尾斜杠（`consoleArgs.ts` 已经归一过）。 */
  readonly baseUrl: string
  readonly fetch?: ConsoleFetch
  readonly timeoutMs?: number
}

/** HTTP 状态码 → 端口失败码。5xx 归 `unreachable`：那是「下游坏了」。 */
function codeForStatus(status: number): ConsoleFailure['code'] {
  if (status === 400) return 'invalid'
  if (status === 404) return 'not_found'
  if (status === 405) return 'unsupported'
  if (status === 409) return 'rejected'
  if (status >= 500) return 'unreachable'
  return 'rejected'
}

/** 注册中心的错误体是 `{ error: { code, message } }`。 */
function errorMessageOf(body: unknown): string | null {
  if (!isRecord(body)) return null
  const error = body['error']
  if (!isRecord(error)) return null
  const message = error['message']
  return typeof message === 'string' && message.length > 0 ? message : null
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 一条 `AgentBody` → `ConsoleAgent`，形状不对就返回 null。
 *
 * 宽进而不是照单全收：注册中心和控制台是两个可以分别升级的进程，一个多出来的
 * 字段不该让整张列表打不开；但一条缺 `address` 的记录进了列表，页面上就会出现
 * 一个没法注销的幽灵行，所以那种记录直接丢掉。
 */
function toConsoleAgent(value: unknown): ConsoleAgent | null {
  if (!isRecord(value)) return null
  const address = value['address']
  const endpoint = value['endpoint']
  const status = value['status']
  if (typeof address !== 'string' || address.length === 0) return null
  if (typeof endpoint !== 'string') return null
  if (typeof status !== 'string') return null
  const rawCapabilities = value['capabilities']
  const capabilities = Array.isArray(rawCapabilities)
    ? rawCapabilities.filter((item): item is string => typeof item === 'string')
    : []
  const publicKey = value['publicKey']
  return {
    address,
    endpoint,
    capabilities,
    ...(typeof publicKey === 'string' && publicKey.length > 0
      ? { publicKey }
      : {}),
    status,
    registeredAt: finiteOr(value['registeredAt'], 0),
    lastHeartbeatAt: finiteOr(value['lastHeartbeatAt'], 0),
    expiresAt: finiteOr(value['expiresAt'], 0),
  }
}

/**
 * 注册中心的 HTTP v0 面。
 *
 * 地址在**单个 path segment** 里百分号编码（`packages/registry/src/http.ts`
 * 第 181 行起的注释）：`qianmo://node-b/reviewer` 编成
 * `qianmo%3A%2F%2Fnode-b%2Freviewer`，`URL` 不会把转义拆开，服务端 split 出来
 * 仍是三段。空地址在本地就挡掉——它会退化成集合路由，删到的不是调用方想删的
 * 那个东西。
 */
export function createRegistryPort(options: RegistryPortOptions): RegistryPort {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS
  const doFetch: ConsoleFetch =
    options.fetch ?? ((input, init) => fetch(input, init))

  async function call(
    path: string,
    init: RequestInit,
  ): Promise<ConsoleResult<unknown>> {
    let response: Response
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      return fail(
        'unreachable',
        `注册中心不可达 ${baseUrl}：${messageOf(error)}`,
      )
    }

    if (response.status === 204) return { ok: true, value: null }

    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      // 断在半路的响应体和一个空体在这里是同一件事：下面靠状态码判成败。
      body = null
    }

    if (!response.ok) {
      return fail(
        codeForStatus(response.status),
        errorMessageOf(body) ??
          `注册中心返回 HTTP ${response.status}（${baseUrl}${path}）`,
      )
    }
    return { ok: true, value: body }
  }

  function segment(address: string): ConsoleResult<string> {
    if (address.trim() === '') {
      return fail('invalid', '地址不能为空')
    }
    return { ok: true, value: encodeURIComponent(address) }
  }

  function oneAgent(value: unknown): ConsoleResult<ConsoleAgent> {
    const agent = toConsoleAgent(value)
    return agent === null
      ? fail('invalid', '注册中心返回的不是一条 agent 记录')
      : { ok: true, value: agent }
  }

  return {
    async list(): Promise<ConsoleResult<readonly ConsoleAgent[]>> {
      const result = await call('/v0/agents', { method: 'GET' })
      if (!result.ok) return result
      const raw = isRecord(result.value) ? result.value['agents'] : undefined
      if (!Array.isArray(raw)) {
        return fail('invalid', '注册中心返回的不是 agents 列表')
      }
      const agents: ConsoleAgent[] = []
      for (const entry of raw) {
        const agent = toConsoleAgent(entry)
        if (agent !== null) agents.push(agent)
      }
      return { ok: true, value: agents }
    },

    async register(
      input: RegisterAgentInput,
    ): Promise<ConsoleResult<ConsoleAgent>> {
      // 字段校验全部留给注册中心：它是这些规则的真源（地址形状、endpoint
      // 形状、能力条数上限），在这里再写一遍就等于开了第二个会漂移的出处。
      const result = await call('/v0/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address: input.address,
          endpoint: input.endpoint,
          ...(input.capabilities === undefined
            ? {}
            : { capabilities: input.capabilities }),
          ...(input.publicKey === undefined
            ? {}
            : { publicKey: input.publicKey }),
          ...(input.status === undefined ? {} : { status: input.status }),
        }),
      })
      if (!result.ok) return result
      return oneAgent(result.value)
    },

    async deregister(address: string): Promise<ConsoleResult<void>> {
      const encoded = segment(address)
      if (!encoded.ok) return encoded
      const result = await call(`/v0/agents/${encoded.value}`, {
        method: 'DELETE',
      })
      if (!result.ok) return result
      return { ok: true, value: undefined }
    },

    async heartbeat(address: string): Promise<ConsoleResult<ConsoleAgent>> {
      const encoded = segment(address)
      if (!encoded.ok) return encoded
      const result = await call(`/v0/agents/${encoded.value}/heartbeat`, {
        method: 'POST',
      })
      if (!result.ok) return result
      return oneAgent(result.value)
    },
  }
}

// ---------------------------------------------------------------------------
// AuditPort —— 本机审计链，只读
// ---------------------------------------------------------------------------

/** 不指定 `limit` 时给的尾部条数，与 `occ audit --limit` 的默认值一致。 */
export const DEFAULT_AUDIT_LIMIT = 200

/**
 * 尾部条数的兜底上限。
 *
 * **不是**生效的那个天花板——查询串上的 `limit` 由 HTTP 面的
 * `MAX_AUDIT_LIMIT`（`packages/console/src/http.ts`，当前 500）夹过一道，所以
 * 从页面来的值永远比这里小，这条永远不触发。它存在是因为 `AuditPort` 是个公开
 * 接口，直接拿着 `limit: 1e9` 调它的调用方（测试、将来的第二个前端）不该把
 * `readTrail` 一次性读进内存的那整个文件都渲染出去。两个数字不会打架：这条严格
 * 更宽松，HTTP 面收紧它是安全的。
 */
const AUDIT_TAIL_BACKSTOP = 10_000

const AUDIT_SOURCES: ReadonlySet<string> = new Set(Object.values(AuditSource))
const AUDIT_OUTCOMES: ReadonlySet<string> = new Set([
  'ok',
  'refused',
  'dropped',
])

interface AuditPortOptions {
  /** 审计链文件的绝对路径。 */
  readonly path: string
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_AUDIT_LIMIT
  return Math.min(AUDIT_TAIL_BACKSTOP, Math.max(1, Math.floor(raw)))
}

/**
 * 审计链的只读面。
 *
 * **文件不存在返回空页，不是失败**：一个刚起来、还没产生过任何审计记录的节点
 * 是完全正常的状态，把它渲染成红色的「读取失败」会让第一次用控制台的人以为
 * 自己装坏了。`readTrail` 自己就把 ENOENT 当空文件处理，这里只需要不把别的
 * IO 错误（比如权限）混进同一个桶。
 *
 * **只读**：这个端口没有任何写审计链的路径。审计链的写入口只有节点进程自己
 * （append-only fd），控制台连一个能追加的方法都不该有。
 */
export function createAuditPort(options: AuditPortOptions): AuditPort {
  function load(): ConsoleResult<TrailReadResult> {
    try {
      return { ok: true, value: readTrail(options.path) }
    } catch (error) {
      return fail(
        'unreachable',
        `审计链读不出来 ${options.path}：${messageOf(error)}`,
      )
    }
  }

  return {
    async read(filter: AuditFilter) {
      // 过滤条件先校验：一个拼错的 source 静默匹配到零条，会让人以为「这段
      // 时间什么都没发生」，而实际上是问错了问题。
      const source = filter.source
      if (source !== undefined && source !== '' && !AUDIT_SOURCES.has(source)) {
        return fail('invalid', `未知的审计来源 ${JSON.stringify(source)}`)
      }
      const outcome = filter.outcome
      if (
        outcome !== undefined &&
        outcome !== '' &&
        !AUDIT_OUTCOMES.has(outcome)
      ) {
        return fail('invalid', `未知的结果 ${JSON.stringify(outcome)}`)
      }
      for (const [name, value] of [
        ['from', filter.from],
        ['to', filter.to],
      ] as const) {
        if (value !== undefined && !Number.isFinite(value)) {
          return fail('invalid', `${name} 必须是 epoch 毫秒`)
        }
      }

      const loaded = load()
      if (!loaded.ok) return loaded
      const { records, issues, intact } = loaded.value

      const query: TrailQuery = {
        ...(source === undefined || source === ''
          ? {}
          : { source: source as AuditSource }),
        ...(outcome === undefined || outcome === ''
          ? {}
          : { outcome: outcome as 'ok' | 'refused' | 'dropped' }),
        ...(filter.traceId === undefined || filter.traceId === ''
          ? {}
          : { traceId: filter.traceId }),
        ...(filter.taskId === undefined || filter.taskId === ''
          ? {}
          : { taskId: filter.taskId }),
        ...(filter.agent === undefined || filter.agent === ''
          ? {}
          : { agent: filter.agent }),
        ...(filter.from === undefined ? {} : { from: filter.from }),
        ...(filter.to === undefined ? {} : { to: filter.to }),
      }

      // 取**尾部** limit 条，和 `occ audit --limit` 同一语义
      // （`qianmoAudit.ts` 第 198 行）：一条链上最近发生的事才是被找的那些。
      const matched = queryTrail(records, query).slice(
        -clampLimit(filter.limit),
      )
      return {
        ok: true,
        value: {
          records: matched,
          intact,
          issueCount: issues.length,
          // 过滤前的总数，页面据此说「共 M 条中的 N 条」。
          total: records.length,
        },
      }
    },

    async chain(traceId: string) {
      if (traceId.trim() === '') {
        return fail('invalid', 'trace id 不能为空')
      }
      const loaded = load()
      if (!loaded.ok) return loaded
      // `reconstructChain` 从不按 outcome 过滤——被拒、被丢、被去重的都在里面，
      // 那正是 P7.2 判据里「完整」两个字的意思。
      return {
        ok: true,
        value: reconstructChain(loaded.value.records, traceId),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// LimitsSnapshot —— 三个包各自的数字，一个都不抄
// ---------------------------------------------------------------------------

export function consoleLimits(): LimitsSnapshot {
  return {
    protocol: {
      maxMessageBytes: LIMITS.maxMessageBytes,
      maxHops: LIMITS.maxHops,
      defaultTtlMs: LIMITS.defaultTtlMs,
      defaultTaskTtlMs: LIMITS.defaultTaskTtlMs,
      ratePerMinute: LIMITS.ratePerMinute,
    },
    runtime: {
      capacity: RUNTIME_RATE.capacity,
      windowMs: RUNTIME_RATE.windowMs,
    },
    registryTtlMs: DEFAULT_TTL_MS,
  }
}

// ---------------------------------------------------------------------------
// WakePort —— 复用 `occ resident-wake` 的那一条发送路径
// ---------------------------------------------------------------------------

/**
 * 页面能排的最长延时。
 *
 * `executeResidentWake` 是**先等够 `afterMs` 再发**，而这个端口是在一个 HTTP
 * 请求里被调用的——一个十分钟的定时唤醒等于一个挂十分钟的请求，浏览器早就断了，
 * 而节点这边还在等。真要排长定时器，用 `occ resident-wake --after-ms`，那是个
 * 可以自己活着的进程。
 */
const MAX_CONSOLE_WAKE_AFTER_MS = 60_000

/** 连接 + 等回执的预算。 */
const DEFAULT_CONSOLE_WAKE_TIMEOUT_MS = 30_000

interface WakePortOptions {
  /** 唤醒目标（激活器）的 ws/wss 地址——这个端口只往这一个地方发。 */
  readonly url: string
  /** 传输层 PSK。**只从环境变量来**，不从命令行、更不从页面来。 */
  readonly psk: string
  readonly timeoutMs?: number
  readonly deliverTtlMs?: number
}

/**
 * 路由器的本地拒绝长这样：`E_LOOP: ...`、`E_RUNTIME_THROTTLED: ...`
 * （`packages/router/src/router.ts` 的 `reject()`）。那是「规则不让发」，
 * 和「对面连不上」是两种完全不同的处置，页面上也该显示成两种。
 */
function classifyWakeError(error: unknown): ConsoleFailure['code'] {
  return /^E_[A-Z_]+:/.test(messageOf(error)) ? 'rejected' : 'unreachable'
}

/**
 * 唤醒面。
 *
 * **目标地址钉死在启动参数上**，页面传来的 `url` 只被允许等于它（或留空）。
 * 否则这个端口就是一个「任何能打开控制台的人都能让本机往任意 ws 地址发一条
 * 带 PSK 握手的消息」的转发器，而控制台的 admin token 门槛远低于「能改本机
 * systemd 单元」。
 */
export function createWakePort(options: WakePortOptions): WakePort {
  const pinned = new URL(options.url).toString()
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONSOLE_WAKE_TIMEOUT_MS
  const deliverTtlMs = options.deliverTtlMs ?? timeoutMs

  return {
    async send(input: WakeInput) {
      try {
        assertAddress(input.from, 'from')
        assertAddress(input.to, 'to')
      } catch (error) {
        return fail('invalid', messageOf(error))
      }
      if (input.prompt.trim() === '') {
        return fail('invalid', 'prompt 不能为空')
      }

      const requested = input.url.trim()
      if (requested !== '') {
        let normalized: string
        try {
          normalized = new URL(requested).toString()
        } catch (error) {
          return fail('invalid', messageOf(error))
        }
        if (normalized !== pinned) {
          return fail(
            'rejected',
            `控制台只向 ${pinned} 发唤醒；要换目标请重启控制台并改 --wake-url`,
          )
        }
      }

      const afterMs = input.afterMs ?? 0
      if (
        !Number.isInteger(afterMs) ||
        afterMs < 0 ||
        afterMs > MAX_CONSOLE_WAKE_AFTER_MS
      ) {
        return fail(
          'invalid',
          `延时必须是 0 到 ${MAX_CONSOLE_WAKE_AFTER_MS} 之间的整毫秒数；` +
            '更长的定时唤醒请用 occ resident-wake --after-ms',
        )
      }

      try {
        const result = await executeResidentWake(
          {
            url: pinned,
            from: input.from,
            to: input.to,
            prompt: input.prompt,
            afterMs,
            timeoutMs,
            deliverTtlMs,
          },
          options.psk,
        )
        return {
          ok: true,
          value: {
            msgId: result.msgId,
            taskId: result.taskId,
            receipt: result.receipt,
          },
        }
      } catch (error) {
        return fail(classifyWakeError(error), messageOf(error))
      }
    },
  }
}
