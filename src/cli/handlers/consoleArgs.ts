// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `occ console` 的参数面，与启动面分开的一个文件。
 *
 * 分开有一个具体理由：这里**不 import `@qianmo/console`**。控制台包的 HTTP 面
 * 与视图层是另外两条工作线，参数解析不该在它们落地之前就跑不起来——同样地，
 * 参数解析的用例也不该因为视图层的一个语法错误而变红。启动面
 * (`console.ts`) 才是把两边接起来的地方。
 *
 * 形状照 `resident.ts` / `residentWake.ts`：`parseXxxArgs` 是纯函数（把 argv
 * 变成一个已经全部校验过的配置对象，不碰进程、不开端口、不读磁盘），
 * `runXxx(args)` 才有副作用。
 */

import { isAbsolute, resolve } from 'node:path'
import { occConfigPath } from '../../config/paths.js'
import { IDENTITY_MODE, type IdentityMode } from '../../constants/identity.js'
import { auditTrailPath } from '../../services/qianmo/auditTrail.js'
import { residentOptionValue } from './residentArgs.js'

/**
 * 默认监听端口。
 *
 * **38613 是挑过的**：`docs/dev/demo-env.md` §2.4 把 38610 / 38611 / 38612 分给
 * 了注册中心与两个演示节点，控制台要能和整套演示拓扑同时起在一台机器上，所以
 * 取下一个空位。改这个数字前先回去看那张表。
 */
export const DEFAULT_CONSOLE_PORT = 38_613

/** 默认只绑回环——见 `packages/console/src/auth.ts` 的 `resolveTokens` 注释。 */
export const DEFAULT_CONSOLE_HOSTNAME = '127.0.0.1'

/** 默认注册中心：演示拓扑里的那一个（demo-env.md §2.4）。 */
export const DEFAULT_CONSOLE_REGISTRY_URL = 'http://127.0.0.1:38610'

/** 页头标签的长度上限，纯粹为了别把页头撑爆。 */
export const MAX_CONSOLE_LABEL_LENGTH = 120

/**
 * 控制台在网络上的默认地址。
 *
 * 它**不是**一个注册进注册中心的节点：控制台只拨出去，没人拨它（理由见
 * `consoleChat.ts` 的模块注释）。这个地址的用处是让对面的常驻节点知道「这条
 * task.request 是谁发的」——`InboundAdapter` 会把它重新渲染进 provenance，并且
 * 写成收件箱里那条消息的 `from`。
 *
 * 两段都必须是合法的地址段（小写字母数字加 `-` `_`），由 `assertAddress` 在
 * `createConsoleChatPort` 里把关，不在这里抄一份规则。
 */
export const DEFAULT_CONSOLE_CHAT_FROM = 'qianmo://console/operator'

/**
 * 会话落盘的默认位置。
 *
 * 从 `occConfigPath()` 派生，和审计链、常驻会话表同一条规矩（CLAUDE.md §1.1②）：
 * 这里绝不出现拼好的家目录路径，`OCC_CONFIG_DIR` 因此对它同样有效——演示拓扑给
 * 每个进程一个配置根，控制台的转录也就跟着分家。
 */
export function consoleChatStorePath(): string {
  return occConfigPath('qianmo', 'console', 'chat.ndjson')
}

/** `occ console` 的全部配置，解析完就不再变。 */
export interface ConsoleCliConfig {
  readonly port: number
  readonly hostname: string
  /** 注册中心 HTTP v0 基址，**不带**尾斜杠。 */
  readonly registryUrl: string
  /** 审计链文件的绝对路径。 */
  readonly auditPath: string
  /** 给了才启用唤醒面；`ws://` 或 `wss://`。 */
  readonly wakeUrl?: string
  /** 页头标签，默认 `hostname:port`。 */
  readonly label: string
  readonly viewToken?: string
  readonly adminToken?: string
  /**
   * 允许聊天拨号的入站端点。**给了才启用聊天面**，且还要有 PSK。
   *
   * 可以给多次，一次一个端点——名字从注册中心来（发现），能不能拨从这里来
   * （授权）。注册中心自己没有鉴权，所以两者必须分开，理由写在
   * `consoleChat.ts` 的模块注释里。
   */
  readonly chatUrls: readonly string[]
  /** 控制台自己在网络上的地址。 */
  readonly chatFrom: string
  /** 会话落盘的绝对路径。 */
  readonly chatStorePath: string
}

/** 去掉尾斜杠，让后面拼 `/v0/agents` 时不会出现 `//`。 */
function normalizeBaseUrl(raw: string, flag: string): string {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${flag} must use http or https`)
  }
  return url.toString().replace(/\/+$/, '')
}

function nonEmpty(value: string, flag: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error(`${flag} must not be empty`)
  return trimmed
}

export function parseConsoleArgs(
  args: readonly string[],
  identity: IdentityMode = IDENTITY_MODE,
): ConsoleCliConfig {
  let port = DEFAULT_CONSOLE_PORT
  let hostname = DEFAULT_CONSOLE_HOSTNAME
  let registryUrl = DEFAULT_CONSOLE_REGISTRY_URL
  let auditPath = auditTrailPath()
  let wakeUrl: string | undefined
  let label: string | undefined
  let viewToken: string | undefined
  let adminToken: string | undefined
  const chatUrls: string[] = []
  let chatFrom = DEFAULT_CONSOLE_CHAT_FROM
  let chatStorePath = consoleChatStorePath()

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--port' || arg?.startsWith('--port=')) {
      const parsed = residentOptionValue(args, index, '--port')
      // 空串必须先挡掉：`Number('')` 是 **0**，而 0 是合法端口，于是
      // `--port=` 会静默变成「随便绑一个」，人却以为自己指定了端口。
      const number =
        parsed.value.trim() === '' ? Number.NaN : Number(parsed.value)
      if (!Number.isInteger(number) || number < 0 || number > 65_535) {
        throw new Error('--port must be an integer from 0 to 65535')
      }
      port = number
      index = parsed.next
    } else if (arg === '--hostname' || arg?.startsWith('--hostname=')) {
      const parsed = residentOptionValue(args, index, '--hostname')
      hostname = nonEmpty(parsed.value, '--hostname')
      index = parsed.next
    } else if (arg === '--registry' || arg?.startsWith('--registry=')) {
      const parsed = residentOptionValue(args, index, '--registry')
      registryUrl = normalizeBaseUrl(parsed.value, '--registry')
      index = parsed.next
    } else if (arg === '--audit' || arg?.startsWith('--audit=')) {
      const parsed = residentOptionValue(args, index, '--audit')
      // 绝对路径，和 `--timings` / `--mem-sample` 同一条规矩：控制台是长驻
      // 进程，一个相对路径的含义会随着谁在哪个目录起它而变。
      if (!isAbsolute(parsed.value)) {
        throw new Error('--audit must be an absolute path')
      }
      auditPath = resolve(parsed.value)
      index = parsed.next
    } else if (arg === '--wake-url' || arg?.startsWith('--wake-url=')) {
      const parsed = residentOptionValue(args, index, '--wake-url')
      const url = new URL(parsed.value)
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        throw new Error('--wake-url must use ws or wss')
      }
      wakeUrl = url.toString()
      index = parsed.next
    } else if (arg === '--label' || arg?.startsWith('--label=')) {
      const parsed = residentOptionValue(args, index, '--label')
      const text = nonEmpty(parsed.value, '--label')
      if (text.length > MAX_CONSOLE_LABEL_LENGTH) {
        throw new Error(
          `--label must be at most ${MAX_CONSOLE_LABEL_LENGTH} characters`,
        )
      }
      label = text
      index = parsed.next
    } else if (arg === '--view-token' || arg?.startsWith('--view-token=')) {
      const parsed = residentOptionValue(args, index, '--view-token')
      viewToken = nonEmpty(parsed.value, '--view-token')
      index = parsed.next
    } else if (arg === '--admin-token' || arg?.startsWith('--admin-token=')) {
      const parsed = residentOptionValue(args, index, '--admin-token')
      adminToken = nonEmpty(parsed.value, '--admin-token')
      index = parsed.next
    } else if (arg === '--chat-url' || arg?.startsWith('--chat-url=')) {
      const parsed = residentOptionValue(args, index, '--chat-url')
      const url = new URL(parsed.value)
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        throw new Error('--chat-url must use ws or wss')
      }
      // Repeatable, and deduplicated here rather than at the far end: giving
      // the same endpoint twice is a copy-paste, not a request for two links.
      const normalized = url.toString()
      if (!chatUrls.includes(normalized)) chatUrls.push(normalized)
      index = parsed.next
    } else if (arg === '--chat-from' || arg?.startsWith('--chat-from=')) {
      const parsed = residentOptionValue(args, index, '--chat-from')
      // Shape is checked by `assertAddress` where the address is used; here it
      // only has to be non-empty, so there is one copy of the address rules.
      chatFrom = nonEmpty(parsed.value, '--chat-from')
      index = parsed.next
    } else if (arg === '--chat-store' || arg?.startsWith('--chat-store=')) {
      const parsed = residentOptionValue(args, index, '--chat-store')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--chat-store must be an absolute path')
      }
      chatStorePath = resolve(parsed.value)
      index = parsed.next
    } else {
      throw new Error(`unknown console option ${String(arg)}`)
    }
  }

  if (identity !== 'qianmo') {
    throw new Error('console requires OCC_IDENTITY=qianmo')
  }

  // token 的长度与「两个必须不同」由 `resolveTokens` 判——那条策略连同「非环回
  // 必须显式给」一起住在 `packages/console/src/auth.ts`，这里再抄一份就等于给
  // 同一条规则开了第二个可以漂移的出处。
  return {
    port,
    hostname,
    registryUrl,
    auditPath,
    ...(wakeUrl === undefined ? {} : { wakeUrl }),
    label: label ?? `${hostname}:${port}`,
    ...(viewToken === undefined ? {} : { viewToken }),
    ...(adminToken === undefined ? {} : { adminToken }),
    chatUrls,
    chatFrom,
    chatStorePath,
  }
}

/** 控制台跑在 `Bun.serve` 上，和常驻模式同一条运行时断言。 */
export function assertConsoleRuntime(
  bunAvailable: boolean = typeof Bun !== 'undefined',
): void {
  if (!bunAvailable) {
    throw new Error('console mode requires the Bun runtime')
  }
}
