// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChildProcess } from 'node:child_process'
import { RUNTIME_MCP_SERVER } from './claudeStream.js'
import {
  type HarnessPromptAdmission,
  nonNegative,
  RuntimeChannelBase,
  type RuntimeChannelHooks,
  type RuntimeUsage,
  toolArgs,
} from './process.js'

/**
 * What a caller that shows the turn as it happens learns beyond the turn
 * port's frames (qmo-local.md §4.3.3, §4.3.5). Tool items are the four the
 * frames know (`commandExecution`, `fileChange`, `mcpToolCall`,
 * `webSearch`), as the app-server sent them.
 */
export type CodexDetail =
  | {
      readonly kind: 'text-delta' | 'message'
      /** The `agentMessage` item. */
      readonly item: string
      readonly text: string
    }
  | { readonly kind: 'thinking'; readonly text: string }
  | {
      readonly kind: 'tool'
      readonly phase: 'start' | 'end'
      readonly id: string
      readonly item: Readonly<Record<string, unknown>>
    }
  /** `item/commandExecution/outputDelta`: a command's output as it comes. */
  | { readonly kind: 'tool-output'; readonly id: string; readonly text: string }
  /** `turn/diff/updated`: the turn's changes so far, one unified diff. */
  | { readonly kind: 'turn-diff'; readonly turn: string; readonly diff: string }
  /** A turn that did not complete: its `error` as Codex gave it. */
  | {
      readonly kind: 'turn-error'
      readonly error: Readonly<Record<string, unknown>>
    }

export type CodexAskDecision = 'once' | 'session' | 'deny'

/** An approval the app-server asks the client for. */
export interface CodexAsk {
  readonly kind: 'command' | 'file-change' | 'mcp-tool'
  /** The resident's names for it: `bash`, `edit`, `mcp__<server>__<tool>`. */
  readonly toolName: string
  /** What the resident's policy reads. */
  readonly input: Record<string, unknown>
  /** The item it is about, when Codex says (`itemId`). */
  readonly itemId?: string
  /** The request's params as they came. */
  readonly params: Readonly<Record<string, unknown>>
  /**
   * The answers it takes: `session` only where Codex has one for the
   * session (`acceptForSession`).
   */
  readonly options: readonly CodexAskDecision[]
  /**
   * Aborted once Codex no longer waits for the answer: resolved
   * (`serverRequest/resolved`), the turn over, the process gone.
   */
  readonly signal: AbortSignal
}

/** One request of the channel's own to the app-server, answered by its `result`. */
export type CodexRequest = (method: string, params: unknown) => Promise<unknown>

export interface CodexChannelOptions extends RuntimeChannelHooks {
  /**
   * The `thread/start` params (`thread/resume` adds the `threadId`), asked
   * after `initialized`; it may ask the app-server first.
   */
  readonly thread: (
    request: CodexRequest,
  ) => Promise<Readonly<Record<string, unknown>>>
  /** A thread to resume; omitted starts a new one. */
  readonly threadId?: string
  readonly onThread: (threadId: string) => void
  /**
   * Answers the app-server's approvals: `once` is `accept`, `session` is
   * `acceptForSession`, `deny` is `decline`. Never an execpolicy or a
   * network policy amendment, which would write into the agent's own
   * rules. Without it every approval is declined.
   */
  readonly ask?: (request: CodexAsk) => Promise<CodexAskDecision>
  readonly onDetail?: (detail: CodexDetail) => void
}

/** Codex's own answers for the session: what `availableDecisions` lists. */
function commandOptions(
  params: Record<string, unknown>,
): readonly CodexAskDecision[] {
  const listed = params.availableDecisions
  return Array.isArray(listed) && !listed.includes('acceptForSession')
    ? ['once', 'deny']
    : ['once', 'session', 'deny']
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
 * One `codex app-server` over stdio, holding one thread for one session.
 * JSON-RPC 2.0 without the `jsonrpc` field: requests `{id, method, params}`,
 * notifications `{method, params}`, server requests carry both.
 */
export class CodexChannel extends RuntimeChannelBase {
  protected readonly runtimeName = 'Codex'
  readonly #settings: CodexChannelOptions
  readonly #pending = new Map<number, Pending>()
  #sequence = 0
  #threadId: string | undefined
  #turnId: string | undefined
  #aborting = false
  /** Approvals not answered yet, by request id. */
  readonly #asks = new Map<string, AbortController>()
  /** Thread token totals when the current turn started. */
  #baseline: RuntimeUsage | undefined
  #latest: RuntimeUsage | undefined

  constructor(child: ChildProcess, settings: CodexChannelOptions) {
    super(child, settings)
    this.#settings = settings
    void this.closed.then(
      () => this.#failPending('Codex app-server exited'),
      () => this.#failPending('Codex app-server exited'),
    )
    void this.closed.catch(() => {}).finally(() => this.#endAsks())
  }

  #detail(detail: CodexDetail): void {
    try {
      this.#settings.onDetail?.(detail)
    } catch {
      // A watcher's failure must not stop the turn.
    }
  }

  /** Every approval still open is no longer waited for. */
  #endAsks(): void {
    for (const [id, controller] of this.#asks) {
      this.#asks.delete(id)
      controller.abort()
    }
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
    const thread = await settings.thread((method, params) =>
      this.#request(method, params),
    )
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

  /**
   * Starts a turn. `approvalPolicy` and `sandboxPolicy`, when given, go in
   * this `turn/start` (Codex's own overrides, from this turn on).
   */
  async prompt(input: {
    readonly messageId: string
    readonly text: string
    readonly approvalPolicy?: string
    readonly sandboxPolicy?: Readonly<Record<string, unknown>>
  }): Promise<HarnessPromptAdmission> {
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
        ...(input.approvalPolicy === undefined
          ? {}
          : { approvalPolicy: input.approvalPolicy }),
        ...(input.sandboxPolicy === undefined
          ? {}
          : { sandboxPolicy: input.sandboxPolicy }),
      })
    } catch (error) {
      if (this.currentRequest === requestId) this.currentRequest = undefined
      throw error
    }
    const turnId = toolArgs(toolArgs(result).turn).id
    if (typeof turnId === 'string' && this.currentRequest === requestId) {
      this.#turnId = turnId
      // Stopped while turn/start was pending: the interrupt goes now that
      // the turn has an id.
      if (this.#aborting)
        void this.#request('turn/interrupt', { threadId, turnId }).catch(
          () => {},
        )
    }
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
      case 'item/agentMessage/delta':
        if (
          typeof params.itemId === 'string' &&
          typeof params.delta === 'string'
        )
          this.#detail({
            kind: 'text-delta',
            item: params.itemId,
            text: params.delta,
          })
        break
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        if (typeof params.delta === 'string')
          this.#detail({ kind: 'thinking', text: params.delta })
        break
      case 'item/commandExecution/outputDelta':
        if (
          typeof params.itemId === 'string' &&
          typeof params.delta === 'string'
        )
          this.#detail({
            kind: 'tool-output',
            id: params.itemId,
            text: params.delta,
          })
        break
      case 'turn/diff/updated':
        if (typeof params.diff === 'string')
          this.#detail({
            kind: 'turn-diff',
            turn: typeof params.turnId === 'string' ? params.turnId : '',
            diff: params.diff,
          })
        break
      case 'serverRequest/resolved': {
        // Answered or withdrawn on Codex's side: no longer waited for.
        const id = params.requestId
        const open =
          typeof id === 'string' || typeof id === 'number'
            ? this.#asks.get(String(id))
            : undefined
        if (open !== undefined) {
          this.#asks.delete(String(id))
          open.abort()
        }
        break
      }
    }
    this.emit({ type: 'runtime_status', subtype: method })
  }

  /** The tool items the frames know, for `onDetail`. */
  #toolDetail(phase: 'start' | 'end', item: Record<string, unknown>): void {
    if (
      typeof item.id === 'string' &&
      (item.type === 'commandExecution' ||
        item.type === 'fileChange' ||
        item.type === 'mcpToolCall' ||
        item.type === 'webSearch')
    )
      this.#detail({ kind: 'tool', phase, id: item.id, item })
  }

  #itemStarted(item: Record<string, unknown>): void {
    const id = typeof item.id === 'string' ? item.id : undefined
    if (id === undefined) return
    this.#frameStarted(id, item)
    this.#toolDetail('start', item)
  }

  #frameStarted(id: string, item: Record<string, unknown>): void {
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
    this.#frameCompleted(item)
    if (
      item.type === 'agentMessage' &&
      typeof item.id === 'string' &&
      typeof item.text === 'string' &&
      item.text !== ''
    )
      this.#detail({ kind: 'message', item: item.id, text: item.text })
    else this.#toolDetail('end', item)
  }

  #frameCompleted(item: Record<string, unknown>): void {
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
    // Nothing of a turn that is over is waited for.
    this.#endAsks()
    if (this.#latest !== undefined)
      this.assistantMessage('', minus(this.#latest, this.#baseline))
    const error = toolArgs(turn.error)
    if (turn.status !== 'completed' && Object.keys(error).length > 0)
      this.#detail({ kind: 'turn-error', error })
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
      request: Omit<CodexAsk, 'params' | 'signal'>,
    ): Promise<CodexAskDecision> => {
      const answer = this.#settings.ask
      if (answer === undefined) return 'deny'
      const key = String(id)
      const controller = new AbortController()
      this.#asks.set(key, controller)
      try {
        return await answer({ ...request, params, signal: controller.signal })
      } catch {
        return 'deny'
      } finally {
        if (this.#asks.get(key) === controller) this.#asks.delete(key)
      }
    }
    const itemId =
      typeof params.itemId === 'string' ? { itemId: params.itemId } : {}
    // `session` only where it was offered; otherwise it is `once`.
    const decision = (
      answer: CodexAskDecision,
      options: readonly CodexAskDecision[],
    ) =>
      answer === 'deny'
        ? 'decline'
        : answer === 'session' && options.includes('session')
          ? 'acceptForSession'
          : 'accept'
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const options = commandOptions(params)
        const answer = await ask({
          kind: 'command',
          toolName: 'bash',
          input: {
            command: params.command ?? '',
            ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
            ...(typeof params.reason === 'string'
              ? { reason: params.reason }
              : {}),
          },
          ...itemId,
          options,
        })
        this.#reply(id, { decision: decision(answer, options) })
        return
      }
      case 'item/fileChange/requestApproval': {
        const answer = await ask({
          kind: 'file-change',
          toolName: 'edit',
          input: {
            ...(typeof params.reason === 'string'
              ? { reason: params.reason }
              : {}),
            ...(typeof params.grantRoot === 'string'
              ? { path: params.grantRoot }
              : {}),
          },
          ...itemId,
          options: ['once', 'session', 'deny'],
        })
        this.#reply(id, {
          decision: decision(answer, ['once', 'session', 'deny']),
        })
        return
      }
      case 'execCommandApproval':
      case 'applyPatchApproval': {
        const answer = await ask({
          kind: method === 'execCommandApproval' ? 'command' : 'file-change',
          toolName: method === 'execCommandApproval' ? 'bash' : 'edit',
          input: { command: params.command ?? '', reason: params.reason ?? '' },
          options: ['once', 'deny'],
        })
        this.#reply(id, {
          decision:
            answer !== 'deny'
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
          const granted =
            (await ask({
              kind: 'mcp-tool',
              toolName: `mcp__${server}__${tool}`,
              input: {
                server,
                tool,
                ...(typeof params.message === 'string'
                  ? { message: params.message }
                  : {}),
              },
              options: ['once', 'deny'],
            })) !== 'deny'
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
