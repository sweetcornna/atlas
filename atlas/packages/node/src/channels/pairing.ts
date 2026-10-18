// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pairing codes for strangers (hermes `gateway/pairing.py`,
 * `runtimes-channels.md` §2.5). Someone a channel does not know writes
 * privately and gets a one-hour code; the owner approves it with
 * `/pair <码>` in their own chat, or approves the request on the console.
 * Only a salted hash of each code is kept, and the limits are hermes's: one
 * code per person per ten minutes, three waiting per channel, five wrong
 * codes lock approval by code for an hour.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'

/** No 0/O, 1/I: codes are read aloud and retyped. */
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
export const PAIRING_TTL_MS = 60 * 60_000
const ASK_INTERVAL_MS = 10 * 60_000
const MAX_PENDING = 3
const MAX_FAILURES = 5
const LOCKOUT_MS = 60 * 60_000

export interface PairingRequestRecord {
  readonly id: string
  readonly userId: string
  readonly userName: string
  /** The private chat to tell once approved. */
  readonly chatId: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly salt: string
  readonly hash: string
}

export interface PairingBook {
  requests: PairingRequestRecord[]
  /** When each person last got a code. */
  asked: Record<string, number>
  failures: number
  lockedUntil: number
}

export function emptyPairingBook(): PairingBook {
  return { requests: [], asked: {}, failures: 0, lockedUntil: 0 }
}

/** `ABCDEFGH` → `ABCD-EFGH`. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

function digest(salt: string, code: string): string {
  return createHash('sha256').update(`${salt}${code}`).digest('hex')
}

function newCode(): string {
  // 32 letters: every byte maps to one evenly.
  return [...randomBytes(CODE_LENGTH)]
    .map(byte => PAIRING_ALPHABET[byte & 31])
    .join('')
}

export type PairingAsk =
  | { readonly kind: 'issued'; readonly code: string }
  /** Asked too recently, or the channel has enough waiting: say nothing. */
  | { readonly kind: 'quiet' }

/** Works on the book in place; the hub saves it afterwards. */
export class ChannelPairing {
  readonly #book: PairingBook
  readonly #now: () => number

  constructor(book: PairingBook, now: () => number) {
    this.#book = book
    this.#now = now
  }

  #prune(): void {
    const now = this.#now()
    this.#book.requests = this.#book.requests.filter(
      request => request.expiresAt > now,
    )
    for (const [user, at] of Object.entries(this.#book.asked))
      if (now - at >= ASK_INTERVAL_MS) delete this.#book.asked[user]
  }

  pending(): readonly PairingRequestRecord[] {
    this.#prune()
    return this.#book.requests
  }

  ask(userId: string, userName: string, chatId: string): PairingAsk {
    this.#prune()
    if (this.#book.asked[userId] !== undefined) return { kind: 'quiet' }
    const others = this.#book.requests.filter(one => one.userId !== userId)
    if (others.length >= MAX_PENDING) return { kind: 'quiet' }
    const now = this.#now()
    const code = newCode()
    const salt = randomBytes(16).toString('hex')
    this.#book.requests = [
      ...others,
      {
        id: `pr-${randomUUID()}`,
        userId,
        userName: [...userName].slice(0, 60).join('') || userId,
        chatId,
        createdAt: now,
        expiresAt: now + PAIRING_TTL_MS,
        salt,
        hash: digest(salt, code),
      },
    ]
    this.#book.asked[userId] = now
    return { kind: 'issued', code }
  }

  /** The request a code belongs to; wrong codes count toward the lockout. */
  redeem(raw: string): PairingRequestRecord | 'locked' | null {
    this.#prune()
    const now = this.#now()
    if (this.#book.lockedUntil > now) return 'locked'
    const code = raw.toUpperCase().replace(/[\s-]/g, '')
    const found = this.#book.requests.find(
      request => digest(request.salt, code) === request.hash,
    )
    if (found === undefined) {
      if (++this.#book.failures >= MAX_FAILURES) {
        this.#book.failures = 0
        this.#book.lockedUntil = now + LOCKOUT_MS
      }
      return null
    }
    this.#book.failures = 0
    this.#book.requests = this.#book.requests.filter(one => one !== found)
    return found
  }

  /** Removes and returns one request (the console decides by id). */
  take(id: string): PairingRequestRecord | null {
    this.#prune()
    const found = this.#book.requests.find(request => request.id === id)
    if (found === undefined) return null
    this.#book.requests = this.#book.requests.filter(one => one !== found)
    return found
  }
}
