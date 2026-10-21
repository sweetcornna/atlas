// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Screenshots of a running preview (`./serve.ts`), in the light and the dark
 * scheme, through the browser suites' own driver (`../browser/cdp.ts`). Not a
 * test.
 *
 * ```
 * bun atlas/packages/console/test/preview/shoot.ts --out <dir> \
 *   [--base http://127.0.0.1:38700] [--as ops] [--width 1280] [--height 860] \
 *   [--theme light|dark|both] 'name|/path|optional script' …
 * ```
 *
 * Each shot is `<name>|<path>`, and an optional third part is evaluated in
 * the page after it loads (open a menu, click a tab) before the picture is
 * taken. Files are `<dir>/<name>-<theme>.png`; the whole document is
 * captured, not only the viewport.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Browser, skipReason } from '../browser/cdp.js'

function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`)
  return at < 0 ? fallback : (process.argv[at + 1] ?? fallback)
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const out = option('out', '')
if (out === '') throw new Error('--out <dir> is required')
const base = option('base', 'http://127.0.0.1:38700')
const role = option('as', 'ops')
const width = Number(option('width', '1280'))
const height = Number(option('height', '860'))
const theme = option('theme', 'both')
const themes = theme === 'both' ? ['light', 'dark'] : [theme]
const valued = new Set([
  '--out',
  '--base',
  '--as',
  '--width',
  '--height',
  '--theme',
])
const shots = process.argv
  .slice(2)
  .filter(
    (arg, index, all) =>
      !arg.startsWith('--') && !valued.has(all[index - 1] ?? ''),
  )
  .map(arg => {
    const [name, path, ...script] = arg.split('|')
    return { name: name ?? 'shot', path: path ?? '/', script: script.join('|') }
  })

const skipped = skipReason()
if (skipped !== null) throw new Error(skipped)
mkdirSync(out, { recursive: true })
const browser = await Browser.launch()
try {
  const tab = await browser.tab({ width, height })
  await tab.goto(
    `${base}/__preview/login?as=${encodeURIComponent(role)}&next=/`,
  )
  for (const shot of shots) {
    for (const scheme of themes) {
      await tab.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: scheme }],
      })
      await tab.goto(`${base}${shot.path}`)
      await pause(500)
      if (shot.script !== '') {
        await tab.evaluate(`(async () => { ${shot.script} })()`)
        await pause(400)
      }
      const metrics = await tab.send('Page.getLayoutMetrics')
      const size = metrics['cssContentSize'] as
        | { width: number; height: number }
        | undefined
      const full = Math.max(height, Math.ceil(size?.height ?? height))
      const picture = await tab.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height: full, scale: 1 },
      })
      const file = join(out, `${shot.name}-${scheme}.png`)
      writeFileSync(file, Buffer.from(String(picture['data']), 'base64'))
      process.stdout.write(`${file}\n`)
    }
  }
  await tab.close()
} finally {
  await browser.close()
}
