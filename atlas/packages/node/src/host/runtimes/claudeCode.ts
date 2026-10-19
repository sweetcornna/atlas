// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChildProcess } from 'node:child_process'
import type { OmpPromptAdmission } from '@qianmo/resident'
import type { RuntimeRoute } from './acpSpec.js'
import { CLAUDE_TIERS, type ClaudeTier, claudeName } from './modelFields.js'
import {
  nonNegative,
  RuntimeChannelBase,
  toolArgs,
  type RuntimeChannelHooks,
  type RuntimeUsage,
} from './channel.js'

/** The MCP server name the host's tools are registered under. */
export const RUNTIME_MCP_SERVER = 'qianmo'
/**
 * P32 connectors reach every runtime under this prefix (`qm-<name>`,
 * P36.7): a native MCP server can neither be removed by nor shadow one.
 */
export const CONNECTOR_PREFIX = 'qm-'
/**
 * How long a runtime's MCP client lets one call to the host's server run:
 * `qianmo_ask` waits up to 1800 s for the other side, plus the hub's margin.
 */
export const RUNTIME_MCP_TIMEOUT_MS = 1_900_000
/** The host tool Claude Code asks before a call its rules do not settle. */
export const PERMISSION_TOOL = 'qianmo_permission'

/**
 * Built-in tools a resident Claude Code agent never gets. Sub-agents and
 * schedules go through qianmo (`qianmo_task_start`, the console's schedules)
 * so they stay visible, authorized and audited; the rest reach outside the
 * agent's workspace or the operator's attention.
 */
const DENIED_TOOLS = [
  'Task',
  'Agent',
  'Workflow',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'PushNotification',
  'RemoteTrigger',
  'EnterWorktree',
  'ExitWorktree',
  'DesignSync',
  'Monitor',
  'SendMessage',
  'ListAgents',
  'TaskStop',
]
/** Network tools: a resident turn has no network (`RESIDENT_DENIED_TOOLS`). */
const NETWORK_TOOLS = ['WebFetch', 'WebSearch']
/** Session-only tools that never need a prompt. Reads go through the posture check. */
const SESSION_TOOLS = ['TodoWrite']
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
/**
 * Tools that always reach the node's permission tool, whatever the agent's
 * own settings, a plugin or a skill's `allowed-tools` would allow (ask beats
 * allow across sources; P36.7 research V1e, V5c, V7b).
 */
const ASKED_TOOLS = ['Bash', ...EDIT_TOOLS, 'Read', 'Grep', 'Glob', 'mcp__*']
/**
 * The pin layer (`--settings`, the highest source the agent's own files
 * cannot override; `harness-backends.md` §7.4): hooks off, the asked tools,
 * the gateway (a user `env` would redirect it) and an inert `apiKeyHelper`
 * (a user one runs at startup even with a key in the environment).
 */
export function claudeCodeSettings(
  baseUrl: string,
  env: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  return {
    disableAllHooks: true,
    permissions: { ask: ASKED_TOOLS },
    env: { ...env, ANTHROPIC_BASE_URL: baseUrl },
    apiKeyHelper: '/usr/bin/true',
  }
}
/**
 * Environment that keeps a resident Claude Code to the node's policy: no
 * auto-memory (qianmo's memory goes through `qianmo_*`, and Claude Code's
 * own would live under the protected config root), no self-update (P31
 * installs versions) and no traffic but the model's. MCP calls get the
 * bridge's timeout; Claude Code has one setting for every server.
 */
export const CLAUDE_CODE_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  MCP_TOOL_TIMEOUT: String(RUNTIME_MCP_TIMEOUT_MS),
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
}

function headerLines(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}

/**
 * Claude Code's part of an agent's environment (`runtimeEnv`): its state
 * directory and, when the caller has one, the route.
 */
export function claudeCodeEnv(
  home: string,
  route?: RuntimeRoute,
): Record<string, string> {
  return {
    ...CLAUDE_CODE_ENV,
    CLAUDE_CONFIG_DIR: home,
    ...(route === undefined
      ? {}
      : {
          ANTHROPIC_API_KEY: route.apiKey,
          ANTHROPIC_BASE_URL: route.baseUrl,
          ...(route.headers && Object.keys(route.headers).length > 0
            ? { ANTHROPIC_CUSTOM_HEADERS: headerLines(route.headers) }
            : {}),
        }),
  }
}

/** Claude Code's variable for one tier's model. */
export function claudeTierEnv(tier: ClaudeTier): string {
  return `ANTHROPIC_DEFAULT_${tier.toUpperCase()}_MODEL`
}

/**
 * The variables naming a model: set from the agent's fields, or emptied in
 * the pin layer so the agent's own settings cannot name one instead.
 */
export const CLAUDE_CODE_MODEL_VARS: readonly string[] = [
  ...CLAUDE_TIERS.map(claudeTierEnv),
  'ANTHROPIC_SMALL_FAST_MODEL',
]

/** The longest reply Claude Code asks a model it does not know for. */
const CLAUDE_CODE_UNKNOWN_OUTPUT = 32_000
const ONE_MILLION = 1_000_000
const CAPS_MAX = 8_000

/** The facts {@link claudeCodeModelPlan} reads of a launch. */
export interface ClaudeCodeModels {
  readonly model: string
  readonly effort?: string
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly efforts?: readonly string[]
  readonly tiers?: Readonly<
    Partial<
      Record<
        ClaudeTier,
        {
          readonly model: string
          readonly effort?: string
          readonly contextWindow?: number
          readonly maxOutputTokens?: number
          readonly efforts?: readonly string[]
        }
      >
    >
  >
  readonly alias?: ClaudeTier
}

/** How Claude Code is told its models (`harness-backends.md` §11.2). */
export interface ClaudeCodeModelPlan {
  /** `--model`: the main model (`[1m]` at 1M and more), or the session's tier. */
  readonly model: string
  /** `--effort` (low…xhigh); `max` goes in `CLAUDE_CODE_EFFORT_LEVEL`. */
  readonly effort?: string
  /** Added to the process environment: only what is set. */
  readonly env: Readonly<Record<string, string>>
  /** The pin layer's: the same, and `''` for each model variable left out. */
  readonly settingsEnv: Readonly<Record<string, string>>
}

function oneMillion(model: string, window: number | undefined): string {
  return window !== undefined &&
    window >= ONE_MILLION &&
    !model.endsWith('[1m]')
    ? `${model}[1m]`
    : model
}

/** One of Anthropic's Claude models, by whichever provider it comes. */
function isClaudeModel(model: string): boolean {
  const bare = model.replace(/\[1m\]$/, '')
  return bare
    .slice(bare.lastIndexOf('/') + 1)
    .toLowerCase()
    .startsWith('claude')
}

/**
 * `CLAUDE_CODE_MODEL_CAPABILITIES` for the models Claude Code does not know
 * (another vendor's, through the gateway) that take efforts: without it
 * Claude Code never sends one an effort.
 */
function capabilities(
  models: readonly {
    readonly id: string
    readonly efforts?: readonly string[]
  }[],
): string {
  const parts: string[] = []
  let length = 0
  for (const { id, efforts } of models) {
    const name = id.replace(/\[1m\]$/, '').toLowerCase()
    if (claudeName(name) !== '' || /[;=,*]/.test(name)) continue
    if (efforts === undefined) continue
    const levels = efforts.filter(level =>
      ['low', 'medium', 'high', 'xhigh', 'max'].includes(level),
    )
    if (levels.length === 0) continue
    const caps = [
      'effort',
      ...(levels.includes('xhigh') ? ['xhigh_effort'] : []),
      ...(levels.includes('max') ? ['max_effort'] : []),
    ].join(',')
    const part = `${name}=${caps}`
    if (parts.some(one => one.startsWith(`${name}=`))) continue
    if (length + part.length + 1 > CAPS_MAX) break
    parts.push(part)
    length += part.length + 1
  }
  return parts.join(';')
}

/**
 * The agent's models as Claude Code takes them (§11.2, as magpie's
 * `writeTiers`): `--model` and `--effort`; each tier with a model in
 * `ANTHROPIC_DEFAULT_<TIER>_MODEL` as `model:effort[1m]`, the haiku tier in
 * `ANTHROPIC_SMALL_FAST_MODEL` too, a tier without one left out; `max` in
 * `CLAUDE_CODE_EFFORT_LEVEL`; the window and the reply length Claude Code
 * cannot know of another vendor's model in `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and
 * `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, and which of them take efforts in
 * `CLAUDE_CODE_MODEL_CAPABILITIES`.
 */
export function claudeCodeModelPlan(
  launch: ClaudeCodeModels,
): ClaudeCodeModelPlan {
  const main = oneMillion(launch.model, launch.contextWindow)
  const env: Record<string, string> = {}
  const tiers = CLAUDE_TIERS.flatMap(tier => {
    const one = launch.tiers?.[tier]
    return one === undefined ? [] : [{ tier, ...one }]
  })
  for (const one of tiers) {
    const bare = one.effort ? `${one.model}:${one.effort}` : one.model
    env[claudeTierEnv(one.tier)] = oneMillion(bare, one.contextWindow)
  }
  const haiku = env[claudeTierEnv('haiku')]
  if (haiku !== undefined) env.ANTHROPIC_SMALL_FAST_MODEL = haiku
  let effort: string | undefined
  if (launch.effort === 'max') env.CLAUDE_CODE_EFFORT_LEVEL = 'max'
  else if (
    launch.effort !== undefined &&
    ['low', 'medium', 'high', 'xhigh'].includes(launch.effort)
  )
    effort = launch.effort
  // One window serves every model not marked [1m]: the main model's, or when
  // that one is marked, the smallest of the unmarked tiers'.
  let window = main.endsWith('[1m]') ? 0 : (launch.contextWindow ?? 0)
  if (main.endsWith('[1m]'))
    for (const one of tiers) {
      if ((one.contextWindow ?? 0) >= ONE_MILLION) continue
      const own = one.contextWindow ?? 0
      if (own > 0 && (window === 0 || own < window)) window = own
    }
  if (window > 0) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(window)
  // The longest reply all of them can write, when it is past what Claude
  // Code asks for anyway and none of them is unknown; a Claude main model
  // Claude Code knows itself.
  if (!isClaudeModel(launch.model)) {
    let reply = 0
    let known = true
    for (const one of [
      { model: launch.model, maxOutputTokens: launch.maxOutputTokens },
      ...tiers,
    ]) {
      if (isClaudeModel(one.model)) continue
      if (one.maxOutputTokens === undefined || one.maxOutputTokens <= 0) {
        known = false
        break
      }
      if (reply === 0 || one.maxOutputTokens < reply)
        reply = one.maxOutputTokens
    }
    if (known && reply > CLAUDE_CODE_UNKNOWN_OUTPUT)
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(reply)
  }
  const caps = capabilities([
    {
      id: launch.model,
      ...(launch.efforts === undefined ? {} : { efforts: launch.efforts }),
    },
    ...tiers
      .filter(one => !one.effort)
      .map(one => ({
        id: one.model,
        ...(one.efforts === undefined ? {} : { efforts: one.efforts }),
      })),
  ])
  if (caps !== '') env.CLAUDE_CODE_MODEL_CAPABILITIES = caps
  const settingsEnv: Record<string, string> = { ...env }
  for (const name of CLAUDE_CODE_MODEL_VARS)
    if (settingsEnv[name] === undefined) settingsEnv[name] = ''
  const alias =
    launch.alias !== undefined && env[claudeTierEnv(launch.alias)] !== undefined
      ? launch.alias
      : undefined
  return {
    model: alias ?? main,
    ...(effort === undefined ? {} : { effort }),
    env,
    settingsEnv,
  }
}

/** What the frontend and the resident process share (P36.7 §7.2). */
export interface ClaudeCodePins {
  /** The gateway, pinned over the agent's own settings. */
  readonly baseUrl: string
  /**
   * The model variables pinned over the agent's own settings
   * ({@link claudeCodeModelPlan}'s `settingsEnv`, §11).
   */
  readonly settingsEnv?: Readonly<Record<string, string>>
  readonly mcpConfigPath?: string
  /** Plugins the operator installed for the agent (P32): `--plugin-dir`. */
  readonly pluginDirs?: readonly string[]
}

/**
 * The pin flags: only the user settings (the agent's own
 * `CLAUDE_CONFIG_DIR`; nothing from the project), the pin layer on top, the
 * operator's plugin directories, and the MCP config with the node's servers
 * (`qianmo`, P32 connectors as `qm-<name>`). The agent's own MCP servers
 * and plugins load beside them (no `--strict-mcp-config`).
 */
export function claudeCodePinArgs(pins: ClaudeCodePins): string[] {
  return [
    '--setting-sources',
    'user',
    '--settings',
    JSON.stringify(claudeCodeSettings(pins.baseUrl, pins.settingsEnv)),
    ...(pins.pluginDirs ?? []).flatMap(dir => ['--plugin-dir', dir]),
    ...(pins.mcpConfigPath === undefined
      ? []
      : ['--mcp-config', pins.mcpConfigPath]),
  ]
}

/**
 * The official terminal frontend (`qm runtime open`): the same pins, the
 * person at the terminal approves (Claude Code's default mode, never its
 * `auto`).
 */
export function claudeCodeOpenArgv(
  input: ClaudeCodePins & { readonly bin: string; readonly model: string },
): string[] {
  return [
    input.bin,
    ...claudeCodePinArgs(input),
    '--permission-mode',
    'default',
    '--model',
    input.model,
  ]
}

export interface ClaudeCodeLaunch {
  readonly bin: string
  readonly model: string
  /** The gateway (`ANTHROPIC_BASE_URL`), pinned in the settings layer too. */
  readonly baseUrl: string
  /** The model variables of the pin layer (§11). */
  readonly settingsEnv?: Readonly<Record<string, string>>
  /** The Claude Code conversation id (a UUID). */
  readonly sessionId: string
  /** Whether the conversation already has a transcript to resume. */
  readonly resume: boolean
  readonly systemPrompt: string
  readonly mcpConfigPath: string
  readonly allowWorkspaceEdits: boolean
  /** `--agent-shell`: keep `Bash`, which then asks for every command. */
  readonly shell?: boolean
  readonly effort?: string
  /** Plugins the operator installed for the agent (P32): `--plugin-dir`. */
  readonly pluginDirs?: readonly string[]
  /** Operator-configured MCP servers that run without asking (P32). */
  readonly allowedMcpServers?: readonly string[]
}

/** The command line for one resident Claude Code process. */
export function claudeCodeArgv(launch: ClaudeCodeLaunch): string[] {
  const allowed = [
    ...SESSION_TOOLS,
    `mcp__${RUNTIME_MCP_SERVER}`,
    // Loading a skill reads instructions the operator installed, natively or
    // through the console; what a skill's `allowed-tools` would grant is
    // asked all the same (the pin layer).
    'Skill',
    ...(launch.allowedMcpServers ?? []).map(name => `mcp__${name}`),
  ]
  const denied = [
    ...DENIED_TOOLS,
    ...NETWORK_TOOLS,
    ...(launch.shell ? [] : ['Bash']),
    ...(launch.allowWorkspaceEdits ? [] : EDIT_TOOLS),
  ]
  return [
    launch.bin,
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    // The agent's own state (`CLAUDE_CONFIG_DIR`, P36.7: what the operator
    // installed natively loads, its MCP servers included); nothing from the
    // project. Hooks stay off and every effectful call reaches the node
    // whatever those files say. (In Claude Code 2.1.301 `--safe-mode` drops
    // `--mcp-config` and `--bare` drops the built-in tools and plugin
    // skills.)
    ...claudeCodePinArgs({
      baseUrl: launch.baseUrl,
      ...(launch.settingsEnv === undefined
        ? {}
        : { settingsEnv: launch.settingsEnv }),
      mcpConfigPath: launch.mcpConfigPath,
      ...(launch.pluginDirs === undefined
        ? {}
        : { pluginDirs: launch.pluginDirs }),
    }),
    // Whatever the rules leave open is asked through the host: Claude Code
    // 2.1.301 otherwise starts in `auto`, where its own model-based
    // classifier decides and the prompt tool is never called.
    '--permission-mode',
    'default',
    '--permission-prompt-tool',
    `mcp__${RUNTIME_MCP_SERVER}__${PERMISSION_TOOL}`,
    '--model',
    launch.model,
    ...(launch.effort ? ['--effort', launch.effort] : []),
    // Cache: the system prompt is rendered once per conversation and reused
    // verbatim; per-machine sections move into the first user message.
    '--system-prompt-snapshot',
    'on',
    '--exclude-dynamic-system-prompt-sections',
    '--append-system-prompt',
    launch.systemPrompt,
    '--allowedTools',
    allowed.join(','),
    '--disallowedTools',
    denied.join(','),
    launch.resume ? '--resume' : '--session-id',
    launch.sessionId,
  ]
}

/** Claude Code's tool names in the turn port's (lower-case) vocabulary. */
const TOOL_NAMES: Record<string, string> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'bash',
  Grep: 'grep',
  Glob: 'glob',
  WebFetch: 'fetch',
  WebSearch: 'web_search',
}
export function claudeCodeToolName(name: string): string {
  const mcp = `mcp__${RUNTIME_MCP_SERVER}__`
  if (name.startsWith(mcp)) return name.slice(mcp.length)
  return TOOL_NAMES[name] ?? name
}

const INTERRUPT_GRACE_MS = 5_000

/**
 * One `claude -p` process in stream-json mode, held open across turns so a
 * busy chat reuses a warm process and the provider's prompt cache.
 *
 * | turn port frame | Claude Code event |
 * |---|---|
 * | user `message_end` | written to stdin |
 * | assistant `message_end` | `assistant` text blocks |
 * | `tool_execution_start/end` | `tool_use` blocks / `tool_result` blocks |
 * | usage | the `result` event's turn total |
 * | `prompt_result` | `result` |
 */
export class ClaudeCodeChannel extends RuntimeChannelBase {
  protected readonly runtimeName = 'Claude Code'
  readonly #tools = new Map<string, string>()
  readonly #onSessionStarted: (() => void) | undefined
  #aborting = false
  #abortTimer: Timer | undefined
  #lastStopReason: string | undefined
  #control = 0

  constructor(
    child: ChildProcess,
    options: RuntimeChannelHooks & {
      readonly onSessionStarted?: () => void
    } = {},
  ) {
    super(child, options)
    this.#onSessionStarted = options.onSessionStarted
  }

  async initialize(): Promise<void> {
    // Claude Code prints its `init` only once the first message arrives, so
    // readiness is the spawned process itself; an immediate failure shows up
    // as `closed` rejecting.
    await new Promise<void>((resolve, reject) => {
      if (this.child.pid !== undefined) resolve()
      else {
        this.child.once('spawn', () => resolve())
        this.child.once('error', reject)
      }
    })
    this.markReady()
  }

  async prompt(input: {
    readonly messageId: string
    readonly text: string
  }): Promise<OmpPromptAdmission> {
    const requestId = this.beginTurn()
    this.#aborting = false
    this.#lastStopReason = undefined
    try {
      this.write({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: input.text }],
        },
        parent_tool_use_id: null,
      })
    } catch (error) {
      this.currentRequest = undefined
      throw error
    }
    this.acceptInput(input.messageId, input.text)
    return { requestId, agentInvoked: true }
  }

  async abort(): Promise<void> {
    if (!this.busy || this.#aborting) return
    this.#aborting = true
    try {
      this.write({
        type: 'control_request',
        request_id: `qianmo-${++this.#control}`,
        request: { subtype: 'interrupt' },
      })
    } catch {
      // Already closed: the base class ends the turn.
    }
    // An interrupt Claude Code does not honor in time ends the process; the
    // next turn resumes the conversation by id.
    this.#abortTimer = setTimeout(() => {
      if (this.busy) {
        this.endTurn('aborted')
        void this.stop(true)
      }
    }, INTERRUPT_GRACE_MS)
    this.#abortTimer.unref()
  }

  protected handleMessage(message: Record<string, unknown>): void {
    switch (message.type) {
      case 'assistant':
        this.#assistant(toolArgs(message.message))
        return
      case 'user':
        this.#toolResults(toolArgs(message.message))
        return
      case 'result':
        this.#result(message)
        return
      case 'system':
        if (message.subtype === 'init') this.markReady()
        // `api_retry` and every other status line keep the watchdog fed.
        this.emit({ type: 'runtime_status', subtype: message.subtype })
        return
      default:
        this.emit({ type: 'runtime_status', subtype: message.type })
    }
  }

  #assistant(message: Record<string, unknown>): void {
    const blocks = Array.isArray(message.content) ? message.content : []
    let text = ''
    for (const raw of blocks) {
      const block = toolArgs(raw)
      if (block.type === 'text' && typeof block.text === 'string')
        text += block.text
      else if (block.type === 'tool_use' && typeof block.id === 'string') {
        const name = claudeCodeToolName(String(block.name ?? 'tool'))
        this.#tools.set(block.id, name)
        this.toolStart(block.id, name, toolArgs(block.input))
      }
    }
    if (typeof message.stop_reason === 'string')
      this.#lastStopReason =
        message.stop_reason === 'max_tokens' ? 'length' : message.stop_reason
    if (text !== '') this.assistantMessage(text)
  }

  #toolResults(message: Record<string, unknown>): void {
    const blocks = Array.isArray(message.content) ? message.content : []
    for (const raw of blocks) {
      const block = toolArgs(raw)
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string')
        continue
      const name = this.#tools.get(block.tool_use_id) ?? 'tool'
      this.#tools.delete(block.tool_use_id)
      this.toolEnd(block.tool_use_id, name, block.is_error === true)
    }
  }

  #result(message: Record<string, unknown>): void {
    if (this.#abortTimer !== undefined) clearTimeout(this.#abortTimer)
    // Any answered message leaves a transcript behind to resume.
    this.#onSessionStarted?.()
    const usage = toolArgs(message.usage)
    const turnUsage: RuntimeUsage = {
      input: nonNegative(usage.input_tokens),
      output: nonNegative(usage.output_tokens),
      cacheRead: nonNegative(usage.cache_read_input_tokens),
      cacheWrite: nonNegative(usage.cache_creation_input_tokens),
    }
    this.assistantMessage('', turnUsage, this.#lastStopReason)
    if (!this.busy) return
    const failed = message.is_error === true || message.subtype !== 'success'
    if (this.#aborting) this.endTurn('aborted')
    else if (failed)
      this.endTurn('error', {
        message:
          typeof message.result === 'string' && message.result !== ''
            ? message.result
            : `Claude Code ended the turn: ${String(message.subtype ?? 'error')}`,
        ...(typeof message.api_error_status === 'number'
          ? { httpStatus: message.api_error_status }
          : {}),
      })
    else this.endTurn('completed')
  }
}
