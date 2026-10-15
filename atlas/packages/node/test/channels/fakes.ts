// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Hand-written fakes for the chat channels (P28): an adapter that records
 * what it sent, turns that answer on cue, and a scripted HTTP/WebSocket
 * world for the platform adapters. No module mocking.
 */

import type {
  ChannelConversation,
  ChannelTurnResult,
  ChannelTurns,
} from '../../src/channels/gateway.js'
import type {
  ChannelAdapter,
  ChannelChat,
  ChannelHealth,
  ChannelInbound,
  ChannelIo,
  ChannelSendOptions,
  ChannelSendResult,
  WebSocketFactory,
} from '../../src/channels/types.js'

export async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('fixture timeout')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

export class FakeAdapter implements ChannelAdapter {
  readonly sent: { chat: ChannelChat; text: string; replyTo?: string }[] = []
  readonly typed: string[] = []
  sink: ((message: ChannelInbound) => void) | null = null
  failSend = false

  constructor(
    readonly platform: ChannelAdapter['platform'] = 'telegram',
    readonly chunkLimit = 4_000,
  ) {}

  async start(sink: (message: ChannelInbound) => void): Promise<void> {
    this.sink = sink
  }

  async stop(): Promise<void> {
    this.sink = null
  }

  async send(
    chat: ChannelChat,
    markdown: string,
    options?: ChannelSendOptions,
  ): Promise<ChannelSendResult> {
    if (this.failSend) return { ok: false, error: 'down' }
    this.sent.push({
      chat,
      text: markdown,
      ...(options?.replyTo === undefined ? {} : { replyTo: options.replyTo }),
    })
    return { ok: true }
  }

  async typing(chat: ChannelChat): Promise<void> {
    this.typed.push(`on ${chat.id}`)
  }

  async stopTyping(chat: ChannelChat): Promise<void> {
    this.typed.push(`off ${chat.id}`)
  }

  health(): ChannelHealth {
    return { state: 'connected', since: 0 }
  }

  texts(): string[] {
    return this.sent.map(one => one.text)
  }
}

interface Call {
  readonly conversation: ChannelConversation
  readonly text: string
  readonly notice: (text: string) => void
  readonly settle: (result: ChannelTurnResult) => void
}

/** Turns that wait until the test answers them, one session per conversation. */
export class FakeTurns implements ChannelTurns {
  readonly calls: Call[] = []
  readonly log: string[] = []
  readonly sessions = new Map<string, string>()
  #seq = 0

  run(
    conversation: ChannelConversation,
    text: string,
    hooks: { onNotice: (text: string) => void },
  ) {
    const { promise, resolve } = Promise.withResolvers<ChannelTurnResult>()
    this.calls.push({
      conversation,
      text,
      notice: hooks.onNotice,
      settle: resolve,
    })
    return promise.then(result => {
      if (result.ok && !this.sessions.has(conversation.key))
        this.sessions.set(conversation.key, `s-${++this.#seq}`)
      return result
    })
  }

  /** Answers the oldest unanswered call. */
  answer(index: number, result: ChannelTurnResult | string): void {
    const call = this.calls[index]
    if (call === undefined) throw new Error(`no call ${index}`)
    call.settle(
      typeof result === 'string' ? { ok: true, text: result } : result,
    )
  }

  sessionOf(conversation: ChannelConversation): string | undefined {
    return this.sessions.get(conversation.key)
  }

  async reset(conversation: ChannelConversation): Promise<void> {
    this.log.push(`reset ${conversation.key}`)
    this.sessions.delete(conversation.key)
  }

  async stop(conversation: ChannelConversation): Promise<boolean> {
    this.log.push(`stop ${conversation.key}`)
    return false
  }

  async compact(conversation: ChannelConversation): Promise<string> {
    this.log.push(`compact ${conversation.key}`)
    return '已压缩上下文。'
  }

  async status(): Promise<readonly string[]> {
    return ['会话：s-1']
  }

  async direction(
    conversation: ChannelConversation,
    value: string | null | undefined,
  ): Promise<string> {
    this.log.push(`direction ${String(value)}`)
    return value === undefined
      ? '当前方向：默认'
      : value === null
        ? '已恢复默认'
        : `已切换到 ${value}`
  }
}

export function inbound(
  overrides: Partial<ChannelInbound> & { id?: string } = {},
): ChannelInbound {
  const { id, ...rest } = overrides
  return {
    chat: { type: 'dm', id: 'owner' },
    messageId: id ?? `m-${Math.random().toString(36).slice(2)}`,
    userId: 'owner',
    userName: '主人',
    text: '你好',
    addressed: true,
    ...rest,
  }
}

// ---------------------------------------------------------------------------
// The network: scripted fetch and WebSocket
// ---------------------------------------------------------------------------

export interface Exchange {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

interface Answer {
  readonly status?: number
  readonly body?: unknown
}

/** A function reply may return undefined: that call hangs until aborted, like a long poll. */
type Reply =
  | Answer
  | ((exchange: Exchange) => Answer | undefined | Promise<Answer | undefined>)

export class FakeNet {
  readonly exchanges: Exchange[] = []
  readonly sockets: FakeSocket[] = []
  readonly errors: string[] = []
  readonly sleeps: number[] = []
  readonly #routes: { match: (exchange: Exchange) => boolean; reply: Reply }[] =
    []
  /** Calls with no route wait here until the request is aborted. */
  readonly hanging: Exchange[] = []

  on(match: string | ((exchange: Exchange) => boolean), reply: Reply): this {
    this.#routes.push({
      match:
        typeof match === 'string'
          ? exchange => exchange.url.includes(match)
          : match,
      reply,
    })
    return this
  }

  /** Exchanges whose URL contains `part`. */
  to(part: string): Exchange[] {
    return this.exchanges.filter(one => one.url.includes(part))
  }

  io(): ChannelIo {
    const net = this
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input)
      const headers: Record<string, string> = {}
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value
      })
      let body: unknown = init?.body
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body)
        } catch {
          // form or plain text stays a string
        }
      }
      const exchange = { method: init?.method ?? 'GET', url, headers, body }
      net.exchanges.push(exchange)
      const route = net.#routes.find(one => one.match(exchange))
      const reply =
        route === undefined
          ? undefined
          : typeof route.reply === 'function'
            ? await route.reply(exchange)
            : route.reply
      if (reply === undefined) {
        net.hanging.push(exchange)
        const signal = init?.signal
        return await new Promise<Response>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason)
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          })
        })
      }
      return new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    class Socket extends FakeSocket {
      constructor(url: string) {
        super(url)
        net.sockets.push(this)
      }
    }
    return {
      fetch: fetchImpl as typeof fetch,
      WebSocket: Socket as unknown as WebSocketFactory,
      now: Date.now,
      // Backoff waits are real but short, so a reconnect loop cannot spin.
      sleep: (ms, signal) =>
        new Promise<void>(resolve => {
          net.sleeps.push(ms)
          if (signal?.aborted) return resolve()
          const timer = setTimeout(resolve, Math.min(ms, 10))
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              resolve()
            },
            { once: true },
          )
        }),
      onError: message => net.errors.push(message),
    }
  }
}

export class FakeSocket {
  readonly sent: unknown[] = []
  readyState = 0
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readonly #listeners = new Map<string, ((event: never) => void)[]>()

  constructor(readonly url: string) {
    queueMicrotask(() => {
      this.readyState = 1
      this.#emit('open', {})
    })
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.#listeners.get(type) ?? []
    list.push(listener)
    this.#listeners.set(type, list)
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    this.#listeners.set(
      type,
      (this.#listeners.get(type) ?? []).filter(one => one !== listener),
    )
  }

  #emit(type: string, event: unknown): void {
    const handler = (
      this as unknown as Record<string, ((event: unknown) => void) | null>
    )[`on${type}`]
    handler?.(event)
    for (const listener of this.#listeners.get(type) ?? [])
      (listener as (event: unknown) => void)(event)
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  /** What the server pushes. */
  push(frame: unknown): void {
    this.#emit('message', { data: JSON.stringify(frame) })
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.#emit('close', { code, reason })
  }

  /** Frames the client sent with this op (Discord/QQ) or type (Slack ack). */
  ops(op: number): Record<string, unknown>[] {
    return this.sent.filter(
      one => (one as { op?: number }).op === op,
    ) as Record<string, unknown>[]
  }
}
