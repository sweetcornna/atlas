// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pairing codes (hermes `pairing.py`): hashed, rate limited, expiring. */

import { describe, expect, test } from 'bun:test'
import {
  ChannelPairing,
  PAIRING_ALPHABET,
  PAIRING_TTL_MS,
  emptyPairingBook,
  formatPairingCode,
} from '../../src/channels/pairing.js'

describe('pairing codes', () => {
  test('eight unambiguous letters, stored only as a salted hash', () => {
    const book = emptyPairingBook()
    const pairing = new ChannelPairing(book, () => 1_000)
    const asked = pairing.ask('u1', '访客', 'dm-1')
    if (asked.kind !== 'issued') throw new Error('no code')
    expect(asked.code).toHaveLength(8)
    expect([...asked.code].every(one => PAIRING_ALPHABET.includes(one))).toBe(true)
    expect(formatPairingCode('ABCDEFGH')).toBe('ABCD-EFGH')
    expect(JSON.stringify(book)).not.toContain(asked.code)
    expect(pairing.redeem(` ${formatPairingCode(asked.code).toLowerCase()} `)).toMatchObject({
      userId: 'u1',
      chatId: 'dm-1',
    })
    expect(pairing.pending()).toEqual([])
  })

  test('one code per person per ten minutes; a later ask replaces it; an hour later it is gone', () => {
    let now = 0
    const pairing = new ChannelPairing(emptyPairingBook(), () => now)
    const first = pairing.ask('u1', 'a', 'dm')
    expect(pairing.ask('u1', 'a', 'dm')).toEqual({ kind: 'quiet' })
    now += 10 * 60_000
    const second = pairing.ask('u1', 'a', 'dm')
    expect(second.kind).toBe('issued')
    expect(pairing.pending()).toHaveLength(1)
    if (first.kind === 'issued') expect(pairing.redeem(first.code)).toBeNull()
    now += PAIRING_TTL_MS
    expect(pairing.pending()).toEqual([])
  })
})
