// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChildProcess } from 'node:child_process'
import type { OmpPromptAdmission } from '@qianmo/resident'
import {
  nonNegative,
  RuntimeChannelBase,
  toolArgs,
  type RuntimeChannelHooks,
  type RuntimeUsage,
} from './channel.js'
import { RUNTIME_MCP_SERVER } from './claudeCode.js'

/** A TOML literal for one `-c key=value` override. */
export function toml(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`
  if (value && typeof value === 'object')
    return `{ ${Object.entries(value)
      .map(([key, entry]) => `${JSON.stringify(key)} = ${toml(entry)}`)
      .join(', ')} }`
  return '""'
}

/** The variable a resident Codex reads its key from. */
export const CODEX_KEY_ENV = 'QIANMO_RUNTIME_KEY'

/**
 * Codex features a resident agent never uses. `plugins` stays on: the
 * operator's skills and plugins load through it (P32); what a plugin bundles
 * besides skills is kept out by `apps`, `remote_plugin` and `hooks` here and
 * by the node's config for bundled MCP servers.
 */
const CODEX_DISABLED_FEATURES = [
  'multi_agent',
  'apps',
  'remote_plugin',
  'skill_mcp_dependency_install',
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

export interface CodexLaunch {
  readonly bin: string
  readonly model: string
  /** OpenAI Responses-compatible base URL, ending before `/responses`. */
  readonly baseUrl: string
  /** Name of the environment variable that holds the key. */
  readonly keyEnv: string
  readonly headers?: Readonly<Record<string, string>>
  /** The MCP server that exposes the host's `qianmo_*` tools. */
  readonly mcp: { readonly command: string; readonly args: readonly string[] }
  readonly effort?: string
  /** `--agent-shell`: keep Codex's shell, which then asks for every command. */
  readonly shell?: boolean
}

/** The command line for one resident `codex app-server` (stdio). */
export function codexArgv(launch: CodexLaunch): string[] {
  const provider = {
    name: 'qianmo',
    base_url: launch.baseUrl,
    env_key: launch.keyEnv,
    wire_api: 'responses',
    ...(launch.headers && Object.keys(launch.headers).length > 0
      ? { http_headers: launch.headers }
      : {}),
  }
  const overrides: Record<string, unknown> = {
    'model_providers.qianmo': provider,
    model_provider: 'qianmo',
    model: launch.model,
    // The host authorizes its own tools when they are called; Codex asking
    // first would only get them refused (P32 audit 14).
    [`mcp_servers.${RUNTIME_MCP_SERVER}`]: {
      command: launch.mcp.command,
      args: [...launch.mcp.args],
      default_tools_approval_mode: 'approve',
    },
    // The host is the only notifier; no desktop notification hooks.
    notify: [],
    // Skills are the ones the operator installs (P32): not Codex's own
    // (`skill-installer`, `imagegen` and the like).
    'skills.bundled.enabled': false,
    ...(launch.effort ? { model_reasoning_effort: launch.effort } : {}),
  }
  return [
    launch.bin,
    'app-server',
    ...Object.entries(overrides).flatMap(([key, value]) => [
      '-c',
      `${key}=${toml(value)}`,
    ]),
    ...[
      ...CODEX_DISABLED_FEATURES,
      ...(launch.shell ? [] : CODEX_SHELL_FEATURES),
    ].flatMap(feature => ['--disable', feature]),
    '-c',
    'web_search="disabled"',
  ]
}

/** The answer to an approval the app-server asks the client for. */
export type CodexPermission = (call: {
  readonly toolName: string
  readonly input: Record<string, unknown>
}) => Promise<boolean>

export interface CodexThreadSettings extends RuntimeChannelHooks {
  readonly cwd: string
  readonly developerInstructions: string
  readonly allowWorkspaceEdits: boolean
  /** A thread to resume; omitted starts a new one. */
  readonly threadId?: string
  readonly onThread: (threadId: string) => void
  readonly permission: CodexPermission
}

interface Pending {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: Timer
}

const REQUEST_TIMEOUT_MS = 60_000

function usageOf(value: unknown): RuntimeUsage | undefined {
  const total = toolArgs(toolArgs(value).total)
  if (Object.keys(total).length === 0) return undefined
  const cached = nonNegative(total.cachedInputTokens)
  return {
    input: Math.max(0, nonNegative(total.inputTokens) - cached),
    output: nonNegative(total.outputTokens),
    cacheRead: cached,
    cacheWrite: nonNegative(total.cacheWriteInputTokens),
  }
}

function minus(a: RuntimeUsage, b: RuntimeUsage | undefined): RuntimeUsage {
  if (b === undefined) return a
  return {
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
    cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
  }
}

/**
 * One `codex app-server` over stdio, holding one thread for one resident
 * session. JSON-RPC 2.0 without the `jsonrpc` field: requests `{id, method,
 * params}`, notifications `{method, params}`, server requests carry both.
 */
export class CodexChannel extends RuntimeChannelBase {
  protected readonly runtimeName = 'Codex'
  readonly #settings: CodexThreadSettings
  readonly #pending = new Map<number, Pending>()
  #sequence = 0
  #threadId: string | undefined
  #turnId: string | undefined
  #aborting = false
  /** Thread token totals when the current turn started. */
  #baseline: RuntimeUsage | undefined
  #latest: RuntimeUsage | undefined

  constructor(child: ChildProcess, settings: CodexThreadSettings) {
    super(child, settings)
    this.#settings = settings
    void this.closed.then(
      () => this.#failPending('Codex app-server exited'),
      () => this.#failPending('Codex app-server exited'),
    )
  }

  get threadId(): string | undefined {
    return this.#threadId
  }

  async initialize(): Promise<void> {
    await this.#request('initialize', {
      clientInfo: { name: 'qianmo', title: 'Qianmo resident', version: '1' },
      capabilities: { experimentalApi: true },
    })
    this.write({ method: 'initialized' })
    const settings = this.#settings
    const thread = {
      cwd: settings.cwd,
      approvalPolicy: 'on-request',
      sandbox: settings.allowWorkspaceEdits ? 'workspace-write' : 'read-only',
      developerInstructions: settings.developerInstructions,
    }
    let result: unknown
    if (settings.threadId !== undefined) {
      try {
        result = await this.#request('thread/resume', {
          ...thread,
          threadId: settings.threadId,
        })
      } catch {
        // The rollout is gone (wiped home, moved node): a new thread.
        result = await this.#request('thread/start', thread)
      }
    } else result = await this.#request('thread/start', thread)
    const id = toolArgs(toolArgs(result).thread).id
    if (typeof id !== 'string' || id === '')
      throw new Error('Codex app-server answered without a thread id')
    this.#threadId = id
    settings.onThread(id)
    this.markReady()
  }

  async prompt(input: {
    readonly messageId: string
    readonly text: string
  }): Promise<OmpPromptAdmission> {
    const threadId = this.#threadId
    if (threadId === undefined) throw new Error('Codex thread is not open')
    const requestId = this.beginTurn()
    this.#aborting = false
    this.#baseline = this.#latest
    let result: unknown
    try {
      result = await this.#request('turn/start', {
        threadId,
        clientUserMessageId: input.messageId,
        input: [{ type: 'text', text: input.text, text_elements: [] }],
      })
    } catch (error) {
      if (this.currentRequest === requestId) this.currentRequest = undefined
      throw error
    }
    const turnId = toolArgs(toolArgs(result).turn).id
    if (typeof turnId === 'string' && this.currentRequest === requestId)
      this.#turnId = turnId
    this.acceptInput(input.messageId, input.text)
    return { requestId, agentInvoked: true }
  }

  async abort(): Promise<void> {
    if (!this.busy || this.#aborting) return
    this.#aborting = true
    const threadId = this.#threadId
    const turnId = this.#turnId
    if (threadId === undefined || turnId === undefined) return
    await this.#request('turn/interrupt', { threadId, turnId }).catch(() => {})
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.#sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Codex ${method} timed out`))
      }, REQUEST_TIMEOUT_MS)
      timer.unref()
      this.#pending.set(id, { method, resolve, reject, timer })
      try {
        this.write({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  #failPending(reason: string): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      this.#pending.delete(id)
      pending.reject(new Error(`${reason} during ${pending.method}`))
    }
  }

  #reply(id: unknown, result: unknown): void {
    try {
      this.write({ id, result })
    } catch {
      // Closed; the turn ends with the process.
    }
  }

  protected handleMessage(message: Record<string, unknown>): void {
    const { id, method } = message
    if (typeof method === 'string' && id !== undefined) {
      void this.#serverRequest(id, method, toolArgs(message.params))
      return
    }
    if (typeof id === 'number' && method === undefined) {
      const pending = this.#pending.get(id)
      if (!pending) return
      this.#pending.delete(id)
      clearTimeout(pending.timer)
      const error = toolArgs(message.error)
      if (Object.keys(error).length > 0)
        pending.reject(
          new Error(
            `Codex ${pending.method}: ${String(error.message ?? 'error')}`,
          ),
        )
      else pending.resolve(message.result)
      return
    }
    if (typeof method === 'string')
      this.#notification(method, toolArgs(message.params))
  }

  #notification(method: string, params: Record<string, unknown>): void {
    if (
      typeof params.threadId === 'string' &&
      this.#threadId !== undefined &&
      params.threadId !== this.#threadId
    )
      return
    switch (method) {
      case 'item/started':
        this.#itemStarted(toolArgs(params.item))
        return
      case 'item/completed':
        this.#itemCompleted(toolArgs(params.item))
        return
      case 'thread/tokenUsage/updated': {
        const usage = usageOf(params.tokenUsage)
        if (usage !== undefined) this.#latest = usage
        break
      }
      case 'turn/completed':
        this.#turnCompleted(toolArgs(params.turn))
        return
    }
    this.emit({ type: 'runtime_status', subtype: method })
  }

  #itemStarted(item: Record<string, unknown>): void {
    const id = typeof item.id === 'string' ? item.id : undefined
    if (id === undefined) return
    switch (item.type) {
      case 'commandExecution':
        this.toolStart(id, 'bash', { command: item.command })
        return
      case 'fileChange':
        this.toolStart(id, 'edit', {
          paths: (Array.isArray(item.changes) ? item.changes : [])
            .map(change => toolArgs(change).path)
            .filter(path => typeof path === 'string'),
        })
        return
      case 'mcpToolCall':
        this.toolStart(
          id,
          item.server === RUNTIME_MCP_SERVER
            ? String(item.tool)
            : `${String(item.server)}.${String(item.tool)}`,
          toolArgs(item.arguments),
        )
        return
      case 'webSearch':
        this.toolStart(id, 'web_search', { query: item.query })
        return
    }
  }

  #itemCompleted(item: Record<string, unknown>): void {
    const id = typeof item.id === 'string' ? item.id : undefined
    switch (item.type) {
      case 'agentMessage':
        if (typeof item.text === 'string' && item.text !== '')
          this.assistantMessage(item.text)
        return
      case 'commandExecution':
        if (id)
          this.toolEnd(
            id,
            'bash',
            item.status === 'failed' ||
              item.status === 'declined' ||
              (typeof item.exitCode === 'number' && item.exitCode !== 0),
          )
        return
      case 'fileChange':
        if (id)
          this.toolEnd(
            id,
            'edit',
            item.status === 'failed' || item.status === 'declined',
          )
        return
      case 'mcpToolCall':
        if (id)
          this.toolEnd(
            id,
            item.server === RUNTIME_MCP_SERVER
              ? String(item.tool)
              : `${String(item.server)}.${String(item.tool)}`,
            item.status === 'failed',
          )
        return
      case 'webSearch':
        if (id) this.toolEnd(id, 'web_search', false)
        return
    }
  }

  #turnCompleted(turn: Record<string, unknown>): void {
    if (
      typeof turn.id === 'string' &&
      this.#turnId !== undefined &&
      turn.id !== this.#turnId
    )
      return
    this.#turnId = undefined
    if (this.#latest !== undefined)
      this.assistantMessage('', minus(this.#latest, this.#baseline))
    const error = toolArgs(turn.error)
    if (turn.status === 'completed') this.endTurn('completed')
    else if (turn.status === 'interrupted' || this.#aborting)
      this.endTurn('aborted')
    else
      this.endTurn('error', {
        message:
          typeof error.message === 'string' && error.message !== ''
            ? error.message
            : `Codex turn ${String(turn.status ?? 'failed')}`,
      })
  }

  async #serverRequest(
    id: unknown,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const ask = async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<boolean> => {
      try {
        return await this.#settings.permission({ toolName, input })
      } catch {
        return false
      }
    }
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const granted = await ask('bash', {
          command: params.command ?? '',
          ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
          ...(typeof params.reason === 'string'
            ? { reason: params.reason }
            : {}),
        })
        this.#reply(id, { decision: granted ? 'accept' : 'decline' })
        return
      }
      case 'item/fileChange/requestApproval': {
        const granted = await ask('edit', {
          ...(typeof params.reason === 'string'
            ? { reason: params.reason }
            : {}),
          ...(typeof params.grantRoot === 'string'
            ? { path: params.grantRoot }
            : {}),
        })
        this.#reply(id, { decision: granted ? 'accept' : 'decline' })
        return
      }
      case 'execCommandApproval':
      case 'applyPatchApproval': {
        const granted = await ask(
          method === 'execCommandApproval' ? 'bash' : 'edit',
          { command: params.command ?? '', reason: params.reason ?? '' },
        )
        this.#reply(id, {
          decision: granted
            ? 'approved'
            : { denied: { rejection: 'refused by the qianmo node' } },
        })
        return
      }
      case 'mcpServer/elicitation/request': {
        // A tool call on an operator-configured MCP server set to ask
        // (`default_tools_approval_mode = "prompt"`, P32): the node decides
        // as it does for every other tool. Any other elicitation is declined.
        const meta = toolArgs(params._meta)
        const server = params.serverName
        if (
          meta.codex_approval_kind === 'mcp_tool_call' &&
          typeof server === 'string'
        ) {
          const tool =
            typeof meta.tool_name === 'string'
              ? meta.tool_name
              : typeof meta.tool_title === 'string'
                ? meta.tool_title
                : 'tool'
          const granted = await ask(`mcp__${server}__${tool}`, {
            server,
            tool,
            ...(typeof params.message === 'string'
              ? { message: params.message }
              : {}),
          })
          this.#reply(id, {
            action: granted ? 'accept' : 'decline',
            content: granted ? {} : null,
            _meta: null,
          })
          return
        }
        this.#reply(id, { action: 'decline', content: null, _meta: null })
        return
      }
      default:
        try {
          this.write({
            id,
            error: {
              code: -32601,
              message: `qianmo resident does not answer ${method}`,
            },
          })
        } catch {
          // Closed.
        }
    }
  }
}
