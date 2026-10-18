#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Picks `ATLAS_TEST_HEAVY` from the changed paths (the trigger table is in
 * atlas/tests/support/heavy.ts).
 *
 *   heavy-tests.ts [--event <github.event_name>] <base-ref>
 *       CI. Paths changed in `<base-ref>...HEAD`. Any event other than
 *       `pull_request` turns everything on without looking at the diff.
 *   heavy-tests.ts --local
 *       This checkout. Paths changed since `git merge-base origin/main HEAD`,
 *       plus staged, unstaged and untracked ones.
 *
 * Prints the value (`all`, `none` or a comma list) on stdout and why on
 * stderr; with `GITHUB_ENV` set, also appends `ATLAS_TEST_HEAVY=<value>`
 * there. When git cannot answer (a base that is not fetched, no origin/main)
 * the answer is `all` with a warning: running too much is the safe mistake.
 */
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  HEAVY_EVERYTHING,
  HEAVY_SETS,
  HEAVY_TRIGGERS,
  type HeavySet,
} from '../../tests/support/heavy'
import { git } from '../sync-omp'

export interface HeavyChoice {
  /** The value for ATLAS_TEST_HEAVY. */
  value: string
  /** One line per decision, for the log. */
  reasons: string[]
  /** True when git failed and the choice fell back to `all`. */
  fallback: boolean
}

function matcher(patterns: readonly string[]): (path: string) => boolean {
  const globs = patterns.map(pattern => new Bun.Glob(pattern))
  return path => globs.some(glob => glob.match(path))
}

function sample(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(', ')
  return paths.length > 3 ? `${shown}, +${paths.length - 3} more` : shown
}

/** The sets a list of changed paths turns on. */
export function heavyFor(paths: readonly string[]): HeavyChoice {
  const everything = paths.filter(matcher(HEAVY_EVERYTHING))
  if (everything.length > 0)
    return {
      value: 'all',
      reasons: [`all: ${sample(everything)}`],
      fallback: false,
    }
  const on: HeavySet[] = []
  const reasons: string[] = []
  for (const set of HEAVY_SETS) {
    const hits = paths.filter(matcher(HEAVY_TRIGGERS[set]))
    if (hits.length > 0) on.push(set)
    reasons.push(
      hits.length > 0 ? `${set}: ${sample(hits)}` : `${set}: no trigger path`,
    )
  }
  return {
    value: on.length > 0 ? on.join(',') : 'none',
    reasons,
    fallback: false,
  }
}

function names(output: string): string[] {
  return output.split('\0').filter(Boolean)
}

/** Paths changed in `<base>...HEAD`; renames count as both sides. */
export function changedPaths(root: string, base: string): string[] {
  return names(
    git(root, [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      '--end-of-options',
      `${base}...HEAD`,
      '--',
    ]),
  )
}

/** Paths changed since this branch left origin/main, committed or not. */
export function localChangedPaths(root: string): string[] {
  const base = git(root, ['merge-base', 'origin/main', 'HEAD'])
  const paths = new Set([
    ...changedPaths(root, base),
    ...names(
      git(root, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--']),
    ),
    ...names(git(root, ['ls-files', '--others', '--exclude-standard', '-z'])),
  ])
  return [...paths].sort()
}

function fallback(reason: string): HeavyChoice {
  return { value: 'all', reasons: [`all: ${reason}`], fallback: true }
}

export function chooseHeavy(
  root: string,
  request: { local: true } | { event?: string; base: string },
): HeavyChoice {
  if (!('local' in request)) {
    if (request.event !== undefined && request.event !== 'pull_request')
      return {
        value: 'all',
        reasons: [`all: ${request.event} runs everything`],
        fallback: false,
      }
    if (request.base === '') return fallback('no base ref to compare with')
  }
  let paths: string[]
  try {
    paths =
      'local' in request
        ? localChangedPaths(root)
        : changedPaths(root, request.base)
  } catch (error) {
    return fallback(
      (error instanceof Error ? error.message : String(error))
        .split('\n')[0]
        .trim(),
    )
  }
  return heavyFor(paths)
}

const USAGE =
  'Usage: heavy-tests.ts [--event <github.event_name>] <base-ref> | --local'

function parse(argv: readonly string[]): Parameters<typeof chooseHeavy>[1] {
  if (argv.length === 1 && argv[0] === '--local') return { local: true }
  if (argv.length === 1 && !argv[0].startsWith('--')) return { base: argv[0] }
  if (argv.length === 3 && argv[0] === '--event' && !argv[2].startsWith('--'))
    return { event: argv[1], base: argv[2] }
  throw new Error(USAGE)
}

if (import.meta.main) {
  let request: Parameters<typeof chooseHeavy>[1]
  try {
    request = parse(process.argv.slice(2))
  } catch {
    console.error(USAGE)
    process.exit(2)
  }
  const choice = chooseHeavy(resolve(import.meta.dir, '../../..'), request)
  for (const reason of choice.reasons)
    console.error(`heavy test sets: ${reason}`)
  if (choice.fallback)
    console.error(
      `::warning title=Heavy test sets fell back to all::${choice.reasons[0]}`,
    )
  console.log(choice.value)
  if (process.env.GITHUB_ENV)
    appendFileSync(process.env.GITHUB_ENV, `ATLAS_TEST_HEAVY=${choice.value}\n`)
}
