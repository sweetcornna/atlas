// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 控制台与注册中心的本地驱动。
 *
 * 三件事在这里定下来，改之前先读：
 *
 * ① **控制台是真进程，注册中心是同进程里的真服务器。**
 *    控制台必须 fork —— 要测的正是 `qm console` 这条命令行、它的 banner、
 *    以及它读 token 的三个入口。注册中心不必：它是 `@qianmo/registry` 的
 *    `startRegistryServer`（`demo/lib/p81-registry.ts` 也只是把它包了一层
 *    argv），跑在套件进程里对被测方而言是同一个 HTTP 面，还省下一次进程起停。
 *    **它不是 stub** —— 一行替身代码都没有，只是宿主换了个进程。
 *
 * ② **就绪判据是 `GET /v0/health` 答 200，不是 banner 落地。**
 *    `Bun.serve` 在 `startConsoleServer` 里同步绑口，但 banner 是之后写的，
 *    而 banner 里带着 token —— 只等 banner 会漏掉「口绑上了但还没写完」的窗口，
 *    只等健康检查又拿不到 token。所以两个都等，顺序是先 banner 后健康检查。
 *
 * ③ **token 从 banner 里抠，因为回环上它是生成的。**
 *    这条同时也在测那条产品规则：**自己生成的才回显，显式给的只打出处**
 *    （`console.ts` 的 `viewGenerated` 分支）。`console/supplied-token-not-echoed`
 *    钉住反向。
 */

import { startRegistryServer } from '@qianmo/registry'
import type { InMemoryRegistry, RegistryOptions } from '@qianmo/registry'
import { join } from 'node:path'
import type { ScenarioContext } from '../types.js'
import { spawnCli, waitFor, type SpawnedProcess } from './spawn.js'

/** 一次 HTTP 往返的原文 —— 断言不成立时这就是证据。 */
export interface HttpProbe {
  readonly status: number
  readonly body: string
  /** 解析得动就给对象，解析不动是 undefined（**不抛**，「不是 JSON」也是观察）。 */
  readonly json?: Record<string, unknown>
  readonly headers: Readonly<Record<string, string>>
  /** 连接层错误原文（服务端没起来 / 被拒）。 */
  readonly error?: string
}

export interface HttpOptions {
  readonly method?: string
  readonly token?: string
  readonly body?: unknown
  /** 额外请求头；`x-qianmo-console` 默认已带上（见文件头 ③ 的 guarded 规则）。 */
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

/**
 * 打一次控制台的 HTTP 面。
 *
 * 默认带 `x-qianmo-console: 1`：guarded 路由只在**凭据来自 cookie** 时才要求
 * 这个头，而这里全走 `Authorization: Bearer`，带不带都一样 —— 带上是为了让
 * 「换成 cookie 之后仍然通」这件事不必改这个 helper。
 */
export async function http(
  url: string,
  options: HttpOptions = {},
): Promise<HttpProbe> {
  const headers: Record<string, string> = {
    'x-qianmo-console': '1',
    ...options.headers,
  }
  if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    })
    const body = await response.text()
    let json: Record<string, unknown> | undefined
    try {
      const parsed: unknown = JSON.parse(body)
      json =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)
          : undefined
    } catch {
      json = undefined
    }
    const outHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      outHeaders[key] = value
    })
    return {
      status: response.status,
      body,
      headers: outHeaders,
      ...(json === undefined ? {} : { json }),
    }
  } catch (error) {
    return {
      status: 0,
      body: '',
      headers: {},
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    }
  }
}

// ---------------------------------------------------------------------------
// 注册中心
// ---------------------------------------------------------------------------

export interface RegistryHandle {
  readonly url: string
  readonly port: number
  readonly registry: InMemoryRegistry
  /** `--state` 落盘路径；不给 `statePath` 时是 undefined。 */
  readonly statePath?: string
}

export interface RegistryFixtureOptions {
  /** 打开落盘（`FileRegistryStore`）。持久化是 opt-in，与产品一致。 */
  readonly statePath?: string
  /** 租约 TTL；不给就是 `DEFAULT_TTL_MS`。短 TTL 用来测过期。 */
  readonly ttlMs?: number
}

export async function startRegistry(
  ctx: ScenarioContext,
  options: RegistryFixtureOptions = {},
): Promise<RegistryHandle> {
  const { FileRegistryStore, InMemoryRegistry: Table } = await import(
    '@qianmo/registry'
  )
  const registryOptions: RegistryOptions = {
    ...(options.statePath === undefined
      ? {}
      : { store: new FileRegistryStore(options.statePath) }),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  }
  const handle = startRegistryServer(0, {
    registry: new Table(registryOptions),
  })
  ctx.cleanup(async () => {
    await handle.stop()
  })
  return {
    url: handle.url,
    port: handle.port,
    registry: handle.registry as InMemoryRegistry,
    ...(options.statePath === undefined
      ? {}
      : { statePath: options.statePath }),
  }
}

// ---------------------------------------------------------------------------
// 控制台
// ---------------------------------------------------------------------------

export interface ConsoleHandle {
  /** `http://127.0.0.1:<port>`，不带 token。 */
  readonly url: string
  readonly port: number
  readonly viewToken: string
  readonly adminToken: string
  readonly configRoot: string
  readonly process: SpawnedProcess
  /** 启动 banner 原文（stdout）。 */
  banner(): string
  stderr(): string
}

export interface ConsoleFixtureOptions {
  readonly registryUrl: string
  /** `--wake-url <node>=<ws url>`，可多条。 */
  readonly wakeTargets?: readonly {
    readonly node: string
    readonly url: string
  }[]
  readonly signWakes?: boolean
  /** 每个唤醒目标的 PSK；键是节点名。 */
  readonly wakePsk?: Readonly<Record<string, string>>
  /** 显式 token（经环境变量给，与产品的第二优先级入口一致）。 */
  readonly viewToken?: string
  readonly adminToken?: string
  readonly extraArgs?: readonly string[]
  /** 配置根目录名，同一场景起两个控制台时要错开。 */
  readonly configDirName?: string
}

/** `qm console` 的 `--print-wake-identity` 用的那个环境变量名。 */
export function wakePskEnvVar(node: string): string {
  return `QIANMO_TRANSPORT_PSK_NODE_${Buffer.from(node, 'utf8')
    .toString('hex')
    .toUpperCase()}`
}

const VIEW_TOKEN_LINE = /^view-token\s+(\S+)/m
const ADMIN_TOKEN_LINE = /^admin-token\s+(\S+)/m

export async function startConsole(
  ctx: ScenarioContext,
  options: ConsoleFixtureOptions,
): Promise<ConsoleHandle> {
  const port = await ctx.allocPort()
  const configRoot = join(
    ctx.workdir,
    options.configDirName ?? 'console-config',
  )
  const argv = [
    'console',
    '--port',
    String(port),
    '--hostname',
    '127.0.0.1',
    '--registry',
    options.registryUrl,
  ]
  for (const target of options.wakeTargets ?? []) {
    argv.push('--wake-url', `${target.node}=${target.url}`)
  }
  if (options.signWakes === true) argv.push('--wake-sign')
  argv.push(...(options.extraArgs ?? []))

  const env: Record<string, string> = {
    OCC_IDENTITY: 'qianmo',
    OCC_CONFIG_DIR: configRoot,
  }
  for (const [node, psk] of Object.entries(options.wakePsk ?? {})) {
    env[wakePskEnvVar(node)] = psk
  }
  if (options.viewToken !== undefined) {
    env.QIANMO_CONSOLE_VIEW_TOKEN = options.viewToken
  }
  if (options.adminToken !== undefined) {
    env.QIANMO_CONSOLE_ADMIN_TOKEN = options.adminToken
  }

  const proc = spawnCli({ argv, env })
  ctx.cleanup(() => proc.stop())

  const url = `http://127.0.0.1:${port}`
  await waitFor(() => proc.stdout().includes('admin-token'), {
    timeoutMs: 40_000,
    what: '控制台的启动 banner',
    diagnose: () => `stdout:\n${proc.stdout()}\nstderr:\n${proc.stderr()}`,
    signal: ctx.signal,
  })
  await waitFor(async () => (await http(`${url}/v0/health`)).status === 200, {
    timeoutMs: 40_000,
    stepMs: 150,
    what: '控制台的 /v0/health',
    diagnose: () => `stderr:\n${proc.stderr()}`,
    signal: ctx.signal,
  })

  const banner = proc.stdout()
  const viewToken = options.viewToken ?? VIEW_TOKEN_LINE.exec(banner)?.[1] ?? ''
  const adminToken =
    options.adminToken ?? ADMIN_TOKEN_LINE.exec(banner)?.[1] ?? ''

  return {
    url,
    port,
    viewToken,
    adminToken,
    configRoot,
    process: proc,
    banner: () => proc.stdout(),
    stderr: () => proc.stderr(),
  }
}
