// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The checkout page's QR encoder (`src/view/qr.ts`). The WeChat login code's
 * smaller encoder, `src/qr.ts`, has its own file, `qr.test.ts`.
 *
 * The expected symbols are not this encoder's own output. They were produced
 * once, outside the repository, by Project Nayuki's qrcodegen (the TypeScript
 * library as bundled in naive-ui 2.44.1) with
 * `QrCode.encodeSegments([QrSegment.makeBytes(utf8)], ecl, 1, 40, mask, false)`
 * — one byte-mode segment, the smallest version, no level boost, the mask
 * chosen by its penalty or forced — and are kept as hex: rows top to bottom,
 * modules left to right, dark = 1, most significant bit first, zero-padded to
 * a whole digit. The byte capacities are the same library's, and equal the
 * byte-mode column of ISO/IEC 18004 Table 7.
 *
 * The structural checks read the symbol back the way a decoder does and
 * compare with the spec's own tables (Annex C format codes, Annex D version
 * codes, Annex E alignment centres), so they lean on neither encoder.
 */

import { describe, expect, test } from 'bun:test'
import {
  QrCapacityError,
  type QrEcc,
  type QrSymbol,
  qrEncode,
  qrMatrix,
  qrSvg,
} from '../src/view/qr.js'

type Rows = QrSymbol['modules']
type Cell = readonly [row: number, col: number]

interface Vector {
  readonly text: string
  readonly ecc: QrEcc
  readonly version: number
  readonly mask: number
  readonly hex: string
}

const LEVELS: readonly QrEcc[] = ['L', 'M', 'Q', 'H']

// ── Reference data (qrcodegen) ──────────────────────────────────────────────

const VECTORS: readonly Vector[] = [
  {
    text: '',
    ecc: 'L',
    version: 1,
    mask: 0,
    hex: 'fe2bfc10506ea8bb7415dba5aec13907faafe01400efae2525aa8a95dc9afbbdf77700711bfa22305c46ba8aadd2aaaeaddb05bbafed778',
  },
  {
    text: '01234567',
    ecc: 'M',
    version: 1,
    mask: 6,
    hex: 'feb3fc14d06ea2bb74c5dbaaaec13d07faafe007009f8cbf8e799cf94a8820c32a69806cd3fa3e505fb5ba9a05d5cb2e90e704cc7fed0c0',
  },
  {
    text: 'HELLO WORLD',
    ecc: 'Q',
    version: 1,
    mask: 7,
    hex: 'fe93fc12106ea4bb7565dba6aec16907faafe01700579f69e21892d65b72f5b5ab7a006453fb4fd05f21ba4e35d50fee8aab05680fe2970',
  },
  {
    text: 'https://qmo.example/pay',
    ecc: 'M',
    version: 2,
    mask: 2,
    hex: 'fe64bfc121906eac4bb75bf5dba88aec17dd07faaafe017700be6c3e224a48bdc3f5778b6c1ebdf7bf8614aa0ce5771062b1b6d6fa0074463f982af05551abaeffbdd6317eebe01b04a7b9fef81f8',
  },
  {
    text: 'weixin://wxpay/bizpayurl?pr=AbCdEfG',
    ecc: 'M',
    version: 3,
    mask: 1,
    hex: 'feaf43fc120a506ead1cbb7492d5dba71a2ec1675507faaaafe008b000a30da12ca947d9c2e3e5fa88b748a02af9a54437df973b05f6a495909a5b2596482545db76a7ee1251352e3eebfaf88043fc5ffba52b304da713ba35dfddd284af6ebc7d27042a530feed8c48',
  },
  {
    text: 'https://qr.alipay.com/bax01234abcdEFGHijkl5678',
    ecc: 'Q',
    version: 4,
    mask: 6,
    hex: 'fe2e6e3fc1732b506e97670bb75bee35dbad1192ec121c1d07faaaaafe015b06005ed150ed409a7a87a995994bb623df7a4931461b1465594293e9b778e8280884b57e416bf8681a2f35c9f15dfdae2f0969d82f1f98566707d0520cc8b6af7181529deec949f8007b8345bf8984ea90503a51cba95bbf8dd734fab6e9135e77054894f7fe22c3bc0',
  },
  {
    text: 'https://qr.alipay.com/bax01234abcdEFGHijkl5678',
    ecc: 'H',
    version: 6,
    mask: 3,
    hex: 'fe3b08a7bfc134be95506e83b6194bb747883325dbacdc3d52ec11f75e4907faaaaaaafe0170482f0033f2156fe8265b3524ed61de05091c86a6707c522d39beac5a612877c654166da04466e64a88c4905a6e894c7a8d2c91c43cea1cf441ecab07298ed1eec2bec5c3176dee2da80f5d2c4da5210d92a2d651c80342f0f700e24e721cc3f7c0dda06f3c36de9e71bfbdc6e099d24559d77fba9bb585fd94108ad1ca5777588c2efe80549257447fb43a92aa50415cdb913ba508e28fbdd59dda8066eb0b82b85b04d153255efe5453a2c30',
  },
  {
    text: '阡陌 Qmo 控制台 · 微信支付与支付宝扫码付款 · 订单 20261016-0001',
    ecc: 'L',
    version: 5,
    mask: 2,
    hex: 'fe2f61c3fc153ccb106e8352bebb75d647f5dba419c92ec16c09d107faaaaaafe00e526900fbd060d5504579ab5566e9ed53515b9a70eabb3abf510e4cb00a72ef5965d62b022e6469631e91f3eb86e670ec060aa1cdc884e29a40b53f2abe0d46e22009b5522b65a60c043e675921de31ed00e5eb70962de9e1f559e97b9b639ab8b2a636fe006006c463fbe4cfab5046500b15bad1e08ffdd6708914eeb1e9c83f059a72b5dfecbf9cbd8',
  },
  {
    text: 'weixin://wxpay/bizpayurl?pr=AbCdEfG0123456789AbCdEfG0123456789AbCdEfG0123456789AbCdEfG0123456789AbCdEfG0123456789',
    ecc: 'M',
    version: 7,
    mask: 2,
    hex: 'fe75c55b4bfc10f97484906eb2352e74bb7530460c35dbab8df86baec15014712107faaaaaaaafe0113f13f700be7eafc033e023dfc69863419348dd4aedda11f89713f7f03eb3450336934e65241c0c4be612dd98b00883b9ad968fa9e50415c6361a3a6b16cbfeac0c9500a94367216cfb7bfc66fcbc4ee44b8475abed6a016bdf175115f11f8fb75fc42f80411596d01bfbe7711f493da09e279f30e269e8c7207810c2114de91d9eae3794841904089a5bfee2dc6d81693122bb9632e0c2f90a860a08f0f2cff73f49a4f0fa02fc80460c772443f9b86a48ebd059e1193d1dbaf62fc25fc5d60c1e1c2feeb0057f0e85041c7a1f29cfedcb4966930',
  },
  {
    text: 'https://qr.alipay.com/bax01234abcdEFGHijkl5678bax01234abcdEFGHijkl5678bax01234abcdEFGHijkl5678?order=qmo-10',
    ecc: 'H',
    version: 10,
    mask: 2,
    hex: 'fe8ae809256f3fc16667f915c2906ea162c17fe7cbb74bdf1bac86a5dba11063fe5f92ec15fd091238d107faaaaaaaaaaafe01e0e4457364003ae8817f6c4673b461827ffcd9c3eabc95b7fd516f9a3074c4c03d91d1637e17c6c122308a4d1cc2256e9d78d9541e8f0889cbfafceb31c427874861cb5573344689bf3dfcb068f5bb08b11fcdad459e121607ff05ebe5f5438302090e0bd7d4454f8e245c04d8a03a529c801e3514b2bb1437da66392e847476cce09452e6cc67f58fbfeaa8ff171ff50c4614f1f9ad7f72a0572a9a44b44913afc4553e137efcbd5fec13842948865aed3ea1bedcc476d09aedb1be6a7c53c4bc50f61497829c00e78722315cc432e1da04c627896d86dcdfabc5317bb56ac98e79d5db601ea9ffcb34239a8b3282385d6cc09e450f3683c1c0d28952463008bc6d607fffeee42dc11bb5456eb18c0751082de11e99bd32dd0f7b19f187141a31d6650259197ef510fc00671831a8bec67f844f3aa769aad04eda0c447f114babd983e8567fddd48bd8b7df0852eae395cb3d7799048d2e2ae47ba4fe6aeab8cb60bd0',
  },
]

const FORCED: readonly string[] = [
  'feb23fc15e106ea44bb75c95dba9caec129d07faaafe0102006b28afa08ef1cad0f57a0fd7853a36106d592e9a69ce9082208f92f88062c63fbf2b7043d12baebf95d36cfaea056b05ba02fe62b98',
  'fe673fc134906e910bb75635dba49aec143507faaafe01a800627db40a245b5f85a030a57d206f6342c7f387cf3c9a3a288adac7fd804844bf8a6a3049718ba3efc5d1c652eb503f0510a8fe37ec8',
  'fed1bfc110106e9cabb74f15dbaff2ec167d07faaafe003a007f4b18c200c904e816e2ac59b6b40ef645baa279e7f71abac3b771fe806cc6ffa7eaf050511ba88ff5d78f76eb8b530582e1fe01378',
  'fe51bfc17d906ea7cbb74f15dba242ec111107faaafe008c007626834200c929decd9981ef66b40ef3e361cd1c512d1abac303aafb005a45bf87eaf05b31aba65f9dd78f76eae6e505598cfe01378',
  'fe16bfc133906eb28bb74805dbab82ec144507faaafe004b004a8c5a7ae34727e62e132b45c1a87f35cb824049047802cb04c6b6fa804f44ff89ea1047516bacffb5d1b796e968dd05f326fe462b8',
  'fee73fc170906e9cabb74365dba7f2ec107507faaafe00b80043cb41de710e04e816e0a479306f6346c7b28279e7f76b7ddfb771fe804c44ffaa6a3048719ba08ff5d09306e98b530500e9fe37ec8',
  'fe673fc173906e958bb75365dbaed2ec11f107faaafe01b4005eefed5e710e0dcc84a12261506f6345cb82435d75bf6b7ddf93e3ff8054457f8a6a3058b19baacfd5d49306e9c27705616ffe37ec8',
  'feb23fc10c506ea0cbb75c95dba382ec160d07faaafe014b0057baf6a08ef1d899d1fe9d9ea53a3612247dbe0820ea908220c6b6fa806bc6bfbf2b7057516ba79f85d76cfae89723059e90fe62b98',
]

const CAPACITY: Readonly<Record<QrEcc, readonly number[]>> = {
  L: [
    17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586,
    644, 718, 792, 858, 929, 1003, 1091, 1171, 1273, 1367, 1465, 1528, 1628,
    1732, 1840, 1952, 2068, 2188, 2303, 2431, 2563, 2699, 2809, 2953,
  ],
  M: [
    14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450,
    504, 560, 624, 666, 711, 779, 857, 911, 997, 1059, 1125, 1190, 1264, 1370,
    1452, 1538, 1628, 1722, 1809, 1911, 1989, 2099, 2213, 2331,
  ],
  Q: [
    11, 20, 32, 46, 60, 74, 86, 108, 130, 151, 177, 203, 241, 258, 292, 322,
    364, 394, 442, 482, 509, 565, 611, 661, 715, 751, 805, 868, 908, 982, 1030,
    1112, 1168, 1228, 1283, 1351, 1423, 1499, 1579, 1663,
  ],
  H: [
    7, 14, 24, 34, 44, 58, 64, 84, 98, 119, 137, 155, 177, 194, 220, 250, 280,
    310, 338, 382, 403, 439, 461, 511, 535, 593, 625, 658, 698, 742, 790, 842,
    898, 958, 983, 1051, 1093, 1139, 1219, 1273,
  ],
}

/** The input behind {@link FORCED}: version 2 at level Q, masks 0–7 in order. */
const FORCED_TEXT = 'Qmo checkout'

/**
 * One input per version and level: printable ASCII from {@link sample}, as
 * long as the middle of that version's byte band. `masks` holds qrcodegen's
 * mask for versions 1–40, one digit each; `hashes` the FNV-1a of its symbol's
 * hex form, eight digits each.
 */
const SWEEP: Readonly<
  Record<QrEcc, { readonly masks: string; readonly hashes: string }>
> = {
  L: {
    masks: '0313322262233742222234262472223474222222',
    hashes:
      '73c7330f320c66c102e80772773fcdea7767ec9c97e65b0551781242cef18146008862687304ed46c124bd14853c65346b931a332ee3d695b4e6eb75a714eee3e0199ca4088a03edbd57e994347138cfb303c5eae829cee450c9453b67da23550ab818120ec44256f42d64eb1db0b081956bdc730d28b984b94afede9bc7736d1256f057ac55aabcb9edc02e0f6087047558e9c8e5e16a86997982302c2e616f',
  },
  M: {
    masks: '1315462426424222323222654262474362232522',
    hashes:
      'f42f0017043e0950b052eb8dc60073d05945ca79f4a08bb7af3483e246b948178e25e2f8e8454f117b3eb6b9b6da0942eca5609ddea962f9d1490324d7b7194735bf5cd8eabe2c05d22baba9b9477f91bccbfe7ecb58523c07d481b05c290caeb644272d24d892eabe7930fbed8c85154ff21a1e162457c90a6d3f55e4b02215b69ee23f1eb69071a18c348d61cce3341fa73960d65591d26da701f423c01ef1',
  },
  Q: {
    masks: '0062242223222226274442632442243412623742',
    hashes:
      '9d67db5f6275c1e9a34c8fac9895883461ad74b5b07d37e482efeed53d7a46f24f49def26443e1939ee7ff1ceeaf84484accd7dd2d7e242f341b73129af75209d804e40e042ca3852f8b9e6d9ec7e943bfb2a6048c5070e9d261c9909e44a8aa4fed125527f1b06e62bd8df45aaf6f91768cff5e0356e868d3b2b35ecf6f055c9c4f420a28fcaa787731bc9d577b641718d0be88df5b0b6a10e328a1df2ffd47',
  },
  H: {
    masks: '6636645326332372222227441246562213322225',
    hashes:
      '97b8b41775bc361a19d8c66ffc61529016a27022f3f72c74fb4ae0248d155a4440b95da130d77bdf9f28bf19d055d217d690a0041e8d6873251665cdc372e110389ffea8716fcf049d2a1181b8f2afc6fc071a11ff361476f249f20f9dca873c36e5211459ad5547fe9ad62b738fda0063721129d9296fa8fa14a9514c225b6f2a890c99ab78543423e666c9ceaadf31d7f15a59541b4742c8834d9163aebaa3',
  },
}

// ── Spec tables ─────────────────────────────────────────────────────────────

/** Annex C: the 15-bit format code for each level and mask 0–7. */
const FORMAT_CODES: Readonly<Record<QrEcc, readonly number[]>> = {
  L: [
    0b111011111000100, 0b111001011110011, 0b111110110101010, 0b111100010011101,
    0b110011000101111, 0b110001100011000, 0b110110001000001, 0b110100101110110,
  ],
  M: [
    0b101010000010010, 0b101000100100101, 0b101111001111100, 0b101101101001011,
    0b100010111111001, 0b100000011001110, 0b100111110010111, 0b100101010100000,
  ],
  Q: [
    0b011010101011111, 0b011000001101000, 0b011111100110001, 0b011101000000110,
    0b010010010110100, 0b010000110000011, 0b010111011011010, 0b010101111101101,
  ],
  H: [
    0b001011010001001, 0b001001110111110, 0b001110011100111, 0b001100111010000,
    0b000011101100010, 0b000001001010101, 0b000110100001100, 0b000100000111011,
  ],
}

/** Table 12: the two level bits inside the format code. */
const LEVEL_BITS: Readonly<Record<QrEcc, number>> = { L: 1, M: 0, Q: 3, H: 2 }

/** Annex D: the 18-bit version code. */
const VERSION_CODES: Readonly<Record<number, number>> = {
  7: 0x07c94,
  10: 0x0a4d3,
}

/** Annex E: alignment pattern centre coordinates. */
const ALIGNMENT: Readonly<Record<number, readonly number[]>> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  10: [6, 28, 50],
}

// ── Reading a symbol ────────────────────────────────────────────────────────

/** The hex form the reference data is kept in. */
function hex(rows: Rows): string {
  let bits = ''
  for (const row of rows) for (const dark of row) bits += dark ? '1' : '0'
  bits = bits.padEnd(Math.ceil(bits.length / 4) * 4, '0')
  let out = ''
  for (let i = 0; i < bits.length; i += 4) {
    out += Number.parseInt(bits.slice(i, i + 4), 2).toString(16)
  }
  return out
}

/** The modules at `cells`, first cell the most significant bit. */
function read(rows: Rows, cells: readonly Cell[]): number {
  let value = 0
  for (const [row, col] of cells) value = value * 2 + (rows[row][col] ? 1 : 0)
  return value
}

/** Both copies of the format information, bit 14 first (Figure 25). */
function formatCells(size: number): [Cell[], Cell[]] {
  const topLeft: Cell[] = [
    [8, 0],
    [8, 1],
    [8, 2],
    [8, 3],
    [8, 4],
    [8, 5],
    [8, 7],
    [8, 8],
    [7, 8],
    [5, 8],
    [4, 8],
    [3, 8],
    [2, 8],
    [1, 8],
    [0, 8],
  ]
  const split: Cell[] = []
  for (let row = size - 1; row >= size - 7; row--) split.push([row, 8])
  for (let col = size - 8; col < size; col++) split.push([8, col])
  return [topLeft, split]
}

/** Both version information blocks, bit 17 first (Figure 27). */
function versionCells(size: number): [Cell[], Cell[]] {
  const bottomLeft: Cell[] = []
  const topRight: Cell[] = []
  for (let i = 17; i >= 0; i--) {
    bottomLeft.push([size - 11 + (i % 3), Math.floor(i / 3)])
    topRight.push([Math.floor(i / 3), size - 11 + (i % 3)])
  }
  return [bottomLeft, topRight]
}

/** Remainder of a GF(2) polynomial division, for the BCH checks. */
function gf2Remainder(value: number, poly: number): number {
  const degree = 31 - Math.clz32(poly)
  for (let top = 31 - Math.clz32(value); top >= degree; ) {
    value ^= poly << (top - degree)
    top = 31 - Math.clz32(value)
  }
  return value
}

/** Whether the 7 × 7 finder with its separator sits with its corner at (top, left). */
function hasFinder(rows: Rows, top: number, left: number): boolean {
  const size = rows.length
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const row = top + dr
      const col = left + dc
      if (row < 0 || row >= size || col < 0 || col >= size) continue
      const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3))
      if (rows[row][col] !== (ring !== 2 && ring !== 4)) return false
    }
  }
  return true
}

/** Whether a 5 × 5 alignment pattern is centred at (row, col). */
function hasAlignment(rows: Rows, row: number, col: number): boolean {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const ring = Math.max(Math.abs(dr), Math.abs(dc))
      if (rows[row + dr][col + dc] !== (ring !== 1)) return false
    }
  }
  return true
}

/** Printable ASCII, the same for the same length and seed. */
function sample(length: number, seed: number): string {
  let state = seed
  let out = ''
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    out += String.fromCharCode(33 + ((state >>> 16) % 94))
  }
  return out
}

/** 32-bit FNV-1a as eight hex digits. */
function fnv(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function preview(text: string): string {
  const quoted = JSON.stringify(text)
  return quoted.length > 34 ? `${quoted.slice(0, 31)}…"` : quoted
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('symbols match an independent encoder', () => {
  test('the vectors span versions 1, 2, 5, 7 and 10 and all four levels', () => {
    const versions = new Set(VECTORS.map(v => v.version))
    for (const version of [1, 2, 5, 7, 10])
      expect(versions.has(version)).toBe(true)
    expect(new Set(VECTORS.map(v => v.ecc))).toEqual(new Set(LEVELS))
  })

  for (const v of VECTORS) {
    test(`${preview(v.text)} at ${v.ecc}: version ${v.version}, mask ${v.mask}`, () => {
      const symbol = qrEncode(v.text, { ecc: v.ecc })
      expect(symbol.version).toBe(v.version)
      expect(symbol.ecc).toBe(v.ecc)
      expect(symbol.mask).toBe(v.mask)
      expect(symbol.modules.length).toBe(v.version * 4 + 17)
      for (const row of symbol.modules) {
        expect(row.length).toBe(symbol.modules.length)
      }
      expect(hex(symbol.modules)).toBe(v.hex)
      expect(hex(qrMatrix(v.text, v.ecc))).toBe(v.hex)
    })
  }

  test('each of the eight masks, forced, on one version-2 symbol', () => {
    for (let mask = 0; mask < 8; mask++) {
      const symbol = qrEncode(FORCED_TEXT, { ecc: 'Q', mask })
      expect(symbol.version).toBe(2)
      expect(symbol.mask).toBe(mask)
      expect(hex(symbol.modules)).toBe(FORCED[mask])
    }
  })

  test('level M when none is asked', () => {
    const wxpay = VECTORS.find(v => v.text.startsWith('weixin://'))
    expect(wxpay?.ecc).toBe('M')
    expect(hex(qrMatrix(wxpay?.text ?? ''))).toBe(wxpay?.hex ?? '')
    expect(qrEncode(wxpay?.text ?? '').ecc).toBe('M')
  })
})

describe('every version at every level', () => {
  for (const [index, ecc] of LEVELS.entries()) {
    test(`level ${ecc}: versions 1–40 choose qrcodegen's mask and draw its symbol`, () => {
      for (let version = 1; version <= 40; version++) {
        const low = version === 1 ? 0 : CAPACITY[ecc][version - 2] + 1
        const length = Math.floor((low + CAPACITY[ecc][version - 1]) / 2)
        const symbol = qrEncode(sample(length, version * 4 + index), { ecc })
        const at = version - 1
        const expected = `${SWEEP[ecc].masks[at]} ${SWEEP[ecc].hashes.slice(at * 8, at * 8 + 8)}`
        expect(`v${version}: ${symbol.version}`).toBe(`v${version}: ${version}`)
        expect(`v${version}: ${symbol.mask} ${fnv(hex(symbol.modules))}`).toBe(
          `v${version}: ${expected}`,
        )
      }
    })
  }
})

describe('structure, read back as a decoder reads it', () => {
  const symbols = VECTORS.map(v => qrEncode(v.text, { ecc: v.ecc }))

  test('finders and separators, timing patterns and the dark module', () => {
    for (const { modules } of symbols) {
      const size = modules.length
      expect(hasFinder(modules, 0, 0)).toBe(true)
      expect(hasFinder(modules, 0, size - 7)).toBe(true)
      expect(hasFinder(modules, size - 7, 0)).toBe(true)
      for (let i = 8; i < size - 8; i++) {
        expect(modules[6][i]).toBe(i % 2 === 0)
        expect(modules[i][6]).toBe(i % 2 === 0)
      }
      expect(modules[size - 8][8]).toBe(true)
    }
  })

  test('alignment patterns at the Annex E centres', () => {
    for (const { version, modules } of symbols) {
      const centres = ALIGNMENT[version]
      expect(centres).toBeDefined()
      const last = (centres?.length ?? 0) - 1
      centres?.forEach((row, i) => {
        centres.forEach((col, j) => {
          const underFinder =
            (i === 0 && (j === 0 || j === last)) || (i === last && j === 0)
          if (!underFinder) expect(hasAlignment(modules, row, col)).toBe(true)
        })
      })
    }
  })

  test('format information: both copies carry the Annex C code, which BCH-decodes to the level and mask', () => {
    for (const ecc of LEVELS) {
      for (let mask = 0; mask < 8; mask++) {
        const { modules } = qrEncode(FORCED_TEXT, { ecc, mask })
        const [first, second] = formatCells(modules.length)
        const code = read(modules, first)
        expect(read(modules, second)).toBe(code)
        expect(code).toBe(FORMAT_CODES[ecc][mask])
        const unmasked = code ^ 0x5412
        expect(gf2Remainder(unmasked, 0x537)).toBe(0)
        expect(unmasked >>> 10).toBe((LEVEL_BITS[ecc] << 3) | mask)
      }
    }
  })

  test('format information follows the chosen mask when the encoder chooses', () => {
    for (const symbol of symbols) {
      const [first] = formatCells(symbol.modules.length)
      expect(read(symbol.modules, first)).toBe(
        FORMAT_CODES[symbol.ecc][symbol.mask],
      )
    }
  })

  test('version information from version 7: both blocks carry the Annex D code', () => {
    const large = symbols.filter(s => s.version >= 7)
    expect(large.map(s => s.version)).toEqual([7, 10])
    for (const { version, modules } of large) {
      const [bottomLeft, topRight] = versionCells(modules.length)
      const code = read(modules, bottomLeft)
      expect(read(modules, topRight)).toBe(code)
      expect(code).toBe(VERSION_CODES[version] ?? -1)
      expect(gf2Remainder(code, 0x1f25)).toBe(0)
      expect(code >>> 12).toBe(version)
    }
  })
})

describe('capacity', () => {
  for (const ecc of LEVELS) {
    test(`level ${ecc}: each version holds its Table 7 byte count, and one byte more moves up`, () => {
      CAPACITY[ecc].forEach((max, i) => {
        const version = i + 1
        // A forced mask skips the penalty search; only the version is at issue.
        expect(qrEncode('a'.repeat(max), { ecc, mask: 0 }).version).toBe(
          version,
        )
        const over = 'a'.repeat(max + 1)
        if (version < 40) {
          expect(qrEncode(over, { ecc, mask: 0 }).version).toBe(version + 1)
        } else {
          expect(() => qrEncode(over, { ecc, mask: 0 })).toThrow(
            QrCapacityError,
          )
        }
      })
    })
  }

  test('capacity counts UTF-8 bytes, not characters', () => {
    // 支 is three bytes; version 1 at L holds 17.
    expect(qrEncode('支'.repeat(5), { ecc: 'L' }).version).toBe(1)
    expect(qrEncode('支'.repeat(6), { ecc: 'L' }).version).toBe(2)
  })

  test('too long for version 40 is a QrCapacityError that says by how much', () => {
    let caught: unknown
    try {
      qrMatrix('a'.repeat(2332))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(QrCapacityError)
    expect(caught).toBeInstanceOf(Error)
    const error = caught as QrCapacityError
    expect(error.name).toBe('QrCapacityError')
    expect(error.bytes).toBe(2332)
    expect(error.ecc).toBe('M')
    expect(error.max).toBe(2331)
    expect(error.message).toContain('2332')
    expect(() => qrSvg('a'.repeat(1274), { ecc: 'H' })).toThrow(QrCapacityError)
  })

  test('a level or mask outside the spec is refused', () => {
    const bogus: string = 'X'
    expect(() => qrMatrix('x', bogus as QrEcc)).toThrow(RangeError)
    expect(() => qrEncode('x', { mask: 8 })).toThrow(RangeError)
    expect(() => qrEncode('x', { mask: -1 })).toThrow(RangeError)
    expect(() => qrEncode('x', { mask: 1.5 })).toThrow(RangeError)
  })
})

describe('qrSvg', () => {
  const WXPAY = 'weixin://wxpay/bizpayurl?pr=AbCdEfG'
  const ALIPAY = 'https://qr.alipay.com/bax01234abcdEFGHijkl5678'

  /** The `d` of the one path, and the runs it is made of. */
  function runs(svg: string): { d: string; cells: Cell[]; parsed: string } {
    const d = /<path fill="#000" d="([^"]*)"\/>/.exec(svg)?.[1] ?? ''
    const cells: Cell[] = []
    let parsed = ''
    for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
      parsed += m[0]
      const [x, y, w, back] = [m[1], m[2], m[3], m[4]].map(Number)
      expect(back).toBe(w)
      for (let i = 0; i < w; i++) cells.push([y, x + i])
    }
    return { d, cells, parsed }
  }

  test('the root element, a white ground and one black path', () => {
    const svg = qrSvg(WXPAY)
    const side = qrMatrix(WXPAY).length + 8
    expect(
      svg.startsWith(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" role="img" aria-label="二维码" shape-rendering="crispEdges">`,
      ),
    ).toBe(true)
    expect(svg).toContain(
      `<rect width="${side}" height="${side}" fill="#fff"/>`,
    )
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg.match(/<rect/g)?.length).toBe(1)
    expect(svg.match(/<path/g)?.length).toBe(1)
    expect(svg.match(/fill="/g)?.length).toBe(2)
    expect(runs(svg).d.length).toBeGreaterThan(0)
  })

  test('the view box is the symbol plus the quiet zone on both sides', () => {
    for (const [text, ecc] of [
      [WXPAY, 'M'],
      [ALIPAY, 'H'],
    ] as const) {
      const size = qrMatrix(text, ecc).length
      for (const quiet of [0, 2, 4, 10]) {
        const side = size + 2 * quiet
        expect(qrSvg(text, { ecc, quiet })).toContain(
          `viewBox="0 0 ${side} ${side}"`,
        )
      }
      expect(qrSvg(text, { ecc })).toContain(
        `viewBox="0 0 ${size + 8} ${size + 8}"`,
      )
    }
  })

  test('the path covers exactly the dark modules, offset by the quiet zone', () => {
    for (const quiet of [0, 4]) {
      const modules = qrMatrix(ALIPAY, 'Q')
      const { d, cells, parsed } = runs(qrSvg(ALIPAY, { ecc: 'Q', quiet }))
      expect(parsed).toBe(d)
      const drawn = new Set(
        cells.map(([row, col]) => `${row - quiet},${col - quiet}`),
      )
      expect(drawn.size).toBe(cells.length)
      let dark = 0
      modules.forEach((line, row) => {
        line.forEach((on, col) => {
          if (on) dark++
          expect(drawn.has(`${row},${col}`)).toBe(on)
        })
      })
      expect(cells.length).toBe(dark)
    }
  })

  test('nothing that loads, links, styles or runs, whatever the label or text', () => {
    const hostile = `"><script>alert(1)</script><style>@import url(x)</style>`
    for (const svg of [
      qrSvg(WXPAY),
      qrSvg(ALIPAY, { ecc: 'H', label: hostile }),
      qrSvg('javascript:alert(1)//<script>url(x)', {
        label: '<use href="#x"/>',
      }),
    ]) {
      for (const banned of [
        'url(',
        '<script',
        '<style',
        '<image',
        '<use',
        '<foreignObject',
      ]) {
        expect(svg).not.toContain(banned)
      }
      // The payload is drawn, never written out.
      expect(svg).not.toContain('bizpayurl')
      expect(svg).not.toContain('alipay')
      // Outside the escaped label everything is fixed markup and numbers:
      // no link of any kind, and the namespace is the one URL.
      const markup = svg.replace(/ aria-label="[^"]*"/, '')
      for (const banned of ['xlink', 'href', 'javascript:', 'data:']) {
        expect(markup).not.toContain(banned)
      }
      expect(markup).not.toMatch(/\son\w+=/)
      expect(markup.match(/https?:\/\//g)).toEqual(['http://'])
    }
  })

  test('the label is escaped for a double-quoted attribute', () => {
    const svg = qrSvg(WXPAY, { label: `微信支付 "a" <b> & 'c' \`d\` (e)` })
    expect(svg).toContain(
      'aria-label="微信支付 &quot;a&quot; &lt;b&gt; &amp; &#39;c&#39; &#96;d&#96; &#40;e&#41;"',
    )
  })

  test('a quiet zone that is not a whole number of modules is refused', () => {
    for (const quiet of [-1, 1.5, Number.NaN]) {
      expect(() => qrSvg(WXPAY, { quiet })).toThrow(RangeError)
    }
  })
})
