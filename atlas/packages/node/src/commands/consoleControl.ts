// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StaticPublicKeyDirectory, type NodeKeyPair } from '@qianmo/capability'
import {
  assertAddress,
  CONTROL_MESSAGE_TYPES,
  CONTROL_OPERATION_ID_CAPABILITY,
  LEGACY_MESSAGE_TYPES,
  LIMITS,
  messageBytes,
  createMessage,
  isHubCallPayload,
  isNodeControlPayload,
  isNodeControlResultPayload,
  MessageType,
  parseAddress,
  newId,
  isOperationId,
  type ControlOutcome,
  type QianmoMessage,
} from '@qianmo/protocol'
import { NodeRouter, RuntimeThrottle } from '@qianmo/router'
import {
  TransportClient,
  TransportEventType,
  type OnceDelivery,
  type InboundContext,
} from '@qianmo/transport'
import {
  assertControlPrefix,
  controlTimeout,
  runControlHandler,
  interruptedControl,
} from '../host/control.js'

export interface ControlEndpoint {
  readonly node: string
  readonly url: string
  readonly psk: string
  readonly publicKey: string
}

export type HubCallHandler = (
  op: string,
  args: Record<string, unknown>,
  ctx: {
    readonly node: string
    readonly agent?: string
    readonly callId: string
    readonly operationId?: string
  },
) => Promise<ControlOutcome>

export interface ControlLinkStatus {
  readonly node: string
  readonly connected: boolean
  readonly lastConnectedAt: number | null
  readonly lastError: string | null
}

interface LinkState {
  readonly target: ControlEndpoint
  link?: TransportClient
  connecting?: Promise<void>
  subscribed: boolean
  generation?: string
  lastConnectedAt: number | null
  lastError: string | null
}

interface ControlPending {
  readonly state: LinkState
  readonly request: QianmoMessage
  readonly link: TransportClient
  readonly generation: string
  readonly delivery: OnceDelivery
  readonly resolve: (result: ControlOutcome) => void
  readonly timer: Timer
}

interface ControlLinksOptions {
  readonly from: string
  readonly targets: readonly ControlEndpoint[]
  readonly commandKeys: NodeKeyPair
  readonly onError?: (error: unknown) => void
}

const unreachable: ControlOutcome = {
  ok: false,
  code: 'unreachable',
  message: '节点控制链路未连接',
}

/** Hub-owned dialers. Feature ports own authorization and action ledgers. */
/** Control requests one hub may send one node per minute. */
const CONTROL_RATE_PER_MINUTE = 300

export class ControlLinks {
  readonly #options: ControlLinksOptions
  readonly #node: string
  readonly #router: NodeRouter
  readonly #states = new Map<string, LinkState>()
  readonly #pending = new Map<string, ControlPending>()
  readonly #handlers = new Map<string, HubCallHandler>()
  #timer: Timer | undefined
  #closed = false

  constructor(options: ControlLinksOptions) {
    this.#options = options
    this.#node = assertAddress(options.from).node
    // The runtime throttle's 20 a minute (AC-3 ①) is for agents answering
    // each other. Control traffic is the console's own: page polls of memory,
    // files and desktop status would trip it with two tabs open. Half the
    // node's inbound budget (LIMITS.ratePerMinute) leaves room for the chat
    // and approval links that share the hub's identity.
    this.#router = new NodeRouter({
      node: this.#node,
      throttle: new RuntimeThrottle({ capacity: CONTROL_RATE_PER_MINUTE }),
    })
    for (const target of options.targets) {
      assertAddress(`qianmo://${target.node}/console`)
      const url = new URL(target.url)
      if (
        !['ws:', 'wss:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error(
          'control endpoint requires ws(s) without URL credentials',
        )
      if (this.#states.has(target.node))
        throw new Error('duplicate control node')
      this.#states.set(target.node, {
        target,
        subscribed: false,
        lastConnectedAt: null,
        lastError: null,
      })
    }
  }

  onHubCall(prefix: string, handler: HubCallHandler): void {
    assertControlPrefix(prefix)
    if (this.#handlers.has(prefix))
      throw new Error(`duplicate hub call prefix: ${prefix}`)
    this.#handlers.set(prefix, handler)
  }

  #finish(taskId: string, result: ControlOutcome): void {
    const pending = this.#pending.get(taskId)
    if (!pending) return
    this.#pending.delete(taskId)
    clearTimeout(pending.timer)
    pending.delivery.cancel()
    pending.resolve(result)
  }

  #lost(state: LinkState): void {
    state.subscribed = false
    state.generation = undefined
    state.lastError = '控制链路已断开'
    for (const [taskId, pending] of this.#pending)
      if (pending.state === state)
        this.#finish(taskId, interruptedControl(pending.delivery))
  }

  #log(error: unknown): void {
    this.#options.onError?.(error)
  }

  async #subscribe(state: LinkState, link: TransportClient): Promise<void> {
    if (this.#closed || state.link !== link || !link.isReady()) return
    const generation = link.connectionGeneration
    if (!generation) return
    if (state.generation !== generation) this.#lost(state)
    if (
      link.authenticatedPeerNode !== state.target.node ||
      !CONTROL_MESSAGE_TYPES.every(type => link.supports(type))
    )
      throw new Error('peer identity or control capabilities unavailable')
    const request = this.#router.outbound(
      createMessage({
        from: this.#options.from,
        to: `qianmo://${state.target.node}/console`,
        type: MessageType.HubSubscribe,
        payload: { subscribe: true },
      }),
    )
    if (!request.ok) throw new Error('control subscription refused by router')
    await link.sendOnce(request.message, 5_000).receipt
    if (
      this.#closed ||
      state.link !== link ||
      !link.isReady() ||
      link.connectionGeneration !== generation
    )
      return
    state.subscribed = true
    state.generation = generation
    state.lastConnectedAt = Date.now()
    state.lastError = null
  }

  async #connect(state: LinkState): Promise<void> {
    if (
      this.#closed ||
      state.connecting ||
      (state.link?.isReady() &&
        state.subscribed &&
        state.generation === state.link.connectionGeneration)
    )
      return state.connecting
    state.connecting = (async () => {
      try {
        if (!state.link || state.link.isClosed()) {
          const link = new TransportClient({
            endpoint: { url: state.target.url },
            node: this.#node,
            peerNode: state.target.node,
            psk: state.target.psk,
            supportedTypes: [
              ...LEGACY_MESSAGE_TYPES,
              ...CONTROL_MESSAGE_TYPES,
              CONTROL_OPERATION_ID_CAPABILITY,
            ],
            signing: {
              keys: this.#options.commandKeys,
              directory: new StaticPublicKeyDirectory([
                [state.target.node, state.target.publicKey],
              ]),
              required: true,
            },
            onMessage: (message, context) =>
              this.#receive(state, message, context),
            onReady: () => {
              this.#lost(state)
              if (!state.connecting) void this.#connect(state)
            },
            events: event => {
              if (
                event.type === TransportEventType.ConnectionClosed ||
                event.type === TransportEventType.AuthRejected ||
                event.type === TransportEventType.ReconnectGaveUp
              )
                this.#lost(state)
            },
          })
          state.link = link
        }
        await state.link.connect(5_000)
        await this.#subscribe(state, state.link)
      } catch (error) {
        state.lastError = '控制链路连接失败'
        this.#log(error)
      } finally {
        state.connecting = undefined
      }
    })()
    return state.connecting
  }

  start(): void {
    if (this.#timer || this.#closed) return
    const check = (): void => {
      for (const state of this.#states.values()) void this.#connect(state)
    }
    check()
    this.#timer = setInterval(check, 10_000)
    this.#timer.unref?.()
  }

  async request(
    node: string,
    op: string,
    args: Record<string, unknown>,
    actor: string,
    options: {
      readonly timeoutMs?: number
      readonly operationId?: string
    } = {},
  ): Promise<ControlOutcome> {
    const timeoutMs = controlTimeout(options.timeoutMs)
    const state = this.#states.get(node),
      link = state?.link
    if (state && state.generation !== link?.connectionGeneration)
      this.#lost(state)
    if (
      !state ||
      !state.subscribed ||
      !link?.isReady() ||
      !state.generation ||
      this.#closed
    )
      return unreachable
    if (
      options.operationId !== undefined &&
      !isOperationId(options.operationId)
    )
      return { ok: false, code: 'invalid', message: 'operationId 必须为 UUID' }
    const operationId = options.operationId ?? newId()
    const payload = {
      op,
      args,
      actor,
      ...(link.peerSupportedTypes?.includes(CONTROL_OPERATION_ID_CAPABILITY)
        ? { operationId }
        : {}),
    }
    if (!isNodeControlPayload(payload))
      return { ok: false, code: 'invalid', message: '控制请求无效' }
    if (
      !link.supports(MessageType.NodeControl) ||
      !link.supports(MessageType.NodeControlResult)
    )
      return { ok: false, code: 'unsupported', message: '节点不支持控制调用' }
    const request = createMessage({
      from: this.#options.from,
      to: `qianmo://${node}/console`,
      type: MessageType.NodeControl,
      payload,
      deliverTtlMs: timeoutMs,
      taskTtlMs: timeoutMs,
    })
    const routed = this.#router.outbound(request)
    if (!routed.ok)
      return { ok: false, code: routed.code, message: routed.reason }
    if (messageBytes(routed.message) > LIMITS.maxMessageBytes)
      return {
        ok: false,
        code: 'invalid',
        message: '控制信封超过 UTF-8 字节上限',
      }
    const { promise, resolve } = Promise.withResolvers<ControlOutcome>()
    const delivery = link.sendOnce(routed.message, timeoutMs)
    const timer = setTimeout(
      () => this.#finish(request.taskId, interruptedControl(delivery)),
      timeoutMs,
    )
    this.#pending.set(request.taskId, {
      state,
      link,
      generation: state.generation,
      request,
      delivery,
      resolve,
      timer,
    })
    void delivery.receipt.catch(() => {
      if (!this.#pending.has(request.taskId)) return
      // A transport rejection can follow a handler's side effect. Only a
      // correlated business response can declare the operation's outcome.
      this.#finish(request.taskId, interruptedControl(delivery))
    })
    return promise
  }

  async #receive(
    state: LinkState,
    message: QianmoMessage,
    context: InboundContext,
  ): Promise<void> {
    const node = context.channel.authenticatedPeerNode
    const generation =
      context.connectionGeneration ?? context.channel.connectionGeneration
    if (
      this.#closed ||
      state.link !== context.channel ||
      node !== state.target.node ||
      parseAddress(message.from)?.node !== node ||
      message.to !== this.#options.from
    )
      throw new Error('control message identity mismatch')
    if (!generation || generation !== context.channel.connectionGeneration)
      return
    const routed = this.#router.inbound(message)
    if (!routed.ok) throw new Error('control message refused by router')
    if (
      message.type === MessageType.NodeControlResult ||
      message.type === MessageType.Error
    ) {
      const pending = this.#pending.get(message.taskId)
      if (
        !pending ||
        pending.state !== state ||
        pending.link !== context.channel ||
        pending.generation !== generation ||
        message.from !== pending.request.to
      )
        return
      if (
        message.type === MessageType.NodeControlResult &&
        isNodeControlResultPayload(message.payload)
      )
        this.#finish(message.taskId, message.payload)
      else if (
        message.type === MessageType.Error &&
        message.payload &&
        typeof message.payload === 'object' &&
        'code' in message.payload &&
        typeof message.payload.code === 'string'
      )
        this.#finish(message.taskId, {
          ok: false,
          code: message.payload.code,
          message: '节点拒绝控制请求',
        })
      return
    }
    if (
      message.type !== MessageType.HubCall ||
      !isHubCallPayload(message.payload)
    )
      throw new Error('unsupported control message')
    const handler = this.#handlers.get(message.payload.op.split('.')[0]!)
    const payload = message.payload
    const agent = parseAddress(message.from)?.agent
    const outcome = handler
      ? await runControlHandler(
          () =>
            handler(payload.op, payload.args, {
              node,
              callId: payload.callId,
              ...(agent === 'console' ? {} : { agent }),
              ...(payload.operationId === undefined
                ? {}
                : { operationId: payload.operationId }),
            }),
          error => this.#log(error),
        )
      : { ok: false as const, code: 'unsupported', message: '不支持此中枢操作' }
    if (
      this.#closed ||
      !context.channel.isReady() ||
      context.channel.connectionGeneration !== generation ||
      !context.channel.supports(MessageType.HubCallResult)
    )
      return
    const reply = this.#router.outbound(
      createMessage({
        from: message.to,
        to: message.from,
        type: MessageType.HubCallResult,
        payload: { callId: payload.callId, ...outcome },
        taskId: message.taskId,
        traceId: message.traceId,
      }),
    )
    if (reply.ok)
      void context.channel
        .sendOnce?.(reply.message)
        .receipt.catch(error => this.#log(error))
  }

  status(): ControlLinkStatus[] {
    return [...this.#states.values()].map(state => ({
      node: state.target.node,
      connected:
        !this.#closed &&
        state.subscribed &&
        state.link?.isReady() === true &&
        state.generation === state.link.connectionGeneration,
      lastConnectedAt: state.lastConnectedAt,
      lastError: state.lastError,
    }))
  }

  async close(): Promise<void> {
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    for (const state of this.#states.values()) this.#lost(state)
    await Promise.all(
      [...this.#states.values()].map(state => state.link?.close()),
    )
  }
}
