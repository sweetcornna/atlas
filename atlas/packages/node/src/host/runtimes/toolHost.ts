// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { createInterface } from 'node:readline'

/** The session a bridge token was issued for. */
export interface RuntimeToolSession {
  readonly agent: string
  readonly sessionId: string
}

/** One host tool as MCP lists it. */
export interface RuntimeToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

export interface RuntimeToolResult {
  readonly ok: boolean
  readonly text: string
}

export interface RuntimeToolHostOptions {
  readonly list: (session: RuntimeToolSession) => readonly RuntimeToolSpec[]
  readonly call: (
    session: RuntimeToolSession,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<RuntimeToolResult>
  readonly onError?: (error: unknown) => void
}

/** Bytes of one bridge request line; tool arguments are small JSON. */
const MAX_LINE_BYTES = 1024 * 1024

function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

/**
 * The loopback endpoint `qm runtime-mcp` relays MCP calls to.
 *
 * Every live external-runtime session gets its own random token; a request
 * names the token, never an agent or session, so a bridge can only act for the
 * session it was started for. Tokens reach the bridge in a 0600 file inside
 * the session directory, not on a command line other users can read.
 */
export class RuntimeToolHost {
  readonly #options: RuntimeToolHostOptions
  readonly #sessions = new Map<string, RuntimeToolSession>()
  readonly #sockets = new Set<Socket>()
  #server: Server | undefined
  #port: number | undefined

  constructor(options: RuntimeToolHostOptions) {
    this.#options = options
  }

  get port(): number {
    if (this.#port === undefined) throw new Error('runtime tool host is closed')
    return this.#port
  }

  async start(): Promise<void> {
    if (this.#server !== undefined) return
    const server = createServer(socket => this.#accept(socket))
    this.#server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string')
      throw new Error('runtime tool host has no TCP address')
    this.#port = address.port
  }

  /** A fresh token bound to one session; revoke it when the process ends. */
  issue(session: RuntimeToolSession): string {
    const token = randomBytes(32).toString('base64url')
    this.#sessions.set(digest(token).toString('hex'), session)
    return token
  }
  revoke(token: string): void {
    this.#sessions.delete(digest(token).toString('hex'))
  }

  #session(token: unknown): RuntimeToolSession | undefined {
    if (typeof token !== 'string' || token.length < 16) return undefined
    const wanted = digest(token)
    for (const [key, session] of this.#sessions) {
      if (timingSafeEqual(Buffer.from(key, 'hex'), wanted)) return session
    }
    return undefined
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket)
    socket.once('close', () => this.#sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    const lines = createInterface({ input: socket, crlfDelay: Infinity })
    lines.on('line', line => {
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        socket.destroy()
        return
      }
      void this.#handle(socket, line)
    })
  }

  async #handle(socket: Socket, line: string): Promise<void> {
    let request: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('request must be an object')
      request = parsed as Record<string, unknown>
    } catch {
      socket.destroy()
      return
    }
    const reply = (body: Record<string, unknown>) => {
      if (!socket.destroyed)
        socket.write(`${JSON.stringify({ id: request.id, ...body })}\n`)
    }
    const session = this.#session(request.token)
    if (session === undefined) {
      reply({ error: 'unknown or revoked runtime session token' })
      return
    }
    try {
      if (request.method === 'list') {
        reply({ tools: this.#options.list(session) })
        return
      }
      if (request.method === 'call' && typeof request.name === 'string') {
        const args =
          request.args && typeof request.args === 'object'
            ? (request.args as Record<string, unknown>)
            : {}
        reply({
          result: await this.#options.call(session, request.name, args),
        })
        return
      }
      reply({ error: 'unknown runtime tool host method' })
    } catch (error) {
      this.#options.onError?.(error)
      reply({ error: 'the resident host could not complete this tool' })
    }
  }

  async stop(): Promise<void> {
    this.#sessions.clear()
    for (const socket of this.#sockets) socket.destroy()
    const server = this.#server
    this.#server = undefined
    this.#port = undefined
    if (server !== undefined)
      await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
