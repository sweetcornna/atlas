// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the resident runtime needs from one `omp --mode rpc` child, stated
 * structurally (design `base-switch-omp.md` §4).
 *
 * This package stays a leaf: it never imports omp. The host (`@qianmo/node`,
 * `src/host/residentOmp.ts`) owns the processes, the RPC client and the session
 * directories, and hands the turn port these two small seams. Everything that
 * reads the RPC event stream — admission, content, failures, progress, the
 * inactivity watchdog — lives here, so it is testable with a scripted channel
 * and no child process.
 *
 * Frames are the RPC wire's own JSON objects (`docs/rpc.md`): session events
 * (`agent_start`, `message_end`, `tool_execution_*`, `auto_retry_*`, …),
 * `prompt_result` and `session_settled`. Only the fields read below are relied
 * on; anything else passes through untouched.
 */

/** One outbound RPC frame (event, `prompt_result`, `session_settled`). */
export type OmpRpcFrame = { readonly type: string } & Readonly<
  Record<string, unknown>
>

/** How omp answered a `prompt`. */
export interface OmpPromptAdmission {
  /** The request id `prompt_result` will carry. */
  readonly requestId: string
  /**
   * `false`: the prompt finished locally (a builtin slash command such as
   * `/compact`, or a host-mapped local command) and no `prompt_result`
   * follows. `true`: wait for the `prompt_result` with {@link requestId}.
   */
  readonly agentInvoked: boolean
  /** What a local completion printed (`command_output`), if anything. */
  readonly output?: string
}

/** One live omp RPC child, bound to one resident session. */
export interface OmpRpcChannel {
  /**
   * Send this turn's user input. Resolves once omp admitted it (the `prompt`
   * response), never after the turn. The channel carries `messageId` to the
   * child so the extension can stamp the transcript with it (crash recovery).
   */
  prompt(input: {
    readonly messageId: string
    readonly text: string
  }): Promise<OmpPromptAdmission>
  /** RPC `abort`. Best effort: the watchdog has already failed the turn. */
  abort(): Promise<void>
  /** Every outbound frame, in wire order. Returns an unsubscribe. */
  onFrame(listener: (frame: OmpRpcFrame) => void): () => void
  /** Settles (either way) when the child is gone. */
  readonly closed: Promise<void>
}

/** Where the turn port finds the child for a session. */
export interface OmpTurnRouter {
  /**
   * The live channel for `sessionId`, starting or resuming the child first if
   * this process has not opened that session yet (a recovered admission names
   * a session from a previous life).
   */
  channelFor(sessionId: string): Promise<OmpRpcChannel>
  /**
   * Crash recovery (§4.3 `input-status`): whether `messageId` reached the
   * session's transcript, read from the identity entries the extension writes
   * into the session JSONL. Never needs a live child.
   */
  isAccepted(sessionId: string, messageId: string): Promise<boolean>
}
