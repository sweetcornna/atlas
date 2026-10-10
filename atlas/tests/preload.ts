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
 * - every variable that relocates node or omp state (`QIANMO_*`, `PI_*` /
 *   `OMP_*` directories and profiles, XDG homes, `CLAUDE_CONFIG_DIR`) is
 *   removed, then the config root and CA directory are pointed at a fresh
 *   per-process temp directory, so no test can read or write `~/.qianmo`,
 *   `~/.qianmo-ca`, `~/.omp` or `~/.claude` by default;
 * - `PI_TEST_RUNTIME=1` tells omp code (in-process and in children that inherit
 *   the env) that it runs under a test runner.
 *
 * A test that needs one of these values sets it itself.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolateCredentialEnv } from './support/credentialEnv.ts'

/** Names that move state roots: config/agent dirs, profiles, entries, homes. */
const STATE_ENV =
  /^(?:QIANMO_.+|QMCODE_HOME|(?:PI|OMP)_\w*(?:DIR|HOME|PROFILE|ROOT|PATH|FILE))$/
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
  env.PI_TEST_RUNTIME = '1'
  return cleared
}

isolateTestEnv()
