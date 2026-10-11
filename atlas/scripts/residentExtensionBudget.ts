// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

// The host-backed bundle measured ~39 KB on Bun 1.4.2 (2026-10-11).
// Allow roughly 3x growth, well below the former 43 MB duplicate omp graph.
export const RESIDENT_EXTENSION_MAX_BYTES = 120_000

/** Check the emitted/extracted artifact, including its asset bootstrap. */
export function assertResidentExtensionBudget(source: string): number {
  const bytes = Buffer.byteLength(source)
  if (bytes > RESIDENT_EXTENSION_MAX_BYTES)
    throw new Error(
      `Resident extension is ${bytes} bytes; limit is ${RESIDENT_EXTENSION_MAX_BYTES}`,
    )
  for (const marker of ['omp-legacy-pi-modules', 'packages/coding-agent/src/'])
    if (source.includes(marker))
      throw new Error(
        `Resident extension contains bundled host code: ${marker}`,
      )
  return bytes
}
