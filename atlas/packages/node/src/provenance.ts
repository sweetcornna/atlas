// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where a running qm learns which source it was built from.
 *
 * Issue #70: a fleet node's deployment tree has no `.git`, so nothing on a
 * deployed machine could answer "which commit is this" unless the build
 * stamped it. The compiled build (`atlas/scripts/build-qm.ts`) writes
 * `src/generated/provenance.ts` exporting `SOURCE_COMMIT` and `BUILD_TIME`;
 * a source run has no such file and falls back to `QIANMO_SOURCE_COMMIT`,
 * then `git rev-parse HEAD` in the checkout, then {@link UNKNOWN_SOURCE_COMMIT}.
 */

import { spawnSync } from 'node:child_process'
import { VERSION as OMP_VERSION } from '@oh-my-pi/pi-utils/dirs'
import pkg from '../package.json' with { type: 'json' }

/**
 * Reported when no commit can be established — a clean tarball, a
 * `.git`-less container, an unborn branch. A word and not `''`: every
 * consumer reports provenance to a human, and an empty field reads as
 * "nobody filled it in" rather than "the build genuinely does not know".
 */
const UNKNOWN_SOURCE_COMMIT = 'unknown'

type GeneratedProvenance = { SOURCE_COMMIT?: string; BUILD_TIME?: string }

let generated: GeneratedProvenance | null | undefined
let gitCommit: string | undefined

/**
 * The build-generated constants, or `null` in a source run. Loaded with
 * `require` so the tree typechecks and runs without the generated file, while
 * the bundler still embeds it when the build has written it.
 */
function generatedProvenance(): GeneratedProvenance | null {
  if (generated !== undefined) return generated
  try {
    generated = require('./generated/provenance.ts') as GeneratedProvenance
  } catch {
    generated = null
  }
  return generated
}

function gitHead(): string {
  if (gitCommit !== undefined) return gitCommit
  gitCommit = ''
  try {
    const run = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: import.meta.dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    })
    const sha = run.status === 0 ? run.stdout.trim() : ''
    if (/^[0-9a-f]{40}$/.test(sha)) gitCommit = sha
  } catch {
    // no git binary: fall through to unknown
  }
  return gitCommit
}

/**
 * The commit this qm runs from: a 40-char SHA, that SHA with a `-dirty`
 * suffix (as the build stamps it), or {@link UNKNOWN_SOURCE_COMMIT}.
 */
export function sourceCommit(): string {
  return (
    generatedProvenance()?.SOURCE_COMMIT ||
    process.env.QIANMO_SOURCE_COMMIT ||
    gitHead() ||
    UNKNOWN_SOURCE_COMMIT
  )
}

/** The `@qianmo/node` package version. */
export function buildVersion(): string {
  return pkg.version
}

/** The oh-my-pi version qm runs as its agent. */
export function ompVersion(): string {
  return OMP_VERSION
}

/** ISO-8601 timestamp of the compiled build, or `undefined` in a source run. */
export function buildTime(): string | undefined {
  return generatedProvenance()?.BUILD_TIME || undefined
}

/** `qm --version`: `qm <version> (omp <version>) <source commit>`. */
export function versionLine(): string {
  return `qm ${buildVersion()} (omp ${ompVersion()}) ${sourceCommit()}`
}
