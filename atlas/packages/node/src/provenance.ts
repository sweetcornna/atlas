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

type GeneratedProvenance = {
  SOURCE_COMMIT?: string
  BUILD_TIME?: string
  RELEASE_VERSION?: string
  EDITION?: string
}

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

const FULL_SHA = /^[0-9a-f]{40}$/

/** Whether the checkout this module runs from has no changes to tracked files. */
function trackedFilesClean(): boolean {
  try {
    const run = spawnSync(
      'git',
      ['status', '--porcelain', '--untracked-files=no'],
      {
        cwd: import.meta.dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      },
    )
    return run.status === 0 && run.stdout.trim() === ''
  } catch {
    return false
  }
}

/**
 * The commit a public deployment can name as its corresponding source (AGPL
 * §13, public-edition.md §0): a full SHA this qm is known to run exactly, or
 * `null`. A build's stamp and `QIANMO_SOURCE_COMMIT` are taken at their word,
 * so `<sha>-dirty` and `unknown` publish nothing; a source run with neither
 * counts only while its checkout has no changes to tracked files — the check
 * `build-qm.ts` makes before it stamps a build.
 */
export function publishedSourceCommit(): string | null {
  const commit = sourceCommit()
  if (!FULL_SHA.test(commit)) return null
  if (generatedProvenance()?.SOURCE_COMMIT || process.env.QIANMO_SOURCE_COMMIT)
    return commit
  return trackedFilesClean() ? commit : null
}

/**
 * `<sourceUrl>/tree/<commit>`: the repository `sourceUrl` names, at one
 * commit. `sourceUrl` is the repository's home, so a query or a fragment is
 * refused rather than carried into a link that would no longer say which
 * tree it is.
 */
export function sourceTreeUrl(sourceUrl: string, commit: string): string {
  if (!FULL_SHA.test(commit))
    throw new Error(`the source link needs a full commit, not ${commit}`)
  const url = new URL(sourceUrl)
  if (url.search !== '' || url.hash !== '')
    throw new Error(
      `sourceUrl names a repository: no query or fragment (${sourceUrl})`,
    )
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/tree/${commit}`
  return url.toString()
}

/**
 * The link every public-edition page gives for its source: the configured
 * repository at this build's commit. Throws when this build cannot name one
 * clean commit — a public deployment then has no corresponding source it
 * could honestly point at, and does not start (`commands/console.ts`).
 */
export function publicSourceUrl(sourceUrl: string): string {
  const commit = publishedSourceCommit()
  if (commit === null)
    throw new Error(
      `the source link needs a build from one clean commit, and this build is ${sourceCommit()} · build the public edition from a committed checkout`,
    )
  return sourceTreeUrl(sourceUrl, commit)
}

/** A release build's tag version, else the `@qianmo/node` package version. */
export function buildVersion(): string {
  return generatedProvenance()?.RELEASE_VERSION || pkg.version
}

/** The oh-my-pi version qm runs as its agent. */
export function ompVersion(): string {
  return OMP_VERSION
}

/** Deployment editions: the self-hosted default and the subscription-only public edition (public-edition.md §0). */
export type Edition = 'default' | 'public'

/**
 * The edition this qm runs as. A public build (`build-qm.ts --edition public`)
 * stamps `EDITION='public'` and cannot be switched back; any other build or a
 * source run is `default` unless `QIANMO_EDITION=public` opts in (tests,
 * operators trying the public console from source).
 */
export function buildEdition(): Edition {
  if (generatedProvenance()?.EDITION === 'public') return 'public'
  return process.env.QIANMO_EDITION === 'public' ? 'public' : 'default'
}

/** ISO-8601 timestamp of the compiled build, or `undefined` in a source run. */
export function buildTime(): string | undefined {
  return generatedProvenance()?.BUILD_TIME || undefined
}

/** `qm --version`: `qm <version> (omp <version>) <source commit>`. */
export function versionLine(): string {
  return `qm ${buildVersion()} (omp ${ompVersion()}) ${sourceCommit()}`
}
