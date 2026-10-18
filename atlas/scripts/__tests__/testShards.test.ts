// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'

const ROOT = join(import.meta.dir, '..', '..', '..')
const SCRIPT = join(ROOT, 'atlas', 'scripts', 'test-shards.sh')
const FIXED = [
  'atlas/tests/integration',
  'atlas/tests/boundary',
  'atlas/tests/support',
  'demo/lib',
  'demo/env',
  'atlas/scripts',
]

const temps: string[] = []
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function list(...dirs: string[]): string[] {
  const run = Bun.spawnSync(['bash', SCRIPT, '--list', ...dirs], { cwd: ROOT })
  expect(run.exitCode).toBe(0)
  return run.stdout.toString().split('\n').filter(Boolean)
}

function hasTests(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (hasTests(path)) return true
    } else if (
      entry.name.endsWith('.test.ts') ||
      entry.name.endsWith('.test.tsx')
    ) {
      return true
    }
  }
  return false
}

describe('test-shards.sh --list', () => {
  test('every package and suite directory with tests is a shard', () => {
    const packages = readdirSync(join(ROOT, 'atlas', 'packages'), {
      withFileTypes: true,
    })
      .filter(entry => entry.isDirectory())
      .map(entry => `atlas/packages/${entry.name}`)
      .sort()
    const expected = [...packages, ...FIXED].filter(dir =>
      hasTests(join(ROOT, dir)),
    )

    expect(expected).toContain('atlas/packages/node')
    expect(list()).toEqual(expected)
  })

  // GNU find writes a long listing in several chunks; `find | grep -q .`
  // under pipefail then exits 141 and the shard used to be dropped. The
  // listing here (~1 MB) is far past a pipe buffer plus grep's read, so find
  // must still be writing after grep has exited: the old probe fails every
  // time, not only when the scheduler happens to interleave them badly.
  test('a directory whose test listing is far past one pipe write is still a shard', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-test-shards-'))
    temps.push(dir)
    const nested = join(dir, 'a'.repeat(40), 'b'.repeat(40))
    mkdirSync(nested, { recursive: true })
    for (let i = 0; i < 4000; i++) {
      writeFileSync(
        join(
          nested,
          `case-${String(i).padStart(4, '0')}-${'x'.repeat(140)}.test.ts`,
        ),
        '',
      )
    }

    expect(list(dir)).toEqual([dir])
  })

  test('a directory without tests is not a shard', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-test-shards-'))
    temps.push(dir)
    writeFileSync(join(dir, 'helper.ts'), '')
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'dep', 'x.test.ts'), '')

    expect(list(dir)).toEqual([])
  })
})
