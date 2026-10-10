// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The console carries nothing it did not write (`providers-console-m1.md`
 * §6.2): no third-party package at run time or in its tests, and no asset
 * fetched from anywhere but itself.
 *
 * Checked from the files, not from memory: the manifest names only
 * `@qianmo/*` workspaces; every module the package's source and tests load
 * is its own file, a `node:` or `bun:` builtin, or one of those workspaces;
 * and every page it serves loads its script and style inline.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { ROUTES } from '../src/routes/index.js'
import { ADMIN, browse, pageHarness } from './pageHarness.js'

const ROOT = resolve(import.meta.dir, '..')

interface Manifest {
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
}

const MANIFEST = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8'),
) as Manifest

function sourcesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourcesUnder(path))
    else if (entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

const TRANSPILER = new Bun.Transpiler({ loader: 'ts' })

/** Type-only imports leave no trace at run time, so the scanner drops them. */
const TYPE_IMPORT =
  /^(?:import|export)\s+type\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s*['"]([^'"]+)['"]/gm

/** Every specifier a file loads, type-only ones included. */
function specifiers(path: string): string[] {
  const code = readFileSync(path, 'utf8')
  const loaded = TRANSPILER.scanImports(code).map(entry => entry.path)
  for (const match of code.matchAll(TYPE_IMPORT)) {
    if (match[1] !== undefined) loaded.push(match[1])
  }
  return loaded
}

describe('dependencies', () => {
  test('the manifest names only @qianmo workspaces, and no dev dependency', () => {
    expect(Object.keys(MANIFEST.dependencies ?? {})).toEqual([
      '@qianmo/audit',
      '@qianmo/protocol',
    ])
    for (const [name, range] of Object.entries(MANIFEST.dependencies ?? {})) {
      expect(`${name} ${range}`).toMatch(/^@qianmo\/\S+ workspace:/)
    }
    expect(MANIFEST.devDependencies).toBeUndefined()
    expect(MANIFEST.peerDependencies).toBeUndefined()
    expect(MANIFEST.optionalDependencies).toBeUndefined()
  })

  test('source and tests load only their own files, builtins and those workspaces', () => {
    const allowed = new Set(Object.keys(MANIFEST.dependencies ?? {}))
    const files = [
      ...sourcesUnder(join(ROOT, 'src')),
      ...sourcesUnder(join(ROOT, 'test')),
    ]
    expect(files.length).toBeGreaterThan(40)
    const stray: string[] = []
    let scanned = 0
    for (const file of files) {
      for (const spec of specifiers(file)) {
        scanned += 1
        const where = relative(ROOT, file)
        if (spec.startsWith('./') || spec.startsWith('../')) {
          // Relative, and still inside this package.
          const target = resolve(file, '..', spec)
          if (!target.startsWith(ROOT + sep)) stray.push(`${where} → ${spec}`)
        } else if (
          !spec.startsWith('node:') &&
          !spec.startsWith('bun:') &&
          spec !== 'bun' &&
          !allowed.has(spec)
        ) {
          stray.push(`${where} → ${spec}`)
        }
      }
    }
    expect(stray).toEqual([])
    // The scan saw the imports it is meant to judge.
    expect(scanned).toBeGreaterThan(200)
  })
})

describe('assets', () => {
  test('every page loads its script and style inline, from nowhere else', async () => {
    const h = pageHarness({ chat: true })
    // The login door is read signed out: signed in, it sends you on.
    const paths = [...ROUTES.map(module => module.area.href), '/login']
    for (const path of paths) {
      const response = await h.handle(
        browse(path, path === '/login' ? undefined : ADMIN),
      )
      expect(`${path} ${response.status}`).toBe(`${path} 200`)
      const html = await response.text()
      const external = [
        ...(html.match(/<script\b[^>]*\bsrc=/g) ?? []),
        ...(html.match(/<link\b[^>]*\bhref="(?!data:)[^"]*"/g) ?? []),
        ...(html.match(/<img\b[^>]*\bsrc="(?!data:)[^"]*"/g) ?? []),
        ...(html.match(/url\(\s*['"]?(?!data:|#)[^)]*\)/g) ?? []),
        ...(html.match(/@import\b/g) ?? []),
      ]
      expect(`${path} ${external.join(' ')}`).toBe(`${path} `)
      // And the inline ones are there: the scan is not looking at nothing.
      // The login door is the one page with no script at all.
      expect(html).toContain('<style>')
      if (path !== '/login') expect(html).toContain('<script>')
    }
  })
})
