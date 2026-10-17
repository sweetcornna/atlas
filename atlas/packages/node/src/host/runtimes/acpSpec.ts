// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a catalog entry tells the generic ACP channel about one harness
 * (`harness-backends.md` §5): how to start it for one agent, where its
 * native skills live, how a conversation continues after a restart, where
 * the real token usage is, and how its tool calls read in the node's
 * permission vocabulary. The channel (`acp.ts`) and the pool never branch on
 * a harness id; every difference lives here.
 */

/** Model lanes a runtime can call (a subset of `@qianmo/providers` lanes). */
export type RuntimeLane =
  | 'openai-chat'
  | 'anthropic'
  | 'openai-responses'
  | 'gemini'

/** What an ACP runtime's launcher gets for one agent's process. */
export interface AcpLaunchInput {
  /** The executable to start (managed prefix, PATH, or a flag). */
  readonly bin: string
  readonly model: string
  readonly lane: RuntimeLane
  /**
   * The lane's base URL as its paths append to it: ending in `/v1` for
   * `openai-chat` (`…/v1/chat/completions`), the root for `anthropic`
   * (`…/v1/messages`), the root or `<root>/v1beta` for `gemini` (as
   * `@qianmo/providers` writes it; launchers that append the version strip
   * it).
   */
  readonly baseUrl: string
  readonly apiKey: string
  readonly headers?: Readonly<Record<string, string>>
  readonly effort?: string
  /** The model's context window and output ceiling, when the node knows them. */
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  /** This agent's private state directory for the harness (0700). */
  readonly home: string
  /**
   * A directory of this one process (0700, under the protected config root)
   * for launch files; it is removed when the process ends.
   */
  readonly runDir: string
  /** The agent's workspace: `session/new {cwd}`. */
  readonly cwd: string
  /** The node's tool bridge for this process. */
  readonly bridge: AcpBridge
}

/** The node's tool bridge (`qm runtime-mcp`) as one process starts it. */
export interface AcpBridge {
  /** The MCP server name (`qianmo`). */
  readonly name: string
  /** Absolute. */
  readonly command: string
  readonly args: readonly string[]
  /**
   * How long one call may run before the harness gives up on it: host
   * tools can wait for a person (`qianmo_ask`).
   */
  readonly timeoutMs: number
}

/** How to start one ACP runtime child. */
export interface AcpLaunch {
  readonly argv: readonly string[]
  /** Added on top of the node's inherited allowlisted environment. */
  readonly env: Readonly<Record<string, string>>
  /**
   * Files the harness reads, written (0600) before the start; only paths
   * inside `runDir` or `home` are written.
   */
  readonly files?: readonly {
    readonly path: string
    readonly content: string
  }[]
  /**
   * The child's working directory, created empty (0700) when missing; absent
   * is the workspace. A harness that reads a `.env` or project config from
   * its launch directory starts in one of its own.
   */
  readonly cwd?: string
  /** Directories the harness expects to exist (created 0700). */
  readonly dirs?: readonly string[]
  /**
   * The launch starts the bridge itself, with its timeout, where servers
   * from `session/new` get a fixed call timeout shorter than the bridge
   * needs; `session/new` then leaves it out.
   */
  readonly mountsBridge?: boolean
}

/** One turn's token usage, as the turn port records it. */
export interface AcpUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** Where a harness keeps the provider's real usage of one session. */
export interface AcpUsageReader {
  /** Called as a turn starts: where its records will begin. */
  start(): number
  /**
   * The usage the harness recorded since `from`, once the turn's records
   * are complete (bounded wait); `undefined` when it recorded none.
   */
  read(from: number): Promise<AcpUsage | undefined>
}

/** A tool call as ACP shows it (`tool_call` plus later updates). */
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

/** One call in the node's permission vocabulary (`residentToolVerdict`). */
export interface AcpVerdictCall {
  readonly toolName: string
  readonly input: Record<string, unknown>
}

export interface AcpRuntime {
  readonly launch: (input: AcpLaunchInput) => AcpLaunch
  /**
   * The node's skills directory under `home`, which the harness loads
   * natively (`<name>/SKILL.md` with `name` and `description`): P32 lands
   * the agent's skills there and touches nothing else of the harness's
   * state; absent = the harness takes no skills.
   */
  readonly skillsDir?: string
  /**
   * Transports of the operator's MCP servers (P32) the node passes in
   * `session/new`; empty when it cannot decide their calls on this harness.
   * The node's own bridge is always passed (or mounted by the launch).
   */
  readonly mcpTransports: readonly ('stdio' | 'http' | 'sse')[]
  /**
   * How a conversation continues in a new process. Absent: `session/resume`
   * when advertised, else `session/load` when advertised, else a new one.
   */
  readonly resume?: 'session/resume' | 'session/load'
  /** The `session/set_config_option` id effort is set through, when offered. */
  readonly effortOption?: string
  /**
   * `false` when the harness's `PromptResponse.usage` does not cover the
   * whole turn (opencode: its last model call only); the turn then counts 0
   * and says so rather than undercount.
   */
  readonly promptUsage?: false
  /** Where the provider's real usage is, when ACP does not carry it. */
  readonly usage?: (session: {
    readonly home: string
    readonly cwd: string
    readonly sessionId: string
  }) => AcpUsageReader
  /**
   * The call in the node's vocabulary, for the permission decision and the
   * progress line; absent uses the ACP `kind` and `locations`. Several
   * calls: every one must pass.
   */
  readonly toolCall?: (call: AcpToolCall) => readonly AcpVerdictCall[]
}
