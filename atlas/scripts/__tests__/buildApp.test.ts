// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { CODE_RENDER_JS } from '../../packages/console/src/assets/codeRender.ts'
import { chevron, icon } from '../../packages/console/src/view/bits.ts'
import {
  CODE_RENDER_PATH,
  codeRenderFile,
  hostTriple,
  sidecarPath,
  tauriBuildArgs,
  writeCodeRender,
} from '../build-app.ts'

const UI = join(import.meta.dir, '..', '..', 'apps', 'qmo', 'ui')
const ui = (name: string): string => readFileSync(join(UI, name), 'utf8')

describe('build-app', () => {
  test('the host triple comes from rustc -vV', () => {
    const rustc = [
      'rustc 1.92.0 (ded5c06cf 2025-12-08)',
      'binary: rustc',
      'host: aarch64-apple-darwin',
      'release: 1.92.0',
    ].join('\n')
    expect(hostTriple(rustc)).toBe('aarch64-apple-darwin')
    expect(hostTriple('rustc 1.92.0\nbinary: rustc\n')).toBeNull()
  })

  test('the sidecar has the name externalBin looks for', () => {
    expect(sidecarPath('aarch64-apple-darwin')).toEndWith(
      ['src-tauri', 'binaries', 'qmo-aarch64-apple-darwin'].join(sep),
    )
    expect(sidecarPath('x86_64-pc-windows-msvc')).toEndWith(
      'qmo-x86_64-pc-windows-msvc.exe',
    )
    expect(sidecarPath('x86_64-unknown-linux-gnu')).toEndWith(
      'qmo-x86_64-unknown-linux-gnu',
    )
  })

  test('macOS makes the .app only; the others their default bundles', () => {
    expect(tauriBuildArgs('darwin', false)).toEqual([
      'tauri',
      'build',
      '--bundles',
      'app',
    ])
    expect(tauriBuildArgs('darwin', true)).toEqual([
      'tauri',
      'build',
      '--debug',
      '--bundles',
      'app',
    ])
    expect(tauriBuildArgs('linux', false)).toEqual(['tauri', 'build'])
    expect(tauriBuildArgs('win32', true)).toEqual(['tauri', 'build', '--debug'])
  })
})

describe('the shell’s Code page and the console’s drawing (P37.16)', () => {
  test('code-render.js is CODE_RENDER_JS under a header, written only when it differs', () => {
    const file = codeRenderFile()
    expect(file.startsWith('// Copyright 2026 Qianmo AgentNest Team\n')).toBe(
      true,
    )
    expect(file).toContain('// SPDX-License-Identifier: AGPL-3.0-or-later\n')
    expect(file.endsWith(CODE_RENDER_JS)).toBe(true)
    expect(CODE_RENDER_PATH).toEndWith(
      ['apps', 'qmo', 'ui', 'code-render.js'].join(sep),
    )
    const dir = mkdtempSync(join(tmpdir(), 'qmo-code-render-'))
    try {
      const path = join(dir, 'code-render.js')
      writeCodeRender(path)
      expect(readFileSync(path, 'utf8')).toBe(file)
      const written = statSync(path).mtimeMs
      Bun.sleepSync(20)
      writeCodeRender(path)
      expect(statSync(path).mtimeMs).toBe(written)
      writeFileSync(path, 'stale')
      writeCodeRender(path)
      expect(readFileSync(path, 'utf8')).toBe(file)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('it is not in git, and the page loads it before its own script', () => {
    const ignored = readFileSync(
      join(import.meta.dir, '..', '..', '.gitignore'),
      'utf8',
    )
    expect(ignored.split('\n')).toContain('apps/qmo/ui/code-render.js')
    const page = ui('code.html')
    const render = page.indexOf('<script src="code-render.js"></script>')
    const own = page.indexOf('<script type="module" src="code.js"></script>')
    expect(render).toBeGreaterThan(0)
    expect(own).toBeGreaterThan(render)
  })

  test('the page has every icon the drawing clones, the console’s own', () => {
    const page = ui('code.html')
    const template =
      /<template id="code-icons">([\s\S]*?)<\/template>/.exec(page)?.[1] ?? ''
    const drawn = new Map(
      [
        ...template.matchAll(
          /<i data-i="([a-z0-9-]+)">(<svg[\s\S]*?<\/svg>)<\/i>/g,
        ),
      ].map(m => [m[1]!, m[2]!]),
    )
    const used = new Set([
      ...[...CODE_RENDER_JS.matchAll(/icon\('([a-z0-9-]+)'\)/g)].map(
        m => m[1]!,
      ),
      // A step's mark, by its severity.
      'x',
      'alert-triangle',
      'check',
    ])
    expect([...used].sort()).toEqual([
      'alert-triangle',
      'check',
      'chev',
      'copy',
      'list-checks',
      'x',
    ])
    for (const name of used) {
      expect(drawn.get(name)).toBe(
        name === 'chev' ? chevron() : icon(name, { small: true }),
      )
    }
  })

  test('every word the drawing asks for is in the three languages', () => {
    const shell = ui('shell.js')
    const asked = new Set([
      ...[...CODE_RENDER_JS.matchAll(/\bw\('([a-zA-Z]+)'\)/g)].map(m => m[1]!),
      // Looked up by a value: a step group's label and a line's state.
      'doing',
      'done',
      'sending',
      'queued',
      'notSent',
      'notDelivered',
    ])
    expect(asked.size).toBeGreaterThanOrEqual(18)
    const blocks = shell.split(/\n {2}(?:zh|en|ja): \{\n/).slice(1)
    expect(blocks).toHaveLength(3)
    for (const block of blocks) {
      for (const key of asked) expect(block).toContain(`'code.${key}':`)
    }
  })
})
