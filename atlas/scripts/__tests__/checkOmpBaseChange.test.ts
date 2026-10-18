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
import {
  atlasOnlyManifest,
  changedOmpBasePaths,
} from '../check-omp-base-change'
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
const PACKAGE = {
  name: 'omp-fixture',
  workspaces: ['packages/*'],
  scripts: {
    build: 'bun run --workspaces build',
    'test:ts': 'bun scripts/ci-test-ts.ts local-ts',
    'atlas:test': 'bash atlas/scripts/test-shards.sh',
    'qianmo:acceptance': 'bun atlas/scripts/qianmo-acceptance.ts',
    qm: 'bun atlas/packages/node/src/cli.ts',
    precheck: 'bun run atlas:test',
    verify: 'bun run atlas:test',
  },
  devDependencies: { typescript: '1.0.0' },
}
type Package = typeof PACKAGE
function manifest(pkg: unknown): string {
  return `${JSON.stringify(pkg, null, 2)}\n`
}
function scripts(edit: (scripts: Record<string, string>) => void): Package {
  const next = structuredClone(PACKAGE) as Package & {
    scripts: Record<string, string>
  }
  edit(next.scripts)
  return next
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qm-base-change-'))
  roots.push(root)
  git(root, ['init', '-b', 'main'])
  mkdirSync(join(root, 'packages'))
  writeFileSync(join(root, 'packages/base.ts'), 'original\n')
  writeFileSync(join(root, 'LICENSE'), 'MIT fixture\n')
  writeFileSync(join(root, 'package.json'), manifest(PACKAGE))
  writeFileSync(join(root, 'bun.lock'), 'lock fixture\n')
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

test.each([
  ['change an atlas: script', scripts(s => (s['atlas:test'] = 'changed'))],
  ['add an atlas: script', scripts(s => (s['atlas:check:new'] = 'new'))],
  ['add a qianmo: script', scripts(s => (s['qianmo:new'] = 'new'))],
  ['remove qm', scripts(s => delete s.qm)],
  ['change precheck', scripts(s => (s.precheck = 'changed'))],
  ['change verify', scripts(s => (s.verify = 'changed'))],
] as const)('package.json: %s does not require the upstream suite', (_, pkg) => {
  const { root, base } = fixture()
  writeFileSync(join(root, 'package.json'), manifest(pkg))
  commit(root)
  expect(changedOmpBasePaths(root, base)).toEqual([])
})
test.each([
  ['change an omp script', scripts(s => (s['test:ts'] = 'changed'))],
  ['add an omp script', scripts(s => (s.lint = 'oxlint .'))],
  [
    'add a script that only looks like ours',
    scripts(s => (s['verify:all'] = 'x')),
  ],
  [
    'add an atlas- script without the colon',
    scripts(s => (s['atlas-x'] = 'x')),
  ],
  [
    'change a dependency',
    { ...PACKAGE, devDependencies: { typescript: '2.0.0' } },
  ],
  [
    'change the workspaces',
    { ...PACKAGE, workspaces: ['packages/*', 'atlas/*'] },
  ],
] as const)('package.json: %s requires the upstream suite', (_, pkg) => {
  const { root, base } = fixture()
  writeFileSync(join(root, 'package.json'), manifest(pkg))
  commit(root)
  expect(changedOmpBasePaths(root, base)).toEqual(['package.json'])
})
test('bun.lock still counts beside an atlas-only package.json change', () => {
  const { root, base } = fixture()
  writeFileSync(
    join(root, 'package.json'),
    manifest(scripts(s => (s['atlas:test'] = 'changed'))),
  )
  writeFileSync(join(root, 'bun.lock'), 'lock changed\n')
  commit(root)
  expect(changedOmpBasePaths(root, base)).toEqual(['bun.lock'])
})
test('a package.json that is not a JSON object counts', () => {
  const { root, base } = fixture()
  writeFileSync(join(root, 'package.json'), '{ not json\n')
  commit(root)
  expect(changedOmpBasePaths(root, base)).toEqual(['package.json'])
  expect(atlasOnlyManifest('[]', '[]')).toBe(false)
  expect(atlasOnlyManifest(manifest(PACKAGE), '')).toBe(false)
})
test('reordering omp keys counts; reformatting alone does not', () => {
  const { scripts: own, ...rest } = PACKAGE
  expect(
    atlasOnlyManifest(manifest(PACKAGE), manifest({ scripts: own, ...rest })),
  ).toBe(false)
  expect(
    atlasOnlyManifest(manifest(PACKAGE), `${JSON.stringify(PACKAGE)}\n`),
  ).toBe(true)
})
