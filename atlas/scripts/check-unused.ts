#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Dead-code ratchet over knip, atlas workspaces only (base-switch-omp.md §6).
 *
 * knip runs with `atlas/knip.json`: every `atlas/packages/*` workspace, with
 * the root workspace, omp's `packages/*` and `python/**` ignored. The root
 * `catalog` category is excluded too — the catalog is omp's. The only ignored
 * binary is tsgo, provided at the repository root and exercised by atlas:typecheck.
 * The analyzer runs explicitly on Bun so direct and `bun run` invocations use
 * the same builtin-module resolution (not an incidental Node installation).
 *
 * One budget file, `atlas/scripts/unused-budget.json`, holds the expected
 * count per knip category. The ratchet is two-sided: a count above budget
 * fails (fix it, or raise the budget deliberately), a count below budget fails
 * too until `--update` records the lower baseline in the same change, so an
 * improvement cannot silently erode. knip's normal 0/1 statuses are accepted;
 * execution or report failures fail closed before comparing counts.
 *
 * Usage:
 *   bun atlas/scripts/check-unused.ts
 *   bun atlas/scripts/check-unused.ts --update
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const CONFIG = join(REPO_ROOT, 'atlas', 'knip.json')
const BUDGET_FILE = join(import.meta.dir, 'unused-budget.json')
const SAMPLE_SIZE = 12

export const CATEGORIES = [
  'files',
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'unlisted',
  'unresolved',
  'binaries',
  'exports',
  'types',
  'enumMembers',
  'namespaceMembers',
  'duplicates',
] as const

type Category = (typeof CATEGORIES)[number]
export type Counts = Record<Category, number>

interface KnipIssue {
  name?: string
}
type KnipFileIssues = { file: string } & Partial<
  Record<Category, (KnipIssue | KnipIssue[])[]>
>

/** Count knip's JSON report per category; returns counts and sample entries. */
export function tally(report: { issues?: KnipFileIssues[] }): {
  counts: Counts
  samples: Record<Category, string[]>
} {
  const counts = {} as Counts
  const samples = {} as Record<Category, string[]>
  for (const category of CATEGORIES) {
    counts[category] = 0
    samples[category] = []
  }
  for (const entry of report.issues ?? []) {
    for (const category of CATEGORIES) {
      const items = entry[category]
      if (!Array.isArray(items)) continue
      counts[category] += items.length
      for (const item of items) {
        const name = Array.isArray(item)
          ? item.map(i => i.name).join(' = ')
          : item.name
        samples[category].push(name ? `${entry.file}: ${name}` : entry.file)
      }
    }
  }
  return { counts, samples }
}

/** Categories whose count differs from the budget, with the direction. */
export function compare(
  counts: Counts,
  budget: Partial<Counts>,
): { category: Category; actual: number; budget: number }[] {
  return CATEGORIES.filter(c => counts[c] !== (budget[c] ?? 0)).map(c => ({
    category: c,
    actual: counts[c],
    budget: budget[c] ?? 0,
  }))
}

function runKnip(): { issues?: KnipFileIssues[] } {
  const proc = Bun.spawnSync(
    [
      'bunx',
      '--bun',
      'knip',
      '--config',
      CONFIG,
      '--reporter',
      'json',
      '--no-progress',
      '--exclude',
      'catalog',
    ],
    { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
  )
  const out = proc.stdout.toString()
  try {
    const report: unknown = JSON.parse(out)
    if (proc.exitCode !== 0 && proc.exitCode !== 1)
      throw new Error(`knip exited ${proc.exitCode}`)
    if (
      typeof report !== 'object' ||
      report === null ||
      !('issues' in report) ||
      !Array.isArray(report.issues)
    )
      throw new Error('missing knip issues array')
    return report as { issues: KnipFileIssues[] }
  } catch {
    console.error('[unused] FAIL: knip did not produce a JSON report')
    console.error(proc.stderr.toString().trim() || out.slice(0, 2000))
    process.exit(1)
  }
}

function main(): void {
  const update = process.argv.includes('--update')
  const { counts, samples } = tally(runKnip())

  if (update) {
    writeFileSync(BUDGET_FILE, `${JSON.stringify(counts, null, 2)}\n`)
    console.log(`[unused] budget written: ${JSON.stringify(counts)}`)
    return
  }

  const budget = JSON.parse(
    readFileSync(BUDGET_FILE, 'utf8'),
  ) as Partial<Counts>
  const diffs = compare(counts, budget)
  if (diffs.length === 0) {
    console.log(`[unused] OK — ${JSON.stringify(counts)}`)
    return
  }
  for (const { category, actual, budget: expected } of diffs) {
    if (actual > expected) {
      console.error(
        `[unused] FAIL ${category}: ${actual} > budget ${expected} — new unused code:`,
      )
      for (const line of samples[category].slice(0, SAMPLE_SIZE)) {
        console.error(`  ${line}`)
      }
      if (samples[category].length > SAMPLE_SIZE) {
        console.error(`  … and ${samples[category].length - SAMPLE_SIZE} more`)
      }
    } else {
      console.error(
        `[unused] FAIL ${category}: ${actual} < budget ${expected} — run with --update and commit the lower baseline`,
      )
    }
  }
  process.exit(1)
}

if (import.meta.main) main()
