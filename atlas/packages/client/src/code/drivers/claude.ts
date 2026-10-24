// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Claude Code on this computer, as the user runs it (qmo-local.md §4.3.4,
 * §4.3.5, §4.4): the user's own login, settings, project files, hooks and
 * MCP servers; only the flags the protocol and the mode need. The process
 * leads a process group of its own, stays between turns, and is replaced
 * when a mode needs a flag it was not started with.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import {
  type ClaudeAsk,
  type ClaudeAskAnswer,
  ClaudeCodeChannel,
  type ClaudeDetail,
} from '@qianmo/harness/claudeStream.ts'
import { unifiedDiff } from '../diff.js'
import { CLAUDE_MODES, type Mode } from '../modes.js'
import { killGroup } from '../processes.js'
import { CodeError } from '../protocol.js'
import type {
  AgentHooks,
  AgentProcess,
  AskView,
  ToolView,
  TurnOutcome,
} from './agent.js'

/** What the runner writes when Claude Code has no mode `auto` (§4.4). */
export const NO_AUTO = '这个 Claude Code 没有自动模式，命令仍会问你'
/** What the runner writes when Claude Code no longer has the conversation. */
export const LOST = '上次的对话 Claude Code 那边已经没有了，这一句从新对话开始'
/** What follows Claude Code's own error when it is not signed in (§4.3.4). */
export const SIGN_IN_HINT = '在终端里运行 `claude` 登录后再试'

const MAX_SUMMARY = 160
const MAX_ASK_INPUT = 2 * 1024
const POSIX = process.platform !== 'win32'

/** The command line (§4.3.4): only the protocol's and the mode's flags. */
export function claudeArgv(input: {
  readonly program: string
  readonly nativeMode: string
  readonly sessionId: string
  readonly resume: boolean
  readonly dangerous: boolean
}): string[] {
  return [
    input.program,
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool',
    'stdio',
    '--permission-mode',
    input.nativeMode,
    input.resume ? '--resume' : '--session-id',
    input.sessionId,
    ...(input.dangerous ? ['--allow-dangerously-skip-permissions'] : []),
  ]
}

function one(text: string, max = MAX_SUMMARY): string {
  const line = text.split('\n', 1)[0]!.trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A path as the session shows it: relative to its root when inside. */
function shown(root: string, file: string): string {
  const rel = path.relative(root, file)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
    ? rel.split(path.sep).join('/')
    : file
}

/** A Claude Code tool call as its process line shows it. */
export function claudeToolView(
  root: string,
  id: string,
  name: string,
  input: Readonly<Record<string, unknown>>,
): ToolView {
  const file = str(input.file_path) ?? str(input.notebook_path)
  const at = file === undefined ? undefined : shown(root, file)
  const paths = at === undefined ? {} : { paths: [at] }
  const base = { id, name }
  switch (name) {
    case 'Edit': {
      const diff = unifiedDiff(
        typeof input.old_string === 'string' ? input.old_string : '',
        typeof input.new_string === 'string' ? input.new_string : '',
      )
      return {
        ...base,
        text: `编辑 ${at ?? ''}`.trim(),
        ...paths,
        detailKind: 'diff',
        diff,
      }
    }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits : []
      let text = ''
      let added = 0
      let removed = 0
      for (const edit of edits) {
        if (typeof edit !== 'object' || edit === null) continue
        const { old_string: before, new_string: after } = edit as Record<
          string,
          unknown
        >
        const diff = unifiedDiff(
          typeof before === 'string' ? before : '',
          typeof after === 'string' ? after : '',
        )
        text += text === '' ? diff.text : `\n${diff.text}`
        added += diff.added
        removed += diff.removed
      }
      return {
        ...base,
        text: `编辑 ${at ?? ''}`.trim(),
        ...paths,
        detailKind: 'diff',
        diff: { text, added, removed },
      }
    }
    case 'Write':
      return {
        ...base,
        text: `写入 ${at ?? ''}`.trim(),
        ...paths,
        detailKind: 'diff',
        diff: unifiedDiff(
          '',
          typeof input.content === 'string' ? input.content : '',
        ),
      }
    case 'NotebookEdit':
      return {
        ...base,
        text: `编辑 ${at ?? ''}`.trim(),
        ...paths,
        detailKind: 'output',
      }
    case 'Read':
      return {
        ...base,
        text: `读取 ${at ?? ''}`.trim(),
        ...paths,
        detailKind: 'output',
      }
    case 'Bash': {
      const command = str(input.command) ?? ''
      return {
        ...base,
        text: one(`运行 ${command}`),
        command,
        detailKind: 'output',
      }
    }
    case 'Grep':
    case 'Glob':
      return {
        ...base,
        text: one(
          `${name === 'Grep' ? '搜索' : '查找'} ${str(input.pattern) ?? ''}`,
        ),
        detailKind: 'output',
      }
    case 'WebFetch':
      return {
        ...base,
        text: one(`打开 ${str(input.url) ?? ''}`),
        detailKind: 'output',
      }
    case 'WebSearch':
      return {
        ...base,
        text: one(`搜索网页 ${str(input.query) ?? ''}`),
        detailKind: 'output',
      }
    case 'TodoWrite':
      return { ...base, text: '更新待办', detailKind: 'output' }
    case 'Task':
    case 'Agent':
      return {
        ...base,
        text: one(`子任务 ${str(input.description) ?? ''}`),
        detailKind: 'output',
      }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
      return {
        ...base,
        text: one(mcp === null ? name : `${mcp[1]} · ${mcp[2]}`),
        detailKind: 'output',
      }
    }
  }
}

/** A `can_use_tool` question as its card shows it. */
export function claudeAskView(root: string, request: ClaudeAsk): AskView {
  const tool = claudeToolView(
    root,
    request.toolUseId ?? request.requestId,
    request.toolName,
    request.input,
  )
  const input =
    tool.command ??
    tool.paths?.[0] ??
    JSON.stringify(request.input).slice(0, MAX_ASK_INPUT)
  return {
    ...(request.toolUseId === undefined ? {} : { toolId: request.toolUseId }),
    tool: request.toolName,
    title: one(request.description ?? tool.text),
    ...(request.blockedPath !== undefined
      ? { paths: [shown(root, request.blockedPath)] }
      : tool.paths === undefined
        ? {}
        : { paths: tool.paths }),
    input: input.slice(0, MAX_ASK_INPUT),
    // 「本会话都允许」 only when Claude Code offers a session-level rule.
    options:
      request.suggestions.length > 0
        ? ['once', 'session', 'deny']
        : ['once', 'deny'],
    ...(tool.diff !== undefined && tool.diff.text !== ''
      ? { detail: tool.diff.text }
      : input === ''
        ? {}
        : { detail: input }),
  }
}

/** Claude Code's own error, with how to sign in when it is about that. */
export function withSignInHint(message: string): string {
  return /log ?in|not logged|authenticat|api key|unauthori[sz]ed|\b401\b|credential/i.test(
    message,
  )
    ? `${message}\n${SIGN_IN_HINT}`
    : message
}

export interface ClaudeAgentOptions {
  readonly program: string
  /** The agent's working folder. */
  readonly root: string
  readonly env: Readonly<Record<string, string>>
  /** Claude Code's session id. */
  readonly sessionId: string
  /** The conversation exists (`--resume`). */
  readonly started: boolean
  readonly mode: Mode
  /** Known already: this program has no `auto`. */
  readonly noAuto: boolean
  readonly hooks: AgentHooks
  /** How long an interrupt has before the group gets SIGTERM, then SIGKILL. */
  readonly interruptGraceMs?: number
  readonly termGraceMs?: number
}

/** One session's Claude Code. */
export class ClaudeAgent implements AgentProcess {
  readonly #options: ClaudeAgentOptions
  readonly #hooks: AgentHooks
  #mode: Mode
  #noAuto: boolean
  #started: boolean
  #channel: ClaudeCodeChannel | undefined
  #child: ChildProcess | undefined
  /** The running process was started with `--allow-dangerously-skip-permissions`. */
  #dangerous = false
  /** The `--permission-mode` the running process was started with. */
  #spawnedNative = ''
  #initSeen = false
  /** Started in `acceptEdits` to see whether `auto` was why it would not start. */
  #trial = false
  #stopping = false
  /** Counts the turns sent, so a late escalation cannot hit a newer one. */
  #sent = 0
  readonly #timers = new Set<ReturnType<typeof setTimeout>>()
  /** Processes being ended: not to be given a turn. */
  readonly #ending = new WeakSet<ClaudeCodeChannel>()

  constructor(options: ClaudeAgentOptions) {
    this.#options = options
    this.#hooks = options.hooks
    this.#mode = options.mode
    this.#noAuto = options.noAuto
    this.#started = options.started
  }

  get alive(): boolean {
    const channel = this.#channel
    return channel !== undefined && channel.alive && !this.#ending.has(channel)
  }

  #native(): string {
    return this.#mode === 'auto' && this.#noAuto
      ? CLAUDE_MODES['accept-edits']
      : CLAUDE_MODES[this.#mode]
  }

  #markStarted(): void {
    if (this.#started) return
    this.#started = true
    this.#hooks.started()
  }

  /** Claude Code has no `auto` here: say so once, and go on in `acceptEdits`. */
  #fallBack(): void {
    if (this.#noAuto && this.#mode !== 'auto') return
    this.#noAuto = true
    this.#hooks.noAuto()
    if (this.#mode === 'auto') {
      this.#mode = 'accept-edits'
      this.#hooks.modeChanged('accept-edits')
      this.#hooks.notice(NO_AUTO, 'warn')
    }
  }

  #spawn(resume: boolean): ClaudeCodeChannel {
    const { program, root, env, sessionId } = this.#options
    const nativeMode = this.#native()
    const dangerous = this.#mode === 'full-access'
    const argv = claudeArgv({
      program,
      nativeMode,
      sessionId,
      resume,
      dangerous,
    })
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: root,
      env: { ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group: a stop reaches whatever it started.
      detached: POSIX,
      windowsHide: true,
    })
    // A process that went away while being written to is the channel's to
    // report (`closed`), not an error of this one.
    child.stdin?.on('error', () => {})
    const startedAt = Date.now()
    this.#child = child
    this.#dangerous = dangerous
    this.#spawnedNative = nativeMode
    this.#initSeen = false
    const channel = new ClaudeCodeChannel(child, {
      onSessionStarted: () => this.#markStarted(),
      onDetail: detail => this.#detail(channel, detail),
      ask: request => this.#ask(request),
    })
    this.#channel = channel
    const pid = child.pid
    if (pid !== undefined) this.#hooks.childStarted({ pid, startedAt, program })
    void channel.closed
      .catch(() => {})
      .finally(() => {
        if (pid !== undefined) this.#hooks.childGone(pid)
        if (this.#channel === channel) {
          this.#channel = undefined
          this.#child = undefined
        }
      })
    return channel
  }

  #detail(channel: ClaudeCodeChannel, detail: ClaudeDetail): void {
    const hooks = this.#hooks
    const root = this.#options.root
    switch (detail.kind) {
      case 'mode':
        this.#initSeen = true
        // Would not start in `auto`, does in `acceptEdits`: no `auto` here.
        if (this.#trial) {
          this.#trial = false
          this.#noAuto = false
          this.#fallBack()
          return
        }
        // Started in `auto` and something else is in effect: not enabled here.
        if (
          this.#spawnedNative === 'auto' &&
          detail.permissionMode !== undefined &&
          detail.permissionMode !== 'auto'
        ) {
          if (detail.permissionMode !== 'acceptEdits')
            void channel.setPermissionMode('acceptEdits').catch(() => {})
          this.#fallBack()
        }
        return
      case 'thinking':
        hooks.activity('thinking', '思考中')
        return
      case 'text-delta':
        if (detail.parent === undefined) hooks.delta(detail.text)
        return
      case 'message':
        if (detail.parent !== undefined) return
        this.#markStarted()
        hooks.message(detail.text)
        return
      case 'tool': {
        if (detail.parent !== undefined) {
          if (detail.phase === 'start')
            hooks.activity(
              'tool',
              claudeToolView(root, detail.id, detail.name, detail.input).text,
            )
          return
        }
        this.#markStarted()
        if (detail.phase === 'start')
          hooks.toolStart(
            claudeToolView(root, detail.id, detail.name, detail.input),
          )
        else hooks.toolEnd(detail.id, detail.isError, detail.output)
        return
      }
    }
  }

  async #ask(request: ClaudeAsk): Promise<ClaudeAskAnswer> {
    const answer = await this.#hooks.ask(
      claudeAskView(this.#options.root, request),
      request.signal,
    )
    return answer.message === undefined
      ? answer.decision
      : { decision: answer.decision, message: answer.message }
  }

  async turn(text: string): Promise<TurnOutcome> {
    this.#stopping = false
    // 「跳过权限确认」 needs a flag this process was not started with.
    if (this.alive && this.#mode === 'full-access' && !this.#dangerous)
      await this.stop()
    let outcome = await this.#once(text, this.#started)
    if (!this.#endedEarly(outcome)) return outcome
    // Whether the conversation exists is only known for sure by Claude Code:
    // a runner that went away mid-turn may have left either guess behind.
    const said = outcome.message ?? ''
    if (!this.#started && /already in use/i.test(said)) {
      this.#markStarted()
      outcome = await this.#once(text, true)
    } else if (this.#started && /no conversation found/i.test(said)) {
      this.#hooks.notice(LOST, 'warn')
      outcome = await this.#once(text, false)
    }
    if (!this.#endedEarly(outcome) || this.#spawnedNative !== 'auto')
      return outcome
    // Would not start in `auto`: if it does in `acceptEdits`, `auto` is not
    // enabled here (said once it has started); if not, `auto` was not why.
    this.#trial = true
    this.#noAuto = true
    const tried = await this.#once(text, this.#started)
    if (this.#trial) {
      this.#trial = false
      this.#noAuto = false
      if (tried.status !== 'aborted') return outcome
    }
    return tried
  }

  /** Failed before Claude Code said anything, and it is gone. */
  #endedEarly(outcome: TurnOutcome): boolean {
    return (
      outcome.status === 'error' &&
      !this.#stopping &&
      !this.#initSeen &&
      !this.alive
    )
  }

  async #once(text: string, resume: boolean): Promise<TurnOutcome> {
    const channel = this.alive ? this.#channel! : this.#spawn(resume)
    try {
      await channel.initialize()
    } catch (error) {
      return {
        status: 'error',
        message: `Claude Code 起不来：${(error as Error).message}`,
      }
    }
    const { promise, resolve } = Promise.withResolvers<TurnOutcome>()
    const off = channel.onFrame(frame => {
      if (frame.type !== 'prompt_result') return
      const status = frame.status
      const error = frame.error as { message?: unknown } | undefined
      resolve(
        status === 'completed'
          ? { status: 'completed' }
          : status === 'aborted'
            ? { status: 'aborted' }
            : {
                status: 'error',
                message:
                  typeof error?.message === 'string'
                    ? error.message
                    : 'Claude Code 这一轮失败了',
              },
      )
    })
    this.#sent++
    try {
      await channel.prompt({ messageId: randomUUID(), text })
    } catch (error) {
      off()
      return {
        status: this.#stopping ? 'aborted' : 'error',
        message: (error as Error).message,
      }
    }
    const outcome = await promise
    off()
    if (this.#stopping && outcome.status !== 'completed')
      return { status: 'aborted' }
    if (outcome.status !== 'error') return outcome
    // Claude Code ended without a result: what it printed says why.
    await Promise.race([channel.closed.catch(() => {}), Bun.sleep(200)])
    const said = channel.alive ? '' : channel.stderrTail.trim().slice(-400)
    return {
      status: 'error',
      message: withSignInHint(
        said === '' ? (outcome.message ?? '') : `${outcome.message}\n${said}`,
      ),
    }
  }

  async setMode(
    mode: Mode,
  ): Promise<{ readonly mode: Mode; readonly applies: 'now' | 'next-turn' }> {
    const channel = this.#channel
    if (channel === undefined || !this.alive) {
      this.#mode = mode === 'auto' && this.#noAuto ? 'accept-edits' : mode
      if (mode === 'auto' && this.#noAuto) this.#hooks.notice(NO_AUTO, 'warn')
      return { mode: this.#mode, applies: 'now' }
    }
    if (mode === 'full-access' && !this.#dangerous) {
      this.#mode = mode
      // Restarted with the flag before the next turn (§4.4).
      if (!channel.busy) {
        await this.stop()
        return { mode, applies: 'now' }
      }
      return { mode, applies: 'next-turn' }
    }
    const native =
      mode === 'auto' && this.#noAuto
        ? CLAUDE_MODES['accept-edits']
        : CLAUDE_MODES[mode]
    try {
      await channel.setPermissionMode(native)
      this.#mode = mode
      if (mode === 'auto' && this.#noAuto) {
        this.#mode = 'accept-edits'
        this.#hooks.notice(NO_AUTO, 'warn')
      }
      return { mode: this.#mode, applies: 'now' }
    } catch (error) {
      if (mode !== 'auto')
        throw new CodeError(
          'E_AGENT',
          `Claude Code 没有切换：${(error as Error).message}`,
        )
      await channel
        .setPermissionMode(CLAUDE_MODES['accept-edits'])
        .catch(() => {})
      this.#mode = 'accept-edits'
      this.#noAuto = true
      this.#hooks.noAuto()
      this.#hooks.notice(NO_AUTO, 'warn')
      return { mode: 'accept-edits', applies: 'now' }
    }
  }

  #later(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      run()
    }, ms)
    timer.unref()
    this.#timers.add(timer)
  }

  abort(): void {
    this.#stopping = true
    const channel = this.#channel
    const pid = this.#child?.pid
    if (channel === undefined || !channel.busy) return
    void channel.abort()
    if (pid === undefined) return
    // Not stopped the native way in time: the group, SIGTERM, then SIGKILL.
    // (The channel ends a turn it could not interrupt at 5 s by stopping its
    // own process; what that process started is still in the group.)
    const grace = (this.#options.interruptGraceMs ?? 5_000) + 100
    const term = this.#options.termGraceMs ?? 3_000
    const sent = this.#sent
    this.#later(grace, () => {
      // Interrupted the native way: the process stays for the next turn.
      if (channel.alive && (!channel.busy || this.#sent !== sent)) return
      killGroup(pid, 'SIGTERM')
      this.#later(term, () => killGroup(pid, 'SIGKILL'))
    })
  }

  async stop(): Promise<void> {
    const channel = this.#channel
    const pid = this.#child?.pid
    if (channel === undefined) return
    this.#ending.add(channel)
    const stopped = channel.stop()
    if (pid !== undefined && POSIX) {
      killGroup(pid, 'SIGTERM')
      this.#later(this.#options.termGraceMs ?? 3_000, () => {
        if (channel.alive) killGroup(pid, 'SIGKILL')
      })
    }
    await stopped
  }
}
