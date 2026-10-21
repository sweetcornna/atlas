// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Group rules every platform shares (`runtimes-channels.md` §2.6).
 *
 * Rewritten from the owner's grantley (`src/grantley/platforms/onebot/`,
 * revision 81fbbd77 with its working tree as of 2026-10-19):
 * `router.py:378-410` (`_group_reply_allowed`: an explicit summons always
 * answers and restarts the room's cooldown, anything else waits it out;
 * keywords are case-insensitive substrings) and `rate_limit.py:152-206`
 * with `adapter.py:3426-3449` (the speech cap: at most N replies per M
 * minutes in a room, an @ does not get around it, continuations and
 * commands are not counted).
 */

import type { ChannelInbound, GroupPolicy, GroupVerdict } from './types.js'

/** Rooms whose clocks are kept; the oldest is forgotten first. */
const ROOMS_KEPT = 500

/** A keyword occurs in the text, case aside (grantley `kw.lower() in lower`). */
export function matchesKeyword(
  text: string,
  keywords: readonly string[],
): boolean {
  const lower = text.toLowerCase()
  return keywords.some(
    word => word !== '' && lower.includes(word.toLowerCase()),
  )
}

/**
 * Platforms without their own group rules: named is explicit; a free room,
 * the `all` trigger, a followed thread or a keyword let the rest in.
 */
export function defaultGroupGate(
  inbound: ChannelInbound,
  policy: GroupPolicy,
): GroupVerdict {
  if (inbound.addressed) return 'explicit'
  if (
    policy.trigger === 'all' ||
    policy.followed ||
    policy.freeGroups.includes(inbound.chat.id) ||
    matchesKeyword(inbound.text, policy.keywords)
  )
    return 'implicit'
  return null
}

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > ROOMS_KEPT) map.delete(map.keys().next().value!)
}

/** Per-room cooldown and speech cap, in memory (grantley keeps them per process too). */
export class RoomBudget {
  readonly #now: () => number
  readonly #lastReply = new Map<string, number>()
  readonly #speech = new Map<string, number[]>()

  constructor(now: () => number) {
    this.#now = now
  }

  /**
   * grantley `_group_reply_allowed` after the keyword match: an explicit
   * summons passes and restarts the clock; an implicit one passes only
   * after `cooldownMs` without a reply, and then restarts it.
   */
  admit(
    room: string,
    verdict: Exclude<GroupVerdict, null>,
    cooldownMs: number,
  ): boolean {
    const now = this.#now()
    if (verdict === 'implicit' && cooldownMs > 0) {
      const last = this.#lastReply.get(room)
      if (last !== undefined && now - last < cooldownMs) return false
    }
    remember(this.#lastReply, room, now)
    return true
  }

  /**
   * grantley `SlidingWindowCounter.allow`: under `max` in the trailing
   * window, then counted; `max` or `windowMs` at 0 turns the cap off.
   */
  speak(room: string, max: number, windowMs: number): boolean {
    if (max <= 0 || windowMs <= 0) return true
    const now = this.#now()
    const recent = (this.#speech.get(room) ?? []).filter(
      at => now - at < windowMs,
    )
    const allowed = recent.length < max
    if (allowed) recent.push(now)
    remember(this.#speech, room, recent)
    return allowed
  }
}
