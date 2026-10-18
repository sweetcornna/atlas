// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Hooks in the `qm handoff` end-to-end suites without sitting out the sync
 * debounce.
 *
 * A hook drains its repository's pending entries no sooner than 5 s after the
 * last sync (`handoffSync.ts` `SYNC_DEBOUNCE_MS`), so a hook that comes right
 * after another sync waits out the rest of those 5 s. These suites test what
 * a sync does, not when it starts; the debounce itself is
 * `handoffSync.test.ts`'s (`debounceMs`). The product is unchanged: the test
 * moves the recorded last sync back by the debounce, through the same read
 * and write the drainer uses.
 */

import {
  readLastSync,
  writeLastSync,
} from '../../../packages/node/src/commands/handoffSync.js'

/** `SYNC_DEBOUNCE_MS` in `handoffSync.ts`, which does not export it. */
const SYNC_DEBOUNCE_MS = 5_000

/**
 * Move the last sync of the repository at `root` — as recorded under the
 * laptop's config root `configDir` — one debounce into the past, so the next
 * hook drains at once. Nothing to do before the first sync.
 */
export function skipSyncDebounce(configDir: string, root: string): void {
  // The handoff paths read QIANMO_CONFIG_DIR on every call (`@qianmo/paths`).
  const saved = process.env.QIANMO_CONFIG_DIR
  process.env.QIANMO_CONFIG_DIR = configDir
  try {
    const last = readLastSync(root)
    if (last !== undefined) {
      writeLastSync(root, { ...last, at: last.at - SYNC_DEBOUNCE_MS })
    }
  } finally {
    if (saved === undefined) delete process.env.QIANMO_CONFIG_DIR
    else process.env.QIANMO_CONFIG_DIR = saved
  }
}
