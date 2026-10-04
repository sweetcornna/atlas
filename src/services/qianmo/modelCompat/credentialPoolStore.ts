// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two node files behind the key pool (P18.18, hermes #2; design
 * `providers-console-m1.md` §9.2 P18.18, §5.11.6 X-1). Paths come from
 * `providerPaths` (`occConfigPath('qianmo','provider', …)`): directory 0700,
 * files 0600, every write tmp + fsync + rename with the tmp created 0600.
 *
 * - `key-pool.json` — every key of the committed profile, primary first. The
 *   node's commit writes it (`node.ts`), the call layer reads it. It carries
 *   key values, so it sits beside `pending.json` under the same rules, inside
 *   the `qianmo/` tree the resident hardline refuses to tools.
 * - `key-pool-state.json` — what the call layer learnt: which key is cooling
 *   until when and why, which is dead, which session is bound to which key,
 *   how often each key was chosen, the round-robin cursor. Ids and
 *   fingerprints only, never a value, so `status` reads it freely. It
 *   survives a process restart; that is its point.
 *
 * A key is named by id AND fingerprint everywhere in the state: when the hub
 * delivers a new value for an id, the fingerprint changes and nothing the old
 * value earned (a cooldown, a binding, a count) sticks to the new one.
 *
 * Several processes on one node read and write the state (the resident's ACP
 * child, `-p` runs). Every change is a read-modify-write of the file as it is
 * on disk at that moment, so a process applies its own change to whatever the
 * others wrote; two changes landing in the same instant can still lose one,
 * which costs at most one more failed request on that key.
 */

import { statSync } from 'node:fs'
import {
  isKeyId,
  isSecretFingerprint,
  KEY_OUT_REASONS,
  KEY_SELECTIONS,
  type KeyOutReason,
  type KeySelection,
} from '@qianmo/providers'
import {
  providerPaths,
  readTextIfExists,
  removeIfExists,
  writePrivateJson,
} from '../providers/store.js'

/** `key-pool.json`. `keys[0]` is the primary key — the one in `settings.json`. */
export type KeyPoolFile = {
  v: 1
  profile: { id: string; revision: number }
  requestId: string
  selection: KeySelection
  /** The env key holding the primary key's value (`OPENAI_API_KEY`). */
  envKey: string
  keys: { id: string; value: string }[]
}

/** Why and until when one key is out of rotation. */
type KeyMark = {
  fp: string
  state: 'cooling' | 'dead'
  /** `cooling`: ISO time it is tried again. */
  until?: string
  reason: KeyOutReason
  /** The HTTP status that took it out, when there was one. */
  status?: number
  at: string
}

/** `key-pool-state.json`. */
export type KeyPoolState = {
  v: 1
  marks: Record<string, KeyMark>
  /** How often each key was chosen for a session (`least_used`). */
  selections: Record<string, { fp: string; count: number }>
  /** `round_robin`: index in `keys` the next choice starts from. */
  cursor: number
  /** sessionId → the key it is bound to (X-1). */
  sessions: Record<string, { key: string; fp: string; at: string }>
}

/** Sessions remembered at once, as for the P18.19 cache-key pins. */
export const MAX_BOUND_SESSIONS = 256

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function emptyState(): KeyPoolState {
  return { v: 1, marks: {}, selections: {}, cursor: 0, sessions: {} }
}

// ---------------------------------------------------------------------------
// key-pool.json
// ---------------------------------------------------------------------------

/** Strict: anything malformed and there is no pool. */
function parseKeyPool(text: string): KeyPoolFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || raw.v !== 1) return null
  const { profile, requestId, selection, envKey, keys } = raw
  if (
    !isRecord(profile) ||
    typeof profile.id !== 'string' ||
    typeof profile.revision !== 'number' ||
    typeof requestId !== 'string' ||
    typeof selection !== 'string' ||
    !(KEY_SELECTIONS as readonly string[]).includes(selection) ||
    typeof envKey !== 'string' ||
    !Array.isArray(keys) ||
    keys.length < 2
  ) {
    return null
  }
  const parsed: KeyPoolFile['keys'] = []
  for (const key of keys) {
    if (
      !isRecord(key) ||
      !isKeyId(key.id) ||
      typeof key.value !== 'string' ||
      key.value.length === 0 ||
      parsed.some(other => other.id === key.id)
    ) {
      return null
    }
    parsed.push({ id: key.id, value: key.value })
  }
  return {
    v: 1,
    profile: { id: profile.id, revision: profile.revision },
    requestId,
    selection: selection as KeySelection,
    envKey,
    keys: parsed,
  }
}

type Cached<T> = { stamp: string; value: T }

/**
 * Path + inode + size + mtime: a rename onto the path always changes the
 * inode, and the path keeps two config roots apart.
 */
function stampOf(path: string): string | null {
  try {
    const stats = statSync(path)
    return `${path}\u0000${stats.ino}:${stats.size}:${stats.mtimeMs}`
  } catch {
    return null
  }
}

let poolCache: Cached<KeyPoolFile | null> | undefined

/** The committed pool, or `null` (no file, or a file that does not parse). */
export function readKeyPool(): KeyPoolFile | null {
  const path = providerPaths.keyPool()
  const stamp = stampOf(path)
  if (stamp === null) return null
  if (poolCache?.stamp === stamp) return poolCache.value
  const text = readTextIfExists(path)
  const value = text === undefined ? null : parseKeyPool(text)
  poolCache = { stamp, value }
  return value
}

/**
 * Write the pool a commit delivered, and forget what the state knew about
 * keys that are no longer in it (or whose value changed).
 */
export function writeKeyPool(
  file: KeyPoolFile,
  fingerprints: Readonly<Record<string, string>>,
): void {
  writePrivateJson(providerPaths.keyPool(), file)
  updateKeyPoolState(state => {
    const current = (id: string, fp: string) => fingerprints[id] === fp
    for (const [id, mark] of Object.entries(state.marks)) {
      if (!current(id, mark.fp)) delete state.marks[id]
    }
    for (const [id, entry] of Object.entries(state.selections)) {
      if (!current(id, entry.fp)) delete state.selections[id]
    }
    for (const [session, bound] of Object.entries(state.sessions)) {
      if (!current(bound.key, bound.fp)) delete state.sessions[session]
    }
    if (state.cursor >= file.keys.length) state.cursor = 0
  })
}

/** A single-key profile was committed: no pool, and nothing to remember. */
export function removeKeyPool(): void {
  removeIfExists(providerPaths.keyPool())
  removeIfExists(providerPaths.keyPoolState())
}

// ---------------------------------------------------------------------------
// key-pool-state.json
// ---------------------------------------------------------------------------

function isIsoTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function parseMark(raw: unknown): KeyMark | null {
  if (!isRecord(raw)) return null
  const { fp, state, until, reason, status, at } = raw
  if (
    !isSecretFingerprint(fp) ||
    (state !== 'cooling' && state !== 'dead') ||
    typeof reason !== 'string' ||
    !(KEY_OUT_REASONS as readonly string[]).includes(reason) ||
    !isIsoTime(at) ||
    (state === 'cooling' && !isIsoTime(until))
  ) {
    return null
  }
  return {
    fp,
    state,
    ...(isIsoTime(until) ? { until } : {}),
    reason: reason as KeyOutReason,
    ...(typeof status === 'number' && Number.isInteger(status)
      ? { status }
      : {}),
    at,
  }
}

/** Lenient: an entry that does not parse is dropped, not the whole state. */
function parseState(text: string): KeyPoolState {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return emptyState()
  }
  const state = emptyState()
  if (!isRecord(raw) || raw.v !== 1) return state
  if (isRecord(raw.marks)) {
    for (const [id, entry] of Object.entries(raw.marks)) {
      const mark = parseMark(entry)
      if (isKeyId(id) && mark !== null) state.marks[id] = mark
    }
  }
  if (isRecord(raw.selections)) {
    for (const [id, entry] of Object.entries(raw.selections)) {
      if (
        isKeyId(id) &&
        isRecord(entry) &&
        isSecretFingerprint(entry.fp) &&
        typeof entry.count === 'number' &&
        Number.isSafeInteger(entry.count) &&
        entry.count >= 0
      ) {
        state.selections[id] = { fp: entry.fp, count: entry.count }
      }
    }
  }
  if (
    typeof raw.cursor === 'number' &&
    Number.isSafeInteger(raw.cursor) &&
    raw.cursor >= 0
  ) {
    state.cursor = raw.cursor
  }
  if (isRecord(raw.sessions)) {
    for (const [session, entry] of Object.entries(raw.sessions)) {
      if (
        session.length > 0 &&
        session.length <= 128 &&
        isRecord(entry) &&
        isKeyId(entry.key) &&
        isSecretFingerprint(entry.fp) &&
        isIsoTime(entry.at)
      ) {
        state.sessions[session] = {
          key: entry.key,
          fp: entry.fp,
          at: entry.at,
        }
      }
    }
  }
  return state
}

let stateCache: Cached<KeyPoolState> | undefined

function cloneState(state: KeyPoolState): KeyPoolState {
  return JSON.parse(JSON.stringify(state)) as KeyPoolState
}

/** What the call layer knows right now (a copy; edit through the updater). */
export function readKeyPoolState(): KeyPoolState {
  const path = providerPaths.keyPoolState()
  const stamp = stampOf(path)
  if (stamp === null) return emptyState()
  if (stateCache?.stamp !== stamp) {
    const text = readTextIfExists(path)
    stateCache = {
      stamp,
      value: text === undefined ? emptyState() : parseState(text),
    }
  }
  return cloneState(stateCache.value)
}

/** Keep the most recently bound sessions only. */
function pruneSessions(state: KeyPoolState): void {
  const entries = Object.entries(state.sessions)
  if (entries.length <= MAX_BOUND_SESSIONS) return
  entries.sort(([, a], [, b]) => a.at.localeCompare(b.at))
  for (const [session] of entries.slice(
    0,
    entries.length - MAX_BOUND_SESSIONS,
  )) {
    delete state.sessions[session]
  }
}

/**
 * Apply `change` to the state as it is on disk now and write it back (0600).
 * Returns the state written.
 */
export function updateKeyPoolState(
  change: (state: KeyPoolState) => void,
): KeyPoolState {
  const state = readKeyPoolState()
  change(state)
  pruneSessions(state)
  writePrivateJson(providerPaths.keyPoolState(), state)
  stateCache = undefined
  return state
}
