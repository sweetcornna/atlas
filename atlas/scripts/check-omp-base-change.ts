#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Decide whether CI must run the upstream TS suite. Renames are deliberately
 * expanded to deletion/addition so moving a base file cannot evade the gate.
 * The root package.json is a base file that also carries Atlas's scripts; a
 * change confined to those does not require the suite (see atlasOnlyManifest). */
import { appendFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { git } from './sync-omp'

const MANIFEST = 'atlas/upstream/omp.json'
const ROOT_PACKAGE = 'package.json'

/** Root scripts Atlas owns (CLAUDE.full.md §3): the `atlas:` and `qianmo:`
 * prefixes plus `qm`, `precheck` and `verify`. Nothing in omp runs them. */
function isAtlasScript(name: string): boolean {
  return (
    /^(atlas|qianmo):/.test(name) ||
    name === 'qm' ||
    name === 'precheck' ||
    name === 'verify'
  )
}

function withoutAtlasScripts(contents: string): string | null {
  let manifest: unknown
  try {
    manifest = JSON.parse(contents)
  } catch {
    return null
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    return null
  const { scripts } = manifest as { scripts?: unknown }
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts))
    return JSON.stringify(manifest)
  return JSON.stringify({
    ...manifest,
    scripts: Object.fromEntries(
      Object.entries(scripts).filter(([name]) => !isAtlasScript(name)),
    ),
  })
}

/** True when two versions of the root package.json differ only in Atlas's own
 * scripts. Every other field and script, key order included, still counts; so
 * does a side that is missing or not a JSON object. */
export function atlasOnlyManifest(before: string, after: string): boolean {
  const base = withoutAtlasScripts(before)
  return base !== null && base === withoutAtlasScripts(after)
}

function snapshotFromManifest(contents: string): string {
  const pin = JSON.parse(contents) as { snapshot?: unknown }
  if (
    typeof pin.snapshot !== 'string' ||
    !/^base-snapshot\/omp-v\d+\.\d+\.\d+$/.test(pin.snapshot)
  )
    throw new Error('Invalid omp snapshot in manifest')
  return pin.snapshot
}

export function changedOmpBasePaths(
  root: string,
  baseRef: string,
  headRef = 'HEAD',
): string[] {
  const base = git(root, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${baseRef}^{commit}`,
  ])
  const head = git(root, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${headRef}^{commit}`,
  ])
  const snapshots = new Set([
    snapshotFromManifest(readFileSync(join(root, MANIFEST), 'utf8')),
  ])
  // A sync can remove a path from the new snapshot. Keep the previous pin's
  // paths in the boundary too, including deletions in that same update.
  const previous = git(root, ['show', `${base}:${MANIFEST}`], {
    allowFailure: true,
  })
  if (previous) snapshots.add(snapshotFromManifest(previous))
  const basePaths = new Set<string>()
  for (const snapshot of snapshots) {
    const paths = git(root, ['ls-tree', '-r', '--name-only', '-z', snapshot])
      .split('\0')
      .filter(Boolean)
    if (paths.length === 0) throw new Error(`Empty omp snapshot: ${snapshot}`)
    for (const path of paths) basePaths.add(path)
  }
  return git(root, [
    'diff',
    '--no-renames',
    '--name-only',
    '-z',
    base,
    head,
    '--',
  ])
    .split('\0')
    .filter(path => basePaths.has(path))
    .filter(
      path =>
        path !== ROOT_PACKAGE ||
        !atlasOnlyManifest(
          git(root, ['show', `${base}:${ROOT_PACKAGE}`], {
            allowFailure: true,
          }),
          git(root, ['show', `${head}:${ROOT_PACKAGE}`], {
            allowFailure: true,
          }),
        ),
    )
    .sort()
}

if (import.meta.main) {
  const base = process.argv[2]
  if (!base)
    throw new Error('Usage: check-omp-base-change.ts <base-ref> | --all')
  const paths =
    base === '--all'
      ? []
      : changedOmpBasePaths(resolve(import.meta.dir, '../..'), base)
  const required = base === '--all' || paths.length > 0
  console.log(
    JSON.stringify({
      required,
      reason:
        base === '--all' ? 'manual-or-new-branch' : 'changed-snapshot-paths',
      paths,
    }),
  )
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `required=${required}\n`)
}
