// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changedOmpBasePaths } from '../check-omp-base-change'
import { git } from '../sync-omp'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
function commit(root: string) {
  git(root, ['add', '--all'])
  git(root, ['commit', '-m', 'fixture'])
  return git(root, ['rev-parse', 'HEAD'])
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qm-base-change-'))
  roots.push(root)
  git(root, ['init', '-b', 'main'])
  mkdirSync(join(root, 'packages'))
  writeFileSync(join(root, 'packages/base.ts'), 'original\n')
  writeFileSync(join(root, 'LICENSE'), 'MIT fixture\n')
  commit(root)
  git(root, ['tag', 'base-snapshot/omp-v1.0.0'])
  mkdirSync(join(root, 'atlas/upstream'), { recursive: true })
  writeFileSync(
    join(root, 'atlas/upstream/omp.json'),
    JSON.stringify({ snapshot: 'base-snapshot/omp-v1.0.0' }),
  )
  const base = commit(root)
  return { root, base }
}
test('Atlas-only additions do not require the upstream suite', () => {
  const { root, base } = fixture()
  writeFileSync(join(root, 'atlas/new.ts'), 'local\n')
  commit(root)
  expect(changedOmpBasePaths(root, base)).toEqual([])
})
test.each([
  'modify',
  'delete',
  'rename',
] as const)('base %s requires the upstream suite', mode => {
  const { root, base } = fixture()
  const file = join(root, 'packages/base.ts')
  if (mode === 'modify') writeFileSync(file, 'changed\n')
  if (mode === 'delete') rmSync(file)
  if (mode === 'rename') renameSync(file, join(root, 'atlas/moved.ts'))
  commit(root)
  expect(changedOmpBasePaths(root, base)).toEqual(['packages/base.ts'])
})
test('snapshot update cannot hide a deleted upstream path', () => {
  const { root, base } = fixture()
  // Construct a second snapshot that excludes the deleted path and Atlas.
  const tree = git(root, ['mktree'], {
    input: `${git(root, ['ls-tree', base, 'LICENSE'])}\n`,
  })
  const snapshot = git(root, ['commit-tree', tree, '-m', 'new snapshot'])
  git(root, ['tag', 'base-snapshot/omp-v1.1.0', snapshot])
  rmSync(join(root, 'packages/base.ts'))
  writeFileSync(
    join(root, 'atlas/upstream/omp.json'),
    JSON.stringify({ snapshot: 'base-snapshot/omp-v1.1.0' }),
  )
  commit(root)
  expect(changedOmpBasePaths(root, base)).toEqual(['packages/base.ts'])
})
test('unavailable comparison commit or snapshot fails closed', () => {
  const { root, base } = fixture()
  expect(() => changedOmpBasePaths(root, 'missing-ref')).toThrow()
  writeFileSync(
    join(root, 'atlas/upstream/omp.json'),
    JSON.stringify({ snapshot: 'base-snapshot/omp-v9.0.0' }),
  )
  expect(() => changedOmpBasePaths(root, base)).toThrow()
})
