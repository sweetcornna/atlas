#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Decide whether CI must run the upstream TS suite. Renames are deliberately
 * expanded to deletion/addition so moving a base file cannot evade the gate. */
import { appendFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { git } from './sync-omp'

const MANIFEST = 'atlas/upstream/omp.json'
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
