// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  assertAddress,
  createMessage,
  isControlOp,
  isHubCallPayload,
  isHubCallResultPayload,
  isNodeControlResultPayload,
  isValidSegment,
  MessageType,
  newId,
  type ControlOutcome,
  type QianmoMessage,
} from '@qianmo/protocol'
import type { TransportChannel } from '@qianmo/transport'
import type { NodeRouter } from '@qianmo/router'

export type { ControlOutcome } from '@qianmo/protocol'

export interface ControlContext {
  readonly peer: string
  readonly actor: string
  readonly taskId: string
  readonly agent?: string
}

export type ControlHandler = (
  op: string,
  args: Record<string, unknown>,
  ctx: ControlContext,
) => Promise<ControlOutcome>

export function assertControlPrefix(prefix: string): void {
  if (!/^[a-z][a-z0-9]*$/.test(prefix) || !isControlOp(`${prefix}.x`))
    throw new Error('invalid control prefix')
}

export function controlTimeout(timeoutMs = 30_000): number {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  )
    throw new Error('control timeout must be a positive timer duration')
  return timeoutMs
}

/** Contain both thrown handlers and non-JSON results before putting them on wire. */
export async function runControlHandler(
  invoke: () => Promise<ControlOutcome>,
  onError?: (error: unknown) => void,
): Promise<ControlOutcome> {
  try {
    const result: unknown = JSON.parse(JSON.stringify(await invoke()))
    if (!isNodeControlResultPayload(result))
      throw new Error('invalid control outcome')
    return result
  } catch (error) {
    onError?.(error)
    return { ok: false, code: 'internal', message: '控制处理器执行失败' }
  }
}

/** Prefixes are owned by one feature module; accidental replacement is an error. */
export class ControlRegistry {
  readonly #handlers = new Map<string, ControlHandler>()
  readonly #onError: ((error: unknown) => void) | undefined

  constructor(options: { readonly onError?: (error: unknown) => void } = {}) {
    this.#onError = options.onError
  }

  register(prefix: string, handler: ControlHandler): void {
    assertControlPrefix(prefix)
    if (this.#handlers.has(prefix))
      throw new Error(`duplicate control prefix: ${prefix}`)
    this.#handlers.set(prefix, handler)
  }

  async handle(
    op: string,
    args: Record<string, unknown>,
    ctx: ControlContext,
  ): Promise<ControlOutcome> {
    if (!isControlOp(op))
      return { ok: false, code: 'invalid', message: '控制操作名无效' }
    const handler = this.#handlers.get(op.split('.')[0]!)
    if (!handler)
      return { ok: false, code: 'unsupported', message: '不支持此控制操作' }
    return runControlHandler(() => handler(op, args, ctx), this.#onError)
  }
}

interface HubSubscription {
  readonly peer: string
  readonly address: string
  readonly channel: TransportChannel
}

interface HubPending {
  readonly subscription: HubSubscription
  readonly request: QianmoMessage
  readonly resolve: (outcome: ControlOutcome) => void
  readonly timer: Timer
}

const unavailable: ControlOutcome = {
  ok: false,
  code: 'hub-unavailable',
  message: '中枢未连接',
}

interface HubCallOptions {
  readonly from: string
  readonly router: NodeRouter
  readonly onError?: (error: unknown) => void
}

/** Uses only reverse directions of subscribed inbound channels (H-2). */
export class HubCallClient {
  readonly #subscriptions = new Map<string, HubSubscription>()
  readonly #pending = new Map<string, HubPending>()
  readonly #options: HubCallOptions
  readonly #node: string
  #closed = false

  constructor(options: HubCallOptions) {
    this.#options = options
    this.#node = assertAddress(options.from).node
  }

  subscribe(peer: string, address: string, channel: TransportChannel): void {
    if (this.#closed) return
    const previous = this.#subscriptions.get(peer)
    if (previous && previous.channel !== channel) this.#drop(previous)
    // Map insertion order is subscription order, including repeat subscriptions.
    this.#subscriptions.delete(peer)
    this.#subscriptions.set(peer, { peer, address, channel })
  }

  #finish(callId: string, result: ControlOutcome): void {
    const pending = this.#pending.get(callId)
    if (!pending) return
    this.#pending.delete(callId)
    clearTimeout(pending.timer)
    pending.resolve(result)
  }

  #drop(subscription: HubSubscription): void {
    if (this.#subscriptions.get(subscription.peer) === subscription)
      this.#subscriptions.delete(subscription.peer)
    for (const [id, pending] of this.#pending)
      if (pending.subscription.channel === subscription.channel)
        this.#finish(id, unavailable)
  }

  /** Called by the listener's physical disconnect callback, even with other links alive. */
  disconnected(): void {
    for (const subscription of this.#subscriptions.values())
      if (!subscription.channel.isReady()) this.#drop(subscription)
  }

  receive(message: QianmoMessage, channel: TransportChannel): void {
    if (
      message.type !== MessageType.HubCallResult ||
      !isHubCallResultPayload(message.payload)
    )
      return
    const { callId, ...outcome } = message.payload
    const pending = this.#pending.get(callId)
    if (
      !pending ||
      pending.subscription.channel !== channel ||
      channel.authenticatedPeerNode !== pending.subscription.peer ||
      message.taskId !== pending.request.taskId ||
      message.from !== pending.request.to ||
      message.to !== pending.request.from
    )
      return
    this.#finish(callId, outcome)
  }

  async call(
    op: string,
    args: Record<string, unknown>,
    options: {
      readonly timeoutMs?: number
      readonly agent?: string
      readonly callId?: string
    } = {},
  ): Promise<ControlOutcome> {
    const timeoutMs = controlTimeout(options.timeoutMs)
    if (
      !isControlOp(op) ||
      (options.agent !== undefined && !isValidSegment(options.agent))
    )
      return { ok: false, code: 'invalid', message: '上行操作或智能体无效' }
    this.disconnected()
    const subscription = [...this.#subscriptions.values()].at(-1)
    if (!subscription || this.#closed) return unavailable
    if (
      !subscription.channel.supports(MessageType.HubCall) ||
      !subscription.channel.supports(MessageType.HubCallResult)
    )
      return { ok: false, code: 'unsupported', message: '中枢不支持上行调用' }
    const callId = options.callId ?? newId()
    if (!isHubCallPayload({ callId, op, args }))
      return { ok: false, code: 'invalid', message: '上行请求参数必须是对象' }
    const request = createMessage({
      from:
        options.agent === undefined
          ? this.#options.from
          : `qianmo://${this.#node}/${options.agent}`,
      to: subscription.address,
      type: MessageType.HubCall,
      taskId: callId,
      payload: { callId, op, args },
      deliverTtlMs: timeoutMs,
      taskTtlMs: timeoutMs,
    })
    const routed = this.#options.router.outbound(request)
    if (!routed.ok)
      return { ok: false, code: routed.code, message: routed.reason }
    const { promise, resolve } = Promise.withResolvers<ControlOutcome>()
    const timer = setTimeout(
      () =>
        this.#finish(callId, {
          ok: false,
          code: 'timeout',
          message: '中枢调用超时',
        }),
      timeoutMs,
    )
    this.#pending.set(callId, { subscription, request, resolve, timer })
    void subscription.channel
      .sendAndWait(routed.message, timeoutMs)
      .catch(error => {
        this.#options.onError?.(error)
        this.#finish(callId, unavailable)
      })
    return promise
  }

  close(): void {
    this.#closed = true
    this.#subscriptions.clear()
    for (const id of this.#pending.keys()) this.#finish(id, unavailable)
  }
}
