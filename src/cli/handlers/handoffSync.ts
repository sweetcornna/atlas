// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One sync — shadow commit, session commits, local anti-GC refs, one atomic
 * push — and the debounce around it (P17.4 `qm handoff sync`).
 *
 * ## One sync
 *
 * 1. `shadowCommit` of the work tree (`@qianmo/handoff`: never touches the
 *    user's HEAD, index, stash or files; a secret in a changed file refuses
 *    the whole sync). A detached HEAD is refused (ruling 9): the shadow has no
 *    branch to be named after, and the cloud side would have nothing to
 *    continue on.
 * 2. Each session's checked prefix becomes a session commit, secrets redacted
 *    (ruling 5); its parent is the commit the local session ref points at,
 *    and an unchanged transcript reuses that commit instead of growing one.
 * 3. `refs/qianmo/local/<device>/{wip,sessions}/…` move to the new commits
 *    (ruling 8), so `git gc` keeps them and the next session commit has its
 *    parent.
 * 4. One atomic push of `refs/qianmo/wip/<device>/<branch>` and every
 *    `refs/qianmo/sessions/<device>/<session>` (`handoffHub.ts`).
 *
 * ## Debounce, trailing edge (probe 第 7 项第 4 条)
 *
 * A hook does not sync by itself. It writes what it checked into
 * `state/<root>/pending/<tool>-<session>.json` — the file and how many of its
 * bytes are complete — and then tries the repository's sync lock:
 *
 * - **lock taken**: it is the drainer. If the last sync ended less than 5 s
 *   ago it waits out the rest, then takes every pending entry and syncs them
 *   in one go, and repeats until nothing is pending. After releasing the lock
 *   it looks once more, and drains again if something arrived meanwhile.
 * - **lock held**: it exits at once; the holder will see the entry.
 *
 * A writer writes before it tries the lock, and the holder looks after it
 * releases, so a request is never left behind with nobody to drain it — the
 * last turn of a burst is always synced. Pending entries are per session, so a
 * burst of turns in one session collapses to its latest.
 *
 * A sync that fails (hub unreachable, push refused) puts its entries back
 * ({@link restorePending}) unless a newer one for the same session arrived
 * meanwhile, and stops draining: the next hook, `sync` or `now` carries them.
 *
 * `now` and a manual `sync` take the same lock (waiting for it), so they never
 * race a hook's push.
 */

import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  type HandoffTool,
  HandoffGitError,
  MAX_CHANGED_FILE_BYTES,
  OversizedFileError,
  SecretFoundError,
  type SessionRedactions,
  sessionCommit,
  sessionRef,
  shadowCommit,
  tryExclusiveLock,
  wipRef,
  type ExclusiveLock,
} from '@qianmo/handoff'
import {
  hubConnection,
  localRef,
  pushToHub,
  type RefUpdate,
  updateLocalRefs,
} from './handoffHub.js'
import {
  appendSyncLog,
  type HandoffProject,
  HandoffUserError,
  readJsonFile,
  sleep,
  stateDir,
  writeJsonFile,
} from './handoffStore.js'

/** The plan card's 5 s. */
const SYNC_DEBOUNCE_MS = 5_000

/** A transcript prefix that has been checked complete. */
export interface SessionSnapshot {
  readonly tool: HandoffTool
  readonly sessionId: string
  readonly file: string
  readonly content: Buffer
}

interface SyncedSession {
  readonly sessionId: string
  readonly ref: string
  readonly commit: string
  readonly reused: boolean
  readonly redactions: SessionRedactions | null
}

interface SyncResult {
  readonly branch: string
  readonly head: string | null
  readonly wip: string
  readonly wipRef: string
  readonly tree: string
  readonly sessions: readonly SyncedSession[]
  /** Untracked files the secret-path patterns kept out of the shadow. */
  readonly excluded: readonly string[]
}

function localWipRef(device: string, branch: string): string {
  return `refs/qianmo/local/${device}/wip/${branch}`
}

function localSessionRef(device: string, sessionId: string): string {
  return `refs/qianmo/local/${device}/sessions/${sessionId}`
}

/** Why a sync could not happen, in a sentence for the person or the log. */
export function syncFailureReason(error: unknown): string {
  if (error instanceof HandoffUserError) return error.message
  if (error instanceof SecretFoundError) {
    return `改动的文件里疑似有密钥，影子提交被拒、不推送：${error.findings
      .map(f => `${f.path}（${f.matches.map(m => m.ruleId).join('、')}）`)
      .join('；')}`
  }
  if (error instanceof OversizedFileError) {
    return `改动的文件超过 ${MAX_CHANGED_FILE_BYTES / 1024 / 1024} MiB，影子提交被拒：${error.files
      .map(f => f.path)
      .join('；')}（加进 .gitignore 或提交它们）`
  }
  if (error instanceof HandoffGitError) return error.message
  return error instanceof Error ? error.message : String(error)
}

/**
 * One sync of `project` with `sessions`. Throws on any failure: nothing is
 * partly pushed (the push is atomic), though local objects may remain.
 */
export async function syncOnce(
  project: HandoffProject,
  sessions: readonly SessionSnapshot[],
): Promise<SyncResult> {
  const conn = hubConnection(project)
  const shadow = await shadowCommit({ cwd: project.root })
  if (shadow.branch === null) {
    throw new HandoffUserError(
      '当前是 detached HEAD，不能转交：先建一个分支（git switch -c <分支名>）再试',
    )
  }
  const branch = shadow.branch
  const synced: SyncedSession[] = []
  for (const session of sessions) {
    const parent = await localRef(
      project.root,
      localSessionRef(project.device, session.sessionId),
    )
    const commit = await sessionCommit({
      cwd: project.root,
      file: session.file,
      content: session.content,
      redact: true,
      ...(parent === undefined ? {} : { parent }),
    })
    synced.push({
      sessionId: session.sessionId,
      ref: sessionRef(project.device, session.sessionId),
      commit: commit.commit,
      reused: commit.reused,
      redactions: commit.redactions,
    })
  }
  const pushed: RefUpdate[] = [
    { ref: wipRef(project.device, branch), sha: shadow.commit },
    ...synced.map(session => ({ ref: session.ref, sha: session.commit })),
  ]
  await updateLocalRefs(project.root, [
    { ref: localWipRef(project.device, branch), sha: shadow.commit },
    ...synced.map(session => ({
      ref: localSessionRef(project.device, session.sessionId),
      sha: session.commit,
    })),
  ])
  await pushToHub(conn, project.root, pushed)
  return {
    branch,
    head: shadow.head,
    wip: shadow.commit,
    wipRef: wipRef(project.device, branch),
    tree: shadow.tree,
    sessions: synced,
    excluded: shadow.excluded,
  }
}

/** The log line for a finished sync: refs, hashes and counts, nothing else. */
export function logSync(
  project: HandoffProject,
  trigger: string,
  outcome: SyncResult | { readonly error: unknown },
): void {
  if ('error' in outcome) {
    appendSyncLog({
      event: 'sync',
      trigger,
      root: project.root,
      ok: false,
      reason: syncFailureReason(outcome.error),
    })
    return
  }
  appendSyncLog({
    event: 'sync',
    trigger,
    root: project.root,
    ok: true,
    wipRef: outcome.wipRef,
    wip: outcome.wip,
    sessions: outcome.sessions.map(session => ({
      ref: session.ref,
      commit: session.commit,
      reused: session.reused,
      redacted: session.redactions?.count ?? 0,
      rules: session.redactions?.ruleIds ?? [],
    })),
    excluded: outcome.excluded.length,
  })
}

// ─── Lock, pending, last ─────────────────────────────────────────────

function syncLockPath(root: string): string {
  return join(stateDir(root), 'sync.lock')
}

function pendingDir(root: string): string {
  return join(stateDir(root), 'pending')
}

function lastPath(root: string): string {
  return join(stateDir(root), 'last.json')
}

/** What a hook checked and leaves for the drainer. */
interface PendingSync {
  readonly tool: HandoffTool
  readonly sessionId: string
  readonly file: string
  /** Bytes of `file` checked complete. */
  readonly length: number
}

function pendingName(entry: Pick<PendingSync, 'tool' | 'sessionId'>): string {
  return `${entry.tool}-${entry.sessionId}.json`
}

/** Leave `entry` for the drainer, replacing an older one for the same session. */
export function writePending(root: string, entry: PendingSync): void {
  const dir = pendingDir(root)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeJsonFile(join(dir, pendingName(entry)), entry)
}

function pendingNames(root: string): string[] {
  try {
    return readdirSync(pendingDir(root)).filter(name => name.endsWith('.json'))
  } catch {
    return []
  }
}

function isPending(value: unknown): value is PendingSync {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    (entry.tool === 'qmcode' || entry.tool === 'claude-code') &&
    typeof entry.sessionId === 'string' &&
    typeof entry.file === 'string' &&
    typeof entry.length === 'number' &&
    Number.isSafeInteger(entry.length) &&
    entry.length > 0
  )
}

/** Every pending entry, removed as it is taken. */
export function takePending(root: string): PendingSync[] {
  const taken: PendingSync[] = []
  for (const name of pendingNames(root)) {
    const path = join(pendingDir(root), name)
    // Renamed before it is read: a hook replacing the same session's entry
    // meanwhile writes a new file rather than having its write deleted.
    const claimed = `${path}.${process.pid}.taking`
    try {
      renameSync(path, claimed)
    } catch {
      continue
    }
    try {
      const value = JSON.parse(readFileSync(claimed, 'utf8'))
      if (isPending(value)) taken.push(value)
    } catch {
    } finally {
      try {
        unlinkSync(claimed)
      } catch {}
    }
  }
  return taken
}

/**
 * Put back entries a failed sync had taken, so the next sync or `now` carries
 * them. An entry is put back only where no entry for the same session exists
 * now: one written meanwhile by a later hook is newer, and wins. The write
 * cannot clobber it either — the entry goes to a temporary file that is then
 * hard-linked into place, which fails if the name is already taken.
 */
export function restorePending(
  root: string,
  entries: readonly PendingSync[],
): void {
  if (entries.length === 0) return
  const dir = pendingDir(root)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const entry of entries) {
    const path = join(dir, pendingName(entry))
    const temp = `${path}.${process.pid}.restore`
    try {
      writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`, {
        mode: 0o600,
      })
      linkSync(temp, path)
    } catch {
      // EEXIST: a newer entry is there. Anything else: the entry is lost and
      // the next hook for that session writes a fresh one.
    } finally {
      try {
        unlinkSync(temp)
      } catch {}
    }
  }
}

/** The checked prefix of a pending entry, or `null` when the file no longer has it. */
function snapshotOf(entry: PendingSync): SessionSnapshot | null {
  let content: Buffer
  try {
    content = readFileSync(entry.file)
  } catch {
    return null
  }
  if (content.length < entry.length) return null
  return {
    tool: entry.tool,
    sessionId: entry.sessionId,
    file: entry.file,
    content: content.subarray(0, entry.length),
  }
}

interface LastSync {
  readonly at: number
  readonly ok: boolean
  readonly wip?: string
  readonly reason?: string
}

export function readLastSync(root: string): LastSync | undefined {
  const value = readJsonFile(lastPath(root))
  if (typeof value !== 'object' || value === null) return undefined
  const last = value as Record<string, unknown>
  if (typeof last.at !== 'number' || typeof last.ok !== 'boolean') {
    return undefined
  }
  return {
    at: last.at,
    ok: last.ok,
    ...(typeof last.wip === 'string' ? { wip: last.wip } : {}),
    ...(typeof last.reason === 'string' ? { reason: last.reason } : {}),
  }
}

export function writeLastSync(root: string, last: LastSync): void {
  writeJsonFile(lastPath(root), last)
}

export function pendingCount(root: string): number {
  return pendingNames(root).length
}

/**
 * Take the repository's sync lock, waiting up to `timeoutMs` for a hook that
 * is in the middle of a sync.
 */
export async function waitForSyncLock(
  root: string,
  timeoutMs = 120_000,
): Promise<ExclusiveLock> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const lock = tryExclusiveLock(syncLockPath(root))
    if (lock !== null) return lock
    if (Date.now() >= deadline) {
      throw new HandoffUserError(
        `另一个同步一直没结束（${syncLockPath(root)}）；稍后再试`,
      )
    }
    await sleep(50)
  }
}

/** Snapshots for every pending entry, the session `first` names taking its place. */
export function mergeSnapshots(
  first: SessionSnapshot | null,
  pending: readonly PendingSync[],
): SessionSnapshot[] {
  const out: SessionSnapshot[] = first === null ? [] : [first]
  for (const entry of pending) {
    if (out.some(session => session.sessionId === entry.sessionId)) continue
    const snapshot = snapshotOf(entry)
    if (snapshot === null) {
      appendSyncLog({
        event: 'skip',
        sessionId: entry.sessionId,
        reason: 'transcript shorter than the checked prefix',
      })
      continue
    }
    out.push(snapshot)
  }
  return out
}

interface DrainOptions {
  readonly debounceMs?: number
  readonly trigger: string
  readonly now?: () => number
}

/**
 * Drain the repository's pending entries if this process can take the sync
 * lock; return at once if another process holds it (see the module note).
 */
export async function drainPending(
  project: HandoffProject,
  options: DrainOptions,
): Promise<void> {
  const now = options.now ?? Date.now
  const debounceMs = options.debounceMs ?? SYNC_DEBOUNCE_MS
  for (;;) {
    const lock = tryExclusiveLock(syncLockPath(project.root))
    if (lock === null) return
    let failed = false
    try {
      // Waits only while something is pending: a hook whose own entry was
      // just synced leaves at once instead of sitting out another 5 s.
      while (!failed && pendingCount(project.root) > 0) {
        const last = readLastSync(project.root)
        const wait = last === undefined ? 0 : last.at + debounceMs - now()
        if (wait > 0) await sleep(Math.min(wait, debounceMs))
        const batch = takePending(project.root)
        if (batch.length === 0) break
        const sessions = mergeSnapshots(null, batch)
        try {
          const result = await syncOnce(project, sessions)
          writeLastSync(project.root, { at: now(), ok: true, wip: result.wip })
          logSync(project, options.trigger, result)
        } catch (error) {
          // Kept for the next sync or `now`, which carry whatever is pending.
          restorePending(project.root, batch)
          writeLastSync(project.root, {
            at: now(),
            ok: false,
            reason: syncFailureReason(error),
          })
          logSync(project, options.trigger, { error })
          failed = true
        }
      }
    } finally {
      lock.release()
    }
    // After a failure the entries wait for the next hook, sync or `now`:
    // retrying at once against a hub that just failed would only spin.
    if (failed || pendingCount(project.root) === 0) return
  }
}
