// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The WeChat login QR code (`src/qr.ts`), read back by a small decoder
 * written from ISO/IEC 18004's tables rather than from the encoder: format
 * information and its BCH code, the version block, every Reed–Solomon block's
 * syndromes, and the byte-mode payload. (The encoder was also checked once
 * against macOS CoreImage's detector while it was written.)
 */

import { describe, expect, test } from 'bun:test'
import { qrModules, qrSvg } from '../src/qr.js'

/** ISO/IEC 18004 Table 1 and 9, level M, versions 1–20. */
const TOTAL = [
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733,
  815, 901, 991, 1085,
]
const ECC = [
  10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26,
  26,
]
const BLOCKS = [
  1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
]
/** Table 7: byte-mode capacity, level M. */
const BYTE_CAPACITY = [
  14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450,
  504, 560, 624, 666,
]
/** Annex E. */
const ALIGN: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
]

const EXP: number[] = []
const LOG: number[] = []
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x
  LOG[x] = i
  x <<= 1
  if (x & 0x100) x ^= 0x11d
}
const mul = (a: number, b: number) =>
  a === 0 || b === 0 ? 0 : EXP[(LOG[a]! + LOG[b]!) % 255]!

function bch(
  data: number,
  length: number,
  poly: number,
  degree: number,
): number {
  let rem = data << degree
  for (let i = length + degree - 1; i >= degree; i--)
    if ((rem >>> i) & 1) rem ^= poly << (i - degree)
  return rem
}

function unmasked(mask: number, y: number, x: number): boolean {
  switch (mask) {
    case 0:
      return (y + x) % 2 === 0
    case 1:
      return y % 2 === 0
    case 2:
      return x % 3 === 0
    case 3:
      return (y + x) % 3 === 0
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
    case 5:
      return ((y * x) % 2) + ((y * x) % 3) === 0
    case 6:
      return (((y * x) % 2) + ((y * x) % 3)) % 2 === 0
    default:
      return (((y + x) % 2) + ((y * x) % 3)) % 2 === 0
  }
}

function decode(m: boolean[][]): {
  text: string
  version: number
  mask: number
} {
  const n = m.length
  const version = (n - 17) / 4
  expect(Number.isInteger(version)).toBe(true)
  const at = (x: number, y: number) => (m[y]![x] ? 1 : 0)

  // Format information, both copies, BCH(15,5) under the 0x5412 mask.
  let first = 0
  for (let i = 0; i <= 5; i++) first |= at(8, i) << i
  first |= at(8, 7) << 6
  first |= at(8, 8) << 7
  first |= at(7, 8) << 8
  for (let i = 9; i < 15; i++) first |= at(14 - i, 8) << i
  let second = 0
  for (let i = 0; i < 8; i++) second |= at(n - 1 - i, 8) << i
  for (let i = 8; i < 15; i++) second |= at(8, n - 15 + i) << i
  expect(second).toBe(first)
  const format = first ^ 0x5412
  expect(format & 0x3ff).toBe(bch(format >>> 10, 5, 0x537, 10))
  expect(format >>> 13).toBe(0b00) // level M
  const mask = (format >>> 10) & 7
  expect(at(8, n - 8)).toBe(1)

  // Version information, BCH(18,6).
  if (version >= 7) {
    let bits = 0
    for (let i = 0; i < 18; i++)
      bits |= at(n - 11 + (i % 3), Math.floor(i / 3)) << i
    expect(bits >>> 12).toBe(version)
    expect(bits & 0xfff).toBe(bch(version, 6, 0x1f25, 12))
  }

  // Finder and timing patterns.
  for (const [cx, cy] of [
    [3, 3],
    [n - 4, 3],
    [3, n - 4],
  ] as const)
    for (let d = -3; d <= 3; d++) {
      expect(at(cx + d, cy - 3)).toBe(1)
      // The light ring two modules from the centre is dark only at the outer border.
      expect(at(cx - 2, cy + d) === 1).toBe(Math.abs(d) === 3)
    }
  for (let i = 8; i < n - 8; i++) {
    expect(at(i, 6)).toBe(i % 2 === 0 ? 1 : 0)
    expect(at(6, i)).toBe(i % 2 === 0 ? 1 : 0)
  }

  const reserved = m.map(row => row.map(() => false))
  const reserve = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < n && y < n) reserved[y]![x] = true
  }
  for (let i = 0; i < n; i++) {
    reserve(6, i)
    reserve(i, 6)
  }
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) reserve(x, y)
  for (let y = 0; y < 9; y++) for (let x = n - 8; x < n; x++) reserve(x, y)
  for (let y = n - 8; y < n; y++) for (let x = 0; x < 9; x++) reserve(x, y)
  const align = ALIGN[version - 1]!
  for (const ax of align)
    for (const ay of align) {
      if (
        (ax === 6 && ay === 6) ||
        (ax === 6 && ay === align.at(-1)) ||
        (ax === align.at(-1) && ay === 6)
      )
        continue
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          expect(at(ax + dx, ay + dy)).toBe(
            Math.max(Math.abs(dx), Math.abs(dy)) === 1 ? 0 : 1,
          )
          reserve(ax + dx, ay + dy)
        }
    }
  if (version >= 7)
    for (let i = 0; i < 18; i++) {
      reserve(n - 11 + (i % 3), Math.floor(i / 3))
      reserve(Math.floor(i / 3), n - 11 + (i % 3))
    }

  // The codewords, in the zig-zag order.
  const stream: number[] = []
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    const upward = ((right + 1) & 2) === 0
    for (let v = 0; v < n; v++)
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const y = upward ? n - 1 - v : v
        if (!reserved[y]![x])
          stream.push(at(x, y) ^ (unmasked(mask, y, x) ? 1 : 0))
      }
  }
  const total = TOTAL[version - 1]!
  const codewords: number[] = []
  for (let i = 0; i < total; i++)
    codewords.push(
      stream.slice(i * 8, i * 8 + 8).reduce((byte, b) => (byte << 1) | b, 0),
    )

  // De-interleave and check every block's syndromes.
  const blockCount = BLOCKS[version - 1]!
  const ecc = ECC[version - 1]!
  const shortBlocks = blockCount - (total % blockCount)
  const shortData = Math.floor(total / blockCount) - ecc
  const blocks = Array.from({ length: blockCount }, (_, i) => ({
    data: [] as number[],
    ecc: [] as number[],
    length: shortData + (i < shortBlocks ? 0 : 1),
  }))
  let k = 0
  for (let i = 0; i <= shortData; i++)
    for (const block of blocks)
      if (i < block.length) block.data.push(codewords[k++]!)
  for (let i = 0; i < ecc; i++)
    for (const block of blocks) block.ecc.push(codewords[k++]!)
  for (const block of blocks) {
    const word = [...block.data, ...block.ecc]
    for (let s = 0; s < ecc; s++) {
      let value = 0
      for (const c of word) value = mul(value, EXP[s]!) ^ c
      expect(value).toBe(0)
    }
  }

  // Byte mode payload.
  const data = blocks.flatMap(block => block.data)
  const bits = data.flatMap(byte =>
    Array.from({ length: 8 }, (_, i) => (byte >>> (7 - i)) & 1),
  )
  let p = 0
  const read = (length: number) => {
    let value = 0
    for (let i = 0; i < length; i++) value = (value << 1) | bits[p++]!
    return value
  }
  expect(read(4)).toBe(0b0100)
  const count = read(version < 10 ? 8 : 16)
  const bytes = Uint8Array.from({ length: count }, () => read(8))
  return {
    text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    version,
    mask,
  }
}

describe('qrModules', () => {
  test.each([
    'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=0123456789abcdef&bot_type=3',
    '短',
    '微信扫码登录 · 阡陌'.repeat(8),
    'x'.repeat(300),
    'y'.repeat(624),
    'y'.repeat(666),
  ])('round-trips at the smallest version that holds it: %#', text => {
    const bytes = new TextEncoder().encode(text).length
    const decoded = decode(qrModules(text))
    expect(decoded.text).toBe(text)
    expect(decoded.version).toBe(
      BYTE_CAPACITY.findIndex(capacity => capacity >= bytes) + 1,
    )
  })

  test('uses more than one mask across inputs, by penalty', () => {
    const masks = new Set(
      ['a', 'bb', 'ccc', 'https://x.y/z', '扫码', 'q'.repeat(40)].map(
        text => decode(qrModules(text)).mask,
      ),
    )
    expect(masks.size).toBeGreaterThan(1)
  })

  test('refuses what does not fit version 20', () => {
    expect(() => qrModules('z'.repeat(667))).toThrow('二维码内容过长')
  })
})

describe('qrSvg', () => {
  test('a self-contained square with a quiet zone', () => {
    const svg = qrSvg('https://liteapp.weixin.qq.com/q/1', 200)
    const size = qrModules('https://liteapp.weixin.qq.com/q/1').length + 8
    expect(
      svg.startsWith(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="200" height="200"`,
      ),
    ).toBe(true)
    expect(svg).toContain('aria-label="二维码"')
    expect(svg).not.toMatch(/href|<script|url\(/)
    // The first finder's top-left module sits inside the four-module margin.
    expect(svg).toContain('M4 4h1v1h-1z')
  })
})
