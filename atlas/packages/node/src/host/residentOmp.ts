// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { NodeDesktop } from './desktop.js'
import type { AgentExtensionsSource } from './extensions.js'

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { RpcFrameDecoder } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame'
import { isRecord, sanitizeText } from '@oh-my-pi/pi-utils'
import { qianmoConfigPath } from '@qianmo/paths'
import { redactHandoffText } from '@qianmo/handoff'
import {
  markResidentInput,
  residentActiveTools,
  residentConfigOverlay,
  residentInputIdentityOf,
  RESIDENT_EXTENSION_CONFIG_ENV,
  type ResidentExtensionConfig,
} from '@qianmo/extension/policy'
import type {
  OmpRpcChannel,
  OmpRpcFrame,
  OmpTurnRouter,
  OmpPromptAdmission,
  ResidentAgentSession,
  ResidentSessionConnection,
} from '@qianmo/resident'
import { ompArgv, ompSpawnEnv } from '../omp/launch.js'
import {
  residentMediaRoutes,
  ResidentModelRouter,
  readResidentManualSelection,
} from './residentRouting.js'
import { VIDEO_TOOL, runVideoTool, type VideoToolResult } from './videoTool.js'
import { nodeModelSelection } from '../providers/node.js'
import { residentOmpEnvironment } from './residentOmpEnv.js'
import { parseResidentOmpLocalCommand } from './residentLocalCommand.js'
import { residentToolSurface, type HostToolDefinition } from './notifyTool.js'
import { dispatchHostTool } from './hostToolDispatch.js'
import { residentExtensionPath } from './residentExtension.js'

export interface ResidentOmpSpawn {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
  readonly sessionId: string
  readonly sessionDir: string
  readonly agent: string
}

const STARTUP_STDERR_LIMIT = 2_048

/** Only the bounded tail is retained; ambiguous boundary secrets are discarded. */
function startupDiagnostic(stderr: Buffer, truncated: boolean): string {
  // Normalize terminal escapes before matching keys, tokens or PEM lines.
  let tail = sanitizeText(stderr.toString('utf8'))
  let omitted = false
  if (truncated) {
    const newline = tail.indexOf('\n')
    tail = newline === -1 ? '' : tail.slice(newline + 1)
    omitted = tail.trim() === ''
    // The PEM header may already be gone. Mask every base64-style line at
    // the cut boundary, including short final lines, until a non-base64 line.
    tail = tail.replace(
      /^(?:[ \t]*[A-Za-z0-9+/=_-]+[ \t]*(?:\r?\n|$))+/,
      block => block.replace(/[^\r\n]+/g, '[REDACTED]'),
    )
  }
  tail = tail
    .replace(
      /-----BEGIN[^\r\n]*-----[\s\S]*?(?:-----END[^\r\n]*-----|$)/gi,
      '[REDACTED]',
    )
    .replace(/^[^\r\n]*-----END[^\r\n]*-----[^\r\n]*$/gim, '[REDACTED]')
    // Startup diagnostics are less valuable than secrets. Mask the remainder
    // of a credential field's line, even for unquoted YAML/env or complex values.
    .replace(
      /(\b(?:api[-_]?key|token|password|secret|authorization)\b(?:\\?["'])?[ \t]*[:=][ \t]*)[^\r\n]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /(\bBearer[ \t]+)(?:\\?["'][^\r\n]*|[^\s"'\\,;]+)/gi,
      '$1[REDACTED]',
    )
  tail = redactHandoffText(tail)
    .text.replace(/\bsk[-_][A-Za-z0-9_-]+/gi, '[REDACTED]')
    .replace(/[A-Za-z0-9_+/=-]{32,}/g, '[REDACTED]')
    .trim()
  const clean = Buffer.from(tail)
  const marker =
    truncated || clean.length > STARTUP_STDERR_LIMIT
      ? `[startup output truncated]${omitted ? '\n[startup line omitted]' : ''}`
      : ''
  // Redaction can expand short keys. Include markers inside the byte budget,
  // and never start the returned tail inside a UTF-8 codepoint.
  const budget =
    STARTUP_STDERR_LIMIT - (marker ? Buffer.byteLength(marker) + 1 : 0)
  let offset = Math.max(0, clean.length - budget)
  while (offset < clean.length && (clean[offset]! & 0xc0) === 0x80) offset++
  tail = clean.subarray(offset).toString('utf8')
  return marker ? `${marker}${tail ? `\n${tail}` : ''}` : tail
}

/** One JSONL transport. Command responses and asynchronous events are distinct. */
export class OmpRpcProcess implements OmpRpcChannel {
  readonly child: ChildProcess
  /** Protocol liveness, which may fail before the operating-system process exits. */
  readonly closed: Promise<void>
  readonly #reaped: Promise<void>
  #stopping: Promise<void> | undefined
  readonly #listeners = new Set<(frame: OmpRpcFrame) => void>()
  readonly #pending = new Map<
    string,
    { resolve: (value: OmpRpcFrame) => void; reject: (error: Error) => void }
  >()
  readonly #ready: Promise<OmpRpcFrame>
  #intentional = false
  #sequence = 0
  #alive = true
  #readyAt: number | undefined
  #endedAt: number | undefined
  #stderrDrain: (() => void) | undefined

  readonly #routing: ResidentModelRouter
  #routeCompletion: Promise<void> = Promise.resolve()
  constructor(
    child: ChildProcess,
    manualPath?: string,
    readyTimeoutMs = 30_000,
    forwardStderr = false,
  ) {
    this.#routing = new ResidentModelRouter(manualPath)
    this.child = child
    if (child.stdin === null || child.stdout === null)
      throw new Error('omp RPC requires piped stdin/stdout')
    // A parse/pipe error makes the RPC channel unusable, but is not exit
    // evidence. Never release a generation's teardown until `close` confirms
    // the actual process and its stdio are gone, including failed spawns.
    this.#reaped = new Promise(resolve =>
      child.once('close', () => {
        this.#releaseStderr()
        resolve()
      }),
    )
    let readyResolve!: (frame: OmpRpcFrame) => void
    let readyReject!: (error: Error) => void
    this.#ready = new Promise((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    void this.#ready.catch(() => {})
    const decoder = new RpcFrameDecoder()
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    // Retain a bounded raw tail; redaction also handles truncated PEM residue.
    let stderr = Buffer.alloc(0)
    let stderrTruncated = false
    child.stderr?.on('data', (chunk: Buffer) => {
      if (this.#readyAt !== undefined) {
        if (forwardStderr) this.#writeStderr(chunk)
        return
      }
      stderr = Buffer.concat([stderr, chunk])
      if (stderr.length > STARTUP_STDERR_LIMIT) {
        stderrTruncated = true
        stderr = Buffer.from(stderr.subarray(-STARTUP_STDERR_LIMIT))
      }
    })
    const startupReason = (error: Error): Error => {
      const tail = startupDiagnostic(stderr, stderrTruncated)
      return tail
        ? new Error(`${error.message}; startup stderr: ${tail}`)
        : error
    }
    const readyTimeout = setTimeout(() => {
      readyReject(new Error('omp RPC ready timed out'))
      child.kill('SIGTERM')
    }, readyTimeoutMs)
    this.closed = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (!this.#alive) return
        this.#alive = false
        this.#endedAt ??= Date.now()
        clearTimeout(readyTimeout)
        lines.close()
        // readline.close() pauses stdout. Drain both pipes to EOF so buffered
        // frames (or an unread piped stderr) cannot suppress ChildProcess close
        // after exit and strand the real-process reaping promise.
        child.stdout?.resume()
        this.#releaseStderr()
        const failure =
          this.#readyAt === undefined
            ? startupReason(
                error ?? new Error('omp RPC child closed before ready'),
              )
            : error
        const reason = failure ?? new Error('omp RPC child closed')
        readyReject(reason)
        for (const pending of this.#pending.values()) pending.reject(reason)
        this.#pending.clear()
        if (this.#intentional || failure === undefined) resolve()
        else reject(failure)
      }
      child.once('error', finish)
      const exited = (code: number | null, signal: NodeJS.Signals | null) =>
        finish(
          code === 0
            ? undefined
            : new Error(`omp RPC child exited code=${code} signal=${signal}`),
        )
      child.once('exit', (code, signal) => {
        // Before ready, close also guarantees stderr has drained. After ready
        // retain the existing immediate protocol failure on exit.
        if (this.#readyAt !== undefined) exited(code, signal)
      })
      child.once('close', exited)
      child.stdin?.on('error', finish)
      lines.on('line', line => {
        try {
          const decoded = decoder.push(JSON.parse(line))
          if (decoded === undefined) return
          const frame = decoded as OmpRpcFrame
          if (frame.type === 'ready') {
            this.#readyAt ??= Date.now()
            const diagnostic = startupDiagnostic(stderr, stderrTruncated)
            if (forwardStderr && diagnostic)
              this.#writeStderr(`${diagnostic}\n`)
            stderr = Buffer.alloc(0)
            stderrTruncated = false
            clearTimeout(readyTimeout)
            readyResolve(frame)
          }
          if (frame.type === 'response' && typeof frame.id === 'string') {
            const pending = this.#pending.get(frame.id)
            this.#pending.delete(frame.id)
            if (frame.success === false)
              pending?.reject(
                new Error(String(frame.error ?? 'omp RPC request failed')),
              )
            else pending?.resolve(frame)
          }
          if (
            (frame.type === 'prompt_result' &&
              frame.sessionSettled !== false) ||
            frame.type === 'session_settled'
          ) {
            this.#routeCompletion = this.#routeCompletion.then(() =>
              this.#routing.finish(this.#routeRpc),
            )
            void this.#routeCompletion.catch(() => {})
          }
          for (const listener of this.#listeners) listener(frame)
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
          child.kill('SIGTERM')
        }
      })
    })
    void this.closed.catch(() => {})
  }

  #writeStderr(chunk: string | Buffer): void {
    if (process.stderr.write(chunk) || !this.#alive || this.#intentional) return
    this.child.stderr?.pause()
    if (this.#stderrDrain) return
    this.#stderrDrain = () => {
      this.#stderrDrain = undefined
      this.child.stderr?.resume()
    }
    process.stderr.once('drain', this.#stderrDrain)
  }
  #releaseStderr(): void {
    if (this.#stderrDrain) process.stderr.off('drain', this.#stderrDrain)
    this.#stderrDrain = undefined
    // Shutdown must drain child pipes to real close even if the host writer
    // never drains. Already accepted writes remain owned by the host stream.
    this.child.stderr?.resume()
  }

  get alive(): boolean {
    return (
      this.#alive &&
      !this.child.killed &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    )
  }
  /** Frozen at protocol failure/stop, never extended by process reaping. */
  get readyRuntimeMs(): number {
    return this.#readyAt === undefined
      ? 0
      : (this.#endedAt ?? Date.now()) - this.#readyAt
  }
  async initialize(): Promise<void> {
    const ready = await this.#ready
    if (
      Array.isArray(ready.supportedProtocolVersions) &&
      ready.supportedProtocolVersions.includes(2)
    ) {
      await this.request('negotiate_protocol', { protocolVersion: 2 })
    }
  }
  onFrame(listener: (frame: OmpRpcFrame) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  send(frame: Record<string, unknown>): void {
    if (!this.alive) throw new Error('omp RPC child is closed')
    this.child.stdin?.write(`${JSON.stringify(frame)}\n`)
  }
  async request(
    type: string,
    input: Record<string, unknown> = {},
    timeoutMs = 30_000,
    routed = false,
  ): Promise<OmpRpcFrame> {
    if (!routed && (type === 'set_model' || type === 'set_thinking_level'))
      await this.#routeCompletion
    const id = `resident-${++this.#sequence}`
    const response = new Promise<OmpRpcFrame>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(id)
              reject(new Error(`omp RPC ${type} timed out`))
            }, timeoutMs)
          : undefined
      timer?.unref()
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
      }
      this.#pending.set(id, {
        resolve: value => {
          cleanup()
          resolve(value)
        },
        reject: error => {
          cleanup()
          reject(error)
        },
      })
      try {
        this.send({ ...input, id, type })
      } catch (error) {
        cleanup()
        this.#pending.delete(id)
        reject(error)
      }
    })
    const frame = await response
    if (!routed && (type === 'set_model' || type === 'set_thinking_level'))
      await this.#routing.remember(this.#routeRpc)
    return frame
  }
  get #routeRpc() {
    return {
      request: (type: string, input?: Record<string, unknown>) =>
        this.request(type, input, 30_000, true),
    }
  }
  async prepareRoute(input: {
    text: string
    hint?: unknown
    localCommand?: string
  }) {
    await this.#routeCompletion
    try {
      return await this.#routing.prepare(this.#routeRpc, input)
    } catch (error) {
      await this.#routing.finish(this.#routeRpc)
      throw error
    }
  }
  async prompt(input: {
    messageId: string
    text: string
  }): Promise<OmpPromptAdmission> {
    const local = parseResidentOmpLocalCommand(input.text)
    if (local) {
      try {
        const argument = local.argument
        const command = local.name
        let output: unknown
        if (command === 'autocompact')
          output =
            '/autocompact is unsupported by this omp resident; use the node compaction configuration.'
        else if (command === 'compact')
          output = (
            await this.request(
              'compact',
              argument ? { customInstructions: argument } : {},
              0, // Compaction is a model operation; the turn watchdog owns it.
            )
          ).data
        else if ((command === 'thinking' || command === 'effort') && argument)
          output =
            (await this.request('set_thinking_level', { level: argument }))
              .data ?? `Thinking level: ${argument}`
        else if (command === 'model' && argument === 'auto') {
          this.#routing.clear()
          output =
            'Manual model selection cleared; automatic routing follows node configuration.'
        } else if (command === 'model' && argument) {
          const slash = argument.indexOf('/')
          if (slash <= 0) throw new Error('/model requires provider/modelId')
          output = (
            await this.request('set_model', {
              provider: argument.slice(0, slash),
              modelId: argument.slice(slash + 1),
            })
          ).data
        } else output = (await this.request('get_state')).data
        return {
          requestId: randomUUID(),
          agentInvoked: false,
          output:
            typeof output === 'string' ? output : JSON.stringify(output ?? {}),
        }
      } finally {
        await this.#routing.finish(this.#routeRpc)
      }
    }
    let response: OmpRpcFrame
    try {
      response = await this.request('prompt', {
        message: markResidentInput(input.messageId, input.text),
      })
      if (
        (response.data as { agentInvoked?: boolean } | undefined)
          ?.agentInvoked === false
      )
        await this.#routing.finish(this.#routeRpc)
    } catch (error) {
      await this.#routing.finish(this.#routeRpc)
      throw error
    }
    const data = response.data as { agentInvoked?: boolean } | undefined
    return {
      requestId: String(response.id),
      agentInvoked: data?.agentInvoked !== false,
    }
  }
  async abort(): Promise<void> {
    await this.request('abort')
  }
  stop(terminateImmediately = false): Promise<void> {
    this.#stopping ??= this.#stopAndReap()
    // A later caller can escalate an existing graceful shutdown. Reaping is
    // shared, but every immediate request must reach the OS synchronously.
    if (terminateImmediately) this.#signal('SIGTERM')
    return this.#stopping
  }
  #signal(name: NodeJS.Signals): void {
    try {
      this.child.kill(name)
    } catch {
      // Failure to send a signal is not proof of exit. Keep waiting for
      // close; an unknown process lifetime cannot open the next generation.
    }
  }
  async #stopAndReap(): Promise<void> {
    this.#intentional = true
    this.#endedAt ??= Date.now()
    this.#releaseStderr()
    try {
      this.child.stdin?.end()
    } catch {
      this.#signal('SIGTERM')
    }
    const terminate = setTimeout(() => this.#signal('SIGTERM'), 1_000)
    const kill = setTimeout(() => this.#signal('SIGKILL'), 2_000)
    terminate.unref()
    kill.unref()
    try {
      await this.#reaped
    } finally {
      clearTimeout(terminate)
      clearTimeout(kill)
    }
  }
}

export const DEFAULT_OMP_IDLE_MS = 600_000
export const DEFAULT_OMP_QUEUE_LIMIT = 64
export const DEFAULT_OMP_QUEUE_TIMEOUT_MS = 30_000

interface CapacityWaiter {
  readonly sessionId: string
  readonly opening: OmpOpening
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  readonly timer: Timer
}

interface OmpOpening {
  readonly promise: Promise<OmpRpcProcess>
  cancelled: boolean
}

interface PoolOptions {
  readonly extensionPath?: string
  /** Internal startup budget; the production default remains 30 seconds. */
  readonly readyTimeoutMs?: number
  readonly desktop?: NodeDesktop
  /** Operator-configured MCP servers, skills and plugins (P32). */
  readonly extensions?: AgentExtensionsSource
  readonly extraHostTools?: readonly HostToolDefinition[]
  readonly onLaunch?: (
    sessionId: string,
    policy: ResidentExtensionConfig,
    configHash: string,
  ) => void
  readonly protectedRoots?: readonly string[]
  readonly agents: readonly ResidentAgentSession[]
  readonly memoryRoot: string
  readonly allowWorkspaceEdits?: boolean
  readonly spawn?: (input: ResidentOmpSpawn) => ChildProcess
  readonly onActivity?: (active: boolean) => void | Promise<void>
  readonly onError?: (error: unknown) => void
  readonly announce: (
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  readonly idleChildMs?: number
  readonly maxChildren?: number
  readonly queueLimit?: number
  readonly queueTimeoutMs?: number
  /** Consecutive lazy startup failures, independent of time spent idle. */
  readonly maxStartFailures?: number
  readonly onParked?: (reason: string) => void
  readonly memoryWrite?: (
    sessionId: string,
    args: unknown,
  ) => Promise<{ ok: boolean; text: string }>
  readonly memoryAnswer?: (
    sessionId: string,
    args: unknown,
  ) => { ok: boolean; text: string }
  readonly requestPermission?: (
    sessionId: string,
    call: unknown,
  ) => Promise<ResidentPermission>
}

/**
 * The host's answer to one `QIANMO_AUTHZ_V1` request: `true` grants, and so
 * does `{ ok: true }`; anything else refuses. A refusal object's reason
 * reaches the extension only through the text-answered (`input`) request.
 */
export type ResidentPermission =
  | boolean
  | {
      readonly ok: boolean
      readonly reason?: string
      /** A desktop phase the host carried out answers with a value. */
      readonly value?: string
    }

/** Registered (agent, context) sessions acquire isolated omp processes on demand. */
export class ResidentOmpPool
  implements ResidentSessionConnection, OmpTurnRouter
{
  readonly closed: Promise<void>
  readonly #options: PoolOptions
  readonly #children = new Map<string, OmpRpcProcess>()
  readonly #retiring = new Map<string, Promise<void>>()
  readonly #starting = new Map<string, OmpOpening>()
  readonly #owners = new Map<string, ResidentAgentSession>()
  readonly #busy = new Set<string>()
  readonly #used = new Map<string, number>()
  readonly #recency = new Map<string, number>()
  #useSequence = 0
  readonly #timer: Timer
  /** Includes reserved starts and retiring processes until actual close. */
  readonly #slots = new Map<string, OmpOpening>()
  readonly #queue: CapacityWaiter[] = []
  readonly #pins = new Map<string, Set<symbol>>()
  #startFailures = 0
  #completedTurn = false
  #longestReadyMs = 0
  #parkedReason: string | undefined
  #resolve!: () => void
  #reject!: (error: Error) => void
  #stopped = false
  #stopping: Promise<void> | undefined
  #failed = false

  constructor(options: PoolOptions) {
    this.#options = options
    this.closed = new Promise((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject
    })
    void this.closed.catch(() => {})
    const idle = options.idleChildMs ?? DEFAULT_OMP_IDLE_MS
    if (!Number.isSafeInteger(idle) || idle <= 0 || idle > 2_147_483_647)
      throw new Error(
        'omp idle milliseconds must be an integer in 1..2147483647',
      )
    for (const [name, value] of [
      ['max children', options.maxChildren],
      ['queue limit', options.queueLimit],
      ['queue timeout', options.queueTimeoutMs],
      ['max start failures', options.maxStartFailures],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
        throw new Error(`omp ${name} must be a positive integer`)
    }
    this.#timer = setInterval(
      () => {
        for (const [id, last] of this.#used) {
          if (this.#idle(id) && Date.now() - last >= idle) this.closeSession(id)
        }
      },
      Math.min(idle, 60_000),
    )
    this.#timer.unref()
  }
  get alive(): boolean {
    return (
      !this.#stopped &&
      !this.#failed &&
      this.#parkedReason === undefined &&
      [...this.#children.values()].every(child => child.alive)
    )
  }
  get parkedReason(): string | undefined {
    return this.#parkedReason
  }
  isStable(stableAfterMs: number): boolean {
    return (
      this.#completedTurn ||
      this.#longestReadyMs >= stableAfterMs ||
      [...this.#children.values()].some(
        child => child.readyRuntimeMs >= stableAfterMs,
      )
    )
  }
  #assertAvailable(): void {
    if (this.#stopped || this.#failed)
      throw new Error('resident omp pool is closed')
    if (this.#parkedReason) throw new Error(this.#parkedReason)
  }
  async initialize(): Promise<void> {
    this.#assertAvailable()
  }
  async newSession(input: ResidentAgentSession): Promise<string> {
    const sessionId = randomUUID()
    await this.resumeSession({ ...input, sessionId })
    return sessionId
  }
  async resumeSession(
    input: ResidentAgentSession & { sessionId: string },
  ): Promise<void> {
    this.#assertAvailable()
    if (!/^[a-zA-Z0-9_-]+$/.test(input.sessionId))
      throw new Error('invalid resident session id')
    this.#owners.set(input.sessionId, input)
    // Registration preserves ownership and recovery without loading omp.
    mkdirSync(
      qianmoConfigPath('resident', 'sessions', input.agent, input.sessionId),
      { recursive: true, mode: 0o700 },
    )
  }
  #owner(sessionId: string): ResidentAgentSession {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId))
      throw new Error('invalid resident session id')
    const known = this.#owners.get(sessionId)
    if (known) return known
    // An admission may refer to a previous generation; determine its owner
    // from our configured agents, never from a peer-supplied path.
    for (const agent of this.#options.agents) {
      try {
        readdirSync(
          qianmoConfigPath('resident', 'sessions', agent.agent, sessionId),
        )
        this.#owners.set(sessionId, agent)
        return agent
      } catch {
        /* Try the next configured agent. */
      }
    }
    throw new Error(`resident session ${sessionId} has no configured owner`)
  }
  async invalidateAgent(agent: string): Promise<void> {
    const ids = [...this.#owners].filter(([, owner]) => owner.agent === agent)
    // Cancel all starts before joining any handshake (including queued starts).
    for (const [id] of ids) this.closeSession(id)
    await Promise.allSettled(
      ids.map(async ([id]) => {
        await this.#starting.get(id)?.promise.catch(() => {})
        await this.#retiring.get(id)
      }),
    )
  }
  async channelFor(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<OmpRpcProcess> {
    this.#assertAvailable()
    signal?.throwIfAborted()
    this.#owner(sessionId)
    const pin = Symbol(sessionId)
    const pins = this.#pins.get(sessionId) ?? new Set<symbol>()
    pins.add(pin)
    this.#pins.set(sessionId, pins)
    const cancelled = Promise.withResolvers<never>()
    void cancelled.promise.catch(() => {})
    const release = () => {
      pins.delete(pin)
      if (pins.size === 0 && this.#pins.get(sessionId) === pins) {
        this.#pins.delete(sessionId)
        if (signal?.aborted && this.#starting.has(sessionId))
          this.closeSession(sessionId)
      }
      this.#drainCapacity()
    }
    const abort = () => {
      release()
      cancelled.reject(
        signal?.reason ?? new Error('resident omp startup aborted'),
      )
    }
    signal?.addEventListener('abort', abort, { once: true })
    let acquired = false
    try {
      // A cancelled opening owns both cleanup and real reaping. Retirement
      // alone can finish before #open's catch/finally. Never share its result.
      for (;;) {
        const previous = this.#starting.get(sessionId)
        const retiring = this.#retiring.get(sessionId)
        if (previous?.cancelled) {
          await Promise.race([
            previous.promise.catch(() => {}),
            cancelled.promise,
          ])
        } else if (retiring) {
          await Promise.race([retiring, cancelled.promise])
        } else break
      }
      this.#assertAvailable()
      signal?.throwIfAborted()
      this.#touch(sessionId)
      let opening = this.#starting.get(sessionId)
      if (!opening) {
        const existing = this.#children.get(sessionId)
        if (existing) {
          if (!existing.alive) {
            const error = new Error('resident omp child closed before reuse')
            this.#fail(error)
            throw error
          }
          acquired = true
          return existing
        }
        // Register before #open runs, even when configuration/spawn throws.
        const result = Promise.withResolvers<OmpRpcProcess>()
        opening = { promise: result.promise, cancelled: false }
        this.#starting.set(sessionId, opening)
        const instance = opening
        void Promise.resolve()
          .then(() => this.#open(sessionId, instance))
          .finally(() => {
            if (this.#starting.get(sessionId) === instance)
              this.#starting.delete(sessionId)
            this.#drainCapacity()
          })
          .then(result.resolve, result.reject)
      }
      const child = await Promise.race([opening.promise, cancelled.promise])
      signal?.throwIfAborted()
      acquired = true
      return child
    } finally {
      // A turn with a signal holds its pin through routing and execution;
      // aborting that signal in the turn's finally releases the reservation.
      if (!acquired || signal === undefined) {
        signal?.removeEventListener('abort', abort)
        release()
      }
    }
  }
  #fail(error: Error): void {
    this.#failed = true
    this.#drainCapacity()
    this.#reject(error)
  }
  #touch(sessionId: string): void {
    this.#used.set(sessionId, Date.now())
    this.#recency.set(sessionId, ++this.#useSequence)
  }
  #idle(sessionId: string): boolean {
    return (
      !this.#busy.has(sessionId) &&
      !this.#starting.has(sessionId) &&
      !this.#pins.has(sessionId)
    )
  }
  #claimCapacity(sessionId: string, opening: OmpOpening): Promise<void> {
    this.#assertAvailable()
    if (opening.cancelled) throw new Error('resident omp startup cancelled')
    if (this.#slots.size < (this.#options.maxChildren ?? Infinity)) {
      this.#slots.set(sessionId, opening)
      return Promise.resolve()
    }
    if (
      this.#queue.length >=
      (this.#options.queueLimit ?? DEFAULT_OMP_QUEUE_LIMIT)
    )
      throw new Error('resident omp child capacity queue is full')
    const waiting = Promise.withResolvers<void>()
    const timeout = this.#options.queueTimeoutMs ?? DEFAULT_OMP_QUEUE_TIMEOUT_MS
    const timer = setTimeout(() => {
      this.#removeWaiter(
        sessionId,
        new Error(
          `resident omp child capacity wait timed out after ${timeout} ms (all slots occupied)`,
        ),
      )
    }, timeout)
    timer.unref()
    this.#queue.push({ sessionId, opening, ...waiting, timer })
    this.#drainCapacity()
    return waiting.promise
  }
  #removeWaiter(sessionId: string, error: Error): void {
    const index = this.#queue.findIndex(
      waiter => waiter.sessionId === sessionId,
    )
    if (index < 0) return
    const [waiter] = this.#queue.splice(index, 1)
    clearTimeout(waiter!.timer)
    waiter!.reject(error)
  }
  #drainCapacity(): void {
    while (this.#queue.length > 0) {
      if (this.#stopped || this.#failed || this.#parkedReason) {
        this.#removeWaiter(
          this.#queue[0]!.sessionId,
          new Error(this.#parkedReason ?? 'resident omp pool is closed'),
        )
        continue
      }
      if (this.#slots.size < (this.#options.maxChildren ?? Infinity)) {
        const waiter = this.#queue.shift()!
        clearTimeout(waiter.timer)
        this.#slots.set(waiter.sessionId, waiter.opening)
        waiter.resolve()
        continue
      }
      // Reap one idle LRU process before reserving its place. Processes that
      // are starting, routing or running a turn are never capacity victims.
      if (this.#retiring.size === 0) {
        const idle = [...this.#children.keys()].filter(id => this.#idle(id))
        idle.sort(
          (a, b) => (this.#recency.get(a) ?? 0) - (this.#recency.get(b) ?? 0),
        )
        if (idle[0]) this.closeSession(idle[0])
      }
      return
    }
  }
  async #open(sessionId: string, opening: OmpOpening): Promise<OmpRpcProcess> {
    try {
      await this.#claimCapacity(sessionId, opening)
      this.#assertAvailable()
      if (opening.cancelled) throw new Error('resident omp startup cancelled')
      const child = await this.#spawn(sessionId)
      this.#assertAvailable()
      if (!child.alive || opening.cancelled)
        throw new Error('resident omp startup cancelled or child closed')
      this.#startFailures = 0
      this.#touch(sessionId)
      return child
    } catch (error) {
      const cancelled = opening.cancelled || this.#stopped
      const hadSlot = this.#slots.get(sessionId) === opening
      if (this.#starting.get(sessionId) === opening)
        this.closeSession(sessionId)
      await this.#retiring.get(sessionId)
      if (
        !this.#children.has(sessionId) &&
        !this.#retiring.has(sessionId) &&
        this.#slots.get(sessionId) === opening
      )
        this.#slots.delete(sessionId)
      // Queue pressure and user cancellation are not broken-model evidence.
      if (!cancelled && hadSlot && !this.#failed && !this.#parkedReason) {
        this.#startFailures++
        if (this.#startFailures >= (this.#options.maxStartFailures ?? 5)) {
          this.#parkedReason = `resident omp RPC parked after ${this.#startFailures} consecutive startup failures: ${error instanceof Error ? error.message : String(error)}; correct the provider configuration and restart resident`
          this.#options.onParked?.(this.#parkedReason)
          this.#options.onError?.(new Error(this.#parkedReason))
        }
      }
      this.#drainCapacity()
      throw error
    }
  }
  async #spawn(sessionId: string): Promise<OmpRpcProcess> {
    const owner = this.#owner(sessionId)
    const sessionDir = qianmoConfigPath(
      'resident',
      'sessions',
      owner.agent,
      sessionId,
    )
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
    const media = residentMediaRoutes()
    const tools = [
      ...residentToolSurface(
        this.#options.memoryWrite !== undefined,
        this.#options.extraHostTools,
      ),
      ...(media.video ? [VIDEO_TOOL] : []),
    ]
    const extensions = this.#options.extensions?.(owner.agent) ?? null
    const config: ResidentExtensionConfig = {
      v: 1,
      agent: owner.agent,
      workspace: owner.cwd,
      edits: this.#options.allowWorkspaceEdits ? 'workspace' : 'none',
      protectedRoots: [
        this.#options.memoryRoot,
        ...(this.#options.protectedRoots ?? []),
      ],
      hostTools: tools.map(tool => tool.name),
      media,
      ...(this.#options.desktop
        ? {
            desktopPath: this.#options.desktop.resourcePath(owner.agent),
            desktop: this.#options.desktop.resource(owner.agent),
          }
        : {}),
      ...(this.#options.requestPermission === undefined
        ? {}
        : { approvals: true }),
      ...(extensions === null
        ? {}
        : {
            mcp: extensions.mcp.map(server => ({
              server: server.name,
              approval: server.approval,
              tools: server.tools,
            })),
            readableRoots: extensions.readableRoots,
          }),
    }
    this.#options.onLaunch?.(
      sessionId,
      config,
      createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    )
    const configPath = join(sessionDir, 'resident-extension.json')
    const overlay = join(sessionDir, 'resident-config.yml')
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
    writeFileSync(overlay, residentConfigOverlay(config), { mode: 0o600 })
    const manualPath = join(sessionDir, 'manual-model.json')
    const selection =
      readResidentManualSelection(manualPath) ?? nodeModelSelection()
    const argv = ompArgv([
      '--mode',
      'rpc',
      ...(this.#options.requestPermission === undefined ? ['--no-ui'] : []),
      '--no-extensions',
      '--extension',
      this.#options.extensionPath ?? residentExtensionPath(sessionDir),
      '--config',
      overlay,
      '--approval-mode',
      config.edits === 'workspace' ? 'write' : 'always-ask',
      ...(extensions?.ompPluginDirs ?? []).flatMap(dir => [
        '--plugin-dir',
        dir,
      ]),
      '--tools',
      residentActiveTools(
        config.edits,
        [],
        config.media,
        config.desktop,
        config.mcp,
      ).join(','),
      ...(selection
        ? ['--model', `${selection.provider}/${selection.modelId}`]
        : []),
      ...(selection?.thinkingLevel
        ? ['--thinking', selection.thinkingLevel]
        : []),
    ])
    const env = residentOmpEnvironment({
      ...ompSpawnEnv(),
      [RESIDENT_EXTENSION_CONFIG_ENV]: configPath,
    })
    if (env.QIANMO_OMP_ENTRY === 'self') env.PI_COMPILED = 'true'
    if (config.desktop?.browser || config.desktop?.computer)
      env.TMPDIR = join(config.desktop.downloads, '..', 'screenshots')
    if (config.desktop?.computer) {
      env.DISPLAY = config.desktop.display!
      env.XAUTHORITY = config.desktop.xauthority!
      delete env.WAYLAND_DISPLAY
      delete env.DBUS_SESSION_BUS_ADDRESS
    } else {
      delete env.DISPLAY
      delete env.XAUTHORITY
      delete env.WAYLAND_DISPLAY
    }
    const input: ResidentOmpSpawn = {
      argv,
      cwd: owner.cwd,
      env,
      sessionId,
      sessionDir,
      agent: owner.agent,
    }
    const child = new OmpRpcProcess(
      this.#options.spawn?.(input) ??
        spawn(argv[0]!, argv.slice(1), {
          cwd: owner.cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      manualPath,
      this.#options.readyTimeoutMs,
      this.#options.spawn === undefined,
    )
    this.#children.set(sessionId, child)
    const videoCalls = new Map<string, AbortController>()
    // Evidence belongs to this child's unsettled activity stretch, not one
    // agent run: ticketless background continuations may start after the
    // completed prompt_result. Only explicit failure/abort, protocol failure,
    // or this child's closure invalidates it before settlement confirms it.
    let completedAwaitingSettlement = false
    void child.closed
      .finally(() => {
        completedAwaitingSettlement = false
        for (const controller of videoCalls.values()) controller.abort()
      })
      .catch(() => {})
    child.onFrame(frame => {
      if (this.#children.get(sessionId) !== child) return
      this.#touch(sessionId)
      // `confirm` answers yes/no. `input` carries the same request and is
      // answered with `{ ok, reason }`, so a refused desktop lease can say why.
      const authzInput =
        frame.type === 'extension_ui_request' &&
        frame.method === 'input' &&
        frame.title === 'QIANMO_AUTHZ_V1'
      if (
        (frame.type === 'extension_ui_request' && frame.method === 'confirm') ||
        authzInput
      ) {
        void (async () => {
          let answer: ResidentPermission = false
          const request = authzInput ? frame.placeholder : frame.message
          try {
            if (
              frame.title === 'QIANMO_AUTHZ_V1' &&
              typeof request === 'string'
            )
              answer = (await this.#options.requestPermission?.(
                sessionId,
                JSON.parse(request),
              )) ?? { ok: false, reason: '宿主没有接入授权通道' }
          } catch {
            /* Any missing, stale, malformed or unavailable authorization denies. */
            answer = { ok: false, reason: '宿主授权检查出错' }
          }
          if (!child.alive) return
          const decision =
            typeof answer === 'object' && answer !== null ? answer : undefined
          const granted = answer === true || decision?.ok === true
          child.send(
            authzInput
              ? {
                  type: 'extension_ui_response',
                  id: frame.id,
                  value: JSON.stringify(
                    granted
                      ? typeof decision?.value === 'string'
                        ? { ok: true, value: decision.value }
                        : { ok: true }
                      : {
                          ok: false,
                          reason: decision?.reason || '宿主拒绝了这次请求',
                        },
                  ),
                }
              : {
                  type: 'extension_ui_response',
                  id: frame.id,
                  confirmed: granted,
                },
          )
        })()
      }
      if (frame.type === 'agent_start') this.#busy.add(sessionId)
      if (frame.type === 'prompt_result') {
        if (frame.status === 'completed') completedAwaitingSettlement = true
        else if (
          frame.status === 'error' ||
          frame.status === 'failed' ||
          frame.status === 'aborted'
        )
          completedAwaitingSettlement = false
      }
      // Background runs have no prompt ticket, so their failures must also be
      // read from assistant events. agent_end can carry a final message that
      // was never streamed; read the last assistant, as RpcPromptResults does.
      const assistant =
        frame.type === 'message_end'
          ? frame.message
          : frame.type === 'agent_end' &&
              (frame.yielded ?? frame.isTerminal !== false) &&
              Array.isArray(frame.messages)
            ? (frame.messages as unknown[]).findLast(
                message => isRecord(message) && message.role === 'assistant',
              )
            : undefined
      if (
        (isRecord(assistant) &&
          assistant.role === 'assistant' &&
          (assistant.stopReason === 'error' ||
            assistant.stopReason === 'aborted')) ||
        (frame.type === 'response' &&
          frame.command === 'abort' &&
          frame.success === true) ||
        frame.type === 'rpc_frame_error'
      )
        completedAwaitingSettlement = false
      if (
        frame.type === 'session_settled' ||
        (frame.type === 'prompt_result' && frame.sessionSettled === true)
      ) {
        if (completedAwaitingSettlement) this.#completedTurn = true
        completedAwaitingSettlement = false
        this.#busy.delete(sessionId)
        this.#drainCapacity()
      }
      if (
        frame.type === 'agent_start' ||
        frame.type === 'session_settled' ||
        frame.type === 'prompt_result'
      ) {
        void Promise.resolve(
          this.#options.onActivity?.(this.#busy.size > 0),
        ).catch(error => this.#options.onError?.(error))
      }
      if (
        frame.type === 'host_tool_cancel' &&
        typeof frame.targetId === 'string'
      )
        videoCalls.get(frame.targetId)?.abort()
      if (frame.type === 'host_tool_call') {
        void (async () => {
          if (frame.toolName === VIDEO_TOOL.name) {
            const controller = new AbortController()
            const id = String(frame.id)
            videoCalls.set(id, controller)
            let result: VideoToolResult
            try {
              result = media.video
                ? await runVideoTool(
                    owner.cwd,
                    frame.arguments,
                    controller.signal,
                    status => {
                      if (child.alive && !controller.signal.aborted)
                        child.send({
                          type: 'host_tool_update',
                          id: frame.id,
                          partialResult: {
                            content: [
                              { type: 'text', text: `视频生成状态：${status}` },
                            ],
                          },
                        })
                    },
                    {
                      workspaces: this.#options.agents.map(agent => agent.cwd),
                    },
                  )
                : { ok: false as const, error: '视频路由未开启' }
            } finally {
              videoCalls.delete(id)
            }
            if (!child.alive || controller.signal.aborted) return
            child.send({
              type: 'host_tool_result',
              id: frame.id,
              isError: !result.ok,
              result: {
                content: [{ type: 'text', text: JSON.stringify(result) }],
              },
            })
            return
          }
          const outcome = await dispatchHostTool(
            this.#options,
            { agent: owner.agent, sessionId },
            String(frame.toolName),
            frame.arguments,
          )
          if (child.alive)
            child.send({
              type: 'host_tool_result',
              id: frame.id,
              ...(outcome.isError ? { isError: true } : {}),
              result: {
                content: [{ type: 'text', text: outcome.text }],
                ...(outcome.details === undefined
                  ? {}
                  : { details: outcome.details }),
              },
            })
        })().catch(error => {
          this.#options.onError?.(error)
          if (child.alive)
            child.send({
              type: 'host_tool_result',
              id: frame.id,
              isError: true,
              result: {
                content: [
                  {
                    type: 'text',
                    text: 'Resident host could not complete this tool',
                  },
                ],
              },
            })
        })
      }
    })
    const ended = (error?: unknown) => {
      if (
        this.#stopped ||
        this.#starting.has(sessionId) ||
        this.#children.get(sessionId) !== child
      )
        return
      this.#fail(
        error instanceof Error
          ? error
          : new Error('resident omp child exited unexpectedly'),
      )
    }
    void child.closed.then(() => ended(), ended)
    await child.initialize()
    await child.request('open_session', {
      sessionDir,
      ...(selection
        ? { provider: selection.provider, modelId: selection.modelId }
        : {}),
    })
    await child.request('set_host_tools', {
      tools,
    })
    return child
  }
  async isAccepted(sessionId: string, messageId: string): Promise<boolean> {
    const owner = this.#owner(sessionId)
    const dir = qianmoConfigPath('resident', 'sessions', owner.agent, sessionId)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue
      const users = new Set<string>()
      for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
        let entry: Record<string, unknown>
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        const message = entry.message as { role?: string } | undefined
        if (
          entry.type === 'message' &&
          message?.role === 'user' &&
          typeof entry.id === 'string'
        )
          users.add(entry.id)
        const data = entry.data as { userEntryId?: string } | undefined
        if (
          residentInputIdentityOf(entry) === messageId &&
          data?.userEntryId &&
          users.has(data.userEntryId)
        ) {
          // Flush the linked input before the host promises durable admission.
          const fd = openSync(join(dir, file), 'r')
          try {
            fsyncSync(fd)
          } finally {
            closeSync(fd)
          }
          return true
        }
      }
    }
    return false
  }
  closeSession(sessionId: string): void {
    const opening = this.#starting.get(sessionId)
    if (opening) {
      opening.cancelled = true
      this.#removeWaiter(sessionId, new Error('resident omp startup cancelled'))
    }
    const child = this.#children.get(sessionId)
    this.#children.delete(sessionId)
    this.#used.delete(sessionId)
    this.#recency.delete(sessionId)
    this.#busy.delete(sessionId)
    if (child) {
      this.#longestReadyMs = Math.max(
        this.#longestReadyMs,
        child.readyRuntimeMs,
      )
      const slot = this.#slots.get(sessionId)
      const retiring = child.stop(opening !== undefined).finally(() => {
        if (this.#retiring.get(sessionId) === retiring)
          this.#retiring.delete(sessionId)
        if (this.#slots.get(sessionId) === slot) this.#slots.delete(sessionId)
        this.#drainCapacity()
      })
      this.#retiring.set(sessionId, retiring)
      void retiring.catch(error => this.#options.onError?.(error))
    }
  }
  stop(): Promise<void> {
    this.#stopping ??= this.#stopAndReap()
    return this.#stopping
  }
  async #stopAndReap(): Promise<void> {
    this.#stopped = true
    clearInterval(this.#timer)
    this.#drainCapacity()
    // Children are registered before ready; terminate them before joining
    // startup, otherwise stopping waits on the very handshake it must cancel.
    for (const sessionId of this.#children.keys()) this.closeSession(sessionId)

    await Promise.allSettled(
      [...this.#starting.values()].map(opening => opening.promise),
    )
    await Promise.allSettled([...this.#retiring.values()])
    this.#resolve()
  }
}
