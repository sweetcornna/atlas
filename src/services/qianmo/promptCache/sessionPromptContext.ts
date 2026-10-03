// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Per-session prompt context for a multi-session ACP process (P18.19 CH-1,
 * design `providers-console-m1.md` §5.11.5).
 *
 * ## The problem
 *
 * A REPL computes its prompt context once — `getUserContext()` (CLAUDE.md,
 * the auto-memory index, today's date), `getSystemContext()` (git status),
 * the memoised system-prompt sections, the date the last turn saw — and keeps
 * it for the whole conversation. That is what makes consecutive requests
 * share a byte-identical prefix, and it is measured to hold on the resident
 * path too, within one session.
 *
 * A resident's ACP child serves many sessions. `activateAcpSessionWorkspace`
 * must drop those memos when it switches session (issue #44: otherwise one
 * workspace's context leaks into another's prompt), so coming BACK to a
 * session recomputed all of it. Whatever had changed in between — a CLAUDE.md
 * edit, the git status, the date — rewrote the head of that session's prompt:
 * `input[0]` or, for the git status, the instructions and with them the
 * prompt-cache key. A replaced child (deploy, hot switch) recomputed it too,
 * on resume.
 *
 * ## What this does
 *
 * hermes' rule: build a session's prompt context once and reuse it verbatim
 * (`agent/conversation_loop.py` `_restore_or_build_system_prompt`), rebuild
 * only on compaction. Here:
 *
 * - on a switch, the outgoing session's memos are kept in memory and the
 *   incoming session's are put back (`saveOnSwitch` / `restoreOnSwitch`);
 * - after every workspace turn the active session's resolved context is
 *   written to `<projectDir>/<sessionId>/prompt-context.json` (0600), together
 *   with its pinned cache keys (CH-3), and read back the first time a new
 *   process activates that session.
 *
 * Compaction still refreshes it: the base's `postCompactCleanup` clears the
 * same memos, the next turn recomputes them, and the turn-end write records
 * the new values.
 *
 * The system-prompt sections are kept in memory only. They are a function of
 * the process's model and settings (the environment section names the
 * model), which a replaced child may have changed; recomputing them on resume
 * is what the base does and gives the same bytes when nothing changed.
 *
 * `QIANMO_PROMPT_CONTEXT_SNAPSHOT=0` turns all of this off — today's
 * recompute-on-switch behaviour.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  getLastEmittedDate,
  getOriginalCwd,
  getSessionId,
  getSystemPromptSectionCache,
  isSessionPersistenceDisabled,
  setCachedClaudeMdContent,
  setLastEmittedDate,
  setSystemPromptSectionCacheEntry,
} from '../../../bootstrap/state.js'
import { getSystemContext, getUserContext } from '../../../context.js'
import {
  isEnvDefinedFalsy,
  isEnvTruthy,
} from '../../../utils/config/envUtils.js'
import { getSettings_DEPRECATED } from '../../../utils/settings/settings.js'
import { getNodeEnv, getTranscriptPath } from '../../../utils/sessionStorage.js'
import { logForDebugging } from '../../../utils/telemetry/debug.js'
import {
  getPinnedPromptCacheKeys,
  restorePinnedPromptCacheKeys,
} from './sessionCacheKey.js'

type ContextValues = { [k: string]: string }

/** What a live process keeps for a session it switched away from. */
type LiveSnapshot = {
  /** The workspace it was computed for; a session reopened elsewhere starts fresh. */
  readonly cwd: string
  readonly userContext: Promise<ContextValues> | undefined
  readonly systemContext: Promise<ContextValues> | undefined
  readonly sections: ReadonlyArray<readonly [string, string | null]>
  readonly lastEmittedDate: string | null
}

/** The on-disk form, written after each turn and read on resume. */
type PromptContextSidecar = {
  readonly format: 1
  readonly sessionId: string
  readonly cwd: string
  readonly userContext?: ContextValues
  readonly systemContext?: ContextValues
  readonly lastEmittedDate: string | null
  readonly cacheKeys: Record<string, string>
}

export const PROMPT_CONTEXT_SIDECAR_NAME = 'prompt-context.json'

/** Sessions whose live snapshot is kept in memory; older ones fall back to disk. */
const MAX_LIVE_SNAPSHOTS = 64

const live = new Map<string, LiveSnapshot>()
/** Sessions this process has activated — the only ids worth snapshotting. */
const activated = new Set<string>()
/** Last sidecar body written per session, so an unchanged turn writes nothing. */
const lastWritten = new Map<string, string>()

function isPromptContextSnapshotEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.QIANMO_PROMPT_CONTEXT_SNAPSHOT)
}

/** The memoised value, if the memo holds one; never computes. */
function memoValue(memo: {
  cache: { has(key: unknown): boolean; get(key: unknown): unknown }
}): Promise<ContextValues> | undefined {
  return memo.cache.has(undefined)
    ? (memo.cache.get(undefined) as Promise<ContextValues>)
    : undefined
}

/**
 * The transcript writer's own "keep nothing on disk" conditions
 * (`transcriptWriter.ts` `shouldSkipPersistence`): a sidecar is part of the
 * session's on-disk record and follows the same rule.
 */
function persistenceDisabled(): boolean {
  return (
    (getNodeEnv() === 'test' &&
      !isEnvTruthy(process.env.TEST_ENABLE_SESSION_PERSISTENCE)) ||
    getSettings_DEPRECATED()?.cleanupPeriodDays === 0 ||
    isSessionPersistenceDisabled() ||
    isEnvTruthy(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY)
  )
}

function sidecarPath(sessionId: string): string {
  return join(
    dirname(getTranscriptPath()),
    sessionId,
    PROMPT_CONTEXT_SIDECAR_NAME,
  )
}

function sameCwd(a: string, b: string): boolean {
  return a.normalize('NFC') === b.normalize('NFC')
}

/**
 * Record that `sessionId` is an ACP session this process serves. Called on
 * every activation, before the switch check, so the first session of a
 * process counts even when it reuses the bootstrap session id.
 */
export function notePromptContextSession(sessionId: string): void {
  activated.add(sessionId)
}

/**
 * Keep the outgoing session's memos before the switch clears them. Must run
 * while they are still the outgoing session's — i.e. before any reset.
 */
export function saveOnSwitch(outgoingSessionId: string): void {
  if (!isPromptContextSnapshotEnabled()) return
  if (!activated.has(outgoingSessionId)) return
  const snapshot: LiveSnapshot = {
    cwd: getOriginalCwd(),
    userContext: memoValue(getUserContext),
    systemContext: memoValue(getSystemContext),
    sections: [...getSystemPromptSectionCache().entries()],
    lastEmittedDate: getLastEmittedDate(),
  }
  if (
    snapshot.userContext === undefined &&
    snapshot.systemContext === undefined &&
    snapshot.sections.length === 0
  ) {
    return
  }
  live.delete(outgoingSessionId)
  live.set(outgoingSessionId, snapshot)
  while (live.size > MAX_LIVE_SNAPSHOTS) {
    const oldest = live.keys().next().value
    if (oldest === undefined) break
    live.delete(oldest)
  }
}

function applyUserContext(values: Promise<ContextValues>): void {
  getUserContext.cache.set(undefined, values)
  // `getUserContext` publishes CLAUDE.md for the auto-mode classifier as a
  // side effect of computing; a restored value has to do the same.
  values.then(
    v => setCachedClaudeMdContent(v.claudeMd ?? null),
    () => {},
  )
}

/**
 * Put back the incoming session's context after the switch cleared the
 * memos. From memory when this process has served the session before, else
 * from its sidecar. A session with neither starts fresh — including a fresh
 * date record, so the date-change notice is per session, not per process.
 *
 * Synchronous on purpose: `activateAcpSessionWorkspace` is.
 */
export function restoreOnSwitch(sessionId: string, cwd: string): void {
  if (!isPromptContextSnapshotEnabled()) return
  const snapshot = live.get(sessionId)
  if (snapshot !== undefined && sameCwd(snapshot.cwd, cwd)) {
    if (snapshot.userContext !== undefined) {
      applyUserContext(snapshot.userContext)
    }
    if (snapshot.systemContext !== undefined) {
      getSystemContext.cache.set(undefined, snapshot.systemContext)
    }
    for (const [name, value] of snapshot.sections) {
      setSystemPromptSectionCacheEntry(name, value)
    }
    setLastEmittedDate(snapshot.lastEmittedDate)
    return
  }
  const sidecar = readSidecar(sessionId, cwd)
  if (sidecar === undefined) {
    setLastEmittedDate(null)
    return
  }
  if (sidecar.userContext !== undefined) {
    applyUserContext(Promise.resolve(sidecar.userContext))
  }
  if (sidecar.systemContext !== undefined) {
    getSystemContext.cache.set(
      undefined,
      Promise.resolve(sidecar.systemContext),
    )
  }
  setLastEmittedDate(sidecar.lastEmittedDate)
  restorePinnedPromptCacheKeys(sessionId, sidecar.cacheKeys)
  lastWritten.set(sessionId, JSON.stringify(sidecar))
}

function isContextValues(value: unknown): value is ContextValues {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(v => typeof v === 'string')
  )
}

/** Parse and validate a sidecar body; anything off is treated as absent. */
export function parsePromptContextSidecar(
  body: string,
  expected: { sessionId: string; cwd: string },
): PromptContextSidecar | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const r = parsed as Record<string, unknown>
  if (r.format !== 1) return undefined
  if (r.sessionId !== expected.sessionId) return undefined
  if (typeof r.cwd !== 'string' || !sameCwd(r.cwd, expected.cwd)) {
    return undefined
  }
  if (r.userContext !== undefined && !isContextValues(r.userContext)) {
    return undefined
  }
  if (r.systemContext !== undefined && !isContextValues(r.systemContext)) {
    return undefined
  }
  if (r.lastEmittedDate !== null && typeof r.lastEmittedDate !== 'string') {
    return undefined
  }
  if (!isContextValues(r.cacheKeys)) return undefined
  return {
    format: 1,
    sessionId: r.sessionId,
    cwd: r.cwd,
    ...(r.userContext !== undefined && { userContext: r.userContext }),
    ...(r.systemContext !== undefined && { systemContext: r.systemContext }),
    lastEmittedDate: r.lastEmittedDate,
    cacheKeys: r.cacheKeys,
  }
}

function readSidecar(
  sessionId: string,
  cwd: string,
): PromptContextSidecar | undefined {
  let body: string
  try {
    body = readFileSync(sidecarPath(sessionId), 'utf8')
  } catch {
    return undefined
  }
  return parsePromptContextSidecar(body, { sessionId, cwd })
}

/**
 * Write the active session's resolved context to its sidecar. Called at the
 * end of every workspace turn; best effort — a failure costs the next resume
 * its byte-identical prefix, never the turn.
 *
 * Everything that identifies the session is read synchronously first, so a
 * later switch cannot redirect the write.
 */
export async function persistActivePromptContext(): Promise<void> {
  if (!isPromptContextSnapshotEnabled() || persistenceDisabled()) return
  const sessionId = getSessionId()
  if (!activated.has(sessionId)) return
  const userContext = memoValue(getUserContext)
  const systemContext = memoValue(getSystemContext)
  if (userContext === undefined && systemContext === undefined) return
  const cwd = getOriginalCwd()
  const lastEmittedDate = getLastEmittedDate()
  const cacheKeys = getPinnedPromptCacheKeys(sessionId)
  let path: string
  try {
    path = sidecarPath(sessionId)
  } catch (error) {
    logForDebugging(`[promptCache] no sidecar path for ${sessionId}: ${error}`)
    return
  }
  try {
    const [user, system] = await Promise.all([userContext, systemContext])
    const sidecar: PromptContextSidecar = {
      format: 1,
      sessionId,
      cwd,
      ...(user !== undefined && { userContext: user }),
      ...(system !== undefined && { systemContext: system }),
      lastEmittedDate,
      cacheKeys,
    }
    const body = JSON.stringify(sidecar)
    if (lastWritten.get(sessionId) === body) return
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, body, { mode: 0o600 })
    renameSync(tmp, path)
    lastWritten.set(sessionId, body)
  } catch (error) {
    logForDebugging(
      `[promptCache] prompt-context sidecar not written for ${sessionId}: ${error}`,
    )
  }
}

/** Test seam. */
export function resetPromptContextSnapshotsForTesting(): void {
  live.clear()
  activated.clear()
  lastWritten.clear()
}
