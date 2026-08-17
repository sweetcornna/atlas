// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `occ console` —— 阡陌控制面板的启动面（P11）。
 *
 *   OCC_IDENTITY=qianmo occ console
 *   OCC_IDENTITY=qianmo occ console --registry http://127.0.0.1:38610 \
 *     --wake-url ws://127.0.0.1:38611
 *
 * 这个文件只做三件事：解析参数（委给 `consoleArgs.ts`）、把五个端口的生产实现
 * 注进 `ConsoleDeps`（委给 `consolePorts.ts`）、把服务起起来并把人需要的几行
 * 字打到 stdout。**面板的行为一点都不在这里**——路由、鉴权、渲染全在
 * `@qianmo/console` 包里，那是它能被单测的原因。
 *
 * 范围依据：roadmap M1「注册发现产品化」——「最小 Web 控制台（智能体列表、
 * 状态、消息链查看）」，出口判据「内测用户无需接触 CLI 即可完成注册与查看」。
 * 文档见 `docs/dev/console.md`。
 */

import { randomBytes } from 'node:crypto'
import {
  resolveTokens,
  startConsoleServer,
  type ConsoleDeps,
  type RegistryPort,
  type WakePort,
} from '@qianmo/console'
import { pskFromEnv } from '@qianmo/transport'
import { createConsoleChatPort, type ConsoleChatHub } from './consoleChat.js'
import {
  assertConsoleRuntime,
  parseConsoleArgs,
  type ConsoleCliConfig,
} from './consoleArgs.js'
import {
  consoleLimits,
  createAuditPort,
  createRegistryPort,
  createWakePort,
} from './consolePorts.js'

/**
 * 32 个 base64url 字符，远在 `MIN_TOKEN_LENGTH`（16）之上。
 *
 * 导出是为了让 `consoleTokens.test.ts` 能把「CLI 生成的 token 满足包这一侧的
 * 下限」钉住——`resolveTokens` 对生成出来的 token 一视同仁地校验长度，所以一个
 * 太短的 generator 会变成启动失败，而那种失败只在真起控制台时才看得见。
 */
export function newConsoleToken(): string {
  return randomBytes(24).toString('base64url')
}

/** IPv6 字面量要加方括号才能进 URL。 */
function httpOrigin(hostname: string, port: number): string {
  const bracketed =
    hostname.includes(':') && !hostname.startsWith('[')
      ? `[${hostname}]`
      : hostname
  return `http://${bracketed}:${port}`
}

/** 唤醒面的接线结果：端口本身，外加一句给人看的原因。 */
interface WakeWiring {
  readonly port?: WakePort
  readonly status: string
}

/**
 * 唤醒面要**两个**条件同时成立：给了 `--wake-url`，且环境里有一把可用的 PSK。
 *
 * 缺任何一个都不注入这个端口，而不是注入一个必定失败的：`ConsoleDeps.wake`
 * 留空时页面把唤醒表单渲染成禁用并说明原因（`deps.ts` 的注释），那比一个按下去
 * 永远报错的按钮诚实。PSK 只从环境变量取，不给命令行选项——命令行上的密钥就是
 * 这台机器每一份进程列表里的密钥，和 `--backup-url` 那条同一个理由。
 */
function wireWake(config: ConsoleCliConfig): WakeWiring {
  if (config.wakeUrl === undefined) {
    return { status: 'disabled (no --wake-url)' }
  }
  let psk: string
  try {
    psk = pskFromEnv()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { status: `disabled (${reason})` }
  }
  return {
    port: createWakePort({ url: config.wakeUrl, psk }),
    status: `enabled -> ${config.wakeUrl}`,
  }
}

/** 聊天面的接线结果，形状与 {@link WakeWiring} 一致。 */
interface ChatWiring {
  readonly hub?: ConsoleChatHub
  readonly status: string
}

/**
 * 聊天面要**两个**条件同时成立：至少给了一个 `--chat-url`，且环境里有 PSK。
 *
 * 缺任何一个都不注入这个端口。和唤醒面不同的是，这里的后果是**整个 `/chat` 页面
 * 不存在**（侧栏也不显示入口），而不是渲染一个禁用的表单——理由见 `deps.ts` 里
 * `ChatPort` 的注释：一个打开就说「这里什么都没有」的页面不如不给入口。
 *
 * PSK 只从环境变量取，与唤醒面同一条纪律：命令行上的密钥就是这台机器每一份进程
 * 列表里的密钥。
 */
function wireChat(
  config: ConsoleCliConfig,
  registry: RegistryPort,
): ChatWiring {
  if (config.chatUrls.length === 0) {
    return { status: 'disabled (no --chat-url)' }
  }
  let psk: string
  try {
    psk = pskFromEnv()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { status: `disabled (${reason})` }
  }
  try {
    const hub = createConsoleChatPort({
      from: config.chatFrom,
      endpoints: config.chatUrls,
      psk,
      storePath: config.chatStorePath,
      registry,
      onError: error => {
        // The console has no logger and its stdout is the banner. A chat-side
        // failure that nobody can see is worse than one line of noise.
        process.stderr.write(
          `console chat: ${error instanceof Error ? error.message : String(error)}\n`,
        )
      },
    })
    return {
      hub,
      status: `enabled as ${config.chatFrom} -> ${config.chatUrls.join(', ')}`,
    }
  } catch (error) {
    // A malformed `--chat-from` lands here: the address rules live in
    // `assertAddress`, so the check happens where the address is used rather
    // than being copied into the argument parser.
    const reason = error instanceof Error ? error.message : String(error)
    return { status: `disabled (${reason})` }
  }
}

const FIELD_WIDTH = 13

function field(name: string, value: string): string {
  return `${name.padEnd(FIELD_WIDTH)}${value}\n`
}

export async function runConsole(args: readonly string[]): Promise<void> {
  assertConsoleRuntime()
  const config = parseConsoleArgs(args)
  const wake = wireWake(config)
  // One registry port, shared: the chat face's target list and the roster are
  // the same question, and two ports would be two answers that can disagree.
  const registry = createRegistryPort({ baseUrl: config.registryUrl })
  const chat = wireChat(config, registry)

  const deps: ConsoleDeps = {
    registry,
    audit: createAuditPort({ path: config.auditPath }),
    limits: consoleLimits(),
    label: config.label,
    ...(wake.port === undefined ? {} : { wake: wake.port }),
    ...(chat.hub === undefined ? {} : { chat: chat.hub }),
  }

  // 「什么时候允许没有密码地跑一个控制台」只有一个答案，住在
  // `packages/console/src/auth.ts`。这里只负责把参数递过去，以及提供一个真随机
  // 的 `generate`——非环回缺 token 时它会抛，那正是我们要的：起不来比悄悄起来
  // 好，`--hostname 0.0.0.0` 正是控制台被挂上公网的那条路。
  const tokens = resolveTokens({
    ...(config.viewToken === undefined ? {} : { view: config.viewToken }),
    ...(config.adminToken === undefined ? {} : { admin: config.adminToken }),
    hostname: config.hostname,
    generate: newConsoleToken,
  })

  const handle = startConsoleServer(deps, config.port, {
    hostname: config.hostname,
    tokens,
  })

  const origin = httpOrigin(config.hostname, handle.port)
  // token 是自己生成的才回显：显式提供的那一个已经在操作者手里，把它再打进
  // 终端记录和 CI 日志里只是白白多一份泄露面。
  const viewGenerated = config.viewToken === undefined
  const adminGenerated = config.adminToken === undefined

  let banner = field('console', origin)
  banner += field(
    'open',
    viewGenerated
      ? `${origin}/?token=${tokens.view}`
      : `${origin}/?token=<your view token>`,
  )
  if (viewGenerated) banner += field('view-token', tokens.view)
  if (adminGenerated) banner += field('admin-token', tokens.admin)
  banner += field('registry', config.registryUrl)
  banner += field('audit-trail', config.auditPath)
  banner += field('wake', wake.status)
  banner += field('chat', chat.status)
  if (chat.hub !== undefined) {
    banner += field('chat-store', config.chatStorePath)
  }
  banner += field('label', config.label)
  process.stdout.write(banner)

  const stop = (): void => {
    void handle.stop()
    // Closing the hub drops the outbound links and the pending-task timers. A
    // console that exits without it leaves a WebSocket the far node keeps a
    // channel record for until its own idle timeout.
    void chat.hub?.close()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
