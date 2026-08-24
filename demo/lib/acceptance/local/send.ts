// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 往节点发一条**自己完全掌控的**信封，并把节点的回应原样收回来。
 *
 * 为什么不用 `qm resident-wake`：它只会发**没有 cap** 的唤醒（
 * `parseResidentWakeArgs` 返回的 `issueCapability` 恒为 undefined），而能力维度
 * 的十条场景要的正是「带一个过期的 / 换了 aud 的 / 签名坏掉的 token 会怎样」。
 * 只有自己拼信封才表达得了。
 *
 * 回应有两种，都要收：
 *   · `receipt` 帧 —— `accepted` / `duplicate` / `rejected`，传输层的答复；
 *   · `error` 信封 —— 节点侧的拒绝原因（issue #34 / PR #42 之后，投递层拒绝
 *     也会补发这一条）。**它是能力与投递两维全部断言的落点。**
 */

import {
  generateNodeKeyPair,
  issueCapability,
  type NodeKeyPair,
} from '@qianmo/capability'
import {
  CapabilityLevel,
  createMessage,
  MessageType,
  withHop,
} from '@qianmo/protocol'
import type { QianmoMessage } from '@qianmo/protocol'
import { FRAME_VERSION, FrameType } from '@qianmo/transport'
import { rawDial, type RawAuth } from './dial.js'

export interface SendResult {
  /** 传输层回执状态；没收到就是 undefined。 */
  readonly receipt?: string
  readonly receiptCode?: string
  readonly receiptReason?: string
  /** 节点回的 error 信封 payload。 */
  readonly errorCode?: string
  readonly errorReason?: string
  /** 收到的全部帧原文 —— 断言不成立时这就是证据。 */
  readonly frames: readonly string[]
  readonly closeCode?: number
  readonly dialError?: string
  readonly message: QianmoMessage
}

export interface SendOptions {
  readonly url: string
  readonly psk: string
  /** 发送方节点段，握手时用。 */
  readonly fromNode: string
  readonly from: string
  readonly to: string
  readonly type?: MessageType
  readonly payload?: unknown
  readonly cap?: string
  readonly taskId?: string
  /** 直接给一条已经拼好的信封（重放场景要一字不改地再发一次）。 */
  readonly message?: QianmoMessage
  readonly settleMs?: number
  readonly timeoutMs?: number
}

export function buildMessage(options: SendOptions): QianmoMessage {
  if (options.message !== undefined) return options.message
  const draft = createMessage({
    from: options.from,
    to: options.to,
    type: options.type ?? MessageType.Wake,
    payload: options.payload ?? {
      trigger: 'manual',
      prompt: 'acceptance ping',
    },
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    ...(options.cap === undefined ? {} : { cap: options.cap }),
  })
  // hops[0] 必须是发起节点，否则审计链没有头、跳数少算一跳（protocol.md §6.3）。
  return withHop(draft, options.fromNode)
}

export async function sendEnvelope(options: SendOptions): Promise<SendResult> {
  const message = buildMessage(options)
  const auth: RawAuth = { kind: 'psk', psk: options.psk }
  const probe = await rawDial({
    url: options.url,
    node: options.fromNode,
    auth,
    sendAfterReady: [
      { t: FrameType.Envelope, v: FRAME_VERSION, envelope: message },
    ],
    settleMs: options.settleMs ?? 3_000,
    timeoutMs: options.timeoutMs ?? 15_000,
  })

  let receipt: string | undefined
  let receiptCode: string | undefined
  let receiptReason: string | undefined
  let errorCode: string | undefined
  let errorReason: string | undefined

  for (const raw of probe.frames) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const frame = parsed as Record<string, unknown>
    if (frame.t === FrameType.Receipt && frame.msgId === message.msgId) {
      receipt = typeof frame.status === 'string' ? frame.status : undefined
      receiptCode = typeof frame.code === 'string' ? frame.code : undefined
      receiptReason =
        typeof frame.reason === 'string' ? frame.reason : undefined
      continue
    }
    if (frame.t !== FrameType.Envelope) continue
    const envelope = frame.envelope as Record<string, unknown> | undefined
    if (envelope?.type !== MessageType.Error) continue
    if (envelope.taskId !== message.taskId) continue
    const payload = envelope.payload as Record<string, unknown> | undefined
    if (typeof payload?.code === 'string') errorCode = payload.code
    if (typeof payload?.reason === 'string') errorReason = payload.reason
  }

  return {
    receipt,
    receiptCode,
    receiptReason,
    errorCode,
    errorReason,
    frames: probe.frames,
    closeCode: probe.closeCode,
    dialError: probe.error,
    message,
  }
}

// ---------------------------------------------------------------------------
// 能力 token 工厂 —— 合法的与故意坏掉的
// ---------------------------------------------------------------------------

export interface Issuer {
  readonly node: string
  readonly keys: NodeKeyPair
}

export function newIssuer(node: string): Issuer {
  return { node, keys: generateNodeKeyPair() }
}

/** `--trust <node>=<publicKey>` 的那一行。 */
export function trustArg(issuer: Issuer): string {
  return `${issuer.node}=${issuer.keys.publicKey}`
}

export interface MintOptions {
  /** 授权的 handler，完整地址；缺省取 `aud` 节点的 `main`。 */
  readonly sub: string
  /** 验证方节点段。 */
  readonly aud: string
  readonly taskId: string
  readonly act?: CapabilityLevel
  readonly nbf?: number
  readonly exp?: number
  readonly nonce?: string
}

export function mint(issuer: Issuer, options: MintOptions): string {
  const now = Date.now()
  return issueCapability(issuer.node, issuer.keys, {
    sub: options.sub,
    aud: options.aud,
    act: options.act ?? CapabilityLevel.WriteLimited,
    taskId: options.taskId,
    nbf: options.nbf ?? now - 30_000,
    exp: options.exp ?? now + 60_000,
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
  })
}

/**
 * 把一个合法 token 的签名换成一串合法形状的垃圾。
 *
 * 用 86 个 `A` 而不是随便截断：`parseCapabilityToken` 先按
 * `/^[A-Za-z0-9_-]{86}$/` 判形状，形状不对会落到 `capability token is malformed`
 * 而不是 `capability signature does not verify` —— 两条断言测的是两件事。
 */
export function withBrokenSignature(token: string): string {
  const dot = token.lastIndexOf('.')
  return `${token.slice(0, dot)}.${'A'.repeat(86)}`
}

export { CapabilityLevel, MessageType }
