// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChannelHealth, ChannelIo, ChannelState } from './types.js'

/** An error the platform will keep returning (bad credentials, revoked bot). */
export class ChannelFatalError extends Error {}

/**
 * The request never reached the platform (refused, reset, DNS): sending it
 * again cannot deliver twice. A timeout is not this: the platform may have
 * taken it (hermes retries connection errors only, never read timeouts).
 */
export class ChannelUnreachable extends Error {}

/** The platform asked us to wait before retrying. */
export class ChannelRateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super('rate limited')
  }
}

export interface JsonReply {
  readonly status: number
  readonly body: Record<string, unknown>
  /** A `Retry-After` header in seconds, as milliseconds. */
  readonly retryAfterMs?: number
}

/** One JSON request with a deadline. Never echoes credentials into errors. */
export async function requestJson(
  io: ChannelIo,
  url: string,
  init: {
    readonly method?: string
    readonly headers?: Record<string, string>
    readonly body?: unknown
    readonly timeoutMs?: number
    readonly signal?: AbortSignal
  } = {},
): Promise<JsonReply> {
  const timeout = AbortSignal.timeout(init.timeoutMs ?? 30_000)
  const signal =
    init.signal === undefined
      ? timeout
      : AbortSignal.any([timeout, init.signal])
  let response: Response
  try {
    response = await io.fetch(url, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal,
    })
  } catch (error) {
    if (init.signal?.aborted) throw error
    if (timeout.aborted) throw new Error(`${new URL(url).host} 请求超时`)
    throw new ChannelUnreachable(`${new URL(url).host} 不可达`)
  }
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    const parsed: unknown = text === '' ? {} : JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      body = parsed as Record<string, unknown>
  } catch {
    body = {}
  }
  const header = response.headers.get('retry-after')
  const after = header === null || header.trim() === '' ? NaN : Number(header)
  return {
    status: response.status,
    body,
    ...(Number.isFinite(after) && after >= 0
      ? { retryAfterMs: after * 1_000 }
      : {}),
  }
}

/**
 * A send that threw, as a result: unreachable is worth another attempt,
 * anything else (a timeout above all) is reported as it is.
 */
export function sendFailure(error: unknown, fallback: string) {
  return {
    ok: false as const,
    error: error instanceof Error ? error.message : fallback,
    ...(error instanceof ChannelUnreachable ? { retryable: true } : {}),
    ...(error instanceof ChannelRateLimited
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  }
}

/**
 * A gateway address the platform handed back must be on the platform's own
 * domain: a bot token is about to be sent to it.
 */
export function officialUrl(
  raw: unknown,
  protocols: readonly string[],
  suffixes: readonly string[],
): URL {
  if (typeof raw !== 'string') throw new Error('平台没有返回连接地址')
  const url = new URL(raw)
  if (
    !protocols.includes(url.protocol) ||
    !suffixes.some(
      suffix => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
    )
  )
    throw new ChannelFatalError('平台返回的连接地址不在官方域名下')
  return url
}

export function text(value: unknown): string {
  return typeof value === 'string'
    ? value
    : typeof value === 'number'
      ? String(value)
      : ''
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

const BACKOFF_MS = [2_000, 5_000, 10_000, 30_000, 60_000]

/**
 * Keeps one connection alive: runs `connect` until it returns or throws,
 * then retries with backoff. A {@link ChannelFatalError} stops the loop and
 * leaves the channel `failed` with its message.
 */
export class ChannelLoop {
  readonly #io: ChannelIo
  readonly #controller = new AbortController()
  #health: ChannelHealth
  #task: Promise<void> | undefined

  constructor(io: ChannelIo) {
    this.#io = io
    this.#health = { state: 'stopped', since: io.now() }
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  get stopped(): boolean {
    return this.#controller.signal.aborted
  }

  health(): ChannelHealth {
    return this.#health
  }

  mark(state: ChannelState, detail?: string): void {
    if (this.#health.state === state && this.#health.detail === detail) return
    this.#health = {
      state,
      since: this.#io.now(),
      ...(detail === undefined ? {} : { detail }),
    }
  }

  start(connect: (signal: AbortSignal) => Promise<void>): void {
    if (this.#task !== undefined) return
    this.mark('starting')
    this.#task = (async () => {
      let attempt = 0
      while (!this.stopped) {
        const started = this.#io.now()
        try {
          await connect(this.signal)
          if (this.stopped) break
          this.mark('retrying', '连接已断开，正在重连')
        } catch (error) {
          if (this.stopped) break
          if (error instanceof ChannelFatalError) {
            this.mark('failed', error.message)
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          this.mark('retrying', message)
          this.#io.onError?.(message)
          if (error instanceof ChannelRateLimited) {
            await this.#io.sleep(error.retryAfterMs, this.signal)
            continue
          }
        }
        // A connection that held for a while starts the backoff over.
        if (this.#io.now() - started > 60_000) attempt = 0
        await this.#io.sleep(
          BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!,
          this.signal,
        )
        attempt++
      }
      this.mark('stopped')
    })()
  }

  async stop(): Promise<void> {
    this.#controller.abort()
    await this.#task?.catch(() => {})
    this.mark('stopped')
  }
}

/**
 * A WebSocket as an async message stream. Resolves when the socket closes;
 * `onMessage` gets each parsed JSON frame.
 */
export function runSocket(
  io: ChannelIo,
  url: string,
  signal: AbortSignal,
  handlers: {
    /** Handshake headers (Bun's WebSocket takes them; OneBot's Bearer token). */
    readonly headers?: Record<string, string>
    readonly onOpen?: (socket: WebSocket) => void
    readonly onMessage: (
      frame: Record<string, unknown>,
      socket: WebSocket,
    ) => void
  },
): Promise<{ code: number; reason: string; opened: boolean }> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket
    let opened = false
    try {
      socket =
        handlers.headers === undefined
          ? new io.WebSocket(url)
          : new io.WebSocket(url, { headers: handlers.headers })
    } catch (error) {
      reject(error)
      return
    }
    const abort = () => socket.close(1000, 'stopping')
    signal.addEventListener('abort', abort, { once: true })
    socket.addEventListener('open', () => {
      opened = true
      handlers.onOpen?.(socket)
    })
    socket.addEventListener('message', event => {
      let frame: unknown
      try {
        frame = JSON.parse(String((event as MessageEvent).data))
      } catch {
        return
      }
      if (frame && typeof frame === 'object' && !Array.isArray(frame))
        handlers.onMessage(frame as Record<string, unknown>, socket)
    })
    socket.addEventListener('error', () => {})
    socket.addEventListener('close', event => {
      signal.removeEventListener('abort', abort)
      const closed = event as CloseEvent
      resolve({ code: closed.code, reason: closed.reason, opened })
    })
  })
}

/** Sends a JSON frame if the socket is still open. */
export function sendFrame(socket: WebSocket, frame: unknown): void {
  if (socket.readyState === 1) socket.send(JSON.stringify(frame))
}

/** Calls `run` at most once per `intervalMs` per key. */
export class Debounce {
  readonly #last = new Map<string, number>()
  constructor(
    readonly intervalMs: number,
    readonly now: () => number,
  ) {}
  due(key: string): boolean {
    const now = this.now()
    const last = this.#last.get(key)
    if (last !== undefined && now - last < this.intervalMs) return false
    this.#last.set(key, now)
    return true
  }
  clear(key: string): void {
    this.#last.delete(key)
  }
}
