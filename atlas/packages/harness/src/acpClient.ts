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
 * A tool call as ACP shows it (`tool_call` plus later updates). The same
 * shape as the node catalog's `AcpToolCall`, defined here so the desktop
 * app's runner can use the channel without the node package.
 */
export interface AcpToolCall {
  /** ACP `title`; dsh puts the tool name there. */
  readonly title: string
  /** ACP `kind`: read, edit, delete, move, search, execute, think, fetch, switch_mode, other. */
  readonly kind?: string
  readonly rawInput: Readonly<Record<string, unknown>>
  /** ACP `locations[].path`. */
  readonly paths: readonly string[]
  /** ACP `_meta`, where a harness adds its own facts (Qwen: `toolName`). */
  readonly meta?: Readonly<Record<string, unknown>>
}

/** Where a harness keeps the provider's real usage of one session. */
export interface AcpUsageReader {
  /** Called as a turn starts: where its records will begin. */
  start(): number
  /**
   * The usage the harness recorded since `from`, once the turn's records
   * are complete (bounded wait); `undefined` when it recorded none.
   */
  read(from: number): Promise<RuntimeUsage | undefined>
}

/**
 * What the channel reads of the caller's catalog entry for the harness. The
 * caller passes its whole entry (how to start it, its tools and skills),
 * which is not the channel's business.
 */
export interface AcpChannelRuntime {
  /**
   * How a conversation continues in a new process. Absent: `session/resume`
   * when advertised, else `session/load` when advertised, else a new one.
   */
  readonly resume?: 'session/resume' | 'session/load'
  /** The `session/set_config_option` id effort is set through, when offered. */
  readonly effortOption?: string
  /**
   * `false` when the harness's `PromptResponse.usage` does not cover the
   * whole turn; the turn then counts 0 and says so rather than undercount.
   */
  readonly promptUsage?: false
}

/** A call as the progress line names it, in the caller's vocabulary. */
export interface AcpProgressCall {
  readonly toolName: string
  readonly input: Record<string, unknown>
}

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

export interface AcpSessionSettings<R extends object = object>
  extends RuntimeChannelHooks {
  /** Shown in errors: the catalog label. */
  readonly label: string
  readonly runtime: R & AcpChannelRuntime
  /** The agent's workspace: `session/new {cwd}`. */
  readonly cwd: string
  readonly mcpServers: readonly AcpMcpServer[]
  /** A native session to continue; omitted opens a new one. */
  readonly sessionId?: string
  /** How many starts in a row failed to continue `sessionId` (default 0). */
  readonly resumeFailures?: number
  readonly onSession: (sessionId: string) => void
  /** A start could not continue `sessionId` and failed. */
  readonly onResumeFailed?: () => void
  /** Sent ahead of the first prompt of a new native session. */
  readonly instructions?: string
  readonly effort?: string
  /**
   * The node's answer to `session/request_permission`: `true` is allow
   * once, `false` reject once. Without it and without {@link ask}, every
   * question is rejected.
   */
  readonly permission?: (call: AcpToolCall) => Promise<boolean>
  /**
   * The call as the progress line names it (the resident: the first call of
   * `acpVerdictCalls`); absent or `undefined`: ACP's `title` and `rawInput`.
   */
  readonly progress?: (call: AcpToolCall) => AcpProgressCall | undefined
  /** Where the provider's usage of the native session is, if anywhere. */
  readonly usage?: (sessionId: string) => AcpUsageReader | undefined
  /** Servers left out: the harness does not take their transport. */
  readonly onMcpSkipped?: (names: readonly string[]) => void
  readonly onError?: (error: unknown) => void
  // ---- the desktop app's runner (qmo-local.md §4.3.3); the resident passes none
  /** `initialize`'s `clientInfo` (default: the resident's). */
  readonly clientInfo?: {
    readonly name: string
    readonly title: string
    readonly version: string
  }
  /** What a caller that shows the turn as it happens learns beyond the frames. */
  readonly onDetail?: (detail: AcpDetail) => void
  /**
   * Answers `session/request_permission` with three choices; takes the
   * place of {@link permission}. The answer is the option of that kind the
   * agent offered: `once` its `allow_once`, `deny` its `reject_once`,
   * `session` the one {@link sessionOption} recognized.
   */
  readonly ask?: (request: AcpAsk) => Promise<AcpAskDecision>
  /**
   * Which of the agent's `allow_always` options keeps to this session (not
   * one written into its settings). Absent, or none recognized: `session`
   * is not offered.
   */
  readonly sessionOption?: (option: AcpPermissionOption) => boolean
}

/** One option of `session/request_permission`, as the agent offers it. */
export interface AcpPermissionOption {
  readonly optionId: string
  readonly name: string
  /** `allow_once`, `allow_always`, `reject_once`, `reject_always`. */
  readonly kind: string
}

/** A tool call's content (ACP `ToolCallContent`): its text, or a file's change. */
export type AcpToolContent =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'diff'
      readonly path: string
      /** `null`: a new file. */
      readonly oldText: string | null
      readonly newText: string
    }

/** One of the agent's ACP modes (`session/new`'s `modes.availableModes`). */
export interface AcpMode {
  readonly id: string
  readonly name: string
}

export interface AcpModes {
  readonly current: string | undefined
  readonly available: readonly AcpMode[]
}

/**
 * What the local runner learns beyond the frames: text as it streams, a
 * whole message, thoughts, a tool call with its content as it starts,
 * changes and ends, and the agent's own word that its mode changed.
 */
export type AcpDetail =
  | {
      readonly kind: 'text-delta' | 'message' | 'thinking'
      readonly text: string
    }
  | {
      readonly kind: 'tool'
      readonly phase: 'start' | 'update' | 'end'
      readonly id: string
      readonly call: AcpToolCall
      /** The latest content (ACP replaces it with each update). */
      readonly content: readonly AcpToolContent[]
      /** At the end: it failed. */
      readonly isError?: boolean
    }
  | { readonly kind: 'mode'; readonly modeId: string }

export type AcpAskDecision = 'once' | 'session' | 'deny'

/** A `session/request_permission`, as {@link AcpSessionSettings.ask} gets it. */
export interface AcpAsk {
  /** The tool call it is about (a `start` detail came first). */
  readonly toolCallId?: string
  readonly call: AcpToolCall
  readonly content: readonly AcpToolContent[]
  /** What may be answered: `session` only when an option was recognized. */
  readonly decisions: readonly AcpAskDecision[]
  /** Aborted once the question is answered without the caller (a stop, the exit). */
  readonly signal: AbortSignal
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
/** Starts in a row that fail to continue a session before a new one opens. */
export const ACP_RESUME_ATTEMPTS = 3

/** An error answer to one of our requests. */
export class AcpRpcError extends Error {
  readonly code: number | undefined
  readonly data: unknown
  constructor(message: string, code: number | undefined, data: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

/**
 * Whether the harness answered that it has no such session: ACP's "resource
 * not found", or an error naming the session as unknown (dsh, Qwen Code and
 * Gemini CLI each word it their own way). A timeout or a transient failure
 * is not: the conversation still exists.
 */
export function acpSessionGone(error: unknown): boolean {
  if (!(error instanceof AcpRpcError)) return false
  if (error.code === -32002) return true
  let detail = error.message
  try {
    detail += ` ${JSON.stringify(error.data) ?? ''}`
  } catch {
    // Not serializable; the message alone decides.
  }
  return /not found|no such session|unknown session|invalid session|session does not exist/i.test(
    detail,
  )
}
const CANCEL_GRACE_MS = 5_000
/** A `session/load` replay is over once updates stop this long… */
const REPLAY_QUIET_MS = 200
/** …or after this long at most. */
const REPLAY_WAIT_MS = 5_000
const ZERO_USAGE: RuntimeUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
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
  const meta = toolArgs(update._meta)
  return {
    title: text(update.title) ?? before?.title ?? 'tool',
    ...(kind === undefined ? {} : { kind }),
    rawInput:
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : (before?.rawInput ?? {}),
    paths: locations ?? before?.paths ?? [],
    ...(Object.keys(meta).length > 0
      ? { meta: { ...before?.meta, ...meta } }
      : before?.meta === undefined
        ? {}
        : { meta: before.meta }),
  }
}

/** The draft `PromptResponse.usage`, where a harness fills it. */
function promptUsage(value: unknown): RuntimeUsage | undefined {
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

/** A tool call's `content`, the parts the runner shows; `undefined` when absent. */
function toolContent(value: unknown): AcpToolContent[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: AcpToolContent[] = []
  for (const raw of value) {
    const part = toolArgs(raw)
    if (part.type === 'diff' && typeof part.path === 'string') {
      if (typeof part.newText !== 'string') continue
      out.push({
        type: 'diff',
        path: part.path,
        oldText: typeof part.oldText === 'string' ? part.oldText : null,
        newText: part.newText,
      })
    } else if (part.type === 'content') {
      const block = toolArgs(part.content)
      if (block.type === 'text' && typeof block.text === 'string')
        out.push({ type: 'text', text: block.text })
    }
  }
  return out
}

/** An answer's `modes` (`SessionModeState`), when it has some. */
function modesOf(value: unknown): AcpModes | undefined {
  const modes = toolArgs(value)
  if (!Array.isArray(modes.availableModes)) return undefined
  return {
    current: text(modes.currentModeId),
    available: modes.availableModes
      .map(toolArgs)
      .filter(one => typeof one.id === 'string')
      .map(one => ({
        id: String(one.id),
        name: text(one.name) ?? String(one.id),
      })),
  }
}

/** The local runner's view of one tool call: separate from the frames'. */
interface ShownTool {
  call: AcpToolCall
  content: AcpToolContent[]
  ended: boolean
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
 *
 * The desktop app's runner adds `onDetail`, `ask` and `sessionOption`
 * (qmo-local.md §4.3.3): details are kept apart from the frames, which are
 * the same with them as without; `session/set_mode` through {@link setMode}.
 * It never sends `authenticate`: an agent that is not signed in says so,
 * and the person signs in in a terminal.
 */
export class AcpChannel<R extends object = object> extends RuntimeChannelBase {
  protected readonly runtimeName: string
  readonly #settings: AcpSessionSettings<R>
  readonly #pending = new Map<number, Pending>()
  readonly #tools = new Map<string, TrackedTool>()
  /** The calls as `onDetail` shows them, by tool call id. */
  readonly #shown = new Map<string, ShownTool>()
  /** Permission requests not answered yet, by JSON-RPC id. */
  readonly #asks = new Map<string, () => void>()
  /** Of those, the ones put to {@link AcpSessionSettings.ask}. */
  readonly #asking = new Map<string, AbortController>()
  #modes: AcpModes | undefined
  #sequence = 0
  #sessionId: string | undefined
  #instructionsPending = false
  #text = ''
  #textMessage: string | undefined
  #aborting = false
  #abortTimer: Timer | undefined
  #usage: AcpUsageReader | undefined
  #usageFrom = 0
  /** When the last `session/update` arrived (ms epoch). */
  #lastUpdate = 0

  constructor(child: ChildProcess, settings: AcpSessionSettings<R>) {
    super(child, settings)
    this.runtimeName = settings.label
    this.#settings = settings
    void this.closed.then(
      () => this.#failPending(`${settings.label} exited`),
      () => this.#failPending(`${settings.label} exited`),
    )
    void this.closed
      .catch(() => {})
      .finally(() => {
        // No one is left to hear an answer.
        for (const [key, controller] of this.#asking) {
          this.#asking.delete(key)
          controller.abort()
        }
      })
  }

  get sessionId(): string | undefined {
    return this.#sessionId
  }

  /** The agent's ACP modes, as the session's opening answer gave them. */
  get modes(): AcpModes | undefined {
    return this.#modes
  }

  /** Switches the agent's ACP mode (`session/set_mode`); rejects when it refuses. */
  async setMode(modeId: string): Promise<void> {
    const sessionId = this.#sessionId
    if (sessionId === undefined)
      throw new Error(`${this.runtimeName} session is not open`)
    await this.#request('session/set_mode', { sessionId, modeId }, 15_000)
    if (this.#modes !== undefined)
      this.#modes = { ...this.#modes, current: modeId }
  }

  #detail(detail: AcpDetail): void {
    try {
      this.#settings.onDetail?.(detail)
    } catch {
      // A watcher's failure must not stop the turn.
    }
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
        clientInfo: settings.clientInfo ?? {
          name: 'qianmo',
          title: 'Qianmo resident',
          version: '1',
        },
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
        if (resume === 'session/load') await this.#replayed()
      } catch (error) {
        // The harness no longer has it (wiped home, another node): a new
        // conversation, with the node's instructions again. Anything else
        // (a timeout, a passing failure) fails this start and keeps the
        // conversation, unless it has kept failing.
        if (
          !acpSessionGone(error) &&
          (settings.resumeFailures ?? 0) + 1 < ACP_RESUME_ATTEMPTS
        ) {
          settings.onResumeFailed?.()
          throw error
        }
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
    this.#modes = modesOf(opened?.modes)
    settings.onSession(this.#sessionId)
    this.#usage = settings.usage?.(this.#sessionId)
    await this.#applyEffort(opened ?? {})
    this.markReady()
  }

  /**
   * ACP has the agent replay a loaded conversation before it answers
   * `session/load`; Gemini CLI (0.64) answers first and replays after, and a
   * prompt sent meanwhile would take the old answers for its own. The
   * replay is not a turn's, so it is waited out: until updates have stopped
   * for a moment, a few seconds at most.
   */
  async #replayed(): Promise<void> {
    const answered = Date.now()
    const until = answered + REPLAY_WAIT_MS
    for (;;) {
      const now = Date.now()
      const quiet = now - Math.max(answered, this.#lastUpdate)
      if (quiet >= REPLAY_QUIET_MS || now >= until) return
      await new Promise(resolve =>
        setTimeout(resolve, Math.min(REPLAY_QUIET_MS - quiet, until - now)),
      )
    }
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
  }): Promise<HarnessPromptAdmission> {
    const sessionId = this.#sessionId
    if (sessionId === undefined)
      throw new Error(`${this.runtimeName} session is not open`)
    const requestId = this.beginTurn()
    this.#aborting = false
    this.#text = ''
    this.#textMessage = undefined
    this.#tools.clear()
    this.#shown.clear()
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
    if (this.#text !== '') {
      this.assistantMessage(this.#text)
      this.#detail({ kind: 'message', text: this.#text })
    }
    this.#text = ''
    this.#textMessage = undefined
  }

  async #turnUsage(answer: Record<string, unknown>): Promise<{
    usage: RuntimeUsage
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
    const usage =
      this.#settings.runtime.promptUsage === false
        ? undefined
        : promptUsage(answer.usage)
    return usage === undefined
      ? { usage: ZERO_USAGE, reported: false }
      : { usage, reported: true }
  }

  /** The turn's usage: never estimated; 0 and marked when not reported. */
  #usageMessage(
    usage: RuntimeUsage,
    reported: boolean,
    stopReason?: string,
  ): void {
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
          new AcpRpcError(
            `${this.runtimeName} ${pending.method}: ${String(error.message ?? 'error')}`,
            typeof error.code === 'number' ? error.code : undefined,
            error.data,
          ),
        )
      else pending.resolve(message.result)
      return
    }
    // Notifications other than session updates are not ours to act on.
    if (method === 'session/update') {
      this.#lastUpdate = Date.now()
      this.#update(toolArgs(message.params))
    }
  }

  #update(params: Record<string, unknown>): void {
    if (params.sessionId === this.#sessionId) this.#modeUpdate(params.update)
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
        this.#detail({ kind: 'text-delta', text: content.text })
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
        const first = this.#settings.progress?.(tool.call)
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
        this.#showTool(id, update, true)
        return
      }
      default:
        if (kind === 'agent_thought_chunk') {
          const content = toolArgs(update.content)
          if (content.type === 'text' && typeof content.text === 'string')
            this.#detail({ kind: 'thinking', text: content.text })
        }
        // Thoughts, usage pressure, plans, modes, commands: signs of life
        // only. `usage_update.used` is an estimate and never counted.
        if (typeof kind === 'string')
          this.emit({ type: 'runtime_status', subtype: kind })
    }
  }

  /** `current_mode_update`, in a turn or not: the agent switched itself. */
  #modeUpdate(value: unknown): void {
    const update = toolArgs(value)
    const modeId = update.currentModeId
    if (update.sessionUpdate !== 'current_mode_update') return
    if (typeof modeId !== 'string') return
    if (this.#modes !== undefined)
      this.#modes = { ...this.#modes, current: modeId }
    this.#detail({ kind: 'mode', modeId })
  }

  /**
   * The call as `onDetail` shows it: a `start` the first time it is heard
   * of (in an update, or in a question about it, which Gemini CLI sends
   * before announcing the call), `update` as its content changes, `end`
   * once an update says it completed or failed.
   */
  #showTool(id: string, update: Record<string, unknown>, ends: boolean): void {
    if (this.#settings.onDetail === undefined) return
    const known = this.#shown.get(id)
    const content = toolContent(update.content)
    const shown: ShownTool = known ?? {
      call: toolCallOf(update),
      content: content ?? [],
      ended: false,
    }
    if (known !== undefined) {
      shown.call = toolCallOf(update, known.call)
      if (content !== undefined) shown.content = content
    }
    this.#shown.set(id, shown)
    const view = { kind: 'tool', id, call: shown.call } as const
    if (known === undefined)
      this.#detail({ ...view, phase: 'start', content: shown.content })
    const status = update.status
    if (
      ends &&
      !shown.ended &&
      (status === 'completed' || status === 'failed')
    ) {
      shown.ended = true
      this.#detail({
        ...view,
        phase: 'end',
        content: shown.content,
        isError: status === 'failed',
      })
    } else if (known !== undefined && !shown.ended && content !== undefined)
      this.#detail({ ...view, phase: 'update', content: shown.content })
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
    /** The option chosen; `undefined`: cancelled. */
    const reply = (chosen: string | undefined) => {
      if (answered) return
      answered = true
      this.#asks.delete(key)
      this.#asking.delete(key)
      this.#reply(id, {
        result: {
          outcome:
            chosen === undefined
              ? { outcome: 'cancelled' }
              : { outcome: 'selected', optionId: chosen },
        },
      })
    }
    // Only ever once: never a standing rule inside the harness.
    const answer = (granted: boolean) =>
      reply(option(granted ? 'allow_once' : 'reject_once'))
    if (params.sessionId !== this.#sessionId || !this.busy || this.#aborting) {
      answer(false)
      return
    }
    const ask = this.#settings.ask
    if (ask !== undefined) {
      await this.#askLocal(key, ask, callId, requested, call, options, reply)
      return
    }
    // An abort answers it at once; the node's late answer is dropped.
    this.#asks.set(key, () => reply(undefined))
    let granted = false
    try {
      granted = (await this.#settings.permission?.(call)) ?? false
    } catch {
      granted = false
    }
    answer(granted && !this.#aborting)
  }

  /**
   * A question put to the local runner: once, for the session (only the
   * `allow_always` option {@link AcpSessionSettings.sessionOption}
   * recognizes, never another), or no. A stop or the process's end cancels
   * it and aborts the request's signal.
   */
  async #askLocal(
    key: string,
    ask: (request: AcpAsk) => Promise<AcpAskDecision>,
    callId: string | undefined,
    requested: Record<string, unknown>,
    call: AcpToolCall,
    options: readonly Record<string, unknown>[],
    reply: (chosen: string | undefined) => void,
  ): Promise<void> {
    // The words before the call, then the call, then the question.
    if (this.#settings.onDetail !== undefined) this.#flushText()
    if (callId !== undefined) this.#showTool(callId, requested, false)
    const shown = callId === undefined ? undefined : this.#shown.get(callId)
    const recognize = this.#settings.sessionOption
    const forSession =
      recognize === undefined
        ? undefined
        : options.find(
            one =>
              one.kind === 'allow_always' &&
              typeof one.optionId === 'string' &&
              recognize({
                optionId: one.optionId,
                name: text(one.name) ?? '',
                kind: 'allow_always',
              }),
          )
    const controller = new AbortController()
    this.#asking.set(key, controller)
    this.#asks.set(key, () => {
      controller.abort()
      reply(undefined)
    })
    let decision: AcpAskDecision = 'deny'
    try {
      decision = await ask({
        ...(callId === undefined ? {} : { toolCallId: callId }),
        call: shown?.call ?? call,
        content: shown?.content ?? toolContent(requested.content) ?? [],
        decisions:
          forSession === undefined
            ? ['once', 'deny']
            : ['once', 'session', 'deny'],
        signal: controller.signal,
      })
    } catch {
      decision = 'deny'
    }
    const option = (kind: string) =>
      text(options.find(one => one.kind === kind)?.optionId)
    reply(
      decision === 'deny'
        ? option('reject_once')
        : decision === 'session' && forSession !== undefined
          ? text(forSession.optionId)
          : option('allow_once'),
    )
  }
}
