// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Remote copies of local Code sessions (P37.15, `docs/dev/qmo-local.md`
 * §5): what a device's runner pushes over its link, what the hub keeps of
 * it, and the port the hub keeps it through.
 *
 * Everything that arrives over a link is checked field by field here and
 * rebuilt from what was checked; the hub stores the rebuilt value, never the
 * text it received. A copy belongs to one account and one device: the store
 * keys it by {@link codeOwnerKey} of the account's subject, the device id and
 * the session id, all three checked before they become a path.
 */

import { createHash } from 'node:crypto'

/** The subprotocol a link must ask for (§5.1). */
export const CODE_LINK_PROTOCOL = 'qmo-link.1'

/** The path a device's runner dials. */
export const CODE_LINK_PATH = '/v0/client/link'

/** A frame larger than this closes the link (§5.1). */
export const CODE_LINK_MAX_FRAME = 1024 * 1024

/** One copy holds at most this many bytes of records (§5.3). */
export const CODE_COPY_MAX_BYTES = 16 * 1024 * 1024

/** One account holds at most this many copies, and this many bytes in all. */
export const CODE_ACCOUNT_MAX_COPIES = 100
export const CODE_ACCOUNT_MAX_BYTES = 256 * 1024 * 1024

/** Records a read answers at most (the runner's `session.read`). */
export const CODE_READ_MAX = 200

export const CODE_SESSION_ID = /^cs_[A-Za-z0-9_-]{22}$/
export const CODE_DEVICE_ID = /^d-[a-z2-7]{12}$/
const TURN_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const ASK_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/
const CODE = /^[A-Za-z0-9_]{1,64}$/
const AGENT_ID = /^[a-z0-9-]{1,32}$/
const CONTROL = /\p{Cc}/u

const MODES = ['off', 'accept-edits', 'auto', 'full-access'] as const
const STATES = ['idle', 'running', 'waiting', 'interrupted', 'failed'] as const
const TURN_STATES = ['pending', 'read', 'done', 'failed'] as const
const SEVERITIES = ['info', 'warn', 'error'] as const
const TOOL_STATUSES = ['running', 'done', 'failed', 'denied'] as const
const DECISIONS = ['once', 'session', 'deny'] as const

/** An agent's message is at most 256 KiB on the device; a little room for the cut note. */
const MAX_TEXT_BYTES = 260 * 1024
/** A detail is at most 16 KiB on the device (the runner sends 4 KiB). */
const MAX_DETAIL_BYTES = 16 * 1024 + 256
const MAX_INPUT_BYTES = 2 * 1024 + 256
const MAX_PATHS = 50
const MAX_PATH = 4_096

export type CodeMode = (typeof MODES)[number]
export type CodeState = (typeof STATES)[number]
export type CodeDecision = (typeof DECISIONS)[number]

/** A session's head as the hub keeps it: no path, no native id. */
export interface CodeCopyHeader {
  readonly id: string
  readonly title: string
  /** The project folder's name only. */
  readonly folder: string
  readonly agent: { readonly id: string; readonly name: string }
  readonly mode: CodeMode
  readonly state: CodeState
  /** Whether Remote is on for it; off, the copy is read-only. */
  readonly remote: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastSeq: number
}

export interface CodeTool {
  readonly id: string
  readonly name: string
  readonly status: (typeof TOOL_STATUSES)[number]
  readonly paths?: readonly string[]
  readonly command?: string
  readonly detailKind: 'output' | 'diff'
  readonly added?: number
  readonly removed?: number
  readonly approvedBy?: 'mode' | 'user' | 'session'
}

export interface CodeAsk {
  readonly id: string
  readonly tool: string
  readonly title: string
  readonly paths?: readonly string[]
  readonly input?: string
  readonly options: readonly CodeDecision[]
  readonly decision?: CodeDecision
  readonly by?: 'user' | 'stop' | 'shutdown'
  readonly at?: number
}

/** One line of a conversation (`qmo-local.md` §4.3.6), as checked. */
export interface CodeCopyTurn {
  readonly id: string
  readonly sessionId: string
  readonly author: 'operator' | 'agent'
  readonly at: number
  readonly text: string
  readonly state: (typeof TURN_STATES)[number]
  readonly code?: string
  readonly variant?: 'notice'
  readonly noticeSource?: 'step'
  readonly severity?: (typeof SEVERITIES)[number]
  readonly detail?: string
  readonly tool?: CodeTool
  readonly ask?: CodeAsk
  readonly clientId?: string
  readonly origin?: 'remote'
}

export interface CodeCopyRecord {
  readonly seq: number
  readonly kind: 'turn'
  readonly turn: CodeCopyTurn
}

/** What the store knows of one copy without reading its records. */
export interface CodeCopy {
  readonly device: string
  readonly header: CodeCopyHeader
  /** The highest seq stored; 0 before the first record. */
  readonly stored: number
  /** The records' size on disk. */
  readonly bytes: number
  /** At its limit: it takes no more records. */
  readonly full: boolean
}

export interface CodeCopyPage {
  readonly records: readonly CodeCopyRecord[]
  readonly more: boolean
  readonly lastSeq: number
}

/**
 * Where the hub keeps the copies (`docs/dev/qmo-local.md` §5.3). The node
 * wires a file store under its config root; a test wires one in memory.
 * Every method takes the owner's subject and the device id the caller was
 * authenticated as or checked against the device ledger: the store itself
 * trusts its caller on who, and checks only shapes.
 */
export interface CodeCopiesPort {
  list(owner: string): readonly CodeCopy[]
  get(owner: string, device: string, session: string): CodeCopy | undefined
  /** Creates the copy or replaces its head; `full` when the account has no room for a new one. */
  saveHeader(
    owner: string,
    device: string,
    header: CodeCopyHeader,
  ): 'ok' | 'full'
  /**
   * Appends records, each with a seq above what is stored; the highest seq
   * stored after. `full` when they would take the copy or the account over
   * its limit (nothing is written), `missing` when there is no such copy.
   */
  append(
    owner: string,
    device: string,
    session: string,
    records: readonly CodeCopyRecord[],
  ): { readonly stored: number } | 'full' | 'missing'
  /** Up to `limit` turns, oldest first, from those first seen before `before`. */
  read(
    owner: string,
    device: string,
    session: string,
    before: number | undefined,
    limit: number,
  ): CodeCopyPage | undefined
  remove(owner: string, device: string, session: string): boolean
  removeDevice(owner: string, device: string): void
  removeOwner(owner: string): void
  /**
   * Drops every device folder `keep` does not keep, given the owner key and
   * the device id; the number dropped. Run at start, against the ledger.
   */
  prune(keep: (ownerKey: string, device: string) => boolean): number
  /** Where the link's up and down lines go (a node writes them to stderr). */
  note?(line: string): void
}

/** The runner's answer to a request sent down a link. */
export type LinkReply =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false
      /** `offline` and `timeout` are the hub's own; the rest the runner's `E_…`. */
      readonly code: string
      readonly message: string
    }

/** A request sent down a link: a line, an answer, a stop. */
export type LinkRequest =
  | {
      readonly t: 'send'
      readonly session: string
      readonly text: string
      readonly clientId: string
    }
  | {
      readonly t: 'answer'
      readonly session: string
      readonly ask: string
      readonly decision: 'once' | 'session' | 'deny'
      readonly message?: string
    }
  | { readonly t: 'stop'; readonly session: string }

/**
 * What the routes and the device door use of the links (`codeLink.ts`
 * holds them), so the handler's dependencies name a port, not the class.
 */
export interface CodeLinksPort {
  /** Whether the device has a link up (after its hello). */
  online(deviceId: string): boolean
  /** The copies of `owner`'s devices. */
  copies(owner: string): readonly CodeCopy[]
  /** Sends `request` to `owner`'s device and waits for the runner's reply. */
  ask(owner: string, deviceId: string, request: LinkRequest): Promise<LinkReply>
  /** Hears about every change to `owner`'s copies and devices. */
  subscribe(owner: string, listener: (rev: number) => void): () => void
  /** A copy was dropped by a person elsewhere. */
  changed(owner: string): void
  /** A device revoked: its link closes and its copies go. */
  endDevice(deviceId: string, owner: string): void
}

/** The folder name an account's copies live under: no subject in a path. */
export function codeOwnerKey(subject: string): string {
  return createHash('sha256').update(subject).digest('hex').slice(0, 32)
}

// ---- checks ------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function one<T extends string>(
  value: unknown,
  choices: readonly T[],
): T | undefined {
  return choices.find(choice => choice === value)
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function time(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function bytes(text: string): number {
  return Buffer.byteLength(text)
}

/** A string of at most `max` UTF-8 bytes, controls allowed (text, detail). */
function body(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && bytes(value) <= max ? value : undefined
}

/** A one-line string of at most `max` characters. */
function line(value: unknown, max: number): string | undefined {
  return typeof value === 'string' &&
    value.length <= max &&
    !CONTROL.test(value)
    ? value
    : undefined
}

function paths(value: unknown): readonly string[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_PATHS) return null
  const out: string[] = []
  for (const item of value) {
    const path = line(item, MAX_PATH)
    if (path === undefined) return null
    out.push(path)
  }
  return out
}

function toolOf(value: unknown): CodeTool | undefined {
  if (!isRecord(value)) return undefined
  const id = line(value.id, 128)
  const name = line(value.name, 128)
  const status = one(value.status, TOOL_STATUSES)
  const detailKind = one(value.detailKind, ['output', 'diff'] as const)
  const listed = paths(value.paths)
  if (
    id === undefined ||
    name === undefined ||
    status === undefined ||
    detailKind === undefined ||
    listed === null
  )
    return undefined
  const command =
    value.command === undefined ? undefined : body(value.command, 4_096)
  const added = value.added === undefined ? undefined : count(value.added)
  const removed = value.removed === undefined ? undefined : count(value.removed)
  const approvedBy =
    value.approvedBy === undefined
      ? undefined
      : one(value.approvedBy, ['mode', 'user', 'session'] as const)
  if (
    (value.command !== undefined && command === undefined) ||
    (value.added !== undefined && added === undefined) ||
    (value.removed !== undefined && removed === undefined) ||
    (value.approvedBy !== undefined && approvedBy === undefined)
  )
    return undefined
  return {
    id,
    name,
    status,
    ...(listed === undefined ? {} : { paths: listed }),
    ...(command === undefined ? {} : { command }),
    detailKind,
    ...(added === undefined ? {} : { added }),
    ...(removed === undefined ? {} : { removed }),
    ...(approvedBy === undefined ? {} : { approvedBy }),
  }
}

function askOf(value: unknown): CodeAsk | undefined {
  if (!isRecord(value)) return undefined
  const id =
    typeof value.id === 'string' && ASK_ID.test(value.id) ? value.id : undefined
  const tool = line(value.tool, 128)
  const title = line(value.title, 1_024)
  const listed = paths(value.paths)
  const options = Array.isArray(value.options)
    ? value.options.map(option => one(option, DECISIONS))
    : undefined
  if (
    id === undefined ||
    tool === undefined ||
    title === undefined ||
    listed === null ||
    options === undefined ||
    options.length === 0 ||
    options.length > 3 ||
    options.some(option => option === undefined)
  )
    return undefined
  const input =
    value.input === undefined ? undefined : body(value.input, MAX_INPUT_BYTES)
  const decision =
    value.decision === undefined ? undefined : one(value.decision, DECISIONS)
  const by =
    value.by === undefined
      ? undefined
      : one(value.by, ['user', 'stop', 'shutdown'] as const)
  const at = value.at === undefined ? undefined : time(value.at)
  if (
    (value.input !== undefined && input === undefined) ||
    (value.decision !== undefined && decision === undefined) ||
    (value.by !== undefined && by === undefined) ||
    (value.at !== undefined && at === undefined)
  )
    return undefined
  return {
    id,
    tool,
    title,
    ...(listed === undefined ? {} : { paths: listed }),
    ...(input === undefined ? {} : { input }),
    options: options as CodeDecision[],
    ...(decision === undefined ? {} : { decision }),
    ...(by === undefined ? {} : { by }),
    ...(at === undefined ? {} : { at }),
  }
}

/** A turn of `session`, rebuilt from what checks; `undefined` for anything else. */
function codeTurnOf(value: unknown, session: string): CodeCopyTurn | undefined {
  if (!isRecord(value)) return undefined
  const id =
    typeof value.id === 'string' && TURN_ID.test(value.id)
      ? value.id
      : undefined
  const author = one(value.author, ['operator', 'agent'] as const)
  const at = time(value.at)
  const text = body(value.text, MAX_TEXT_BYTES)
  const state = one(value.state, TURN_STATES)
  if (
    id === undefined ||
    value.sessionId !== session ||
    author === undefined ||
    at === undefined ||
    text === undefined ||
    state === undefined
  )
    return undefined
  const code =
    value.code === undefined
      ? undefined
      : typeof value.code === 'string' && CODE.test(value.code)
        ? value.code
        : null
  const variant =
    value.variant === undefined
      ? undefined
      : value.variant === 'notice'
        ? 'notice'
        : null
  const noticeSource =
    value.noticeSource === undefined
      ? undefined
      : value.noticeSource === 'step'
        ? 'step'
        : null
  const severity =
    value.severity === undefined
      ? undefined
      : (one(value.severity, SEVERITIES) ?? null)
  const detail =
    value.detail === undefined
      ? undefined
      : (body(value.detail, MAX_DETAIL_BYTES) ?? null)
  const tool =
    value.tool === undefined ? undefined : (toolOf(value.tool) ?? null)
  const ask = value.ask === undefined ? undefined : (askOf(value.ask) ?? null)
  const clientId =
    value.clientId === undefined
      ? undefined
      : typeof value.clientId === 'string' && CLIENT_ID.test(value.clientId)
        ? value.clientId
        : null
  const origin =
    value.origin === undefined
      ? undefined
      : value.origin === 'remote'
        ? 'remote'
        : null
  if (
    [
      code,
      variant,
      noticeSource,
      severity,
      detail,
      tool,
      ask,
      clientId,
      origin,
    ].some(part => part === null)
  )
    return undefined
  return {
    id,
    sessionId: session,
    author,
    at,
    text,
    state,
    ...(code == null ? {} : { code }),
    ...(variant == null ? {} : { variant }),
    ...(noticeSource == null ? {} : { noticeSource }),
    ...(severity == null ? {} : { severity }),
    ...(detail == null ? {} : { detail }),
    ...(tool == null ? {} : { tool }),
    ...(ask == null ? {} : { ask }),
    ...(clientId == null ? {} : { clientId }),
    ...(origin == null ? {} : { origin }),
  }
}

/** A session head, rebuilt from what checks. */
export function codeHeaderOf(value: unknown): CodeCopyHeader | undefined {
  if (!isRecord(value)) return undefined
  const id =
    typeof value.id === 'string' && CODE_SESSION_ID.test(value.id)
      ? value.id
      : undefined
  const title = line(value.title, 200)
  const folder = line(value.folder, 256)
  const agent = isRecord(value.agent) ? value.agent : undefined
  const agentId =
    typeof agent?.id === 'string' && AGENT_ID.test(agent.id)
      ? agent.id
      : undefined
  const agentName = line(agent?.name, 64)
  const mode = one(value.mode, MODES)
  const state = one(value.state, STATES)
  const createdAt = time(value.createdAt)
  const updatedAt = time(value.updatedAt)
  const lastSeq = count(value.lastSeq)
  if (
    id === undefined ||
    title === undefined ||
    folder === undefined ||
    agentId === undefined ||
    agentName === undefined ||
    mode === undefined ||
    state === undefined ||
    typeof value.remote !== 'boolean' ||
    createdAt === undefined ||
    updatedAt === undefined ||
    lastSeq === undefined
  )
    return undefined
  return {
    id,
    title,
    folder,
    agent: { id: agentId, name: agentName },
    mode,
    state,
    remote: value.remote,
    createdAt,
    updatedAt,
    lastSeq,
  }
}

/** A record as a link pushes it, `{seq, turn}`; the seq must be positive. */
export function codeRecordOf(
  value: unknown,
  session: string,
): CodeCopyRecord | undefined {
  if (!isRecord(value)) return undefined
  const seq = count(value.seq)
  if (seq === undefined || seq < 1) return undefined
  const turn = codeTurnOf(value.turn, session)
  return turn === undefined ? undefined : { seq, kind: 'turn', turn }
}
