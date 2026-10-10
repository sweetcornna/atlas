// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * File-backed teammate inbox.
 *
 * One inbox per agent per team, stored as a JSON array at
 * `<config root>/teams/<team>/inboxes/<agent>.json`. Every mutation runs under
 * a `proper-lockfile` lock on the inbox (`<inbox>.lock`), re-reads the file
 * inside the lock, compacts it to the size bounds below and replaces it with a
 * temp-file + rename, so a reader never sees a half-written array.
 *
 * The on-disk shape is shared with nodes that already hold inbox files, so the
 * field set, the identity tuple `[from, timestamp, text]`, the limits and the
 * compaction order are part of the format, not implementation details.
 */

import { randomBytes } from 'node:crypto'
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { qianmoConfigPath } from '@qianmo/paths'
import { lock } from 'proper-lockfile'

/** Name of the agent that leads a team; the resident's own inbox. */
export const TEAM_LEAD_NAME = 'team-lead'

/** Element name {@link formatTeammateMessages} wraps each message in. */
export const TEAMMATE_MESSAGE_TAG = 'teammate-message'

/** Most regular (non-protocol) messages kept after compaction, read + unread. */
export const MAX_MAILBOX_MESSAGES = 1_000
/** Most already-read messages kept after compaction. */
export const MAX_READ_MAILBOX_MESSAGES = 200
/** Most unread protocol messages kept, on a lane independent of the regular cap. */
export const MAX_UNREAD_PROTOCOL_MAILBOX_MESSAGES = 2_000
/** Largest accepted message `text`, in UTF-8 bytes. */
export const MAX_MAILBOX_MESSAGE_TEXT_BYTES = 64 * 1024
/** Budget of serialized message bytes compaction keeps. */
export const MAX_MAILBOX_RETAINED_BYTES = 2 * 1024 * 1024
/** Largest inbox file read or written. */
export const MAX_MAILBOX_FILE_BYTES = 4 * 1024 * 1024

const LOCK_RETRIES = { retries: 10, minTimeout: 5, maxTimeout: 100 }

const PROTOCOL_TYPES: Readonly<Record<string, true>> = {
  permission_request: true,
  permission_response: true,
  sandbox_permission_request: true,
  sandbox_permission_response: true,
  shutdown_request: true,
  shutdown_approved: true,
  team_permission_update: true,
  mode_set_request: true,
  plan_approval_request: true,
  plan_approval_response: true,
}

export type TeammateMessage = {
  from: string
  text: string
  timestamp: string
  read: boolean
  /** Sender's display colour. */
  color?: string
  /** Short preview line. */
  summary?: string
}

export type CompactionLimits = {
  maxMessages?: number
  maxReadMessages?: number
  maxUnreadProtocolMessages?: number
  maxRetainedBytes?: number
}

// ─── Names ─────────────────────────────────────────────────────────────────

/** Windows device stems, reserved at every directory level and with any extension. */
const WINDOWS_DEVICE_STEM = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/

/**
 * Inbox path segment: every character outside `[A-Za-z0-9_-]` becomes `-`.
 * Used for both the team directory and the agent file name.
 */
export function sanitizePathComponent(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '-')
}

/**
 * Team roster directory name: lowercased, every non-alphanumeric character
 * (including `_`) becomes `-`, and a Windows device stem gets a `_` prefix.
 * Differs from {@link sanitizePathComponent} on `_` and device names, which is
 * why adapter team names are normalized so both agree.
 */
export function sanitizeName(name: string): string {
  const folded = name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
  const stem = folded.split('.')[0] ?? ''
  if (WINDOWS_DEVICE_STEM.test(stem)) return `_${folded}`
  return folded.replace(/[. ]+$/, '')
}

/** `<config root>/teams/<team>/inboxes/<agent>.json`; team defaults to `default`. */
export function getInboxPath(agentName: string, teamName?: string): string {
  return join(inboxDir(teamName), `${sanitizePathComponent(agentName)}.json`)
}

function inboxDir(teamName: string | undefined): string {
  return qianmoConfigPath(
    'teams',
    sanitizePathComponent(teamName || 'default'),
    'inboxes',
  )
}

// ─── Message classification ─────────────────────────────────────────────────

/** The `type` field of `text` parsed as a JSON object, if it has one. */
function jsonTypeField(text: string): { type: unknown } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed && typeof parsed === 'object' && 'type' in parsed) {
    return { type: parsed.type }
  }
  return undefined
}

/**
 * Whether `text` is a JSON control message (permission, sandbox, shutdown,
 * plan-approval, mode-set, team-permission) meant for a protocol handler
 * rather than for the model's context.
 */
export function isStructuredProtocolMessage(text: string): boolean {
  const type = jsonTypeField(text)?.type
  return typeof type === 'string' && PROTOCOL_TYPES[type] === true
}

/**
 * Unread and a JSON object carrying a `type`: an unknown control message is
 * kept as carefully as a known protocol message.
 */
function isProtocolLane(message: TeammateMessage): boolean {
  if (message.read) return false
  const head = message.text.trimStart()
  if (!head.startsWith('{') && !head.startsWith('[')) return false
  return jsonTypeField(message.text) !== undefined
}

/** The `[from, timestamp, text]` tuple that identifies a message on disk. */
function identityOf(message: TeammateMessage): string {
  return JSON.stringify([message.from, message.timestamp, message.text])
}

function countBy<T>(items: Iterable<T>, key: (item: T) => string | undefined) {
  const counts = new Map<string, number>()
  for (const item of items) {
    const k = key(item)
    if (k !== undefined) counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return counts
}

function sum(values: Iterable<number>): number {
  let total = 0
  for (const v of values) total += v
  return total
}

// ─── Compaction ────────────────────────────────────────────────────────────

/**
 * Bound an inbox, newest first within each tier:
 *
 * 1. unread protocol messages, up to `maxUnreadProtocolMessages`;
 * 2. other unread messages, up to `maxMessages`;
 * 3. read messages, up to `maxReadMessages` and only while tier 2 plus tier 3
 *    stays under `maxMessages`.
 *
 * Every tier draws on one `maxRetainedBytes` budget of compact-JSON bytes; a
 * message that does not fit is skipped. Original order is preserved.
 */
export function compactMailboxMessages(
  messages: TeammateMessage[],
  limits: CompactionLimits = {},
): TeammateMessage[] {
  const maxMessages = limits.maxMessages ?? MAX_MAILBOX_MESSAGES
  const maxRead = limits.maxReadMessages ?? MAX_READ_MAILBOX_MESSAGES
  const maxProtocol =
    limits.maxUnreadProtocolMessages ?? MAX_UNREAD_PROTOCOL_MAILBOX_MESSAGES
  const budget = limits.maxRetainedBytes ?? MAX_MAILBOX_RETAINED_BYTES
  if (budget <= 0 || (maxMessages <= 0 && maxProtocol <= 0)) return []

  const protocol = messages.map(isProtocolLane)
  const kept = new Set<number>()
  let used = 0
  const keep = (index: number): boolean => {
    const bytes = Buffer.byteLength(JSON.stringify(messages[index]), 'utf8')
    if (used + bytes > budget) return false
    kept.add(index)
    used += bytes
    return true
  }

  let protocolKept = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (protocolKept >= maxProtocol) break
    if (protocol[i] && keep(i)) protocolKept++
  }

  let regularKept = 0
  for (let i = messages.length - 1; i >= 0 && regularKept < maxMessages; i--) {
    if (!messages[i]!.read && !protocol[i] && keep(i)) regularKept++
  }

  let readKept = 0
  for (
    let i = messages.length - 1;
    i >= 0 && regularKept < maxMessages && readKept < maxRead;
    i--
  ) {
    if (messages[i]!.read && keep(i)) {
      readKept++
      regularKept++
    }
  }

  return messages.filter((_, index) => kept.has(index))
}

// ─── File I/O ──────────────────────────────────────────────────────────────

function errnoCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    return typeof error.code === 'string' ? error.code : undefined
  }
  return undefined
}

function validateMessage(value: unknown): TeammateMessage {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid mailbox message: expected object')
  }
  const r = value as Record<string, unknown>
  if (
    typeof r.from !== 'string' ||
    typeof r.text !== 'string' ||
    typeof r.timestamp !== 'string' ||
    typeof r.read !== 'boolean'
  ) {
    throw new Error('Invalid mailbox message shape')
  }
  if (Buffer.byteLength(r.text, 'utf8') > MAX_MAILBOX_MESSAGE_TEXT_BYTES) {
    throw new Error(
      `Mailbox message text exceeds ${MAX_MAILBOX_MESSAGE_TEXT_BYTES} bytes`,
    )
  }
  const message: TeammateMessage = {
    from: r.from,
    text: r.text,
    timestamp: r.timestamp,
    read: r.read,
  }
  if (typeof r.color === 'string') message.color = r.color
  if (typeof r.summary === 'string') message.summary = r.summary
  return message
}

async function loadInbox(path: string): Promise<TeammateMessage[]> {
  const { size } = await stat(path)
  if (size > MAX_MAILBOX_FILE_BYTES) {
    throw new Error(
      `Mailbox file exceeds ${MAX_MAILBOX_FILE_BYTES} bytes: ${path}`,
    )
  }
  const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'))
  if (!Array.isArray(parsed)) {
    throw new Error('Invalid mailbox file: expected message array')
  }
  return parsed.map(validateMessage)
}

async function storeInbox(
  path: string,
  messages: TeammateMessage[],
  context: string,
): Promise<void> {
  const compacted = compactMailboxMessages(messages)
  reportUnreadEvictions(messages, compacted, context)
  const content = JSON.stringify(compacted, null, 2)
  if (Buffer.byteLength(content, 'utf8') > MAX_MAILBOX_FILE_BYTES) {
    throw new Error(
      `Compacted mailbox still exceeds ${MAX_MAILBOX_FILE_BYTES} bytes`,
    )
  }
  const temp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, 'utf-8')
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

function reportUnreadEvictions(
  before: TeammateMessage[],
  after: TeammateMessage[],
  context: string,
): void {
  const kept = new Set(after)
  const evicted = before.filter(m => !m.read && !kept.has(m))
  if (evicted.length === 0) return
  const protocol = evicted.filter(isProtocolLane).length
  console.error(
    `[mailbox] ${context}: compaction dropped ${evicted.length} unread message(s); protocol_or_unknown=${protocol}`,
  )
}

/** Run `fn` on the inbox's messages under the inbox lock. */
async function withInboxLock<T>(
  path: string,
  fn: (messages: TeammateMessage[]) => Promise<T>,
): Promise<T> {
  const release = await lock(path, {
    lockfilePath: `${path}.lock`,
    retries: LOCK_RETRIES,
  })
  try {
    return await fn(await loadInbox(path))
  } finally {
    await release()
  }
}

// ─── Public operations ─────────────────────────────────────────────────────

/**
 * Every message in the inbox; `[]` when the inbox does not exist. Throws on a
 * corrupt, oversized or malformed inbox instead of hiding it.
 */
export async function readMailbox(
  agentName: string,
  teamName?: string,
): Promise<TeammateMessage[]> {
  try {
    return await loadInbox(getInboxPath(agentName, teamName))
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return []
    throw error
  }
}

/** The unread subset of {@link readMailbox}. */
export async function readUnreadMessages(
  agentName: string,
  teamName?: string,
): Promise<TeammateMessage[]> {
  return (await readMailbox(agentName, teamName)).filter(m => !m.read)
}

/**
 * Append an unread message, creating the inbox if needed. Rejects text over
 * {@link MAX_MAILBOX_MESSAGE_TEXT_BYTES} and a corrupt existing inbox (left
 * untouched).
 */
export async function writeToMailbox(
  recipientName: string,
  message: Omit<TeammateMessage, 'read'>,
  teamName?: string,
): Promise<void> {
  await mkdir(inboxDir(teamName), { recursive: true })
  const path = getInboxPath(recipientName, teamName)
  // proper-lockfile locks an existing file only.
  try {
    await writeFile(path, '[]', { encoding: 'utf-8', flag: 'wx' })
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error
  }
  await withInboxLock(path, async messages => {
    messages.push(validateMessage({ ...message, read: false }))
    await storeInbox(path, messages, 'writeToMailbox')
  })
}

/** Mark every message read. A missing inbox is a no-op. */
export async function markMessagesAsRead(
  agentName: string,
  teamName?: string,
): Promise<void> {
  const path = getInboxPath(agentName, teamName)
  try {
    await withInboxLock(path, async messages => {
      if (messages.length === 0) return
      for (const m of messages) m.read = true
      await storeInbox(path, messages, 'markMessagesAsRead')
    })
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return
    console.error(`[mailbox] markMessagesAsRead(${agentName}) failed:`, error)
  }
}

/**
 * Mark the first unread message with `expected`'s identity read. Returns
 * whether one was found; never throws.
 */
export async function markMessageAsReadByIdentity(
  agentName: string,
  teamName: string | undefined,
  expected: TeammateMessage,
): Promise<boolean> {
  const path = getInboxPath(agentName, teamName)
  const identity = identityOf(expected)
  try {
    return await withInboxLock(path, async messages => {
      const index = messages.findIndex(
        m => !m.read && identityOf(m) === identity,
      )
      if (index < 0) return false
      messages[index] = { ...messages[index]!, read: true }
      await storeInbox(path, messages, 'markMessageAsReadByIdentity')
      return true
    })
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') {
      console.error(
        `[mailbox] markMessageAsReadByIdentity(${agentName}) failed:`,
        error,
      )
    }
    return false
  }
}

/**
 * Acknowledge the unread messages of an earlier snapshot.
 *
 * For each identity the snapshot held `n` unread copies of, at most `n`
 * currently-unread copies are marked, oldest first, so messages appended after
 * the snapshot (including exact duplicates) stay unread.
 *
 * Without `readBefore` the return value is the number of messages marked.
 * With it — the per-identity read counts observed when the snapshot was taken
 * — copies that someone else already marked read since then count as
 * acknowledged and are not marked again; the return value is how many
 * snapshot messages are now accounted for as read. Never throws; returns 0 on
 * a missing or unreadable inbox.
 */
export async function markMessagesAsReadBySnapshot(
  agentName: string,
  teamName: string | undefined,
  snapshot: TeammateMessage[],
  readBefore?: Readonly<Record<string, number>>,
): Promise<number> {
  const pending = countBy(snapshot, m => (m.read ? undefined : identityOf(m)))
  if (pending.size === 0) return 0
  const expected = sum(pending.values())
  const path = getInboxPath(agentName, teamName)

  try {
    return await withInboxLock(path, async messages => {
      if (readBefore !== undefined) {
        const readNow = countBy(messages, m =>
          m.read ? identityOf(m) : undefined,
        )
        for (const [identity, n] of pending) {
          const stillUnread =
            (readBefore[identity] ?? 0) + n - (readNow.get(identity) ?? 0)
          if (stillUnread > 0) pending.set(identity, stillUnread)
          else pending.delete(identity)
        }
      }

      let marked = 0
      for (let i = 0; i < messages.length && pending.size > 0; i++) {
        const message = messages[i]!
        if (message.read) continue
        const identity = identityOf(message)
        const left = pending.get(identity)
        if (!left) continue
        messages[i] = { ...message, read: true }
        marked++
        if (left === 1) pending.delete(identity)
        else pending.set(identity, left - 1)
      }

      if (marked > 0) {
        await storeInbox(path, messages, 'markMessagesAsReadBySnapshot')
      }
      return readBefore === undefined
        ? marked
        : expected - sum(pending.values())
    })
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') {
      console.error(
        `[mailbox] markMessagesAsReadBySnapshot(${agentName}) failed:`,
        error,
      )
    }
    return 0
  }
}

/**
 * Render messages for a model turn, one `<teammate-message>` element each,
 * separated by a blank line. Attributes and text are inserted verbatim:
 * callers sanitize untrusted content first.
 */
export function formatTeammateMessages(
  messages: ReadonlyArray<{
    from: string
    text: string
    timestamp: string
    color?: string
    summary?: string
  }>,
): string {
  return messages
    .map(m => {
      const color = m.color ? ` color="${m.color}"` : ''
      const summary = m.summary ? ` summary="${m.summary}"` : ''
      return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${color}${summary}>\n${m.text}\n</${TEAMMATE_MESSAGE_TAG}>`
    })
    .join('\n\n')
}
