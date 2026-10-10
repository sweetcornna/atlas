// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A client for the node's own `qmcode app-server`, over its WebSocket
 * JSON-RPC (handoff-p17-plan.md §2 P17.5「app-server 客户端」).
 *
 * The node bridge (`qm handoff node`) drives the app-server that runs next to
 * it on loopback: resume a thread (or import a Claude Code session, or start a
 * fresh one), start a turn with the brief, wait for that turn to end. This file
 * is the only network code in `@qianmo/handoff`, and it only ever talks to
 * that one local listener.
 *
 * ## Wire shape (fork `codex-rs/app-server-protocol`, rust-v0.158.0)
 *
 * - Frames are JSON objects **without** a `"jsonrpc"` member: requests
 *   `{id, method, params}`, responses `{id, result}` / `{id, error}`,
 *   notifications `{method, params}`, and server-to-client requests carry both
 *   `id` and `method`.
 * - The upgrade carries `Authorization: Bearer <token>` (`--ws-auth
 *   capability-token`) and no `Origin` header.
 * - After `initialize` the client sends the `initialized` notification.
 *
 * ## Types are written by hand
 *
 * Only the fields this client sends or reads, from the fork's
 * `protocol/v2/{thread,thread_data,turn,config,item}.rs` and `v1.rs`
 * (decisions.md 第 13 条: no generated bindings copied in). Field names are the
 * serde `camelCase` forms. Methods used: `initialize`, `thread/resume`,
 * `thread/start`, `turn/start`, `turn/interrupt`, `externalAgentConfig/import`;
 * notifications read: `turn/completed`, `item/completed`,
 * `externalAgentConfig/import/completed`. `qm handoff attach` (P17.6) reads
 * two more, through the user's own tunnel to a node: `thread/loaded/list` and
 * `thread/read` without turns, to find the thread a task runs in by its
 * working directory (seen on the fork's 0.158.0 release build, 2026-10-04:
 * `{data: [<thread id>], nextCursor: null}` and `thread.cwd`). Anything else
 * the server sends is ignored; a server-to-client request (an approval, say —
 * the bridge runs with `approvalPolicy: "never"`, so none is expected) is
 * answered `-32601`.
 */

/** How a turn ended, or that it has not (`turn.status`). */
export type AppServerTurnStatus =
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'inProgress'

export interface AppServerTurn {
  readonly id: string
  readonly status: AppServerTurnStatus
}

export interface AppServerThread {
  readonly id: string
  /** `thread.path`: the rollout on disk, when the server says. */
  readonly path: string | null
}

/** `approvalPolicy` / `sandbox` as the bridge passes them. */
export interface AppServerThreadSettings {
  readonly cwd: string
  readonly approvalPolicy: 'never'
  readonly sandbox: 'workspace-write'
}

/** A JSON-RPC error answer, or a transport failure on the way to one. */
export class AppServerError extends Error {
  /** JSON-RPC error code; `null` for a timeout or a closed connection. */
  readonly code: number | null
  readonly method: string

  constructor(method: string, message: string, code: number | null = null) {
    super(`app-server ${method}: ${message}`)
    this.name = 'AppServerError'
    this.code = code
    this.method = method
  }
}

/** `externalAgentConfig/import` finished without a thread to resume. */
export class AppServerImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppServerImportError'
  }
}

export interface AppServerClientOptions {
  /** `ws://127.0.0.1:<port>`. */
  readonly url: string
  /** The capability token from `--ws-token-file`. */
  readonly token: string
  readonly clientName?: string
  readonly clientVersion?: string
  /** Per request; default 60 s. */
  readonly requestTimeoutMs?: number
  /** For the upgrade; default 15 s. */
  readonly connectTimeoutMs?: number
}

type Frame = Record<string, unknown>

interface Pending {
  readonly method: string
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface Waiter {
  readonly match: (frame: Frame) => boolean
  readonly resolve: (frame: Frame) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout> | null
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_IMPORT_TIMEOUT_MS = 120_000
/** Pages of `thread/loaded/list` read at most; a node holds a handful. */
const MAX_LIST_PAGES = 20
/** Notifications kept for late waiters; the oldest go first. */
const RETAINED_NOTIFICATIONS = 512

function isFrame(value: unknown): value is Frame {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function field(value: unknown, key: string): unknown {
  return isFrame(value) ? value[key] : undefined
}

function stringField(value: unknown, key: string): string | null {
  const found = field(value, key)
  return typeof found === 'string' ? found : null
}

const TURN_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'interrupted',
  'failed',
  'inProgress',
])

function threadOf(method: string, result: unknown): AppServerThread {
  const thread = field(result, 'thread')
  const id = stringField(thread, 'id')
  if (id === null || id === '') {
    throw new AppServerError(method, 'the answer names no thread')
  }
  return { id, path: stringField(thread, 'path') }
}

function turnOf(method: string, value: unknown): AppServerTurn {
  const id = stringField(value, 'id')
  const status = stringField(value, 'status')
  if (
    id === null ||
    id === '' ||
    status === null ||
    !TURN_STATUSES.has(status)
  ) {
    throw new AppServerError(method, 'the answer names no turn')
  }
  return { id, status: status as AppServerTurnStatus }
}

export class AppServerClient {
  readonly #socket: WebSocket
  readonly #requestTimeoutMs: number
  readonly #pending = new Map<number, Pending>()
  readonly #waiters = new Set<Waiter>()
  readonly #seen: Frame[] = []
  #nextId = 1
  #closedError: Error | null = null
  readonly closed: Promise<void>
  #markClosed: () => void = () => {}

  private constructor(socket: WebSocket, requestTimeoutMs: number) {
    this.#socket = socket
    this.#requestTimeoutMs = requestTimeoutMs
    this.closed = new Promise(resolve => {
      this.#markClosed = resolve
    })
    socket.addEventListener('message', event => {
      this.#onFrame(
        typeof event.data === 'string' ? event.data : String(event.data),
      )
    })
    socket.addEventListener('close', () => {
      this.#fail(
        new AppServerError(
          'connection',
          'the app-server closed the connection',
        ),
      )
    })
  }

  /** Open the connection and run `initialize` + `initialized`. */
  static async connect(
    options: AppServerClientOptions,
  ): Promise<AppServerClient> {
    const socket = new WebSocket(options.url, {
      // Bun supports headers on the WebSocket handshake.
      headers: { Authorization: `Bearer ${options.token}` },
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new AppServerError('connect', `no answer from ${options.url}`))
        socket.close()
      }, options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        // The token never goes into the message: a refused upgrade is a 401
        // and that is all a reader needs.
        reject(new AppServerError('connect', `cannot open ${options.url}`))
      })
    })
    const client = new AppServerClient(
      socket,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    )
    try {
      await client.#request('initialize', {
        clientInfo: {
          name: options.clientName ?? 'qianmo_handoff_node',
          title: 'Qianmo handoff node bridge',
          version: options.clientVersion ?? '0.0.0',
        },
        // `approvalPolicy` on thread/resume is an experimental-nested field.
        capabilities: { experimentalApi: true },
      })
      client.#send({ method: 'initialized' })
    } catch (error) {
      client.close()
      throw error
    }
    return client
  }

  /** `thread/resume` with the node's cwd and the bridge's fixed settings. */
  async threadResume(
    threadId: string,
    settings: AppServerThreadSettings,
  ): Promise<AppServerThread> {
    const result = await this.#request('thread/resume', {
      threadId,
      cwd: settings.cwd,
      approvalPolicy: settings.approvalPolicy,
      sandbox: settings.sandbox,
      excludeTurns: true,
    })
    return threadOf('thread/resume', result)
  }

  /** `thread/start`: the fallback path's fresh thread. */
  async threadStart(
    settings: AppServerThreadSettings,
  ): Promise<AppServerThread> {
    const result = await this.#request('thread/start', {
      cwd: settings.cwd,
      approvalPolicy: settings.approvalPolicy,
      sandbox: settings.sandbox,
    })
    return threadOf('thread/start', result)
  }

  /**
   * `turn/start` with one text input. Returns the turn id — of a new turn, or
   * of the running one the input was steered into.
   */
  async turnStart(threadId: string, text: string): Promise<string> {
    const result = await this.#request('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    })
    return turnOf('turn/start', field(result, 'turn')).id
  }

  async turnInterrupt(threadId: string, turnId: string): Promise<void> {
    await this.#request('turn/interrupt', { threadId, turnId })
  }

  /**
   * Import one Claude Code session file (already under the app-server's
   * `$HOME/.claude/projects/`) and return the thread it became:
   * `successes[0].target` of the `SESSIONS` result (probe 第 4 项). Throws
   * {@link AppServerImportError} when the import reports no such thread.
   */
  async importClaudeCodeSession(input: {
    readonly path: string
    readonly cwd: string
    readonly description: string
    readonly timeoutMs?: number
  }): Promise<string> {
    const answer = await this.#request('externalAgentConfig/import', {
      migrationItems: [
        {
          itemType: 'SESSIONS',
          description: input.description,
          cwd: null,
          details: {
            sessions: [{ path: input.path, cwd: input.cwd, title: null }],
          },
        },
      ],
    })
    const importId = stringField(answer, 'importId')
    if (importId === null) {
      throw new AppServerImportError('the import answer carries no importId')
    }
    const completed = await this.#waitFor(
      frame =>
        frame.method === 'externalAgentConfig/import/completed' &&
        stringField(frame.params, 'importId') === importId,
      input.timeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS,
      'externalAgentConfig/import/completed',
    )
    const results = field(completed.params, 'itemTypeResults')
    const sessions = Array.isArray(results)
      ? results.find(result => field(result, 'itemType') === 'SESSIONS')
      : undefined
    const successes = field(sessions, 'successes')
    const target = Array.isArray(successes)
      ? stringField(successes[0], 'target')
      : null
    if (target === null || target === '') {
      const failures = field(sessions, 'failures')
      const first = Array.isArray(failures) ? failures[0] : undefined
      const message = stringField(first, 'message')
      throw new AppServerImportError(
        message === null
          ? 'the import completed without a thread'
          : `the import failed: ${message.slice(0, 300)}`,
      )
    }
    return target
  }

  /** Resolves with the turn once `turn/completed` for it arrives. */
  async waitTurnCompleted(
    threadId: string,
    turnId: string,
    timeoutMs: number | null = null,
  ): Promise<AppServerTurn> {
    const frame = await this.#waitFor(
      candidate =>
        candidate.method === 'turn/completed' &&
        stringField(candidate.params, 'threadId') === threadId &&
        stringField(field(candidate.params, 'turn'), 'id') === turnId,
      timeoutMs,
      `turn/completed ${turnId}`,
    )
    return turnOf('turn/completed', field(frame.params, 'turn'))
  }

  /**
   * `thread/loaded/list`: the ids of every thread the server holds in memory,
   * all pages.
   */
  async loadedThreadIds(): Promise<string[]> {
    const ids: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await this.#request(
        'thread/loaded/list',
        cursor === null ? {} : { cursor },
      )
      const data = field(result, 'data')
      if (Array.isArray(data)) {
        for (const id of data) if (typeof id === 'string') ids.push(id)
      }
      cursor = stringField(result, 'nextCursor')
      if (cursor === null) break
    }
    return ids
  }

  /** `thread/read` without turns: the thread's working directory, if it says. */
  async threadCwd(threadId: string): Promise<string | null> {
    const result = await this.#request('thread/read', { threadId })
    return stringField(field(result, 'thread'), 'cwd')
  }

  /** Text of the last `agentMessage` item completed in `turnId`, if any. */
  lastAgentMessage(turnId: string): string | null {
    for (let index = this.#seen.length - 1; index >= 0; index--) {
      const frame = this.#seen[index]
      if (frame?.method !== 'item/completed') continue
      if (stringField(frame.params, 'turnId') !== turnId) continue
      const item = field(frame.params, 'item')
      if (field(item, 'type') !== 'agentMessage') continue
      const text = stringField(item, 'text')
      if (text !== null) return text
    }
    return null
  }

  close(): void {
    try {
      this.#socket.close()
    } catch {}
    this.#fail(new AppServerError('connection', 'closed by the bridge'))
  }

  // ─── internals ─────────────────────────────────────────────────────

  #send(frame: Frame): void {
    this.#socket.send(JSON.stringify(frame))
  }

  #request(method: string, params: unknown): Promise<unknown> {
    if (this.#closedError !== null) return Promise.reject(this.#closedError)
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(
          new AppServerError(
            method,
            `no answer in ${this.#requestTimeoutMs} ms`,
          ),
        )
      }, this.#requestTimeoutMs)
      this.#pending.set(id, { method, resolve, reject, timer })
      this.#send({ id, method, params })
    })
  }

  #waitFor(
    match: (frame: Frame) => boolean,
    timeoutMs: number | null,
    what: string,
  ): Promise<Frame> {
    const earlier = this.#seen.find(match)
    if (earlier !== undefined) return Promise.resolve(earlier)
    if (this.#closedError !== null) return Promise.reject(this.#closedError)
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve,
        reject,
        timer:
          timeoutMs === null
            ? null
            : setTimeout(() => {
                this.#waiters.delete(waiter)
                reject(new AppServerError(what, `not seen in ${timeoutMs} ms`))
              }, timeoutMs),
      }
      this.#waiters.add(waiter)
    })
  }

  #onFrame(text: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (!isFrame(frame)) return
    const id = frame.id
    const method = frame.method
    if (id !== undefined && typeof method === 'string') {
      // A request from the server. The bridge handles none of them.
      this.#send({
        id,
        error: {
          code: -32601,
          message: 'the handoff node bridge does not handle server requests',
        },
      })
      return
    }
    if (typeof id === 'number' && method === undefined) {
      const pending = this.#pending.get(id)
      if (pending === undefined) return
      this.#pending.delete(id)
      clearTimeout(pending.timer)
      const error = frame.error
      if (error !== undefined && error !== null) {
        const code = field(error, 'code')
        pending.reject(
          new AppServerError(
            pending.method,
            stringField(error, 'message') ?? 'error',
            typeof code === 'number' ? code : null,
          ),
        )
        return
      }
      pending.resolve(frame.result)
      return
    }
    if (typeof method !== 'string') return
    this.#seen.push(frame)
    if (this.#seen.length > RETAINED_NOTIFICATIONS) this.#seen.shift()
    for (const waiter of this.#waiters) {
      if (!waiter.match(frame)) continue
      this.#waiters.delete(waiter)
      if (waiter.timer !== null) clearTimeout(waiter.timer)
      waiter.resolve(frame)
    }
  }

  #fail(error: Error): void {
    if (this.#closedError !== null) return
    this.#closedError = error
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
    for (const waiter of this.#waiters) {
      if (waiter.timer !== null) clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.#waiters.clear()
    this.#markClosed()
  }
}
