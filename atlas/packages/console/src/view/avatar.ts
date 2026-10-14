// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Drawing a 形象 (`../avatar.ts`) as inline SVG, and the editor that picks one.
 *
 * One flat shape that fills its square, in one muted colour, with two solid
 * black eyes set low — nothing else, and no outline anywhere. The squircle is the house shape, a seal's outline;
 * the others are there so a roster of agents is not a row of twins. Mouth,
 * material, cheeks and accessory stay in the saved figure for compatibility
 * and are not drawn.
 *
 * What the figure is doing (`data-state` on the `<svg>`) shows only in the
 * eyes and a little in the body:
 *
 * | state | 待机 idle | 倾听 listening | 思考 thinking | 回复 speaking | 完成 happy | 出错 error | 休眠 sleep |
 * |---|---|---|---|---|---|---|---|
 * | eyes | its own, blinks, glances | wider | look up and aside | its own, hop | crescents | low dots | closed |
 * | body | — | — | breathes | — | — | greys | dims |
 *
 * Every expression is in the markup at once and CSS shows the one the state
 * asks for, so a state change is an attribute flip — no redraw. Only a figure
 * drawn `live` moves: it blinks on two overlapping rhythms (now and then
 * twice), and its eyes turn toward the half of it the pointer is over.
 * Nothing moves under `prefers-reduced-motion`.
 */

import {
  AVATAR_COLORS,
  AVATAR_EYES,
  AVATAR_HEX,
  AVATAR_SHAPES,
  AVATAR_STATES,
  AVATAR_WORDS,
  type AvatarColor,
  type AvatarEyes,
  type AvatarShape,
  type AvatarSpec,
  type AvatarState,
  avatarHash,
} from '../avatar.js'
import type { Lang } from '../i18n.js'
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
  orb: { d: 'M20 0a20 20 0 1 1 0 40a20 20 0 1 1 0-40Z', eyeY: 21, eyeDX: 6.7 },
  squircle: { d: superellipse(0.3), eyeY: 21, eyeDX: 6.9 },
  capsule: {
    d: 'M20 0a14 14 0 0 1 14 14v12a14 14 0 0 1-28 0v-12a14 14 0 0 1 14-14Z',
    eyeY: 19,
    eyeDX: 6,
  },
  drop: {
    d: 'M3 3h17a17 17 0 0 1 17 17v0a17 17 0 0 1-17 17h0a17 17 0 0 1-17-17Z',
    eyeY: 23,
    eyeDX: 6.5,
  },
  pebble: { d: superellipse(0.62, -0.16), eyeY: 21.5, eyeDX: 6.5 },
  cloud: {
    d: 'M3 23a9 9 0 0 1 8-10a10 10 0 0 1 18 0a9 9 0 0 1 8 10v6a9 9 0 0 1-9 9h-16a9 9 0 0 1-9-9Z',
    eyeY: 25,
    eyeDX: 6.7,
  },
}

/** The eyes are black on every colour but the darkest, where they are white. */
function inkOn(spec: AvatarSpec): string {
  return spec.color === 'ink' ? '#ffffff' : '#1c1b1f'
}

// ---------------------------------------------------------------------------
// eyes
// ---------------------------------------------------------------------------

/** Each kind of eye as half its width and half its height. */
const EYE_SIZE: Readonly<Record<AvatarEyes, readonly [number, number]>> = {
  dot: [3.6, 3.6],
  oval: [3.1, 4.1],
  wide: [3.4, 5],
  square: [3.1, 3.1],
  ring: [4.3, 4.3],
  spark: [2.8, 4.2],
}

function eye(
  kind: AvatarEyes,
  x: number,
  y: number,
  ink: string,
  side: -1 | 1,
): string {
  const [w, h] = EYE_SIZE[kind]
  switch (kind) {
    case 'dot':
    case 'ring':
      // 'ring' is kept for figures saved with it: drawn solid, a size up from the dot.
      return `<circle cx="${num(x)}" cy="${num(y)}" r="${num(w)}" fill="${ink}"/>`
    case 'square':
      return (
        `<rect x="${num(x - w)}" y="${num(y - h)}" width="${num(2 * w)}" ` +
        `height="${num(2 * h)}" rx="1.5" fill="${ink}"/>`
      )
    case 'spark':
      return (
        `<ellipse cx="${num(x)}" cy="${num(y)}" rx="${num(w)}" ry="${num(h)}" fill="${ink}" ` +
        `transform="rotate(${side * 14} ${num(x)} ${num(y)})"/>`
      )
    default:
      return `<ellipse cx="${num(x)}" cy="${num(y)}" rx="${num(w)}" ry="${num(h)}" fill="${ink}"/>`
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
  // The glance, then two lids nested so the two blink rhythms multiply
  // instead of replacing each other.
  return (
    `<g class="av-eyes av-eyes-own"><g class="av-gaze"><g class="av-lid"><g class="av-lid-2">${pair(
      body,
      (x, y, side) => eye(spec.eyes, x, y, ink, side),
    )}</g></g></g></g>` +
    `<g class="av-eyes av-eyes-happy">${pair(body, (x, y) =>
      solid(`M${num(x - 3.5)} ${num(y + 1.9)}q3.5-6.2 7 0q-3.5-3-7 0z`, ink),
    )}</g>` +
    `<g class="av-eyes av-eyes-closed">${pair(
      body,
      (x, y) =>
        `<rect x="${num(x - 3.4)}" y="${num(y - 0.4)}" width="6.8" height="2.4" rx="1.2" fill="${ink}"/>`,
    )}</g>` +
    `<g class="av-eyes av-eyes-low">${pair(
      body,
      (x, y) =>
        `<circle cx="${num(x)}" cy="${num(y + 2.4)}" r="2.2" fill="${ink}"/>`,
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
  /** Blinks, plays its state and looks toward the pointer. */
  readonly live?: boolean
  readonly state?: AvatarState
  /** The accessible name; absent marks the figure decorative. */
  readonly label?: string
  readonly className?: string
}

/** The words for what the editor draws, in each language the front speaks. */
interface DrawnWords {
  readonly shape: Readonly<Record<AvatarShape, string>>
  readonly color: Readonly<Record<AvatarColor, string>>
  readonly eyes: Readonly<Record<AvatarEyes, string>>
  readonly state: Readonly<Record<AvatarState, string>>
  /** A figure's short name from its colour and shape. */
  readonly name: (color: string, shape: string) => string
}

const DRAWN: Readonly<Record<Lang, DrawnWords>> = {
  'zh-CN': { ...AVATAR_WORDS, name: (color, shape) => `${color}${shape}` },
  en: {
    shape: {
      orb: 'Orb',
      capsule: 'Capsule',
      drop: 'Drop',
      cloud: 'Cloud',
      pebble: 'Pebble',
      squircle: 'Squircle',
    },
    color: {
      mist: 'Mist',
      lake: 'Lake',
      sage: 'Sage',
      sand: 'Sand',
      apricot: 'Apricot',
      clay: 'Clay',
      blush: 'Blush',
      lilac: 'Lilac',
      cloud: 'Chalk',
      ink: 'Ink',
    },
    eyes: {
      dot: 'Dot',
      oval: 'Oval',
      wide: 'Bright',
      square: 'Square',
      ring: 'Round',
      spark: 'Spark',
    },
    state: {
      idle: 'Idle',
      listening: 'Listening',
      thinking: 'Thinking',
      speaking: 'Replying',
      happy: 'Done',
      error: 'Error',
      sleep: 'Asleep',
    },
    name: (color, shape) => `${color} ${shape.toLowerCase()}`,
  },
  ja: {
    shape: {
      orb: '丸',
      capsule: 'カプセル',
      drop: 'しずく',
      cloud: '雲',
      pebble: '小石',
      squircle: '角丸',
    },
    color: {
      mist: '霧青',
      lake: '湖水',
      sage: 'セージ',
      sand: '砂',
      apricot: 'あんず',
      clay: '土',
      blush: '薄紅',
      lilac: 'ライラック',
      cloud: '白',
      ink: '墨',
    },
    eyes: {
      dot: '点',
      oval: '楕円',
      wide: 'ぱっちり',
      square: '四角',
      ring: '大丸',
      spark: '星',
    },
    state: {
      idle: '待機',
      listening: '聞いている',
      thinking: '考え中',
      speaking: '返信中',
      happy: '完了',
      error: 'エラー',
      sleep: 'スリープ',
    },
    name: (color, shape) => `${color}の${shape}`,
  },
}

/** The editor's own words; `whose` keeps `{name}` for the script to fill. */
const EDITOR_TEXT: Readonly<
  Record<
    Lang,
    {
      readonly title: string
      readonly random: string
      readonly reset: string
      readonly cancel: string
      readonly save: string
      readonly tryStates: string
      readonly shape: string
      readonly color: string
      readonly eyes: string
      readonly client: Readonly<Record<string, string>>
    }
  >
> = {
  'zh-CN': {
    title: '形象',
    random: '随机',
    reset: '恢复默认',
    cancel: '取消',
    save: '保存',
    tryStates: '试一下状态',
    shape: '形态',
    color: '颜色',
    eyes: '眼睛',
    client: {
      mine: '我的形象',
      whose: '{name} 的形象',
      saving: '保存中',
      saved: '形象已更新',
    },
  },
  en: {
    title: 'Avatar',
    random: 'Random',
    reset: 'Reset',
    cancel: 'Cancel',
    save: 'Save',
    tryStates: 'Try a state',
    shape: 'Shape',
    color: 'Color',
    eyes: 'Eyes',
    client: {
      mine: 'My avatar',
      whose: 'Avatar · {name}',
      saving: 'Saving',
      saved: 'Avatar updated',
      loadFailed: 'Could not load the avatar',
      saveFailed: 'Could not save',
    },
  },
  ja: {
    title: 'アバター',
    random: 'ランダム',
    reset: '既定に戻す',
    cancel: 'キャンセル',
    save: '保存',
    tryStates: '状態を試す',
    shape: '形',
    color: '色',
    eyes: '目',
    client: {
      mine: '自分のアバター',
      whose: '{name} のアバター',
      saving: '保存中',
      saved: 'アバターを更新しました',
      loadFailed: 'アバターを読み込めません',
      saveFailed: '保存できません',
    },
  },
}

/** A short name for a figure: 雾蓝方圆, Mist squircle. */
export function avatarWords(spec: AvatarSpec, lang: Lang = 'zh-CN'): string {
  const words = DRAWN[lang]
  return words.name(words.color[spec.color], words.shape[spec.shape])
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
  const live = options.live === true
  // Where the eyes blink about; a live figure also starts its blink at a
  // point of its own, so two on a page do not blink as one.
  const vars =
    `--av-ey:${num(body.eyeY)}px` +
    (live
      ? `;--av-d:-${num((avatarHash(JSON.stringify(spec)) % 40) / 10)}s`
      : '')
  // The two halves a live figure's eyes turn toward on hover, under the face.
  const look = live
    ? '<rect class="av-look av-look-l" width="20" height="40" fill="transparent"/>' +
      '<rect class="av-look av-look-r" x="20" width="20" height="40" fill="transparent"/>'
    : ''
  return (
    `<svg class="${classes}" width="${options.size}" height="${options.size}" ` +
    `viewBox="0 0 40 40" data-state="${state}" data-face="${avatarFace(spec)}" style="${vars}"${a11y}>` +
    `<path class="av-body" d="${body.d}" fill="${AVATAR_HEX[spec.color]}"/>` +
    look +
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
.avatar .av-body, .avatar .av-face { transform-box: view-box; transform-origin: 20px 20px; }
.avatar .av-eyes, .avatar .av-gaze, .avatar .av-lid, .avatar .av-lid-2 { transform-box: view-box; transform-origin: 20px var(--av-ey, 20px); }
.avatar .av-gaze { transition: translate 200ms ease-out; }
.avatar .av-body { transition: opacity 240ms ease, filter 240ms ease; }
.avatar .av-face { transition: transform 300ms cubic-bezier(.3, .7, .3, 1); }
.avatar .av-eyes { transition: opacity 180ms ease, transform 220ms ease; }
.avatar .av-eyes-happy, .avatar .av-eyes-closed, .avatar .av-eyes-low { opacity: 0; }
.av-live .av-face { pointer-events: none; }

.avatar[data-state="listening"] .av-eyes-own { transform: scale(1.12); }
.avatar[data-state="thinking"] .av-face { transform: translate(1.6px, -1.8px); }
.avatar[data-state="happy"] .av-eyes-own { opacity: 0; }
.avatar[data-state="happy"] .av-eyes-happy { opacity: 1; }
.avatar[data-state="error"] .av-eyes-own { opacity: 0; }
.avatar[data-state="error"] .av-eyes-low { opacity: 1; }
.avatar[data-state="error"] .av-body { filter: saturate(.25); }
.avatar[data-state="sleep"] .av-eyes-own { opacity: 0; }
.avatar[data-state="sleep"] .av-eyes-closed { opacity: 1; }
.avatar[data-state="sleep"] .av-body { opacity: .42; }
.avatar[data-state="speaking"] .av-face { transform: translate(0, -.6px); }

/* Two blink rhythms on nested lids: one plain, one now and then twice. */
.av-live .av-lid { animation: av-blink 5.2s ease-in-out var(--av-d, 0s) infinite; }
.av-live .av-lid-2 { animation: av-blink-2 8.3s ease-in-out var(--av-d, 0s) infinite; }
.av-live[data-state="idle"] .av-gaze { animation: av-glance 11s ease-in-out var(--av-d, 0s) infinite; }
.av-live[data-state="thinking"] .av-body { animation: av-breathe 1.8s ease-in-out infinite; }
.av-live[data-state="thinking"] .av-lid, .av-live[data-state="thinking"] .av-lid-2 { animation: none; }
.av-live[data-state="speaking"] .av-face { animation: av-hop .9s cubic-bezier(.3, .7, .4, 1) infinite; }
.av-live[data-state="sleep"] .av-lid, .av-live[data-state="sleep"] .av-lid-2 { animation: none; }
/* The eyes turn toward the half the pointer is over, unless it is thinking. */
.av-live:not([data-state="thinking"]) .av-look-l:hover ~ .av-face .av-gaze { translate: -1px .2px; }
.av-live:not([data-state="thinking"]) .av-look-r:hover ~ .av-face .av-gaze { translate: 1px .2px; }

@keyframes av-blink { 0%, 93%, 100% { transform: scaleY(1); } 95.5% { transform: scaleY(.1); } }
@keyframes av-blink-2 { 0%, 54%, 57.6%, 61.2%, 100% { transform: scaleY(1); } 55.8%, 59.4% { transform: scaleY(.1); } }
@keyframes av-glance { 0%, 40%, 58%, 100% { transform: translate(0, 0); } 44%, 54% { transform: translate(-.9px, -.3px); } }
@keyframes av-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .78; } }
@keyframes av-hop { 0%, 55%, 100% { transform: translateY(0); } 25% { transform: translateY(-1.1px); } }
@media (prefers-reduced-motion: reduce) {
  /* As specific as the state rules above, and later, so it wins over them. */
  .av-live .av-gaze, .av-live .av-lid, .av-live .av-lid-2, .av-live .av-body, .av-live .av-face,
  .av-live[data-state] .av-gaze, .av-live[data-state] .av-lid, .av-live[data-state] .av-lid-2,
  .av-live[data-state] .av-body, .av-live[data-state] .av-face { animation: none; }
  .avatar .av-face, .avatar .av-eyes, .avatar .av-gaze, .avatar .av-body { transition: none; }
  .av-look { display: none; }
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
export function renderAvatarEditor(
  spec: AvatarSpec,
  name: string,
  lang: Lang = 'zh-CN',
): string {
  const words = DRAWN[lang]
  const text = EDITOR_TEXT[lang]
  const swatches = AVATAR_COLORS.map(
    color =>
      `<label class="av-choice" title="${attr(words.color[color])}">` +
      radio('color', color, spec.color === color, words.color[color]) +
      `<span class="av-swatch" style="background:${AVATAR_HEX[color]}"></span></label>`,
  ).join('')
  const states = AVATAR_STATES.map(
    state =>
      `<button type="button" class="av-state" data-action="avatar-state" ` +
      `data-state="${state}" aria-pressed="${state === 'idle'}">` +
      `${escapeHtml(words.state[state])}</button>`,
  ).join('')
  return (
    `<div class="av-editor" data-spec="${attr(JSON.stringify(spec))}">` +
    `<div class="av-stage">` +
    avatarSvg(spec, {
      size: 112,
      uid: 'av-edit',
      live: true,
      label: `${name} · ${avatarWords(spec, lang)}`,
      className: 'av-stage-figure',
    }) +
    `<span class="av-stage-name">${escapeHtml(avatarWords(spec, lang))}</span>` +
    `<div class="av-states" role="group" aria-label="${attr(text.tryStates)}">${states}</div>` +
    `</div>` +
    `<div class="av-groups">` +
    group(
      text.shape,
      options('shape', AVATAR_SHAPES, words.shape, spec, shapeGlyph),
    ) +
    group(text.color, swatches) +
    group(
      text.eyes,
      options('eyes', AVATAR_EYES, words.eyes, spec, eyesGlyph),
    ) +
    `</div></div>`
  )
}

/**
 * The editor dialog. Its body is empty until the page script fills it from
 * `/fragments/avatar` for the figure being edited.
 */
export function avatarDialog(lang: Lang = 'zh-CN'): string {
  const text = EDITOR_TEXT[lang]
  return (
    `<dialog class="dialog" id="avatar-dialog" aria-labelledby="avatar-title" ` +
    `data-lang="${lang}" data-text="${attr(JSON.stringify(text.client))}">` +
    `<form id="avatar-form" novalidate>` +
    dialogTop('avatar-title', 'sparkles', text.title) +
    `<div class="dialog-body">` +
    `<p class="note" id="avatar-who"></p>` +
    `<div id="avatar-editor"></div>` +
    `<p class="note" id="avatar-status" role="status"></p>` +
    `</div>` +
    `<div class="dialog-actions av-foot">` +
    `<span class="kit-row">` +
    `<button type="button" class="btn btn-ghost btn-small" data-action="avatar-random">` +
    `${icon('refresh-cw', { small: true })}${escapeHtml(text.random)}</button>` +
    `<button type="button" class="btn btn-ghost btn-small" data-action="avatar-default">${escapeHtml(text.reset)}</button>` +
    `</span>` +
    `<span class="kit-row">` +
    `<button type="button" class="btn btn-secondary" data-action="confirm-cancel">${escapeHtml(text.cancel)}</button>` +
    `<button type="submit" class="btn btn-primary" data-write>${icon('check', { small: true })}${escapeHtml(text.save)}</button>` +
    `</span></div>` +
    `</form></dialog>`
  )
}
