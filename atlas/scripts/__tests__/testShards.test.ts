// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { junitFiles } from '../check-test-files-ran'

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

function shards(...args: string[]): { code: number; lines: string[] } {
  const run = Bun.spawnSync(['bash', SCRIPT, ...args], { cwd: ROOT })
  return {
    code: run.exitCode,
    lines: run.stdout.toString().split('\n').filter(Boolean),
  }
}

function list(...dirs: string[]): string[] {
  const run = shards('--list', ...dirs)
  expect(run.code).toBe(0)
  return run.lines
}

function files(...args: string[]): string[] {
  const run = shards('--files', ...args)
  expect(run.code).toBe(0)
  return run.lines
}

function tree(paths: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'qm-test-shards-'))
  temps.push(dir)
  for (const path of paths) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), '')
  }
  return dir
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

describe('test-shards.sh paths and exclusions', () => {
  test('a single test file is a shard; any other file is not', () => {
    const dir = tree(['a/x.test.ts', 'a/helper.ts'])

    expect(list(`${dir}/a/x.test.ts`)).toEqual([`${dir}/a/x.test.ts`])
    expect(files(`${dir}/a/x.test.ts`)).toEqual([`${dir}/a/x.test.ts`])
    expect(list(`${dir}/a/helper.ts`)).toEqual([])
  })

  test('--exclude drops a subtree; the shard keeps the rest', () => {
    const dir = tree([
      'a/x.test.ts',
      'ab/y.test.ts',
      'b/z.test.tsx',
      'w.test.ts',
    ])

    expect(list('--exclude', `${dir}/a`, dir)).toEqual([dir])
    // `a` is not a prefix of `ab`: only whole path segments are excluded.
    expect(files('--exclude', `${dir}/a/`, `${dir}/`)).toEqual([
      `${dir}/ab/y.test.ts`,
      `${dir}/b/z.test.tsx`,
      `${dir}/w.test.ts`,
    ])
  })

  test('a shard inside or equal to an exclusion is not a shard', () => {
    const dir = tree(['a/x.test.ts'])

    expect(list('--exclude', dir, `${dir}/a`)).toEqual([])
    expect(list('--exclude', `${dir}/a`, `${dir}/a`)).toEqual([])
  })

  test('bad arguments stop before running anything', () => {
    expect(shards('--group', 'nope').code).toBe(2)
    expect(shards('--group', 'ops', 'atlas/scripts').code).toBe(2)
    expect(shards('--list', '--files').code).toBe(2)
    expect(shards('--exclude').code).toBe(2)
    expect(shards('--report-dir').code).toBe(2)
    expect(shards('--report-dir', '').code).toBe(2)
    expect(shards('--bogus').code).toBe(2)
  })
})

describe('test-shards.sh --report-dir', () => {
  // test-groups.sh runs the groups side by side, one directory each under
  // test-reports/: a group clearing more than its own reports would delete
  // another group's.
  test('reports land there; only its old shard reports are cleared', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-test-shards-'))
    temps.push(dir)
    writeFileSync(join(dir, 'shard-07-stale.xml'), '')
    writeFileSync(join(dir, 'other.log'), 'kept\n')
    mkdirSync(join(dir, 'group'))
    writeFileSync(join(dir, 'group', 'shard-01-kept.xml'), '')
    const file = 'atlas/packages/paths/test/qmcodeHome.test.ts'

    const run = shards('--report-dir', dir, file)

    expect(run.code).toBe(0)
    const report = `shard-01-${file.replaceAll('/', '-')}.xml`
    expect(readdirSync(dir).sort()).toEqual(['group', 'other.log', report])
    expect(readdirSync(join(dir, 'group'))).toEqual(['shard-01-kept.xml'])
    expect(junitFiles(readFileSync(join(dir, report), 'utf8'))).toEqual([file])
  })
})

describe('test-shards.sh CI groups', () => {
  const groups = shards('--list-groups').lines

  test('the groups split the default shards, each test file exactly once', () => {
    expect(groups.length).toBeGreaterThan(1)
    const grouped = groups.flatMap(group => {
      const run = files('--group', group)
      expect(run.length).toBeGreaterThan(0)
      return run
    })

    expect(new Set(grouped).size).toBe(grouped.length)
    expect([...grouped].sort()).toEqual([...files()].sort())
  })

  test('node is split into test/host and everything else', () => {
    const host = files('--group', 'node-host')
    const rest = files('--group', 'node-rest')

    expect(host.length).toBeGreaterThan(0)
    expect(rest.length).toBeGreaterThan(0)
    expect(
      host.every(path => path.startsWith('atlas/packages/node/test/host/')),
    ).toBe(true)
    expect(
      rest.some(path => path.startsWith('atlas/packages/node/test/host/')),
    ).toBe(false)
    expect([...host, ...rest].sort()).toEqual(files('atlas/packages/node'))
  })

  // A group the workflow does not list never runs in CI; a listed name the
  // script does not know fails that job. Either way, keep the two in step.
  test('bun run atlas:test runs these groups with test-groups.sh; precheck formats first', () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }

    expect(scripts['atlas:test']).toBe('bash atlas/scripts/test-groups.sh')
    // lint:fix writes files, so it finishes before anything reads them.
    expect(scripts.precheck).toBe(
      'bun run atlas:lint:fix && bash atlas/scripts/test-groups.sh --precheck',
    )
    expect(scripts.verify).toContain('ATLAS_TEST_HEAVY=all bun run atlas:test')
  })

  test('the CI test matrix lists exactly these groups', () => {
    const workflow = Bun.YAML.parse(
      readFileSync(join(ROOT, '.github', 'workflows', 'atlas.yml'), 'utf8'),
    ) as { jobs: { test: { strategy: { matrix: { group: string[] } } } } }

    expect([...workflow.jobs.test.strategy.matrix.group].sort()).toEqual(
      [...groups].sort(),
    )
  })
})
