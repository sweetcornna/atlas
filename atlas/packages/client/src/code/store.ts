// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where local sessions live (qmo-local.md §4.3.6): `<client dir>/code/`, a
 * 0700 folder of 0600 files, JSON files written whole and renamed into
 * place, conversations appended one line at a time.
 *
 * | Path | What |
 * | --- | --- |
 * | `folders.json` | the folders picked, newest first, at most 20 |
 * | `sessions/<id>/session.json` | a session's header |
 * | `sessions/<id>/events.ndjson` | its conversation, append-only |
 * | `runner.lock`, `children.json` | the runner's own (serve.ts) |
 *
 * `events.ndjson` has the hub console's chat-store envelope
 * (`consoleChatStore.ts`) with a `seq`: a `session` line, then `turn` lines.
 * A turn that changes is written again in full; a reader keeps the last
 * write of each id at the place of its first, as the chat store does.
 */

import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ClientError } from '../hub.js'
import {
  ensurePrivateDir,
  readPrivateFile,
  writePrivateFile,
} from '../secret.js'
import { isMode, type Mode } from './modes.js'
import {
  type CodeRecord,
  type CodeTurn,
  CodeError,
  FOLDER_ID,
  SESSION_ID,
  type SessionState,
} from './protocol.js'

/** At most this many folders are remembered; the oldest pick goes first. */
export const MAX_FOLDERS = 20
/** An agent's message is cut here (§4.3.6). */
export const MAX_MESSAGE_BYTES = 256 * 1024
/** A process line's detail is cut here: an output keeps its tail, a diff its head. */
export const MAX_DETAIL_BYTES = 16 * 1024
/** A conversation this large takes no more lines; a new session is the way on. */
export const MAX_LOG_BYTES = 64 * 1024 * 1024

export interface StoredFolder {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly pickedAt: number
}

/** `session.json` (§4.3.6). */
export interface SessionHeader {
  readonly id: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly folder: { readonly path: string; readonly name: string }
  /** The agent's working folder. */
  readonly root: string
  readonly agent: {
    readonly id: string
    readonly name: string
    readonly protocol: string
    readonly version: string | null
  }
  readonly mode: Mode
  readonly state: SessionState
  readonly lastSeq: number
  /** The agent's own conversation: Claude Code's session id. */
  readonly native: {
    readonly kind: string
    readonly id: string
    readonly started: boolean
  }
  /**
   * Remote (§5): on or off, how far the hub has acknowledged, and the device
   * id it was turned on under (a later pairing does not inherit it).
   */
  readonly remote: {
    readonly on: boolean
    readonly pushedSeq: number
    readonly device?: string
  }
}

/** The `session` line, the chat store's `StoredChatSession`. */
export interface SessionEnvelope {
  readonly id: string
  readonly target: string
  readonly node: string
  readonly agent: string
  readonly createdAt: number
}

const STATES: readonly SessionState[] = [
  'idle',
  'running',
  'waiting',
  'interrupted',
  'failed',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A random id: 16 hex digits for a folder, `cs_` and 22 base64url for a session. */
export function newFolderId(): string {
  return randomBytes(8).toString('hex')
}
export function newSessionId(): string {
  return `cs_${randomBytes(16).toString('base64url')}`
}
export function newTurnId(): string {
  return `t_${randomBytes(12).toString('base64url')}`
}

/** Whether `byte` continues a UTF-8 character (10xxxxxx). */
const continues = (byte: number | undefined) =>
  byte !== undefined && (byte & 0xc0) === 0x80

/** `text` cut to `max` UTF-8 bytes from its start, not inside a character. */
function headBytes(text: string, max: number): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= max) return text
  let end = max
  while (end > 0 && continues(bytes[end])) end--
  return bytes.subarray(0, end).toString('utf8')
}

/** `text` cut to `max` UTF-8 bytes from its end, not inside a character. */
function tailBytes(text: string, max: number): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= max) return text
  let start = bytes.length - max
  while (start < bytes.length && continues(bytes[start])) start++
  return bytes.subarray(start).toString('utf8')
}

const MESSAGE_CUT = '\n\n（超过 256 KiB，后面的截掉了）'
const DIFF_CUT = '\n…（差异太长，后面的截掉了）'
const OUTPUT_CUT = '…（前面的截掉了）\n'

/** An agent's message within {@link MAX_MESSAGE_BYTES}, saying so when cut. */
export function clipMessage(text: string): string {
  if (Buffer.byteLength(text) <= MAX_MESSAGE_BYTES) return text
  return `${headBytes(text, MAX_MESSAGE_BYTES - Buffer.byteLength(MESSAGE_CUT))}${MESSAGE_CUT}`
}

/** A detail within {@link MAX_DETAIL_BYTES}: an output's tail, a diff's head. */
export function clipDetail(text: string, kind: 'output' | 'diff'): string {
  if (Buffer.byteLength(text) <= MAX_DETAIL_BYTES) return text
  return kind === 'diff'
    ? `${headBytes(text, MAX_DETAIL_BYTES - Buffer.byteLength(DIFF_CUT))}${DIFF_CUT}`
    : `${OUTPUT_CUT}${tailBytes(text, MAX_DETAIL_BYTES - Buffer.byteLength(OUTPUT_CUT))}`
}

/** Appends one line to a private file, refusing a link or someone else's file. */
function appendPrivateLine(file: string, line: string): void {
  ensurePrivateDir(path.dirname(file))
  const nofollow = fs.constants.O_NOFOLLOW ?? 0
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY |
      fs.constants.O_APPEND |
      fs.constants.O_CREAT |
      nofollow,
    0o600,
  )
  try {
    if (process.platform !== 'win32') {
      const stat = fs.fstatSync(fd)
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0
      )
        throw new ClientError(`${file} 不是本人独占的普通文件`)
    }
    fs.writeSync(fd, line)
  } finally {
    fs.closeSync(fd)
  }
}

function headerOf(value: unknown): SessionHeader | undefined {
  if (!isRecord(value)) return undefined
  const { folder, agent, native, remote } = value
  if (
    typeof value.id !== 'string' ||
    !SESSION_ID.test(value.id) ||
    typeof value.title !== 'string' ||
    typeof value.createdAt !== 'number' ||
    typeof value.updatedAt !== 'number' ||
    !isRecord(folder) ||
    typeof folder.path !== 'string' ||
    typeof folder.name !== 'string' ||
    typeof value.root !== 'string' ||
    !isRecord(agent) ||
    typeof agent.id !== 'string' ||
    typeof agent.name !== 'string' ||
    typeof agent.protocol !== 'string' ||
    !(agent.version === null || typeof agent.version === 'string') ||
    !isMode(value.mode) ||
    !STATES.some(state => state === value.state) ||
    typeof value.lastSeq !== 'number' ||
    !isRecord(native) ||
    typeof native.kind !== 'string' ||
    typeof native.id !== 'string' ||
    typeof native.started !== 'boolean'
  )
    return undefined
  return {
    id: value.id,
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    folder: { path: folder.path, name: folder.name },
    root: value.root,
    agent: {
      id: agent.id,
      name: agent.name,
      protocol: agent.protocol,
      version: agent.version,
    },
    mode: value.mode,
    state: value.state as SessionState,
    lastSeq: value.lastSeq,
    native: { kind: native.kind, id: native.id, started: native.started },
    remote: {
      on: isRecord(remote) && remote.on === true,
      pushedSeq:
        isRecord(remote) &&
        typeof remote.pushedSeq === 'number' &&
        Number.isSafeInteger(remote.pushedSeq) &&
        remote.pushedSeq >= 0
          ? remote.pushedSeq
          : 0,
      ...(isRecord(remote) &&
      typeof remote.device === 'string' &&
      /^d-[a-z2-7]{12}$/.test(remote.device)
        ? { device: remote.device }
        : {}),
    },
  }
}

/** One parsed line of `events.ndjson`. */
type EventLine =
  | { readonly kind: 'session'; readonly seq: number }
  | { readonly kind: 'turn'; readonly seq: number; readonly turn: CodeTurn }

function turnOf(value: unknown): CodeTurn | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.sessionId !== 'string' ||
    (value.author !== 'operator' && value.author !== 'agent') ||
    typeof value.at !== 'number' ||
    typeof value.text !== 'string' ||
    typeof value.state !== 'string'
  )
    return undefined
  return value as unknown as CodeTurn
}

function lineOf(text: string): EventLine | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined // A line cut by a power loss costs that line.
  }
  if (!isRecord(value) || typeof value.seq !== 'number') return undefined
  if (value.kind === 'session') return { kind: 'session', seq: value.seq }
  if (value.kind !== 'turn') return undefined
  const turn = turnOf(value.turn)
  return turn === undefined ? undefined : { kind: 'turn', seq: value.seq, turn }
}

export class CodeStore {
  readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  get foldersFile(): string {
    return path.join(this.dir, 'folders.json')
  }
  get lockFile(): string {
    return path.join(this.dir, 'runner.lock')
  }
  get childrenFile(): string {
    return path.join(this.dir, 'children.json')
  }
  get sessionsDir(): string {
    return path.join(this.dir, 'sessions')
  }
  sessionDir(id: string): string {
    if (!SESSION_ID.test(id)) throw new CodeError('E_SESSION', '会话 id 不对')
    return path.join(this.sessionsDir, id)
  }
  eventsFile(id: string): string {
    return path.join(this.sessionDir(id), 'events.ndjson')
  }

  /** Makes the folder, 0700; one that is not this user's alone is refused. */
  ensure(): void {
    ensurePrivateDir(this.dir)
    ensurePrivateDir(this.sessionsDir)
  }

  readFolders(): StoredFolder[] {
    let value: unknown
    try {
      value = JSON.parse(readPrivateFile(this.foldersFile) ?? 'null')
    } catch {
      return []
    }
    if (!isRecord(value) || !Array.isArray(value.folders)) return []
    return value.folders
      .filter(
        (one): one is StoredFolder =>
          isRecord(one) &&
          typeof one.id === 'string' &&
          FOLDER_ID.test(one.id) &&
          typeof one.path === 'string' &&
          path.isAbsolute(one.path) &&
          typeof one.name === 'string' &&
          typeof one.pickedAt === 'number',
      )
      .slice(0, MAX_FOLDERS)
  }

  writeFolders(folders: readonly StoredFolder[]): void {
    writePrivateFile(
      this.foldersFile,
      `${JSON.stringify({ v: 1, folders: folders.slice(0, MAX_FOLDERS) })}\n`,
    )
  }

  /** The sessions on disk, by id. */
  sessionIds(): string[] {
    try {
      return fs
        .readdirSync(this.sessionsDir)
        .filter(name => SESSION_ID.test(name))
    } catch {
      return []
    }
  }

  /** A session's header; `undefined` when it is missing or damaged. */
  readHeader(id: string): SessionHeader | undefined {
    try {
      const raw = readPrivateFile(
        path.join(this.sessionDir(id), 'session.json'),
      )
      return raw === undefined ? undefined : headerOf(JSON.parse(raw))
    } catch {
      return undefined
    }
  }

  writeHeader(header: SessionHeader): void {
    const dir = this.sessionDir(header.id)
    ensurePrivateDir(dir)
    writePrivateFile(
      path.join(dir, 'session.json'),
      `${JSON.stringify(header)}\n`,
    )
  }

  /**
   * Appends one line; returns its size in bytes. `afterCut`: the file ends
   * in a line a power loss cut short, which this one must not continue.
   */
  append(
    id: string,
    line: Readonly<Record<string, unknown>>,
    afterCut = false,
  ): number {
    const text = `${afterCut ? '\n' : ''}${JSON.stringify(line)}\n`
    appendPrivateLine(this.eventsFile(id), text)
    return Buffer.byteLength(text)
  }

  /** Every readable line, the file's size, and whether its last line is cut short. */
  readEvents(id: string): { lines: EventLine[]; bytes: number; cut: boolean } {
    const raw = readPrivateFile(this.eventsFile(id)) ?? ''
    const lines: EventLine[] = []
    for (const text of raw.split('\n')) {
      if (text.trim() === '') continue
      const line = lineOf(text)
      if (line !== undefined) lines.push(line)
    }
    return {
      lines,
      bytes: Buffer.byteLength(raw),
      cut: raw !== '' && !raw.endsWith('\n'),
    }
  }
}

interface Entry {
  /** The seq of the turn's first line: its place. */
  readonly first: number
  readonly seq: number
  readonly turn: CodeTurn
}

/**
 * One conversation in memory: each turn's last write at the place of its
 * first, and the seq to write next. Every write goes to the file first.
 */
export class Transcript {
  readonly #store: CodeStore
  readonly #id: string
  readonly #entries = new Map<string, Entry>()
  #lastSeq: number
  #bytes: number
  /** The file ends in a cut line: the next write starts a line of its own. */
  #cut = false

  private constructor(
    store: CodeStore,
    id: string,
    lastSeq: number,
    bytes: number,
  ) {
    this.#store = store
    this.#id = id
    this.#lastSeq = lastSeq
    this.#bytes = bytes
  }

  /** A new conversation: its `session` line is seq 0. */
  static create(store: CodeStore, envelope: SessionEnvelope): Transcript {
    const bytes = store.append(envelope.id, {
      kind: 'session',
      seq: 0,
      session: envelope,
    })
    return new Transcript(store, envelope.id, 0, bytes)
  }

  /** The conversation on disk. */
  static load(store: CodeStore, id: string): Transcript {
    const { lines, bytes, cut } = store.readEvents(id)
    const transcript = new Transcript(store, id, 0, bytes)
    transcript.#cut = cut
    for (const line of lines) {
      if (line.seq > transcript.#lastSeq) transcript.#lastSeq = line.seq
      if (line.kind === 'turn') transcript.#remember(line.seq, line.turn)
    }
    return transcript
  }

  get lastSeq(): number {
    return this.#lastSeq
  }
  get bytes(): number {
    return this.#bytes
  }
  /** Full: no more lines from a person (§4.3.6). */
  get full(): boolean {
    return this.#bytes >= MAX_LOG_BYTES
  }

  #remember(seq: number, turn: CodeTurn): void {
    const known = this.#entries.get(turn.id)
    this.#entries.set(turn.id, { first: known?.first ?? seq, seq, turn })
  }

  turn(id: string): CodeTurn | undefined {
    return this.#entries.get(id)?.turn
  }

  turns(): CodeTurn[] {
    return [...this.#entries.values()].map(entry => entry.turn)
  }

  /** Writes a turn (new or again in full) as the next line. */
  write(turn: CodeTurn): CodeRecord {
    const seq = this.#lastSeq + 1
    this.#bytes += this.#store.append(
      this.#id,
      { kind: 'turn', seq, turn },
      this.#cut,
    )
    this.#cut = false
    this.#lastSeq = seq
    this.#remember(seq, turn)
    return { seq, kind: 'turn', turn }
  }

  /**
   * Up to `limit` turns, oldest first, from those whose first line is before
   * `before` (all when absent); `more` when older ones are left.
   */
  page(
    before: number | undefined,
    limit: number,
  ): { records: CodeRecord[]; more: boolean } {
    const all = [...this.#entries.values()].filter(
      entry => before === undefined || entry.first < before,
    )
    const shown = all.slice(Math.max(0, all.length - limit))
    return {
      records: shown.map(entry => ({
        seq: entry.seq,
        kind: 'turn',
        turn: entry.turn,
      })),
      more: all.length > shown.length,
    }
  }
}
