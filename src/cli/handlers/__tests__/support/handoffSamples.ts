// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Transcripts and hook inputs shaped like the real ones, for the `qm handoff`
 * tests (unit and integration).
 *
 * - qmcode rollout lines follow `codex-rs/history` `RolloutLine` (`timestamp`
 *   plus a `type` / `payload` item) and `codex-rs/protocol` — `task_started` /
 *   `task_complete` carry `turn_id`; the end of a turn is written
 *   `token_count` → `task_complete` (handoff-probe-p17.md 第 7 项).
 * - The qmcode notify argument is `legacy_notify.rs`'s `agent-turn-complete`,
 *   kebab-case; `client` is optional and `last-assistant-message` nullable.
 * - A `/handoff` or `!` shell turn is what `user_shell.rs` persists: while
 *   the command runs, its `task_started` and nothing after it.
 * - Claude Code records carry the fields a real transcript has around
 *   `type` / `message`; one API response is one record per content block, each
 *   with the response's final `stop_reason` (`services/api/claude.ts`). The hook
 *   input is `createBaseHookInput` plus the `Stop` / `SessionEnd` fields
 *   (`utils/hooks/lifecycleHooks.ts`).
 *
 * Values are made up; nothing here came from a real session.
 */

const MODEL = 'gpt-6-luna'

interface QmcodeModelTurn {
  readonly turnId: string
  readonly user: string
  readonly assistant: string
  /**
   * `complete` (default) ends with `task_complete`; `aborted` with
   * `turn_aborted`; `open` stops mid-turn, after the first tool call;
   * `starting` stops after `task_started` (the wait for MCP servers before the
   * first `turn_context`, `codex-rs/core/src/session/turn.rs`).
   */
  readonly ending?: 'complete' | 'aborted' | 'open' | 'starting'
}

/**
 * A `!` command, or `/handoff`, run while no turn runs: a standalone turn of
 * its own (`codex-rs/core/src/tasks/user_shell.rs`, `StandaloneTurn`).
 * `task_started` is written before the command starts; while it `runs`,
 * nothing follows — its begin and output events are not persisted
 * (`codex-rs/rollout/src/policy.rs`). Once it has exited, the
 * `<user_shell_command>` record (`core/src/context/user_shell_command.rs`)
 * and `task_complete`.
 */
interface QmcodeShellTurn {
  readonly turnId: string
  readonly shell: string
  readonly ending?: 'complete' | 'runs'
}

export type QmcodeTurn = QmcodeModelTurn | QmcodeShellTurn

function line(timestamp: string, type: string, payload: unknown): string {
  return `${JSON.stringify({ timestamp, type, payload })}\n`
}

/** A rollout: `session_meta`, then each turn as qmcode writes it. */
export function qmcodeRollout(
  threadId: string,
  cwd: string,
  turns: readonly QmcodeTurn[],
): string {
  let at = Date.UTC(2026, 9, 3, 9, 0, 0)
  const ts = () => new Date((at += 37)).toISOString()
  let out = line(ts(), 'session_meta', {
    id: threadId,
    timestamp: new Date(at).toISOString(),
    cwd,
    originator: 'codex_cli_rs',
    cli_version: '0.158.0',
    source: 'cli',
    model_provider: 'luna',
  })
  for (const turn of turns) {
    out += line(ts(), 'event_msg', {
      type: 'task_started',
      turn_id: turn.turnId,
      root_turn_id: turn.turnId,
      started_at: Math.floor(at / 1000),
      model_context_window: 272000,
      collaboration_mode_kind: 'default',
    })
    if ('shell' in turn) {
      if (turn.ending === 'runs') continue
      out += line(ts(), 'response_item', {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `<user_shell_command>\n<command>\n${turn.shell}\n</command>\n<result>\nExit code: 0\nDuration: 0.0120 seconds\nOutput:\none\n\n</result>\n</user_shell_command>`,
          },
        ],
      })
      out += line(ts(), 'event_msg', {
        type: 'task_complete',
        turn_id: turn.turnId,
        last_agent_message: null,
      })
      continue
    }
    if (turn.ending === 'starting') continue
    out += line(ts(), 'turn_context', {
      turn_id: turn.turnId,
      cwd,
      approval_policy: 'on-request',
      sandbox_policy: { type: 'workspace-write' },
      model: MODEL,
      effort: 'medium',
      summary: 'auto',
    })
    out += line(ts(), 'response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: turn.user }],
    })
    out += line(ts(), 'event_msg', {
      type: 'user_message',
      message: turn.user,
      images: [],
    })
    out += line(ts(), 'response_item', {
      type: 'function_call',
      name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'cat a.txt' }),
      call_id: `call_${turn.turnId.slice(-6)}`,
    })
    out += line(ts(), 'response_item', {
      type: 'function_call_output',
      call_id: `call_${turn.turnId.slice(-6)}`,
      output: 'Process exited with code 0\nOutput:\none\n',
    })
    if (turn.ending === 'open') continue
    out += line(ts(), 'response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: turn.assistant }],
    })
    out += line(ts(), 'event_msg', {
      type: 'agent_message',
      message: turn.assistant,
    })
    out += line(ts(), 'event_msg', {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 4210,
          cached_input_tokens: 3072,
          output_tokens: 61,
          reasoning_output_tokens: 0,
          total_tokens: 4271,
        },
        model_context_window: 272000,
      },
      rate_limits: null,
    })
    out +=
      turn.ending === 'aborted'
        ? line(ts(), 'event_msg', {
            type: 'turn_aborted',
            turn_id: turn.turnId,
            reason: 'interrupted',
          })
        : line(ts(), 'event_msg', {
            type: 'task_complete',
            turn_id: turn.turnId,
            last_agent_message: turn.assistant,
          })
  }
  return out
}

/**
 * The argument qmcode's `notify` appends, as `legacy_notify.rs` writes it:
 * kebab-case, `client` left out when there is none (`client: null`), and
 * `last-assistant-message` possibly `null`.
 */
export function qmcodeNotify(
  threadId: string,
  turnId: string,
  cwd: string,
  extra: {
    readonly input?: string
    readonly last?: string | null
    readonly client?: string | null
  } = {},
): string {
  const client = extra.client === undefined ? 'codex-tui' : extra.client
  return JSON.stringify({
    type: 'agent-turn-complete',
    'thread-id': threadId,
    'turn-id': turnId,
    cwd,
    ...(client === null ? {} : { client }),
    'input-messages': [extra.input ?? '把 a.txt 读出来'],
    'last-assistant-message':
      extra.last === undefined ? 'a.txt 里是 one' : extra.last,
  })
}

/** Where a rollout of `threadId` lives under `$QMCODE_HOME`. */
export function qmcodeRolloutPath(home: string, threadId: string): string {
  return `${home}/sessions/2026/10/03/rollout-2026-10-03T09-00-00-${threadId}.jsonl`
}

/** How a Claude Code transcript ends. */
type ClaudeCodeEnding =
  /** Final text, `stop_reason: end_turn`. */
  | 'complete'
  /** Last record is a `tool_use` the tool has not answered. */
  | 'tool-use'
  /** Last record is the tool's result; the model's answer is not on disk yet. */
  | 'tool-result'

/** A Claude Code transcript: one prompt, one tool round trip, then `ending`. */
export function claudeCodeTranscript(
  sessionId: string,
  cwd: string,
  ending: ClaudeCodeEnding,
): string {
  let at = Date.UTC(2026, 9, 3, 9, 30, 0)
  let previous: string | null = null
  let counter = 0
  const records: unknown[] = []
  const push = (fields: Record<string, unknown>) => {
    counter++
    const uuid = `5c1d0e7a-0000-4000-8000-${String(counter).padStart(12, '0')}`
    records.push({
      parentUuid: previous,
      isSidechain: false,
      userType: 'external',
      cwd,
      sessionId,
      version: '2.1.12',
      gitBranch: 'main',
      ...fields,
      uuid,
      timestamp: new Date((at += 211)).toISOString(),
    })
    previous = uuid
  }
  const assistant = (
    id: string,
    content: unknown[],
    stop: string,
  ): Record<string, unknown> => ({
    type: 'assistant',
    requestId: `req_${id}`,
    message: {
      id: `msg_${id}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 812, output_tokens: 44 },
    },
  })
  records.push({
    type: 'summary',
    summary: 'Read a.txt',
    leafUuid: 'none',
  })
  push({
    type: 'user',
    message: { role: 'user', content: '把 a.txt 读出来' },
  })
  push({
    type: 'attachment',
    attachment: { type: 'todo', content: [] },
  })
  push(
    assistant(
      '01A',
      [{ type: 'thinking', thinking: 'Read the file.', signature: 'c2ln' }],
      'tool_use',
    ),
  )
  push(
    assistant(
      '01A',
      [
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'Read',
          input: { file_path: `${cwd}/a.txt` },
        },
      ],
      'tool_use',
    ),
  )
  if (ending === 'tool-use') {
    return records.map(r => `${JSON.stringify(r)}\n`).join('')
  }
  push({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_01', content: '1\tone\n' },
      ],
    },
    toolUseResult: { type: 'text', file: { filePath: `${cwd}/a.txt` } },
  })
  // A subagent's record in the main file: not the main chain, never the verdict.
  records.push({
    parentUuid: null,
    isSidechain: true,
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'side' }],
      stop_reason: 'end_turn',
    },
    uuid: 'side-0001',
    timestamp: new Date((at += 5)).toISOString(),
  })
  if (ending === 'tool-result') {
    return records.map(r => `${JSON.stringify(r)}\n`).join('')
  }
  push(
    assistant('01B', [{ type: 'text', text: 'a.txt 里是 one。' }], 'end_turn'),
  )
  push({
    type: 'system',
    subtype: 'stop_hook_summary',
    hookCount: 1,
    level: 'suggestion',
  })
  return records.map(r => `${JSON.stringify(r)}\n`).join('')
}

/** The stdin of a Claude Code `Stop` or `SessionEnd` command hook. */
export function claudeCodeHookInput(
  sessionId: string,
  transcriptPath: string,
  cwd: string,
  event: 'Stop' | 'SessionEnd' = 'Stop',
): string {
  return JSON.stringify(
    event === 'Stop'
      ? {
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd,
          permission_mode: 'default',
          hook_event_name: 'Stop',
          stop_hook_active: false,
          last_assistant_message: 'a.txt 里是 one。',
        }
      : {
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd,
          hook_event_name: 'SessionEnd',
          reason: 'prompt_input_exit',
        },
  )
}
