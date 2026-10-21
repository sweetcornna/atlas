// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Preload for every atlas test shard (`atlas/scripts/test-shards.sh` passes it
 * with `--preload`; the root bunfig.toml does not, so omp's own suites never
 * load it).
 *
 * Applied once per test process, before any test file loads:
 * - credentials and login switches from the developer's shell are removed
 *   (`support/credentialEnv.ts`);
 * - every variable that relocates node, client or omp state (`QIANMO_*`,
 *   `QMO_*`, `PI_*` / `OMP_*` directories and profiles, XDG homes,
 *   `CLAUDE_CONFIG_DIR`) is removed, then the config root, CA directory and
 *   `qmo` client directory are pointed at a fresh per-process temp directory,
 *   so no test can read or write `~/.qianmo`, `~/.qianmo-ca`, `~/.omp`,
 *   `~/.claude` or the client's state by default;
 * - `PI_TEST_RUNTIME=1` tells omp code (in-process and in children that inherit
 *   the env) that it runs under a test runner;
 * - an `ATLAS_TEST_HEAVY` naming a heavy test set that does not exist fails
 *   the process (`support/heavy.ts`); the variable itself is left alone.
 *
 * A test that needs one of these values sets it itself.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolateCredentialEnv } from './support/credentialEnv.ts'
import { heavySets } from './support/heavy.ts'

/** Names that move state roots: config/agent dirs, profiles, entries, homes. */
const STATE_ENV =
  /^(?:QIANMO_.+|QMO_.+|QMCODE_HOME|(?:PI|OMP)_\w*(?:DIR|HOME|PROFILE|ROOT|PATH|FILE))$/
const SCRUB_ENV: Record<string, true> = {
  CLAUDE_CONFIG_DIR: true,
  XDG_DATA_HOME: true,
  XDG_STATE_HOME: true,
  XDG_CACHE_HOME: true,
  XDG_CONFIG_HOME: true,
  OPENAI_MODEL: true,
}

// Explicit test executables select coverage; they do not relocate runtime state.
const TEST_BINARIES = new Set([
  'QIANMO_TEST_QMCODE_BIN',
  'QIANMO_TEST_COMPILED_QM',
])

/** Remove credential and state-root variables from `env`; returns the removed names. */
export function isolateTestEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const cleared = isolateCredentialEnv(env)
  for (const name of Object.keys(env)) {
    if (!TEST_BINARIES.has(name) && (STATE_ENV.test(name) || SCRUB_ENV[name])) {
      delete env[name]
      cleared.push(name)
    }
  }
  const root = mkdtempSync(join(tmpdir(), `qianmo-test-${process.pid}-`))
  env.QIANMO_CONFIG_DIR = join(root, 'config')
  env.QIANMO_CA_DIR = join(root, 'ca')
  env.QMCODE_HOME = join(root, 'qmcode')
  // The `qmo` client's state (clients.md §5.1), never the developer's own.
  env.QMO_CLIENT_DIR = join(root, 'qmo-client')
  env.PI_TEST_RUNTIME = '1'
  // A `qm resident` a test starts never downloads a runtime (P36 §2).
  env.QIANMO_RUNTIME_AUTOINSTALL = '0'
  return cleared
}

isolateTestEnv()

// A misspelt ATLAS_TEST_HEAVY fails every test file here, before a test can
// read the name it does not know as "skip" (support/heavy.ts).
heavySets(process.env.ATLAS_TEST_HEAVY)
