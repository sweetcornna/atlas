// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { qianmoConfigPath } from '@qianmo/paths'
import {
  residentApprovalInput,
  residentToolVerdict,
  type ResidentExtensionConfig,
} from '@qianmo/extension/policy'
import type {
  OmpRpcFrame,
  ResidentAgentSession,
  ResidentSessionConnection,
} from '@qianmo/resident'
import { qmArgv } from '../../omp/launch.js'
import {
  dispatchHostTool,
  type HostToolDispatchOptions,
} from '../hostToolDispatch.js'
import { residentToolSurface } from '../notifyTool.js'
import type { ResidentPermission } from '../residentOmp.js'
import { AcpChannel, type AcpMcpServer, acpVerdictCalls } from './acp.js'
import type { AcpRuntime, AcpToolCall } from './acpSpec.js'
import { type RuntimeLane, runtimeSpec } from './catalog.js'
import type { ExternalRuntimeChannel, ExternalRuntimeKind } from './channel.js'
import {
  CLAUDE_CODE_ENV,
  ClaudeCodeChannel,
  claudeCodeArgv,
  claudeCodeToolName,
  PERMISSION_TOOL,
  RUNTIME_MCP_SERVER,
} from './claudeCode.js'
import { CODEX_KEY_ENV, CodexChannel, codexArgv } from './codex.js'
import {
  RuntimeToolHost,
  type RuntimeToolResult,
  type RuntimeToolSession,
  type RuntimeToolSpec,
} from './toolHost.js'
import type { AgentExtensionsSource, AgentMcpServer } from '../extensions.js'
import {
  RuntimeDesktopTools,
  type RuntimeDesktopSource,
} from './desktopTools.js'
import { runtimeBin } from '../runtimeUpdate.js'
import { inheritedEnv } from './inheritedEnv.js'
import { runWorkspaceTool, WORKSPACE_TOOLS } from './workspaceTools.js'

/** A resident agent that runs on an external runtime (a catalog id). */
export interface ExternalAgent extends ResidentAgentSession {
  readonly runtime: ExternalRuntimeKind
  /**
   * Shell access: Codex runs commands inside its own sandbox (no network,
   * writes confined by `--allow-workspace-edits`); Claude Code's `Bash`
   * asks the operator for every command. Off by default.
   */
  readonly shell?: boolean
}

/** The model and credentials one agent's runtime starts with. */
export interface ExternalLaunch {
  readonly model: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly headers?: Readonly<Record<string, string>>
  readonly effort?: string
  /**
   * The lane `baseUrl` speaks (P36). Claude Code and Codex have one each;
   * an ACP runtime absent it takes its first catalog lane.
   */
  readonly lane?: RuntimeLane
  /** The model's context window and output ceiling, when known. */
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
}

export interface ExternalRuntimeSpawn {
  readonly kind: ExternalRuntimeKind
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
  readonly agent: string
  readonly sessionId: string
  readonly sessionDir: string
}

export interface ExternalRuntimePoolOptions {
  readonly agents: readonly ExternalAgent[]
  /**
   * The runtime `agent` runs on now (a catalog id), read each time one of
   * its processes starts; absent: `ExternalAgent.runtime`. A session whose
   * native conversation is on another runtime starts a new one there.
   */
  readonly runtimeOf?: (agent: string) => string
  /** Called with the agent as it runs now (`runtime` is the one starting). */
  readonly resolveLaunch: (agent: ExternalAgent) => ExternalLaunch
  readonly bins?: Partial<Record<ExternalRuntimeKind, string>>
  readonly memoryRoot: string
  readonly protectedRoots?: readonly string[]
  readonly allowWorkspaceEdits?: boolean
  readonly hostTools: HostToolDispatchOptions
  readonly requestPermission?: (
    sessionId: string,
    call: {
      readonly toolName: string
      readonly input: Readonly<Record<string, unknown>>
    },
  ) => Promise<ResidentPermission>
  /** The appended system prompt, frozen per session on its first launch. */
  readonly systemPrompt?: (agent: ExternalAgent) => string
  readonly spawn?: (input: ExternalRuntimeSpawn) => ChildProcess
  /** How the runtime starts `qm runtime-mcp`; tests point it elsewhere. */
  readonly mcpArgv?: (args: readonly string[]) => string[]
  readonly idleChildMs?: number
  readonly maxChildren?: number
  /** Operator-configured MCP servers, skills and plugins (P32). */
  readonly extensions?: AgentExtensionsSource
  /** The private browser and computer (P21+), when the node has them. */
  readonly desktop?: RuntimeDesktopSource
  /** How the host starts `qm desktop-exec`; tests point it elsewhere. */
  readonly desktopArgv?: (args: readonly string[]) => string[]
  readonly onActivity?: (active: boolean) => void | Promise<void>
  readonly onError?: (error: unknown) => void
}

interface SessionRecord {
  readonly kind: ExternalRuntimeKind
  /** Claude Code conversation id or Codex thread id. */
  nativeId?: string
  /** Claude Code: the conversation has a transcript to resume. */
  started?: boolean
}

const DEFAULT_IDLE_MS = 600_000
const CAPACITY_WAIT_MS = 30_000
const SESSION_ID = /^[a-zA-Z0-9_-]+$/

export function defaultExternalSystemPrompt(agent: ExternalAgent): string {
  return [
    `You are "${agent.agent}", a resident agent on a Qianmo AgentNest node. Messages reach you from the Qianmo network: the operator's console, chat channels, schedules and other agents.`,
    `Your workspace is ${agent.cwd}. Stay inside it.`,
    agent.shell
      ? 'You may run shell commands; they run sandboxed or need operator approval.'
      : agent.runtime === 'codex'
        ? 'You have no shell. Read the workspace with qianmo_read_file, qianmo_list_files and qianmo_search.'
        : runtimeSpec(agent.runtime)?.protocol === 'acp'
          ? 'You have no shell: shell commands are refused. Read the workspace with your read, grep and glob tools.'
          : 'You have no shell. Read the workspace with Read, Grep and Glob.',
    'Tools named qianmo_* act through this node: notify the operator, remember, delegate background tasks to other agents, use authorized connections, and drive your private browser and computer when the operator has switched them on.',
  ].join('\n')
}

function headerLines(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}

/** Codex without a shell reads the workspace through the host's tools. */
function codexReadsByHost(agent: ExternalAgent): boolean {
  return agent.runtime === 'codex' && agent.shell !== true
}

/** A refusal as Claude Code shows it to the model, prefixed once. */
function postureMessage(reason = 'refused'): string {
  return reason.startsWith(POSTURE) ? reason : `${POSTURE} ${reason}`
}
const POSTURE = 'Qianmo resident posture:'

/** Whether `path` is `root` or inside it (lexically). */
function within(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** ACP harnesses take only absolute MCP commands. */
function absoluteCommand(command: string): string {
  return isAbsolute(command) ? command : (Bun.which(command) ?? command)
}

function verdictCall(
  toolName: string,
  input: Record<string, unknown>,
): { toolName: string; input: Record<string, unknown> } {
  const name = claudeCodeToolName(toolName)
  const path =
    typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.notebook_path === 'string'
        ? input.notebook_path
        : undefined
  if (name === 'TodoWrite') return { toolName: 'todo', input }
  return {
    toolName: name,
    input: path === undefined ? input : { ...input, path },
  }
}

/**
 * Resident sessions on Claude Code or Codex: one live process per active
 * session, reused across turns (warm), reaped when idle, and resumed by the
 * runtime's own conversation id after a restart.
 */
export class ExternalRuntimePool implements ResidentSessionConnection {
  readonly #options: ExternalRuntimePoolOptions
  readonly #agents: Map<string, ExternalAgent>
  readonly #owners = new Map<string, ExternalAgent>()
  readonly #channels = new Map<string, ExternalRuntimeChannel>()
  /** Each live process's agent, on the runtime it was started on. */
  readonly #running = new Map<string, ExternalAgent>()
  readonly #starting = new Map<string, Promise<ExternalRuntimeChannel>>()
  readonly #tokens = new Map<string, string>()
  readonly #used = new Map<string, number>()
  /** Turns holding a session's channel (their acquisition signal is live). */
  readonly #leases = new Map<string, number>()
  /** Bumped by {@link invalidateAgent}; a channel started before is stale. */
  readonly #epochs = new Map<string, number>()
  readonly #channelEpochs = new WeakMap<ExternalRuntimeChannel, number>()
  readonly #toolHost: RuntimeToolHost
  readonly #desktop: RuntimeDesktopTools | undefined
  readonly #timer: Timer
  #completedTurn = false
  #longestReadyMs = 0
  #stopped = false
  #hostStarted: Promise<void> | undefined

  constructor(options: ExternalRuntimePoolOptions) {
    this.#options = options
    this.#agents = new Map(options.agents.map(agent => [agent.agent, agent]))
    this.#toolHost = new RuntimeToolHost({
      list: session => this.#toolList(session),
      call: (session, name, args) => this.#callTool(session, name, args),
      onError: options.onError,
    })
    this.#desktop =
      options.desktop === undefined
        ? undefined
        : new RuntimeDesktopTools({
            desktop: options.desktop,
            permission: async (sessionId, call) =>
              (await options.requestPermission?.(sessionId, call)) ?? false,
            ...(options.desktopArgv === undefined
              ? {}
              : { argv: options.desktopArgv }),
            ...(options.onError === undefined
              ? {}
              : { onError: options.onError }),
          })
    const idle = options.idleChildMs ?? DEFAULT_IDLE_MS
    this.#timer = setInterval(
      () => {
        const now = Date.now()
        for (const [id, channel] of this.#channels) {
          if (!channel.busy && now - (this.#used.get(id) ?? now) >= idle)
            this.closeSession(id)
          else this.#retireIfStale(id)
        }
      },
      Math.min(idle, 60_000),
    )
    this.#timer.unref()
    // A Claude Code MCP config left behind by a process that is gone holds
    // the agent's MCP secrets for nothing.
    for (const agent of options.agents) this.#sweepMcpConfigs(agent.agent)
  }

  get alive(): boolean {
    return !this.#stopped
  }
  isStable(stableAfterMs: number): boolean {
    return (
      this.#completedTurn ||
      this.#longestReadyMs >= stableAfterMs ||
      [...this.#channels.values()].some(
        channel => channel.readyRuntimeMs >= stableAfterMs,
      )
    )
  }
  /** Whether `agent` runs on an external runtime in this pool. */
  hasAgent(agent: string): boolean {
    return this.#agents.has(agent)
  }

  async initialize(): Promise<void> {
    if (this.#stopped) throw new Error('external runtime pool is closed')
    this.#hostStarted ??= this.#toolHost.start()
    await this.#hostStarted
  }
  async newSession(input: ResidentAgentSession): Promise<string> {
    const sessionId = randomUUID()
    await this.resumeSession({ ...input, sessionId })
    return sessionId
  }
  async resumeSession(
    input: ResidentAgentSession & { sessionId: string },
  ): Promise<void> {
    const agent = this.#agents.get(input.agent)
    if (agent === undefined)
      throw new Error(`${input.agent} does not run on an external runtime`)
    if (!SESSION_ID.test(input.sessionId))
      throw new Error('invalid resident session id')
    this.#owners.set(input.sessionId, agent)
    mkdirSync(this.#sessionDir(agent.agent, input.sessionId), {
      recursive: true,
      mode: 0o700,
    })
  }

  /** The agent a session belongs to, from memory or its directory on disk. */
  owner(sessionId: string): ExternalAgent | undefined {
    if (!SESSION_ID.test(sessionId)) return undefined
    const known = this.#owners.get(sessionId)
    if (known) return known
    for (const agent of this.#agents.values()) {
      if (existsSync(this.#sessionDir(agent.agent, sessionId))) {
        this.#owners.set(sessionId, agent)
        return agent
      }
    }
    return undefined
  }

  #sessionDir(agent: string, sessionId: string): string {
    return qianmoConfigPath('resident', 'sessions', agent, sessionId)
  }

  /** The runtime `agent`'s next process starts on. */
  #runtimeOf(agent: ExternalAgent): string {
    return this.#options.runtimeOf?.(agent.agent) ?? agent.runtime
  }

  async channelFor(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ExternalRuntimeChannel> {
    if (this.#stopped) throw new Error('external runtime pool is closed')
    signal?.throwIfAborted()
    const agent = this.owner(sessionId)
    if (agent === undefined)
      throw new Error(`resident session ${sessionId} has no configured owner`)
    this.#used.set(sessionId, Date.now())
    if (signal !== undefined) this.#lease(sessionId, signal)
    const live = this.#channels.get(sessionId)
    // A stale channel nobody else holds is replaced before this turn.
    if (
      live?.alive &&
      this.#stale(sessionId, live) &&
      !live.busy &&
      (this.#leases.get(sessionId) ?? 0) <= (signal === undefined ? 0 : 1)
    ) {
      this.closeSession(sessionId)
      // Closing forgot the session's last use; this turn is one, and the
      // idle reaper needs it to ever close the replacement.
      this.#used.set(sessionId, Date.now())
      await live.stop().catch(() => {})
    } else if (live?.alive) return live
    let starting = this.#starting.get(sessionId)
    if (starting === undefined) {
      starting = (async () => {
        await this.initialize()
        await this.#claimCapacity(sessionId)
        return this.#spawn(agent, sessionId)
      })()
      this.#starting.set(sessionId, starting)
      void starting.then(
        () => this.#starting.delete(sessionId),
        () => this.#starting.delete(sessionId),
      )
    }
    const channel = await starting
    signal?.throwIfAborted()
    return channel
  }

  /** Holds `sessionId`'s channel until `signal` aborts (the turn's end). */
  #lease(sessionId: string, signal: AbortSignal): void {
    if (signal.aborted) return
    this.#leases.set(sessionId, (this.#leases.get(sessionId) ?? 0) + 1)
    signal.addEventListener(
      'abort',
      () => {
        const left = (this.#leases.get(sessionId) ?? 1) - 1
        if (left > 0) this.#leases.set(sessionId, left)
        else {
          this.#leases.delete(sessionId)
          this.#retireIfStale(sessionId)
        }
      },
      { once: true },
    )
  }

  #stale(sessionId: string, channel: ExternalRuntimeChannel): boolean {
    const agent = this.#owners.get(sessionId)?.agent
    if (agent === undefined) return false
    return (
      (this.#channelEpochs.get(channel) ?? 0) < (this.#epochs.get(agent) ?? 0)
    )
  }

  /** Closes a stale channel that no turn is using. */
  #retireIfStale(sessionId: string): boolean {
    const channel = this.#channels.get(sessionId)
    if (
      channel === undefined ||
      channel.busy ||
      this.#leases.has(sessionId) ||
      !this.#stale(sessionId, channel)
    )
      return false
    this.closeSession(sessionId)
    return true
  }

  #mcpConfig(agent: string, sessionId: string): string {
    return join(this.#sessionDir(agent, sessionId), 'runtime-mcp.json')
  }
  /** An ACP process's launch files (its patch, config with headers). */
  #launchDir(agent: string, sessionId: string): string {
    return join(this.#sessionDir(agent, sessionId), 'runtime-launch')
  }
  /** What a process had written for it that can carry secrets. */
  #removeLaunchFiles(agent: string, sessionId: string): void {
    rmSync(this.#mcpConfig(agent, sessionId), { force: true })
    rmSync(this.#launchDir(agent, sessionId), { recursive: true, force: true })
  }

  /**
   * Removes the MCP configs and launch files of `agent`'s sessions with no
   * process.
   */
  #sweepMcpConfigs(agent: string): void {
    let ids: string[]
    try {
      ids = readdirSync(qianmoConfigPath('resident', 'sessions', agent))
    } catch {
      return
    }
    for (const id of ids) {
      if (!SESSION_ID.test(id) || this.#channels.has(id)) continue
      if (this.#starting.has(id)) continue
      this.#removeLaunchFiles(agent, id)
    }
  }

  async #claimCapacity(sessionId: string): Promise<void> {
    const max = this.#options.maxChildren
    if (max === undefined) return
    const deadline = Date.now() + CAPACITY_WAIT_MS
    while (this.#channels.size >= max) {
      const idle = [...this.#channels]
        .filter(([id, channel]) => id !== sessionId && !channel.busy)
        .sort(
          ([a], [b]) => (this.#used.get(a) ?? 0) - (this.#used.get(b) ?? 0),
        )[0]
      if (idle !== undefined) {
        this.closeSession(idle[0])
        continue
      }
      if (Date.now() >= deadline)
        throw new Error('external runtime capacity is exhausted')
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  #record(dir: string, kind: ExternalRuntimeKind): SessionRecord {
    try {
      const raw = JSON.parse(
        readFileSync(join(dir, 'runtime.json'), 'utf8'),
      ) as SessionRecord
      if (raw.kind === kind) return raw
      // The session moved to another runtime: a new native conversation,
      // with the instructions of the runtime it runs on now.
      rmSync(join(dir, 'runtime-system.txt'), { force: true })
    } catch {
      // A first launch: start fresh.
    }
    return { kind }
  }
  #saveRecord(dir: string, record: SessionRecord): void {
    writeFileSync(join(dir, 'runtime.json'), JSON.stringify(record), {
      mode: 0o600,
    })
  }
  /** The frozen appended system prompt (P30): written once, then reused. */
  #systemPrompt(dir: string, agent: ExternalAgent): string {
    const path = join(dir, 'runtime-system.txt')
    try {
      return readFileSync(path, 'utf8')
    } catch {
      const text = (this.#options.systemPrompt ?? defaultExternalSystemPrompt)(
        agent,
      )
      writeFileSync(path, text, { mode: 0o600 })
      return text
    }
  }

  async #spawn(
    agent: ExternalAgent,
    sessionId: string,
  ): Promise<ExternalRuntimeChannel> {
    const dir = this.#sessionDir(agent.agent, sessionId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // Read before the configuration: an invalidation from here on is newer.
    const epoch = this.#epochs.get(agent.agent) ?? 0
    const runtime = this.#runtimeOf(agent)
    const spec = runtimeSpec(runtime)
    if (spec === undefined || spec.protocol === 'omp')
      throw new Error(
        `${agent.agent} runs on ${runtime}, which is not an external runtime`,
      )
    // The agent as it runs now: its launch, prompt and tools follow this
    // runtime, whatever it was configured with when the pool started.
    const running: ExternalAgent =
      agent.runtime === runtime ? agent : { ...agent, runtime }
    const launch = this.#options.resolveLaunch(running)
    const record = this.#record(dir, runtime)
    const systemPrompt = this.#systemPrompt(dir, running)
    const token = this.#toolHost.issue({ agent: agent.agent, sessionId })
    const tokenFile = join(dir, 'runtime-mcp.token')
    writeFileSync(tokenFile, token, { mode: 0o600 })
    const mcp = (this.#options.mcpArgv ?? qmArgv)([
      'runtime-mcp',
      '--port',
      String(this.#toolHost.port),
      '--token-file',
      tokenFile,
    ])
    // The node's environment stays with the node; credentials are added.
    const env = inheritedEnv()
    const ledger = join(dir, 'runtime-inputs.ndjson')
    const onAdmitted = (messageId: string) => {
      try {
        appendFileSync(ledger, `${JSON.stringify({ messageId })}\n`, {
          mode: 0o600,
        })
      } catch (error) {
        this.#options.onError?.(error)
      }
    }
    let argv: string[]
    let cwd = agent.cwd
    let open: (child: ChildProcess) => ExternalRuntimeChannel
    const extensions = this.#options.extensions?.(agent.agent) ?? null
    switch (spec.protocol) {
      case 'claude-stream': {
        const home = qianmoConfigPath('runtimes', 'claude-code', agent.agent)
        mkdirSync(home, { recursive: true, mode: 0o700 })
        const mcpConfig = join(dir, 'runtime-mcp.json')
        writeFileSync(
          mcpConfig,
          JSON.stringify({
            mcpServers: {
              ...Object.fromEntries(
                (extensions?.mcp ?? []).map(server => [
                  server.name,
                  server.transport === 'stdio'
                    ? {
                        type: 'stdio',
                        command: server.command ?? '',
                        args: server.args ?? [],
                        // Claude Code passes its own environment on; the
                        // agent's model key is not the server's business.
                        env: {
                          ANTHROPIC_API_KEY: '',
                          ANTHROPIC_CUSTOM_HEADERS: '',
                          ...server.env,
                        },
                      }
                    : {
                        type: server.transport,
                        url: server.url ?? '',
                        headers: server.headers ?? {},
                      },
                ]),
              ),
              [RUNTIME_MCP_SERVER]: {
                type: 'stdio',
                command: mcp[0],
                args: mcp.slice(1),
              },
            },
          }),
          { mode: 0o600 },
        )
        if (record.nativeId === undefined) {
          record.nativeId = randomUUID()
          record.started = false
          this.#saveRecord(dir, record)
        }
        argv = claudeCodeArgv({
          bin: runtimeBin('claude-code', this.#options.bins),
          model: launch.model,
          sessionId: record.nativeId,
          resume: record.started === true,
          systemPrompt,
          mcpConfigPath: mcpConfig,
          allowWorkspaceEdits: this.#options.allowWorkspaceEdits === true,
          ...(agent.shell ? { shell: true } : {}),
          ...(launch.effort ? { effort: launch.effort } : {}),
          ...(extensions === null
            ? {}
            : {
                pluginDirs: extensions.claudePluginDirs,
                allowedMcpServers: extensions.mcp
                  .filter(server => server.approval === 'allow')
                  .map(server => server.name),
              }),
        })
        Object.assign(env, {
          ...CLAUDE_CODE_ENV,
          CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_API_KEY: launch.apiKey,
          ANTHROPIC_BASE_URL: launch.baseUrl,
          ...(launch.headers && Object.keys(launch.headers).length > 0
            ? { ANTHROPIC_CUSTOM_HEADERS: headerLines(launch.headers) }
            : {}),
        })
        open = child =>
          new ClaudeCodeChannel(child, {
            onAdmitted,
            onSessionStarted: () => {
              if (record.started) return
              record.started = true
              this.#saveRecord(dir, record)
            },
          })
        break
      }
      case 'codex-app-server': {
        const home = qianmoConfigPath('runtimes', 'codex', agent.agent)
        mkdirSync(home, { recursive: true, mode: 0o700 })
        argv = codexArgv({
          bin: runtimeBin('codex', this.#options.bins),
          model: launch.model,
          baseUrl: launch.baseUrl,
          keyEnv: CODEX_KEY_ENV,
          ...(launch.headers ? { headers: launch.headers } : {}),
          mcp: { command: mcp[0]!, args: mcp.slice(1) },
          ...(launch.effort ? { effort: launch.effort } : {}),
          ...(agent.shell ? { shell: true } : {}),
        })
        Object.assign(env, { CODEX_HOME: home, [CODEX_KEY_ENV]: launch.apiKey })
        open = child =>
          new CodexChannel(child, {
            onAdmitted,
            cwd: agent.cwd,
            developerInstructions: systemPrompt,
            allowWorkspaceEdits: this.#options.allowWorkspaceEdits === true,
            ...(record.nativeId === undefined
              ? {}
              : { threadId: record.nativeId }),
            onThread: threadId => {
              if (record.nativeId === threadId) return
              record.nativeId = threadId
              this.#saveRecord(dir, record)
            },
            permission: call => this.#codexPermission(agent, sessionId, call),
          })
        break
      }
      case 'acp': {
        const acp = spec.acp
        if (acp === undefined)
          throw new Error(`${spec.label} has no ACP launch in the catalog`)
        const home = qianmoConfigPath('runtimes', runtime, agent.agent)
        mkdirSync(home, { recursive: true, mode: 0o700 })
        const runDir = this.#launchDir(agent.agent, sessionId)
        rmSync(runDir, { recursive: true, force: true })
        mkdirSync(runDir, { recursive: true, mode: 0o700 })
        const lane = launch.lane ?? spec.lanes[0]
        if (lane === undefined)
          throw new Error(`${spec.label} has no model lane`)
        const plan = acp.launch({
          bin: runtimeBin(runtime, this.#options.bins),
          model: launch.model,
          lane,
          baseUrl: launch.baseUrl,
          apiKey: launch.apiKey,
          ...(launch.headers ? { headers: launch.headers } : {}),
          ...(launch.effort ? { effort: launch.effort } : {}),
          ...(launch.contextWindow === undefined
            ? {}
            : { contextWindow: launch.contextWindow }),
          ...(launch.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: launch.maxOutputTokens }),
          home,
          runDir,
          cwd: agent.cwd,
        })
        for (const path of [
          ...(plan.dirs ?? []),
          ...(plan.cwd === undefined ? [] : [plan.cwd]),
        ])
          mkdirSync(path, { recursive: true, mode: 0o700 })
        for (const file of plan.files ?? []) {
          if (!within(file.path, runDir) && !within(file.path, home))
            throw new Error(
              `${spec.label} would write a launch file outside its directories: ${file.path}`,
            )
          mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 })
          writeFileSync(file.path, file.content, { mode: 0o600 })
          chmodSync(file.path, 0o600)
        }
        argv = [...plan.argv]
        Object.assign(env, plan.env)
        cwd = plan.cwd ?? agent.cwd
        const servers: AcpMcpServer[] = [
          {
            name: RUNTIME_MCP_SERVER,
            command: absoluteCommand(mcp[0]!),
            args: mcp.slice(1),
            env: [],
          },
          ...(extensions?.mcp ?? []).map(server => this.#acpMcpServer(server)),
        ]
        const usage = acp.usage
        open = child =>
          new AcpChannel(child, {
            onAdmitted,
            label: spec.label,
            runtime: acp,
            cwd: agent.cwd,
            mcpServers: servers,
            ...(record.nativeId === undefined
              ? {}
              : { sessionId: record.nativeId }),
            onSession: id => {
              if (record.nativeId === id) return
              record.nativeId = id
              this.#saveRecord(dir, record)
            },
            instructions: systemPrompt,
            ...(launch.effort ? { effort: launch.effort } : {}),
            permission: call =>
              this.#acpPermission(running, sessionId, acp, call),
            ...(usage === undefined
              ? {}
              : {
                  usage: (id: string) =>
                    usage({ home, cwd: agent.cwd, sessionId: id }),
                }),
            onMcpSkipped: names =>
              this.#options.onError?.(
                new Error(
                  `${spec.label} does not take the transport of MCP servers ${names.join(', ')}`,
                ),
              ),
            ...(this.#options.onError === undefined
              ? {}
              : { onError: this.#options.onError }),
          })
        break
      }
      default:
        throw new Error(`${spec.label} has no channel on this node`)
    }
    const spawnInput: ExternalRuntimeSpawn = {
      kind: runtime,
      argv,
      cwd,
      env,
      agent: agent.agent,
      sessionId,
      sessionDir: dir,
    }
    const child =
      this.#options.spawn?.(spawnInput) ??
      spawn(argv[0]!, argv.slice(1), {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    const channel = open(child)
    this.#tokens.set(sessionId, token)
    this.#channels.set(sessionId, channel)
    this.#running.set(sessionId, running)
    this.#channelEpochs.set(channel, epoch)
    channel.onFrame(frame => this.#observe(sessionId, frame))
    const gone = () => {
      this.#toolHost.revoke(token)
      if (this.#channels.get(sessionId) === channel) {
        this.#removeLaunchFiles(agent.agent, sessionId)
        // The session's desktop child goes with the process; the next one
        // starts its own on the resource as it is then (a re-enabled display).
        this.#desktop?.close(sessionId)
        this.#channels.delete(sessionId)
        this.#running.delete(sessionId)
        this.#tokens.delete(sessionId)
        this.#longestReadyMs = Math.max(
          this.#longestReadyMs,
          channel.readyRuntimeMs,
        )
      }
    }
    void channel.closed.then(gone, error => {
      gone()
      // A conversation Claude Code no longer has: begin a new one next time.
      if (
        spec.protocol === 'claude-stream' &&
        error instanceof Error &&
        /No conversation found/i.test(error.message)
      ) {
        record.nativeId = randomUUID()
        record.started = false
        this.#saveRecord(dir, record)
      }
      if (!this.#stopped) this.#options.onError?.(error)
    })
    try {
      await channel.initialize()
    } catch (error) {
      await channel.stop(true)
      gone()
      throw error
    }
    return channel
  }

  /** An operator-configured MCP server (P32) as `session/new` takes it. */
  #acpMcpServer(server: AgentMcpServer): AcpMcpServer {
    const pairs = (values: Readonly<Record<string, string>> | undefined) =>
      Object.entries(values ?? {}).map(([name, value]) => ({ name, value }))
    if (server.transport !== 'stdio')
      return {
        type: server.transport,
        name: server.name,
        url: server.url ?? '',
        headers: pairs(server.headers),
      }
    // Through `qm mcp-exec`, as qianmopi starts them: the server sees the
    // node's baseline environment and its own variables, never the agent's
    // model key in the harness's environment.
    const keep = Object.keys(server.env ?? {})
    const exec = (this.#options.mcpArgv ?? qmArgv)([
      'mcp-exec',
      ...(keep.length > 0 ? ['--keep', keep.join(',')] : []),
      '--',
      server.command ?? '',
      ...(server.args ?? []),
    ])
    return {
      name: server.name,
      command: absoluteCommand(exec[0]!),
      args: exec.slice(1),
      env: pairs(server.env),
    }
  }

  #observe(sessionId: string, frame: OmpRpcFrame): void {
    if (frame.type !== 'prompt_result' && frame.type !== 'message_end') return
    if (frame.type === 'prompt_result' && frame.status === 'completed')
      this.#completedTurn = true
    if (frame.type === 'prompt_result') this.#retireIfStale(sessionId)
    const active = [...this.#channels.values()].some(channel => channel.busy)
    void Promise.resolve(this.#options.onActivity?.(active)).catch(error =>
      this.#options.onError?.(error),
    )
  }

  #policy(agent: ExternalAgent): ResidentExtensionConfig {
    const extensions = this.#extensionPolicy(agent.agent)
    const skills = this.#runtimeSkills(agent)
    return {
      v: 1,
      agent: agent.agent,
      workspace: agent.cwd,
      edits: this.#options.allowWorkspaceEdits ? 'workspace' : 'none',
      protectedRoots: [
        this.#options.memoryRoot,
        ...(this.#options.protectedRoots ?? []),
      ],
      hostTools: [],
      approvals: this.#options.requestPermission !== undefined,
      ...extensions,
      // The operator's skills in an ACP harness's home are material the
      // agent may read (P32), like the plugin directories.
      ...(skills === undefined
        ? {}
        : { readableRoots: [...(extensions.readableRoots ?? []), skills] }),
    }
  }

  /** The node's skills directory of the ACP harness `agent` runs on. */
  #runtimeSkills(agent: ExternalAgent): string | undefined {
    const skills = runtimeSpec(agent.runtime)?.acp?.skillsDir
    return skills === undefined
      ? undefined
      : join(qianmoConfigPath('runtimes', agent.runtime, agent.agent), skills)
  }

  /** The posture's part for operator-configured extensions (P32). */
  #extensionPolicy(
    agent: string,
  ): Pick<ResidentExtensionConfig, 'mcp' | 'readableRoots'> {
    const extensions = this.#options.extensions?.(agent) ?? null
    if (extensions === null) return {}
    return {
      mcp: extensions.mcp.map(server => ({
        server: server.name,
        approval: server.approval,
        tools: server.tools,
      })),
      readableRoots: extensions.readableRoots,
    }
  }

  async #ask(
    sessionId: string,
    call: { toolName: string; input: Readonly<Record<string, unknown>> },
  ): Promise<{ ok: boolean; reason?: string }> {
    const answer = await this.#options.requestPermission?.(sessionId, call)
    if (answer === true) return { ok: true }
    if (typeof answer === 'object' && answer !== null)
      return answer.ok
        ? { ok: true }
        : { ok: false, reason: answer.reason ?? '操作员没有批准' }
    return { ok: false, reason: '操作员没有批准' }
  }

  /** The resident posture applied to one runtime-native tool call. */
  async #decide(
    agent: ExternalAgent,
    sessionId: string,
    call: { toolName: string; input: Record<string, unknown> },
  ): Promise<{ ok: boolean; reason?: string }> {
    if (call.toolName === 'bash')
      return agent.shell
        ? this.#ask(sessionId, call)
        : {
            ok: false,
            reason:
              'this resident agent has no shell (start the node with --agent-shell to allow one)',
          }
    const verdict = residentToolVerdict(call, this.#policy(agent), {
      agentKind: 'main',
    })
    if (verdict === undefined) return { ok: true }
    if (verdict.approvalEligible === true) {
      try {
        return await this.#ask(sessionId, {
          toolName: call.toolName,
          input: residentApprovalInput(call, agent.cwd),
        })
      } catch {
        return { ok: false, reason: verdict.reason }
      }
    }
    return { ok: false, reason: verdict.reason }
  }

  async #codexPermission(
    agent: ExternalAgent,
    sessionId: string,
    call: { toolName: string; input: Record<string, unknown> },
  ): Promise<boolean> {
    // An approval request from Codex is an escalation past its sandbox; the
    // sandbox is the boundary, so only an edit the verdict would ask about
    // goes to the operator.
    if (call.toolName === 'bash') return false
    // The host's own tools decide for themselves when they are called.
    if (call.toolName.startsWith(`mcp__${RUNTIME_MCP_SERVER}__`)) return true
    // An operator-configured MCP server set to ask (P32).
    if (call.toolName.startsWith('mcp__'))
      return (await this.#decide(agent, sessionId, call)).ok
    if (typeof call.input.path !== 'string') return false
    return (await this.#decide(agent, sessionId, call)).ok
  }

  /**
   * A permission request from an ACP harness: the same posture as Claude
   * Code's `qianmo_permission`, on the call read in the node's vocabulary.
   */
  async #acpPermission(
    agent: ExternalAgent,
    sessionId: string,
    runtime: AcpRuntime,
    call: AcpToolCall,
  ): Promise<boolean> {
    const calls = acpVerdictCalls(runtime, call)
    if (calls.length === 0) return false
    for (const one of calls) {
      // The host's own tools decide for themselves when they are called.
      if (one.toolName.startsWith(`mcp__${RUNTIME_MCP_SERVER}__`)) continue
      if (!(await this.#decide(agent, sessionId, one)).ok) return false
    }
    return true
  }

  #toolList(session: RuntimeToolSession): RuntimeToolSpec[] {
    const agent =
      this.#running.get(session.sessionId) ?? this.#agents.get(session.agent)
    if (agent === undefined) return []
    const host = this.#options.hostTools
    const tools: RuntimeToolSpec[] = residentToolSurface(
      host.memoryWrite !== undefined,
      host.extraHostTools,
    ).map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    }))
    if (codexReadsByHost(agent)) tools.push(...WORKSPACE_TOOLS)
    if (this.#desktop) tools.push(...this.#desktop.specs(agent.agent))
    if (agent.runtime === 'claude-code')
      tools.push({
        name: PERMISSION_TOOL,
        description:
          'Internal: decides whether a tool call may run on this node. Never call it yourself.',
        inputSchema: {
          type: 'object',
          properties: {
            tool_name: { type: 'string' },
            input: { type: 'object' },
            tool_use_id: { type: 'string' },
          },
          required: ['tool_name', 'input'],
        },
      })
    return tools.sort((a, b) => a.name.localeCompare(b.name))
  }

  async #callTool(
    session: RuntimeToolSession,
    name: string,
    args: Record<string, unknown>,
  ): Promise<RuntimeToolResult> {
    const agent =
      this.#running.get(session.sessionId) ?? this.#agents.get(session.agent)
    if (agent === undefined)
      return { ok: false, text: 'this session has no agent' }
    if (name === PERMISSION_TOOL && agent.runtime === 'claude-code') {
      const input =
        args.input && typeof args.input === 'object'
          ? (args.input as Record<string, unknown>)
          : {}
      const decision = await this.#decide(
        agent,
        session.sessionId,
        verdictCall(String(args.tool_name ?? ''), input),
      )
      return {
        ok: true,
        text: JSON.stringify(
          decision.ok
            ? { behavior: 'allow', updatedInput: input }
            : {
                behavior: 'deny',
                message: postureMessage(decision.reason),
              },
        ),
      }
    }
    if (codexReadsByHost(agent)) {
      const workspace = runWorkspaceTool(this.#policy(agent), name, args)
      if (workspace !== undefined) return workspace
    }
    if (this.#desktop?.handles(name))
      return await this.#desktop.call(session, agent.cwd, name, args)
    const outcome = await dispatchHostTool(
      this.#options.hostTools,
      { agent: agent.agent, sessionId: session.sessionId },
      name,
      args,
    )
    return { ok: !outcome.isError, text: outcome.text }
  }

  async isAccepted(sessionId: string, messageId: string): Promise<boolean> {
    const agent = this.owner(sessionId)
    if (agent === undefined)
      throw new Error(`resident session ${sessionId} has no configured owner`)
    const ledger = join(
      this.#sessionDir(agent.agent, sessionId),
      'runtime-inputs.ndjson',
    )
    let text: string
    try {
      text = readFileSync(ledger, 'utf8')
    } catch {
      return false
    }
    return text
      .split('\n')
      .some(line => line.includes(JSON.stringify(messageId)))
  }

  closeSession(sessionId: string): void {
    const channel = this.#channels.get(sessionId)
    const token = this.#tokens.get(sessionId)
    if (token !== undefined) this.#toolHost.revoke(token)
    this.#tokens.delete(sessionId)
    this.#desktop?.close(sessionId)
    this.#channels.delete(sessionId)
    this.#running.delete(sessionId)
    this.#used.delete(sessionId)
    const owner = this.#owners.get(sessionId)
    if (owner !== undefined && channel !== undefined)
      this.#removeLaunchFiles(owner.agent, sessionId)
    if (channel !== undefined) {
      this.#longestReadyMs = Math.max(
        this.#longestReadyMs,
        channel.readyRuntimeMs,
      )
      void channel.stop().catch(error => this.#options.onError?.(error))
    }
  }

  /**
   * `agent`'s configuration changed (extensions, desktop): idle processes
   * close now, and one that is starting or running a turn finishes that turn
   * on what it started with and closes once the turn is over. The next turn
   * starts a process with the new configuration.
   */
  async invalidateAgent(agent: string): Promise<void> {
    this.#epochs.set(agent, (this.#epochs.get(agent) ?? 0) + 1)
    const closing: Promise<void>[] = []
    for (const [id, owner] of this.#owners) {
      if (owner.agent !== agent) continue
      const channel = this.#channels.get(id)
      if (channel !== undefined && this.#retireIfStale(id))
        closing.push(channel.stop().catch(() => {}))
    }
    this.#sweepMcpConfigs(agent)
    await Promise.allSettled(closing)
  }

  async stop(): Promise<void> {
    if (this.#stopped) return
    this.#stopped = true
    clearInterval(this.#timer)
    const channels = [...this.#channels.values()]
    for (const id of this.#channels.keys()) {
      const owner = this.#owners.get(id)
      if (owner !== undefined) this.#removeLaunchFiles(owner.agent, id)
    }
    this.#channels.clear()
    this.#running.clear()
    this.#tokens.clear()
    this.#desktop?.stop()
    await Promise.allSettled(channels.map(channel => channel.stop()))
    await this.#toolHost.stop()
  }
}
