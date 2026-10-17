// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChildProcess } from 'node:child_process'
import type { OmpPromptAdmission } from '@qianmo/resident'
import type {
  AcpRuntime,
  AcpToolCall,
  AcpUsage,
  AcpUsageReader,
  AcpVerdictCall,
} from './acpSpec.js'
import {
  nonNegative,
  RuntimeChannelBase,
  toolArgs,
  type RuntimeChannelHooks,
} from './channel.js'
import { RUNTIME_MCP_SERVER } from './claudeCode.js'

/** The ACP major version this client speaks. */
export const ACP_PROTOCOL_VERSION = 1

/** An MCP server as `session/new` takes it. */
export type AcpMcpServer =
  | {
      readonly name: string
      readonly command: string
      readonly args: readonly string[]
      readonly env: readonly { readonly name: string; readonly value: string }[]
    }
  | {
      readonly type: 'http' | 'sse'
      readonly name: string
      readonly url: string
      readonly headers: readonly {
        readonly name: string
        readonly value: string
      }[]
    }

export function acpMcpTransport(
  server: AcpMcpServer,
): 'stdio' | 'http' | 'sse' {
  return 'type' in server ? server.type : 'stdio'
}

export interface AcpSessionSettings extends RuntimeChannelHooks {
  /** Shown in errors: the catalog label. */
  readonly label: string
  readonly runtime: AcpRuntime
  /** The agent's workspace: `session/new {cwd}`. */
  readonly cwd: string
  readonly mcpServers: readonly AcpMcpServer[]
  /** A native session to continue; omitted opens a new one. */
  readonly sessionId?: string
  readonly onSession: (sessionId: string) => void
  /** Sent ahead of the first prompt of a new native session. */
  readonly instructions?: string
  readonly effort?: string
  /** The node's answer to `session/request_permission`. */
  readonly permission: (call: AcpToolCall) => Promise<boolean>
  /** Where the provider's usage of the native session is, if anywhere. */
  readonly usage?: (sessionId: string) => AcpUsageReader | undefined
  /** Servers left out: the harness does not take their transport. */
  readonly onMcpSkipped?: (names: readonly string[]) => void
  readonly onError?: (error: unknown) => void
}

interface Pending {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: Timer | undefined
}

interface TrackedTool {
  call: AcpToolCall
  started: boolean
  ended: boolean
}

const REQUEST_TIMEOUT_MS = 60_000
const CANCEL_GRACE_MS = 5_000
const ZERO_USAGE: AcpUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function firstPath(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === 'string' && value !== '',
  )
}

/**
 * A tool call by its ACP `kind` and `locations`, for harnesses without a
 * mapping of their own. What it cannot place keeps its title, which the
 * node's verdict refuses as a tool it does not know.
 */
export function genericAcpToolCall(call: AcpToolCall): AcpVerdictCall[] {
  const raw = call.rawInput
  const path = firstPath(
    call.paths[0],
    raw.file_path,
    raw.filePath,
    raw.absolute_path,
    raw.path,
  )
  if (call.title.startsWith('mcp__'))
    return [{ toolName: call.title, input: { ...raw } }]
  switch (call.kind) {
    case 'execute':
      return [
        {
          toolName: 'bash',
          input: { ...raw, command: text(raw.command) ?? call.title },
        },
      ]
    case 'edit':
    case 'delete':
    case 'move': {
      const targets =
        call.paths.length > 0 ? call.paths : path === undefined ? [] : [path]
      // No target: the verdict cannot tell what it would change and refuses.
      if (targets.length === 0) return [{ toolName: 'edit', input: { ...raw } }]
      return targets.map(target => ({
        toolName: 'edit',
        input: { ...raw, path: target },
      }))
    }
    case 'read':
      return path === undefined
        ? [{ toolName: `read:${call.title}`, input: { ...raw } }]
        : [{ toolName: 'read', input: { path } }]
    case 'search':
      return [{ toolName: 'grep', input: { path: path ?? '.' } }]
    case 'think':
      return [{ toolName: 'todo', input: {} }]
    case 'fetch':
      return [{ toolName: 'fetch', input: { ...raw } }]
    default:
      return [{ toolName: call.title, input: { ...raw } }]
  }
}

/** `call` in the node's vocabulary, by the harness's own mapping if it has one. */
export function acpVerdictCalls(
  runtime: AcpRuntime,
  call: AcpToolCall,
): readonly AcpVerdictCall[] {
  return (runtime.toolCall ?? genericAcpToolCall)(call)
}

/** What the progress line calls a tool. */
function progressName(name: string): string {
  const own = `mcp__${RUNTIME_MCP_SERVER}__`
  return name.startsWith(own) ? name.slice(own.length) : name
}

function toolCallOf(
  update: Record<string, unknown>,
  before?: AcpToolCall,
): AcpToolCall {
  const locations = Array.isArray(update.locations)
    ? update.locations
        .map(location => toolArgs(location).path)
        .filter((path): path is string => typeof path === 'string')
    : undefined
  const raw = update.rawInput
  const kind = text(update.kind) ?? before?.kind
  return {
    title: text(update.title) ?? before?.title ?? 'tool',
    ...(kind === undefined ? {} : { kind }),
    rawInput:
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : (before?.rawInput ?? {}),
    paths: locations ?? before?.paths ?? [],
  }
}

/** The draft `PromptResponse.usage`, where a harness fills it. */
function promptUsage(value: unknown): AcpUsage | undefined {
  const usage = toolArgs(value)
  if (Object.keys(usage).length === 0) return undefined
  const cached = nonNegative(usage.cachedReadTokens)
  return {
    input: Math.max(0, nonNegative(usage.inputTokens) - cached),
    output: nonNegative(usage.outputTokens),
    cacheRead: cached,
    cacheWrite: nonNegative(usage.cachedWriteTokens),
  }
}

/**
 * One ACP agent (`harness-backends.md` §5) over stdio, holding one native
 * session for one resident session. JSON-RPC 2.0, newline-delimited.
 *
 * | turn port frame | ACP |
 * |---|---|
 * | user `message_end` | `session/prompt` written |
 * | assistant `message_end` | `agent_message_chunk` text, up to the next tool call or the turn's end |
 * | `tool_execution_start/end` | `tool_call` / `tool_call_update` `completed`, `failed` |
 * | usage | the harness's usage reader, else `PromptResponse.usage`, else 0 marked unreported |
 * | `prompt_result` | the `session/prompt` answer's `stopReason`, or its error |
 *
 * The client offers no `fs` or `terminal`: the harness's own tools do the
 * work, and every one it asks about goes to the node
 * (`session/request_permission`), answered with a one-time option only.
 */
export class AcpChannel extends RuntimeChannelBase {
  protected readonly runtimeName: string
  readonly #settings: AcpSessionSettings
  readonly #pending = new Map<number, Pending>()
  readonly #tools = new Map<string, TrackedTool>()
  /** Permission requests not answered yet, by JSON-RPC id. */
  readonly #asks = new Map<string, () => void>()
  #sequence = 0
  #sessionId: string | undefined
  #instructionsPending = false
  #text = ''
  #textMessage: string | undefined
  #aborting = false
  #abortTimer: Timer | undefined
  #usage: AcpUsageReader | undefined
  #usageFrom = 0

  constructor(child: ChildProcess, settings: AcpSessionSettings) {
    super(child, settings)
    this.runtimeName = settings.label
    this.#settings = settings
    void this.closed.then(
      () => this.#failPending(`${settings.label} exited`),
      () => this.#failPending(`${settings.label} exited`),
    )
  }

  get sessionId(): string | undefined {
    return this.#sessionId
  }

  async initialize(): Promise<void> {
    const settings = this.#settings
    const init = toolArgs(
      await this.#request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        // Files and commands are the harness's own tools' work, decided by
        // the node through permission requests; nothing runs through us.
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'qianmo', title: 'Qianmo resident', version: '1' },
      }),
    )
    if (init.protocolVersion !== ACP_PROTOCOL_VERSION)
      throw new Error(
        `${settings.label} speaks ACP version ${String(init.protocolVersion)}, not ${ACP_PROTOCOL_VERSION}`,
      )
    const capabilities = toolArgs(init.agentCapabilities)
    const mcp = toolArgs(capabilities.mcpCapabilities)
    const servers = settings.mcpServers.filter(server => {
      const transport = acpMcpTransport(server)
      return transport === 'stdio' || mcp[transport] === true
    })
    if (servers.length < settings.mcpServers.length)
      settings.onMcpSkipped?.(
        settings.mcpServers
          .filter(server => !servers.includes(server))
          .map(server => server.name),
      )
    const resume =
      settings.runtime.resume ??
      (Object.hasOwn(toolArgs(capabilities.sessionCapabilities), 'resume')
        ? 'session/resume'
        : capabilities.loadSession === true
          ? 'session/load'
          : undefined)
    let opened: Record<string, unknown> | undefined
    if (settings.sessionId !== undefined && resume !== undefined) {
      try {
        opened = toolArgs(
          await this.#request(resume, {
            sessionId: settings.sessionId,
            cwd: settings.cwd,
            mcpServers: servers,
          }),
        )
        this.#sessionId = settings.sessionId
      } catch {
        // The harness no longer has it (wiped home, another node): a new
        // conversation, with the node's instructions again.
        opened = undefined
      }
    }
    if (this.#sessionId === undefined) {
      opened = toolArgs(
        await this.#request('session/new', {
          cwd: settings.cwd,
          mcpServers: servers,
        }),
      )
      const id = opened.sessionId
      if (typeof id !== 'string' || id === '')
        throw new Error(`${settings.label} answered session/new without an id`)
      this.#sessionId = id
      this.#instructionsPending = settings.instructions !== undefined
    }
    settings.onSession(this.#sessionId)
    this.#usage = settings.usage?.(this.#sessionId)
    await this.#applyEffort(opened ?? {})
    this.markReady()
  }

  /** Effort through the harness's config option, when it offers the value. */
  async #applyEffort(opened: Record<string, unknown>): Promise<void> {
    const { effort, runtime } = this.#settings
    const configId = runtime.effortOption
    if (effort === undefined || configId === undefined) return
    const option = (
      Array.isArray(opened.configOptions) ? opened.configOptions : []
    )
      .map(toolArgs)
      .find(one => one.id === configId)
    if (option === undefined || option.currentValue === effort) return
    const values = (Array.isArray(option.options) ? option.options : []).map(
      one => toolArgs(one).value,
    )
    if (!values.includes(effort)) return
    try {
      await this.#request(
        'session/set_config_option',
        { sessionId: this.#sessionId, configId, value: effort },
        15_000,
      )
    } catch (error) {
      // The turn still runs, on the harness's default effort.
      this.#settings.onError?.(error)
    }
  }

  async prompt(input: {
    readonly messageId: string
    readonly text: string
  }): Promise<OmpPromptAdmission> {
    const sessionId = this.#sessionId
    if (sessionId === undefined)
      throw new Error(`${this.runtimeName} session is not open`)
    const requestId = this.beginTurn()
    this.#aborting = false
    this.#text = ''
    this.#textMessage = undefined
    this.#tools.clear()
    try {
      this.#usageFrom = this.#usage?.start() ?? 0
    } catch {
      this.#usageFrom = 0
    }
    const instructions = this.#instructionsPending
      ? this.#settings.instructions
      : undefined
    let answer: Promise<unknown>
    try {
      answer = this.#request(
        'session/prompt',
        {
          sessionId,
          prompt: [
            ...(instructions === undefined
              ? []
              : [{ type: 'text', text: instructions }]),
            { type: 'text', text: input.text },
          ],
        },
        null,
      )
    } catch (error) {
      if (this.currentRequest === requestId) this.currentRequest = undefined
      throw error
    }
    this.#instructionsPending = false
    void answer.then(
      result => this.#finish(requestId, toolArgs(result)),
      error => this.#fail(requestId, error),
    )
    this.acceptInput(input.messageId, input.text)
    return { requestId, agentInvoked: true }
  }

  async abort(): Promise<void> {
    if (!this.busy || this.#aborting) return
    this.#aborting = true
    // Nothing still waiting for the node is granted now.
    for (const settle of [...this.#asks.values()]) settle()
    try {
      this.write({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: this.#sessionId },
      })
    } catch {
      // Already closed: the base class ends the turn.
    }
    const requestId = this.currentRequest
    this.#abortTimer = setTimeout(() => {
      if (this.busy && this.currentRequest === requestId) {
        this.endTurn('aborted')
        void this.stop(true)
      }
    }, CANCEL_GRACE_MS)
    this.#abortTimer.unref()
  }

  /** The turn's text so far, as one assistant message. */
  #flushText(): void {
    if (this.#text !== '') this.assistantMessage(this.#text)
    this.#text = ''
    this.#textMessage = undefined
  }

  async #turnUsage(answer: Record<string, unknown>): Promise<{
    usage: AcpUsage
    reported: boolean
  }> {
    if (this.#usage !== undefined) {
      try {
        const usage = await this.#usage.read(this.#usageFrom)
        if (usage !== undefined) return { usage, reported: true }
      } catch (error) {
        this.#settings.onError?.(error)
      }
    }
    const usage = promptUsage(answer.usage)
    return usage === undefined
      ? { usage: ZERO_USAGE, reported: false }
      : { usage, reported: true }
  }

  /** The turn's usage: never estimated; 0 and marked when not reported. */
  #usageMessage(usage: AcpUsage, reported: boolean, stopReason?: string): void {
    this.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        usage,
        ...(reported ? {} : { usageReported: false }),
        ...(stopReason === undefined ? {} : { stopReason }),
      },
    })
  }

  async #finish(
    requestId: string,
    answer: Record<string, unknown>,
  ): Promise<void> {
    if (this.currentRequest !== requestId) return
    this.#flushText()
    const { usage, reported } = await this.#turnUsage(answer)
    if (this.currentRequest !== requestId) return
    if (this.#abortTimer !== undefined) clearTimeout(this.#abortTimer)
    const reason = answer.stopReason
    this.#usageMessage(
      usage,
      reported,
      reason === 'max_tokens' ? 'length' : undefined,
    )
    switch (reason) {
      case 'end_turn':
      case 'max_tokens':
        this.endTurn('completed')
        return
      case 'cancelled':
        this.endTurn('aborted')
        return
      case 'refusal':
        this.endTurn('error', {
          message: `${this.runtimeName} refused to continue`,
        })
        return
      case 'max_turn_requests':
        this.endTurn('error', {
          message: `${this.runtimeName} stopped: too many model requests in one turn`,
        })
        return
      default:
        if (this.#aborting) this.endTurn('aborted')
        else
          this.endTurn('error', {
            message: `${this.runtimeName} ended the turn: ${String(reason ?? 'no stop reason')}`,
          })
    }
  }

  async #fail(requestId: string, error: unknown): Promise<void> {
    if (this.currentRequest !== requestId) return
    this.#flushText()
    // The provider may have answered (and billed) steps before the failure.
    const { usage, reported } = await this.#turnUsage({})
    if (this.currentRequest !== requestId) return
    if (this.#abortTimer !== undefined) clearTimeout(this.#abortTimer)
    this.#usageMessage(usage, reported)
    if (this.#aborting) this.endTurn('aborted')
    else
      this.endTurn('error', {
        message: error instanceof Error ? error.message : String(error),
      })
  }

  /**
   * Sends a request; its answer settles the promise. A closed process
   * throws here, before anything counts as sent.
   */
  #request(
    method: string,
    params: unknown,
    timeoutMs: number | null = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const id = ++this.#sequence
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const timer =
      timeoutMs === null
        ? undefined
        : setTimeout(() => {
            this.#pending.delete(id)
            reject(new Error(`${this.runtimeName} ${method} timed out`))
          }, timeoutMs)
    timer?.unref()
    this.#pending.set(id, { method, resolve, reject, timer })
    try {
      this.write({ jsonrpc: '2.0', id, method, params })
    } catch (error) {
      if (timer !== undefined) clearTimeout(timer)
      this.#pending.delete(id)
      throw error
    }
    return promise
  }

  #failPending(reason: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      this.#pending.delete(id)
      pending.reject(new Error(`${reason} during ${pending.method}`))
    }
  }

  #reply(id: unknown, body: { result: unknown } | { error: unknown }): void {
    try {
      this.write({ jsonrpc: '2.0', id, ...body })
    } catch {
      // Closed; the turn ends with the process.
    }
  }

  protected handleMessage(message: Record<string, unknown>): void {
    const { id, method } = message
    if (typeof method === 'string' && id !== undefined && id !== null) {
      if (method === 'session/request_permission')
        void this.#permission(id, toolArgs(message.params))
      else
        this.#reply(id, {
          error: {
            code: -32601,
            message: `qianmo resident does not answer ${method}`,
          },
        })
      return
    }
    if (typeof id === 'number' && method === undefined) {
      const pending = this.#pending.get(id)
      if (!pending) return
      this.#pending.delete(id)
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      const error = toolArgs(message.error)
      if (Object.keys(error).length > 0)
        pending.reject(
          new Error(
            `${this.runtimeName} ${pending.method}: ${String(error.message ?? 'error')}`,
          ),
        )
      else pending.resolve(message.result)
      return
    }
    // Notifications other than session updates are not ours to act on.
    if (method === 'session/update') this.#update(toolArgs(message.params))
  }

  #update(params: Record<string, unknown>): void {
    if (params.sessionId !== this.#sessionId || !this.busy) return
    const update = toolArgs(params.update)
    const kind = update.sessionUpdate
    switch (kind) {
      case 'agent_message_chunk': {
        const content = toolArgs(update.content)
        if (content.type !== 'text' || typeof content.text !== 'string') return
        const message = text(update.messageId)
        if (message !== this.#textMessage) {
          this.#flushText()
          this.#textMessage = message
        }
        this.#text += content.text
        this.emit({ type: 'message_update', message: { role: 'assistant' } })
        return
      }
      case 'tool_call':
      case 'tool_call_update': {
        const id = text(update.toolCallId)
        if (id === undefined) return
        this.#flushText()
        const known = this.#tools.get(id)
        const tool: TrackedTool = known ?? {
          call: toolCallOf(update),
          started: false,
          ended: false,
        }
        if (known !== undefined) tool.call = toolCallOf(update, known.call)
        this.#tools.set(id, tool)
        const [first] = acpVerdictCalls(this.#settings.runtime, tool.call)
        const name = progressName(first?.toolName ?? tool.call.title)
        if (!tool.started) {
          tool.started = true
          this.toolStart(id, name, first?.input ?? { ...tool.call.rawInput })
        }
        const status = update.status
        if (!tool.ended && (status === 'completed' || status === 'failed')) {
          tool.ended = true
          this.toolEnd(id, name, status === 'failed')
        }
        return
      }
      default:
        // Thoughts, usage pressure, plans, modes, commands: signs of life
        // only. `usage_update.used` is an estimate and never counted.
        if (typeof kind === 'string')
          this.emit({ type: 'runtime_status', subtype: kind })
    }
  }

  async #permission(
    id: unknown,
    params: Record<string, unknown>,
  ): Promise<void> {
    const key = JSON.stringify(id)
    const requested = toolArgs(params.toolCall)
    const callId = text(requested.toolCallId)
    const known = callId === undefined ? undefined : this.#tools.get(callId)
    const call = toolCallOf(requested, known?.call)
    const options = (Array.isArray(params.options) ? params.options : []).map(
      toolArgs,
    )
    const option = (kind: string) =>
      text(options.find(one => one.kind === kind)?.optionId)
    let answered = false
    const answer = (granted: boolean) => {
      if (answered) return
      answered = true
      this.#asks.delete(key)
      // Only ever once: never a standing rule inside the harness.
      const chosen = option(granted ? 'allow_once' : 'reject_once')
      this.#reply(id, {
        result: {
          outcome:
            chosen === undefined
              ? { outcome: 'cancelled' }
              : { outcome: 'selected', optionId: chosen },
        },
      })
    }
    if (params.sessionId !== this.#sessionId || !this.busy || this.#aborting) {
      answer(false)
      return
    }
    // An abort answers it at once; the node's late answer is dropped.
    this.#asks.set(key, () => {
      if (answered) return
      answered = true
      this.#asks.delete(key)
      this.#reply(id, { result: { outcome: { outcome: 'cancelled' } } })
    })
    let granted = false
    try {
      granted = await this.#settings.permission(call)
    } catch {
      granted = false
    }
    answer(granted && !this.#aborting)
  }
}
