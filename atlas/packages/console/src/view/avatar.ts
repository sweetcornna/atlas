// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Drawing a 形象 (`../avatar.ts`) as inline SVG, and the editor that picks one.
 *
 * One flat shape that fills its square, in one muted colour, with two small
 * solid eyes — nothing else, and no outline anywhere. The squircle is the house shape, a seal's outline;
 * the others are there so a roster of agents is not a row of twins. Mouth,
 * material, cheeks and accessory stay in the saved figure for compatibility
 * and are not drawn.
 *
 * What the figure is doing (`data-state` on the `<svg>`) shows only in the
 * eyes and a little in the body:
 *
 * | state | 待机 idle | 倾听 listening | 思考 thinking | 回复 speaking | 完成 happy | 出错 error | 休眠 sleep |
 * |---|---|---|---|---|---|---|---|
 * | eyes | its own, blink | wider | look up and aside | its own, bob | crescents | low dots | closed |
 * | body | — | — | breathes | — | — | greys | dims |
 *
 * Every expression is in the markup at once and CSS shows the one the state
 * asks for, so a state change is an attribute flip — no redraw. Only a figure
 * drawn `live` moves, and nothing moves under `prefers-reduced-motion`.
 */

import {
  AVATAR_COLORS,
  AVATAR_EYES,
  AVATAR_HEX,
  AVATAR_SHAPES,
  AVATAR_STATES,
  AVATAR_WORDS,
  type AvatarShape,
  type AvatarSpec,
  type AvatarState,
  avatarHash,
} from '../avatar.js'
import { icon } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { dialogTop } from './kit.js'

// ---------------------------------------------------------------------------
// geometry, in a 40 × 40 box
// ---------------------------------------------------------------------------

function num(value: number): string {
  return (Math.round(value * 100) / 100).toString()
}

/** A superellipse filling the box: power 1 is a diamond, 0.5 nearly a circle. */
function superellipse(power: number, lean = 0): string {
  const points: string[] = []
  const steps = 64
  for (let index = 0; index < steps; index += 1) {
    const t = (index / steps) * Math.PI * 2
    const c = Math.cos(t)
    const s = Math.sin(t)
    const x = 20 * Math.sign(c) * Math.abs(c) ** power
    const y = 20 * Math.sign(s) * Math.abs(s) ** power
    points.push(
      `${num(20 + x * Math.cos(lean) - y * Math.sin(lean))} ${num(20 + x * Math.sin(lean) + y * Math.cos(lean))}`,
    )
  }
  return `M${points.join('L')}Z`
}

/** One body: its outline and where the eyes sit. */
interface Body {
  readonly d: string
  readonly eyeY: number
  readonly eyeDX: number
}

const BODIES: Readonly<Record<AvatarShape, Body>> = {
  orb: { d: 'M20 0a20 20 0 1 1 0 40a20 20 0 1 1 0-40Z', eyeY: 19, eyeDX: 5.4 },
  squircle: { d: superellipse(0.3), eyeY: 19, eyeDX: 5.6 },
  capsule: {
    d: 'M20 0a14 14 0 0 1 14 14v12a14 14 0 0 1-28 0v-12a14 14 0 0 1 14-14Z',
    eyeY: 17,
    eyeDX: 4.8,
  },
  drop: {
    d: 'M3 3h17a17 17 0 0 1 17 17v0a17 17 0 0 1-17 17h0a17 17 0 0 1-17-17Z',
    eyeY: 21,
    eyeDX: 5.2,
  },
  pebble: { d: superellipse(0.62, -0.16), eyeY: 19.5, eyeDX: 5.2 },
  cloud: {
    d: 'M3 23a9 9 0 0 1 8-10a10 10 0 0 1 18 0a9 9 0 0 1 8 10v6a9 9 0 0 1-9 9h-16a9 9 0 0 1-9-9Z',
    eyeY: 24,
    eyeDX: 5.4,
  },
}

/** The eyes are white on every colour but the palest, where they are ink. */
function inkOn(spec: AvatarSpec): string {
  return spec.color === 'cloud' ? '#1c1b1f' : '#ffffff'
}

// ---------------------------------------------------------------------------
// eyes
// ---------------------------------------------------------------------------

function eye(
  kind: AvatarSpec['eyes'],
  x: number,
  y: number,
  ink: string,
  side: -1 | 1,
): string {
  switch (kind) {
    case 'dot':
      return `<circle cx="${num(x)}" cy="${num(y)}" r="2.5" fill="${ink}"/>`
    case 'wide':
      return `<ellipse cx="${num(x)}" cy="${num(y)}" rx="2.3" ry="3.7" fill="${ink}"/>`
    case 'square':
      return `<rect x="${num(x - 2.2)}" y="${num(y - 2.2)}" width="4.4" height="4.4" rx="1.1" fill="${ink}"/>`
    case 'ring':
      // Kept for figures saved with it; drawn solid, a size up from the dot.
      return `<circle cx="${num(x)}" cy="${num(y)}" r="3.1" fill="${ink}"/>`
    case 'spark':
      return (
        `<ellipse cx="${num(x)}" cy="${num(y)}" rx="1.8" ry="3.1" fill="${ink}" ` +
        `transform="rotate(${side * 14} ${num(x)} ${num(y)})"/>`
      )
    default:
      return `<ellipse cx="${num(x)}" cy="${num(y)}" rx="1.8" ry="3.1" fill="${ink}"/>`
  }
}

function pair(
  body: Body,
  draw: (x: number, y: number, side: -1 | 1) => string,
): string {
  return (
    draw(20 - body.eyeDX, body.eyeY, -1) + draw(20 + body.eyeDX, body.eyeY, 1)
  )
}

function solid(d: string, ink: string): string {
  return `<path d="${d}" fill="${ink}"/>`
}

function expressions(spec: AvatarSpec, body: Body, ink: string): string {
  return (
    `<g class="av-eyes av-eyes-own">${pair(body, (x, y, side) => eye(spec.eyes, x, y, ink, side))}</g>` +
    `<g class="av-eyes av-eyes-happy">${pair(body, (x, y) =>
      solid(
        `M${num(x - 2.6)} ${num(y + 1.4)}q2.6-4.6 5.2 0q-2.6-2.2-5.2 0z`,
        ink,
      ),
    )}</g>` +
    `<g class="av-eyes av-eyes-closed">${pair(
      body,
      (x, y) =>
        `<rect x="${num(x - 2.5)}" y="${num(y - 0.3)}" width="5" height="1.9" rx="0.95" fill="${ink}"/>`,
    )}</g>` +
    `<g class="av-eyes av-eyes-low">${pair(
      body,
      (x, y) =>
        `<circle cx="${num(x)}" cy="${num(y + 2)}" r="1.6" fill="${ink}"/>`,
    )}</g>`
  )
}

// ---------------------------------------------------------------------------
// the figure
// ---------------------------------------------------------------------------

interface AvatarDrawOptions {
  /** Pixels on a side. */
  readonly size: number
  /**
   * Marks a figure that has a name of its own on the page (the head, the
   * greeting, the editor's stage). Kept for callers; the drawing has no
   * definitions to name.
   */
  readonly uid?: string
  /** Blinks and plays its state. */
  readonly live?: boolean
  readonly state?: AvatarState
  /** The accessible name; absent marks the figure decorative. */
  readonly label?: string
  readonly className?: string
}

/** A short name for a figure: 雾蓝方圆. */
export function avatarWords(spec: AvatarSpec): string {
  return `${AVATAR_WORDS.color[spec.color]}${AVATAR_WORDS.shape[spec.shape]}`
}

/** Which figure this is, so a script can tell a redraw of the same one. */
function avatarFace(spec: AvatarSpec): string {
  return avatarHash(JSON.stringify(spec)).toString(36)
}

/** One figure as an inline `<svg>`. */
export function avatarSvg(
  spec: AvatarSpec,
  options: AvatarDrawOptions,
): string {
  const body = BODIES[spec.shape]
  const ink = inkOn(spec)
  const state = options.state ?? 'idle'
  const classes = [
    'avatar',
    options.live === true ? 'av-live' : '',
    options.className ?? '',
  ]
    .filter(one => one !== '')
    .join(' ')
  const a11y =
    options.label === undefined
      ? ' aria-hidden="true"'
      : ` role="img" aria-label="${attr(options.label)}"`
  return (
    `<svg class="${classes}" width="${options.size}" height="${options.size}" ` +
    `viewBox="0 0 40 40" data-state="${state}" data-face="${avatarFace(spec)}"${a11y}>` +
    `<path class="av-body" d="${body.d}" fill="${AVATAR_HEX[spec.color]}"/>` +
    `<g class="av-face">${expressions(spec, body, ink)}</g>` +
    `</svg>`
  )
}

/**
 * Figures and their states. Every expression is drawn; these rules pick one.
 * The motion is `transform` and `opacity` only, and stops under reduced motion
 * while the expressions still change.
 */
export const AVATAR_CSS = `
.avatar { display: block; flex: none; overflow: visible; }
.avatar .av-body, .avatar .av-face, .avatar .av-eyes { transform-box: view-box; transform-origin: 20px 20px; }
.avatar .av-body { transition: opacity 240ms ease, filter 240ms ease; }
.avatar .av-face { transition: transform 300ms cubic-bezier(.3, .7, .3, 1); }
.avatar .av-eyes { transition: opacity 180ms ease, transform 220ms ease; }
.avatar .av-eyes-happy, .avatar .av-eyes-closed, .avatar .av-eyes-low { opacity: 0; }

.avatar[data-state="listening"] .av-eyes-own { transform: scale(1.1); }
.avatar[data-state="thinking"] .av-face { transform: translate(1.6px, -1.6px); }
.avatar[data-state="happy"] .av-eyes-own { opacity: 0; }
.avatar[data-state="happy"] .av-eyes-happy { opacity: 1; }
.avatar[data-state="error"] .av-eyes-own { opacity: 0; }
.avatar[data-state="error"] .av-eyes-low { opacity: 1; }
.avatar[data-state="error"] .av-body { filter: saturate(.25); }
.avatar[data-state="sleep"] .av-eyes-own { opacity: 0; }
.avatar[data-state="sleep"] .av-eyes-closed { opacity: 1; }
.avatar[data-state="sleep"] .av-body { opacity: .42; }
.avatar[data-state="speaking"] .av-face { transform: translate(0, -.6px); }

.av-live .av-eyes-own { animation: av-blink 5.6s ease-in-out infinite; }
.av-live[data-state="thinking"] .av-body { animation: av-breathe 1.8s ease-in-out infinite; }
.av-live[data-state="thinking"] .av-eyes-own { animation: none; }
.av-live[data-state="speaking"] .av-face { animation: av-bob .8s ease-in-out infinite; }
.av-live[data-state="sleep"] .av-eyes-own { animation: none; }

@keyframes av-blink { 0%, 94%, 100% { transform: scaleY(1); } 96.5% { transform: scaleY(.12); } }
@keyframes av-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .78; } }
@keyframes av-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-1px); } }
@media (prefers-reduced-motion: reduce) {
  /* As specific as the state rules above, and later, so it wins over them. */
  .av-live .av-eyes-own, .av-live .av-body, .av-live .av-face,
  .av-live[data-state] .av-eyes-own, .av-live[data-state] .av-body, .av-live[data-state] .av-face { animation: none; }
  .avatar .av-face, .avatar .av-eyes, .avatar .av-body { transition: none; }
}

.av-editor { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: var(--space-6); align-items: start; }
.av-stage {
  position: sticky; top: 0; display: flex; flex-direction: column; align-items: center; gap: var(--space-3);
  padding: var(--space-6) var(--space-3) var(--space-4); border-radius: 16px;
  background: var(--fx-tint, rgb(0 0 0 / .035));
}
.av-stage-name { font-size: 13px; color: var(--color-muted); }
.av-states { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; }
.av-state {
  min-height: 24px; padding: 0 9px; border: 0; border-radius: 999px; cursor: pointer;
  background: transparent; color: var(--color-muted); font-size: 12px;
  transition: background-color 150ms ease, color 150ms ease;
}
.av-state:hover { color: var(--color-text); }
.av-state[aria-pressed="true"] { background: var(--color-text); color: var(--color-bg); }
.av-groups { display: flex; flex-direction: column; gap: var(--space-4); }
.av-group { display: grid; grid-template-columns: 44px minmax(0, 1fr); align-items: center; gap: var(--space-3); border: 0; margin: 0; padding: 0; min-width: 0; }
.av-group > legend { float: left; padding: 0; font-size: 12px; color: var(--color-muted); }
.av-choices { display: flex; flex-wrap: wrap; gap: 6px; }
.av-choice { position: relative; display: inline-flex; cursor: pointer; }
.av-choice input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.av-opt {
  display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px;
  color: var(--color-muted); transition: background-color 150ms ease, color 150ms ease;
}
.av-opt svg { display: block; }
.av-choice:hover .av-opt { color: var(--color-text); background: var(--fx-tint, rgb(0 0 0 / .04)); }
.av-choice input:checked + .av-opt { background: var(--color-text); color: var(--color-bg); }
.av-choice input:focus-visible + .av-opt, .av-choice input:focus-visible + .av-swatch { outline: 2px solid var(--color-text); outline-offset: 2px; }
.av-swatch { width: 24px; height: 24px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgb(0 0 0 / .08); }
.av-choice input:checked + .av-swatch { box-shadow: 0 0 0 2px var(--color-bg), 0 0 0 3.5px var(--color-text); }
.av-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap; }
@media (max-width: 700px) {
  .av-editor { grid-template-columns: minmax(0, 1fr); }
  .av-stage { position: static; }
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
function glyph(inner: string, size = 22): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true">` +
    `${inner}</svg>`
  )
}

function shapeGlyph(shape: AvatarShape): string {
  return glyph(`<path d="${BODIES[shape].d}" fill="currentColor"/>`)
}

function eyesGlyph(kind: AvatarSpec['eyes']): string {
  return glyph(
    `<path d="${BODIES.squircle.d}" fill="currentColor" opacity=".18"/>` +
      pair(BODIES.squircle, (x, y, side) =>
        eye(kind, x, y, 'currentColor', side),
      ),
  )
}

function options<K extends 'shape' | 'eyes'>(
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
 * The editor's body for one figure: the stage, with the states to try, and
 * the three choices that are drawn — shape, colour, eyes. Fields the drawing
 * no longer shows are carried in `data-spec` and saved as they were.
 * Redrawn by the server on every pick (`/fragments/avatar`).
 */
export function renderAvatarEditor(spec: AvatarSpec, name: string): string {
  const swatches = AVATAR_COLORS.map(
    color =>
      `<label class="av-choice" title="${attr(AVATAR_WORDS.color[color])}">` +
      radio('color', color, spec.color === color, AVATAR_WORDS.color[color]) +
      `<span class="av-swatch" style="background:${AVATAR_HEX[color]}"></span></label>`,
  ).join('')
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
      size: 112,
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
      '眼睛',
      options('eyes', AVATAR_EYES, AVATAR_WORDS.eyes, spec, eyesGlyph),
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
    `<dialog class="dialog" id="avatar-dialog" aria-labelledby="avatar-title">` +
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
