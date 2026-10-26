// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Codex on this computer, as the user runs it (qmo-local.md §4.3.4, §4.3.5,
 * §4.4): `codex app-server` and nothing else on its command line, so the
 * user's own login, `config.toml`, `AGENTS.md`, MCP servers and sandbox
 * apply as in a terminal. One thread per session, resumed by id. The process
 * leads a process group of its own and stays between turns.
 *
 * A mode is said in Codex's own settings: the thread opens with its
 * `approvalPolicy` and `sandbox`; a change goes in the next `turn/start`
 * (`approvalPolicy`, and `sandboxPolicy` to full access). Two changes a
 * turn's policy cannot say start the process again on the same thread
 * before the next turn: into a mode whose questions must reach the person
 * (`approvalsReviewer: 'user'`) from one without it, and back into the
 * workspace sandbox (`thread/resume` with `sandbox`, so the user's own
 * workspace settings apply again).
 *
 * The runner answers for Codex only where the mode says so: in
 * 「自动接受编辑」 an edit whose files are all in the session's folder, in
 * 「跳过权限确认」 whatever still asks. A command is never answered here in
 * any other mode.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import {
  type CodexAsk,
  type CodexAskDecision,
  CodexChannel,
  type CodexDetail,
} from '@qianmo/harness/codexRpc.ts'
import { unifiedDiff } from '../diff.js'
import { CODEX_MODES, type CodexPolicy, type Mode } from '../modes.js'
import { resolveInRoot } from '../paths.js'
import { killGroup } from '../processes.js'
import type {
  AgentHooks,
  AgentProcess,
  AskView,
  Driver,
  ToolView,
  TurnOutcome,
} from './agent.js'
import { one, shown, withSignInHint } from './claude.js'

/** What the runner writes when Codex no longer has the thread. */
export const LOST = '上次的对话 Codex 那边已经没有了，这一句从新对话开始'
/** What follows Codex's own error when it is not signed in (§4.3.4). */
export const SIGN_IN_HINT = '在终端里运行 `codex login` 登录后再试'

const MAX_ASK_INPUT = 2 * 1024
/** A command's output is kept up to this, its tail (the record keeps 16 KiB). */
const MAX_OUTPUT = 64 * 1024
const POSIX = process.platform !== 'win32'

/** The command line (§4.3.4): the app-server and nothing else. */
export function codexArgv(program: string): string[] {
  return [program, 'app-server']
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * A `fileChange` item's changes: the file (absolute, a relative one taken
 * from the session's folder, Codex's `cwd`), kind (`add`, `delete`,
 * `update`), diff.
 */
function changesOf(
  root: string,
  item: Readonly<Record<string, unknown>>,
): {
  readonly path: string
  readonly kind: string
  readonly diff: string
}[] {
  return (Array.isArray(item.changes) ? item.changes : []).flatMap(raw => {
    const change = record(raw)
    const file = str(change.path)
    if (file === undefined) return []
    const kind =
      typeof change.kind === 'string' ? change.kind : record(change.kind).type
    return [
      {
        path: path.resolve(root, file),
        kind: typeof kind === 'string' ? kind : 'update',
        diff: typeof change.diff === 'string' ? change.diff : '',
      },
    ]
  })
}

/** One change as a unified diff: Codex gives an added or deleted file whole. */
function changeDiff(change: { readonly kind: string; readonly diff: string }): {
  text: string
  added: number
  removed: number
} {
  if (change.kind === 'add') return unifiedDiff('', change.diff)
  if (change.kind === 'delete') return unifiedDiff(change.diff, '')
  let added = 0
  let removed = 0
  let inHunk = false
  for (const line of change.diff.split('\n')) {
    if (line.startsWith('@@')) inHunk = true
    else if (inHunk && line.startsWith('+')) added++
    else if (inHunk && line.startsWith('-')) removed++
  }
  return { text: change.diff.replace(/\n$/, ''), added, removed }
}

function commandOf(value: unknown): string {
  if (Array.isArray(value))
    return value.filter(part => typeof part === 'string').join(' ')
  return typeof value === 'string' ? value : ''
}

/** A Codex tool item as its process line shows it; `undefined` for one the line does not show. */
export function codexToolView(
  root: string,
  item: Readonly<Record<string, unknown>>,
): ToolView | undefined {
  const id = str(item.id)
  if (id === undefined) return undefined
  switch (item.type) {
    case 'commandExecution': {
      const command = commandOf(item.command)
      return {
        id,
        name: 'commandExecution',
        text: one(`运行 ${command}`),
        command,
        detailKind: 'output',
      }
    }
    case 'fileChange': {
      const changes = changesOf(root, item)
      const paths = changes.map(change => shown(root, change.path))
      const verb = changes.every(change => change.kind === 'add')
        ? '写入'
        : changes.every(change => change.kind === 'delete')
          ? '删除'
          : '编辑'
      const several = changes.length > 1
      let text = ''
      let added = 0
      let removed = 0
      for (const [at, change] of changes.entries()) {
        const diff = changeDiff(change)
        const head = several ? `--- a/${paths[at]}\n+++ b/${paths[at]}\n` : ''
        text += `${text === '' ? '' : '\n'}${head}${diff.text}`
        added += diff.added
        removed += diff.removed
      }
      return {
        id,
        name: 'fileChange',
        text: one(
          paths.length > 1
            ? `${verb} ${paths[0]} 等 ${paths.length} 个文件`
            : `${verb} ${paths[0] ?? ''}`.trim(),
        ),
        ...(paths.length === 0 ? {} : { paths }),
        detailKind: 'diff',
        diff: { text, added, removed },
      }
    }
    case 'mcpToolCall':
      return {
        id,
        name: 'mcpToolCall',
        text: one(`${String(item.server ?? '')} · ${String(item.tool ?? '')}`),
        detailKind: 'output',
      }
    case 'webSearch':
      return {
        id,
        name: 'webSearch',
        text: one(`搜索网页 ${str(item.query) ?? ''}`),
        detailKind: 'output',
      }
    default:
      return undefined
  }
}

/** What a finished tool item said: a command's output, an MCP result's text. */
function outputOf(
  item: Readonly<Record<string, unknown>>,
  streamed: string | undefined,
): string {
  if (item.type === 'commandExecution')
    return typeof item.aggregatedOutput === 'string'
      ? item.aggregatedOutput
      : (streamed ?? '')
  if (item.type === 'mcpToolCall') {
    const error = str(record(item.error).message)
    if (error !== undefined) return error
    const content = record(item.result).content
    return (Array.isArray(content) ? content : [])
      .map(block => {
        const one = record(block)
        return one.type === 'text' && typeof one.text === 'string'
          ? one.text
          : ''
      })
      .filter(text => text !== '')
      .join('\n')
  }
  return ''
}

function failed(item: Readonly<Record<string, unknown>>): boolean {
  return (
    item.status === 'failed' ||
    item.status === 'declined' ||
    (typeof item.exitCode === 'number' && item.exitCode !== 0)
  )
}

/** An approval as its card shows it. */
export function codexAskView(
  root: string,
  request: CodexAsk,
  tool: ToolView | undefined,
): AskView {
  const params = request.params
  const reason = str(params.reason)
  const toolId = request.itemId === undefined ? {} : { toolId: request.itemId }
  if (request.kind === 'command') {
    const command = commandOf(params.command)
    return {
      ...toolId,
      tool: 'commandExecution',
      title: one(reason ?? `运行 ${command}`),
      input: command.slice(0, MAX_ASK_INPUT),
      options: request.options,
      ...(command === '' ? {} : { detail: command }),
    }
  }
  if (request.kind === 'file-change') {
    const grant = str(params.grantRoot)
    const granted =
      grant === undefined ? undefined : shown(root, path.resolve(root, grant))
    const paths = [
      ...(tool?.paths ?? []),
      ...(granted === undefined ? [] : [granted]),
    ]
    return {
      ...toolId,
      tool: 'fileChange',
      title: one(
        reason ??
          (granted === undefined
            ? (tool?.text ?? '修改文件')
            : `允许写入 ${granted}`),
      ),
      ...(paths.length === 0 ? {} : { paths }),
      input: paths.join('\n').slice(0, MAX_ASK_INPUT),
      options: request.options,
      ...(tool?.diff !== undefined && tool.diff.text !== ''
        ? { detail: tool.diff.text }
        : {}),
    }
  }
  const server = String(request.input.server ?? '')
  const name = String(request.input.tool ?? '')
  return {
    tool: request.toolName,
    title: one(str(params.message) ?? `${server} · ${name}`),
    input: `${server} · ${name}`.slice(0, MAX_ASK_INPUT),
    options: request.options,
  }
}

/** Whether every file (absolute) is in the session's folder, links resolved. */
function allInRoot(root: string, files: readonly string[]): boolean {
  if (files.length === 0) return false
  for (const file of files) {
    const relative = path.relative(root, file)
    if (relative === '') continue // The folder itself.
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false
    try {
      resolveInRoot(root, relative.split(path.sep).join('/'))
    } catch {
      return false
    }
  }
  return true
}

/** The sandbox a turn names (`turn/start`'s `sandboxPolicy`). */
function sandboxPolicy(
  sandbox: CodexPolicy['sandbox'],
): Record<string, string> {
  return sandbox === 'danger-full-access'
    ? { type: 'dangerFullAccess' }
    : { type: 'workspaceWrite' }
}

export interface CodexAgentOptions {
  readonly program: string
  /** The agent's working folder (the thread's `cwd`). */
  readonly root: string
  readonly env: Readonly<Record<string, string>>
  /** The thread to resume; `''` before the first. */
  readonly threadId: string
  readonly started: boolean
  readonly mode: Mode
  readonly hooks: AgentHooks
  readonly interruptGraceMs: number
  readonly termGraceMs: number
}

/** One session's Codex. */
export class CodexAgent implements AgentProcess {
  readonly #options: CodexAgentOptions
  readonly #hooks: AgentHooks
  #mode: Mode
  /** The mode the turn in flight runs in: the runner's own answers follow it. */
  #turnMode: Mode
  #threadId: string
  #started: boolean
  #channel: CodexChannel | undefined
  #child: ChildProcess | undefined
  #ready: Promise<void> | undefined
  /** What the running process's thread was opened with. */
  #opened: CodexPolicy | undefined
  /** What its turns run in now, the turns' own policy included. */
  #effective: CodexPolicy | undefined
  #stopping = false
  /** Counts the turns sent, so a late escalation cannot hit a newer one. */
  #sent = 0
  /** The tool lines drawn, by item. */
  readonly #tools = new Map<string, ToolView>()
  /** The files a `fileChange` item changes (absolute), by item. */
  readonly #files = new Map<string, string[]>()
  /** A command's output as it streamed, by item. */
  readonly #output = new Map<string, string>()
  #turnError: Readonly<Record<string, unknown>> | undefined
  readonly #timers = new Set<ReturnType<typeof setTimeout>>()
  readonly #ending = new WeakSet<CodexChannel>()

  constructor(options: CodexAgentOptions) {
    this.#options = options
    this.#hooks = options.hooks
    this.#mode = options.mode
    this.#turnMode = options.mode
    this.#threadId = options.threadId
    this.#started = options.started
  }

  get alive(): boolean {
    const channel = this.#channel
    return channel !== undefined && channel.alive && !this.#ending.has(channel)
  }

  #spawn(): CodexChannel {
    const { program, root, env } = this.#options
    const policy = CODEX_MODES[this.#mode]
    const argv = codexArgv(program)
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: root,
      env: { ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group: a stop reaches whatever it started.
      detached: POSIX,
      windowsHide: true,
    })
    child.stdin?.on('error', () => {})
    const startedAt = Date.now()
    this.#child = child
    const resume =
      this.#started && this.#threadId !== '' ? this.#threadId : undefined
    const channel = new CodexChannel(child, {
      thread: async () => ({
        cwd: root,
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        // Its questions to this client and the person here, not to a
        // reviewer agent of Codex's.
        ...(policy.reviewer ? { approvalsReviewer: 'user' } : {}),
      }),
      ...(resume === undefined ? {} : { threadId: resume }),
      onThread: id => this.#thread(id, resume),
      ask: request => this.#ask(request),
      onDetail: detail => this.#detail(detail),
    })
    this.#channel = channel
    this.#opened = policy
    this.#effective = policy
    this.#ready = channel.initialize()
    void this.#ready.catch(() => {})
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

  #thread(id: string, resumed: string | undefined): void {
    // Asked to resume and given another: the rollout was gone.
    if (resumed !== undefined && id !== resumed)
      this.#hooks.notice(LOST, 'warn')
    this.#threadId = id
    this.#started = true
    this.#hooks.started(id)
  }

  #detail(detail: CodexDetail): void {
    const hooks = this.#hooks
    switch (detail.kind) {
      case 'text-delta':
        hooks.delta(detail.text)
        return
      case 'message':
        hooks.message(detail.text)
        return
      case 'thinking':
        hooks.activity('thinking', '思考中')
        return
      case 'tool': {
        if (detail.phase === 'start') {
          const root = this.#options.root
          const view = codexToolView(root, detail.item)
          if (view === undefined || this.#tools.has(view.id)) return
          this.#tools.set(view.id, view)
          if (detail.item.type === 'fileChange')
            this.#files.set(
              view.id,
              changesOf(root, detail.item).map(change => change.path),
            )
          hooks.toolStart(view)
          return
        }
        // One Codex ended without starting it (a declined command): drawn now.
        if (!this.#tools.has(detail.id)) {
          const view = codexToolView(this.#options.root, detail.item)
          if (view === undefined) return
          hooks.toolStart(view)
        }
        this.#tools.delete(detail.id)
        this.#files.delete(detail.id)
        const output = outputOf(detail.item, this.#output.get(detail.id))
        this.#output.delete(detail.id)
        hooks.toolEnd(detail.id, failed(detail.item), output)
        return
      }
      case 'tool-output': {
        const kept = (this.#output.get(detail.id) ?? '') + detail.text
        this.#output.set(detail.id, kept.slice(-MAX_OUTPUT))
        return
      }
      case 'turn-diff':
        hooks.turnDiff(detail.diff)
        return
      case 'turn-error':
        this.#turnError = detail.error
        return
    }
  }

  async #ask(request: CodexAsk): Promise<CodexAskDecision> {
    const mode = this.#turnMode
    const tool =
      request.itemId === undefined ? undefined : this.#tools.get(request.itemId)
    const byMode = () => {
      if (request.itemId !== undefined)
        this.#hooks.approvedByMode(request.itemId)
      return 'once' as const
    }
    // 「跳过权限确认」: whatever still asks is allowed (Codex asks nothing
    // in `never`; this is for what does anyway).
    if (mode === 'full-access') return byMode()
    // 「自动接受编辑」: an edit whose files (and the root it asks to write
    // under, if any) are all in the session's folder. Files not known (no
    // item seen) go to the person.
    if (mode === 'accept-edits' && request.kind === 'file-change') {
      const root = this.#options.root
      const known =
        request.itemId === undefined
          ? undefined
          : this.#files.get(request.itemId)
      const grant = str(request.params.grantRoot)
      if (
        known !== undefined &&
        allInRoot(root, [
          ...known,
          ...(grant === undefined ? [] : [path.resolve(root, grant)]),
        ])
      )
        return byMode()
    }
    const answer = await this.#hooks.ask(
      codexAskView(this.#options.root, request, tool),
      request.signal,
    )
    // Codex's `decline` takes no sentence: a note to a denial stays here.
    return answer.decision
  }

  async turn(text: string): Promise<TurnOutcome> {
    this.#stopping = false
    this.#turnMode = this.#mode
    const policy = CODEX_MODES[this.#mode]
    if (this.alive && this.#restartFor(policy)) await this.stop()
    const channel = this.alive ? this.#channel! : this.#spawn()
    try {
      await this.#ready
    } catch (error) {
      await Promise.race([channel.closed.catch(() => {}), Bun.sleep(200)])
      const said = channel.stderrTail.trim().slice(-400)
      if (channel.alive) await this.stop()
      const message = `Codex 起不来：${(error as Error).message}`
      return {
        status: 'error',
        message: withSignInHint(
          said === '' ? message : `${message}\n${said}`,
          SIGN_IN_HINT,
        ),
      }
    }
    if (this.#stopping) return { status: 'aborted' }
    return this.#once(channel, text, policy)
  }

  /** A turn's policy cannot say it: the process starts again on the same thread. */
  #restartFor(policy: CodexPolicy): boolean {
    const opened = this.#opened
    const effective = this.#effective
    if (opened === undefined || effective === undefined) return false
    if (policy.reviewer && !opened.reviewer) return true
    return (
      policy.sandbox !== effective.sandbox &&
      policy.sandbox !== 'danger-full-access'
    )
  }

  async #once(
    channel: CodexChannel,
    text: string,
    policy: CodexPolicy,
  ): Promise<TurnOutcome> {
    const opened = this.#opened ?? policy
    const effective = this.#effective ?? policy
    // Said again on every turn once it differs from what the thread opened
    // with, whether Codex keeps a turn's policy for later turns or not.
    const own = {
      ...(policy.approvalPolicy !== opened.approvalPolicy ||
      policy.approvalPolicy !== effective.approvalPolicy
        ? { approvalPolicy: policy.approvalPolicy }
        : {}),
      ...(policy.sandbox !== opened.sandbox ||
      policy.sandbox !== effective.sandbox
        ? { sandboxPolicy: sandboxPolicy(policy.sandbox) }
        : {}),
    }
    const { promise, resolve } = Promise.withResolvers<TurnOutcome>()
    const off = channel.onFrame(frame => {
      if (frame.type !== 'prompt_result') return
      const error = frame.error as { message?: unknown } | undefined
      resolve(
        frame.status === 'completed'
          ? { status: 'completed' }
          : frame.status === 'aborted'
            ? { status: 'aborted' }
            : {
                status: 'error',
                message:
                  typeof error?.message === 'string'
                    ? error.message
                    : 'Codex 这一轮失败了',
              },
      )
    })
    this.#sent++
    this.#turnError = undefined
    try {
      await channel.prompt({ messageId: randomUUID(), text, ...own })
    } catch (error) {
      off()
      return {
        status: this.#stopping ? 'aborted' : 'error',
        message: withSignInHint((error as Error).message, SIGN_IN_HINT),
      }
    }
    this.#effective = policy
    const outcome = await promise
    off()
    this.#tools.clear()
    this.#files.clear()
    this.#output.clear()
    if (this.#stopping && outcome.status !== 'completed')
      return { status: 'aborted' }
    if (outcome.status !== 'error') return outcome
    // Ended without Codex saying why: what it printed may.
    await Promise.race([channel.closed.catch(() => {}), Bun.sleep(200)])
    const said = channel.alive ? '' : channel.stderrTail.trim().slice(-400)
    const message =
      said === '' ? (outcome.message ?? '') : `${outcome.message}\n${said}`
    const hinted = withSignInHint(message, SIGN_IN_HINT)
    return {
      status: 'error',
      message:
        hinted === message && this.#unauthorized()
          ? `${message}\n${SIGN_IN_HINT}`
          : hinted,
    }
  }

  /** Codex said the turn failed for want of a login (`codexErrorInfo`). */
  #unauthorized(): boolean {
    return this.#turnError?.codexErrorInfo === 'unauthorized'
  }

  async setMode(
    mode: Mode,
  ): Promise<{ readonly mode: Mode; readonly applies: 'now' | 'next-turn' }> {
    this.#mode = mode
    // A running thread takes it with the next turn/start; a process not
    // running opens its thread in it.
    return { mode, applies: this.alive ? 'next-turn' : 'now' }
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
    const sent = this.#sent
    this.#later(this.#options.interruptGraceMs, () => {
      if (channel.alive && (!channel.busy || this.#sent !== sent)) return
      killGroup(pid, 'SIGTERM')
      this.#later(this.#options.termGraceMs, () => killGroup(pid, 'SIGKILL'))
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
      this.#later(this.#options.termGraceMs, () => {
        if (channel.alive) killGroup(pid, 'SIGKILL')
      })
    }
    await stopped
  }
}

/** Codex's driver: the thread id is the app-server's (`thread/start`). */
export const CODEX_DRIVER: Driver = {
  nativeKind: 'codex-thread',
  newNativeId: () => '',
  start: input =>
    new CodexAgent({
      program: input.program,
      root: input.root,
      env: input.env,
      threadId: input.native.id,
      started: input.native.started,
      mode: input.mode,
      hooks: input.hooks,
      interruptGraceMs: input.interruptGraceMs,
      termGraceMs: input.termGraceMs,
    }),
}
