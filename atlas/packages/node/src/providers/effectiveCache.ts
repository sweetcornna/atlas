// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The last `effective` this node computed, reused by `status` while the
 * inputs it was computed from are unchanged.
 *
 * Computing `effective` starts a second qm (`provider __effective`, a few
 * hundred MB while it loads omp's model registry). The hub's 10-minute
 * background refresh asked for it every time, almost always getting the
 * same answer. On a host running two nodes, the refresh started two such
 * children back to back; when that landed next to two agent children it
 * pushed available memory below 400 MB (2026-10-15, p3).
 *
 * An entry is keyed by a fingerprint of what this process can see without
 * loading omp:
 *
 *   - the bytes of `models.yml` and of omp's own settings files for an
 *     agent directory that is also its cwd (`config.yml` / `config.yaml` and
 *     the project layer `.omp/config.yml` / `.omp/settings.json`);
 *   - the state's `appliedHash`, `loadedHash` and `onDiskHash`;
 *   - the executable (path, inode, size, mtime), which a deploy changes.
 *
 * Inputs it cannot see, such as settings found by capability discovery
 * (other tools' settings files in that directory) or the forced command's
 * environment, are bounded by age: an entry older than
 * {@link EFFECTIVE_CACHE_MAX_AGE_MS} is recomputed whatever its fingerprint.
 *
 * Only successful computations are kept. The file is 0600, written
 * atomically, and only into a provider directory that already exists, so
 * looking at a node never creates its private state.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR_NAME, MAIN_CONFIG_FILENAMES } from '@oh-my-pi/pi-utils/dirs'
import { ompAgentDir } from '@qianmo/paths'
import type { EffectiveState, ProviderNodeState } from '@qianmo/providers'
import { isEffectiveState } from './effectiveProcess.js'
import { providerDir, providerPaths, writePrivateJson } from './store.js'

/** Longest an entry is trusted for inputs the fingerprint cannot see. */
export const EFFECTIVE_CACHE_MAX_AGE_MS = 30 * 60_000

const CACHE_VERSION = 1

type HashedState = Pick<
  ProviderNodeState,
  'appliedHash' | 'loadedHash' | 'onDiskHash'
>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fileDigest(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? 'missing' : `unreadable:${code ?? 'unknown'}`
  }
}

function executableIdentity(): string {
  try {
    const stat = statSync(process.execPath)
    return `${process.execPath}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return `${process.execPath}:unknown`
  }
}

/** The fingerprint of the inputs `effective` is computed from. */
export function effectiveInputsFingerprint(state: HashedState): string {
  const agent = ompAgentDir()
  const files = [
    providerPaths.models(),
    ...MAIN_CONFIG_FILENAMES.map(name => join(agent, name)),
    join(agent, CONFIG_DIR_NAME, 'config.yml'),
    join(agent, CONFIG_DIR_NAME, 'settings.json'),
  ]
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: CACHE_VERSION,
        executable: executableIdentity(),
        state: [state.appliedHash, state.loadedHash, state.onDiskHash],
        files: files.map(path => [path, fileDigest(path)]),
      }),
    )
    .digest('hex')
}

/** The cached `effective` for `fingerprint`, if it is young enough. */
export function readCachedEffective(
  fingerprint: string,
  now: number,
): EffectiveState | undefined {
  let entry: unknown
  try {
    entry = JSON.parse(readFileSync(providerPaths.effectiveCache(), 'utf8'))
  } catch {
    return undefined
  }
  if (
    !isRecord(entry) ||
    entry.v !== CACHE_VERSION ||
    entry.fingerprint !== fingerprint ||
    typeof entry.computedAt !== 'number'
  )
    return undefined
  const age = now - entry.computedAt
  if (!(age >= 0 && age < EFFECTIVE_CACHE_MAX_AGE_MS)) return undefined
  return isEffectiveState(entry.effective) ? entry.effective : undefined
}

/** Keep a freshly computed `effective`; never creates the provider directory. */
export function writeCachedEffective(
  fingerprint: string,
  effective: EffectiveState,
  now: number,
): void {
  if (!existsSync(providerDir())) return
  try {
    writePrivateJson(providerPaths.effectiveCache(), {
      v: CACHE_VERSION,
      fingerprint,
      computedAt: now,
      effective,
    })
  } catch {
    // An entry that cannot be written is a miss next time, nothing more.
  }
}
