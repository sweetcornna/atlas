// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The agent's runtime lock (P36.7, `harness-backends.md` §7.2): while
 * `qm runtime open` runs an agent's official frontend on the agent's state,
 * the resident starts no process of that agent and the console's native
 * operations wait, so two writers never share the harness's files.
 *
 * Plain files under `qianmoConfigPath('runtimes', 'locks')`, because the
 * frontend command and the resident are separate processes with nothing
 * else in common:
 *
 * | file | written by | content |
 * |---|---|---|
 * | `<agent>.lock` | `qm runtime open` (created exclusively) | `{pid, nonce, runtime, at}` |
 * | `<agent>.ack` | the resident's pool, once per lock | `{nonce, pid, busy}` |
 *
 * The pool looks every second. A lock it has not answered yet: a turn in
 * progress answers `busy` (the frontend refuses and lets go); otherwise the
 * agent's idle processes are closed first, then it answers free. A lock
 * whose process is gone counts as no lock. A lock appears whole (written
 * aside, then linked into place), and a dead one is moved aside and checked
 * before it goes, so two takers never both win. The resident also keeps a
 * secret-free roster (`resident/runtime-agents.json`) for the frontend
 * command: each agent's workspace and where it runs.
 */

import { randomUUID } from 'node:crypto'
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { qianmoConfigPath } from '@qianmo/paths'
import { writePrivateJson } from '../../providers/store.js'

export interface FrontendLock {
  readonly pid: number
  readonly nonce: string
  readonly runtime: string
  readonly at: number
}

export interface FrontendAck {
  readonly nonce: string
  readonly pid: number
  /** A turn of the agent was in progress: the frontend must not start. */
  readonly busy: boolean
}

/** One agent as the resident runs it, for `qm runtime open`. */
export interface ResidentRosterAgent {
  readonly agent: string
  readonly cwd: string
  readonly shell: boolean
  /** The external runtime its sessions use (a catalog id). */
  readonly runtime: string
  /** That runtime's executable, as the resident starts it. */
  readonly bin: string
  /** The model spec (`<profile>/<model>`) its runtime starts with. */
  readonly model: string | null
}

export interface ResidentRoster {
  readonly v: 1
  readonly pid: number
  readonly agents: readonly ResidentRosterAgent[]
}

const AGENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

function lockDir(): string {
  return qianmoConfigPath('runtimes', 'locks')
}
function lockPath(agent: string): string {
  if (!AGENT.test(agent)) throw new Error(`invalid agent name ${agent}`)
  return join(lockDir(), `${agent}.lock`)
}
function ackPath(agent: string): string {
  return join(lockDir(), `${agent}.ack`)
}

/** Whether a process with `pid` exists (one of another user counts). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function parseJson(
  text: string | undefined,
): Record<string, unknown> | undefined {
  if (text === undefined) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  return parseJson(readText(path))
}

/** The lock in `text`, when the process holding it is alive. */
function liveLock(text: string | undefined): FrontendLock | undefined {
  const raw = parseJson(text)
  if (
    raw === undefined ||
    typeof raw.pid !== 'number' ||
    typeof raw.nonce !== 'string' ||
    typeof raw.runtime !== 'string' ||
    typeof raw.at !== 'number' ||
    !pidAlive(raw.pid)
  )
    return undefined
  return { pid: raw.pid, nonce: raw.nonce, runtime: raw.runtime, at: raw.at }
}

/** `agent`'s lock, when the process holding it is alive. */
export function readFrontendLock(agent: string): FrontendLock | undefined {
  return liveLock(readText(lockPath(agent)))
}

/** Whether an official frontend holds `agent`'s state now. */
export function frontendHolds(agent: string): boolean {
  return readFrontendLock(agent) !== undefined
}

/**
 * Takes `agent`'s lock for this process; `undefined` when a live process
 * holds it. A lock left by a process that is gone is taken over.
 */
export function acquireFrontendLock(
  agent: string,
  runtime: string,
): FrontendLock | undefined {
  const path = lockPath(agent)
  mkdirSync(lockDir(), { recursive: true, mode: 0o700 })
  const lock: FrontendLock = {
    pid: process.pid,
    nonce: randomUUID(),
    runtime,
    at: Date.now(),
  }
  // Written whole before it can be seen: a taker never finds it half done.
  const staged = join(lockDir(), `.${agent}.${lock.nonce}.new`)
  writeFileSync(staged, JSON.stringify(lock), { mode: 0o600, flag: 'wx' })
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(staged, path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (!clearDeadLock(agent)) return undefined
        continue
      }
      rmSync(ackPath(agent), { force: true })
      return lock
    }
    return undefined
  } finally {
    rmSync(staged, { force: true })
  }
}

/**
 * Removes `agent`'s lock unless a live process holds it (`false` then). It is
 * moved aside first and compared with what was judged dead: a lock another
 * taker put in place meanwhile is put back, not removed.
 */
function clearDeadLock(agent: string): boolean {
  const path = lockPath(agent)
  const seen = readText(path)
  if (seen === undefined) return true
  if (liveLock(seen) !== undefined) return false
  const aside = join(lockDir(), `.${agent}.${randomUUID()}.dead`)
  try {
    renameSync(path, aside)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
  const moved = readText(aside)
  if (moved === seen) {
    rmSync(aside, { force: true })
    return true
  }
  try {
    linkSync(aside, path)
  } catch {
    // A third taker is in place already; the one moved aside learns it has
    // lost the lock from `holdsFrontendLock` before it starts anything.
  }
  rmSync(aside, { force: true })
  return false
}

/** Whether `lock` is still the one in place (checked before a frontend starts). */
export function holdsFrontendLock(agent: string, lock: FrontendLock): boolean {
  return readJson(lockPath(agent))?.nonce === lock.nonce
}

/** Lets go of `lock` (only if it is still this one). */
export function releaseFrontendLock(agent: string, lock: FrontendLock): void {
  const raw = readJson(lockPath(agent))
  if (raw?.nonce !== lock.nonce) return
  rmSync(lockPath(agent), { force: true })
  rmSync(ackPath(agent), { force: true })
}

export function readFrontendAck(agent: string): FrontendAck | undefined {
  const raw = readJson(ackPath(agent))
  if (
    raw === undefined ||
    typeof raw.nonce !== 'string' ||
    typeof raw.pid !== 'number' ||
    typeof raw.busy !== 'boolean'
  )
    return undefined
  return { nonce: raw.nonce, pid: raw.pid, busy: raw.busy }
}

export function writeFrontendAck(agent: string, ack: FrontendAck): void {
  mkdirSync(lockDir(), { recursive: true, mode: 0o700 })
  writePrivateJson(ackPath(agent), ack)
}

function rosterPath(): string {
  return qianmoConfigPath('resident', 'runtime-agents.json')
}

export function writeResidentRoster(
  agents: readonly ResidentRosterAgent[],
): void {
  const roster: ResidentRoster = { v: 1, pid: process.pid, agents }
  writePrivateJson(rosterPath(), roster)
}

export function readResidentRoster(): ResidentRoster | undefined {
  const raw = readJson(rosterPath())
  if (raw === undefined || raw.v !== 1 || typeof raw.pid !== 'number')
    return undefined
  if (!Array.isArray(raw.agents)) return undefined
  const agents: ResidentRosterAgent[] = []
  for (const one of raw.agents as unknown[]) {
    if (one === null || typeof one !== 'object') continue
    const row = one as Record<string, unknown>
    if (
      typeof row.agent !== 'string' ||
      typeof row.cwd !== 'string' ||
      typeof row.runtime !== 'string' ||
      typeof row.bin !== 'string'
    )
      continue
    agents.push({
      agent: row.agent,
      cwd: row.cwd,
      shell: row.shell === true,
      runtime: row.runtime,
      bin: row.bin,
      model: typeof row.model === 'string' ? row.model : null,
    })
  }
  return { v: 1, pid: raw.pid, agents }
}
