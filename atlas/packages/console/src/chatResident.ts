// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 常驻会话 — a person's one conversation with each agent (P37.17,
 * `docs/dev/console.md` §6.1).
 *
 * Work's side list draws every agent once, and an agent's row is one
 * conversation that stays: not a new session each time somebody says hello.
 * Which session that is, is decided here and nowhere else.
 *
 * ## What makes a session resident
 *
 * Two facts, each kept where it already lives:
 *
 * - the session record says `resident` (`ChatSession.resident`), written once
 *   when `POST /v0/chat/sessions` opened it — the one way a person opens a
 *   conversation with an agent. Schedules, IM channels, questions between
 *   agents and background tasks open theirs through `ChatDispatch.open` and
 *   never carry it;
 * - the account book says whose it is (`chat.owned`), the same record every
 *   other ownership rule reads (`accountsHttp.ts`, `chatScopeOf`). A legacy
 *   token, or a console without personal accounts, owns nothing: its resident
 *   sessions are the ones without an owner.
 *
 * So the key is the reader's account × the agent's address. Should two ever
 * carry it for one key (a crash between opening and the owner record, a
 * second console process on the same files), the one opened first is the
 * resident one, and the other is just another conversation.
 *
 * ## Why a mark and not "the latest session with that agent"
 *
 * Nothing in the sessions written before this says what kind they are: a
 * schedule's dedicated session, an IM group's, a sub-agent's worker and a
 * person's own conversation look the same. Picking the latest would sooner
 * or later pick a group chat's context and put a person's private lines into
 * it, and that cannot be taken back once sent. The latest also moves: a late
 * reply to an old conversation would make it the agent's row. A mark written
 * once does neither, and an older console reading the same file ignores it.
 */

import type { Access, ConsoleAccounts } from './access.js'
import { chatScopeOf } from './accountsHttp.js'
import type { AccountSubject } from './contracts.js'
import type { ChatSession } from './deps.js'

/** Whose resident sessions a reader holds, and how to tell whose one is. */
interface ResidentOwner {
  /** The reader's account; `null` for a legacy token or no accounts. */
  readonly opener: AccountSubject | null
  readonly ownerOf: (sessionId: string) => AccountSubject | null
}

/**
 * The reader as an owner of resident sessions; `null` when that cannot be
 * known — the account book is unavailable, and with it every owner, so no
 * session can be said to be the reader's (`AccountBook.ownerOf` answers
 * `null` for everything then, which would make everyone's look unowned).
 */
export function residentOwnerOf(
  access: Access,
  accounts: ConsoleAccounts | undefined,
): ResidentOwner | null {
  const opener = chatScopeOf(access, accounts).opener
  if (accounts === undefined) return { opener, ownerOf: () => null }
  if (accounts.book.problem !== null) return null
  return { opener, ownerOf: id => accounts.book.ownerOf(id) }
}

/**
 * The reader's resident session with each agent they have one with, by the
 * agent's address: of the sessions given that carry the mark and are the
 * reader's, the first opened.
 */
export function residentSessions(
  sessions: readonly ChatSession[],
  owner: ResidentOwner | null,
): ReadonlyMap<string, ChatSession> {
  const out = new Map<string, ChatSession>()
  if (owner === null) return out
  for (const session of sessions) {
    if (session.resident !== true) continue
    if (owner.ownerOf(session.id) !== owner.opener) continue
    const held = out.get(session.target)
    if (
      held === undefined ||
      session.createdAt < held.createdAt ||
      (session.createdAt === held.createdAt && session.id < held.id)
    ) {
      out.set(session.target, session)
    }
  }
  return out
}

/** Resolutions on their way, by reader and agent. */
const resolving = new Map<string, Promise<void>>()

/**
 * Run `work` after every earlier one under the same key has finished: two
 * tabs, or quick entry and the main window, asking for the same agent at the
 * same moment would otherwise both find nothing and both open one. Only
 * ordered, never shared: each caller looks again with its own port once its
 * turn comes, so two consoles in one process cannot hand each other a
 * session.
 */
export async function oneAtATime<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const before = resolving.get(key) ?? Promise.resolve()
  const { promise: done, resolve: finish } = Promise.withResolvers<void>()
  const queued = before.then(() => done)
  resolving.set(key, queued)
  try {
    await before
    return await work()
  } finally {
    finish()
    if (resolving.get(key) === queued) resolving.delete(key)
  }
}
