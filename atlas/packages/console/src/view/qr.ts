// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * QR codes for the checkout page, drawn as inline SVG.
 *
 * A payment provider hands back one string — WeChat Pay a `code_url`
 * (`weixin://wxpay/bizpayurl?pr=…`), Alipay a `qr_code`
 * (`https://qr.alipay.com/…`) — and a phone has to scan it off the screen.
 * The console carries nothing it did not write (`test/dependencies.test.ts`),
 * so the symbol is encoded here, to ISO/IEC 18004:
 *
 * - byte mode only, over the UTF-8 bytes of the text. Payment strings are
 *   short ASCII URLs; numeric and alphanumeric modes would save a version on
 *   a few inputs and are not worth a second code path;
 * - the smallest version 1–40 that holds those bytes at the asked level, and
 *   no silent boost to a higher level — the caller gets the level it asked for;
 * - Reed–Solomon over GF(256), blocks interleaved;
 * - all eight masks scored with the four penalty rules; the lowest score
 *   wins, a tie goes to the lower mask number.
 *
 * `test/qrView.test.ts` holds whole symbols produced by an independent
 * encoder (Project Nayuki's qrcodegen) and requires these to match module for
 * module, the chosen mask included.
 *
 * It is the console's one encoder: the checkout page's payment codes and the
 * WeChat channel's login code (`channels.ts`) both draw through it.
 *
 * The drawing is dark on white whatever the page theme: a scanner needs the
 * contrast, and many phone cameras refuse an inverted code. It is one `<rect>`
 * and one `<path>` and nothing that loads, links or runs.
 */

import { attr } from './escape.js'

// ── Public shapes ───────────────────────────────────────────────────────────

/** Error-correction level: about 7, 15, 25 and 30 % of the symbol recoverable. */
export type QrEcc = 'L' | 'M' | 'Q' | 'H'

/** The text's UTF-8 bytes do not fit version 40 at the asked level. */
export class QrCapacityError extends Error {
  /** UTF-8 length of the text. */
  readonly bytes: number
  readonly ecc: QrEcc
  /** The most bytes version 40 holds at this level. */
  readonly max: number

  constructor(bytes: number, ecc: QrEcc, max: number) {
    super(
      `QR payload of ${bytes} bytes exceeds the ${max}-byte limit at level ${ecc}`,
    )
    this.name = 'QrCapacityError'
    this.bytes = bytes
    this.ecc = ecc
    this.max = max
  }
}

/** A finished symbol and the choices that made it. */
export interface QrSymbol {
  /** 1–40; the symbol is `4 × version + 17` modules on a side. */
  readonly version: number
  readonly ecc: QrEcc
  /** The data mask, 0–7. */
  readonly mask: number
  /** `modules[row][column]`, `true` for dark; the quiet zone is not included. */
  readonly modules: boolean[][]
}

// ── Spec tables (ISO/IEC 18004:2015) ────────────────────────────────────────

/** Row of each level in the tables below, and its two-bit format code (§7.9.1). */
const LEVELS: Readonly<
  Record<QrEcc, { readonly row: number; readonly code: number }>
> = {
  L: { row: 0, code: 0b01 },
  M: { row: 1, code: 0b00 },
  Q: { row: 2, code: 0b11 },
  H: { row: 3, code: 0b10 },
}

/** Table 9: error-correction codewords per block, versions 1–40, rows L M Q H. */
const ECC_PER_BLOCK: readonly (readonly number[])[] = [
  [
    7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28,
    28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
    30, 30,
  ],
  [
    10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26,
    26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
    28, 28,
  ],
  [
    13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26,
    30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
    30, 30,
  ],
  [
    17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26,
    28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
    30, 30,
  ],
]

/** Table 9: number of error-correction blocks, versions 1–40, rows L M Q H. */
const BLOCKS: readonly (readonly number[])[] = [
  [
    1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12,
    12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
  ],
  [
    1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17,
    18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
  [
    1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23,
    25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
  ],
  [
    1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25,
    34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
  ],
]

const MODE_BYTE = 0b0100
/** Pad codewords, alternating, after the terminator (§7.4.10). */
const PAD = [0xec, 0x11] as const
/** x⁸ + x⁴ + x³ + x² + 1, the field polynomial for Reed–Solomon. */
const FIELD_POLY = 0x11d
/** x¹⁰ + x⁸ + x⁵ + x⁴ + x² + x + 1: the BCH(15, 5) generator for format information. */
const FORMAT_POLY = 0x537
/** XORed onto format information so it is never all light (§7.9.1). */
const FORMAT_MASK = 0x5412
/** x¹² + x¹¹ + x¹⁰ + x⁹ + x⁸ + x⁵ + x² + 1: the BCH(18, 6) generator for version information. */
const VERSION_POLY = 0x1f25

/** Penalty weights N1–N4 (§7.8.3.1). */
const N1 = 3
const N2 = 3
const N3 = 40
const N4 = 10

// ── Capacity ────────────────────────────────────────────────────────────────

/**
 * Modules left for codewords once every function pattern is placed. Includes
 * the 0–7 remainder bits that do not make a whole codeword.
 */
function rawModules(version: number): number {
  const size = version * 4 + 17
  let n = size * size
  n -= 3 * 64 // finder patterns with their separators, 8 × 8 each
  n -= 2 * (size - 16) // timing patterns, between the separators
  n -= 31 // format information (2 × 15) and the dark module
  if (version >= 2) {
    const across = Math.floor(version / 7) + 2 // alignment centres per axis
    n -= (across * across - 3) * 25 // all but the three under the finders
    n += 2 * (across - 2) * 5 // those on a timing line share 5 modules with it
  }
  if (version >= 7) n -= 2 * 18 // version information, two copies
  return n
}

function dataCodewords(version: number, ecc: QrEcc): number {
  const { row } = LEVELS[ecc]
  const total = Math.floor(rawModules(version) / 8)
  return total - ECC_PER_BLOCK[row][version - 1] * BLOCKS[row][version - 1]
}

/** Width of the byte-mode character count indicator (Table 3). */
function countBits(version: number): number {
  return version <= 9 ? 8 : 16
}

/** The most bytes a version holds in one byte-mode segment. */
function byteCapacity(version: number, ecc: QrEcc): number {
  const bits = dataCodewords(version, ecc) * 8 - 4 - countBits(version)
  return Math.floor(bits / 8)
}

function smallestVersion(bytes: number, ecc: QrEcc): number {
  for (let version = 1; version <= 40; version++) {
    if (bytes <= byteCapacity(version, ecc)) return version
  }
  throw new QrCapacityError(bytes, ecc, byteCapacity(40, ecc))
}

// ── Data codewords ──────────────────────────────────────────────────────────

/** Mode, count, the bytes, terminator, zero fill and pad codewords (§7.4). */
function dataStream(
  bytes: Uint8Array,
  version: number,
  ecc: QrEcc,
): Uint8Array {
  const total = dataCodewords(version, ecc)
  const out = new Uint8Array(total)
  let length = 0
  const put = (value: number, width: number): void => {
    for (let i = width - 1; i >= 0; i--) {
      if ((value >>> i) & 1) out[length >>> 3] |= 0x80 >>> (length & 7)
      length++
    }
  }
  put(MODE_BYTE, 4)
  put(bytes.length, countBits(version))
  for (const byte of bytes) put(byte, 8)
  // Up to four zero bits of terminator; the zeros to the next byte boundary
  // are already in `out`, so the pad codewords start at the next whole byte.
  length += Math.min(4, total * 8 - length)
  for (let at = Math.ceil(length / 8), i = 0; at < total; at++, i++) {
    out[at] = PAD[i % 2]
  }
  return out
}

// ── Reed–Solomon over GF(256) ───────────────────────────────────────────────

/** Powers of α (doubled, so a sum of two logs needs no reduction) and logs. */
const [EXP, LOG] = galoisField()

function galoisField(): [Uint8Array, Uint8Array] {
  const exp = new Uint8Array(512)
  const log = new Uint8Array(256)
  let x = 1
  for (let i = 0; i < 255; i++) {
    exp[i] = x
    log[x] = i
    x <<= 1
    if (x & 0x100) x ^= FIELD_POLY
  }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255]
  return [exp, log]
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]
}

/**
 * The generator (x − α⁰)(x − α¹)…(x − αⁿ⁻¹), coefficients from the highest
 * power down, with the leading 1 left off.
 */
function generator(degree: number): Uint8Array {
  let poly = new Uint8Array([1])
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j] // × x
      next[j + 1] ^= gfMul(poly[j], EXP[i]) // × αⁱ; minus is plus in GF(2⁸)
    }
    poly = next
  }
  return poly.subarray(1)
}

/** The remainder of data · xⁿ divided by the generator: n check codewords. */
function rsRemainder(data: Uint8Array, gen: Uint8Array): Uint8Array {
  const rem = new Uint8Array(gen.length)
  for (const byte of data) {
    const factor = byte ^ rem[0]
    rem.copyWithin(0, 1)
    rem[rem.length - 1] = 0
    if (factor === 0) continue
    for (let j = 0; j < gen.length; j++) rem[j] ^= gfMul(gen[j], factor)
  }
  return rem
}

/**
 * Split the data into blocks, append each block's check codewords, and
 * interleave (§7.6): data column by column across the blocks, then the check
 * codewords the same way. The later blocks carry one data codeword more.
 */
function interleave(data: Uint8Array, version: number, ecc: QrEcc): Uint8Array {
  const { row } = LEVELS[ecc]
  const blocks = BLOCKS[row][version - 1]
  const checkLength = ECC_PER_BLOCK[row][version - 1]
  const total = Math.floor(rawModules(version) / 8)
  const shortData = Math.floor(total / blocks) - checkLength
  const firstLong = blocks - (total % blocks)
  const gen = generator(checkLength)
  const dataBlocks: Uint8Array[] = []
  const checkBlocks: Uint8Array[] = []
  for (let b = 0, at = 0; b < blocks; b++) {
    const length = shortData + (b >= firstLong ? 1 : 0)
    const block = data.subarray(at, at + length)
    at += length
    dataBlocks.push(block)
    checkBlocks.push(rsRemainder(block, gen))
  }
  const out = new Uint8Array(total)
  let w = 0
  for (let i = 0; i <= shortData; i++) {
    for (const block of dataBlocks) if (i < block.length) out[w++] = block[i]
  }
  for (let i = 0; i < checkLength; i++) {
    for (const block of checkBlocks) out[w++] = block[i]
  }
  return out
}

// ── Function patterns ───────────────────────────────────────────────────────

/** A symbol under construction: row-major, one byte per module. */
interface Grid {
  readonly size: number
  readonly dark: Uint8Array
  /** 1 under a function pattern: never data, never masked. */
  readonly fixed: Uint8Array
}

function setFixed(grid: Grid, row: number, col: number, dark: boolean): void {
  const i = row * grid.size + col
  grid.dark[i] = dark ? 1 : 0
  grid.fixed[i] = 1
}

/**
 * Row/column coordinates of alignment pattern centres (Annex E): 6, then
 * evenly spaced, with an even step, back from `size − 7`. Version 32 is the
 * one version whose table entry the rule misses.
 */
function alignmentCentres(version: number): number[] {
  if (version === 1) return []
  const across = Math.floor(version / 7) + 2
  const size = version * 4 + 17
  const step =
    version === 32 ? 26 : Math.ceil((size - 13) / (2 * across - 2)) * 2
  const out = [6]
  for (let at = size - 7; out.length < across; at -= step) out.splice(1, 0, at)
  return out
}

/** Remainder of value · xᵈ modulo poly over GF(2), d its degree: a BCH check field. */
function bch(value: number, poly: number, degree: number): number {
  let rem = value << degree
  for (let bit = 31 - Math.clz32(rem); bit >= degree; bit--) {
    if ((rem >>> bit) & 1) rem ^= poly << (bit - degree)
  }
  return rem
}

/** Format information for this level and mask, both copies, and the dark module. */
function drawFormat(grid: Grid, ecc: QrEcc, mask: number): void {
  const data = (LEVELS[ecc].code << 3) | mask
  const bits = ((data << 10) | bch(data, FORMAT_POLY, 10)) ^ FORMAT_MASK
  const { size } = grid
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >>> i) & 1) === 1
    // Around the top-left finder: down column 8 past the timing row, then
    // leftwards along row 8 past the timing column. Bit 0 at the top.
    if (i < 6) setFixed(grid, i, 8, dark)
    else if (i < 8) setFixed(grid, i + 1, 8, dark)
    else if (i === 8) setFixed(grid, 8, 7, dark)
    else setFixed(grid, 8, 14 - i, dark)
    // Split between the other two: bits 0–7 along row 8 in from the right
    // edge, bits 8–14 down column 8 to the bottom edge.
    if (i < 8) setFixed(grid, 8, size - 1 - i, dark)
    else setFixed(grid, size - 15 + i, 8, dark)
  }
  setFixed(grid, size - 8, 8, true)
}

/** Version information, version 7 up: two 6 × 3 blocks by the far finders. */
function drawVersion(grid: Grid, version: number): void {
  const bits = (version << 12) | bch(version, VERSION_POLY, 12)
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1
    const near = Math.floor(i / 3)
    const far = grid.size - 11 + (i % 3)
    setFixed(grid, near, far, dark) // top right, beside the finder
    setFixed(grid, far, near, dark) // bottom left, its transpose
  }
}

function drawFunctionPatterns(grid: Grid, version: number, ecc: QrEcc): void {
  const { size } = grid
  // Timing first: the finders and alignment patterns overwrite its ends.
  for (let i = 0; i < size; i++) {
    setFixed(grid, 6, i, i % 2 === 0)
    setFixed(grid, i, 6, i % 2 === 0)
  }
  // Finders with their separators: square rings around the centre, light at
  // Chebyshev distance 2 (inside) and 4 (the separator), clipped at the edge.
  const finders = [
    [3, 3],
    [3, size - 4],
    [size - 4, 3],
  ]
  for (const [r, c] of finders) {
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const row = r + dr
        const col = c + dc
        if (row < 0 || row >= size || col < 0 || col >= size) continue
        const ring = Math.max(Math.abs(dr), Math.abs(dc))
        setFixed(grid, row, col, ring !== 2 && ring !== 4)
      }
    }
  }
  // Alignment patterns at every pair of centres except the three finder corners.
  const centres = alignmentCentres(version)
  const last = centres.length - 1
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && (j === 0 || j === last)) || (i === last && j === 0)) {
        continue
      }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc))
          setFixed(grid, centres[i] + dr, centres[j] + dc, ring !== 1)
        }
      }
    }
  }
  // Reserve the format areas now; the real bits go in once the mask is known.
  drawFormat(grid, ecc, 0)
  if (version >= 7) drawVersion(grid, version)
}

// ── Codeword placement ──────────────────────────────────────────────────────

/**
 * Codeword bits, most significant first, in two-module columns from the right
 * edge, alternately upwards and downwards, skipping function modules and the
 * whole of column 6. Remainder modules past the last codeword stay light.
 */
function placeCodewords(grid: Grid, words: Uint8Array): void {
  const { size, dark, fixed } = grid
  const total = words.length * 8
  let bit = 0
  for (let right = size - 1, up = true; right >= 1; right -= 2, up = !up) {
    if (right === 6) right = 5
    for (let k = 0; k < size; k++) {
      const row = up ? size - 1 - k : k
      for (let col = right; col >= right - 1; col--) {
        const i = row * size + col
        if (fixed[i]) continue
        if (bit < total && (words[bit >>> 3] >>> (7 - (bit & 7))) & 1) {
          dark[i] = 1
        }
        bit++
      }
    }
  }
}

// ── Masking and penalty ─────────────────────────────────────────────────────

/** Whether mask `mask` inverts the module at (row, col) (Table 10). */
function inverts(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0
    case 1:
      return row % 2 === 0
    case 2:
      return col % 3 === 0
    case 3:
      return (row + col) % 3 === 0
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
  }
}

/** XOR a mask over the data modules; applying it twice undoes it. */
function applyMask(grid: Grid, mask: number): void {
  const { size, dark, fixed } = grid
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const i = row * size + col
      if (!fixed[i] && inverts(mask, row, col)) dark[i] ^= 1
    }
  }
}

/**
 * Rules 1 and 3 along one row or column, read with `stride` from `start`.
 *
 * Rule 1: each run of five or more same-coloured modules scores N1 plus one
 * per module beyond five. Rule 3: each dark-light-dark-light-dark run in the
 * ratio 1:1:3:1:1, at any scale n, with 4n light on one side (and n on the
 * other) scores N3 — twice if both sides qualify. Outside the symbol counts
 * as light, since it is the quiet zone. This is the reading qrcodegen and
 * ZXing take; an encoder that looks only inside the symbol can pick a
 * different mask, which is just as valid to a scanner.
 */
function lineScore(
  dark: Uint8Array,
  start: number,
  stride: number,
  size: number,
): number {
  // Run lengths, alternating colour, the first always light (maybe empty).
  const runs = [0]
  let colour = 0
  for (let k = 0; k < size; k++) {
    const c = dark[start + k * stride]
    if (c === colour) {
      runs[runs.length - 1]++
    } else {
      runs.push(1)
      colour = c
    }
  }
  let score = 0
  for (const run of runs) if (run >= 5) score += N1 + run - 5
  runs[0] += size
  if (colour === 0) runs[runs.length - 1] += size
  else runs.push(size)
  for (let j = 1; j + 5 < runs.length; j += 2) {
    const n = runs[j]
    if (runs[j + 1] !== n || runs[j + 2] !== 3 * n) continue
    if (runs[j + 3] !== n || runs[j + 4] !== n) continue
    const before = runs[j - 1]
    const after = runs[j + 5]
    if (before >= 4 * n && after >= n) score += N3
    if (after >= 4 * n && before >= n) score += N3
  }
  return score
}

/** The four penalty rules over the whole symbol, format information included. */
function penalty(grid: Grid): number {
  const { size, dark } = grid
  let score = 0
  for (let line = 0; line < size; line++) {
    score += lineScore(dark, line * size, 1, size)
    score += lineScore(dark, line, size, size)
  }
  // Rule 2: every 2 × 2 block of one colour, overlapping blocks counted.
  for (let row = 0; row + 1 < size; row++) {
    for (let col = 0; col + 1 < size; col++) {
      const i = row * size + col
      const c = dark[i]
      if (
        c === dark[i + 1] &&
        c === dark[i + size] &&
        c === dark[i + size + 1]
      ) {
        score += N2
      }
    }
  }
  // Rule 4: N4 for each whole 5 % step the dark share is from 50 %; 45–55 %
  // costs nothing, and a share exactly on a step counts to the lower one.
  let count = 0
  for (const c of dark) count += c
  const total = size * size
  const steps = Math.ceil(Math.abs(count * 20 - total * 10) / total) - 1
  return score + steps * N4
}

/** Score every mask with its own format information; ties go to the lower. */
function chooseMask(grid: Grid, ecc: QrEcc): number {
  let best = 0
  let bestScore = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask++) {
    applyMask(grid, mask)
    drawFormat(grid, ecc, mask)
    const score = penalty(grid)
    if (score < bestScore) {
      best = mask
      bestScore = score
    }
    applyMask(grid, mask)
  }
  return best
}

// ── Encoder ─────────────────────────────────────────────────────────────────

/**
 * Encode text as a QR symbol. `mask` forces one of the eight masks instead
 * of choosing by penalty — for tests and diagnostics; any mask scans.
 *
 * @throws {QrCapacityError} the UTF-8 bytes do not fit version 40.
 * @throws {RangeError} an unknown level or a mask outside 0–7.
 */
export function qrEncode(
  text: string,
  options: { readonly ecc?: QrEcc; readonly mask?: number } = {},
): QrSymbol {
  if (typeof text !== 'string') throw new TypeError('QR text must be a string')
  const ecc = options.ecc ?? 'M'
  if (!Object.hasOwn(LEVELS, ecc)) {
    throw new RangeError(`unknown QR error-correction level ${String(ecc)}`)
  }
  const forced = options.mask
  if (
    forced !== undefined &&
    !(Number.isInteger(forced) && forced >= 0 && forced <= 7)
  ) {
    throw new RangeError(`QR mask must be an integer 0-7, got ${forced}`)
  }
  const bytes = new TextEncoder().encode(text)
  const version = smallestVersion(bytes.length, ecc)
  const size = version * 4 + 17
  const grid: Grid = {
    size,
    dark: new Uint8Array(size * size),
    fixed: new Uint8Array(size * size),
  }
  drawFunctionPatterns(grid, version, ecc)
  placeCodewords(
    grid,
    interleave(dataStream(bytes, version, ecc), version, ecc),
  )
  const mask = forced ?? chooseMask(grid, ecc)
  applyMask(grid, mask)
  drawFormat(grid, ecc, mask)
  const modules: boolean[][] = []
  for (let row = 0; row < size; row++) {
    const line: boolean[] = []
    for (let col = 0; col < size; col++)
      line.push(grid.dark[row * size + col] === 1)
    modules.push(line)
  }
  return { version, ecc, mask, modules }
}

/**
 * The module grid for `text`, `[row][column]`, `true` for dark, at the
 * smallest version that fits. Level M unless asked.
 *
 * @throws {QrCapacityError} the UTF-8 bytes do not fit version 40.
 */
export function qrMatrix(text: string, ecc: QrEcc = 'M'): boolean[][] {
  return qrEncode(text, { ecc }).modules
}

// ── SVG ─────────────────────────────────────────────────────────────────────

/** {@link attr}, and the parentheses too, so not even a label spells `url(`. */
function labelAttr(label: string): string {
  return attr(label).replace(/\(/g, '&#40;').replace(/\)/g, '&#41;')
}

/**
 * `text` as an inline SVG QR code: one module per user unit, `quiet` modules
 * of white margin (4, the spec minimum, unless asked), a white background
 * and every dark module in one black path of horizontal runs. No size is
 * set; the page's CSS decides how large it shows, and `crispEdges` keeps the
 * modules from blurring into each other when it scales.
 *
 * @throws {QrCapacityError} the UTF-8 bytes do not fit version 40.
 * @throws {RangeError} `quiet` is not a whole number of modules.
 */
export function qrSvg(
  text: string,
  options: {
    readonly ecc?: QrEcc
    readonly quiet?: number
    readonly label?: string
  } = {},
): string {
  const quiet = options.quiet ?? 4
  if (!Number.isInteger(quiet) || quiet < 0) {
    throw new RangeError(`QR quiet zone must be a whole number, got ${quiet}`)
  }
  const modules = qrMatrix(text, options.ecc)
  const side = modules.length + 2 * quiet
  let d = ''
  for (let row = 0; row < modules.length; row++) {
    const line = modules[row]
    for (let col = 0; col < line.length; col++) {
      if (!line[col]) continue
      const from = col
      while (col + 1 < line.length && line[col + 1]) col++
      const run = col + 1 - from
      d += `M${from + quiet} ${row + quiet}h${run}v1h-${run}z`
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}"` +
    ` role="img" aria-label="${labelAttr(options.label ?? '二维码')}"` +
    ` shape-rendering="crispEdges">` +
    `<rect width="${side}" height="${side}" fill="#fff"/>` +
    `<path fill="#000" d="${d}"/>` +
    `</svg>`
  )
}
