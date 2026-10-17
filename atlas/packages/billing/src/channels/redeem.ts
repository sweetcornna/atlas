// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Redeem codes (兑换码) issued by platform operators. Not a `PaymentChannel`:
 * there is no QR, notification, query or close.
 *
 * A code is 20 symbols of Crockford base32 (100 random bits), shown as
 * `XXXXX-XXXXX-XXXXX-XXXXX` exactly once at issue. Only the SHA-256 of the
 * normalised form is stored; with 100 bits of entropy an unsalted hash cannot
 * be reversed by enumeration.
 */

import { createHash } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const SYMBOLS = 20

/** A fresh code from `random(n)` (n uniform bytes). */
export function generateRedeemCode(random: (bytes: number) => Uint8Array) {
  const bytes = random(SYMBOLS)
  if (bytes.length < SYMBOLS)
    throw new Error('random source returned too few bytes')
  let symbols = ''
  // 256 is a multiple of 32, so the low five bits are uniform.
  for (let i = 0; i < SYMBOLS; i++) symbols += ALPHABET[bytes[i]! & 31]
  return symbols.match(/.{5}/g)!.join('-')
}

/**
 * Upper-case, drop spaces and hyphens, read O as 0 and I/L as 1 (Crockford).
 * Null when the result is not a well-formed code.
 */
export function normalizeRedeemCode(input: string): string | null {
  if (typeof input !== 'string' || input.length > 64) return null
  const normalized = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (normalized.length !== SYMBOLS) return null
  for (const char of normalized) if (!ALPHABET.includes(char)) return null
  return normalized
}

/** SHA-256 (hex) of a normalised code: the only form that is stored. */
export function hashRedeemCode(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}
