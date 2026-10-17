// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A QR code encoder for short strings (the WeChat bot login link): byte
 * mode, error-correction level M, versions 1–20, drawn as SVG on the server
 * so the page loads nothing from outside (`view/shell.ts` CSP).
 *
 * Follows ISO/IEC 18004: Reed–Solomon over GF(256) (polynomial 0x11D),
 * block interleaving, BCH-protected format and version information, and the
 * mask with the lowest penalty.
 */

/** Error-correction codewords per block and block count, level M, v1–v20. */
const ECC_PER_BLOCK = [
  10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26,
  26,
]
const BLOCKS = [
  1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
]
const MAX_VERSION = ECC_PER_BLOCK.length
/** Format bits of level M. */
const LEVEL_M = 0

function rawModules(version: number): number {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const aligns = Math.floor(version / 7) + 2
    result -= (25 * aligns - 10) * aligns - 55
    if (version >= 7) result -= 36
  }
  return result
}

function dataCodewords(version: number): number {
  return (
    Math.floor(rawModules(version) / 8) -
    ECC_PER_BLOCK[version - 1]! * BLOCKS[version - 1]!
  )
}

function multiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

function divisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = multiply(result[j]!, root)
      if (j + 1 < degree) result[j]! ^= result[j + 1]!
    }
    root = multiply(root, 0x02)
  }
  return result
}

function remainder(
  data: readonly number[],
  generator: readonly number[],
): number[] {
  const result = new Array<number>(generator.length).fill(0)
  for (const byte of data) {
    const factor = byte ^ result.shift()!
    result.push(0)
    for (let i = 0; i < result.length; i++)
      result[i]! ^= multiply(generator[i]!, factor)
  }
  return result
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const result = [6]
  for (let position = version * 4 + 10; result.length < count; position -= step)
    result.splice(1, 0, position)
  return result
}

function bit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0
}

class Matrix {
  readonly size: number
  readonly dark: boolean[][]
  readonly fixed: boolean[][]

  constructor(readonly version: number) {
    this.size = version * 4 + 17
    this.dark = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    )
    this.fixed = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    )
  }

  set(x: number, y: number, dark: boolean): void {
    this.dark[y]![x] = dark
    this.fixed[y]![x] = true
  }

  functionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0)
      this.set(i, 6, i % 2 === 0)
    }
    for (const [cx, cy] of [
      [3, 3],
      [this.size - 4, 3],
      [3, this.size - 4],
    ] as const) {
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx
          const y = cy + dy
          if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue
          const distance = Math.max(Math.abs(dx), Math.abs(dy))
          this.set(x, y, distance !== 2 && distance !== 4)
        }
    }
    const positions = alignmentPositions(this.version)
    const last = positions.length - 1
    positions.forEach((x, i) =>
      positions.forEach((y, j) => {
        if (
          (i === 0 && j === 0) ||
          (i === 0 && j === last) ||
          (i === last && j === 0)
        )
          return
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }),
    )
    this.format(0)
    if (this.version >= 7) {
      let rem = this.version
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
      const bits = (this.version << 12) | rem
      for (let i = 0; i < 18; i++) {
        const a = this.size - 11 + (i % 3)
        const b = Math.floor(i / 3)
        this.set(a, b, bit(bits, i))
        this.set(b, a, bit(bits, i))
      }
    }
  }

  format(mask: number): void {
    const data = (LEVEL_M << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i))
    this.set(8, 7, bit(bits, 6))
    this.set(8, 8, bit(bits, 7))
    this.set(7, 8, bit(bits, 8))
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i))
    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(bits, i))
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(bits, i))
    this.set(8, this.size - 8, true)
  }

  codewords(data: readonly number[]): void {
    let i = 0
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vertical = 0; vertical < this.size; vertical++)
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? this.size - 1 - vertical : vertical
          if (!this.fixed[y]![x] && i < data.length * 8) {
            this.dark[y]![x] = bit(data[i >>> 3]!, 7 - (i & 7))
            i++
          }
        }
    }
  }

  mask(mask: number): void {
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++) {
        if (this.fixed[y]![x]) continue
        let invert: boolean
        switch (mask) {
          case 0:
            invert = (x + y) % 2 === 0
            break
          case 1:
            invert = y % 2 === 0
            break
          case 2:
            invert = x % 3 === 0
            break
          case 3:
            invert = (x + y) % 3 === 0
            break
          case 4:
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
            break
          case 5:
            invert = ((x * y) % 2) + ((x * y) % 3) === 0
            break
          case 6:
            invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
            break
          default:
            invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
        }
        if (invert) this.dark[y]![x] = !this.dark[y]![x]
      }
  }

  /** Runs of five or more, 2×2 blocks and dark/light balance (finder-like rule omitted). */
  penalty(): number {
    let score = 0
    for (let pass = 0; pass < 2; pass++)
      for (let a = 0; a < this.size; a++) {
        let run = 1
        for (let b = 1; b < this.size; b++) {
          const here = pass === 0 ? this.dark[a]![b] : this.dark[b]![a]
          const before =
            pass === 0 ? this.dark[a]![b - 1] : this.dark[b - 1]![a]
          if (here === before) {
            run++
            if (run === 5) score += 3
            else if (run > 5) score++
          } else run = 1
        }
      }
    for (let y = 0; y + 1 < this.size; y++)
      for (let x = 0; x + 1 < this.size; x++) {
        const c = this.dark[y]![x]
        if (
          c === this.dark[y]![x + 1] &&
          c === this.dark[y + 1]![x] &&
          c === this.dark[y + 1]![x + 1]
        )
          score += 3
      }
    const dark = this.dark.reduce(
      (sum, row) => sum + row.filter(Boolean).length,
      0,
    )
    const total = this.size * this.size
    score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10
    return score
  }
}

/** The modules of `text`'s QR code, `true` for dark, without the quiet zone. */
export function qrModules(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)]
  let version = 1
  for (; version <= MAX_VERSION; version++) {
    const countBits = version < 10 ? 8 : 16
    if (4 + countBits + bytes.length * 8 <= dataCodewords(version) * 8) break
  }
  if (version > MAX_VERSION) throw new Error('二维码内容过长')
  const capacity = dataCodewords(version)
  const bits: number[] = []
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, version < 10 ? 8 : 16)
  for (const byte of bytes) push(byte, 8)
  push(0, Math.min(4, capacity * 8 - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8)
    data.push(bits.slice(i, i + 8).reduce((byte, b) => (byte << 1) | b, 0))
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11)
    data.push(pad)

  const blockCount = BLOCKS[version - 1]!
  const eccLength = ECC_PER_BLOCK[version - 1]!
  const total = Math.floor(rawModules(version) / 8)
  const shortBlocks = blockCount - (total % blockCount)
  const shortData = Math.floor(total / blockCount) - eccLength
  const generator = divisor(eccLength)
  const blocks: { data: number[]; ecc: number[] }[] = []
  for (let i = 0, offset = 0; i < blockCount; i++) {
    const length = shortData + (i < shortBlocks ? 0 : 1)
    const part = data.slice(offset, offset + length)
    offset += length
    blocks.push({ data: part, ecc: remainder(part, generator) })
  }
  const interleaved: number[] = []
  for (let i = 0; i <= shortData; i++)
    for (const block of blocks)
      if (i < block.data.length) interleaved.push(block.data[i]!)
  for (let i = 0; i < eccLength; i++)
    for (const block of blocks) interleaved.push(block.ecc[i]!)

  let best: Matrix | undefined
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const matrix = new Matrix(version)
    matrix.functionPatterns()
    matrix.codewords(interleaved)
    matrix.mask(mask)
    matrix.format(mask)
    const score = matrix.penalty()
    if (score < bestScore) {
      best = matrix
      bestScore = score
    }
  }
  return best!.dark
}

/** `text` as a black-on-white SVG QR code with a four-module quiet zone. */
export function qrSvg(text: string, pixels = 220): string {
  const modules = qrModules(text)
  const size = modules.length + 8
  let path = ''
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x + 4} ${y + 4}h1v1h-1z`
    }),
  )
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${pixels}" height="${pixels}" shape-rendering="crispEdges" role="img" aria-label="二维码">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
  )
}
