// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Drawing a 形象 (`../avatar.ts`) as inline SVG, and the editor that picks one.
 *
 * The look is deliberately quiet: one soft body in a muted colour, small ink
 * features, accessories in a single line weight. Character comes from motion
 * rather than detail — the figure breathes, blinks and glances, and its
 * **state** (`data-state` on the `<svg>`) changes what it does:
 *
 * | state | 待机 idle | 倾听 listening | 思考 thinking | 回复 speaking | 完成 happy | 出错 error | 休眠 sleep |
 * |---|---|---|---|---|---|---|---|
 * | eyes | its own | its own, wider | look up | its own | arcs | low, brows | closed |
 * | body | breathes | leans in | sways | bobs | hops | droops, greys | slow breath, greys |
 * | extra | — | — | three dots | a talking mouth | two sparks | — | z z |
 *
 * Every expression is in the markup at once and CSS shows the one the state
 * asks for, so a state change is an attribute flip that animates — no
 * redraw. Under `prefers-reduced-motion` the expressions still change and
 * nothing moves.
 *
 * Two weights: **rich** (a `uid` is given) has a soft gradient, a blurred
 * shadow and, for 绒, a fine displacement on the outline, all as `url(#…)`
 * references to its own `<defs>` named from `uid`; **flat** has no
 * definitions at all — the size a transcript repeats on every turn.
 */

import {
  AVATAR_ACCESSORIES,
  AVATAR_COLORS,
  AVATAR_EYES,
  AVATAR_HEX,
  AVATAR_MATERIALS,
  AVATAR_MOUTHS,
  AVATAR_SHAPES,
  AVATAR_STATES,
  AVATAR_WORDS,
  type AvatarAccessory,
  type AvatarShape,
  type AvatarSpec,
  type AvatarState,
  avatarHash,
} from '../avatar.js'
import { icon } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { dialogTop } from './kit.js'

// ---------------------------------------------------------------------------
// colour
// ---------------------------------------------------------------------------

function channels(hex: string): readonly [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function toHex(rgb: readonly number[]): string {
  return `#${rgb
    .map(part =>
      Math.max(0, Math.min(255, Math.round(part)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

/** `amount` of the way to white (positive) or black (negative). */
function shade(hex: string, amount: number): string {
  const target = amount >= 0 ? 255 : 0
  const share = Math.abs(amount)
  return toHex(channels(hex).map(part => part + (target - part) * share))
}

const INK = '#2b2830'
const PAPER = '#f6f1ea'

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

/** Where the face and the hat go on one body, in the 120 × 120 box. */
interface Body {
  readonly d: string
  /** The body's highest point at the centre line. */
  readonly top: number
  /** The lowest point; the shadow sits just under it. */
  readonly bottom: number
  readonly eyeY: number
  readonly eyeDX: number
  readonly mouthY: number
  readonly cheekDX: number
  /** Half the body's width at eye height, for the headphones. */
  readonly side: number
}

function num(value: number): string {
  return (Math.round(value * 10) / 10).toString()
}

/**
 * A closed smooth outline through `points`: each sample is a control point
 * and the curve passes through the midpoints between them, so a sampled
 * shape comes out round rather than faceted.
 */
function smooth(points: readonly (readonly [number, number])[]): string {
  const count = points.length
  const at = (index: number) => points[index % count] ?? [0, 0]
  const mid = (a: readonly [number, number], b: readonly [number, number]) =>
    [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const
  const first = mid(at(count - 1), at(0))
  let d = `M${num(first[0])} ${num(first[1])}`
  for (let index = 0; index < count; index += 1) {
    const point = at(index)
    const next = mid(point, at(index + 1))
    d += `Q${num(point[0])} ${num(point[1])} ${num(next[0])} ${num(next[1])}`
  }
  return `${d}Z`
}

function sampled(
  steps: number,
  point: (t: number) => readonly [number, number],
): string {
  const points: (readonly [number, number])[] = []
  for (let index = 0; index < steps; index += 1) {
    points.push(point((index / steps) * Math.PI * 2))
  }
  return smooth(points)
}

function superellipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  power: number,
): string {
  return sampled(72, t => {
    const c = Math.cos(t)
    const s = Math.sin(t)
    return [
      cx + rx * Math.sign(c) * Math.abs(c) ** power,
      cy + ry * Math.sign(s) * Math.abs(s) ** power,
    ]
  })
}

const BODIES: Readonly<Record<AvatarShape, Body>> = {
  orb: {
    d: superellipse(60, 64, 37, 35, 0.92),
    top: 29,
    bottom: 99,
    eyeY: 62,
    eyeDX: 9.5,
    mouthY: 72,
    cheekDX: 18,
    side: 37,
  },
  capsule: {
    d: superellipse(60, 62, 27, 38, 0.62),
    top: 24,
    bottom: 100,
    eyeY: 55,
    eyeDX: 8.5,
    mouthY: 65,
    cheekDX: 15,
    side: 27,
  },
  drop: {
    d: sampled(72, t => [
      60 + 34 * Math.sin(t) * Math.sin(t / 2) ** 1.15,
      63 - 38 * Math.cos(t),
    ]),
    top: 25,
    bottom: 101,
    eyeY: 72,
    eyeDX: 9,
    mouthY: 81,
    cheekDX: 16,
    side: 26,
  },
  cloud: {
    d: sampled(96, t => {
      const theta = t - Math.PI / 2
      const r = 33.5 + 2.8 * Math.abs(Math.cos(3.5 * t))
      return [60 + r * Math.cos(theta), 65 + r * Math.sin(theta) * 0.94]
    }),
    top: 30,
    bottom: 97,
    eyeY: 64,
    eyeDX: 10,
    mouthY: 74,
    cheekDX: 19,
    side: 35,
  },
  pebble: {
    d: sampled(72, t => {
      // An egg, wider below, leaning a few degrees: the one shape that is
      // not symmetric, so a page of them is not all mirrors.
      const x = 34 * Math.cos(t) * (1 + 0.09 * Math.sin(t))
      const y = 33 * Math.sin(t)
      const lean = -0.12
      return [
        60 + x * Math.cos(lean) - y * Math.sin(lean),
        65 + x * Math.sin(lean) + y * Math.cos(lean),
      ]
    }),
    top: 31,
    bottom: 98,
    eyeY: 63,
    eyeDX: 9.5,
    mouthY: 73,
    cheekDX: 18,
    side: 34,
  },
  squircle: {
    d: superellipse(60, 65, 35, 33, 0.38),
    top: 32,
    bottom: 98,
    eyeY: 63,
    eyeDX: 10,
    mouthY: 73,
    cheekDX: 19,
    side: 35,
  },
}

// ---------------------------------------------------------------------------
// face
// ---------------------------------------------------------------------------

function line(d: string, ink: string, width = 2.2): string {
  return `<path d="${d}" fill="none" stroke="${ink}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`
}

/** One eye of the figure's own kind, centred on (x, y), in `ink`. */
function eye(
  kind: AvatarSpec['eyes'],
  x: number,
  y: number,
  ink: string,
): string {
  switch (kind) {
    case 'dot':
      return `<circle cx="${num(x)}" cy="${num(y)}" r="3.4" fill="${ink}"/>`
    case 'oval':
      return `<ellipse cx="${num(x)}" cy="${num(y)}" rx="2.5" ry="4.3" fill="${ink}"/>`
    case 'wide':
      return (
        `<circle cx="${num(x)}" cy="${num(y)}" r="4.6" fill="${ink}"/>` +
        `<circle cx="${num(x + 1.5)}" cy="${num(y - 1.6)}" r="1.4" fill="#fff"/>`
      )
    case 'square':
      return `<rect x="${num(x - 3)}" y="${num(y - 3)}" width="6" height="6" rx="1.6" fill="${ink}"/>`
    case 'ring':
      return `<circle cx="${num(x)}" cy="${num(y)}" r="3.4" fill="none" stroke="${ink}" stroke-width="2"/>`
    case 'spark':
      return (
        `<path d="M${num(x)} ${num(y - 4.6)}Q${num(x + 0.8)} ${num(y - 0.8)} ${num(x + 4.6)} ${num(y)}` +
        `Q${num(x + 0.8)} ${num(y + 0.8)} ${num(x)} ${num(y + 4.6)}Q${num(x - 0.8)} ${num(y + 0.8)} ${num(x - 4.6)} ${num(y)}` +
        `Q${num(x - 0.8)} ${num(y - 0.8)} ${num(x)} ${num(y - 4.6)}Z" fill="${ink}"/>`
      )
  }
}

function pair(
  body: Body,
  draw: (x: number, y: number, side: -1 | 1) => string,
): string {
  return (
    draw(60 - body.eyeDX, body.eyeY, -1) + draw(60 + body.eyeDX, body.eyeY, 1)
  )
}

/** All four expressions; CSS shows the one the state asks for. */
function expressions(spec: AvatarSpec, body: Body, ink: string): string {
  const own = pair(body, (x, y) => eye(spec.eyes, x, y, ink))
  const happy = pair(body, (x, y) =>
    line(
      `M${num(x - 3.8)} ${num(y + 1.2)}Q${num(x)} ${num(y - 3.6)} ${num(x + 3.8)} ${num(y + 1.2)}`,
      ink,
    ),
  )
  const closed = pair(body, (x, y) =>
    line(
      `M${num(x - 3.8)} ${num(y)}Q${num(x)} ${num(y + 2.6)} ${num(x + 3.8)} ${num(y)}`,
      ink,
    ),
  )
  const low = pair(
    body,
    (x, y, side) =>
      `<circle cx="${num(x)}" cy="${num(y + 1.5)}" r="2.6" fill="${ink}"/>` +
      line(
        side < 0
          ? `M${num(x - 3.8)} ${num(y - 5.4)}L${num(x + 2.6)} ${num(y - 3.6)}`
          : `M${num(x - 2.6)} ${num(y - 3.6)}L${num(x + 3.8)} ${num(y - 5.4)}`,
        ink,
        1.8,
      ),
  )
  return (
    `<g class="av-eyes av-eyes-own">${own}</g>` +
    `<g class="av-eyes av-eyes-happy">${happy}</g>` +
    `<g class="av-eyes av-eyes-closed">${closed}</g>` +
    `<g class="av-eyes av-eyes-low">${low}</g>`
  )
}

function mouthOf(spec: AvatarSpec, body: Body, ink: string): string {
  const y = body.mouthY
  switch (spec.mouth) {
    case 'none':
      return ''
    case 'smile':
      return line(`M56 ${num(y)}Q60 ${num(y + 3.4)} 64 ${num(y)}`, ink, 2)
    case 'dot':
      return `<circle cx="60" cy="${num(y + 1)}" r="1.7" fill="${ink}"/>`
    case 'cat':
      return line(
        `M55 ${num(y)}Q57.5 ${num(y + 3)} 60 ${num(y)}Q62.5 ${num(y + 3)} 65 ${num(y)}`,
        ink,
        1.8,
      )
  }
}

function cheeksOf(spec: AvatarSpec, body: Body): string {
  if (!spec.cheeks) return ''
  const y = num(body.eyeY + 6)
  return (
    `<ellipse cx="${num(60 - body.cheekDX)}" cy="${y}" rx="4.2" ry="2.4" fill="#f08a8a" opacity=".3"/>` +
    `<ellipse cx="${num(60 + body.cheekDX)}" cy="${y}" rx="4.2" ry="2.4" fill="#f08a8a" opacity=".3"/>`
  )
}

// ---------------------------------------------------------------------------
// accessories: one line weight, ink or a single accent
// ---------------------------------------------------------------------------

function accessoryOf(
  kind: AvatarAccessory,
  body: Body,
  ink: string,
  accent: string,
): string {
  const t = body.top
  switch (kind) {
    case 'none':
      return ''
    case 'beret':
      return (
        `<path d="M41 ${num(t + 6)}C42 ${num(t - 4)} 82 ${num(t - 8)} 86 ${num(t + 3)}` +
        `C80 ${num(t + 8)} 50 ${num(t + 11)} 41 ${num(t + 6)}Z" fill="${ink}"/>` +
        line(`M65 ${num(t - 4)}L66 ${num(t - 8.5)}`, ink, 2.6)
      )
    case 'headphones': {
      const left = 60 - body.side + 0.5
      const right = 60 + body.side - 0.5
      const y = body.eyeY - 2
      return (
        line(
          `M${num(left)} ${num(y)}C${num(left)} ${num(t - 14)} ${num(right)} ${num(t - 14)} ${num(right)} ${num(y)}`,
          ink,
          2.6,
        ) +
        `<rect x="${num(left - 5)}" y="${num(y - 5)}" width="9" height="14" rx="4.5" fill="${ink}"/>` +
        `<rect x="${num(right - 4)}" y="${num(y - 5)}" width="9" height="14" rx="4.5" fill="${ink}"/>`
      )
    }
    case 'halo':
      return `<ellipse class="av-halo" cx="60" cy="${num(t - 8)}" rx="15" ry="3.6" fill="none" stroke="${accent}" stroke-width="2.4"/>`
    case 'antenna':
      return (
        line(`M60 ${num(t + 1)}L60 ${num(t - 10)}`, ink, 2) +
        `<circle class="av-bulb" cx="60" cy="${num(t - 13)}" r="3.2" fill="${accent}"/>`
      )
    case 'sprout':
      return (
        line(
          `M60 ${num(t + 1)}Q59.5 ${num(t - 5)} 60.5 ${num(t - 9)}`,
          '#6f9a5f',
          2,
        ) +
        `<path d="M60.5 ${num(t - 9)}C55 ${num(t - 9)} 51 ${num(t - 12)} 50 ${num(t - 16)}C55.5 ${num(t - 16.5)} 59.5 ${num(t - 13)} 60.5 ${num(t - 9)}Z" fill="#86b274"/>` +
        `<path d="M60.5 ${num(t - 9)}C65 ${num(t - 10)} 69 ${num(t - 13)} 70 ${num(t - 18)}C64.5 ${num(t - 18)} 61 ${num(t - 14)} 60.5 ${num(t - 9)}Z" fill="#9cc489"/>`
      )
    case 'glasses': {
      const y = body.eyeY
      const left = 60 - body.eyeDX
      const right = 60 + body.eyeDX
      return (
        `<circle cx="${num(left)}" cy="${num(y)}" r="6.4" fill="none" stroke="${ink}" stroke-width="1.7"/>` +
        `<circle cx="${num(right)}" cy="${num(y)}" r="6.4" fill="none" stroke="${ink}" stroke-width="1.7"/>` +
        line(
          `M${num(left + 6.4)} ${num(y)}L${num(right - 6.4)} ${num(y)}`,
          ink,
          1.7,
        )
      )
    }
  }
}

/** The things only a state shows: thinking dots, a talking mouth, sparks, z z. */
function overlays(body: Body, ink: string): string {
  const t = body.top
  const spark = (x: number, y: number, r: number) =>
    `<path d="M${num(x)} ${num(y - r)}Q${num(x + r * 0.18)} ${num(y - r * 0.18)} ${num(x + r)} ${num(y)}` +
    `Q${num(x + r * 0.18)} ${num(y + r * 0.18)} ${num(x)} ${num(y + r)}Q${num(x - r * 0.18)} ${num(y + r * 0.18)} ${num(x - r)} ${num(y)}` +
    `Q${num(x - r * 0.18)} ${num(y - r * 0.18)} ${num(x)} ${num(y - r)}Z" fill="#e9b949"/>`
  const zed = (x: number, y: number, s: number) =>
    line(
      `M${num(x)} ${num(y)}h${num(s)}l${num(-s)} ${num(s * 1.1)}h${num(s)}`,
      ink,
      1.6,
    )
  return (
    `<g class="av-think">` +
    `<circle cx="${num(82)}" cy="${num(t - 2)}" r="2.1" fill="${ink}"/>` +
    `<circle cx="${num(90)}" cy="${num(t - 8)}" r="2.6" fill="${ink}"/>` +
    `<circle cx="${num(99)}" cy="${num(t - 15)}" r="3.1" fill="${ink}"/>` +
    `</g>` +
    `<g class="av-sparks">${spark(30, t + 6, 4.5)}${spark(92, t - 2, 3.4)}</g>` +
    `<g class="av-zzz">${zed(80, t - 6, 4.4)}${zed(90, t - 16, 5.6)}</g>`
  )
}

// ---------------------------------------------------------------------------
// the figure
// ---------------------------------------------------------------------------

export interface AvatarDrawOptions {
  /** Pixels on a side. */
  readonly size: number
  /**
   * Turns on the rich drawing, and names its definitions. Unique per figure
   * on a page.
   */
  readonly uid?: string
  /** Moves: breathes, blinks, and plays its state (rich only). */
  readonly live?: boolean
  readonly state?: AvatarState
  /** The accessible name; absent marks the figure decorative. */
  readonly label?: string
  readonly className?: string
}

/** A short name for a figure: 雾蓝云. */
export function avatarWords(spec: AvatarSpec): string {
  return `${AVATAR_WORDS.color[spec.color]}${AVATAR_WORDS.shape[spec.shape]}`
}

/** Which figure this is, so a script can tell a redraw of the same one. */
export function avatarFace(spec: AvatarSpec): string {
  return avatarHash(JSON.stringify(spec)).toString(36)
}

/** One figure as an inline `<svg>`. */
export function avatarSvg(
  spec: AvatarSpec,
  options: AvatarDrawOptions,
): string {
  const body = BODIES[spec.shape]
  const base = AVATAR_HEX[spec.color]
  const ink = spec.color === 'ink' ? PAPER : INK
  const accent =
    spec.color === 'sand' || spec.color === 'apricot' ? '#d9774f' : '#e9b949'
  const rich = options.uid !== undefined
  const state = options.state ?? 'idle'
  const classes = [
    'avatar',
    rich && options.live === true ? 'av-live' : '',
    options.className ?? '',
  ]
    .filter(one => one !== '')
    .join(' ')
  const a11y =
    options.label === undefined
      ? ' aria-hidden="true"'
      : ` role="img" aria-label="${attr(options.label)}"`
  const open =
    `<svg class="${classes}" width="${options.size}" height="${options.size}" ` +
    `viewBox="0 0 120 120" data-state="${state}" data-face="${avatarFace(spec)}"${a11y}>`
  const face =
    `<g class="av-face">` +
    cheeksOf(spec, body) +
    expressions(spec, body, ink) +
    `<g class="av-mouth">${mouthOf(spec, body, ink)}</g>` +
    `<ellipse class="av-talk" cx="60" cy="${num(body.mouthY + 1.5)}" rx="2.6" ry="2.2" fill="${ink}"/>` +
    `</g>`
  const hat = accessoryOf(spec.accessory, body, ink, accent)
  const shadowY = num(body.bottom + 4)
  if (!rich) {
    return (
      open +
      `<ellipse class="av-shadow" cx="60" cy="${shadowY}" rx="22" ry="3" fill="#000" opacity=".08"/>` +
      `<g class="av-body">` +
      `<path d="${body.d}" fill="${base}"/>` +
      face +
      hat +
      `</g></svg>`
    )
  }
  const u = options.uid ?? ''
  const glaze = spec.material === 'glaze'
  const plush = spec.material === 'plush'
  const seed = (avatarHash(u) % 97) + 1
  const defs =
    `<defs>` +
    `<radialGradient id="${u}-b" cx="34%" cy="26%" r="82%">` +
    `<stop offset="0" stop-color="${shade(base, glaze ? 0.42 : 0.26)}"/>` +
    `<stop offset=".62" stop-color="${base}"/>` +
    `<stop offset="1" stop-color="${shade(base, glaze ? -0.2 : -0.12)}"/>` +
    `</radialGradient>` +
    `<filter id="${u}-s" x="-50%" y="-300%" width="200%" height="700%">` +
    `<feGaussianBlur stdDeviation="2.6"/></filter>` +
    (plush
      ? `<filter id="${u}-f" x="-6%" y="-6%" width="112%" height="112%">` +
        `<feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="${seed}" result="n"/>` +
        `<feDisplacementMap in="SourceGraphic" in2="n" scale="2.6" xChannelSelector="R" yChannelSelector="G"/>` +
        `</filter>`
      : '') +
    `</defs>`
  const skin =
    `<path d="${body.d}" fill="url(#${u}-b)"${plush ? ` filter="url(#${u}-f)"` : ''}/>` +
    (glaze
      ? `<ellipse cx="${num(60 - body.side * 0.42)}" cy="${num(body.top + 11)}" rx="7" ry="3.4" ` +
        `transform="rotate(-24 ${num(60 - body.side * 0.42)} ${num(body.top + 11)})" fill="#fff" opacity=".55"/>`
      : '')
  return (
    open +
    defs +
    `<ellipse class="av-shadow" cx="60" cy="${shadowY}" rx="24" ry="3.6" ` +
    `fill="#000" opacity=".16" filter="url(#${u}-s)"/>` +
    `<g class="av-body">` +
    skin +
    face +
    hat +
    `</g>` +
    overlays(body, ink) +
    `</svg>`
  )
}

/**
 * Figures and their states. Every expression is drawn; these rules pick one.
 * The motion is all `transform` and `opacity`, and stops under reduced
 * motion while the expressions still change.
 */
export const AVATAR_CSS = `
.avatar { display: block; flex: none; overflow: visible; }
.avatar .av-body, .avatar .av-face, .avatar .av-shadow { transform-box: view-box; }
.avatar .av-body { transform-origin: 60px 100px; }
.avatar .av-shadow { transform-origin: 60px 102px; }
.avatar .av-eyes, .avatar .av-talk, .avatar .av-think, .avatar .av-sparks, .avatar .av-zzz, .avatar .av-mouth {
  transition: opacity 220ms ease;
}
.avatar .av-eyes-happy, .avatar .av-eyes-closed, .avatar .av-eyes-low,
.avatar .av-talk, .avatar .av-think, .avatar .av-sparks, .avatar .av-zzz { opacity: 0; }
.avatar .av-face { transition: transform 360ms cubic-bezier(.3, .7, .3, 1); }
.avatar .av-eyes-own { transform-box: fill-box; transform-origin: 50% 50%; transition: opacity 220ms ease, transform 260ms ease; }

.avatar[data-state="listening"] .av-eyes-own { transform: scale(1.14); }
.avatar[data-state="listening"] .av-face { transform: translate(0, -1px); }
.avatar[data-state="thinking"] .av-face { transform: translate(2.5px, -2.5px); }
.avatar[data-state="thinking"] .av-think { opacity: 1; }
.avatar[data-state="speaking"] .av-mouth { opacity: 0; }
.avatar[data-state="speaking"] .av-talk { opacity: 1; }
.avatar[data-state="happy"] .av-eyes-own { opacity: 0; }
.avatar[data-state="happy"] .av-eyes-happy { opacity: 1; }
.avatar[data-state="happy"] .av-sparks { opacity: 1; }
.avatar[data-state="error"] .av-eyes-own, .avatar[data-state="error"] .av-mouth { opacity: 0; }
.avatar[data-state="error"] .av-eyes-low { opacity: 1; }
.avatar[data-state="error"] .av-body { filter: saturate(.35); }
.avatar[data-state="sleep"] .av-eyes-own, .avatar[data-state="sleep"] .av-mouth { opacity: 0; }
.avatar[data-state="sleep"] .av-eyes-closed { opacity: 1; }
.avatar[data-state="sleep"] .av-zzz { opacity: 1; }
.avatar[data-state="sleep"] .av-body { filter: saturate(.55); }

.av-live .av-body { animation: av-breathe 4.2s ease-in-out infinite; }
.av-live .av-shadow { animation: av-shadow 4.2s ease-in-out infinite; }
.av-live .av-eyes-own { animation: av-blink 5.4s ease-in-out infinite; }
.av-live[data-state="idle"] .av-face { animation: av-glance 9s ease-in-out infinite; }
.av-live[data-state="listening"] .av-body { animation: av-lean 2.6s ease-in-out infinite; }
.av-live[data-state="thinking"] .av-body { animation: av-sway 3s ease-in-out infinite; }
.av-live[data-state="thinking"] .av-think circle { transform-box: fill-box; transform-origin: 50% 50%; animation: av-dot 1.2s ease-in-out infinite; }
.av-live[data-state="thinking"] .av-think circle:nth-child(2) { animation-delay: .18s; }
.av-live[data-state="thinking"] .av-think circle:nth-child(3) { animation-delay: .36s; }
.av-live[data-state="speaking"] .av-body { animation: av-bob .9s ease-in-out infinite; }
.av-live[data-state="speaking"] .av-talk { transform-box: fill-box; transform-origin: 50% 50%; animation: av-talk .36s ease-in-out infinite alternate; }
.av-live[data-state="happy"] .av-body { animation: av-hop 1.5s cubic-bezier(.3, .7, .3, 1) infinite; }
.av-live[data-state="happy"] .av-shadow { animation: av-hop-shadow 1.5s cubic-bezier(.3, .7, .3, 1) infinite; }
.av-live[data-state="happy"] .av-sparks path { transform-box: fill-box; transform-origin: 50% 50%; animation: av-twinkle 1.5s ease-in-out infinite; }
.av-live[data-state="happy"] .av-sparks path:nth-child(2) { animation-delay: .5s; }
.av-live[data-state="error"] .av-body { animation: av-droop 3.6s ease-in-out infinite; }
.av-live[data-state="sleep"] .av-body { animation: av-breathe 6s ease-in-out infinite; }
.av-live[data-state="sleep"] .av-eyes-own { animation: none; }
.av-live[data-state="sleep"] .av-zzz path { transform-box: fill-box; animation: av-float 3s ease-in-out infinite; }
.av-live[data-state="sleep"] .av-zzz path:nth-child(2) { animation-delay: 1.5s; }
.av-live .av-halo { transform-box: fill-box; transform-origin: 50% 50%; animation: av-halo 4.2s ease-in-out infinite; }
.av-live .av-bulb { animation: av-bulb 2.4s ease-in-out infinite; }

@keyframes av-breathe { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(.992, 1.022); } }
@keyframes av-shadow { 0%, 100% { transform: scale(1); } 50% { transform: scale(.94); } }
@keyframes av-blink { 0%, 93%, 100% { transform: scaleY(1); } 95.5% { transform: scaleY(.1); } }
@keyframes av-glance { 0%, 36%, 100% { transform: translate(0, 0); } 42%, 54% { transform: translate(2px, 0); } 62%, 74% { transform: translate(-2px, 0); } 80% { transform: translate(0, 0); } }
@keyframes av-lean { 0%, 100% { transform: rotate(-3deg) scale(1, 1.01); } 50% { transform: rotate(-4.5deg) scale(1, 1.025); } }
@keyframes av-sway { 0%, 100% { transform: rotate(-2deg); } 50% { transform: rotate(2deg); } }
@keyframes av-dot { 0%, 100% { opacity: .25; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-2px); } }
@keyframes av-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
@keyframes av-talk { from { transform: scaleY(.35); } to { transform: scaleY(1.1); } }
@keyframes av-hop {
  0%, 60%, 100% { transform: translateY(0) scale(1, 1); }
  12% { transform: translateY(1px) scale(1.04, .95); }
  30% { transform: translateY(-9px) scale(.97, 1.04); }
  48% { transform: translateY(0) scale(1.03, .97); }
}
@keyframes av-hop-shadow { 0%, 60%, 100% { transform: scale(1); opacity: .16; } 30% { transform: scale(.72); opacity: .08; } }
@keyframes av-twinkle { 0%, 100% { transform: scale(.6) rotate(0deg); opacity: .4; } 50% { transform: scale(1.1) rotate(45deg); opacity: 1; } }
@keyframes av-droop { 0%, 100% { transform: translateY(2px) scale(1.02, .96); } 50% { transform: translateY(2.5px) scale(1.025, .955); } }
@keyframes av-float { 0% { transform: translate(0, 2px); opacity: 0; } 30% { opacity: 1; } 100% { transform: translate(3px, -6px); opacity: 0; } }
@keyframes av-halo { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-1.5px); } }
@keyframes av-bulb { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
@media (prefers-reduced-motion: reduce) {
  .av-live .av-body, .av-live .av-shadow, .av-live .av-eyes-own, .av-live .av-face,
  .av-live .av-think circle, .av-live .av-talk, .av-live .av-sparks path,
  .av-live .av-zzz path, .av-live .av-halo, .av-live .av-bulb { animation: none; }
  .avatar .av-face, .avatar .av-eyes-own { transition: none; }
}

.av-editor { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: var(--space-6); align-items: start; }
.av-stage {
  position: sticky; top: 0; display: flex; flex-direction: column; align-items: center; gap: var(--space-3);
  padding: var(--space-5) var(--space-3) var(--space-4); border-radius: var(--radius-xl);
  background: var(--color-neutral-100);
}
.av-stage-name { font-family: var(--font-heading); font-size: var(--text-14); }
.av-states { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; }
.av-state {
  min-height: 26px; padding: 0 9px; border: 0; border-radius: var(--radius-pill); cursor: pointer;
  background: transparent; color: var(--color-muted); font-size: var(--text-11-5);
  transition: background-color 150ms ease, color 150ms ease;
}
.av-state:hover { color: var(--color-text); }
.av-state[aria-pressed="true"] { background: var(--color-text); color: var(--color-bg); }
.av-groups { display: flex; flex-direction: column; gap: var(--space-4); max-height: min(60vh, 520px); overflow-y: auto; padding: 2px var(--space-1) 2px 2px; }
.av-group { display: grid; grid-template-columns: 56px minmax(0, 1fr); align-items: center; gap: var(--space-3); border: 0; margin: 0; padding: 0; min-width: 0; }
.av-group > legend { float: left; padding: 0; font-size: var(--text-12); color: var(--color-muted); }
.av-choices { display: flex; flex-wrap: wrap; gap: 6px; }
.av-choice { position: relative; display: inline-flex; cursor: pointer; }
.av-choice input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.av-opt {
  display: grid; place-items: center; min-width: 38px; height: 38px; padding: 0 10px; border-radius: 12px;
  background: var(--color-bg); color: var(--color-quiet, var(--color-muted)); font-size: var(--text-12-5, 12.5px);
  transition: background-color 150ms ease, color 150ms ease, transform 150ms ease;
}
.av-opt svg { display: block; }
.av-choice:hover .av-opt { color: var(--color-text); }
.av-choice input:checked + .av-opt { background: var(--color-text); color: var(--color-bg); }
.av-choice input:focus-visible + .av-opt, .av-choice input:focus-visible + .av-swatch { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.av-swatch { width: 26px; height: 26px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgb(0 0 0 / .08); transition: box-shadow 150ms ease, transform 150ms ease; }
.av-choice:hover .av-swatch { transform: scale(1.08); }
.av-choice input:checked + .av-swatch { box-shadow: 0 0 0 2px var(--color-bg), 0 0 0 3.5px var(--color-text); }
.av-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap; }
@media (max-width: 700px) {
  .av-editor { grid-template-columns: minmax(0, 1fr); }
  .av-stage { position: static; }
  .av-groups { max-height: none; }
  .av-group { grid-template-columns: minmax(0, 1fr); gap: var(--space-2); }
}
`

// ---------------------------------------------------------------------------
// the editor
// ---------------------------------------------------------------------------

function radio(
  name: string,
  value: string,
  checked: boolean,
  label: string,
): string {
  return (
    `<input type="radio" name="${attr(name)}" value="${attr(value)}"` +
    `${checked ? ' checked' : ''} aria-label="${attr(label)}">`
  )
}

function group(legend: string, choices: string): string {
  return (
    `<fieldset class="av-group"><legend>${escapeHtml(legend)}</legend>` +
    `<div class="av-choices">${choices}</div></fieldset>`
  )
}

/** A small monochrome drawing of one choice, in the chip's own colour. */
function glyph(viewBox: string, inner: string, size = 26): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="${viewBox}" aria-hidden="true">` +
    `${inner}</svg>`
  )
}

const GLYPH_BODY = BODIES.orb

function shapeGlyph(shape: AvatarShape): string {
  return glyph(
    '18 18 84 90',
    `<path d="${BODIES[shape].d}" fill="currentColor"/>`,
    24,
  )
}

function eyesGlyph(kind: AvatarSpec['eyes']): string {
  return glyph(
    '44 52 32 20',
    pair(GLYPH_BODY, (x, y) => eye(kind, x, y, 'currentColor')),
    30,
  )
}

function mouthGlyph(kind: AvatarSpec['mouth']): string {
  if (kind === 'none') return escapeHtml(AVATAR_WORDS.mouth.none)
  return glyph(
    '50 64 20 16',
    mouthOf({ ...SAMPLE, mouth: kind }, GLYPH_BODY, 'currentColor'),
    24,
  )
}

function accessoryGlyph(kind: AvatarAccessory): string {
  if (kind === 'none') return escapeHtml(AVATAR_WORDS.accessory.none)
  return glyph(
    '14 8 92 96',
    `<path d="${GLYPH_BODY.d}" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="3"/>` +
      accessoryOf(kind, GLYPH_BODY, 'currentColor', 'currentColor').replace(
        /fill="#[0-9a-f]{6}"|stroke="#[0-9a-f]{6}"/g,
        found =>
          found.startsWith('fill')
            ? 'fill="currentColor"'
            : 'stroke="currentColor"',
      ),
    28,
  )
}

const SAMPLE: AvatarSpec = {
  shape: 'orb',
  color: 'mist',
  material: 'matte',
  eyes: 'dot',
  mouth: 'none',
  cheeks: false,
  accessory: 'none',
}

function options<K extends keyof AvatarSpec>(
  key: K,
  values: readonly AvatarSpec[K][],
  words: Readonly<Record<string, string>>,
  spec: AvatarSpec,
  draw: (value: AvatarSpec[K]) => string,
): string {
  return values
    .map(value => {
      const word = words[String(value)] ?? String(value)
      return (
        `<label class="av-choice" title="${attr(word)}">` +
        radio(key, String(value), spec[key] === value, word) +
        `<span class="av-opt">${draw(value)}</span></label>`
      )
    })
    .join('')
}

/**
 * The editor's body for one figure: the stage, with the states to try, on
 * the left; every choice as a small monochrome chip on the right. Redrawn by
 * the server on every pick (`/fragments/avatar`).
 */
export function renderAvatarEditor(spec: AvatarSpec, name: string): string {
  const swatches = AVATAR_COLORS.map(
    color =>
      `<label class="av-choice" title="${attr(AVATAR_WORDS.color[color])}">` +
      radio('color', color, spec.color === color, AVATAR_WORDS.color[color]) +
      `<span class="av-swatch" style="background:${AVATAR_HEX[color]}"></span></label>`,
  ).join('')
  const cheeks =
    `<label class="av-choice">${radio('cheeks', 'on', spec.cheeks, '有腮红')}` +
    `<span class="av-opt">有</span></label>` +
    `<label class="av-choice">${radio('cheeks', 'off', !spec.cheeks, '无腮红')}` +
    `<span class="av-opt">无</span></label>`
  const states = AVATAR_STATES.map(
    state =>
      `<button type="button" class="av-state" data-action="avatar-state" ` +
      `data-state="${state}" aria-pressed="${state === 'idle'}">` +
      `${escapeHtml(AVATAR_WORDS.state[state])}</button>`,
  ).join('')
  return (
    `<div class="av-editor" data-spec="${attr(JSON.stringify(spec))}">` +
    `<div class="av-stage">` +
    avatarSvg(spec, {
      size: 168,
      uid: 'av-edit',
      live: true,
      label: `${name} · ${avatarWords(spec)}`,
      className: 'av-stage-figure',
    }) +
    `<span class="av-stage-name">${escapeHtml(avatarWords(spec))}</span>` +
    `<div class="av-states" role="group" aria-label="试一下状态">${states}</div>` +
    `</div>` +
    `<div class="av-groups">` +
    group(
      '形态',
      options('shape', AVATAR_SHAPES, AVATAR_WORDS.shape, spec, shapeGlyph),
    ) +
    group('颜色', swatches) +
    group(
      '材质',
      options(
        'material',
        AVATAR_MATERIALS,
        AVATAR_WORDS.material,
        spec,
        value => escapeHtml(AVATAR_WORDS.material[value]),
      ),
    ) +
    group(
      '眼睛',
      options('eyes', AVATAR_EYES, AVATAR_WORDS.eyes, spec, eyesGlyph),
    ) +
    group(
      '嘴巴',
      options('mouth', AVATAR_MOUTHS, AVATAR_WORDS.mouth, spec, mouthGlyph),
    ) +
    group('腮红', cheeks) +
    group(
      '配饰',
      options(
        'accessory',
        AVATAR_ACCESSORIES,
        AVATAR_WORDS.accessory,
        spec,
        accessoryGlyph,
      ),
    ) +
    `</div></div>`
  )
}

/**
 * The editor dialog. Its body is empty until the page script fills it from
 * `/fragments/avatar` for the figure being edited.
 */
export function avatarDialog(): string {
  return (
    `<dialog class="dialog dialog-wide" id="avatar-dialog" aria-labelledby="avatar-title">` +
    `<form id="avatar-form" novalidate>` +
    dialogTop('avatar-title', 'sparkles', '形象') +
    `<div class="dialog-body">` +
    `<p class="note" id="avatar-who"></p>` +
    `<div id="avatar-editor"></div>` +
    `<p class="note" id="avatar-status" role="status"></p>` +
    `</div>` +
    `<div class="dialog-actions av-foot">` +
    `<span class="kit-row">` +
    `<button type="button" class="btn btn-ghost btn-small" data-action="avatar-random">` +
    `${icon('refresh-cw', { small: true })}随机</button>` +
    `<button type="button" class="btn btn-ghost btn-small" data-action="avatar-default">恢复默认</button>` +
    `</span>` +
    `<span class="kit-row">` +
    `<button type="button" class="btn btn-secondary" data-action="confirm-cancel">取消</button>` +
    `<button type="submit" class="btn btn-primary" data-write>${icon('check', { small: true })}保存</button>` +
    `</span></div>` +
    `</form></dialog>`
  )
}
