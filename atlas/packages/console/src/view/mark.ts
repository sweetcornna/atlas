// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The 阡陌 logo, drawn for the screen.
 *
 * The logo is a field seen from above: plots of land in ink and in sage,
 * parted by one winding path and the narrow ridges between terraces — 阡陌,
 * the paths between the fields. These are its two shapes, traced from the
 * logo artwork (`docs/assets/brand/`, the deck's copy) in its own 853 × 920
 * frame; nothing is redrawn or recoloured beyond what follows.
 *
 * Fitted to the front: the ink plots take `--qm-ink` when a sheet sets it, so
 * on a dark page they turn light instead of vanishing, and the sage stays the
 * logo's own. A page that draws the mark small can widen the ridges with a
 * stroke in its own ground colour (`frontStyle.ts`), which keeps them visible
 * at twenty-odd pixels where they would otherwise close up.
 */

/** The logo's two colours. */
const INK = '#222623'
const FIELD = '#5e866c'

/** The traced shapes, in the trace's own upward-y units. */
const INK_PATH =
  'M100 916 c-43 -3 -74 -24 -89 -61 -10 -21 -11 -35 -11 -100 0 -60 1 -63 10 -72 7 -7 12 -9 59 ' +
  '-19 76 -17 94 -23 143 -55 39 -24 63 -35 99 -44 20 -6 27 -7 30 -5 4 3 3 6 -6 18 -46 60 -42 ' +
  '118 12 184 4 6 26 28 47 49 46 46 51 52 51 66 0 20 -20 31 -62 34 -36 3 -262 7 -283 5z M11 653 ' +
  'c-5 -1 -9 -5 -10 -10 -1 -7 -1 -506 1 -517 6 -49 30 -87 44 -71 4 4 6 8 10 31 17 78 51 140 107 ' +
  '197 34 33 64 56 121 91 40 25 46 29 58 37 14 10 34 30 39 39 17 28 10 68 -13 83 -6 4 -12 6 -25 ' +
  '8 -49 6 -94 22 -131 45 -8 4 -19 11 -25 15 -42 25 -80 38 -156 52 -17 2 -15 2 -20 0z M280 256 ' +
  'c-5 -2 -9 -4 -18 -13 -36 -37 -71 -95 -82 -137 -4 -17 -4 -43 0 -56 9 -25 28 -40 61 -46 10 -2 ' +
  '12 -2 205 -3 205 -1 239 0 257 2 38 6 67 20 74 36 7 17 -8 42 -43 73 -53 48 -111 77 -179 90 ' +
  '-17 4 -30 6 -86 14 -67 9 -101 16 -149 32 -28 9 -33 10 -40 8z'

const FIELD_PATH =
  'M692 918 c-129 -3 -154 -13 -222 -84 -75 -77 -100 -120 -100 -167 0 -31 12 -53 44 -87 26 -25 ' +
  '26 -25 44 -10 69 56 115 77 220 99 89 19 150 42 165 64 8 10 8 11 9 54 0 23 0 41 -1 46 -6 47 ' +
  '-33 75 -79 84 -12 2 -41 2 -80 1z M827 698 c-42 -20 -84 -34 -152 -49 -68 -15 -105 -28 -144 ' +
  '-50 -31 -18 -71 -50 -71 -58 0 -3 0 -3 11 -18 21 -27 25 -53 14 -81 -5 -12 -12 -21 -28 -37 -21 ' +
  '-20 -21 -21 14 -24 118 -14 224 2 311 47 44 22 65 40 69 60 2 9 1 205 -1 209 -4 8 -9 8 -23 1z ' +
  'M837 438 c-2 -1 -11 -6 -20 -12 -95 -57 -212 -80 -338 -67 -10 1 -25 3 -34 4 -32 3 -45 -1 -80 ' +
  '-27 -18 -14 -30 -24 -46 -39 -19 -19 -19 -21 3 -29 43 -16 87 -25 169 -36 63 -8 89 -13 121 -23 ' +
  '68 -21 134 -66 177 -122 12 -15 16 -18 25 -18 17 0 28 17 36 53 2 12 3 305 0 310 -2 6 -7 8 -13 ' +
  '6z'

/** Both shapes, flipped into the 853 × 920 frame. */
function shapes(): string {
  return (
    `<g transform="matrix(1 0 0 -1 0 920)">` +
    `<path class="qm-ink" d="${INK_PATH}" fill="${INK}"/>` +
    `<path class="qm-field" d="${FIELD_PATH}" fill="${FIELD}"/>` +
    `</g>`
  )
}

/**
 * The logo at `height` pixels, inline. Decorative: the wordmark beside it
 * carries the name.
 */
export function qianmoMark(height: number): string {
  const width = Math.round((height * 853) / 920)
  return (
    `<svg class="qm-mark" width="${width}" height="${height}" viewBox="0 0 853 920" ` +
    `aria-hidden="true">${shapes()}</svg>`
  )
}

/**
 * The logo as a standalone document for the browser tab, with its ink
 * turning light where the browser's own chrome is dark.
 */
function qianmoIcon(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-40 -20 933 960">` +
    `<style>.qm-ink{fill:${INK}}@media (prefers-color-scheme:dark){.qm-ink{fill:#e6ebe7}}</style>` +
    shapes() +
    `</svg>`
  )
}

/** {@link qianmoIcon} as the `href` of a `<link rel="icon">`. */
export const QIANMO_ICON_HREF = `data:image/svg+xml,${encodeURIComponent(qianmoIcon())}`
