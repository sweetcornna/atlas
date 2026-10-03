// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Making one ACP session's workspace the process-wide active one.
 *
 * The agent runtime keeps a single set of "current session" globals — session
 * id, session project dir, original cwd, the transcript writer's file latch,
 * and a family of caches memoised "for this conversation". A REPL process has
 * exactly one conversation for its whole life, so those globals ARE the
 * session and nobody ever had to re-establish them.
 *
 * An ACP process does not. `session/new` may be called once per workspace —
 * a Qianmo resident node opens one session per `--agent`, each in its own
 * directory — and then turns arrive for those sessions in any order. Before
 * this function existed each of those globals was written at a different
 * moment and never re-established, so a multi-session process described a
 * mixture of workspaces (issue #44):
 *
 *   • `originalCwd` was written by `createSession` and by nothing else, so the
 *     LAST session created owned the permission working-directory set
 *     (`allWorkingDirectories()`), the memory dir and the transcript project
 *     dir — for every session, including the ones in other directories.
 *   • the system-prompt section cache is keyed by section name alone, so the
 *     FIRST session to run a turn owned `env_info_simple`: every later session
 *     was told, in its own system prompt, that it was working in the first
 *     session's directory. That is the wrong cwd the node reported.
 *   • the transcript writer latches its file path on first write and only
 *     `resetSessionFilePointer()` unlatches it — which no ACP path called, so
 *     every session's transcript appended to the first session's file.
 *
 * Hence one function, called from every entry point that makes a session
 * current (`createSession`, `getOrCreateSession`, `prompt`), that
 * re-establishes all of it together. A new call site that switches sessions
 * without going through here re-opens the same class of bug.
 */
import { realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  getSessionId,
  setOriginalCwd,
  switchSession,
} from '../../../bootstrap/state.js'
import { clearSystemPromptSections } from '../../../constants/systemPromptSections.js'
import { resetWorkspaceScopedContext } from '../../../context.js'
import {
  notePromptContextSession,
  persistActivePromptContext,
  restoreOnSwitch,
  saveOnSwitch,
} from '../../qianmo/promptCache/sessionPromptContext.js'
import type { SessionId } from '../../../types/ids.js'
import {
  canonicalizePath,
  findProjectDir,
  getProjectDir,
  resolveSessionFilePath,
} from '../../../utils/session/sessionStoragePortable.js'
import {
  clearSessionMetadata,
  resetSessionFilePointer,
} from '../../../utils/sessionStorage.js'

/**
 * The project directory a session's transcript belongs in, derived from the
 * session's OWN cwd.
 *
 * `switchSession(id, null)` means "derive the path from originalCwd at read
 * time", which is only the same answer when the process has one workspace.
 * Pinning it per session makes a session's transcript independent of whatever
 * else the process is serving.
 *
 * Keyed by the cwd's canonical form — realpath, then NFC, the cwd as given
 * (NFC) when it cannot be resolved — because that is the key every reader
 * looks under: `resolveSessionFilePath` on resume, `listSessionsImpl` for
 * `session/list`, and the interactive CLI, whose own cwd is resolved the same
 * way at startup (`getInitialState`). Keying by the cwd as given put every
 * session opened through a symlink — `/tmp` on macOS is one — where none of
 * them looked, so each resume of it started empty.
 */
export function projectDirForSessionCwd(cwd: string): string {
  return getProjectDir(canonicalSessionCwd(cwd))
}

/**
 * `canonicalizePath`, synchronously, so `projectDirForSessionCwd` keeps its
 * signature and the base call sites in `createSessionMethod.ts` and
 * `sessionLifecycle.ts` stay as they are.
 */
function canonicalSessionCwd(cwd: string): string {
  try {
    return realpathSync(cwd).normalize('NFC')
  } catch {
    return cwd.normalize('NFC')
  }
}

/**
 * Find a session's transcript for `session/load` and `session/resume`.
 *
 * The canonical key first — where {@link projectDirForSessionCwd} writes, and
 * the base's own lookup, worktree fallback included. Then, only when the cwd
 * as given differs from its canonical form, under the cwd as given: that is
 * where builds before this fix wrote a session opened through a symlink.
 *
 * What such a file gives back is the conversation since its last resume, not
 * all of it. Each resume under an older build found nothing, started empty,
 * and appended its turns to the same file as a new chain (the first message
 * of a turn with no history has no parent); loading follows the newest chain
 * only. That is the context the last older process was working with.
 */
export async function resolveAcpSessionFile(
  sessionId: string,
  cwd: string,
): ReturnType<typeof resolveSessionFilePath> {
  const found = await resolveSessionFilePath(sessionId, cwd)
  if (found) return found

  const asGiven = cwd.normalize('NFC')
  if (asGiven === (await canonicalizePath(cwd))) return undefined
  const legacyDir = await findProjectDir(asGiven)
  if (!legacyDir) return undefined
  const filePath = join(legacyDir, `${sessionId}.jsonl`)
  try {
    const { size } = await stat(filePath)
    // Zero bytes is not found, as in `resolveSessionFilePath`.
    if (size > 0) return { filePath, projectPath: asGiven, fileSize: size }
  } catch {
    // ENOENT/EACCES — not there either.
  }
  return undefined
}

/**
 * Point every process-global "current session" at `session`.
 *
 * Idempotent, and cheap when the session is already active: the caches are
 * only dropped when the active session actually changes, so consecutive turns
 * in one session keep the prompt cache they have always had.
 *
 * Dropped from the process, not lost: the outgoing session's prompt context
 * is kept and the incoming session's put back (P18.19 CH-1,
 * `sessionPromptContext.ts`), so returning to a session sends the same
 * prompt head it sent before — not one recomputed from whatever changed in
 * between.
 */
export function activateAcpSessionWorkspace(session: {
  sessionId: string
  cwd: string
  projectDir: string | null
}): void {
  const outgoing = getSessionId()
  const changed = outgoing !== session.sessionId
  notePromptContextSession(session.sessionId)
  if (changed) saveOnSwitch(outgoing)

  switchSession(session.sessionId as SessionId, session.projectDir)
  setOriginalCwd(session.cwd)

  if (!changed) return

  // The transcript file path is latched on first write; unlatch it so the
  // next write derives it from the session we just switched to.
  //
  // Not awaited, and this function is deliberately synchronous: the body of
  // `resetSessionFilePointer` only nulls the latch — it is `async` for the
  // convenience of its callers, not because it waits for anything. Awaiting
  // it would put a microtask boundary between "this turn is running" and the
  // first line of the turn, which the prompt-queueing invariants are written
  // against.
  void resetSessionFilePointer()
  // The metadata cache behind it (title, tag, last prompt) belongs to the
  // session that just went inactive. `reAppendSessionMetadata` writes it to
  // whatever file is current, so leaving it would copy one agent's most
  // recent prompt into another agent's transcript.
  clearSessionMetadata()
  // Sections memoised per conversation — `env_info_simple` (which names the
  // working directory) and `memory` among them.
  clearSystemPromptSections()
  // CLAUDE.md, git state and the directory listing: memoised with no key at
  // all, so they describe whichever workspace asked first.
  resetWorkspaceScopedContext()
  // ...then the incoming session's own, if it has run before (in this process
  // or, through its sidecar, in an earlier one).
  restoreOnSwitch(session.sessionId, session.cwd)
}

// ── The lock that makes the above safe under a concurrent client ──
//
// `activateAcpSessionWorkspace` re-establishes the process-wide workspace at
// the START of an operation and nothing re-establishes it again until the
// next one begins. That is sufficient exactly as long as operations do not
// overlap, which is what issue #52 records: two prompts in flight at once and
// the second one's activation lands in the middle of the first one's turn.
//
// ACP is JSON-RPC over stdio and a client is free to have several requests
// outstanding. The Qianmo resident never does — `NodeTurnGate` serialises at
// the node — but a general client (Zed's agent panel runs several threads,
// and `session/new` for a new thread is sent while an older thread is still
// streaming) has no reason to know it must.
//
// Two ways out. Move every global into session scope, or let only one of
// these operations own the process at a time. The first is not a bigger
// version of the same change, it is a different program: `createSession`
// alone `process.chdir()`s, calls `resetSettingsCache()` and re-applies
// settings env; a turn additionally writes the prompt id, the beta-header
// latches, the cached CLAUDE.md, the cost accumulators and the transcript
// writer's file latch. Enumerating that surface is open-ended, and each item
// missed is another silent cross-session bug of exactly the shape #44 was.
//
// So: one at a time. The cost is head-of-line blocking — `session/new` issued
// while a long turn streams waits for it — and that is the right trade against
// corrupting the running turn, which is what happens today. Concurrency WITHIN
// a session was already serialised by `session.promptRunning` + the pending
// queue, so this only extends an invariant the agent already had.
//
// The worst case of that cost is a turn parked on `session/request_permission`
// with nobody answering: it holds the lock for as long as the person takes.
// `session/cancel` is deliberately NOT gated, so the way out of it is the way
// out of any stuck turn — cancel it — and the client never has to wait on the
// lock to ask for that.
//
// Deadlock is avoided by placing the lock at the protocol entry points only —
// `newSession`, `loadSession`, `resumeSession`, `forkSession` and `prompt`,
// none of which calls another — and NOT on the internal `createSession` /
// `getOrCreateSession` helpers, which do call each other. A new entry point
// that reaches `activateAcpSessionWorkspace` must take the lock; a new
// internal helper must not.

type WorkspaceTurnWaiter = () => void

let workspaceTurnActive = false
const workspaceTurnWaiters: WorkspaceTurnWaiter[] = []

/**
 * Run `work` as the only operation owning the process-wide workspace.
 *
 * FIFO, and free of a scheduling hop when uncontended: an operation that
 * finds the lock open calls `work()` synchronously, so the single-session
 * case — every resident node, every ACP client that sends one request at a
 * time — runs exactly the interleaving it ran before this existed.
 */
export function runInAcpWorkspaceTurn<T>(work: () => Promise<T>): Promise<T> {
  if (!workspaceTurnActive) {
    workspaceTurnActive = true
    return startWorkspaceTurn(work)
  }
  return new Promise<T>((resolve, reject) => {
    workspaceTurnWaiters.push(() => {
      startWorkspaceTurn(work).then(resolve, reject)
    })
  })
}

/** True while some operation holds the workspace lock. Test seam. */
export function isAcpWorkspaceTurnActive(): boolean {
  return workspaceTurnActive
}

function startWorkspaceTurn<T>(work: () => Promise<T>): Promise<T> {
  let running: Promise<T>
  try {
    running = work()
  } catch (err) {
    // A synchronous throw out of `work` still ends this operation's turn.
    releaseWorkspaceTurn()
    return Promise.reject(err)
  }
  // The active session's prompt context goes to its sidecar before the lock
  // is released (P18.19 CH-1): a child replaced right after this turn still
  // resumes with the prompt head it sent. Best effort, never throws.
  return running.then(
    async value => {
      await persistActivePromptContext().catch(() => {})
      releaseWorkspaceTurn()
      return value
    },
    async err => {
      await persistActivePromptContext().catch(() => {})
      releaseWorkspaceTurn()
      throw err
    },
  )
}

function releaseWorkspaceTurn(): void {
  const next = workspaceTurnWaiters.shift()
  if (next) {
    // Ownership passes straight to the next waiter — `workspaceTurnActive`
    // deliberately stays true so an arrival in between cannot jump the queue.
    next()
    return
  }
  workspaceTurnActive = false
}
