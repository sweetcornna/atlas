// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChildProcess } from 'node:child_process'
import {
  type HarnessPromptAdmission,
  nonNegative,
  RuntimeChannelBase,
  type RuntimeChannelHooks,
  type RuntimeUsage,
  toolArgs,
} from './process.js'

/** The MCP server name the host's tools are registered under. */
export const RUNTIME_MCP_SERVER = 'qianmo'

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
/** How long a control request of ours (`set_permission_mode`) waits for its answer. */
const CONTROL_TIMEOUT_MS = 10_000
const DENIED = 'The user denied this action.'
const STOPPED = 'The turn was stopped before this was answered.'
const UNASKED = 'Nobody here answers permission questions.'

/**
 * What a caller that shows the turn as it happens learns beyond the turn
 * port's frames (qmo-local.md §4.3.3). `parent` is set on what a sub-agent
 * (a `Task` tool call) said or did.
 */
export type ClaudeDetail =
  | {
      readonly kind: 'text-delta' | 'thinking' | 'message'
      readonly text: string
      readonly parent?: string
    }
  | {
      readonly kind: 'tool'
      readonly phase: 'start'
      readonly id: string
      readonly name: string
      readonly input: Readonly<Record<string, unknown>>
      readonly parent?: string
    }
  | {
      readonly kind: 'tool'
      readonly phase: 'end'
      readonly id: string
      readonly name: string
      readonly isError: boolean
      /** The result's text, whole; cutting it is the caller's. */
      readonly output: string
      readonly parent?: string
    }
  | {
      readonly kind: 'mode'
      readonly permissionMode?: string
      readonly model?: string
      readonly sessionId?: string
    }

/** A `can_use_tool` question, as Claude Code asks it on stdout. */
export interface ClaudeAsk {
  readonly requestId: string
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
  readonly toolUseId?: string
  readonly description?: string
  readonly blockedPath?: string
  /** Claude Code's `permission_suggestions`, as it gave them. */
  readonly suggestions: readonly Readonly<Record<string, unknown>>[]
  /** Aborted once the question is answered `deny` without the caller (stop, exit). */
  readonly signal: AbortSignal
}

export type ClaudeAskDecision = 'once' | 'session' | 'deny'

/** `deny` may carry a sentence for the agent. */
export type ClaudeAskAnswer =
  | ClaudeAskDecision
  | { readonly decision: ClaudeAskDecision; readonly message?: string }

export interface ClaudeChannelOptions extends RuntimeChannelHooks {
  readonly onSessionStarted?: () => void
  readonly onDetail?: (detail: ClaudeDetail) => void
  /**
   * Answers `can_use_tool` (`--permission-prompt-tool stdio`). Without it a
   * question is denied: the resident asks through its MCP prompt tool and
   * never gets one.
   */
  readonly ask?: (request: ClaudeAsk) => Promise<ClaudeAskAnswer>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A tool result's text: a string, or the text blocks of a list. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : '',
    )
    .filter(text => text !== '')
    .join('\n')
}

function parentOf(message: Record<string, unknown>): { parent?: string } {
  return typeof message.parent_tool_use_id === 'string'
    ? { parent: message.parent_tool_use_id }
    : {}
}

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
  /** Claude Code's own names of the tools in flight, for `onDetail`. */
  readonly #toolNames = new Map<string, string>()
  readonly #onSessionStarted: (() => void) | undefined
  readonly #onDetail: ((detail: ClaudeDetail) => void) | undefined
  readonly #ask: ClaudeChannelOptions['ask']
  /** Our control requests waiting for their `control_response`, by id. */
  readonly #pending = new Map<
    string,
    {
      readonly resolve: (response: Record<string, unknown>) => void
      readonly reject: (error: Error) => void
    }
  >()
  /** Claude Code's questions not answered yet, by request id. */
  readonly #asks = new Map<string, AbortController>()
  #aborting = false
  #abortTimer: Timer | undefined
  #lastStopReason: string | undefined
  #control = 0

  constructor(child: ChildProcess, options: ClaudeChannelOptions = {}) {
    super(child, options)
    this.#onSessionStarted = options.onSessionStarted
    this.#onDetail = options.onDetail
    this.#ask = options.ask
    void this.closed
      .catch(() => {})
      .finally(() => {
        for (const [id, waiter] of this.#pending) {
          this.#pending.delete(id)
          waiter.reject(new Error(`${this.runtimeName} is closed`))
        }
        for (const [id, controller] of this.#asks) {
          this.#asks.delete(id)
          controller.abort()
        }
      })
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
  }): Promise<HarnessPromptAdmission> {
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
    // Questions still open are answered first: an interrupt does not reach
    // a turn that waits on one.
    for (const [id, controller] of this.#asks) {
      this.#asks.delete(id)
      controller.abort()
      this.#permission(id, { behavior: 'deny', message: STOPPED })
    }
    try {
      // Its answer is taken and dropped; the turn ends on `result` or below.
      void this.#request({ subtype: 'interrupt' }).catch(() => {})
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

  /**
   * Changes Claude Code's permission mode now (`set_permission_mode`);
   * rejects with its error when it refuses (`auto` not enabled, say).
   */
  async setPermissionMode(mode: string): Promise<void> {
    await this.#request({ subtype: 'set_permission_mode', mode })
  }

  /** Sends one control request and waits for the answer with its id. */
  #request(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `qianmo-${++this.#control}`
    const { promise, resolve, reject } =
      Promise.withResolvers<Record<string, unknown>>()
    const timer = setTimeout(() => {
      if (this.#pending.delete(id))
        reject(
          new Error(`${this.runtimeName} did not answer ${request.subtype}`),
        )
    }, CONTROL_TIMEOUT_MS)
    timer.unref()
    this.#pending.set(id, {
      resolve: response => {
        clearTimeout(timer)
        resolve(response)
      },
      reject: error => {
        clearTimeout(timer)
        reject(error)
      },
    })
    try {
      this.write({ type: 'control_request', request_id: id, request })
    } catch (error) {
      this.#pending.delete(id)
      clearTimeout(timer)
      throw error
    }
    return promise
  }

  #detail(detail: ClaudeDetail): void {
    try {
      this.#onDetail?.(detail)
    } catch {
      // A watcher's failure must not stop the turn.
    }
  }

  #permission(requestId: string, response: Record<string, unknown>): void {
    try {
      this.write({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response },
      })
    } catch {
      // Closed: there is no one left to answer.
    }
  }

  protected handleMessage(message: Record<string, unknown>): void {
    switch (message.type) {
      case 'assistant':
        this.#assistant(toolArgs(message.message), parentOf(message))
        return
      case 'user':
        this.#toolResults(toolArgs(message.message), parentOf(message))
        return
      case 'result':
        this.#result(message)
        return
      case 'system':
        if (message.subtype === 'init') {
          this.markReady()
          this.#detail({
            kind: 'mode',
            ...(typeof message.permissionMode === 'string'
              ? { permissionMode: message.permissionMode }
              : {}),
            ...(typeof message.model === 'string'
              ? { model: message.model }
              : {}),
            ...(typeof message.session_id === 'string'
              ? { sessionId: message.session_id }
              : {}),
          })
        }
        // `api_retry` and every other status line keep the watchdog fed.
        this.emit({ type: 'runtime_status', subtype: message.subtype })
        return
      case 'stream_event':
        this.#streamEvent(toolArgs(message.event), parentOf(message))
        this.emit({ type: 'runtime_status', subtype: message.type })
        return
      case 'control_request':
        this.#controlRequest(message)
        this.emit({ type: 'runtime_status', subtype: message.type })
        return
      case 'control_response':
        this.#controlResponse(toolArgs(message.response))
        this.emit({ type: 'runtime_status', subtype: message.type })
        return
      default:
        this.emit({ type: 'runtime_status', subtype: message.type })
    }
  }

  /** `--include-partial-messages`: text and thinking as they are written. */
  #streamEvent(
    event: Record<string, unknown>,
    parent: { parent?: string },
  ): void {
    if (event.type !== 'content_block_delta') return
    const delta = toolArgs(event.delta)
    if (delta.type === 'text_delta' && typeof delta.text === 'string')
      this.#detail({ kind: 'text-delta', text: delta.text, ...parent })
    else if (
      delta.type === 'thinking_delta' &&
      typeof delta.thinking === 'string'
    )
      this.#detail({ kind: 'thinking', text: delta.thinking, ...parent })
  }

  #controlResponse(response: Record<string, unknown>): void {
    const id = response.request_id
    if (typeof id !== 'string') return
    const waiter = this.#pending.get(id)
    if (waiter === undefined) return
    this.#pending.delete(id)
    if (response.subtype === 'error')
      waiter.reject(
        new Error(
          typeof response.error === 'string' && response.error !== ''
            ? response.error
            : `${this.runtimeName} refused the request`,
        ),
      )
    else waiter.resolve(toolArgs(response.response))
  }

  /** A question from Claude Code: `can_use_tool` goes to `ask`. */
  #controlRequest(message: Record<string, unknown>): void {
    const id = message.request_id
    if (typeof id !== 'string') return
    const request = toolArgs(message.request)
    const ask = this.#ask
    if (request.subtype !== 'can_use_tool') {
      // Only a caller that answers questions hears of others.
      if (ask !== undefined)
        try {
          this.write({
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: id,
              error: `unsupported control request: ${String(request.subtype)}`,
            },
          })
        } catch {}
      return
    }
    if (ask === undefined) {
      this.#permission(id, { behavior: 'deny', message: UNASKED })
      return
    }
    const input = toolArgs(request.input)
    const suggestions = Array.isArray(request.permission_suggestions)
      ? request.permission_suggestions.filter(isRecord)
      : []
    const controller = new AbortController()
    this.#asks.set(id, controller)
    const answered = (answer: ClaudeAskAnswer | undefined) => {
      if (!this.#asks.delete(id)) return // Denied already (stop, exit).
      const { decision, message: said } =
        typeof answer === 'object'
          ? answer
          : { decision: answer ?? 'deny', message: undefined }
      if (decision === 'deny')
        this.#permission(id, {
          behavior: 'deny',
          message: said !== undefined && said !== '' ? said : DENIED,
        })
      else
        this.#permission(id, {
          behavior: 'allow',
          updatedInput: input,
          // 「本会话都允许」: Claude Code's own suggestions, kept to this
          // session; never written into the user's settings.
          ...(decision === 'session' && suggestions.length > 0
            ? {
                updatedPermissions: suggestions.map(one => ({
                  ...one,
                  destination: 'session',
                })),
              }
            : {}),
        })
    }
    Promise.resolve()
      .then(() =>
        ask({
          requestId: id,
          toolName:
            typeof request.tool_name === 'string' ? request.tool_name : '',
          input,
          ...(typeof request.tool_use_id === 'string'
            ? { toolUseId: request.tool_use_id }
            : {}),
          ...(typeof request.description === 'string'
            ? { description: request.description }
            : {}),
          ...(typeof request.blocked_path === 'string'
            ? { blockedPath: request.blocked_path }
            : {}),
          suggestions,
          signal: controller.signal,
        }),
      )
      .then(answered, () => answered('deny'))
  }

  #assistant(
    message: Record<string, unknown>,
    parent: { parent?: string },
  ): void {
    const blocks = Array.isArray(message.content) ? message.content : []
    let text = ''
    for (const raw of blocks) {
      const block = toolArgs(raw)
      if (block.type === 'text' && typeof block.text === 'string')
        text += block.text
      else if (block.type === 'tool_use' && typeof block.id === 'string') {
        const own = String(block.name ?? 'tool')
        const name = claudeCodeToolName(own)
        this.#tools.set(block.id, name)
        this.toolStart(block.id, name, toolArgs(block.input))
        if (this.#onDetail !== undefined) this.#toolNames.set(block.id, own)
        this.#detail({
          kind: 'tool',
          phase: 'start',
          id: block.id,
          name: own,
          input: toolArgs(block.input),
          ...parent,
        })
      }
    }
    if (typeof message.stop_reason === 'string')
      this.#lastStopReason =
        message.stop_reason === 'max_tokens' ? 'length' : message.stop_reason
    if (text !== '') {
      this.assistantMessage(text)
      this.#detail({ kind: 'message', text, ...parent })
    }
  }

  #toolResults(
    message: Record<string, unknown>,
    parent: { parent?: string },
  ): void {
    const blocks = Array.isArray(message.content) ? message.content : []
    for (const raw of blocks) {
      const block = toolArgs(raw)
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string')
        continue
      const name = this.#tools.get(block.tool_use_id) ?? 'tool'
      this.#tools.delete(block.tool_use_id)
      this.toolEnd(block.tool_use_id, name, block.is_error === true)
      const own = this.#toolNames.get(block.tool_use_id) ?? name
      this.#toolNames.delete(block.tool_use_id)
      this.#detail({
        kind: 'tool',
        phase: 'end',
        id: block.tool_use_id,
        name: own,
        isError: block.is_error === true,
        output: resultText(block.content),
        ...parent,
      })
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
