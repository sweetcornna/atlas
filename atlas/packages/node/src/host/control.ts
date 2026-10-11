// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  assertAddress,
  CONTROL_OPERATION_ID_CAPABILITY,
  createMessage,
  isControlOp,
  isHubCallPayload,
  isHubCallResultPayload,
  isNodeControlResultPayload,
  isValidSegment,
  isOperationId,
  MessageType,
  ProtocolErrorCode,
  newId,
  type ControlOutcome,
  type QianmoMessage,
} from '@qianmo/protocol'
import type { OnceDelivery, TransportChannel } from '@qianmo/transport'
import type { NodeRouter } from '@qianmo/router'
import { qianmoConfigPath } from '@qianmo/paths'
import { ControlLedger, type ControlOperationContext } from './controlLedger.js'

export type { ControlOutcome } from '@qianmo/protocol'

export interface ControlContext extends ControlOperationContext {
  /** Exact final UTF-8 response envelope byte check, supplied by the host. */
  readonly resultFits?: (outcome: ControlOutcome) => boolean
  readonly taskId: string
}

export type ControlHandler = (
  op: string,
  args: Record<string, unknown>,
  ctx: ControlContext,
) => Promise<ControlOutcome>

export interface ControlRegistrationOptions {
  readonly estopAllowed?: readonly string[]
  readonly sideEffects?: (op: string) => boolean
}

export function interruptedControl(delivery: OnceDelivery): ControlOutcome {
  return delivery.cancel() === 'unknown'
    ? {
        ok: false,
        code: 'unknown',
        message: '请求已写入连接，执行结果未知；请使用原 operationId 核对',
      }
    : { ok: false, code: 'not-sent', message: '请求未发送，已从发送队列撤下' }
}

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
  failure: ControlOutcome = {
    ok: false,
    code: 'internal',
    message: '控制处理器执行失败',
  },
): Promise<ControlOutcome> {
  try {
    const result: unknown = JSON.parse(JSON.stringify(await invoke()))
    if (!isNodeControlResultPayload(result))
      throw new Error('invalid control outcome')
    return result
  } catch (error) {
    onError?.(error)
    return failure
  }
}

/** Prefixes are owned by one feature module; accidental replacement is an error. */
export class ControlRegistry {
  readonly #handlers = new Map<
    string,
    { handler: ControlHandler; options: ControlRegistrationOptions }
  >()
  readonly #onError: ((error: unknown) => void) | undefined
  readonly #estopEngaged: () => boolean
  readonly #ledger: ControlLedger

  constructor(
    options: {
      readonly onError?: (error: unknown) => void
      readonly estopEngaged?: () => boolean
      readonly ledgerPath?: string
    } = {},
  ) {
    this.#onError = options.onError
    this.#estopEngaged = options.estopEngaged ?? (() => false)
    this.#ledger = new ControlLedger({
      file:
        options.ledgerPath ??
        qianmoConfigPath('resident', 'control-operations.sqlite'),
      onError: options.onError,
    })
  }

  register(
    prefix: string,
    handler: ControlHandler,
    options: ControlRegistrationOptions = {},
  ): void {
    assertControlPrefix(prefix)
    if (this.#handlers.has(prefix))
      throw new Error(`duplicate control prefix: ${prefix}`)
    if (
      options.estopAllowed?.some(
        op => !isControlOp(op) || op.split('.')[0] !== prefix,
      )
    )
      throw new Error(
        'ESTOP allowlist must contain full operations owned by the prefix',
      )
    this.#handlers.set(prefix, {
      handler,
      options: { ...options, estopAllowed: [...(options.estopAllowed ?? [])] },
    })
  }

  async handle(
    op: string,
    args: Record<string, unknown>,
    ctx: ControlContext,
  ): Promise<ControlOutcome> {
    if (!isControlOp(op))
      return { ok: false, code: 'invalid', message: '控制操作名无效' }
    const registration = this.#handlers.get(op.split('.')[0]!)
    if (
      this.#estopEngaged() &&
      !registration?.options.estopAllowed?.includes(op)
    )
      return {
        ok: false,
        code: ProtocolErrorCode.E_BUSY,
        message: 'resident is halted by its ESTOP sentinel',
      }
    if (!registration)
      return { ok: false, code: 'unsupported', message: '不支持此控制操作' }
    if (!registration.options.sideEffects?.(op))
      return runControlHandler(
        () => registration.handler(op, args, ctx),
        this.#onError,
      )
    try {
      return await this.#ledger.execute(op, args, ctx, () =>
        runControlHandler(
          () => registration.handler(op, args, ctx),
          this.#onError,
          {
            ok: false,
            code: 'unknown',
            message: '控制处理器异常，操作结果未知；请使用原 operationId 核对',
          },
        ),
      )
    } catch (error) {
      this.#onError?.(error)
      return {
        ok: false,
        code: 'internal',
        message: '控制幂等账本不可用，操作未执行',
      }
    }
  }

  close(): Promise<void> {
    return this.#ledger.close()
  }
}

interface HubSubscription {
  readonly peer: string
  readonly address: string
  readonly channel: TransportChannel
  readonly generation: string
}

interface HubPending {
  readonly subscription: HubSubscription
  readonly request: QianmoMessage
  readonly delivery: OnceDelivery
  readonly generation: string
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

  subscribe(
    peer: string,
    address: string,
    channel: TransportChannel,
    generation = channel.connectionGeneration,
  ): void {
    if (this.#closed) return
    if (
      !generation ||
      generation !== channel.connectionGeneration ||
      !channel.sendOnce
    )
      return
    const previous = this.#subscriptions.get(peer)
    if (
      previous &&
      (previous.channel !== channel ||
        previous.generation !== generation ||
        previous.address !== address)
    )
      this.#drop(previous)
    if (
      previous &&
      previous.channel === channel &&
      previous.generation === generation &&
      previous.address === address
    ) {
      this.#subscriptions.delete(peer)
      this.#subscriptions.set(peer, previous)
      return
    }
    // Map insertion order is subscription order, including repeat subscriptions.
    this.#subscriptions.delete(peer)
    this.#subscriptions.set(peer, { peer, address, channel, generation })
  }

  #finish(callId: string, result: ControlOutcome): void {
    const pending = this.#pending.get(callId)
    if (!pending) return
    this.#pending.delete(callId)
    clearTimeout(pending.timer)
    pending.delivery.cancel()
    pending.resolve(result)
  }

  #drop(subscription: HubSubscription): void {
    if (this.#subscriptions.get(subscription.peer) === subscription)
      this.#subscriptions.delete(subscription.peer)
    for (const [id, pending] of this.#pending)
      if (pending.subscription === subscription)
        this.#finish(id, interruptedControl(pending.delivery))
  }

  /** Called by the listener's physical disconnect callback, even with other links alive. */
  disconnected(): void {
    for (const subscription of this.#subscriptions.values())
      if (
        !subscription.channel.isReady() ||
        subscription.generation !== subscription.channel.connectionGeneration
      )
        this.#drop(subscription)
  }

  receive(
    message: QianmoMessage,
    channel: TransportChannel,
    generation = channel.connectionGeneration,
  ): void {
    this.disconnected()
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
      pending.generation !== generation ||
      generation !== channel.connectionGeneration ||
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
      readonly peer?: string
      readonly operationId?: string
      /** Caller-chosen call id, so a retried hub call keeps its identity. */
      readonly callId?: string
    } = {},
  ): Promise<ControlOutcome> {
    const timeoutMs = controlTimeout(options.timeoutMs)
    if (
      !isControlOp(op) ||
      (options.agent !== undefined && !isValidSegment(options.agent)) ||
      (options.peer !== undefined && !isValidSegment(options.peer)) ||
      (options.operationId !== undefined && !isOperationId(options.operationId))
    )
      return { ok: false, code: 'invalid', message: '上行操作或智能体无效' }
    this.disconnected()
    // Grant checks must return to the controller that issued this control call.
    const subscription =
      options.peer === undefined
        ? [...this.#subscriptions.values()].at(-1)
        : this.#subscriptions.get(options.peer)
    if (!subscription || this.#closed) return unavailable
    if (
      !subscription.channel.supports(MessageType.HubCall) ||
      !subscription.channel.supports(MessageType.HubCallResult)
    )
      return { ok: false, code: 'unsupported', message: '中枢不支持上行调用' }
    const callId = options.callId ?? newId()
    const operationId = options.operationId ?? newId()
    const payload = {
      callId,
      op,
      args,
      ...(subscription.channel.peerSupportedTypes?.includes(
        CONTROL_OPERATION_ID_CAPABILITY,
      )
        ? { operationId }
        : {}),
    }
    if (!isHubCallPayload(payload))
      return { ok: false, code: 'invalid', message: '上行请求参数必须是对象' }
    const request = createMessage({
      from:
        options.agent === undefined
          ? this.#options.from
          : `qianmo://${this.#node}/${options.agent}`,
      to: subscription.address,
      type: MessageType.HubCall,
      taskId: callId,
      payload,
      deliverTtlMs: timeoutMs,
      taskTtlMs: timeoutMs,
    })
    const routed = this.#options.router.outbound(request)
    if (!routed.ok)
      return { ok: false, code: routed.code, message: routed.reason }
    const { promise, resolve } = Promise.withResolvers<ControlOutcome>()
    const delivery = subscription.channel.sendOnce!(routed.message, timeoutMs)
    const timer = setTimeout(
      () => this.#finish(callId, interruptedControl(delivery)),
      timeoutMs,
    )
    this.#pending.set(callId, {
      subscription,
      generation: subscription.generation,
      request,
      delivery,
      resolve,
      timer,
    })
    void delivery.receipt.catch(() => {
      if (!this.#pending.has(callId)) return
      this.#finish(callId, interruptedControl(delivery))
    })
    return promise
  }

  close(): void {
    this.#closed = true
    this.#subscriptions.clear()
    for (const [id, pending] of this.#pending)
      this.#finish(id, interruptedControl(pending.delivery))
  }
}
