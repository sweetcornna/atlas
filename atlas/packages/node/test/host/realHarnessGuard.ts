// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * For tests that start a real harness (P36.7): the harness writes where the
 * node's config root says, so a root under the real home (a run without
 * `--preload ./atlas/tests/preload.ts` and without `isolatedRoot()`) would
 * install into the user's own `~/.qianmo`. Such a run fails here instead.
 */

import { homedir } from 'node:os'
import { relative } from 'node:path'
import { qianmoConfigDir } from '@qianmo/paths'

/** The home when the test process started, before any test moved `HOME`. */
export const REAL_HOME = homedir()

export function assertScratchConfigRoot(): void {
  const root = qianmoConfigDir()
  const rel = relative(REAL_HOME, root)
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/')))
    throw new Error(
      `the config root ${root} is under the real home ${REAL_HOME}; run with --preload ./atlas/tests/preload.ts`,
    )
}
