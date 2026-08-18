// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { MessageType, assertAddress, createMessage } from '@qianmo/protocol'
import { NodeRouter } from '@qianmo/router'
import {
  PSK_ENV_VAR,
  TransportClient,
  pskFromEnv,
  type SuccessfulReceiptStatus,
} from '@qianmo/transport'
import { BIN_NAME } from '../../constants/brand.js'
import { IDENTITY_MODE, type IdentityMode } from '../../constants/identity.js'
import { residentOptionValue } from './residentArgs.js'

const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * The three defaults and the connect cap, hoisted out of the parser and out of
 * `executeResidentWake`.
 *
 * Not tidiness: the help text names all four, and a default that is spelled
 * once in the parser and once in the help is a default that can drift. Same
 * rule the console help follows for its ports and limits.
 */
const DEFAULT_WAKE_AFTER_MS = 0
const DEFAULT_WAKE_TIMEOUT_MS = 90_000
const DEFAULT_WAKE_DELIVER_TTL_MS = 90_000

/**
 * Connecting is capped independently of `--timeout-ms`, which covers the wait
 * for the receipt rather than the wait for the socket.
 */
const CONNECT_TIMEOUT_CAP_MS = 30_000

export interface ResidentWakeConfig {
  readonly url: string
  readonly from: string
  readonly to: string
  readonly prompt: string
  readonly afterMs: number
  readonly timeoutMs: number
  readonly deliverTtlMs: number
}

function integer(
  raw: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return parsed
}

/**
 * `--help` / `-h` 出现在任何位置都算请求帮助。
 *
 * 位置不限，是因为「敲到一半发现忘了选项名」正是人会做的事：
 * `qm resident-wake --url ws://… --help` 必须答帮助，而不是先解析出一个配置再
 * 抛。判定用**全等**，所以 `--prompt=--help` 这种把它当值的写法不会被当成请求。
 *
 * 为什么不落回 commander：`resident-wake` 的子命令注册
 * （`cli/program/commands/qianmo.tsx`）**刻意不复制选项表**（那个文件的顶部注释
 * 写着这条），落回去只会打印一行描述加一个空的选项列表。选项的唯一出处是本文件
 * 的解析器，帮助文本因此也在这里。
 */
export function isResidentWakeHelpRequest(args: readonly string[]): boolean {
  return args.some(arg => arg === '--help' || arg === '-h')
}

/**
 * `occ resident-wake --help` 打印的全文。
 *
 * 这条命令没有一份对应的选项表文档，所以这里是唯一的自助入口。四个必填项一个
 * 都不能省，而它们的报错是一条一条来的（`--url` 缺了先报 `--url`），所以帮助里
 * 要把四个一次列全，免得人靠反复撞错误把它们凑出来。
 */
export const RESIDENT_WAKE_HELP_TEXT = `Usage: ${BIN_NAME} resident-wake [options]

Send one wake message to an agent on another node and print the receipt as
JSON. One invocation sends one message and exits. Requires OCC_IDENTITY=qianmo
and a key in $${PSK_ENV_VAR} that the far node shares.

Options (each accepts both --name value and --name=value):

Required, all four:

  --url <ws url>           The target node's inbound WebSocket, ws or wss.
  --from <address>         Who the wake is from, qianmo://<node>/<agent>. Its
                           <node> half is also the hop this process stamps
                           into the envelope, so the audit chain has a head.
  --to <address>           The agent to wake, qianmo://<node>/<agent>.
  --prompt <text>          What the woken agent is asked to do.

Optional:

  --after-ms <ms>          Wait this long before sending, an integer from 0 to
                           ${MAX_TIMER_DELAY_MS}. Default ${DEFAULT_WAKE_AFTER_MS}. Anything above 0 also makes
                           the wake read as "timer" rather than "manual" at
                           the far end.
  --timeout-ms <ms>        How long to wait for the receipt, an integer from 1
                           to ${MAX_TIMER_DELAY_MS}. Default ${DEFAULT_WAKE_TIMEOUT_MS}. Connecting is capped
                           at ${CONNECT_TIMEOUT_CAP_MS} regardless.
  --deliver-ttl-ms <ms>    How long the message stays deliverable, an integer
                           from 1 to ${MAX_TIMER_DELAY_MS}. Default ${DEFAULT_WAKE_DELIVER_TTL_MS}.
  -h, --help               Print this and exit.

Environment:

  OCC_IDENTITY             Must be "qianmo". Waking a node is part of the
                           Qianmo node identity, it does not run under plain
                           occ.
  ${PSK_ENV_VAR}     Transport pre-shared key, required. Environment
                           only, never a command-line option: a key on a
                           command line is a key in every process listing on
                           this machine.
`

export function parseResidentWakeArgs(
  args: readonly string[],
  identity: IdentityMode = IDENTITY_MODE,
): ResidentWakeConfig {
  let url: string | undefined
  let from: string | undefined
  let to: string | undefined
  let prompt: string | undefined
  let afterMs = DEFAULT_WAKE_AFTER_MS
  let timeoutMs = DEFAULT_WAKE_TIMEOUT_MS
  let deliverTtlMs = DEFAULT_WAKE_DELIVER_TTL_MS

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--url' || arg?.startsWith('--url=')) {
      const parsed = residentOptionValue(args, index, '--url')
      const endpoint = new URL(parsed.value)
      if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') {
        throw new Error('--url must use ws or wss')
      }
      url = endpoint.toString()
      index = parsed.next
    } else if (arg === '--from' || arg?.startsWith('--from=')) {
      const parsed = residentOptionValue(args, index, '--from')
      assertAddress(parsed.value, '--from')
      from = parsed.value
      index = parsed.next
    } else if (arg === '--to' || arg?.startsWith('--to=')) {
      const parsed = residentOptionValue(args, index, '--to')
      assertAddress(parsed.value, '--to')
      to = parsed.value
      index = parsed.next
    } else if (arg === '--prompt' || arg?.startsWith('--prompt=')) {
      const parsed = residentOptionValue(args, index, '--prompt')
      if (parsed.value.trim() === '')
        throw new Error('--prompt must not be empty')
      prompt = parsed.value
      index = parsed.next
    } else if (arg === '--after-ms' || arg?.startsWith('--after-ms=')) {
      const parsed = residentOptionValue(args, index, '--after-ms')
      afterMs = integer(parsed.value, '--after-ms', 0, MAX_TIMER_DELAY_MS)
      index = parsed.next
    } else if (arg === '--timeout-ms' || arg?.startsWith('--timeout-ms=')) {
      const parsed = residentOptionValue(args, index, '--timeout-ms')
      timeoutMs = integer(parsed.value, '--timeout-ms', 1, MAX_TIMER_DELAY_MS)
      index = parsed.next
    } else if (
      arg === '--deliver-ttl-ms' ||
      arg?.startsWith('--deliver-ttl-ms=')
    ) {
      const parsed = residentOptionValue(args, index, '--deliver-ttl-ms')
      deliverTtlMs = integer(
        parsed.value,
        '--deliver-ttl-ms',
        1,
        MAX_TIMER_DELAY_MS,
      )
      index = parsed.next
    } else {
      // 指一下帮助：走到这一支的人多半是拼错了选项名，而在 `--help` 存在之前
      // 他没有任何地方可以去查那张表。
      throw new Error(
        `unknown resident wake option ${String(arg)}` +
          ` (run \`${BIN_NAME} resident-wake --help\` for the list)`,
      )
    }
  }

  if (identity !== 'qianmo') {
    throw new Error('resident wake requires OCC_IDENTITY=qianmo')
  }
  if (url === undefined) throw new Error('resident wake requires --url')
  if (from === undefined) throw new Error('resident wake requires --from')
  if (to === undefined) throw new Error('resident wake requires --to')
  if (prompt === undefined) throw new Error('resident wake requires --prompt')

  return { url, from, to, prompt, afterMs, timeoutMs, deliverTtlMs }
}

interface ResidentWakeResult {
  readonly msgId: string
  readonly taskId: string
  readonly receipt: SuccessfulReceiptStatus
}

export async function executeResidentWake(
  config: ResidentWakeConfig,
  psk: string,
): Promise<ResidentWakeResult> {
  if (config.afterMs > 0) {
    await new Promise<void>(resolve => setTimeout(resolve, config.afterMs))
  }

  const draft = createMessage({
    from: config.from,
    to: config.to,
    type: MessageType.Wake,
    payload: {
      trigger: config.afterMs > 0 ? 'timer' : 'manual',
      prompt: config.prompt,
    },
    deliverTtlMs: config.deliverTtlMs,
  })
  // protocol.md §6.3 call site 1: the origin stamps itself into `hops[0]`
  // before the envelope reaches a transport, so the audit chain has a head and
  // the hop backstop counts from one rather than from zero.
  //
  // The runtime throttle this also consults is, in this process, always full:
  // one CLI invocation sends one message and exits. That is not a reason to
  // skip the gate — going through the same door as every other sender is what
  // keeps the seeding rule from having a second, subtly different copy.
  const from = assertAddress(config.from)
  const routed = new NodeRouter({ node: from.node }).outbound(draft)
  if (!routed.ok) throw new Error(`${routed.code}: ${routed.reason}`)
  const message = routed.message

  const client = new TransportClient({
    endpoint: { url: config.url },
    node: from.node,
    psk,
    keepAliveIntervalMs: 0,
  })

  try {
    await client.connect(Math.min(config.timeoutMs, CONNECT_TIMEOUT_CAP_MS))
    const receipt = await client.sendAndWait(message, config.timeoutMs)
    return { msgId: message.msgId, taskId: message.taskId, receipt }
  } finally {
    await client.close()
  }
}

export async function runResidentWake(args: readonly string[]): Promise<void> {
  // 帮助排在最前面，**在身份校验与 PSK 读取之前**：问「这个命令怎么用」的人
  // 恰恰是还没把 `OCC_IDENTITY=qianmo` 和 PSK 配对的那个人。
  if (isResidentWakeHelpRequest(args)) {
    process.stdout.write(RESIDENT_WAKE_HELP_TEXT)
    return
  }
  const result = await executeResidentWake(
    parseResidentWakeArgs(args),
    pskFromEnv(),
  )
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
