// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the two conversation surfaces share: the legacy chat routes
 * (`routes/chat.ts`) and the conversation front (`routes/front.ts`).
 *
 * The one gate every transcript passes (D6, {@link noteTranscriptRead}), the
 * answer to a session a member may not see, the roster lookup and the figure
 * lookup. Kept apart from both route files so neither imports the other.
 */

import type { ActionLedgerPort, ChatPort, ChatTarget, ConsoleFailure } from '../deps.js'
import { agentAvatarKey, type AvatarKey } from '../avatar.js'
import type { ChatFaces } from '../view/chat.js'
import { type Faces, facesFor } from './avatars.js'
import type { RouteContext } from './types.js'

/**
 * The one answer to a session a member may not see, whether it belongs to
 * somebody else or does not exist at all — the host's own wording for the
 * second case, so the two cannot be told apart (`tenancy-m1.md` §3.2).
 */
const CHAT_SESSION_NOT_FOUND = '这条会话不在本控制台的记录里'

/**
 * The failure a member gets for a session it may not see, in place of any
 * port call: the same `not_found` the port gives for one that does not exist.
 */
export const HIDDEN_SESSION: ConsoleFailure = {
  code: 'not_found',
  message: CHAT_SESSION_NOT_FOUND,
}

/**
 * What stands where a conversation would have opened while the action ledger
 * cannot take the reading (P15.9). `rejected` because it is this side that
 * will not let the transcript out — the far node was never asked. The
 * remedy named is the one a refused write is told (`http.ts`,
 * `LEDGER_CLOSED`).
 */
export const LEDGER_CLOSED_FAILURE: ConsoleFailure = {
  code: 'rejected',
  message: '动作账本停用，暂时不能打开对话；恢复动作账本之后再试。',
}


/**
 * The roster the chat views annotate themselves with.
 *
 * A failed lookup is `null`, not an empty list: "the registry says this agent
 * is gone" and "nobody could ask the registry" are different facts and the view
 * renders them differently (`view/chat.ts`, `targetState`).
 */
export async function chatTargets(
  chat: ChatPort,
): Promise<readonly ChatTarget[] | null> {
  const result = await chat.targets()
  return result.ok ? result.value : null
}

/** Looks up the figures one render draws (`routes/avatars.ts`). */
export type FaceLookup = (keys: readonly AvatarKey[]) => Promise<Faces>

export function chatFaces(faces: Faces): ChatFaces {
  return {
    agent: address => faces.spec(agentAvatarKey(address)),
    self: faces.spec(faces.self),
    selfKey: faces.self,
    editable: faces.editable,
  }
}

export function lookFaces(ctx: RouteContext): FaceLookup {
  return keys => facesFor(ctx, keys)
}


// --- readings (P15.9, D6) ----------------------------------------------------

/**
 * How long one recorded reading covers the same person re-reading the same
 * conversation without a word from the page that it is an opening — the
 * poller, a stream event, a script that leaves `?open=1` off.
 */
const READ_WINDOW_MS = 30 * 60 * 1000

/** Pairs the window remembers before it forgets the least recently used. */
const MAX_READ_WINDOW_ENTRIES = 4096

/**
 * When each (person, conversation) last had a reading written down.
 *
 * In memory and bounded: a restart, or a pair pushed out by four thousand
 * others, costs one more line on the next poll — never a read without one.
 * Insertion order is the recency order; a lookup moves the pair to the end
 * without changing when it was recorded, so the window is "since the last
 * line", not "since the last poll", and an open page writes a line every half
 * hour rather than once for ever.
 */
class ReadWindow {
  readonly #recordedAt = new Map<string, number>()

  covers(key: string, now: number): boolean {
    const at = this.#recordedAt.get(key)
    if (at === undefined) return false
    this.#recordedAt.delete(key)
    this.#recordedAt.set(key, at)
    return now - at < READ_WINDOW_MS
  }

  note(key: string, now: number): void {
    this.#recordedAt.delete(key)
    this.#recordedAt.set(key, now)
    for (const oldest of this.#recordedAt.keys()) {
      if (this.#recordedAt.size <= MAX_READ_WINDOW_ENTRIES) break
      this.#recordedAt.delete(oldest)
    }
  }
}

/**
 * One window per ledger, so two consoles in one process — every test suite —
 * never answer for each other. A console with no ledger has nothing to cover.
 */
const READ_WINDOWS = new WeakMap<ActionLedgerPort, ReadWindow>()

function readWindowOf(ledger: ActionLedgerPort | undefined): ReadWindow | null {
  if (ledger === undefined) return null
  let window = READ_WINDOWS.get(ledger)
  if (window === undefined) {
    window = new ReadWindow()
    READ_WINDOWS.set(ledger, window)
  }
  return window
}

/** A reading the ledger let through; `done` once the transcript was fetched. */
export interface TranscriptReading {
  done(loaded: boolean): Promise<void>
}

/**
 * The one gate in front of every path that hands out a transcript (D6).
 *
 * - `explicitOpen` (the JSON read, the page with `?session=`, the fragment with
 *   `?open=1`): `admit` first, and one line once the transcript loaded.
 * - Otherwise (the poll): if this person had a reading of this conversation
 *   written down in the last {@link READ_WINDOW_MS}, it is covered and goes
 *   ahead unrecorded; if not, it is an opening like any other. Leaving
 *   `?open=1` off therefore never makes a read invisible — it only spares the
 *   ledger a line per refresh — and "one opening and a hundred polls" is still
 *   one line, because the opening starts the window. Only a line the ledger
 *   took starts it: a failed write leaves the next poll to ask again.
 *
 * Refused, the answer is the 503 the ledger's `admit` produced; the caller
 * decides how a refusal looks on its own surface. Only for a conversation the
 * caller may see: a hidden one is answered without a read and never gets here.
 */
export async function noteTranscriptRead(
  ctx: RouteContext,
  sessionId: string,
  explicitOpen: boolean,
): Promise<TranscriptReading | Response> {
  const window = readWindowOf(ctx.deps.actions)
  const key = `${ctx.access.principal?.subject ?? 'anonymous'}|${sessionId}`
  if (!explicitOpen && window?.covers(key, ctx.now) === true) {
    return { done: () => Promise.resolve() }
  }
  const blocked = await ctx.admit()
  if (blocked !== null) return blocked
  return {
    async done(loaded) {
      if (!loaded) return
      // Only a line that is in the ledger covers the polls after it: a write
      // that failed has closed the ledger, and the next poll must ask again.
      if (await ctx.record('chat.transcript.open', sessionId, 'ok')) {
        window?.note(key, ctx.now)
      }
    },
  }
}

