// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import {
  checkTestFilesRan,
  compareTestFiles,
  junitFiles,
  trackedTestFiles,
} from '../check-test-files-ran'

const ROOT = join(import.meta.dir, '..', '..', '..')
const SCRIPT = join(ROOT, 'atlas', 'scripts', 'check-test-files-ran.ts')

const temps: string[] = []
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qm-tests-ran-'))
  temps.push(dir)
  return dir
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
}

function junit(...files: string[]): string {
  const suites = files.map(
    file =>
      `  <testsuite name="${file}" file="${file}" tests="1">\n` +
      `    <testcase name="t" classname="c" file="${file}" />\n` +
      '  </testsuite>',
  )
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test">\n${suites.join('\n')}\n</testsuites>\n`
}

describe('junitFiles', () => {
  // Parse what Bun's own reporter writes, not a hand-made imitation of it.
  test('reads the files a real bun JUnit report names', () => {
    const dir = temp()
    write(dir, {
      'nested.test.ts': [
        "import { describe, expect, test } from 'bun:test'",
        'describe(\'suite > "q" & <x>\', () => {',
        '  test(\'a > b file="decoy.test.ts"\', () => expect(1).toBe(1))',
        '})',
      ].join('\n'),
      'skipped.test.ts': [
        "import { describe, test } from 'bun:test'",
        "describe.skipIf(true)('never', () => test('x', () => {}))",
      ].join('\n'),
      'empty.test.ts': 'export {}\n',
    })
    const run = Bun.spawnSync(
      [
        process.execPath,
        'test',
        '--reporter=junit',
        '--reporter-outfile',
        'out.xml',
        './nested.test.ts',
        './skipped.test.ts',
        './empty.test.ts',
      ],
      { cwd: dir, stdout: 'pipe', stderr: 'pipe' },
    )
    expect(run.exitCode).toBe(0)

    // The decoy in a test name is not a file, and a file that registers no
    // test is not in the report at all: the check counts it as missing.
    expect(junitFiles(readFileSync(join(dir, 'out.xml'), 'utf8'))).toEqual([
      'nested.test.ts',
      'skipped.test.ts',
    ])
  })

  test('decodes escaped paths', () => {
    expect(junitFiles(junit('a/b&amp;c.test.ts'))).toEqual(['a/b&c.test.ts'])
  })
})

describe('compareTestFiles', () => {
  const tracked = ['atlas/a.test.ts', 'atlas/b.test.ts', 'demo/c.test.tsx']

  test('every tracked file once is clean', () => {
    const result = compareTestFiles(tracked, [
      {
        path: 'g1/shard-01.xml',
        files: ['atlas/a.test.ts', 'atlas/b.test.ts'],
      },
      { path: 'g2/shard-01.xml', files: ['demo/c.test.tsx'] },
    ])

    expect(result).toEqual({
      tracked: 3,
      reports: 2,
      ran: 3,
      missing: [],
      unexpected: [],
      duplicated: [],
    })
  })

  test('names the missing, the unexpected and the duplicated', () => {
    const result = compareTestFiles(tracked, [
      { path: 'g1/shard-01.xml', files: ['atlas/a.test.ts'] },
      {
        path: 'g2/shard-01.xml',
        files: ['atlas/a.test.ts', 'packages/ai/test/x.test.ts'],
      },
    ])

    expect(result.missing).toEqual(['atlas/b.test.ts', 'demo/c.test.tsx'])
    expect(result.unexpected).toEqual(['packages/ai/test/x.test.ts'])
    expect(result.duplicated).toEqual([
      {
        file: 'atlas/a.test.ts',
        reports: ['g1/shard-01.xml', 'g2/shard-01.xml'],
      },
    ])
  })
})

describe('checkTestFilesRan', () => {
  test('tracked atlas and demo tests against the reports under each directory', () => {
    const repo = temp()
    write(repo, {
      'atlas/pkg/test/a.test.ts': '',
      'demo/lib/b.test.tsx': '',
      'atlas/pkg/src/helper.ts': '',
      'packages/omp/test/base.test.ts': '',
    })
    const git = (...args: string[]) =>
      expect(Bun.spawnSync(['git', ...args], { cwd: repo }).exitCode).toBe(0)
    git('init', '-q', '-b', 'main')
    git('add', '--all')
    // Untracked: present on disk, absent from what must run.
    write(repo, { 'atlas/pkg/test/draft.test.ts': '' })

    expect(trackedTestFiles(repo)).toEqual([
      'atlas/pkg/test/a.test.ts',
      'demo/lib/b.test.tsx',
    ])
    // A local run (test-groups.sh) expects the uncommitted one too.
    expect(trackedTestFiles(repo, true)).toEqual([
      'atlas/pkg/test/a.test.ts',
      'atlas/pkg/test/draft.test.ts',
      'demo/lib/b.test.tsx',
    ])

    const reports = temp()
    write(reports, {
      'test-reports-one/shard-01-a.xml': junit('atlas/pkg/test/a.test.ts'),
      'test-reports-two/shard-01-b.xml': junit('demo/lib/b.test.tsx'),
      'test-reports-two/notes.txt': junit('demo/lib/ignored.test.ts'),
    })
    const result = checkTestFilesRan(repo, [reports])

    expect(result.reports).toBe(2)
    expect(result.missing).toEqual([])
    expect(result.unexpected).toEqual([])
    expect(result.duplicated).toEqual([])
  })
})

describe('check-test-files-ran.ts', () => {
  function cli(...dirs: string[]) {
    const run = Bun.spawnSync([process.execPath, SCRIPT, ...dirs], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { code: run.exitCode, out: run.stdout.toString() }
  }

  test('passes when the reports name every tracked atlas test once', () => {
    const tracked = trackedTestFiles(ROOT)
    expect(tracked.length).toBeGreaterThan(0)
    const reports = temp()
    const half = Math.ceil(tracked.length / 2)
    write(reports, {
      'g1/shard-01.xml': junit(...tracked.slice(0, half)),
      'g2/shard-01.xml': junit(...tracked.slice(half)),
    })

    const run = cli(reports)
    expect(run.out).toContain(
      `${tracked.length} tracked, ${tracked.length} ran in 2 reports; missing 0, unexpected 0, duplicated 0`,
    )
    expect(run.code).toBe(0)
  })

  test('fails, naming the file, when one tracked test never ran', () => {
    const tracked = trackedTestFiles(ROOT)
    const reports = temp()
    write(reports, { 'g1/shard-01.xml': junit(...tracked.slice(1)) })

    const run = cli(reports)
    expect(run.out).toContain(
      `::error title=Test file never ran::${tracked[0]}`,
    )
    expect(run.code).toBe(1)
  })

  test('fails when there is no report at all', () => {
    const run = cli(temp())
    expect(run.out).toContain('::error title=No JUnit reports::')
    expect(run.code).toBe(1)
  })

  test('--include-untracked expects the untracked test files as well', () => {
    const files = trackedTestFiles(ROOT, true)
    const reports = temp()
    write(reports, { 'g1/shard-01.xml': junit(...files) })

    const run = cli('--include-untracked', reports)
    expect(run.out).toContain(
      `${files.length} tracked, ${files.length} ran in 1 reports; missing 0`,
    )
    expect(run.code).toBe(0)
    expect(cli('--include-untracked').code).toBe(2)
    expect(cli(reports, '--include-untracked').code).toBe(2)
  })
})
