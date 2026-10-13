// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 主题色 — the conversation front's one colour of the reader's choosing.
 *
 * It colours what is the reader's own or what is alive: the reader's lines,
 * the send button, the marks that move while an agent works. Everything else
 * stays ink and paper. Six presets, each with a lighter step for the dark
 * scheme, or any colour picked by hand, whose text colour is worked out from
 * its lightness.
 *
 * The choice is a cookie (`qianmo_accent`), like the light/dark choice, so
 * the server draws the page in it and nothing flashes on load
 * (`preferences.ts`). A preset is `data-accent` on `<html>`; a picked colour
 * is also two custom properties there. The front's sheet reads them through
 * `--qm-accent` and `--qm-accent-ink`, defaulting to ink.
 */

interface AccentPreset {
  readonly name: string
  readonly label: string
  readonly light: string
  readonly lightInk: string
  readonly dark: string
  readonly darkInk: string
}

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  {
    name: 'ink',
    label: '墨',
    light: '#111110',
    lightInk: '#fafaf9',
    dark: '#ececea',
    darkInk: '#111110',
  },
  {
    name: 'sage',
    label: '青',
    light: '#4b6f58',
    lightInk: '#ffffff',
    dark: '#86ad93',
    darkInk: '#0f1712',
  },
  {
    name: 'indigo',
    label: '黛',
    light: '#3e5c8a',
    lightInk: '#ffffff',
    dark: '#93acd6',
    darkInk: '#0e1420',
  },
  {
    name: 'clay',
    label: '赭',
    light: '#a8553b',
    lightInk: '#ffffff',
    dark: '#e09a7f',
    darkInk: '#1d0f0a',
  },
  {
    name: 'plum',
    label: '紫',
    light: '#6a5797',
    lightInk: '#ffffff',
    dark: '#ae9fd8',
    darkInk: '#15101f',
  },
  {
    name: 'gold',
    label: '金',
    light: '#8a6a1f',
    lightInk: '#ffffff',
    dark: '#d8b76d',
    darkInk: '#1a1406',
  },
]

/** A picked colour, as the cookie and the page carry it. */
const CUSTOM = /^#[0-9a-f]{6}$/

/** The text colour that reads on `hex`: ink on a light colour, white on a dark one. */
function accentInk(hex: string): string {
  const luminance = (color: string): number => {
    const channel = (at: number): number => {
      const value = Number.parseInt(color.slice(at, at + 2), 16) / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  }
  const ground = luminance(hex)
  const contrast = (ink: string): number => {
    const other = luminance(ink)
    return (Math.max(ground, other) + 0.05) / (Math.min(ground, other) + 0.05)
  }
  // The console's ink or white, whichever reads better; on the few mid tones
  // where neither reaches 4.5:1, pure black does.
  const best =
    contrast('#111110') >= contrast('#ffffff') ? '#111110' : '#ffffff'
  return contrast(best) >= 4.5 ? best : '#000000'
}

/**
 * The attributes `<html>` carries for a cookie value, or `''` for none or
 * anything off the lists: a preset name, or a picked `#rrggbb`.
 */
export function accentAttrs(value: string | undefined): string {
  if (value === undefined) return ''
  const picked = value.toLowerCase()
  if (CUSTOM.test(picked)) {
    return (
      ` data-accent="custom" style="--qm-accent:${picked};` +
      `--qm-accent-ink:${accentInk(picked)}"`
    )
  }
  return ACCENT_PRESETS.some(preset => preset.name === value)
    ? ` data-accent="${value}"`
    : ''
}

/** The presets as rules on `<html>`: the light step, and the dark one in both dark selectors. */
export function accentCss(): string {
  return ACCENT_PRESETS.map(preset => {
    const at = `[data-accent="${preset.name}"]`
    return (
      `:root${at} { --qm-accent: ${preset.light}; --qm-accent-ink: ${preset.lightInk}; }\n` +
      `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"])${at} { ` +
      `--qm-accent: ${preset.dark}; --qm-accent-ink: ${preset.darkInk}; } }\n` +
      `:root[data-theme="dark"]${at} { --qm-accent: ${preset.dark}; --qm-accent-ink: ${preset.darkInk}; }\n` +
      `.fx-swatch[data-accent="${preset.name}"] { --fx-swatch: ${preset.light}; }\n`
    )
  }).join('')
}
