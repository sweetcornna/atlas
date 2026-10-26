// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The ACP agents on this computer, as the user runs them (qmo-local.md
 * §4.3.4, §4.3.5, §4.4): Gemini CLI, Qwen Code, opencode and DeepSeek
 * Harness, each with the user's own login and settings, started with only
 * the flag that makes it speak ACP. One profile per agent says how it starts,
 * which of its ACP modes each permission mode is, and which of its
 * 「always allow」 options keeps to the session. The runner never calls
 * `authenticate` and never picks an option that writes the agent's settings.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import {
  type AcpAsk,
  type AcpAskDecision,
  AcpChannel,
  type AcpDetail,
  type AcpPermissionOption,
  AcpRpcError,
  type AcpToolCall,
  type AcpToolContent,
} from '@qianmo/harness/acpClient.ts'
import pkg from '../../../package.json' with { type: 'json' }
import { unifiedDiff } from '../diff.js'
import { ACP_MODES, type Mode } from '../modes.js'
import { insideRoot } from '../paths.js'
import { killGroup } from '../processes.js'
import { CodeError } from '../protocol.js'
import type {
  AgentHooks,
  AgentProcess,
  AskView,
  Driver,
  ToolView,
  TurnOutcome,
} from './agent.js'

/** How the runner starts and answers one ACP agent. */
export interface AcpProfile {
  /** The runtime catalog's id. */
  readonly id: 'gemini' | 'qwen' | 'opencode' | 'dsh'
  /** Only the flags that make it speak ACP (§4.3.4). */
  readonly argv: (program: string) => string[]
  /** What the user runs in a terminal to sign in. */
  readonly signIn: string
  /** Its ACP mode ids for each mode; absent: the runner answers by the mode. */
  readonly modes?: Readonly<Record<Mode, readonly string[]>>
  /**
   * Which `allow_always` option keeps to this session; absent, or none
   * recognized: 「本会话都允许」 is not offered.
   */
  readonly sessionOption?: (option: AcpPermissionOption) => boolean
  /** How a conversation continues (absent: what the agent advertises). */
  readonly resume?: 'session/resume' | 'session/load'
}

/**
 * Gemini CLI 0.64 offers two `allow_always` options: `proceed_always`
 * (this session) and `proceed_always_and_save` (written into its settings);
 * only the first is ever chosen. Qwen Code keeps Gemini CLI's ids (not
 * checked on a real install).
 */
const GEMINI_SESSION_OPTION = (option: AcpPermissionOption) =>
  option.optionId === 'proceed_always'

export const ACP_PROFILES: Readonly<Record<AcpProfile['id'], AcpProfile>> = {
  gemini: {
    id: 'gemini',
    argv: program => [program, '--acp'],
    signIn: 'gemini',
    modes: ACP_MODES,
    sessionOption: GEMINI_SESSION_OPTION,
  },
  qwen: {
    id: 'qwen',
    argv: program => [program, '--acp'],
    signIn: 'qwen',
    modes: ACP_MODES,
    sessionOption: GEMINI_SESSION_OPTION,
  },
  // Whether opencode's `always` stays in the session is not known here:
  // not offered.
  opencode: {
    id: 'opencode',
    argv: program => [program, 'acp'],
    signIn: 'opencode auth login',
  },
  dsh: {
    id: 'dsh',
    argv: program => [program, '--profile', 'acp'],
    signIn: 'dsh',
    // No `session/load`; `session/resume` restores the history model-side.
    resume: 'session/resume',
  },
}

export function acpProfile(agentId: string): AcpProfile {
  const found = Object.values(ACP_PROFILES).find(one => one.id === agentId)
  if (found === undefined) throw new CodeError('E_AGENT', '后续版本支持')
  return found
}

/** What the runner writes when the agent no longer has the conversation. */
export function acpLost(name: string): string {
  return `上次的对话 ${name} 那边已经没有了，这一句从新对话开始`
}

const MAX_SUMMARY = 160
const MAX_ASK_INPUT = 2 * 1024
const POSIX = process.platform !== 'win32'
/** What an edit is, as ACP's `kind` says. */
const EDIT_KINDS = new Set(['edit', 'delete', 'move'])
/** How strict each mode is: a mode may only be weakened by the person. */
const STRICTNESS: Readonly<Record<Mode, number>> = {
  off: 0,
  'accept-edits': 1,
  auto: 1,
  'full-access': 2,
}
const MODE_NAMES: Readonly<Record<Mode, string>> = {
  off: '人工确认',
  'accept-edits': '自动接受编辑',
  auto: '自动审批',
  'full-access': '跳过权限确认',
}
/**
 * Starts in a row that failed to continue a conversation, by its id, for
 * the runner's life: a process (and its driver) may go between them.
 */
const RESUME_FAILURES = new Map<string, number>()

/** The mode an agent's own ACP mode id is (`auto` is never told apart). */
function tierOf(
  table: Readonly<Record<Mode, readonly string[]>>,
  modeId: string | undefined,
): Mode | undefined {
  if (modeId === undefined) return undefined
  return (['off', 'accept-edits', 'full-access'] as const).find(mode =>
    table[mode].includes(modeId),
  )
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
  const absolute = path.resolve(root, file)
  const rel = path.relative(root, absolute)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
    ? rel.split(path.sep).join('/')
    : absolute
}

/** Every path a call names: its locations, its diffs, its input's. */
function callPaths(
  call: AcpToolCall,
  content: readonly AcpToolContent[],
): string[] {
  const raw = call.rawInput
  const named = [
    ...call.paths,
    ...content.flatMap(part => (part.type === 'diff' ? [part.path] : [])),
    ...[raw.file_path, raw.filePath, raw.absolute_path, raw.path].filter(
      (value): value is string => typeof value === 'string' && value !== '',
    ),
  ]
  return [...new Set(named)]
}

/** The diffs of a call's content, as one unified diff without file headers. */
function diffOf(content: readonly AcpToolContent[]): ToolView['diff'] {
  let text = ''
  let added = 0
  let removed = 0
  let any = false
  for (const part of content) {
    if (part.type !== 'diff') continue
    any = true
    const diff = unifiedDiff(part.oldText ?? '', part.newText)
    text += text === '' ? diff.text : `\n${diff.text}`
    added += diff.added
    removed += diff.removed
  }
  return any ? { text, added, removed } : undefined
}

function outputOf(content: readonly AcpToolContent[]): string {
  return content
    .flatMap(part => (part.type === 'text' ? [part.text] : []))
    .join('\n')
}

/** An ACP tool call as its process line shows it. */
export function acpToolView(
  root: string,
  id: string,
  call: AcpToolCall,
  content: readonly AcpToolContent[],
): ToolView {
  const paths = callPaths(call, content).map(file => shown(root, file))
  const command = str(call.rawInput.command)
  const diff = diffOf(content)
  const kind = call.kind
  const target =
    kind === 'execute'
      ? (command ?? call.title)
      : kind === 'fetch'
        ? (str(call.rawInput.url) ?? call.title)
        : paths[0]
  const verb =
    kind === 'edit'
      ? '编辑'
      : kind === 'delete'
        ? '删除'
        : kind === 'move'
          ? '移动'
          : kind === 'read'
            ? '读取'
            : kind === 'execute'
              ? '运行'
              : kind === 'fetch'
                ? '打开'
                : undefined
  return {
    id,
    name: str(call.meta?.toolName) ?? kind ?? 'tool',
    text: one(
      verb !== undefined && target !== undefined
        ? `${verb} ${target}`
        : call.title,
    ),
    ...(paths.length === 0 ? {} : { paths }),
    ...(command === undefined ? {} : { command }),
    detailKind:
      diff !== undefined || (kind !== undefined && EDIT_KINDS.has(kind))
        ? 'diff'
        : 'output',
    ...(diff === undefined ? {} : { diff }),
  }
}

/** A permission question as its card shows it. */
export function acpAskView(root: string, request: AcpAsk): AskView {
  const tool = acpToolView(
    root,
    request.toolCallId ?? 'ask',
    request.call,
    request.content,
  )
  const raw = request.call.rawInput
  const input = (
    tool.command ??
    tool.paths?.[0] ??
    (Object.keys(raw).length === 0 ? '' : JSON.stringify(raw))
  ).slice(0, MAX_ASK_INPUT)
  return {
    ...(request.toolCallId === undefined ? {} : { toolId: request.toolCallId }),
    tool: tool.name,
    title: one(request.call.title === '' ? tool.text : request.call.title),
    ...(tool.paths === undefined ? {} : { paths: tool.paths }),
    ...(input === '' ? {} : { input }),
    options: request.decisions,
    ...(tool.diff !== undefined && tool.diff.text !== ''
      ? { detail: tool.diff.text }
      : input === ''
        ? {}
        : { detail: input }),
  }
}

/**
 * Whether the runner answers this question itself by the mode (§4.4):
 * everything in 「跳过权限确认」; in 「自动接受编辑」 and 「自动审批」 an
 * edit, with every path it names inside the session's folder and no command
 * in it. Never a command otherwise.
 */
export function acpAnswersByMode(
  mode: Mode,
  root: string,
  request: Pick<AcpAsk, 'call' | 'content'>,
): boolean {
  if (mode === 'full-access') return true
  if (mode === 'off') return false
  const { call, content } = request
  if (call.kind === undefined || !EDIT_KINDS.has(call.kind)) return false
  if (call.rawInput.command !== undefined) return false
  const paths = callPaths(call, content)
  return paths.length > 0 && paths.every(file => insideRoot(root, file))
}

/** The agent's own words, with how to sign in when they are about that. */
export function acpStartError(
  error: unknown,
  profile: AcpProfile,
  said: string,
): string {
  const message = error instanceof Error ? error.message : String(error)
  const text = said === '' ? message : `${message}\n${said}`
  const auth =
    (error instanceof AcpRpcError && error.code === -32000) ||
    /auth|log ?in|sign ?in|credential|api key|unauthori[sz]ed|\b401\b/i.test(
      text,
    )
  return auth ? `${text}\n在终端里运行 \`${profile.signIn}\` 登录后再试` : text
}

export interface AcpAgentOptions {
  readonly profile: AcpProfile
  /** The agent's display name (`qmo agents`). */
  readonly name: string
  readonly program: string
  /** The agent's working folder. */
  readonly root: string
  readonly env: Readonly<Record<string, string>>
  /** The agent's session id, `''` before it gave one. */
  readonly nativeId: string
  /** The conversation exists (it has had a line). */
  readonly started: boolean
  readonly mode: Mode
  readonly hooks: AgentHooks
  /** How long a cancel has before the group gets SIGTERM, then SIGKILL. */
  readonly interruptGraceMs?: number
  readonly termGraceMs?: number
}

/** One session's ACP agent. */
export class AcpAgent implements AgentProcess {
  readonly #options: AcpAgentOptions
  readonly #profile: AcpProfile
  readonly #hooks: AgentHooks
  #mode: Mode
  #nativeId: string
  #started: boolean
  #channel: AcpChannel | undefined
  #child: ChildProcess | undefined
  /** Channels whose `initialize` succeeded. */
  readonly #opened = new WeakSet<AcpChannel>()
  #stopping = false
  /** Counts the turns sent, so a late escalation cannot hit a newer one. */
  #sent = 0
  readonly #timers = new Set<ReturnType<typeof setTimeout>>()
  /** Processes being ended: not to be given a turn. */
  readonly #ending = new WeakSet<AcpChannel>()

  constructor(options: AcpAgentOptions) {
    this.#options = options
    this.#profile = options.profile
    this.#hooks = options.hooks
    this.#mode = options.mode
    this.#nativeId = options.nativeId
    this.#started = options.started && options.nativeId !== ''
  }

  get alive(): boolean {
    const channel = this.#channel
    return channel !== undefined && channel.alive && !this.#ending.has(channel)
  }

  #spawn(): AcpChannel {
    const { program, root, env, name } = this.#options
    const argv = this.#profile.argv(program)
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
    const resume = this.#profile.resume
    const channel: AcpChannel = new AcpChannel(child, {
      label: name,
      runtime: resume === undefined ? {} : { resume },
      cwd: root,
      // The agent's own MCP servers, as it has them configured.
      mcpServers: [],
      ...(this.#started
        ? {
            sessionId: this.#nativeId,
            resumeFailures: RESUME_FAILURES.get(this.#nativeId) ?? 0,
          }
        : {}),
      onSession: id => {
        RESUME_FAILURES.delete(this.#nativeId)
        if (this.#started && id !== this.#nativeId)
          this.#hooks.notice(acpLost(name), 'warn')
        if (id !== this.#nativeId) this.#started = false
        this.#nativeId = id
      },
      onResumeFailed: () => {
        const id = this.#nativeId
        RESUME_FAILURES.set(id, (RESUME_FAILURES.get(id) ?? 0) + 1)
      },
      clientInfo: { name: 'qmo', title: 'Qmo', version: pkg.version },
      onDetail: detail => this.#detail(detail),
      ask: request => this.#ask(request),
      ...(this.#profile.sessionOption === undefined
        ? {}
        : { sessionOption: this.#profile.sessionOption }),
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

  #detail(detail: AcpDetail): void {
    const hooks = this.#hooks
    const root = this.#options.root
    switch (detail.kind) {
      case 'thinking':
        hooks.activity('thinking', '思考中')
        return
      case 'text-delta':
        hooks.delta(detail.text)
        return
      case 'message':
        hooks.message(detail.text)
        return
      case 'mode':
        this.#agentMode(detail.modeId)
        return
      case 'tool':
        if (detail.phase === 'start')
          hooks.toolStart(
            acpToolView(root, detail.id, detail.call, detail.content),
          )
        else if (detail.phase === 'end')
          hooks.toolEnd(
            detail.id,
            detail.isError === true,
            outputOf(detail.content),
            diffOf(detail.content),
          )
        return
    }
  }

  /** The agent changed its mode itself (a person's 「always」 can do that). */
  #agentMode(modeId: string): void {
    const modes = this.#profile.modes
    if (modes === undefined || modes[this.#mode].includes(modeId)) return
    const now = tierOf(modes, modeId)
    if (now === undefined) return
    this.#mode = now
    this.#hooks.modeChanged(now)
  }

  async #ask(request: AcpAsk): Promise<AcpAskDecision> {
    if (acpAnswersByMode(this.#mode, this.#options.root, request)) {
      if (request.toolCallId !== undefined)
        this.#hooks.approvedByMode(request.toolCallId)
      return 'once'
    }
    // ACP's answer has no room for a sentence: a refusal is just that.
    const answer = await this.#hooks.ask(
      acpAskView(this.#options.root, request),
      request.signal,
    )
    return answer.decision
  }

  /**
   * Puts the agent in `mode`'s ACP mode. Where it reports no modes at all,
   * the runner answers by the mode (as for opencode and dsh). Where it would
   * stay looser than asked (it lacks the mode, or refuses the switch), this
   * throws, and no line is sent in it. Otherwise the runner does not go
   * around the agent: a mode it lacks, or a switch it refuses (an untrusted
   * folder, a policy of its own), refuses a change of mode (`change`);
   * before a line the session goes to the widest of its own modes no looser
   * than asked (refused: the one it is in), says so, and the runner answers
   * by that mode only.
   */
  async #applyMode(
    channel: AcpChannel,
    mode: Mode,
    change = false,
  ): Promise<void> {
    const table = this.#profile.modes
    const offered = channel.modes
    if (table === undefined || offered === undefined) return
    const current = offered.current
    const target = table[mode].find(id =>
      offered.available.some(one => one.id === id),
    )
    if (target !== undefined && current === target) return
    const looser =
      current !== undefined &&
      (['off', 'accept-edits', 'full-access'] as const).some(
        tier =>
          table[tier].includes(current) && STRICTNESS[tier] > STRICTNESS[mode],
      )
    const { name } = this.#options
    if (target === undefined) {
      if (looser)
        throw new CodeError(
          'E_AGENT',
          `${name} 没有「${MODE_NAMES[mode]}」对应的模式，它现在是 ${current}`,
        )
      // Nothing stricter to fall to: the person answers everything.
      if (mode === 'off') return
      const lacking = `${name} 没有「${MODE_NAMES[mode]}」（它没提供 ${table[mode].join(' 或 ')}）`
      if (change) throw new CodeError('E_AGENT', lacking)
      const now =
        (['accept-edits', 'off'] as const).find(
          tier =>
            STRICTNESS[tier] < STRICTNESS[mode] &&
            table[tier].some(id =>
              offered.available.some(one => one.id === id),
            ),
        ) ?? 'off'
      this.#mode = now
      this.#hooks.modeChanged(now)
      this.#hooks.notice(`${lacking}，按「${MODE_NAMES[now]}」继续`, 'warn')
      // Then into that mode of its own (`off` without one stops there).
      await this.#applyMode(channel, now)
      return
    }
    try {
      await channel.setMode(target)
    } catch (error) {
      const why = (error as Error).message
      if (looser || change)
        throw new CodeError('E_AGENT', `${name} 没有切到 ${target}：${why}`)
      const now = tierOf(table, current) ?? 'off'
      this.#mode = now
      this.#hooks.modeChanged(now)
      this.#hooks.notice(
        `${name} 没有切到 ${target}（${why}），按「${MODE_NAMES[now]}」继续`,
        'warn',
      )
    }
  }

  async turn(text: string): Promise<TurnOutcome> {
    this.#stopping = false
    const channel = this.alive ? this.#channel! : this.#spawn()
    if (!this.#opened.has(channel)) {
      try {
        await channel.initialize()
        this.#opened.add(channel)
      } catch (error) {
        await Promise.race([channel.closed.catch(() => {}), Bun.sleep(200)])
        const said = channel.alive ? '' : channel.stderrTail.trim().slice(-400)
        await this.stop()
        return {
          status: 'error',
          message:
            error instanceof AcpRpcError
              ? acpStartError(error, this.#profile, said)
              : acpStartError(
                  new Error(
                    `${this.#options.name} 起不来：${(error as Error).message}`,
                  ),
                  this.#profile,
                  said,
                ),
        }
      }
    }
    try {
      await this.#applyMode(channel, this.#mode)
    } catch (error) {
      return { status: 'error', message: (error as Error).message }
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
                    : `${this.#options.name} 这一轮失败了`,
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
    // The line reached the agent: its conversation is there to continue.
    const id = channel.sessionId
    if (id !== undefined && !this.#started) {
      this.#started = true
      this.#hooks.started(id)
    }
    const outcome = await promise
    off()
    if (this.#stopping && outcome.status !== 'completed')
      return { status: 'aborted' }
    if (outcome.status !== 'error') return outcome
    await Promise.race([channel.closed.catch(() => {}), Bun.sleep(200)])
    const said = channel.alive ? '' : channel.stderrTail.trim().slice(-400)
    return {
      status: 'error',
      message: acpStartError(
        new Error(outcome.message ?? ''),
        this.#profile,
        said,
      ),
    }
  }

  async setMode(
    mode: Mode,
  ): Promise<{ readonly mode: Mode; readonly applies: 'now' | 'next-turn' }> {
    const channel = this.#channel
    if (channel === undefined || !this.alive || !this.#opened.has(channel)) {
      // The next process is put in it before its first line.
      this.#mode = mode
      return { mode, applies: 'now' }
    }
    const before = this.#mode
    // Set first: the agent's word that it switched is then not news.
    this.#mode = mode
    try {
      await this.#applyMode(channel, mode, true)
    } catch (error) {
      this.#mode = before
      throw error
    }
    return { mode, applies: 'now' }
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
    const grace = (this.#options.interruptGraceMs ?? 5_000) + 100
    const term = this.#options.termGraceMs ?? 3_000
    const sent = this.#sent
    this.#later(grace, () => {
      // Cancelled the native way: the process stays for the next turn.
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

export const ACP_DRIVER: Driver = {
  nativeKind: 'acp-session',
  // The agent gives the id (`session/new`).
  newNativeId: () => '',
  start: input =>
    new AcpAgent({
      profile: acpProfile(input.agentId),
      name: input.name,
      program: input.program,
      root: input.root,
      env: input.env,
      nativeId: input.native.id,
      started: input.native.started,
      mode: input.mode,
      hooks: input.hooks,
      interruptGraceMs: input.interruptGraceMs,
      termGraceMs: input.termGraceMs,
    }),
}
