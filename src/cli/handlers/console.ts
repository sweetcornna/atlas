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
import { readFileSync } from 'node:fs'
import { invokedBinName } from '../../constants/brand.js'
import {
  resolveTokens,
  startConsoleServer,
  type ConsoleDeps,
  type RegistryPort,
  type WakePort,
} from '@qianmo/console'
import { isNodePublicKey } from '@qianmo/protocol'
import { pskFromEnv } from '@qianmo/transport'
import { createConsoleChatPort, type ConsoleChatHub } from './consoleChat.js'
import {
  CONSOLE_HELP_TEXT,
  assertConsoleRuntime,
  isConsoleHelpRequest,
  parseConsoleArgs,
  type ConsoleCliConfig,
} from './consoleArgs.js'
import {
  consoleLimits,
  createAuditPort,
  createCertificatePort,
  createRegistryPort,
  createWakePort,
} from './consolePorts.js'
import { resolveConsoleTokenSource } from './consoleTokenSources.js'

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

/** Resolve a node key from the published registry record, never from anchors. */
function witnessPublicKeyOf(registry: RegistryPort) {
  return async (node: string) => {
    const listed = await registry.list()
    if (!listed.ok) return listed
    const prefix = `qianmo://${node}/`
    const agents = listed.value.filter(agent =>
      agent.address.startsWith(prefix),
    )
    const keys = new Set(
      agents.flatMap(agent =>
        agent.publicKey === undefined ? [] : [agent.publicKey],
      ),
    )
    if (keys.size === 0) {
      return {
        ok: false as const,
        failure: {
          code: 'not_found' as const,
          message: `名册没有节点 ${node} 的公钥`,
        },
      }
    }
    if (keys.size !== 1) {
      return {
        ok: false as const,
        failure: {
          code: 'invalid' as const,
          message: `名册中的节点 ${node} 公钥不一致`,
        },
      }
    }
    const publicKey = keys.values().next().value
    if (publicKey === undefined || !isNodePublicKey(publicKey)) {
      return {
        ok: false as const,
        failure: {
          code: 'invalid' as const,
          message: `名册中的节点 ${node} 公钥无效`,
        },
      }
    }
    return { ok: true as const, value: publicKey }
  }
}

const FIELD_WIDTH = 13

function field(name: string, value: string): string {
  return `${name.padEnd(FIELD_WIDTH)}${value}\n`
}

export async function runConsole(args: readonly string[]): Promise<void> {
  // 帮助排在最前面，**在身份校验与运行时断言之前**：问「这个命令怎么用」的人
  // 恰恰是还没把 `OCC_IDENTITY=qianmo` 配对的那个人，让他先撞一条错误再去查文档
  // 是把唯一的自助入口挡在门外。
  if (isConsoleHelpRequest(args)) {
    process.stdout.write(CONSOLE_HELP_TEXT)
    return
  }
  assertConsoleRuntime()
  const config = parseConsoleArgs(args)

  // 凭据在**接线之前**就要定下来。放在后面的代价很具体：`wireChat` 会真的向
  // `--chat-url` 拨出去，于是一个权限过宽的 token 文件会在「拒绝启动」之前先把
  // 链路建起来、把会话文件写出去。起不来的那一次就该什么都没做过。
  //
  // 每枚 token 从三个入口里挑一个（文件 > 环境变量 > 命令行，取舍写在
  // `consoleTokenSources.ts` 的模块注释里）。这一步会读磁盘，所以它不在
  // `parseConsoleArgs` 里——那个函数是纯的。
  const viewSource = resolveConsoleTokenSource('view', config)
  const adminSource = resolveConsoleTokenSource('admin', config)

  // 「什么时候允许没有密码地跑一个控制台」只有一个答案，住在
  // `packages/console/src/auth.ts`。这里只负责把参数递过去，以及提供一个真随机
  // 的 `generate`——非环回缺 token 时它会抛，那正是我们要的：起不来比悄悄起来
  // 好，`--hostname 0.0.0.0` 正是控制台被挂上公网的那条路。
  const tokens = resolveTokens({
    ...(viewSource === undefined ? {} : { view: viewSource.value }),
    ...(adminSource === undefined ? {} : { admin: adminSource.value }),
    hostname: config.hostname,
    generate: newConsoleToken,
  })

  const wake = wireWake(config)
  // One registry port, shared: the chat face's target list and the roster are
  // the same question, and two ports would be two answers that can disagree.
  const registry = createRegistryPort({ baseUrl: config.registryUrl })
  const chat = wireChat(config, registry)
  // The certificate column, or nothing at all (§10.1). Read at startup rather
  // than per request: the CA root is the one file this console needs and a
  // missing one is a configuration error the operator should hear about now,
  // not as an empty column later. It is public material — §10.3's rule that no
  // private key of any kind is reachable from this process holds structurally,
  // because there is no option here that could point at one.
  const certificates =
    config.trustCa === undefined
      ? undefined
      : createCertificatePort({
          baseUrl: config.registryUrl,
          caCertificatePem: readFileSync(config.trustCa, 'utf8'),
        })

  const deps: ConsoleDeps = {
    registry,
    audit: createAuditPort({
      path: config.auditPath,
      ...(config.anchors === undefined ? {} : { witness: config.anchors }),
      ...(config.anchors === undefined
        ? {}
        : { publicKeyOf: witnessPublicKeyOf(registry) }),
    }),
    limits: consoleLimits(),
    label: config.label,
    // Display only. The wake form used to carry a 回调 text box that could hold
    // exactly one value — `createWakePort` pins it — so the field is gone and
    // the page states the pinned URL as read-only small print instead. Passed
    // only when the wake face is actually wired: printing a receipt endpoint
    // beside a disabled form would be stating a fact about a thing that cannot
    // happen.
    ...(wake.port === undefined || config.wakeUrl === undefined
      ? {}
      : { wakeUrl: config.wakeUrl }),
    // Prefills the wake form's 发起方. The chat face already speaks as this
    // address (§6.3), and a console that introduces itself as one thing when
    // chatting and another when waking is a console whose audit trail has two
    // identities in it.
    identity: config.chatFrom,
    ...(wake.port === undefined ? {} : { wake: wake.port }),
    ...(chat.hub === undefined ? {} : { chat: chat.hub }),
    ...(certificates === undefined ? {} : { certificates }),
    // Spelled once, in the identity roster — never as a literal here
    // (CLAUDE.md §2.3).
    binName: invokedBinName(),
  }

  const handle = startConsoleServer(deps, config.port, {
    hostname: config.hostname,
    tokens,
  })

  const origin = httpOrigin(config.hostname, handle.port)
  // token 是自己生成的才回显：显式提供的那一个已经在操作者手里，把它再打进
  // 终端记录和 CI 日志里只是白白多一份泄露面。**出处**则总是打——三个入口里
  // 高优先级的那个静默盖掉低的，是事后没人查得清的那类配置事故，而「这一枚
  // 来自命令行」同时就是「它此刻躺在 ps 里」的告警。
  const viewGenerated = viewSource === undefined

  let banner = field('console', origin)
  banner += field(
    'open',
    viewGenerated
      ? `${origin}/?token=${tokens.view}`
      : `${origin}/?token=<your view token>`,
  )
  banner += field(
    'view-token',
    viewSource === undefined ? tokens.view : `from ${viewSource.detail}`,
  )
  banner += field(
    'admin-token',
    adminSource === undefined ? tokens.admin : `from ${adminSource.detail}`,
  )
  banner += field('registry', config.registryUrl)
  banner += field('audit-trail', config.auditPath)
  if (config.anchors !== undefined) {
    banner += field('anchors', config.anchors.value)
  }
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
