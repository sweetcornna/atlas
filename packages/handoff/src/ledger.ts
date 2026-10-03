// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isValidSegment } from '@qianmo/protocol'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import {
  acquireExclusiveLock,
  type ExclusiveLock,
  LockHeldError,
} from './lock.js'
import {
  FIELD_MAX_BYTES,
  type HandoffManifest,
  type HandoffResult,
  isTaskId,
  validateManifest,
  validateResult,
} from './manifest.js'

/**
 * The hub's handoff ledger: an append-only NDJSON file, one transition per
 * line, replayed in full at start-up.
 *
 * ## States
 *
 * `accepted → dispatched → running → done | failed → returned`, as in
 * handoff-p17-plan.md §1, plus two failure edges the plan's arrow leaves
 * implicit: `accepted → failed` (no node ever took it, the deadline passed)
 * and `dispatched → failed` (the node refused or never acknowledged). Without
 * them a task that fails before it runs could never leave the node it was
 * assigned to. Nothing else is legal, and nothing leaves `returned`.
 *
 * ## One task per node
 *
 * A task holds its node while `dispatched` or `running`. Dispatching a second
 * task to a held node is refused, on the live path and on replay alike, so
 * the rule survives a restart rather than living in a variable.
 *
 * ## Reading
 *
 * Strict except for the very end. A line that does not end in `\n` is the
 * write a crash interrupted: it is reported ({@link LedgerReplay.tornTail}),
 * not applied, and cut off before the next append — its caller was never told
 * the transition happened. Anything wrong *before* the last newline (bad
 * JSON, an unknown field, an illegal transition, two tasks on one node) is a
 * {@link HandoffLedgerError} with the line number and no ledger at all:
 * skipping a middle line could drop a `dispatched` and free a busy node, or
 * drop a `done` and run a task twice.
 *
 * ## Writing
 *
 * One process writes a ledger (the hub). Each transition is validated against
 * the in-memory state first, then appended and fsynced, and only then
 * applied — the caller's next step may be telling a person "safe to shut
 * down", so the line is on disk before the method returns. The path comes
 * from the caller; this package never derives one.
 *
 * "One process" is enforced, not assumed (ruling 10, 2026-10-03):
 * {@link HandoffLedger.open} takes `<path>.lock` (`O_EXCL`, the pid inside,
 * see `lock.ts`) and {@link HandoffLedger.close} gives it back. A second hub
 * started on the same ledger gets `locked` instead of a second writer whose
 * appends would interleave with the first one's; a lock left by a crashed hub
 * is reclaimed because its pid is gone.
 *
 * ## Messages for a running task
 *
 * Besides transitions, a line can carry one message somebody asked the hub to
 * pass on to the cloud side (`POST /v0/handoff/<task>/send`). It does not move
 * the task, it is numbered per task from 1, and it is only taken while the
 * task can still hear it (`accepted`, `dispatched`, `running`). Delivering it
 * is the node bridge's business (P17.5); the ledger only keeps it.
 */

export const HANDOFF_STATES = [
  'accepted',
  'dispatched',
  'running',
  'done',
  'failed',
  'returned',
] as const
export type HandoffState = (typeof HANDOFF_STATES)[number]

/** Legal next states. The only place the state machine is spelled. */
export const HANDOFF_TRANSITIONS: Readonly<
  Record<HandoffState, readonly HandoffState[]>
> = {
  accepted: ['dispatched', 'failed'],
  dispatched: ['running', 'failed'],
  running: ['done', 'failed'],
  done: ['returned'],
  failed: ['returned'],
  returned: [],
}

/** States in which a task occupies its node. */
const NODE_HOLDING_STATES: ReadonlySet<HandoffState> = new Set([
  'dispatched',
  'running',
])

/** States in which a task still takes a message for the cloud side. */
const SENDABLE_STATES: ReadonlySet<HandoffState> = new Set([
  'accepted',
  'dispatched',
  'running',
])

/** Cap on a failure reason, in UTF-8 bytes. */
export const FAILURE_REASON_MAX_BYTES = 2048

/** Cap on one message for the cloud side: the same as one brief field. */
export const SEND_TEXT_MAX_BYTES = FIELD_MAX_BYTES.brief

const LEDGER_VERSION = 1
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

export interface HandoffTask {
  readonly taskId: string
  readonly state: HandoffState
  readonly manifest: HandoffManifest
  /** Set from `dispatched` on; kept after the node is released. */
  readonly node: string | null
  /** Set by `done`. */
  readonly result: HandoffResult | null
  /** Set by `failed`. */
  readonly reason: string | null
  /** Epoch ms of the `accepted` line. */
  readonly acceptedAt: number
  /** Epoch ms of the latest line. */
  readonly updatedAt: number
}

/** A message for the cloud side, as kept by the ledger. */
export interface HandoffSend {
  readonly taskId: string
  /** Per task, from 1, without gaps. */
  readonly seq: number
  /** Epoch ms of the line. */
  readonly at: number
  readonly text: string
}

type TransitionRecord = {
  readonly v: typeof LEDGER_VERSION
  readonly at: number
  readonly taskId: string
} & (
  | { readonly state: 'accepted'; readonly manifest: HandoffManifest }
  | { readonly state: 'dispatched'; readonly node: string }
  | { readonly state: 'running' }
  | { readonly state: 'done'; readonly result: HandoffResult }
  | { readonly state: 'failed'; readonly reason: string }
  | { readonly state: 'returned' }
)

interface SendRecord {
  readonly v: typeof LEDGER_VERSION
  readonly at: number
  readonly taskId: string
  readonly send: { readonly seq: number; readonly text: string }
}

type LedgerRecord = TransitionRecord | SendRecord

export type HandoffLedgerErrorCode =
  | 'unknown_task'
  | 'duplicate_task'
  | 'illegal_transition'
  | 'node_busy'
  | 'invalid_input'
  | 'corrupt'
  /** Another live process holds the ledger's lock file. */
  | 'locked'

export class HandoffLedgerError extends Error {
  readonly code: HandoffLedgerErrorCode
  /** 1-based line of the ledger file, for `corrupt`. */
  readonly line: number | null

  constructor(
    code: HandoffLedgerErrorCode,
    message: string,
    line: number | null = null,
  ) {
    super(line === null ? message : `ledger line ${line}: ${message}`)
    this.name = 'HandoffLedgerError'
    this.code = code
    this.line = line
  }
}

/** An interrupted last write: reported, not applied. */
export interface TornTail {
  /** 1-based line number the fragment would have been. */
  readonly line: number
  readonly bytes: number
}

export interface LedgerReplay {
  /** Every task, in acceptance order. */
  readonly tasks: ReadonlyMap<string, HandoffTask>
  /** Messages for the cloud side, per task, in order. */
  readonly sends: ReadonlyMap<string, readonly HandoffSend[]>
  readonly tornTail: TornTail | null
  /** Length of the prefix that holds complete lines. */
  readonly validBytes: number
}

// ─── Record shape ────────────────────────────────────────────────────

const BASE_KEYS = ['v', 'at', 'taskId', 'state'] as const
const STATE_KEYS: Readonly<Record<HandoffState, readonly string[]>> = {
  accepted: ['manifest'],
  dispatched: ['node'],
  running: [],
  done: ['result'],
  failed: ['reason'],
  returned: [],
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkReason(reason: unknown): string | null {
  if (typeof reason !== 'string' || reason.trim() === '') {
    return 'failure reason must be a non-empty string'
  }
  if (reason.includes('\0')) return 'failure reason contains NUL'
  if (Buffer.byteLength(reason, 'utf8') > FAILURE_REASON_MAX_BYTES) {
    return `failure reason longer than ${FAILURE_REASON_MAX_BYTES} bytes`
  }
  return null
}

/** Parse one line into a record, or say why not. */
function parseRecord(line: string): LedgerRecord | string {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return 'not JSON'
  }
  if (!isPlainObject(value)) return 'not an object'
  if (Object.hasOwn(value, 'send')) return parseSendRecord(value)
  const state = value.state
  if (!(HANDOFF_STATES as readonly unknown[]).includes(state)) {
    return 'unknown state'
  }
  const expected = [...BASE_KEYS, ...STATE_KEYS[state as HandoffState]]
  const keys = Object.keys(value)
  if (
    keys.length !== expected.length ||
    !expected.every(key => keys.includes(key))
  ) {
    return 'unexpected field set'
  }
  if (value.v !== LEDGER_VERSION) return 'unsupported version'
  if (
    typeof value.at !== 'number' ||
    !Number.isSafeInteger(value.at) ||
    value.at < 0
  ) {
    return 'bad timestamp'
  }
  const taskId = value.taskId
  if (!isTaskId(taskId)) return 'bad task id'
  // Rebuilt rather than cast, so a record is exactly its declared shape.
  const base = { v: LEDGER_VERSION, at: value.at, taskId } as const
  switch (state as HandoffState) {
    case 'accepted': {
      const manifest = validateManifest(value.manifest)
      if (!manifest.ok) return `bad manifest (${manifest.errors.join('; ')})`
      return { ...base, state: 'accepted', manifest: manifest.value }
    }
    case 'dispatched':
      return isValidSegment(value.node)
        ? { ...base, state: 'dispatched', node: value.node }
        : 'bad node name'
    case 'running':
      return { ...base, state: 'running' }
    case 'done': {
      const result = validateResult(value.result)
      if (!result.ok) return `bad result (${result.errors.join('; ')})`
      return { ...base, state: 'done', result: result.value }
    }
    case 'failed': {
      const reason = value.reason
      const problem = checkReason(reason)
      return problem === null && typeof reason === 'string'
        ? { ...base, state: 'failed', reason }
        : (problem ?? 'bad failure reason')
    }
    case 'returned':
      return { ...base, state: 'returned' }
  }
}

function checkSendText(text: unknown): string | null {
  if (typeof text !== 'string' || text.trim() === '') {
    return 'message must be a non-empty string'
  }
  if (text.includes('\0')) return 'message contains NUL'
  if (Buffer.byteLength(text, 'utf8') > SEND_TEXT_MAX_BYTES) {
    return `message longer than ${SEND_TEXT_MAX_BYTES} bytes`
  }
  return null
}

function parseSendRecord(value: Record<string, unknown>): SendRecord | string {
  const keys = Object.keys(value)
  if (
    keys.length !== 4 ||
    !['v', 'at', 'taskId', 'send'].every(key => keys.includes(key))
  ) {
    return 'unexpected field set'
  }
  if (value.v !== LEDGER_VERSION) return 'unsupported version'
  if (
    typeof value.at !== 'number' ||
    !Number.isSafeInteger(value.at) ||
    value.at < 0
  ) {
    return 'bad timestamp'
  }
  const taskId = value.taskId
  if (!isTaskId(taskId)) return 'bad task id'
  const send = value.send
  if (!isPlainObject(send)) return 'bad message'
  const sendKeys = Object.keys(send)
  if (
    sendKeys.length !== 2 ||
    !sendKeys.includes('seq') ||
    !sendKeys.includes('text')
  ) {
    return 'bad message'
  }
  if (
    typeof send.seq !== 'number' ||
    !Number.isSafeInteger(send.seq) ||
    send.seq < 1
  ) {
    return 'bad message number'
  }
  const problem = checkSendText(send.text)
  if (problem !== null || typeof send.text !== 'string') {
    return problem ?? 'bad message'
  }
  return {
    v: LEDGER_VERSION,
    at: value.at,
    taskId,
    send: { seq: send.seq, text: send.text },
  }
}

/**
 * The message after `record`, given the tasks and the messages so far. Pure;
 * throws {@link HandoffLedgerError} for an unknown task, a task that can no
 * longer hear it, or a number out of sequence.
 */
function admitSend(
  tasks: ReadonlyMap<string, HandoffTask>,
  sends: ReadonlyMap<string, readonly HandoffSend[]>,
  record: SendRecord,
): HandoffSend {
  const task = tasks.get(record.taskId)
  if (task === undefined) {
    throw new HandoffLedgerError(
      'unknown_task',
      `task ${record.taskId} was never accepted`,
    )
  }
  if (!SENDABLE_STATES.has(task.state)) {
    throw new HandoffLedgerError(
      'illegal_transition',
      `task ${record.taskId} is ${task.state} and takes no more messages`,
    )
  }
  const expected = (sends.get(record.taskId)?.length ?? 0) + 1
  if (record.send.seq !== expected) {
    throw new HandoffLedgerError(
      'illegal_transition',
      `task ${record.taskId}: message ${record.send.seq} where ${expected} was next`,
    )
  }
  return {
    taskId: record.taskId,
    seq: record.send.seq,
    at: record.at,
    text: record.send.text,
  }
}

// ─── State machine ───────────────────────────────────────────────────

/**
 * The task after `record`, given every task so far. Pure; throws
 * {@link HandoffLedgerError} for an unknown task, a duplicate acceptance, an
 * illegal transition or a busy node.
 */
function advance(
  tasks: ReadonlyMap<string, HandoffTask>,
  record: TransitionRecord,
): HandoffTask {
  const current = tasks.get(record.taskId)
  if (record.state === 'accepted') {
    if (current !== undefined) {
      throw new HandoffLedgerError(
        'duplicate_task',
        `task ${record.taskId} was already accepted`,
      )
    }
    return {
      taskId: record.taskId,
      state: 'accepted',
      manifest: record.manifest,
      node: null,
      result: null,
      reason: null,
      acceptedAt: record.at,
      updatedAt: record.at,
    }
  }
  if (current === undefined) {
    throw new HandoffLedgerError(
      'unknown_task',
      `task ${record.taskId} was never accepted`,
    )
  }
  if (!HANDOFF_TRANSITIONS[current.state].includes(record.state)) {
    throw new HandoffLedgerError(
      'illegal_transition',
      `task ${record.taskId}: ${current.state} → ${record.state} is not allowed`,
    )
  }
  const next = { ...current, state: record.state, updatedAt: record.at }
  switch (record.state) {
    case 'dispatched': {
      for (const other of tasks.values()) {
        if (
          other.taskId !== current.taskId &&
          other.node === record.node &&
          NODE_HOLDING_STATES.has(other.state)
        ) {
          throw new HandoffLedgerError(
            'node_busy',
            `node ${record.node} is running task ${other.taskId}`,
          )
        }
      }
      return { ...next, node: record.node }
    }
    case 'done':
      return { ...next, result: record.result }
    case 'failed':
      return { ...next, reason: record.reason }
    default:
      return next
  }
}

/**
 * Rebuild every task from a ledger file's bytes. Throws
 * {@link HandoffLedgerError} (`corrupt`, with the line) for anything wrong
 * before the last newline; an unterminated last line is reported instead.
 */
export function replayLedger(content: Buffer | string): LedgerReplay {
  const bytes =
    typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  const validBytes = bytes.lastIndexOf(0x0a) + 1
  const lines =
    validBytes === 0
      ? []
      : bytes.toString('utf8', 0, validBytes - 1).split('\n')
  const tasks = new Map<string, HandoffTask>()
  const sends = new Map<string, HandoffSend[]>()
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue
    const record = parseRecord(line)
    if (typeof record === 'string') {
      throw new HandoffLedgerError('corrupt', record, index + 1)
    }
    try {
      if ('send' in record) {
        const send = admitSend(tasks, sends, record)
        sends.set(record.taskId, [...(sends.get(record.taskId) ?? []), send])
      } else {
        tasks.set(record.taskId, advance(tasks, record))
      }
    } catch (error) {
      if (!(error instanceof HandoffLedgerError)) throw error
      throw new HandoffLedgerError('corrupt', error.message, index + 1)
    }
  }
  const tornTail =
    validBytes < bytes.length
      ? { line: lines.length + 1, bytes: bytes.length - validBytes }
      : null
  return { tasks, sends, tornTail, validBytes }
}

// ─── File-backed ledger ──────────────────────────────────────────────

export interface HandoffLedgerOptions {
  readonly now?: () => number
}

export class HandoffLedger {
  readonly path: string
  /** What {@link HandoffLedger.open} found at the end of the file. */
  readonly tornTail: TornTail | null
  readonly #now: () => number
  readonly #tasks: Map<string, HandoffTask>
  readonly #sends: Map<string, readonly HandoffSend[]>
  readonly #lock: ExclusiveLock
  /** Bytes to keep before the first append; `null` once handled. */
  #truncateTo: number | null
  #fd: number | null = null

  private constructor(
    path: string,
    replay: LedgerReplay,
    options: HandoffLedgerOptions,
    lock: ExclusiveLock,
  ) {
    this.path = path
    this.tornTail = replay.tornTail
    this.#now = options.now ?? Date.now
    this.#tasks = new Map(replay.tasks)
    this.#sends = new Map(replay.sends)
    this.#lock = lock
    this.#truncateTo = replay.tornTail === null ? null : replay.validBytes
  }

  /**
   * Take the ledger's lock (`<path>.lock`) and replay the ledger at `path` (a
   * missing file is an empty ledger). Throws {@link HandoffLedgerError}
   * `locked` while another live process holds it, and `corrupt` rather than
   * open a damaged one — releasing the lock again in that case. Call
   * {@link close} to give the lock back.
   */
  static open(path: string, options: HandoffLedgerOptions = {}): HandoffLedger {
    if (path.trim() === '') {
      throw new HandoffLedgerError('invalid_input', 'ledger path is empty')
    }
    let lock: ExclusiveLock
    try {
      lock = acquireExclusiveLock(`${path}.lock`)
    } catch (error) {
      if (error instanceof LockHeldError) {
        throw new HandoffLedgerError(
          'locked',
          `ledger ${path} is in use: ${error.message}`,
        )
      }
      throw error
    }
    try {
      let content: Buffer
      try {
        content = readFileSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        content = Buffer.alloc(0)
      }
      return new HandoffLedger(path, replayLedger(content), options, lock)
    } catch (error) {
      lock.release()
      throw error
    }
  }

  get(taskId: string): HandoffTask | undefined {
    return this.#tasks.get(taskId)
  }

  /** Every task, in acceptance order. */
  list(): readonly HandoffTask[] {
    return [...this.#tasks.values()]
  }

  /** Messages for the cloud side kept for `taskId`, in order. */
  sends(taskId: string): readonly HandoffSend[] {
    return this.#sends.get(taskId) ?? []
  }

  /** The task currently holding `node`, if any. */
  activeOn(node: string): HandoffTask | undefined {
    for (const task of this.#tasks.values()) {
      if (task.node === node && NODE_HOLDING_STATES.has(task.state)) {
        return task
      }
    }
    return undefined
  }

  /** Record a new task. The manifest is validated again here. */
  accept(taskId: string, manifest: HandoffManifest): HandoffTask {
    if (!isTaskId(taskId)) {
      throw new HandoffLedgerError('invalid_input', `bad task id: ${taskId}`)
    }
    const checked = validateManifest(manifest)
    if (!checked.ok) {
      throw new HandoffLedgerError(
        'invalid_input',
        `bad manifest: ${checked.errors.join('; ')}`,
      )
    }
    return this.#record({
      v: LEDGER_VERSION,
      at: this.#now(),
      taskId,
      state: 'accepted',
      manifest: checked.value,
    })
  }

  dispatch(taskId: string, node: string): HandoffTask {
    if (!isValidSegment(node)) {
      throw new HandoffLedgerError('invalid_input', `bad node name: ${node}`)
    }
    return this.#record({
      v: LEDGER_VERSION,
      at: this.#now(),
      taskId,
      state: 'dispatched',
      node,
    })
  }

  start(taskId: string): HandoffTask {
    return this.#record({
      v: LEDGER_VERSION,
      at: this.#now(),
      taskId,
      state: 'running',
    })
  }

  complete(taskId: string, result: HandoffResult): HandoffTask {
    const checked = validateResult(result)
    if (!checked.ok) {
      throw new HandoffLedgerError(
        'invalid_input',
        `bad result: ${checked.errors.join('; ')}`,
      )
    }
    return this.#record({
      v: LEDGER_VERSION,
      at: this.#now(),
      taskId,
      state: 'done',
      result: checked.value,
    })
  }

  fail(taskId: string, reason: string): HandoffTask {
    const problem = checkReason(reason)
    if (problem !== null) throw new HandoffLedgerError('invalid_input', problem)
    return this.#record({
      v: LEDGER_VERSION,
      at: this.#now(),
      taskId,
      state: 'failed',
      reason,
    })
  }

  markReturned(taskId: string): HandoffTask {
    return this.#record({
      v: LEDGER_VERSION,
      at: this.#now(),
      taskId,
      state: 'returned',
    })
  }

  /**
   * Keep one message for the cloud side. Only while the task can still hear
   * it (`accepted`, `dispatched`, `running`); the state does not change.
   */
  queueSend(taskId: string, text: string): HandoffSend {
    const problem = checkSendText(text)
    if (problem !== null) throw new HandoffLedgerError('invalid_input', problem)
    const record: SendRecord = {
      v: LEDGER_VERSION,
      at: this.#now(),
      taskId,
      send: { seq: this.sends(taskId).length + 1, text },
    }
    const send = admitSend(this.#tasks, this.#sends, record)
    this.#append(record)
    this.#sends.set(taskId, [...this.sends(taskId), send])
    return send
  }

  /** Close the file and give the lock back. Idempotent. */
  close(): void {
    if (this.#fd !== null) {
      closeSync(this.#fd)
      this.#fd = null
    }
    this.#lock.release()
  }

  /** Validate, append + fsync, then apply. */
  #record(record: TransitionRecord): HandoffTask {
    const next = advance(this.#tasks, record)
    this.#append(record)
    this.#tasks.set(record.taskId, next)
    return next
  }

  /** Append one line and fsync it; a failed write is taken back. */
  #append(record: LedgerRecord): void {
    const fd = this.#handle()
    const size = fstatSync(fd).size
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`)
      fsyncSync(fd)
    } catch (error) {
      // A short write (disk full) would leave a fragment the next append
      // glues onto; take it back so the file stays readable. Best effort —
      // if this fails too, the next open reports the torn tail.
      try {
        ftruncateSync(fd, size)
      } catch {}
      throw error
    }
  }

  #handle(): number {
    if (this.#fd !== null) return this.#fd
    mkdirSync(dirname(this.path), { recursive: true, mode: DIRECTORY_MODE })
    if (this.#truncateTo !== null) {
      // The torn fragment goes before anything is appended after it, or the
      // next line would be glued to it and the whole file would stop reading.
      truncateSync(this.path, this.#truncateTo)
      this.#truncateTo = null
    }
    this.#fd = openSync(
      this.path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        (constants.O_NOFOLLOW ?? 0),
      FILE_MODE,
    )
    chmodSync(this.path, FILE_MODE)
    return this.#fd
  }
}
