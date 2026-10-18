// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Heavy test sets: tests that only a narrow set of paths can turn red, run on
 * a pull request only when one of those paths changed.
 *
 * A heavy test registers as `describe.skipIf(!heavy('<set>'))(…)` (or
 * `test.skipIf` for one test), so a skipped one still shows in the JUnit
 * report and `check-test-files-ran.ts` still sees its file. Which sets run is
 * `ATLAS_TEST_HEAVY`: `all`, `none`, or a comma list of set names. Unset or
 * empty means all, so running a file by hand runs everything.
 *
 * The name has no `QIANMO_` prefix on purpose: `tests/preload.ts` deletes
 * every `QIANMO_…` variable before a test file loads.
 *
 * Who sets it: `atlas/scripts/ci/heavy-tests.ts` matches the changed paths
 * against `HEAVY_TRIGGERS` below. CI's `test` job runs it on pull requests and
 * runs everything on every other event (main pushes, the nightly schedule,
 * manual runs); `atlas/scripts/test-groups.sh` runs it on the local diff
 * against `origin/main`. A dependency missing from a set is caught by the next
 * main push at the latest.
 */

/** The paths that turn each set on. Globs are `Bun.Glob`, repo-relative. */
export const HEAVY_TRIGGERS = {
  /** routeDocs.test.ts「every routed path is documented」: the reverse scan. */
  'route-docs': [
    'atlas/packages/console/**',
    // The console's routes are built from these two packages' types and readers.
    'atlas/packages/audit/**',
    'atlas/packages/protocol/**',
    'docs/dev/console.md',
  ],
  /**
   * The P16.2b/P16.3 evidence gates (docs/dev/memory-m1.md):
   * retrieval-gates.test.ts「P16.2b acceptance: null rankers on the hardened
   * corpus」, heldout.test.ts's two null-ranker judgments, and three
   * qianmo-recall-answer-eval.test.ts cases (the preregistered dry run, the
   * M1 replay and the M1 dry run).
   */
  'recall-eval': [
    'atlas/packages/recall/**',
    'atlas/packages/memory/**',
    'atlas/packages/paths/**',
    // Imported by qianmo-recall-answer-eval.ts for the M1 arm's embedder.
    'atlas/packages/node/src/host/memoryEmbedding.ts',
    'atlas/scripts/qianmo-recall-*.ts',
    'atlas/scripts/__tests__/qianmo-recall-*',
    // Base utility files the answer eval reaches through its imports.
    'packages/utils/src/**',
  ],
} as const satisfies Record<string, readonly string[]>

export type HeavySet = keyof typeof HEAVY_TRIGGERS

/** A change to any of these turns every set on: they decide what the tests
 * see, how they are run, or which ones run. This file is under the support
 * glob. */
export const HEAVY_EVERYTHING = [
  'bun.lock',
  'package.json',
  '.tool-versions',
  'atlas/tests/preload.ts',
  'atlas/tests/support/**',
  'atlas/scripts/test-shards.sh',
  'atlas/scripts/test-groups.sh',
  'atlas/scripts/ci/heavy-tests.ts',
  '.github/workflows/atlas.yml',
] as const

export const HEAVY_SETS = Object.keys(HEAVY_TRIGGERS) as HeavySet[]

/**
 * The sets `ATLAS_TEST_HEAVY` turns on. An unknown name throws, so a typo
 * fails the test file loudly instead of silently skipping its heavy tests.
 */
export function heavySets(value: string | undefined): ReadonlySet<HeavySet> {
  const names = (value ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
  if (names.length === 0 || names.includes('all')) return new Set(HEAVY_SETS)
  const on = new Set<HeavySet>()
  for (const name of names) {
    if (name === 'none') continue
    if (!(HEAVY_SETS as string[]).includes(name))
      throw new Error(
        `ATLAS_TEST_HEAVY: unknown set "${name}" (known: all, none, ${HEAVY_SETS.join(', ')})`,
      )
    on.add(name as HeavySet)
  }
  return on
}

/** Whether the heavy tests of `set` run in this process. */
export function heavy(set: HeavySet): boolean {
  return heavySets(process.env.ATLAS_TEST_HEAVY).has(set)
}
