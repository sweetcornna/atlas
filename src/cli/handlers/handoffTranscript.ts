// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Transcripts: what the two hooks hand over, where the session file is, and
 * when a turn in it is complete (P17.3 会话定位, P17.4 同步规则).
 *
 * ## The two hook inputs
 *
 * - **Claude Code** runs `qm handoff sync --hook claude-code` from its `Stop`
 *   and `SessionEnd` hooks with one JSON object on stdin
 *   (`createBaseHookInput`: `session_id`, `transcript_path`, `cwd`, plus
 *   `hook_event_name`). Only those four fields are read.
 * - **qmcode** runs `qm handoff sync --hook qmcode <json>` from `notify`, the
 *   JSON as the last argument (`codex-rs/hooks/src/legacy_notify.rs`):
 *   `{"type":"agent-turn-complete","thread-id","turn-id","cwd","client",
 *   "input-messages","last-assistant-message"}`. Only `type`, `thread-id`,
 *   `turn-id` and `cwd` are read; the messages are not looked at, let alone
 *   kept.
 *
 * Neither input is a place an environment variable could come from, and none
 * is read here: the notify process inherits qmcode's environment, model key
 * included, and the rule is to record nothing of it.
 *
 * ## When a turn is complete (handoff-probe-p17.md 第 7 项)
 *
 * Judged from the content, never from size or mtime being stable: a model
 * thinking for a few seconds looks stable too.
 *
 * - qmcode: the turn named by `turn-id` is complete once an `event_msg` line
 *   with `payload.type` `task_complete` (or `turn_aborted`) and that
 *   `payload.turn_id` is on disk. The file is re-read every 10 ms for up to
 *   2 s. Measured need was 0 ms on 5 of 5 turns; the code does not promise the
 *   order, which is why there is a wait at all.
 * - Claude Code: `SessionEnd` is complete by definition. For `Stop`, the last
 *   main-chain (`isSidechain` not true) `user`/`assistant` record must be an
 *   assistant message whose `stop_reason` is set and is not `tool_use`.
 *
 * Only whole lines count: the cut is at the end of the completing line (or the
 * last newline), never in the middle of a write.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { HandoffUserError, sleep } from './handoffStore.js'

// ─── Hook inputs ─────────────────────────────────────────────────────

interface ClaudeCodeHookInput {
  readonly sessionId: string
  readonly transcriptPath: string
  readonly cwd: string
  /** `Stop`, `SessionEnd`, …; `null` when the field is absent. */
  readonly event: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The stdin of a Claude Code command hook. */
export function parseClaudeCodeHookInput(text: string): ClaudeCodeHookInput {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new HandoffUserError('Claude Code hook 的标准输入不是 JSON')
  }
  if (!isRecord(value)) {
    throw new HandoffUserError('Claude Code hook 的标准输入不是 JSON 对象')
  }
  const { session_id, transcript_path, cwd, hook_event_name } = value
  if (
    typeof session_id !== 'string' ||
    typeof transcript_path !== 'string' ||
    typeof cwd !== 'string' ||
    !isAbsolute(transcript_path) ||
    !isAbsolute(cwd)
  ) {
    throw new HandoffUserError(
      'Claude Code hook 输入缺 session_id / transcript_path / cwd（后两个须是绝对路径）',
    )
  }
  return {
    sessionId: session_id,
    transcriptPath: transcript_path,
    cwd,
    event: typeof hook_event_name === 'string' ? hook_event_name : null,
  }
}

interface QmcodeNotify {
  readonly threadId: string
  readonly turnId: string
  readonly cwd: string
}

/**
 * The JSON qmcode appends to the `notify` command. `null` for a notification
 * of another type — only `agent-turn-complete` exists today, but the field is
 * there to grow.
 */
export function parseQmcodeNotify(text: string): QmcodeNotify | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new HandoffUserError('qmcode notify 的参数不是 JSON')
  }
  if (!isRecord(value)) {
    throw new HandoffUserError('qmcode notify 的参数不是 JSON 对象')
  }
  if (value.type !== 'agent-turn-complete') return null
  const threadId = value['thread-id']
  const turnId = value['turn-id']
  const cwd = value.cwd
  if (
    typeof threadId !== 'string' ||
    typeof turnId !== 'string' ||
    typeof cwd !== 'string' ||
    threadId === '' ||
    turnId === '' ||
    !isAbsolute(cwd)
  ) {
    throw new HandoffUserError(
      'qmcode notify 缺 thread-id / turn-id / cwd（cwd 须是绝对路径）',
    )
  }
  return { threadId, turnId, cwd }
}

// ─── Locating a qmcode rollout ───────────────────────────────────────

function sortedDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/**
 * The rollout of `threadId` under `<home>/sessions/YYYY/MM/DD/`, newest day
 * first: `rollout-<timestamp>-<threadId>.jsonl`, or `…-<threadId>_<rollout
 * id>.jsonl` for a reverted thread (`codex-rs/rollout/src/rollout_file_name.rs`).
 * Only plain `.jsonl`: a live session is never the compressed `.jsonl.zst`
 * form. `null` when there is none — a notify for a thread that never wrote a
 * rollout (the title thread the TUI starts, probe 第 5 项).
 */
export function findQmcodeRollout(
  home: string,
  threadId: string,
): string | null {
  const sessions = join(home, 'sessions')
  const plain = `-${threadId}.jsonl`
  const reverted = `-${threadId}_`
  for (const year of sortedDirs(sessions)) {
    for (const month of sortedDirs(join(sessions, year))) {
      for (const day of sortedDirs(join(sessions, year, month))) {
        const dir = join(sessions, year, month, day)
        let names: string[]
        try {
          names = readdirSync(dir)
        } catch {
          continue
        }
        const hits = names
          .filter(
            name =>
              name.startsWith('rollout-') &&
              (name.endsWith(plain) ||
                (name.includes(reverted) && name.endsWith('.jsonl'))),
          )
          .map(name => join(dir, name))
        if (hits.length === 0) continue
        return hits.sort((a, b) => mtimeOf(b) - mtimeOf(a))[0] ?? null
      }
    }
  }
  return null
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

// ─── Lines ───────────────────────────────────────────────────────────

interface Line {
  /** Offset of the first byte. */
  readonly start: number
  /** Offset just past the newline. */
  readonly end: number
  readonly text: string
}

/** Every complete line of `content`; a last line without `\n` is left out. */
function completeLines(content: Buffer): Line[] {
  const lines: Line[] = []
  let start = 0
  for (;;) {
    const newline = content.indexOf(0x0a, start)
    if (newline === -1) break
    lines.push({
      start,
      end: newline + 1,
      text: content.toString('utf8', start, newline),
    })
    start = newline + 1
  }
  return lines
}

function parsed(line: Line): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line.text)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

/** Offset just past the last newline; 0 when there is none. */
export function lastNewlineEnd(content: Buffer): number {
  return content.lastIndexOf(0x0a) + 1
}

const TURN_END_TYPES = new Set(['task_complete', 'turn_aborted'])

function turnEndOf(record: Record<string, unknown>): string | null {
  if (record.type !== 'event_msg' || !isRecord(record.payload)) return null
  const { type, turn_id } = record.payload
  return typeof type === 'string' &&
    TURN_END_TYPES.has(type) &&
    typeof turn_id === 'string'
    ? turn_id
    : null
}

function turnStartOf(record: Record<string, unknown>): string | null {
  if (record.type !== 'event_msg' || !isRecord(record.payload)) return null
  const { type, turn_id } = record.payload
  return type === 'task_started' && typeof turn_id === 'string' ? turn_id : null
}

// ─── Completeness ────────────────────────────────────────────────────

/** End of the line that completes qmcode turn `turnId`, or `null` while it is open. */
export function qmcodeTurnEnd(content: Buffer, turnId: string): number | null {
  for (const line of completeLines(content)) {
    // Cheap test first: most lines are not about this turn's end.
    if (!line.text.includes(turnId) || !line.text.includes('"event_msg"')) {
      continue
    }
    const record = parsed(line)
    if (record !== null && turnEndOf(record) === turnId) return line.end
  }
  return null
}

/** Where a Claude Code transcript is complete for `event`, or `null`. */
export function claudeCodeTurnEnd(
  content: Buffer,
  event: string | null,
): number | null {
  const end = lastNewlineEnd(content)
  if (end === 0) return null
  if (event === 'SessionEnd') return end
  const lines = completeLines(content)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (line === undefined) continue
    const record = parsed(line)
    if (record === null || record.isSidechain === true) continue
    if (record.type === 'user') return null
    if (record.type === 'assistant') {
      const message = record.message
      const stop = isRecord(message) ? message.stop_reason : undefined
      return typeof stop === 'string' && stop !== 'tool_use' ? end : null
    }
  }
  return null
}

/** What `now` may hand over of a qmcode rollout. */
type QmcodeSnapshot =
  | { readonly open: false; readonly end: number }
  | {
      readonly open: true
      readonly turnId: string
      /** Start of the open turn's `task_started` line: everything before it is complete. */
      readonly before: number
    }

interface OpenTurn {
  readonly turnId: string
  /** Index of its `task_started` line. */
  readonly index: number
}

/** The latest turn started in `records[0, count)`, if it has no end there. */
function openTurn(
  records: readonly (Record<string, unknown> | null)[],
  count: number,
): OpenTurn | null {
  let latest: OpenTurn | null = null
  const ended = new Set<string>()
  for (let index = 0; index < count; index++) {
    const record = records[index]
    if (record === undefined || record === null) continue
    const started = turnStartOf(record)
    if (started !== null) latest = { turnId: started, index }
    const finished = turnEndOf(record)
    if (finished !== null) ended.add(finished)
  }
  return latest === null || ended.has(latest.turnId) ? null : latest
}

/**
 * Whether a turn is still running, and how much of the rollout to take
 * (probe 第 7 项第 5 条: the latest `task_started` must have its
 * `task_complete` / `turn_aborted`, or it is 「回合进行中」).
 *
 * One open turn is the caller's own. `/handoff` in the qmcode TUI, like any
 * `!` command typed while no turn runs, runs `qm handoff now` as a standalone
 * user-shell turn (`codex-rs/core/src/session/handlers.rs`
 * `run_user_shell_command`, `core/src/tasks/user_shell.rs` `StandaloneTurn`):
 * its `task_started` is written before the command starts, and nothing else
 * of that turn is until the command has exited — no `turn_context` (the
 * task never records one), and the command's begin and output events are
 * not persisted (`codex-rs/rollout/src/policy.rs`). Measured the same way
 * (QIANMO.md 10.3): while `qm handoff now` runs, the rollout ends on that
 * `task_started`. So when `fromThreadShell` — this process is a shell
 * command of the very thread the rollout belongs to (`CODEX_THREAD_ID`) —
 * and the open turn is exactly the last line of the file, nothing after it,
 * that turn is left out and what precedes it is judged by the same rule.
 *
 * Every other open turn is refused, the bare `task_started` included: a
 * model turn writes only that while it waits for MCP servers before its first
 * `turn_context`, and from a terminal, or from another thread, nothing tells
 * the two apart. A `!` command typed while a model turn runs gets no turn of
 * its own (`ActiveTurnAuxiliary`); the open turn is the model's and is
 * refused — unless that turn is still in the wait just described, the one
 * case this rule takes for the caller's own.
 */
export function qmcodeSnapshot(
  content: Buffer,
  fromThreadShell = false,
): QmcodeSnapshot {
  const lines = completeLines(content)
  const records = lines.map(parsed)
  let end = lastNewlineEnd(content)
  let open = openTurn(records, lines.length)
  const last = lines.at(-1)
  if (
    open !== null &&
    fromThreadShell &&
    last !== undefined &&
    open.index === lines.length - 1 &&
    last.end === content.length
  ) {
    end = last.start
    open = openTurn(records, open.index)
  }
  if (open === null) return { open: false, end }
  return {
    open: true,
    turnId: open.turnId,
    before: lines[open.index]?.start ?? end,
  }
}

/** The bytes of `file` now, or `null` when it does not exist. */
export function readTranscript(file: string): Buffer | null {
  try {
    return readFileSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Re-read `file` until `judge` finds the turn complete, every `intervalMs`
 * for up to `timeoutMs` (10 ms / 2 s, probe 第 7 项). Returns the content and
 * the cut, or `null` when the turn did not complete in time.
 */
export async function waitForTurnEnd(
  file: string,
  judge: (content: Buffer) => number | null,
  options: { readonly intervalMs?: number; readonly timeoutMs?: number } = {},
): Promise<{ readonly content: Buffer; readonly end: number } | null> {
  const intervalMs = options.intervalMs ?? 10
  const deadline = Date.now() + (options.timeoutMs ?? 2_000)
  let lastSize = -1
  for (;;) {
    let size = -2
    try {
      size = statSync(file).size
    } catch {}
    if (size !== lastSize) {
      lastSize = size
      const content = readTranscript(file)
      if (content !== null) {
        const end = judge(content)
        if (end !== null) return { content, end }
      }
    }
    if (Date.now() >= deadline) return null
    await sleep(intervalMs)
  }
}
