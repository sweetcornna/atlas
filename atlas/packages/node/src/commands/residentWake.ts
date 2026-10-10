// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { HandshakeIdentity } from '@qianmo/transport'
import { StaticPublicKeyDirectory } from '@qianmo/capability'
import {
  MessageType,
  assertAddress,
  createMessage,
  newId,
} from '@qianmo/protocol'
import { NodeRouter } from '@qianmo/router'
import {
  PSK_ENV_VAR,
  TransportClient,
  TransportReceiptError,
  pskFromEnv,
  type SuccessfulReceiptStatus,
} from '@qianmo/transport'
import { residentOptionValue } from './residentArgs.js'
import { loadOrCreateNodeKeys, parseTrustedKey } from '../host/nodeIdentity.js'
import { createConsoleWakeIssuer } from './consoleWakeIdentity.js'
import type { WakeCapabilityIssuer } from './wakeCapability.js'
export type {
  WakeCapabilityBinding,
  WakeCapabilityIssuer,
} from './wakeCapability.js'

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

/**
 * Everything a capability token for this wake has to be bound to.
 *
 * The four fields are not a convenience bundle — they are exactly the checks
 * `verifyCapability` runs against the message it arrived with, so a caller that
 * can fill this in can mint a token that will actually verify, and a caller that
 * cannot has no business minting one.
 *
 * `sub` is the **whole address**, not its agent segment: the verifying node
 * passes `handler: message.to` (`packages/capability/src/gate.ts`), so anything
 * shorter is refused as a subject mismatch.
 */
export interface ResidentWakeConfig {
  /** Host-only live authorization check; throws before any wake can leave. */
  readonly beforeDispatch?: () => void
  /** CLI opt-in; no ambient key is loaded for legacy unsigned callers. */
  readonly sign?: boolean
  readonly trusted?: { readonly node: string; readonly publicKey: string }[]
  readonly signing?: HandshakeIdentity
  /** Host-only durable attribution before any network side effect. */
  readonly onTaskCreated?: (taskId: string, node: string) => void
  readonly url: string
  readonly from: string
  readonly to: string
  readonly prompt: string
  readonly afterMs: number
  readonly timeoutMs: number
  readonly deliverTtlMs: number
  /**
   * How this sender signs the wake, when it signs at all.
   *
   * Absent means the envelope carries no `cap` field, which is the shape every
   * wake had before P12.4 and the shape a node with `--open-policy` still
   * accepts. It is deliberately **not** defaulted to some ambient identity:
   * presenting a token the receiving node cannot resolve is refused
   * (`E_CAP_INVALID`) under *either* policy, so "sign by default" would break
   * exactly the deployments that have not distributed a key yet.
   *
   * The hook exists rather than a key pair because the binding is only knowable
   * here: `taskId` is minted in {@link executeResidentWake}, and the token has
   * to carry that same value or it is refused as bound to another task.
   */
  readonly issueCapability?: WakeCapabilityIssuer
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
 * `qm resident-wake --help` 打印的全文。
 *
 * 这条命令没有一份对应的选项表文档，所以这里是唯一的自助入口。四个必填项一个
 * 都不能省，而它们的报错是一条一条来的（`--url` 缺了先报 `--url`），所以帮助里
 * 要把四个一次列全，免得人靠反复撞错误把它们凑出来。
 */
export const RESIDENT_WAKE_HELP_TEXT = `Usage: qm resident-wake [options]

Send one wake message to an agent on another node and print the receipt as
JSON. One invocation sends one message and exits. Requires a key in
$${PSK_ENV_VAR} that the far node shares.

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
  --sign                  Sign both the handshake and wake capability.
  --trust <node>=<key>     Fixed target node public key; required with --sign.
                           --sign requires a mutually signed target channel.
  --print-identity        With --from only, print the local node public key.
  -h, --help               Print this and exit.

Environment:

  ${PSK_ENV_VAR}     Transport pre-shared key, required. Environment
                           only, never a command-line option: a key on a
                           command line is a key in every process listing on
                           this machine.
`

export function parseResidentWakeArgs(
  args: readonly string[],
): ResidentWakeConfig {
  let url: string | undefined
  let from: string | undefined
  let to: string | undefined
  let prompt: string | undefined
  let afterMs = DEFAULT_WAKE_AFTER_MS
  let timeoutMs = DEFAULT_WAKE_TIMEOUT_MS
  let deliverTtlMs = DEFAULT_WAKE_DELIVER_TTL_MS
  let sign = false
  const trusted: { node: string; publicKey: string }[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--sign') {
      sign = true
    } else if (arg === '--trust' || arg?.startsWith('--trust=')) {
      const parsed = residentOptionValue(args, index, '--trust')
      const [node, publicKey] = parseTrustedKey(parsed.value)
      if (trusted.some(key => key.node === node))
        throw new Error('duplicate --trust node')
      trusted.push({ node, publicKey })
      index = parsed.next
    } else if (arg === '--url' || arg?.startsWith('--url=')) {
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
          ' (run `qm resident-wake --help` for the list)',
      )
    }
  }

  if (url === undefined) throw new Error('resident wake requires --url')
  if (from === undefined) throw new Error('resident wake requires --from')
  if (to === undefined) throw new Error('resident wake requires --to')
  if (prompt === undefined) throw new Error('resident wake requires --prompt')
  if (sign && !trusted.some(key => key.node === assertAddress(to).node))
    throw new Error('--sign requires --trust for the target node')
  if (trusted.length && !sign) throw new Error('--trust requires --sign')

  return {
    url,
    from,
    to,
    prompt,
    afterMs,
    timeoutMs,
    deliverTtlMs,
    ...(sign ? { sign, trusted } : {}),
  }
}

interface ResidentWakeResult {
  readonly msgId: string
  readonly taskId: string
  readonly receipt: SuccessfulReceiptStatus
}

/** A send was attempted but no definitive receipt arrived. Never release quota. */
export class WakeDeliveryUnknownError extends Error {
  constructor(
    readonly taskId: string,
    readonly msgId: string,
  ) {
    super(
      `Wake delivery outcome is unknown; task ${taskId}, msg ${msgId}. Inspect the node audit before retrying.`,
    )
    this.name = 'WakeDeliveryUnknownError'
  }
}

/** What the target node's `error` envelope said, as it arrived. */
export interface WakeRefusalDetail {
  /** The node's own code, not re-typed here: it is whatever it sent. */
  readonly code: string
  readonly reason: string
}

/**
 * The target node had the envelope and decided against it.
 *
 * Kept apart from every other failure this module can raise, and that is the
 * whole point of the class: a refusal means the handshake completed, the
 * envelope was delivered, and a node made a decision about it. Reporting that
 * as anything network-shaped sends an operator to check tunnels and ports for
 * a message that arrived (issue #29).
 *
 * ## Why the reason has to be picked up separately
 *
 * A refusing node answers **twice**, on two different channels:
 *
 * - a protocol `error` envelope carrying the real code and sentence — the
 *   node's own account of why (`resident.ts` `#receive`);
 * - a rejected transport receipt, whose code `receiveEnvelope` flattens to
 *   `E_UNDELIVERABLE` for *every* handler refusal, because the transport layer
 *   holds no policy knowledge and must not invent one.
 *
 * A dialer that registers no inbound handler discards the first and is left
 * with the second, which says "the last hop could not write this into the
 * mailbox" about a message the node deliberately refused. That is exactly how
 * `E_CAP_INSUFFICIENT` reached an operator as `unreachable`. The console's chat
 * surface has always read the same envelope (`consoleChat.ts` `onReply`); this
 * is the wake surface catching up, not a new disclosure — those bytes are
 * already sent to every peer that clears the handshake.
 *
 * ## Why `detail` can be absent
 *
 * Not every refusal comes with an envelope: a `wake` refused past the routing
 * layer (an agent this node does not host, a mailbox write that failed) has no
 * task to answer on and nothing is sent back. An absent reason is reported as
 * absent rather than guessed at — the node's audit trail still has it.
 */
export class WakeRefusedError extends Error {
  /** The message the target node refused, for joining onto its audit trail. */
  readonly msgId: string
  /** Present only when the node also sent an `error` envelope. */
  readonly detail: WakeRefusalDetail | undefined
  /**
   * What the receipt carried. Always `E_UNDELIVERABLE` today — recorded so a
   * reader can see it was consulted, never shown to an operator as the reason.
   */
  readonly receiptCode: string | undefined

  constructor(
    receipt: TransportReceiptError,
    detail: WakeRefusalDetail | undefined,
  ) {
    super(
      detail === undefined
        ? `the target node refused wake ${receipt.msgId}; the reason is in that node's audit trail`
        : `the target node refused wake ${receipt.msgId}: ${detail.code}: ${detail.reason}`,
    )
    this.name = 'WakeRefusedError'
    this.msgId = receipt.msgId
    this.detail = detail
    this.receiptCode = receipt.receiptCode
  }
}

/**
 * Read an `error` payload off the wire without trusting its shape.
 *
 * `code` stays a string rather than being narrowed to `ProtocolErrorCode`: a
 * node one release ahead may refuse with a code this build has never heard of,
 * and dropping that on the floor would turn the one useful refusal into the
 * vague one.
 */
function refusalDetailOf(payload: unknown): WakeRefusalDetail | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const code = record['code']
  const reason = record['reason']
  if (typeof code !== 'string' || code === '') return undefined
  if (typeof reason !== 'string' || reason === '') return undefined
  return { code, reason }
}

export async function executeResidentWake(
  config: ResidentWakeConfig,
  psk: string,
): Promise<ResidentWakeResult> {
  config.beforeDispatch?.()
  if (config.afterMs > 0) {
    await new Promise<void>(resolve => setTimeout(resolve, config.afterMs))
  }
  config.beforeDispatch?.()

  // `taskId` and `createdAt` are minted here rather than left to
  // `createMessage`'s defaults, and that hoist is the whole reason this
  // function can sign at all: a capability token is bound to one `taskId`
  // (`verifyCapability` refuses any other), so the value has to exist before
  // the envelope that carries the token is built. Reading the clock once and
  // handing the same number to both keeps the token's window measured from the
  // envelope it rides in, not from a second reading a few statements later.
  const to = assertAddress(config.to, 'to')
  const taskId = newId()
  const createdAt = Date.now()
  const cap = config.issueCapability?.({
    aud: to.node,
    sub: config.to,
    taskId,
    createdAt,
  })

  const draft = createMessage({
    from: config.from,
    to: config.to,
    type: MessageType.Wake,
    payload: {
      trigger: config.afterMs > 0 ? 'timer' : 'manual',
      prompt: config.prompt,
    },
    taskId,
    createdAt,
    deliverTtlMs: config.deliverTtlMs,
    ...(cap === undefined ? {} : { cap }),
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
  config.onTaskCreated?.(taskId, to.node)

  // Correlation is the envelope's `taskId` and nothing else — the same rule
  // `consoleChat.ts` follows, and `errorReply` copies `taskId` verbatim. An
  // envelope for some other task belongs to nobody here and is ignored.
  let refusal: WakeRefusalDetail | undefined
  const client = new TransportClient({
    endpoint: { url: config.url },
    node: from.node,
    peerNode: to.node,
    ...(config.signing === undefined ? {} : { signing: config.signing }),
    psk,
    keepAliveIntervalMs: 0,
    // Registering a handler at all is the fix for issue #29: without one the
    // node's `error` envelope is refused as undeliverable by this very process
    // and its reason is lost, leaving only the receipt's flattened
    // `E_UNDELIVERABLE`. See {@link WakeRefusedError} for the two channels.
    onMessage: (inbound, context) => {
      if (config.signing && context.channel.authenticatedPeerNode !== to.node)
        return
      if (inbound.type !== MessageType.Error) return
      if (
        inbound.taskId !== taskId ||
        inbound.from !== config.to ||
        inbound.to !== config.from
      )
        return
      refusal = refusalDetailOf(inbound.payload) ?? refusal
    },
  })

  let attempted = false
  try {
    await client.connect(Math.min(config.timeoutMs, CONNECT_TIMEOUT_CAP_MS))
    // No await between the final authority check and handing off the envelope.
    // A refusal here proves no wake was sent; it must not retain unknown-delivery quota.
    config.beforeDispatch?.()
    attempted = true
    const receipt = await client.sendAndWait(message, config.timeoutMs)
    return { msgId: message.msgId, taskId: message.taskId, receipt }
  } catch (error) {
    // A rejected receipt is the one failure that proves the far side was
    // reached: it is an answer, not a silence. Everything else here — a refused
    // dial, an exhausted reconnect budget, a receipt that never came — stays
    // exactly as it was, because those really are "could not get there".
    //
    // The envelope is written to the socket before the receipt is, so by the
    // time this rejects the reason has already been read; no grace window is
    // waited out for it, and a refusal that genuinely carried none is reported
    // as carrying none.
    if (error instanceof TransportReceiptError) {
      throw new WakeRefusedError(error, refusal)
    }
    if (attempted) throw new WakeDeliveryUnknownError(taskId, message.msgId)
    throw error
  } finally {
    await client.close()
  }
}

export async function runResidentWake(args: readonly string[]): Promise<void> {
  // 帮助排在最前面，**在 PSK 读取之前**：问「这个命令怎么用」的人恰恰是还没
  // 配好 PSK 的那个人。
  if (isResidentWakeHelpRequest(args)) {
    process.stdout.write(RESIDENT_WAKE_HELP_TEXT)
    return
  }
  if (args.includes('--print-identity')) {
    let from: string | undefined
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--print-identity') continue
      if (args[index] === '--from' || args[index]?.startsWith('--from=')) {
        const parsed = residentOptionValue(args, index, '--from')
        from = parsed.value
        index = parsed.next
      } else throw new Error('--print-identity accepts only --from')
    }
    if (!from) throw new Error('--print-identity requires --from')
    const node = assertAddress(from).node
    process.stdout.write(`${node}=${loadOrCreateNodeKeys(node).publicKey}\n`)
    return
  }
  const config = parseResidentWakeArgs(args)
  let signed: Partial<ResidentWakeConfig> = {}
  if (config.sign) {
    const node = assertAddress(config.from).node
    const keys = loadOrCreateNodeKeys(node)
    signed = {
      signing: {
        keys,
        directory: new StaticPublicKeyDirectory(
          config.trusted!.map(key => [key.node, key.publicKey]),
        ),
        required: true,
      },
      issueCapability: createConsoleWakeIssuer(node, keys),
    }
  }
  const result = await executeResidentWake(
    { ...config, ...signed },
    pskFromEnv(),
  )
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

/** `qm resident-wake`. */
export async function run(argv: string[]): Promise<number> {
  await runResidentWake(argv)
  return 0
}
