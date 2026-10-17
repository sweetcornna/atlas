// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
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
import type { ExternalRuntimeChannel, ExternalRuntimeKind } from './channel.js'
import {
  CLAUDE_CODE_ENV,
  ClaudeCodeChannel,
  claudeCodeArgv,
  claudeCodeToolName,
  PERMISSION_TOOL,
  RUNTIME_MCP_SERVER,
} from './claudeCode.js'
import { CodexChannel, codexArgv } from './codex.js'
import {
  RuntimeToolHost,
  type RuntimeToolResult,
  type RuntimeToolSession,
  type RuntimeToolSpec,
} from './toolHost.js'
import type { AgentExtensionsSource } from '../extensions.js'
import {
  RuntimeDesktopTools,
  type RuntimeDesktopSource,
} from './desktopTools.js'
import { runtimeBin } from '../runtimeUpdate.js'
import { runWorkspaceTool, WORKSPACE_TOOLS } from './workspaceTools.js'

/** A resident agent that runs on Claude Code or Codex. */
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
/** Environment a runtime inherits from the node; credentials are added. */
const INHERITED_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TERM',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
]
const CODEX_KEY_ENV = 'QIANMO_RUNTIME_KEY'
/** Codex features a resident agent never uses. */
const CODEX_DISABLED_FEATURES = [
  'multi_agent',
  'apps',
  'plugins',
  'remote_plugin',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'image_generation',
  'hooks',
  'memories',
  'goals',
]
const CODEX_SHELL_FEATURES = ['shell_tool', 'unified_exec']

export function defaultExternalSystemPrompt(agent: ExternalAgent): string {
  return [
    `You are "${agent.agent}", a resident agent on a Qianmo AgentNest node. Messages reach you from the Qianmo network: the operator's console, chat channels, schedules and other agents.`,
    `Your workspace is ${agent.cwd}. Stay inside it.`,
    agent.shell
      ? 'You may run shell commands; they run sandboxed or need operator approval.'
      : agent.runtime === 'codex'
        ? 'You have no shell. Read the workspace with qianmo_read_file, qianmo_list_files and qianmo_search.'
        : 'You have no shell. Read the workspace with Read, Grep and Glob.',
    'Tools named qianmo_* act through this node: notify the operator, remember, delegate background tasks to other agents, use authorized connections, and drive your private browser and computer when the operator has switched them on.',
  ].join('\n')
}

/** The env one runtime child starts with. */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of INHERITED_ENV) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function headerLines(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}

/** Claude Code's tool input in the resident verdict's vocabulary. */
/** Codex without a shell reads the workspace through the host's tools. */
function codexReadsByHost(agent: ExternalAgent): boolean {
  return agent.runtime === 'codex' && agent.shell !== true
}

/** A refusal as Claude Code shows it to the model, prefixed once. */
function postureMessage(reason = 'refused'): string {
  return reason.startsWith(POSTURE) ? reason : `${POSTURE} ${reason}`
}
const POSTURE = 'Qianmo resident posture:'

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
  readonly #starting = new Map<string, Promise<ExternalRuntimeChannel>>()
  readonly #tokens = new Map<string, string>()
  readonly #used = new Map<string, number>()
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
        }
      },
      Math.min(idle, 60_000),
    )
    this.#timer.unref()
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
    const live = this.#channels.get(sessionId)
    if (live?.alive) return live
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
    } catch {
      // A first launch, or a session that changed runtime: start fresh.
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
    const launch = this.#options.resolveLaunch(agent)
    const record = this.#record(dir, agent.runtime)
    const systemPrompt = this.#systemPrompt(dir, agent)
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
    const env = baseEnv()
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
    const extensions = this.#options.extensions?.(agent.agent) ?? null
    if (agent.runtime === 'claude-code') {
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
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ...(launch.headers && Object.keys(launch.headers).length > 0
          ? { ANTHROPIC_CUSTOM_HEADERS: headerLines(launch.headers) }
          : {}),
      })
    } else {
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
      })
      for (const feature of [
        ...CODEX_DISABLED_FEATURES,
        ...(agent.shell ? [] : CODEX_SHELL_FEATURES),
      ])
        argv.push('--disable', feature)
      argv.push('-c', 'web_search="disabled"')
      Object.assign(env, { CODEX_HOME: home, [CODEX_KEY_ENV]: launch.apiKey })
    }
    const spawnInput: ExternalRuntimeSpawn = {
      kind: agent.runtime,
      argv,
      cwd: agent.cwd,
      env,
      agent: agent.agent,
      sessionId,
      sessionDir: dir,
    }
    const child =
      this.#options.spawn?.(spawnInput) ??
      spawn(argv[0]!, argv.slice(1), {
        cwd: agent.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    const channel: ExternalRuntimeChannel =
      agent.runtime === 'claude-code'
        ? new ClaudeCodeChannel(child, {
            onAdmitted,
            onSessionStarted: () => {
              if (record.started) return
              record.started = true
              this.#saveRecord(dir, record)
            },
          })
        : new CodexChannel(child, {
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
    this.#tokens.set(sessionId, token)
    this.#channels.set(sessionId, channel)
    channel.onFrame(frame => this.#observe(frame))
    const gone = () => {
      this.#toolHost.revoke(token)
      if (this.#channels.get(sessionId) === channel) {
        this.#channels.delete(sessionId)
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
        agent.runtime === 'claude-code' &&
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

  #observe(frame: OmpRpcFrame): void {
    if (frame.type !== 'prompt_result' && frame.type !== 'message_end') return
    if (frame.type === 'prompt_result' && frame.status === 'completed')
      this.#completedTurn = true
    const active = [...this.#channels.values()].some(channel => channel.busy)
    void Promise.resolve(this.#options.onActivity?.(active)).catch(error =>
      this.#options.onError?.(error),
    )
  }

  #policy(agent: ExternalAgent): ResidentExtensionConfig {
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
      ...this.#extensionPolicy(agent.agent),
    }
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
    // An operator-configured MCP server set to ask (P32).
    if (call.toolName.startsWith('mcp__'))
      return (await this.#decide(agent, sessionId, call)).ok
    if (typeof call.input.path !== 'string') return false
    return (await this.#decide(agent, sessionId, call)).ok
  }

  #toolList(session: RuntimeToolSession): RuntimeToolSpec[] {
    const agent = this.#agents.get(session.agent)
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
    const agent = this.#agents.get(session.agent)
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
    this.#used.delete(sessionId)
    if (channel !== undefined) {
      this.#longestReadyMs = Math.max(
        this.#longestReadyMs,
        channel.readyRuntimeMs,
      )
      void channel.stop().catch(error => this.#options.onError?.(error))
    }
  }

  async invalidateAgent(agent: string): Promise<void> {
    const ids = [...this.#owners]
      .filter(([, owner]) => owner.agent === agent)
      .map(([id]) => id)
    await Promise.allSettled(
      ids.map(async id => {
        await this.#starting.get(id)?.catch(() => {})
        const channel = this.#channels.get(id)
        this.closeSession(id)
        await channel?.stop()
      }),
    )
  }

  async stop(): Promise<void> {
    if (this.#stopped) return
    this.#stopped = true
    clearInterval(this.#timer)
    const channels = [...this.#channels.values()]
    this.#channels.clear()
    this.#tokens.clear()
    this.#desktop?.stop()
    await Promise.allSettled(channels.map(channel => channel.stop()))
    await this.#toolHost.stop()
  }
}
