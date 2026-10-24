// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local sessions (qmo-local.md §4.3.2–§4.3.6): one state machine each
 * (idle, running, waiting, interrupted, failed), a queue of at most five
 * lines, one agent process each, at most four running at once, ten idle
 * minutes before a process is ended, and the conversation written as it
 * happens. A record goes to the file first, then to the page.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import * as path from 'node:path'
import type {
  AgentHooks,
  AgentProcess,
  AskAnswer,
  AskView,
  ToolView,
} from './drivers/agent.js'
import { ClaudeAgent, NO_AUTO } from './drivers/claude.js'
import {
  type Changes,
  diff as fileDiff,
  type FileDiff,
  type GitContext,
  changes as gitChanges,
  gitTop,
} from './git.js'
import { DEFAULT_MODE, type Mode } from './modes.js'
import { checkPickedFolder, sessionRoot } from './paths.js'
import type { ChildRegistry } from './processes.js'
import {
  type AskDecision,
  type AskInfo,
  CodeError,
  type CodeEvent,
  type CodeRecord,
  type CodeTurn,
  FEATURES,
  type Folder,
  type SessionState,
  type Summary,
  type ToolInfo,
} from './protocol.js'
import {
  type CodeStore,
  clipDetail,
  clipMessage,
  MAX_FOLDERS,
  newFolderId,
  newSessionId,
  newTurnId,
  type SessionHeader,
  type StoredFolder,
  Transcript,
} from './store.js'

/** An agent the runner may start, as `qmo agents` found it. */
export type FoundAgent =
  | {
      readonly ok: true
      readonly id: string
      readonly name: string
      readonly version: string | null
      readonly path: string
      readonly protocol: string
    }
  | { readonly ok: false; readonly reason: string }

export interface Limits {
  /** Agent processes alive at once. */
  readonly maxAgents: number
  /** An idle agent process is ended after this long. */
  readonly idleMs: number
  /** Lines waiting behind a running turn, per session. */
  readonly queue: number
  /** Text streamed is sent at most this often. */
  readonly deltaMs: number
  readonly interruptGraceMs: number
  readonly termGraceMs: number
}

export const DEFAULT_LIMITS: Limits = {
  maxAgents: 4,
  idleMs: 10 * 60 * 1000,
  queue: 5,
  deltaMs: 50,
  interruptGraceMs: 5_000,
  termGraceMs: 3_000,
}

/** A `delta` event's text is at most this many UTF-8 bytes. */
const MAX_DELTA_BYTES = 4 * 1024
/** A `record` event larger than this is sent as `trimmed` (§4.5.2). */
const MAX_EVENT_BYTES = 8 * 1024
const MAX_TITLE = 120

export interface SessionManagerOptions {
  readonly store: CodeStore
  /** The client folder: never a session's folder. */
  readonly clientDir: string
  /** The home the guarded roots are under. */
  readonly home?: string
  readonly emit: (event: CodeEvent) => void
  readonly findAgent: (id: string) => Promise<FoundAgent>
  /** The environment an agent starts with (env.ts). */
  readonly agentEnv: () => Promise<Record<string, string>>
  /** Where git is; `undefined` when it is not installed. */
  readonly git: () => Promise<GitContext | undefined>
  readonly children: ChildRegistry
  readonly limits?: Partial<Limits>
  readonly now?: () => number
  readonly log?: (line: string) => void
}

interface Live {
  readonly turn: string
  text: string
  sent: number
}

interface Queued {
  readonly turnId: string
  readonly text: string
}

interface OpenAsk {
  readonly turnId: string
  readonly options: readonly AskDecision[]
  readonly toolId?: string
  readonly settle: (answer: AskAnswer, by: 'user' | 'stop' | 'shutdown') => void
}

class Session {
  header: SessionHeader
  #transcript: Transcript | undefined
  agent: AgentProcess | undefined
  /** The program the agent was started from (for `noAuto`). */
  program: string | undefined
  readonly queue: Queued[] = []
  /** A turn is in flight (or waits for room). */
  active = false
  stopping = false
  live: Live | undefined
  flushTimer: ReturnType<typeof setTimeout> | undefined
  idleTimer: ReturnType<typeof setTimeout> | undefined
  lastActive: number
  activity = ''
  readonly asks = new Map<string, OpenAsk>()
  /** Tool call id → its process line. */
  readonly tools = new Map<string, string>()
  readonly approved = new Map<string, 'user' | 'session'>()
  readonly denied = new Set<string>()
  /** Settles a wait for room with `false` when the turn is stopped. */
  cancelWait: ((go: boolean) => void) | undefined
  readonly store: CodeStore

  constructor(store: CodeStore, header: SessionHeader, now: number) {
    this.store = store
    this.header = header
    this.lastActive = now
  }

  get transcript(): Transcript {
    this.#transcript ??= Transcript.load(this.store, this.header.id)
    return this.#transcript
  }
  set transcript(transcript: Transcript) {
    this.#transcript = transcript
  }
}

function utf8Chunks(text: string, max: number): string[] {
  const out: string[] = []
  let current = ''
  let size = 0
  for (const char of text) {
    const bytes = Buffer.byteLength(char)
    if (size + bytes > max && current !== '') {
      out.push(current)
      current = ''
      size = 0
    }
    current += char
    size += bytes
  }
  if (current !== '') out.push(current)
  return out
}

function titleOf(text: string): string {
  const line = text.trim().split('\n', 1)[0]!.trim()
  if (line === '') return '新会话'
  const chars = [...line]
  return chars.length > MAX_TITLE
    ? `${chars.slice(0, MAX_TITLE - 1).join('')}…`
    : line
}

export class SessionManager {
  readonly #options: SessionManagerOptions
  readonly #limits: Limits
  readonly #now: () => number
  readonly #sessions = new Map<string, Session>()
  #folders: StoredFolder[]
  /** Sessions holding one of the agent process slots. */
  readonly #slots = new Set<Session>()
  readonly #waiting: { session: Session; go: (go: boolean) => void }[] = []
  /** Programs found to have no `auto` (for this runner's life). */
  readonly #noAuto = new Set<string>()
  #closing = false

  constructor(options: SessionManagerOptions) {
    this.#options = options
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.#now = options.now ?? Date.now
    this.#folders = options.store.readFolders()
    for (const id of options.store.sessionIds()) {
      const header = options.store.readHeader(id)
      if (header === undefined) {
        this.#log(`skipped a damaged session: ${id}`)
        continue
      }
      this.#sessions.set(id, new Session(options.store, header, this.#now()))
    }
    this.#recover()
  }

  #log(line: string): void {
    this.#options.log?.(line)
  }

  /**
   * A runner that ended mid-turn (a crash, a kill) left sessions running:
   * they are interrupted, an open question is denied, a running tool failed,
   * a queued line not sent. The next line resumes as usual.
   */
  #recover(): void {
    for (const session of this.#sessions.values()) {
      const { state } = session.header
      if (state !== 'running' && state !== 'waiting') continue
      try {
        const at = this.#now()
        for (const turn of session.transcript.turns()) {
          if (turn.ask !== undefined && turn.ask.decision === undefined)
            session.transcript.write({
              ...turn,
              ask: { ...turn.ask, decision: 'deny', by: 'shutdown', at },
            })
          else if (turn.tool?.status === 'running')
            session.transcript.write({
              ...turn,
              severity: 'error',
              tool: { ...turn.tool, status: 'failed' },
            })
          else if (turn.author === 'operator' && turn.state === 'pending')
            session.transcript.write({
              ...turn,
              state: 'failed',
              code: 'E_NOT_SENT',
            })
        }
        session.header = {
          ...session.header,
          lastSeq: session.transcript.lastSeq,
        }
      } catch (error) {
        this.#log(`could not repair ${session.header.id}: ${String(error)}`)
      }
      this.#header(session, { state: 'interrupted' })
    }
  }

  // ---- shapes ----------------------------------------------------------------

  #folder(stored: StoredFolder): Folder {
    return {
      id: stored.id,
      name: stored.name,
      path: stored.path,
      git: gitTop(stored.path) !== undefined,
    }
  }

  #summary(session: Session): Summary {
    const { header } = session
    const folder = this.#folders.find(one => one.path === header.folder.path)
    return {
      id: header.id,
      title: header.title,
      folder: { id: folder?.id ?? null, name: header.folder.name },
      agent: { id: header.agent.id, name: header.agent.name },
      mode: header.mode,
      state: header.state,
      remote: false,
      createdAt: header.createdAt,
      updatedAt: header.updatedAt,
      lastSeq: header.lastSeq,
    }
  }

  #header(
    session: Session,
    change: Partial<Pick<SessionHeader, 'state' | 'mode' | 'native'>>,
    announce = true,
  ): void {
    session.header = { ...session.header, ...change, updatedAt: this.#now() }
    try {
      this.#options.store.writeHeader(session.header)
    } catch (error) {
      this.#log(`could not write ${session.header.id}: ${String(error)}`)
    }
    if (announce)
      this.#options.emit({ type: 'session', session: this.#summary(session) })
  }

  #setState(session: Session, state: SessionState): void {
    if (session.header.state !== state) this.#header(session, { state })
  }

  /** Writes a line, then tells the page. */
  #write(session: Session, turn: CodeTurn): CodeRecord {
    const record = session.transcript.write(turn)
    session.header = { ...session.header, lastSeq: record.seq }
    const event: CodeEvent = {
      type: 'record',
      session: session.header.id,
      seq: record.seq,
      record,
    }
    this.#options.emit(
      Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES
        ? {
            type: 'record',
            session: session.header.id,
            seq: record.seq,
            trimmed: true,
          }
        : event,
    )
    return record
  }

  #notice(
    session: Session,
    text: string,
    severity: 'info' | 'warn' | 'error',
    extra: Partial<CodeTurn> = {},
  ): CodeTurn {
    const turn: CodeTurn = {
      id: newTurnId(),
      sessionId: session.header.id,
      author: 'agent',
      at: this.#now(),
      text,
      state: 'done',
      variant: 'notice',
      noticeSource: 'step',
      severity,
      ...extra,
    }
    this.#write(session, turn)
    return turn
  }

  #session(id: string): Session {
    const session = this.#sessions.get(id)
    if (session === undefined) throw new CodeError('E_SESSION', '没有这个会话')
    return session
  }

  // ---- folders -----------------------------------------------------------------

  list(): {
    v: 1
    features: typeof FEATURES
    folders: Folder[]
    sessions: Summary[]
  } {
    return {
      v: 1,
      features: FEATURES,
      folders: this.#folders.map(one => this.#folder(one)),
      sessions: [...this.#sessions.values()]
        .map(session => this.#summary(session))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    }
  }

  /** A folder the dialog picked: checked, resolved, remembered (newest first). */
  addFolder(picked: string): Folder {
    const resolved = checkPickedFolder(
      picked,
      this.#options.clientDir,
      this.#options.home,
    )
    const known = this.#folders.find(one => one.path === resolved)
    const folder: StoredFolder = {
      id: known?.id ?? newFolderId(),
      path: resolved,
      name: path.basename(resolved) || resolved,
      pickedAt: this.#now(),
    }
    this.#folders = [
      folder,
      ...this.#folders.filter(one => one.id !== folder.id),
    ].slice(0, MAX_FOLDERS)
    this.#options.store.writeFolders(this.#folders)
    return this.#folder(folder)
  }

  forgetFolder(id: string): void {
    if (!this.#folders.some(one => one.id === id))
      throw new CodeError('E_FOLDER', '没有这个文件夹')
    this.#folders = this.#folders.filter(one => one.id !== id)
    this.#options.store.writeFolders(this.#folders)
  }

  // ---- sessions ------------------------------------------------------------------

  async start(input: {
    readonly folder: string
    readonly agent: string
    readonly mode: Mode
    readonly text: string
    readonly clientId: string
  }): Promise<{ session: Summary; turn: CodeTurn }> {
    if (this.#closing) throw new CodeError('E_RUNNER', '运行器正在退出')
    const folder = this.#folders.find(one => one.id === input.folder)
    if (folder === undefined) throw new CodeError('E_FOLDER', '没有这个文件夹')
    const root = sessionRoot(folder.path)
    const found = await this.#options.findAgent(input.agent)
    if (!found.ok) throw new CodeError('E_AGENT', found.reason)
    const id = newSessionId()
    const now = this.#now()
    const noAuto = input.mode === 'auto' && this.#noAuto.has(found.path)
    const header: SessionHeader = {
      id,
      title: titleOf(input.text),
      createdAt: now,
      updatedAt: now,
      folder: { path: folder.path, name: folder.name },
      root,
      agent: {
        id: found.id,
        name: found.name,
        protocol: found.protocol,
        version: found.version,
      },
      mode: noAuto ? 'accept-edits' : input.mode,
      state: 'running',
      lastSeq: 0,
      native: { kind: 'claude-session', id: randomUUID(), started: false },
      remote: { on: false, pushedSeq: 0 },
    }
    this.#options.store.ensure()
    this.#options.store.writeHeader(header)
    const session = new Session(this.#options.store, header, now)
    session.transcript = Transcript.create(this.#options.store, {
      id,
      target: 'local',
      node: 'local',
      agent: found.name,
      createdAt: now,
    })
    session.program = found.path
    this.#sessions.set(id, session)
    this.#options.emit({ type: 'session', session: this.#summary(session) })
    const turn = this.#operator(session, input.text, input.clientId, 'read')
    if (noAuto) this.#notice(session, NO_AUTO, 'warn')
    session.queue.push({ turnId: turn.id, text: input.text })
    void this.#pump(session)
    return { session: this.#summary(session), turn }
  }

  #operator(
    session: Session,
    text: string,
    clientId: string,
    state: 'read' | 'pending',
  ): CodeTurn {
    const turn: CodeTurn = {
      id: newTurnId(),
      sessionId: session.header.id,
      author: 'operator',
      at: this.#now(),
      text,
      state,
      clientId,
    }
    this.#write(session, turn)
    return turn
  }

  async send(input: {
    readonly session: string
    readonly text: string
    readonly clientId: string
  }): Promise<{ turn: CodeTurn; queued: boolean }> {
    if (this.#closing) throw new CodeError('E_RUNNER', '运行器正在退出')
    const session = this.#session(input.session)
    if (session.transcript.full)
      throw new CodeError(
        'E_LIMIT',
        '这个会话的记录到了 64 MiB，开一个新会话接着做',
      )
    try {
      sessionRoot(session.header.root)
    } catch {
      throw new CodeError('E_FOLDER', '文件夹不在了，这个会话只能看')
    }
    const busy = session.active || session.queue.length > 0
    if (busy && session.queue.length >= this.#limits.queue)
      throw new CodeError(
        'E_BUSY',
        `排队的已有 ${this.#limits.queue} 条，等这一轮结束再发`,
      )
    const turn = this.#operator(
      session,
      input.text,
      input.clientId,
      busy ? 'pending' : 'read',
    )
    session.queue.push({ turnId: turn.id, text: input.text })
    if (!busy) {
      this.#header(session, { state: 'running' })
      void this.#pump(session)
    }
    return { turn, queued: busy }
  }

  /** Stops the turn: the queue is withdrawn, open questions denied, the agent interrupted. */
  stop(id: string, by: 'stop' | 'shutdown' = 'stop'): void {
    const session = this.#session(id)
    if (!session.active && session.queue.length === 0) return
    session.stopping = true
    this.#withdraw(session)
    for (const ask of [...session.asks.values()])
      ask.settle({ decision: 'deny' }, by)
    session.cancelWait?.(false)
    session.agent?.abort()
  }

  /** Lines waiting in the queue are marked 「未发出」. */
  #withdraw(session: Session): void {
    for (const queued of session.queue.splice(0)) {
      const turn = session.transcript.turn(queued.turnId)
      if (turn !== undefined && turn.state === 'pending')
        this.#write(session, { ...turn, state: 'failed', code: 'E_NOT_SENT' })
    }
  }

  answer(input: {
    readonly session: string
    readonly ask: string
    readonly decision: AskDecision
    readonly message?: string
  }): void {
    const session = this.#session(input.session)
    const ask = session.asks.get(input.ask)
    if (ask === undefined)
      throw new CodeError('E_ASK', '这条征询已经答过或已失效')
    if (!ask.options.includes(input.decision))
      throw new CodeError('E_ASK', '这条征询没有这个选项')
    ask.settle(
      {
        decision: input.decision,
        ...(input.decision === 'deny' && input.message !== undefined
          ? { message: input.message }
          : {}),
      },
      'user',
    )
  }

  async setMode(input: {
    readonly session: string
    readonly mode: Mode
  }): Promise<{ mode: Mode; applies: 'now' | 'next-turn' }> {
    const session = this.#session(input.session)
    let result: { mode: Mode; applies: 'now' | 'next-turn' }
    // An agent, even one between processes (a turn may be about to start
    // one), takes the mode itself: dropping it would leave that process to
    // nobody.
    if (session.agent !== undefined)
      result = await session.agent.setMode(input.mode)
    else {
      const noAuto =
        input.mode === 'auto' &&
        session.program !== undefined &&
        this.#noAuto.has(session.program)
      if (noAuto) this.#notice(session, NO_AUTO, 'warn')
      // The next process starts in it.
      result = { mode: noAuto ? 'accept-edits' : input.mode, applies: 'now' }
    }
    if (result.mode !== session.header.mode)
      this.#header(session, { mode: result.mode })
    return result
  }

  read(input: {
    readonly session: string
    readonly before?: number
    readonly limit: number
  }): {
    session: Summary
    records: CodeRecord[]
    more: boolean
    lastSeq: number
    live?: { turn: string; text: string }
  } {
    const session = this.#session(input.session)
    const { records, more } = session.transcript.page(input.before, input.limit)
    return {
      session: this.#summary(session),
      records,
      more,
      lastSeq: session.transcript.lastSeq,
      ...(session.live === undefined
        ? {}
        : { live: { turn: session.live.turn, text: session.live.text } }),
    }
  }

  async changes(id: string): Promise<Changes> {
    const session = this.#session(id)
    return gitChanges(await this.#options.git(), session.header.root)
  }

  async diff(id: string, relative: string): Promise<FileDiff> {
    const session = this.#session(id)
    return fileDiff(await this.#options.git(), session.header.root, relative)
  }

  // ---- turns -------------------------------------------------------------------

  async #pump(session: Session): Promise<void> {
    if (session.active) return
    session.active = true
    clearTimeout(session.idleTimer)
    let last: 'completed' | 'error' | 'aborted' = 'completed'
    try {
      while (session.queue.length > 0 && !session.stopping && !this.#closing) {
        const next = session.queue.shift()!
        const turn = session.transcript.turn(next.turnId)
        if (turn?.state === 'pending')
          this.#write(session, { ...turn, state: 'read' })
        last = await this.#turn(session, next.text)
      }
    } catch (error) {
      last = 'error'
      this.#log(`turn failed in ${session.header.id}: ${String(error)}`)
    } finally {
      if (session.stopping) last = 'aborted'
      session.active = false
      session.stopping = false
      session.lastActive = this.#now()
      this.#setState(
        session,
        last === 'completed'
          ? 'idle'
          : last === 'aborted'
            ? 'interrupted'
            : 'failed',
      )
      if (session.agent?.alive !== true) this.#release(session)
      else if (this.#waiting.length > 0)
        // Another session waits for room: this process goes now (its exit
        // hands the slot on).
        void session.agent.stop()
      else if (!this.#closing) this.#idleLater(session)
    }
  }

  async #turn(
    session: Session,
    text: string,
  ): Promise<'completed' | 'error' | 'aborted'> {
    let agent: AgentProcess | undefined
    try {
      agent = await this.#acquire(session)
    } catch (error) {
      this.#write(session, {
        id: newTurnId(),
        sessionId: session.header.id,
        author: 'agent',
        at: this.#now(),
        text: (error as Error).message,
        state: 'failed',
        code: error instanceof CodeError ? error.code : 'E_AGENT',
      })
      return 'error'
    }
    // Stopped while it waited for room or for a process to end.
    if (agent === undefined || session.stopping) return 'aborted'
    session.activity = ''
    const outcome = await agent.turn(text)
    this.#finishLive(session)
    if (outcome.status === 'error') {
      this.#write(session, {
        id: newTurnId(),
        sessionId: session.header.id,
        author: 'agent',
        at: this.#now(),
        text: outcome.message ?? 'agent 这一轮失败了',
        state: 'failed',
        code: 'E_AGENT',
      })
    } else if (outcome.status === 'aborted')
      this.#notice(session, '已中断', 'warn')
    return outcome.status
  }

  /** A process slot for the session's agent, and the agent; `undefined` when stopped first. */
  async #acquire(session: Session): Promise<AgentProcess | undefined> {
    while (!this.#slots.has(session)) {
      if (this.#slots.size < this.#limits.maxAgents) {
        this.#slots.add(session)
        break
      }
      const idle = [...this.#slots]
        .filter(one => !one.active)
        .sort((a, b) => a.lastActive - b.lastActive)[0]
      if (idle !== undefined) {
        // Its slot is this session's now; its process ends first.
        this.#slots.delete(idle)
        this.#slots.add(session)
        const old = idle.agent
        idle.agent = undefined
        clearTimeout(idle.idleTimer)
        await old?.stop()
        break
      }
      this.#activity(
        session,
        'queued',
        `同时至多 ${this.#limits.maxAgents} 个 agent 在跑，等一个结束`,
      )
      const go = await new Promise<boolean>(resolve => {
        const entry = { session, go: resolve }
        this.#waiting.push(entry)
        session.cancelWait = ok => {
          const at = this.#waiting.indexOf(entry)
          if (at >= 0) this.#waiting.splice(at, 1)
          resolve(ok)
        }
      })
      session.cancelWait = undefined
      if (!go) return undefined
    }
    if (session.agent?.alive === true) return session.agent
    const found = await this.#options.findAgent(session.header.agent.id)
    if (!found.ok) {
      this.#release(session)
      throw new CodeError('E_AGENT', found.reason)
    }
    session.program = found.path
    session.agent = new ClaudeAgent({
      program: found.path,
      root: session.header.root,
      env: await this.#options.agentEnv(),
      sessionId: session.header.native.id,
      started: session.header.native.started,
      mode: session.header.mode,
      noAuto: this.#noAuto.has(found.path),
      hooks: this.#hooks(session),
      interruptGraceMs: this.#limits.interruptGraceMs,
      termGraceMs: this.#limits.termGraceMs,
    })
    this.#activity(session, 'starting', `正在起 ${session.header.agent.name}`)
    return session.agent
  }

  /** Gives the session's slot to the next one waiting. */
  #release(session: Session): void {
    if (!this.#slots.delete(session)) return
    session.agent = undefined
    const next = this.#waiting.shift()
    if (next === undefined) return
    this.#slots.add(next.session)
    next.go(true)
  }

  #idleLater(session: Session): void {
    clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      if (session.active) return
      void session.agent?.stop()
    }, this.#limits.idleMs)
    session.idleTimer.unref?.()
  }

  #activity(
    session: Session,
    kind: 'thinking' | 'tool' | 'waiting' | 'queued' | 'starting',
    words: string,
  ): void {
    const key = `${kind}\0${words}`
    if (session.activity === key) return
    session.activity = key
    this.#options.emit({
      type: 'activity',
      session: session.header.id,
      kind,
      words,
    })
  }

  // ---- streaming ---------------------------------------------------------------

  #flush(session: Session): void {
    clearTimeout(session.flushTimer)
    session.flushTimer = undefined
    const live = session.live
    if (live === undefined || live.sent >= live.text.length) return
    let offset = live.sent
    for (const text of utf8Chunks(
      live.text.slice(live.sent),
      MAX_DELTA_BYTES,
    )) {
      this.#options.emit({
        type: 'delta',
        session: session.header.id,
        turn: live.turn,
        offset,
        text,
      })
      offset += text.length
    }
    live.sent = live.text.length
  }

  /** What streamed without a message to close it (a stop) is kept as one. */
  #finishLive(session: Session): void {
    const live = session.live
    if (live === undefined) return
    this.#flush(session)
    session.live = undefined
    if (live.text.trim() === '') return
    this.#write(session, {
      id: live.turn,
      sessionId: session.header.id,
      author: 'agent',
      at: this.#now(),
      text: clipMessage(live.text),
      state: 'done',
    })
  }

  // ---- what the agent reports --------------------------------------------------

  #hooks(session: Session): AgentHooks {
    const id = session.header.id
    return {
      message: text => {
        this.#flush(session)
        const turn = session.live?.turn ?? newTurnId()
        session.live = undefined
        session.activity = ''
        this.#write(session, {
          id: turn,
          sessionId: id,
          author: 'agent',
          at: this.#now(),
          text: clipMessage(text),
          state: 'done',
        })
      },
      delta: text => {
        session.live ??= { turn: newTurnId(), text: '', sent: 0 }
        session.live.text += text
        session.flushTimer ??= setTimeout(
          () => this.#flush(session),
          this.#limits.deltaMs,
        )
      },
      activity: (kind, words) => this.#activity(session, kind, words),
      toolStart: tool => this.#toolStart(session, tool),
      toolEnd: (toolId, isError, output) =>
        this.#toolEnd(session, toolId, isError, output),
      ask: (view, signal) => this.#ask(session, view, signal),
      notice: (text, severity) => this.#notice(session, text, severity),
      started: () =>
        this.#header(
          session,
          { native: { ...session.header.native, started: true } },
          false,
        ),
      modeChanged: mode => this.#header(session, { mode }),
      noAuto: () => {
        if (session.program !== undefined) this.#noAuto.add(session.program)
      },
      childStarted: child => this.#options.children.add(id, child),
      childGone: pid => {
        this.#options.children.remove(pid)
        // Gone between turns (idle, crashed): the slot is free.
        if (!session.active) this.#release(session)
      },
    }
  }

  #toolStart(session: Session, tool: ToolView): void {
    this.#finishLive(session)
    const info: ToolInfo = {
      id: tool.id,
      name: tool.name,
      status: 'running',
      ...(tool.paths === undefined ? {} : { paths: tool.paths }),
      ...(tool.command === undefined ? {} : { command: tool.command }),
      detailKind: tool.detailKind,
      ...(tool.diff === undefined
        ? {}
        : { added: tool.diff.added, removed: tool.diff.removed }),
    }
    const turn = this.#notice(session, tool.text, 'info', {
      tool: info,
      ...(tool.diff !== undefined && tool.diff.text !== ''
        ? { detail: clipDetail(tool.diff.text, 'diff') }
        : {}),
    })
    session.tools.set(tool.id, turn.id)
    this.#activity(session, 'tool', tool.text)
  }

  #toolEnd(
    session: Session,
    toolId: string,
    isError: boolean,
    output: string,
  ): void {
    const turnId = session.tools.get(toolId)
    session.tools.delete(toolId)
    const turn =
      turnId === undefined ? undefined : session.transcript.turn(turnId)
    if (turn === undefined || turn.tool === undefined) return
    const denied = session.denied.delete(toolId)
    const approvedBy = session.approved.get(toolId)
    session.approved.delete(toolId)
    const status = denied ? 'denied' : isError ? 'failed' : 'done'
    const detail =
      turn.tool.detailKind === 'output' && output.trim() !== ''
        ? clipDetail(output, 'output')
        : turn.detail
    this.#write(session, {
      ...turn,
      at: turn.at,
      severity:
        status === 'done' ? 'info' : status === 'denied' ? 'warn' : 'error',
      ...(detail === undefined ? {} : { detail }),
      tool: {
        ...turn.tool,
        status,
        ...(approvedBy === undefined ? {} : { approvedBy }),
      },
    })
  }

  #ask(
    session: Session,
    view: AskView,
    signal: AbortSignal,
  ): Promise<AskAnswer> {
    this.#finishLive(session)
    const askId = `ask_${randomBytes(9).toString('base64url')}`
    const info: AskInfo = {
      id: askId,
      tool: view.tool,
      title: view.title,
      ...(view.paths === undefined ? {} : { paths: view.paths }),
      ...(view.input === undefined ? {} : { input: view.input }),
      options: view.options,
    }
    const turn = this.#notice(session, view.title, 'warn', {
      ask: info,
      ...(view.detail === undefined
        ? {}
        : { detail: clipDetail(view.detail, 'diff') }),
    })
    this.#setState(session, 'waiting')
    this.#activity(session, 'waiting', '等你确认')
    return new Promise<AskAnswer>(resolve => {
      const settle = (answer: AskAnswer, by: 'user' | 'stop' | 'shutdown') => {
        if (!session.asks.delete(askId)) return
        signal.removeEventListener('abort', aborted)
        const current = session.transcript.turn(turn.id) ?? turn
        if (current.ask !== undefined)
          this.#write(session, {
            ...current,
            ask: {
              ...current.ask,
              decision: answer.decision,
              by,
              at: this.#now(),
            },
          })
        if (view.toolId !== undefined) {
          if (answer.decision === 'deny') session.denied.add(view.toolId)
          else
            session.approved.set(
              view.toolId,
              answer.decision === 'session' ? 'session' : 'user',
            )
        }
        if (session.asks.size === 0 && session.active)
          this.#setState(session, 'running')
        resolve(answer)
      }
      const aborted = () =>
        settle({ decision: 'deny' }, this.#closing ? 'shutdown' : 'stop')
      session.asks.set(askId, {
        turnId: turn.id,
        options: view.options,
        ...(view.toolId === undefined ? {} : { toolId: view.toolId }),
        settle,
      })
      if (signal.aborted) aborted()
      else signal.addEventListener('abort', aborted, { once: true })
    })
  }

  // ---- the end -------------------------------------------------------------------

  /**
   * Every turn stopped (open questions denied, queues withdrawn), every agent
   * ended; resolves within about `waitMs`.
   */
  async shutdown(waitMs = 2_500): Promise<void> {
    this.#closing = true
    for (const session of this.#sessions.values()) {
      clearTimeout(session.idleTimer)
      if (session.active || session.queue.length > 0)
        this.stop(session.header.id, 'shutdown')
    }
    for (const waiter of this.#waiting.splice(0)) waiter.go(false)
    const stops = [...this.#sessions.values()].map(session =>
      session.agent === undefined ? Promise.resolve() : session.agent.stop(),
    )
    await Promise.race([Promise.allSettled(stops), Bun.sleep(waitMs)])
    // What did not stop in time is not left behind (children.json still
    // names it, should this not reach it).
    this.#options.children.killAll()
    for (const session of this.#sessions.values()) {
      this.#finishLive(session)
      if (session.active) this.#setState(session, 'interrupted')
    }
  }
}
