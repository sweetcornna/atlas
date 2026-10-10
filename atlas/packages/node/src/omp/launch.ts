// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How qm starts the oh-my-pi agent. omp must always run as its own process:
 * its CLI re-enters `Bun.main` to start workers, so importing it into qm would
 * hand qm's entry to those workers.
 *
 * Two layouts:
 * - source tree (dev, local demo, sandbox with node_modules): run the
 *   workspace package's `bin.omp` under the current Bun;
 * - compiled `dist/qm-<target>`: qm and omp share one binary, and
 *   `QIANMO_OMP_ENTRY=self` makes the child `<binary> agent …`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ompChildEnv } from '@qianmo/paths'
import { withoutManagedConfigEnvironment } from '../providers/whitelist.js'

const OMP_PACKAGE = '@oh-my-pi/pi-coding-agent'

function resolveWorkspaceOmpCli(): string {
  let dir = dirname(Bun.resolveSync(OMP_PACKAGE, import.meta.dir))
  while (dir !== dirname(dir)) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: string
        bin?: Record<string, string>
      }
      if (pkg.name === OMP_PACKAGE && pkg.bin?.omp)
        return join(dir, pkg.bin.omp)
    }
    dir = dirname(dir)
  }
  throw new Error(
    `cannot locate ${OMP_PACKAGE} bin.omp from ${import.meta.dir}`,
  )
}

/** argv that runs omp with `args`. `QIANMO_OMP_ENTRY` overrides the entry; `self` means the compiled qm binary. */
export function ompArgv(args: readonly string[]): string[] {
  const entry = process.env.QIANMO_OMP_ENTRY
  if (entry === 'self') return [process.execPath, 'agent', ...args]
  return [process.execPath, entry || resolveWorkspaceOmpCli(), ...args]
}

/** Environment for an omp child: omp state confined to the Qianmo root, plus `extra`. */
export function ompSpawnEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  return withoutManagedConfigEnvironment(
    ompChildEnv({ ...process.env, ...extra }),
  )
}
