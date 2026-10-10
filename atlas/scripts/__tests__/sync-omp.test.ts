// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  git,
  importSnapshot,
  prepareCandidate,
  stableRelease,
  UPSTREAM,
} from '../sync-omp'
const roots: string[] = []
function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}
function commit(root: string, message: string) {
  git(root, ['add', '--all'])
  git(root, ['commit', '-m', message])
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qm-sync-omp-'))
  roots.push(root)
  const upstream = join(root, 'upstream'),
    source = join(root, 'source')
  mkdirSync(upstream)
  mkdirSync(source)
  git(upstream, ['init', '-b', 'main'])
  git(source, ['init', '-b', 'main'])
  write(
    upstream,
    'packages/utils/package.json',
    JSON.stringify({ version: '1.0.0' }),
  )
  write(upstream, 'LICENSE', 'MIT fixture\n\n')
  write(
    upstream,
    'packages/example.ts',
    'const original = 1\n' +
      Array.from({ length: 30 }, (_, i) => `// stable line ${i}\n`).join(''),
  )
  write(upstream, 'packages/deleted.ts', 'obsolete upstream\n')
  commit(upstream, 'upstream initial')
  git(upstream, ['tag', 'v1.0.0'])
  const first = join(root, 'first')
  mkdirSync(first)
  const pin = importSnapshot(source, upstream, 'v1.0.0', first)
  git(source, ['read-tree', '--reset', '-u', pin.snapshot])
  write(source, 'atlas/upstream/omp.json', JSON.stringify(pin))
  write(source, 'atlas/local.ts', 'local owner\n')
  write(source, 'docs/dev/sbom-m0.json', '{}\n')
  write(source, 'docs/dev/sbom-m0.md', '# Fixture SBOM\n')
  write(
    source,
    'NOTICE',
    `v1.0.0 ${pin.commit} ${pin.tree} ${pin.snapshot} ${git(source, ['rev-parse', pin.snapshot])}\n`,
  )
  write(
    source,
    'BASE.md',
    '# 基座溯源\n\n## 现行基座：fixture\n（**当前 pin**）\n',
  )
  commit(source, 'atlas overlay')
  const oldTag = git(source, ['rev-parse', pin.snapshot])
  return { root, upstream, source, pin, oldTag, out: join(root, 'result') }
}
function next(upstream: string) {
  write(
    upstream,
    'packages/utils/package.json',
    JSON.stringify({ version: '1.1.0' }),
  )
  commit(upstream, 'next version')
  git(upstream, ['tag', 'v1.1.0'])
}
function gateRunner(root: string) {
  const bin = join(root, 'gate-bin')
  mkdirSync(bin)
  const trace = join(root, 'gate-trace.jsonl')
  // Exercise the real verify/bundle CLI while making expensive gate outcomes
  // deterministic. The database itself is covered by atlas:test:registry-ha.
  for (const name of ['bun', 'bash']) {
    const file = join(bin, name)
    writeFileSync(
      file,
      `#!${process.execPath}\n` +
        `import { appendFileSync } from 'node:fs'\n` +
        `const args = process.argv.slice(2)\n` +
        `appendFileSync(process.env.SYNC_TEST_TRACE, JSON.stringify(args) + '\\n')\n` +
        `process.exit(args.includes(process.env.SYNC_TEST_FAIL) ? 73 : 0)\n`,
    )
    chmodSync(file, 0o755)
  }
  return (mode: string, out: string, fail = '') =>
    Bun.spawnSync(
      [process.execPath, join(import.meta.dir, '../sync-omp.ts'), mode, out],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          SYNC_TEST_TRACE: trace,
          SYNC_TEST_FAIL: fail,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
describe('isolated omp candidate sync', () => {
  test('a failed real-registry gate blocks candidate verification and bundle publication', () => {
    const f = fixture()
    next(f.upstream)
    prepareCandidate(f.source, f.upstream, 'v1.1.0', f.out)
    const run = gateRunner(f.root)
    const failed = run('verify', f.out, 'atlas:test:registry-ha')
    expect(failed.exitCode).not.toBe(0)
    const checks = JSON.parse(readFileSync(join(f.out, 'checks.json'), 'utf8'))
    expect(checks.at(-1)).toEqual({
      command: ['bun', 'run', 'atlas:test:registry-ha'],
      passed: false,
    })
    expect(run('bundle', f.out).exitCode).not.toBe(0)
    expect(existsSync(join(f.out, 'candidate.bundle'))).toBe(false)
    // A later successful verification must restore the publishing path.
    expect(run('verify', f.out).exitCode).toBe(0)
    expect(run('bundle', f.out).exitCode).toBe(0)
    expect(
      git(f.source, ['bundle', 'list-heads', join(f.out, 'candidate.bundle')]),
    ).toContain(
      `${readFileSync(join(f.out, 'verified-head'), 'utf8').trim()} refs/heads/codex/sync-omp-1.1.0`,
    )
  })
  test('a failed recheck revokes a previously successful head before bundling', () => {
    const f = fixture()
    next(f.upstream)
    prepareCandidate(f.source, f.upstream, 'v1.1.0', f.out)
    const run = gateRunner(f.root)
    const verified = run('verify', f.out)
    expect(verified.stderr.toString()).toBe('')
    expect(verified.exitCode).toBe(0)
    expect(run('verify', f.out, 'atlas:typecheck').exitCode).not.toBe(0)
    expect(run('bundle', f.out).exitCode).not.toBe(0)
    expect(existsSync(join(f.out, 'candidate.bundle'))).toBe(false)
  })
  test('accepts only published stable release metadata', () => {
    expect(
      stableRelease({ tag_name: 'v18.9.0', draft: false, prerelease: false }),
    ).toEqual({ version: '18.9.0', tag: 'v18.9.0' })
    for (const release of [
      { tag_name: 'v18.9.0-canary.1', draft: false, prerelease: false },
      { tag_name: 'v18.9.0', draft: true, prerelease: false },
      { tag_name: 'v18.9.0', draft: false, prerelease: true },
    ])
      expect(() => stableRelease(release)).toThrow()
  })
  test('fresh update preserves local code, parentless snapshots, exact trees and separates provenance', () => {
    const f = fixture()
    next(f.upstream)
    const result = prepareCandidate(f.source, f.upstream, 'v1.1.0', f.out)
    const candidate = result.candidate!
    expect(result.status).toBe('prepared')
    expect(readFileSync(join(candidate, 'atlas/local.ts'), 'utf8')).toBe(
      'local owner\n',
    )
    expect(
      git(candidate, [
        'rev-list',
        '--parents',
        '-n',
        '1',
        result.snapshot!,
      ]).split(' '),
    ).toHaveLength(1)
    expect(git(candidate, ['rev-parse', `${result.snapshot}^{tree}`])).toBe(
      git(f.upstream, ['rev-parse', 'v1.1.0^{tree}']),
    )
    expect(git(candidate, ['rev-parse', f.pin.snapshot])).toBe(f.oldTag)
    expect(git(f.source, ['tag', '--list', result.snapshot!])).toBe('')
    expect(
      git(candidate, ['cat-file', '-t', result.upstreamCommit!], {
        allowFailure: true,
      }),
    ).toBe('')
    expect(git(candidate, ['status', '--porcelain'])).toBe('')
    expect(
      git(candidate, ['rev-list', '--count', `${result.baseHead}..HEAD`]),
    ).toBe('2')
    expect(readFileSync(join(candidate, 'LICENSE.base'), 'utf8')).toBe(
      'MIT fixture\n\n',
    )
    expect(
      JSON.parse(
        readFileSync(join(candidate, 'atlas/upstream/omp.json'), 'utf8'),
      ).repository,
    ).toBe(UPSTREAM)
    expect(readFileSync(join(candidate, 'NOTICE'), 'utf8')).toContain(
      result.snapshot!,
    )
    expect(readFileSync(join(candidate, 'BASE.md'), 'utf8')).toContain(
      'omp-current:start',
    )
  })
  test('an existing matching candidate snapshot is reused without moving its tag', () => {
    const f = fixture()
    next(f.upstream)
    const scratch = join(f.root, 'already-published')
    mkdirSync(scratch)
    const nextPin = importSnapshot(f.source, f.upstream, 'v1.1.0', scratch)
    const ref = git(f.source, ['rev-parse', nextPin.snapshot])
    const result = prepareCandidate(f.source, f.upstream, 'v1.1.0', f.out)
    expect(git(result.candidate!, ['rev-parse', nextPin.snapshot])).toBe(ref)
  })
  test('different contents under an existing snapshot tag are refused', () => {
    const f = fixture()
    next(f.upstream)
    git(f.source, ['tag', 'base-snapshot/omp-v1.1.0', f.pin.snapshot])
    expect(() =>
      prepareCandidate(f.source, f.upstream, 'v1.1.0', f.out),
    ).toThrow('different provenance')
  })
  test('disjoint edits in the same base file preserve the local edit', () => {
    const f = fixture()
    const content = readFileSync(
      join(f.upstream, 'packages/example.ts'),
      'utf8',
    )
    write(f.source, 'packages/example.ts', content.replace('= 1', '= "local"'))
    commit(f.source, 'local change')
    write(f.upstream, 'packages/example.ts', content + '// upstream addition\n')
    next(f.upstream)
    const result = prepareCandidate(f.source, f.upstream, 'v1.1.0', f.out)
    const merged = readFileSync(
      join(result.candidate!, 'packages/example.ts'),
      'utf8',
    )
    expect(merged).toContain('= "local"')
    expect(merged).toContain('// upstream addition')
  })
  test('dirty source checkouts are refused before creating a candidate', () => {
    const f = fixture()
    next(f.upstream)
    write(f.source, 'atlas/local.ts', 'uncommitted work\n')
    expect(() =>
      prepareCandidate(f.source, f.upstream, 'v1.1.0', f.out),
    ).toThrow('dirty')
    expect(existsSync(join(f.out, 'candidate'))).toBe(false)
  })
  test('same or older versions are an explicit no-op', () => {
    const f = fixture()
    expect(prepareCandidate(f.source, f.upstream, 'v1.0.0', f.out).status).toBe(
      'unchanged',
    )
    expect(existsSync(join(f.out, 'candidate'))).toBe(false)
  })
  test('upstream modifications and deletions apply while disjoint local edits survive', () => {
    const f = fixture()
    write(f.source, 'packages/local-only.ts', 'local addition\n')
    commit(f.source, 'local only')
    write(f.upstream, 'packages/example.ts', 'const original = 2\n')
    git(f.upstream, ['rm', 'packages/deleted.ts'])
    next(f.upstream)
    const result = prepareCandidate(f.source, f.upstream, 'v1.1.0', f.out)
    expect(
      readFileSync(join(result.candidate!, 'packages/example.ts'), 'utf8'),
    ).toContain('= 2')
    expect(existsSync(join(result.candidate!, 'packages/deleted.ts'))).toBe(
      false,
    )
    expect(
      readFileSync(join(result.candidate!, 'packages/local-only.ts'), 'utf8'),
    ).toBe('local addition\n')
  })
  test('conflicting local modifications fail and retain evidence; source and old tag stay intact', () => {
    const f = fixture()
    write(f.source, 'packages/example.ts', 'const original = "local"\n')
    commit(f.source, 'local conflict')
    write(f.upstream, 'packages/example.ts', 'const original = "upstream"\n')
    next(f.upstream)
    expect(() =>
      prepareCandidate(f.source, f.upstream, 'v1.1.0', f.out),
    ).toThrow('conflicts')
    expect(
      readFileSync(join(f.source, 'packages/example.ts'), 'utf8'),
    ).toContain('"local"')
    expect(git(f.source, ['rev-parse', f.pin.snapshot])).toBe(f.oldTag)
    expect(readFileSync(join(f.out, 'conflicts.txt'), 'utf8')).toContain(
      'UU packages/example.ts',
    )
  })
  test.each([
    'atlas/local.ts',
    'packages/local-only.ts',
  ])('upstream cannot take ownership of local path %s', path => {
    const f = fixture()
    if (path.startsWith('packages')) {
      write(f.source, path, 'ours\n')
      commit(f.source, 'local path')
    }
    write(f.upstream, path, 'upstream collision\n')
    next(f.upstream)
    expect(() =>
      prepareCandidate(f.source, f.upstream, 'v1.1.0', f.out),
    ).toThrow(/overlaps|collides/)
  })
})
