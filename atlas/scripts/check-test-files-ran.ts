#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Proves the atlas suite ran every test file exactly once.
 *
 * CI splits the suite over the `test` matrix in .github/workflows/atlas.yml
 * (`test-shards.sh --group`). Green jobs are not evidence that anything ran: a
 * shard that finds no tests is skipped, and from 10-10 to 10-18 a SIGPIPE in the
 * probe dropped atlas/packages/node from every Linux run while CI stayed green.
 * This reads the JUnit reports every group uploaded and compares the test files
 * they name with the tracked ones (`git ls-files`, `*.test.ts(x)` under `atlas/`
 * and `demo/`):
 *
 *   missing     tracked, never ran. A file that registers no test at all is
 *               missing too: Bun leaves it out of the report. Skip its tests
 *               (`test.skip`, `describe.skipIf`) instead, so the report shows it.
 *   unexpected  ran, but is not a tracked atlas test file: an omp test pulled in
 *               by a substring filter, or a file nobody committed.
 *   duplicated  ran in more than one shard.
 *
 * Any of the three fails, as does finding no report at all.
 *
 * Usage: bun atlas/scripts/check-test-files-ran.ts <report-dir> …
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const TRACKED = [
  'atlas/*.test.ts',
  'atlas/*.test.tsx',
  'demo/*.test.ts',
  'demo/*.test.tsx',
]

export interface Report {
  /** Report path, for naming the shards a file ran in. */
  path: string
  files: readonly string[]
}

export interface TestFilesRan {
  tracked: number
  reports: number
  ran: number
  missing: string[]
  unexpected: string[]
  duplicated: { file: string; reports: string[] }[]
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decode(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name])
}

/** The test files a Bun JUnit report names (its `file` attributes). */
export function junitFiles(xml: string): string[] {
  const files = new Set<string>()
  for (const tag of xml.matchAll(/<(?:testsuite|testcase)\s[^>]*>/g)) {
    const file = /\sfile="([^"]*)"/.exec(tag[0])
    if (file) files.add(decode(file[1]))
  }
  return [...files].sort()
}

export function trackedTestFiles(root: string): string[] {
  const run = Bun.spawnSync(['git', 'ls-files', '-z', '--', ...TRACKED], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (run.exitCode !== 0)
    throw new Error(`git ls-files failed: ${run.stderr.toString().trim()}`)
  return run.stdout.toString().split('\0').filter(Boolean).sort()
}

export function readReports(dirs: readonly string[]): Report[] {
  const reports: Report[] = []
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.xml'))
        reports.push({ path, files: junitFiles(readFileSync(path, 'utf8')) })
    }
  }
  for (const dir of dirs) walk(dir)
  return reports
}

export function compareTestFiles(
  tracked: readonly string[],
  reports: readonly Report[],
): TestFilesRan {
  const ranIn = new Map<string, string[]>()
  for (const report of reports)
    for (const file of report.files)
      ranIn.set(file, [...(ranIn.get(file) ?? []), report.path])
  const expected = new Set(tracked)
  return {
    tracked: expected.size,
    reports: reports.length,
    ran: ranIn.size,
    missing: [...expected].filter(file => !ranIn.has(file)).sort(),
    unexpected: [...ranIn.keys()].filter(file => !expected.has(file)).sort(),
    duplicated: [...ranIn]
      .filter(([, paths]) => paths.length > 1)
      .map(([file, paths]) => ({ file, reports: paths }))
      .sort((a, b) => a.file.localeCompare(b.file)),
  }
}

export function checkTestFilesRan(
  root: string,
  reportDirs: readonly string[],
): TestFilesRan {
  return compareTestFiles(trackedTestFiles(root), readReports(reportDirs))
}

if (import.meta.main) {
  const dirs = process.argv.slice(2)
  if (dirs.length === 0) {
    console.error('Usage: bun atlas/scripts/check-test-files-ran.ts <dir> …')
    process.exit(2)
  }
  const result = checkTestFilesRan(resolve(import.meta.dir, '../..'), dirs)
  console.log(
    `atlas test files: ${result.tracked} tracked, ${result.ran} ran in ` +
      `${result.reports} reports; missing ${result.missing.length}, ` +
      `unexpected ${result.unexpected.length}, ` +
      `duplicated ${result.duplicated.length}`,
  )
  for (const file of result.missing)
    console.log(`::error title=Test file never ran::${file}`)
  for (const file of result.unexpected)
    console.log(
      `::error title=Ran a file that is not a tracked atlas test::${file}`,
    )
  for (const { file, reports } of result.duplicated)
    console.log(
      `::error title=Test file ran in more than one shard::${file} (${reports.join(', ')})`,
    )
  if (result.reports === 0)
    console.log(
      `::error title=No JUnit reports::nothing under ${dirs.join(' ')}`,
    )
  if (
    result.reports === 0 ||
    result.missing.length > 0 ||
    result.unexpected.length > 0 ||
    result.duplicated.length > 0
  )
    process.exit(1)
}
