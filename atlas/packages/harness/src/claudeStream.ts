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
