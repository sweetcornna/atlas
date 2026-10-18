// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `heavy()` of atlas/tests/support/heavy.ts, for this package's tests: they
 * load nothing from outside the package (dependencies.test.ts), so the shared
 * helper cannot be imported here. Same reading of `ATLAS_TEST_HEAVY` (unset or
 * empty, `all`, `none`, a comma list); the preload has already refused a set
 * name it does not know, and atlas/scripts/__tests__/heavyTests.test.ts checks
 * that this copy agrees with the shared one.
 */

type ConsoleHeavySet = 'route-docs'

export function heavyIn(
  value: string | undefined,
  set: ConsoleHeavySet,
): boolean {
  const names = (value ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
  return names.length === 0 || names.includes('all') || names.includes(set)
}

/** Whether the heavy tests of `set` run in this process. */
export function heavy(set: ConsoleHeavySet): boolean {
  return heavyIn(process.env.ATLAS_TEST_HEAVY, set)
}
