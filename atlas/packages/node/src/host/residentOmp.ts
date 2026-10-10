// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

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
import { qianmoConfigPath } from '@qianmo/paths'
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
import { nodeModelSelection } from '../providers/node.js'
import { residentOmpEnvironment } from './residentOmpEnv.js'
import { residentToolSurface, verdictText } from './notifyTool.js'
import { parseNotifyVerdict } from './notifyWire.js'
import { residentExtensionPath } from './residentExtension.js'

export interface ResidentOmpSpawn {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
  readonly sessionId: string
  readonly sessionDir: string
  readonly agent: string
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

  constructor(child: ChildProcess) {
    this.child = child
    if (child.stdin === null || child.stdout === null)
      throw new Error('omp RPC requires piped stdin/stdout')
    // A parse/pipe error makes the RPC channel unusable, but is not exit
    // evidence. Never release a generation's teardown until `close` confirms
    // the actual process and its stdio are gone, including failed spawns.
    this.#reaped = new Promise(resolve => child.once('close', () => resolve()))
    let readyResolve!: (frame: OmpRpcFrame) => void
    let readyReject!: (error: Error) => void
    this.#ready = new Promise((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    void this.#ready.catch(() => {})
    const decoder = new RpcFrameDecoder()
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    const readyTimeout = setTimeout(() => {
      readyReject(new Error('omp RPC ready timed out'))
      child.kill('SIGTERM')
    }, 30_000)
    this.closed = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (!this.#alive) return
        this.#alive = false
        clearTimeout(readyTimeout)
        lines.close()
        const reason = error ?? new Error('omp RPC child closed')
        readyReject(reason)
        for (const pending of this.#pending.values()) pending.reject(reason)
        this.#pending.clear()
        if (this.#intentional || error === undefined) resolve()
        else reject(error)
      }
      child.once('error', finish)
      child.once('exit', (code, signal) =>
        finish(
          code === 0
            ? undefined
            : new Error(`omp RPC child exited code=${code} signal=${signal}`),
        ),
      )
      child.stdin?.on('error', finish)
      lines.on('line', line => {
        try {
          const decoded = decoder.push(JSON.parse(line))
          if (decoded === undefined) return
          const frame = decoded as OmpRpcFrame
          if (frame.type === 'ready') {
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
          for (const listener of this.#listeners) listener(frame)
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
          child.kill('SIGTERM')
        }
      })
    })
    void this.closed.catch(() => {})
  }

  get alive(): boolean {
    return (
      this.#alive &&
      !this.child.killed &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    )
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
  ): Promise<OmpRpcFrame> {
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
    return await response
  }
  async prompt(input: {
    messageId: string
    text: string
  }): Promise<OmpPromptAdmission> {
    const local =
      /^\/(compact|context|model|thinking|effort|autocompact)(?:\s+(.*))?\s*$/s.exec(
        input.text,
      )
    if (local !== null) {
      const argument = local[2]?.trim()
      const command = local[1]
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
      else if (command === 'model' && argument) {
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
    }
    const response = await this.request('prompt', {
      message: markResidentInput(input.messageId, input.text),
    })
    const data = response.data as { agentInvoked?: boolean } | undefined
    return {
      requestId: String(response.id),
      agentInvoked: data?.agentInvoked !== false,
    }
  }
  async abort(): Promise<void> {
    await this.request('abort')
  }
  stop(): Promise<void> {
    this.#stopping ??= this.#stopAndReap()
    return this.#stopping
  }
  async #stopAndReap(): Promise<void> {
    this.#intentional = true
    const signal = (name: NodeJS.Signals) => {
      try {
        this.child.kill(name)
      } catch {
        // Failure to send a signal is not proof of exit. Keep waiting for
        // close; an unknown process lifetime cannot open the next generation.
      }
    }
    try {
      this.child.stdin?.end()
    } catch {
      signal('SIGTERM')
    }
    const terminate = setTimeout(() => signal('SIGTERM'), 1_000)
    const kill = setTimeout(() => signal('SIGKILL'), 2_000)
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

interface PoolOptions {
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
  ) => Promise<boolean>
}

/** Every live (agent, context) session has its own isolated omp process. */
export class ResidentOmpPool
  implements ResidentSessionConnection, OmpTurnRouter
{
  readonly closed: Promise<void>
  readonly #options: PoolOptions
  readonly #children = new Map<string, OmpRpcProcess>()
  readonly #retiring = new Map<string, Promise<void>>()
  readonly #starting = new Map<string, Promise<OmpRpcProcess>>()
  readonly #owners = new Map<string, ResidentAgentSession>()
  readonly #busy = new Set<string>()
  readonly #used = new Map<string, number>()
  readonly #timer: ReturnType<typeof setInterval>
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
    const idle = options.idleChildMs ?? 10 * 60_000
    this.#timer = setInterval(
      () => {
        for (const [id, last] of this.#used) {
          if (!this.#busy.has(id) && Date.now() - last >= idle)
            this.closeSession(id)
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
      [...this.#children.values()].every(child => child.alive)
    )
  }
  async initialize(): Promise<void> {}
  async newSession(input: ResidentAgentSession): Promise<string> {
    const sessionId = randomUUID()
    await this.resumeSession({ ...input, sessionId })
    return sessionId
  }
  async resumeSession(
    input: ResidentAgentSession & { sessionId: string },
  ): Promise<void> {
    this.#owners.set(input.sessionId, input)
    await this.channelFor(input.sessionId)
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
  async channelFor(sessionId: string): Promise<OmpRpcProcess> {
    // An idle session may be resumed while its previous process is still
    // retiring. It must not spawn a second writer for the same session.
    const retiring = this.#retiring.get(sessionId)
    if (retiring) await retiring
    if (this.#stopped || this.#failed)
      throw new Error('resident omp pool is closed')
    this.#used.set(sessionId, Date.now())
    const existing = this.#children.get(sessionId)
    if (existing?.alive) return existing
    let opening = this.#starting.get(sessionId)
    if (!opening) {
      opening = this.#open(sessionId)
      this.#starting.set(sessionId, opening)
      void opening
        .finally(() => this.#starting.delete(sessionId))
        .catch(() => {})
    }
    return await opening
  }
  async #open(sessionId: string): Promise<OmpRpcProcess> {
    const owner = this.#owner(sessionId)
    const sessionDir = qianmoConfigPath(
      'resident',
      'sessions',
      owner.agent,
      sessionId,
    )
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
    const config: ResidentExtensionConfig = {
      v: 1,
      agent: owner.agent,
      workspace: owner.cwd,
      edits: this.#options.allowWorkspaceEdits ? 'workspace' : 'none',
      protectedRoots: [
        this.#options.memoryRoot,
        ...(this.#options.protectedRoots ?? []),
      ],
      hostTools: residentToolSurface(
        this.#options.memoryWrite !== undefined,
      ).map(tool => tool.name),
      ...(this.#options.requestPermission === undefined
        ? {}
        : { approvals: true }),
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
    const selection = nodeModelSelection()
    const argv = ompArgv([
      '--mode',
      'rpc',
      ...(this.#options.requestPermission === undefined ? ['--no-ui'] : []),
      '--no-extensions',
      '--extension',
      residentExtensionPath(sessionDir),
      '--config',
      overlay,
      '--approval-mode',
      config.edits === 'workspace' ? 'write' : 'always-ask',
      '--tools',
      residentActiveTools(config.edits).join(','),
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
          stdio: ['pipe', 'pipe', 'inherit'],
        }),
    )
    this.#children.set(sessionId, child)
    child.onFrame(frame => {
      this.#used.set(sessionId, Date.now())
      if (frame.type === 'extension_ui_request' && frame.method === 'confirm') {
        void (async () => {
          let confirmed = false
          try {
            if (
              frame.title === 'QIANMO_AUTHZ_V1' &&
              typeof frame.message === 'string'
            )
              confirmed =
                (await this.#options.requestPermission?.(
                  sessionId,
                  JSON.parse(frame.message),
                )) ?? false
          } catch {
            /* Any missing, stale, malformed or unavailable authorization denies. */
          }
          if (child.alive)
            child.send({
              type: 'extension_ui_response',
              id: frame.id,
              confirmed,
            })
        })()
      }
      if (frame.type === 'agent_start') this.#busy.add(sessionId)
      else if (
        frame.type === 'session_settled' ||
        (frame.type === 'prompt_result' && frame.sessionSettled === true)
      )
        this.#busy.delete(sessionId)
      if (
        frame.type === 'agent_start' ||
        frame.type === 'session_settled' ||
        frame.type === 'prompt_result'
      ) {
        void Promise.resolve(
          this.#options.onActivity?.(this.#busy.size > 0),
        ).catch(error => this.#options.onError?.(error))
      }
      if (frame.type === 'host_tool_call') {
        void (async () => {
          if (frame.toolName === 'qianmo_memory_write') {
            const result = (await this.#options.memoryWrite?.(
              sessionId,
              frame.arguments,
            )) ?? { ok: false, text: 'Memory writer is not enabled' }
            child.send({
              type: 'host_tool_result',
              id: frame.id,
              isError: !result.ok,
              result: { content: [{ type: 'text', text: result.text }] },
            })
            return
          }
          if (frame.toolName === 'qianmo_memory_answer') {
            const answer = this.#options.memoryAnswer?.(
              sessionId,
              frame.arguments,
            ) ?? { ok: false, text: 'Memory answer host unavailable' }
            child.send({
              type: 'host_tool_result',
              id: frame.id,
              isError: !answer.ok,
              result: { content: [{ type: 'text', text: answer.text }] },
            })
            return
          }
          const verdict =
            frame.toolName === 'qianmo_notify'
              ? parseNotifyVerdict(
                  await this.#options.announce({
                    ...(frame.arguments as Record<string, unknown>),
                    sessionId,
                  }),
                )
              : {
                  status: 'rejected' as const,
                  detail: 'unknown resident host tool',
                }
          child.send({
            type: 'host_tool_result',
            id: frame.id,
            result: {
              content: [{ type: 'text', text: verdictText(verdict) }],
              details: verdict,
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
      if (this.#stopped || this.#children.get(sessionId) !== child) return
      this.#failed = true
      this.#reject(
        error instanceof Error
          ? error
          : new Error('resident omp child exited unexpectedly'),
      )
    }
    void child.closed.then(() => ended(), ended)
    try {
      await child.initialize()
      await child.request('open_session', {
        sessionDir,
        ...(selection
          ? { provider: selection.provider, modelId: selection.modelId }
          : {}),
      })
      await child.request('set_host_tools', {
        tools: residentToolSurface(this.#options.memoryWrite !== undefined),
      })
      return child
    } catch (error) {
      this.closeSession(sessionId)
      throw error
    }
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
    const child = this.#children.get(sessionId)
    this.#children.delete(sessionId)
    this.#used.delete(sessionId)
    this.#busy.delete(sessionId)
    if (child) {
      const retiring = child.stop().finally(() => {
        if (this.#retiring.get(sessionId) === retiring)
          this.#retiring.delete(sessionId)
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
    await Promise.allSettled([...this.#starting.values()])
    for (const sessionId of this.#children.keys()) this.closeSession(sessionId)
    await Promise.allSettled([...this.#retiring.values()])
    this.#resolve()
  }
}
