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
import { isValidSegment, MAX_SEGMENT_LENGTH } from '@qianmo/protocol'
import { PSK_ENV_VAR } from '@qianmo/transport'
import { occConfigPath } from '../../config/paths.js'
import { invokedBinName } from '../../constants/brand.js'
import { IDENTITY_MODE, type IdentityMode } from '../../constants/identity.js'
import { auditTrailPath } from '../../services/qianmo/auditTrail.js'
import {
  parseAuditWitnessSource,
  WITNESS_READ_TOKEN_ENV_VAR,
  type AuditWitnessSource,
} from '../../services/qianmo/auditWitness.js'
import {
  ADMIN_TOKEN_ENV_VAR,
  VIEW_TOKEN_ENV_VAR,
} from './consoleTokenSources.js'
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

/** Legacy single-value flags are represented by this stable source name. */
export const DEFAULT_CONSOLE_NODE = 'default'

export interface ConsoleAuditTarget {
  readonly node: string
  readonly path: string
}

export interface ConsoleAuditMirror {
  readonly node: string
  readonly maxLagMinutes: number
}

export interface ConsoleWakeTarget {
  readonly node: string
  readonly url: string
  /** Only the old single URL is allowed to use QIANMO_TRANSPORT_PSK. */
  readonly legacy: boolean
}

/**
 * PSK variable for a named wake target. UTF-8 hex is one-to-one and legal in
 * POSIX, Windows, and Bun environment names, unlike replacing '-' with '_'.
 */
export function wakePskEnvVarForNode(node: string): string {
  assertConsoleNodeName(node, '--wake-url')
  return `QIANMO_TRANSPORT_PSK_NODE_${Buffer.from(node, 'utf8')
    .toString('hex')
    .toUpperCase()}`
}

function assertConsoleNodeName(node: string, flag: string): void {
  if (!isValidSegment(node)) {
    throw new Error(
      `${flag} node must be a lowercase protocol segment (letters, digits, - or _, 1-${MAX_SEGMENT_LENGTH} characters, starting and ending with a letter or digit)`,
    )
  }
}

function parseNamedValue(
  raw: string,
  flag: string,
): { readonly node: string; readonly value: string } {
  const equals = raw.indexOf('=')
  if (equals <= 0) {
    throw new Error(`${flag} must be <node>=<value>`)
  }
  const node = raw.slice(0, equals)
  const value = raw.slice(equals + 1)
  assertConsoleNodeName(node, flag)
  if (value.trim() === '') throw new Error(`${flag} value must not be empty`)
  return { node, value }
}

/** A complete URL is always the legacy form; its protocol is checked by caller. */
function legacyWakeUrl(raw: string): URL | undefined {
  try {
    return new URL(raw)
  } catch {
    return undefined
  }
}

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
  /** Ordered, independently rendered audit sources. */
  readonly auditTargets: readonly ConsoleAuditTarget[]
  /** Explicit mirror metadata; paths never imply mirror status. */
  readonly auditMirrors: readonly ConsoleAuditMirror[]
  /** 给了才读取机外锚点；目录或 HTTP(S) 端点。 */
  readonly anchors?: AuditWitnessSource
  /** Explicit allowlist of wake endpoints. */
  readonly wakeTargets: readonly ConsoleWakeTarget[]
  /**
   * CA 根证书的绝对路径。**给了才有证书栏**（key-distribution.md §10.1）。
   *
   * 是根证书而不是证书目录：控制台要做的那一次判定是 F-2——「这张证书是不是本
   * CA 签的」——它只需要根证书里的公钥，一件**公开材料**。§10.3 那条硬规矩
   * （控制台进程不得读任何私钥）在这里是结构性的，不是靠自觉：这个参数只能指向
   * 一份公开材料，CA 私钥连一个可以出现的位置都没有。
   */
  readonly trustCa?: string
  /** 页头标签，默认 `hostname:port`。 */
  readonly label: string
  /**
   * 只读凭据，**来自命令行的那一份**。
   *
   * 命令行是三个入口里最弱的一个：它会出现在这台机器每一份进程列表里
   * （Linux 的 `/proc/<pid>/cmdline` 默认全局可读）。优先级与另两个入口的取舍
   * 写在 `consoleTokenSources.ts` 的模块注释里，这里只是解析结果。
   */
  readonly viewToken?: string
  /** 读写凭据，来自命令行；暴露面同 {@link viewToken}。 */
  readonly adminToken?: string
  /** `--view-token-file` 给的绝对路径；值由 `consoleTokenSources.ts` 读。 */
  readonly viewTokenFile?: string
  /** `--admin-token-file` 给的绝对路径。 */
  readonly adminTokenFile?: string
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
  const auditTargets: ConsoleAuditTarget[] = []
  const auditMirrors: ConsoleAuditMirror[] = []
  let legacyAudit = false
  let anchors: AuditWitnessSource | undefined
  const wakeTargets: ConsoleWakeTarget[] = []
  let legacyWake = false
  let trustCa: string | undefined
  let label: string | undefined
  let viewToken: string | undefined
  let adminToken: string | undefined
  let viewTokenFile: string | undefined
  let adminTokenFile: string | undefined
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
      // A path is complete before it is a named value: `--audit /tmp/a=b`
      // predates repeatable sources and remains a valid legacy invocation.
      if (!isAbsolute(parsed.value)) {
        if (!parsed.value.includes('=')) {
          throw new Error('--audit must be an absolute path')
        }
        if (legacyAudit) {
          throw new Error('--audit cannot mix legacy paths with named values')
        }
        const named = parseNamedValue(parsed.value, '--audit')
        if (!isAbsolute(named.value)) {
          throw new Error('--audit path must be an absolute path')
        }
        if (auditTargets.some(target => target.node === named.node)) {
          throw new Error(`--audit repeats node ${named.node}`)
        }
        const path = resolve(named.value)
        if (auditTargets.some(target => target.path === path)) {
          throw new Error(`--audit repeats path ${path}`)
        }
        auditTargets.push({ node: named.node, path })
      } else {
        // An old unlabelled value is still accepted, but only alone: mixing it
        // with named values leaves two competing ways to name the same view.
        if (legacyAudit || auditTargets.length > 0) {
          throw new Error('--audit cannot mix legacy paths with named values')
        }
        if (!isAbsolute(parsed.value)) {
          throw new Error('--audit must be an absolute path')
        }
        legacyAudit = true
        auditTargets.push({
          node: DEFAULT_CONSOLE_NODE,
          path: resolve(parsed.value),
        })
      }
      index = parsed.next
    } else if (arg === '--audit-mirror' || arg?.startsWith('--audit-mirror=')) {
      const parsed = residentOptionValue(args, index, '--audit-mirror')
      const named = parseNamedValue(parsed.value, '--audit-mirror')
      const maxLagMinutes = Number(named.value)
      if (!Number.isInteger(maxLagMinutes) || maxLagMinutes <= 0) {
        throw new Error(
          '--audit-mirror lag must be a positive integer of minutes',
        )
      }
      if (auditMirrors.some(mirror => mirror.node === named.node)) {
        throw new Error(`--audit-mirror repeats node ${named.node}`)
      }
      auditMirrors.push({ node: named.node, maxLagMinutes })
      index = parsed.next
    } else if (arg === '--trust-ca' || arg?.startsWith('--trust-ca=')) {
      const parsed = residentOptionValue(args, index, '--trust-ca')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--trust-ca must be an absolute path')
      }
      trustCa = resolve(parsed.value)
      index = parsed.next
    } else if (arg === '--anchors' || arg?.startsWith('--anchors=')) {
      const parsed = residentOptionValue(args, index, '--anchors')
      anchors = parseAuditWitnessSource(parsed.value, '--anchors')
      index = parsed.next
    } else if (arg === '--wake-url' || arg?.startsWith('--wake-url=')) {
      const parsed = residentOptionValue(args, index, '--wake-url')
      // A complete URL is legacy even when its query contains `=`. Only
      // remaining values can be interpreted as `<node>=<url>`.
      const legacyUrl = legacyWakeUrl(parsed.value)
      const named =
        legacyUrl === undefined
          ? parseNamedValue(parsed.value, '--wake-url')
          : undefined
      if (legacyUrl !== undefined && (legacyWake || wakeTargets.length > 0)) {
        throw new Error('--wake-url cannot mix legacy URLs with named values')
      }
      if (named !== undefined && legacyWake) {
        throw new Error('--wake-url cannot mix legacy URLs with named values')
      }
      const url = legacyUrl ?? new URL(named?.value ?? parsed.value)
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        throw new Error('--wake-url must use ws or wss')
      }
      const node = named?.node ?? DEFAULT_CONSOLE_NODE
      if (wakeTargets.some(target => target.node === node)) {
        throw new Error(`--wake-url repeats node ${node}`)
      }
      legacyWake ||= legacyUrl !== undefined
      wakeTargets.push({
        node,
        url: url.toString(),
        legacy: named === undefined,
      })
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
    } else if (
      // 必须排在 `--view-token` 前面读一遍才不会让人怀疑：`--view-token-file`
      // 既不等于 `--view-token`、也不以 `--view-token=` 开头，所以两条分支实际
      // 互不相交，顺序只是为了读代码的人不用自己验一遍这件事。
      arg === '--view-token-file' ||
      arg?.startsWith('--view-token-file=')
    ) {
      const parsed = residentOptionValue(args, index, '--view-token-file')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--view-token-file must be an absolute path')
      }
      viewTokenFile = resolve(parsed.value)
      index = parsed.next
    } else if (
      arg === '--admin-token-file' ||
      arg?.startsWith('--admin-token-file=')
    ) {
      const parsed = residentOptionValue(args, index, '--admin-token-file')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--admin-token-file must be an absolute path')
      }
      adminTokenFile = resolve(parsed.value)
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
      // 指一下帮助：走到这一支的人多半是拼错了选项名，而在 `--help` 存在之前
      // 他没有任何地方可以去查那张表。
      throw new Error(
        `unknown console option ${String(arg)}` +
          ` (run \`${invokedBinName()} console --help\` for the list)`,
      )
    }
  }

  if (identity !== 'qianmo') {
    throw new Error('console requires OCC_IDENTITY=qianmo')
  }

  if (auditTargets.length === 0) {
    auditTargets.push({ node: DEFAULT_CONSOLE_NODE, path: auditTrailPath() })
  }
  for (const mirror of auditMirrors) {
    if (!auditTargets.some(target => target.node === mirror.node)) {
      throw new Error(`--audit-mirror names unknown audit node ${mirror.node}`)
    }
  }

  // token 的长度与「两个必须不同」由 `resolveTokens` 判——那条策略连同「非环回
  // 必须显式给」一起住在 `packages/console/src/auth.ts`，这里再抄一份就等于给
  // 同一条规则开了第二个可以漂移的出处。
  return {
    port,
    hostname,
    registryUrl,
    auditTargets,
    auditMirrors,
    ...(anchors === undefined ? {} : { anchors }),
    wakeTargets,
    ...(trustCa === undefined ? {} : { trustCa }),
    label: label ?? `${hostname}:${port}`,
    ...(viewToken === undefined ? {} : { viewToken }),
    ...(adminToken === undefined ? {} : { adminToken }),
    ...(viewTokenFile === undefined ? {} : { viewTokenFile }),
    ...(adminTokenFile === undefined ? {} : { adminTokenFile }),
    chatUrls,
    chatFrom,
    chatStorePath,
  }
}

/**
 * `--help` / `-h` 出现在任何位置都算请求帮助。
 *
 * 位置不限，是因为「敲到一半发现忘了选项名」正是人会做的事：
 * `occ console --port 39000 --help` 必须答帮助，而不是先解析出一个配置再抛。
 * 判定用**全等**，所以 `--label=--help` 这种把它当值的写法不会被当成请求。
 *
 * 为什么不像 `occ migrate` 那样落回 commander：`console` 的子命令注册
 * （`cli/program/commands/qianmo.tsx`）**刻意不复制选项表**，落回去只会打印一行
 * 描述加一个空的选项列表。选项的唯一出处是本文件的解析器，帮助文本因此也在
 * 这里——两份会漂移的选项表比一份不好看的要糟得多。
 */
export function isConsoleHelpRequest(args: readonly string[]): boolean {
  return args.some(arg => arg === '--help' || arg === '-h')
}

/**
 * `occ console --help` 打印的全文。
 *
 * 对照 `docs/dev/console.md` §3 的选项表——那份文档是给开发者读的，这份是内测
 * 用户手上**唯一**的自助入口，所以凡是不看文档就会配错的事（绝对路径、两个
 * 「给了才启用」的面、三个 token 入口的优先级与那条进程列表的暴露）都必须在
 * 这里说全。
 */
export const CONSOLE_HELP_TEXT = `Usage: ${invokedBinName()} console [options]

Serve the Qianmo web console. Requires OCC_IDENTITY=qianmo and the Bun runtime.
Full documentation: docs/dev/console.md

Options (each accepts both --name value and --name=value):

  --port <0-65535>         Port to listen on. Default ${DEFAULT_CONSOLE_PORT};
                           0 lets the kernel pick and the real port is printed
                           on the "console" line.
  --hostname <host>        Address to bind. Default ${DEFAULT_CONSOLE_HOSTNAME}.
                           A non-loopback bind refuses to start unless both
                           tokens are supplied.
  --registry <url>         Registry HTTP v0 base URL, http or https.
                           Default ${DEFAULT_CONSOLE_REGISTRY_URL}.
  --audit <node>=<path>    Audit trail source. Repeatable; node names use
                           lowercase letters, digits, - and _, are 1-64
                           characters, and paths are absolute.
                           A legacy single <abs path> remains accepted only on
                           its own and is shown as node "${DEFAULT_CONSOLE_NODE}".
                           Default <config root>/qianmo/audit/trail.ndjson.
  --audit-mirror <node>=<minutes>
                           Mark one named audit source as a mirror with an
                           explicit maximum lag. Repeatable; paths never imply
                           mirror status. Example: beta-2=5.
  --trust-ca <abs path>    PEM root certificate of the offline CA. The
                           certificate column turns on only when this is
                           given: without a root there is nothing to check a
                           published certificate against, and a column of
                           unknowns makes "no certificates yet" and "every
                           certificate is broken" look the same. Read only —
                           this console verifies, never signs.
  --anchors <path|url>     Witness anchor directory (absolute) or HTTP(S)
                           endpoint. Without this, the trail is 未见证.
  --wake-url <node>=<ws url>
                           Wake target allowlist. Repeatable; each named node
                           reads only its derived PSK environment variable.
                           A legacy single <ws url> remains accepted only on
                           its own and uses ${PSK_ENV_VAR}.
  --chat-url <ws url>      Endpoint the chat face may dial. Repeatable, one per
                           flag, duplicates folded. The chat face turns on only
                           when at least one is given AND ${PSK_ENV_VAR}
                           holds a usable key.
  --chat-from <address>    Address the console speaks as.
                           Default ${DEFAULT_CONSOLE_CHAT_FROM}.
  --chat-store <abs path>  Where sessions and transcripts land, absolute path.
                           Default <config root>/qianmo/console/chat.ndjson.
  --label <text>           Header label, at most ${MAX_CONSOLE_LABEL_LENGTH} characters.
                           Default <hostname>:<port>.
  -h, --help               Print this and exit.

Credentials:

  Two tokens, at least 16 characters each, and they must differ. On a loopback
  bind either one is generated when nothing supplies it, and generated tokens
  are printed at startup. On any other bind both must be supplied or the
  console refuses to start.

  Each token has three entrances. The highest one that is present wins:

  1. --view-token-file <abs path> / --admin-token-file <abs path>
       Read the token out of a file; a trailing newline is stripped. The file
       must not be readable by group or other (chmod 600) or the console
       refuses to start. This is the only entrance a file mode can protect,
       which is why it wins.
  2. $${VIEW_TOKEN_ENV_VAR} / $${ADMIN_TOKEN_ENV_VAR}
       Read out of the environment, the same shape as $${PSK_ENV_VAR}.
  3. --view-token <token> / --admin-token <token>
       WARNING: the value shows up in this machine's process list
       (ps -eo args, /proc/<pid>/cmdline), which every local account can read.
       Kept so existing scripts keep working; prefer one of the two entrances
       above. The startup banner says so when a token arrives this way.

Environment:

  OCC_IDENTITY             Must be "qianmo". The console is part of the Qianmo
                           node identity, it does not run under plain occ.
  ${PSK_ENV_VAR}     Legacy single-target wake and chat PSK. Environment only,
                           never a command-line option, for the reason under
                           entrance 3.
  QIANMO_TRANSPORT_PSK_NODE_<UTF-8 HEX>
                           Per-node wake PSK for named --wake-url values. The
                           node bytes are uppercase UTF-8 hex, so beta-1 is
                           QIANMO_TRANSPORT_PSK_NODE_626574612D31. This is
                           one-to-one: beta-1 and beta_1 never collide.
  ${VIEW_TOKEN_ENV_VAR}
  ${ADMIN_TOKEN_ENV_VAR}
                           The view and admin tokens, entrance 2 above.
  ${WITNESS_READ_TOKEN_ENV_VAR}
                           Read-only token for a remote --anchors endpoint.
  OCC_CONFIG_DIR           Config root the default audit trail and transcript
                           paths are derived from.
`

/** 控制台跑在 `Bun.serve` 上，和常驻模式同一条运行时断言。 */
export function assertConsoleRuntime(
  bunAvailable: boolean = typeof Bun !== 'undefined',
): void {
  if (!bunAvailable) {
    throw new Error('console mode requires the Bun runtime')
  }
}
