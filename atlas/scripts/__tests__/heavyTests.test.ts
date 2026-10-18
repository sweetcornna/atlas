// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  HEAVY_EVERYTHING,
  HEAVY_SETS,
  HEAVY_TRIGGERS,
  heavySets,
} from '../../tests/support/heavy'
import { heavyIn } from '../../packages/console/test/heavy'
import { junitFiles } from '../check-test-files-ran'
import {
  changedPaths,
  chooseHeavy,
  heavyFor,
  localChangedPaths,
} from '../ci/heavy-tests'
import { git } from '../sync-omp'

const ROOT = join(import.meta.dir, '..', '..', '..')
const SCRIPT = join(ROOT, 'atlas', 'scripts', 'ci', 'heavy-tests.ts')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function write(root: string, path: string, contents = `${path}\n`): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), contents)
}

function commit(root: string, message = 'fixture'): string {
  git(root, ['add', '--all'])
  git(root, ['commit', '-m', message])
  return git(root, ['rev-parse', 'HEAD'])
}

describe('ATLAS_TEST_HEAVY', () => {
  test('unset or empty runs every set; all, none and lists mean what they say', () => {
    const every = [...HEAVY_SETS].sort()
    expect([...heavySets(undefined)].sort()).toEqual(every)
    expect([...heavySets('')].sort()).toEqual(every)
    expect([...heavySets(' , ')].sort()).toEqual(every)
    expect([...heavySets('all')].sort()).toEqual(every)
    expect([...heavySets('none')]).toEqual([])
    expect([...heavySets('route-docs')]).toEqual(['route-docs'])
    expect([...heavySets(' recall-eval , route-docs ')].sort()).toEqual([
      'recall-eval',
      'route-docs',
    ])
  })

  // A typo must not read as "skip": the test file that asks fails to load.
  test('an unknown set name throws', () => {
    expect(() => heavySets('route-doc')).toThrow(
      'ATLAS_TEST_HEAVY: unknown set "route-doc"',
    )
    expect(() => heavySets('none,recall')).toThrow('unknown set "recall"')
  })

  // The console's tests may not load the shared helper (its
  // dependencies.test.ts), so they carry a copy of the reading.
  test("the console package's copy reads it the same way", () => {
    for (const value of [
      undefined,
      '',
      ' , ',
      'all',
      'none',
      'route-docs',
      'recall-eval',
      ' recall-eval , route-docs ',
      'none,route-docs',
    ])
      expect({ value, on: heavyIn(value, 'route-docs') }).toEqual({
        value,
        on: heavySets(value).has('route-docs'),
      })
  })

  test('the preload refuses an unknown set before any test runs', () => {
    const dir = temp('qm-heavy-preload-')
    writeFileSync(
      join(dir, 'never.test.ts'),
      "import { test } from 'bun:test'\ntest('never', () => {})\n",
    )
    const run = Bun.spawnSync(
      [
        process.execPath,
        'test',
        '--preload',
        join(ROOT, 'atlas', 'tests', 'preload.ts'),
        './never.test.ts',
      ],
      {
        cwd: dir,
        env: { ...process.env, ATLAS_TEST_HEAVY: 'route-doc' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(run.stderr.toString()).toContain(
      'ATLAS_TEST_HEAVY: unknown set "route-doc"',
    )
    expect(run.exitCode).not.toBe(0)
  })

  // The run CI and test-groups.sh rely on: the variable gets past the preload
  // (which deletes QIANMO_*), and a skipped heavy test is still a test case in
  // the JUnit report, so check-test-files-ran.ts still counts its file.
  test('through the preload, skipped heavy tests still reach the JUnit report', () => {
    const dir = temp('qm-heavy-junit-')
    const heavyModule = JSON.stringify(
      join(ROOT, 'atlas', 'tests', 'support', 'heavy.ts'),
    )
    writeFileSync(
      join(dir, 'gate.test.ts'),
      [
        "import { describe, expect, test } from 'bun:test'",
        `import { heavy } from ${heavyModule}`,
        "test('light', () => expect(process.env.ATLAS_TEST_HEAVY).toBe('recall-eval'))",
        "describe.skipIf(!heavy('route-docs'))('route docs', () => {",
        "  test('reverse', () => { throw new Error('a skipped set ran') })",
        '})',
        "test.skipIf(!heavy('recall-eval'))('recall', () => {})",
        '',
      ].join('\n'),
    )
    const report = join(dir, 'report.xml')
    const run = Bun.spawnSync(
      [
        process.execPath,
        'test',
        '--preload',
        join(ROOT, 'atlas', 'tests', 'preload.ts'),
        '--reporter=junit',
        '--reporter-outfile',
        report,
        './gate.test.ts',
      ],
      {
        cwd: dir,
        env: { ...process.env, ATLAS_TEST_HEAVY: 'recall-eval' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(run.stderr.toString()).toContain('2 pass')
    expect(run.exitCode).toBe(0)
    const xml = readFileSync(report, 'utf8')
    expect(junitFiles(xml)).toEqual(['gate.test.ts'])
    expect(xml).toMatch(/<testcase name="reverse"[^>]*>\s*<skipped \/>/)
    expect(xml).toMatch(/<testcase name="recall"[^>]*\/>/)
  })
})

describe('heavy-tests.ts: paths to sets', () => {
  const value = (...paths: string[]) => heavyFor(paths).value

  test('each set turns on for its own paths only', () => {
    expect(value()).toBe('none')
    expect(value('README.md', 'atlas/packages/node/src/host/other.ts')).toBe(
      'none',
    )

    expect(value('atlas/packages/console/src/routes/index.ts')).toBe(
      'route-docs',
    )
    expect(value('docs/dev/console.md')).toBe('route-docs')
    // Whole segments: a sibling with the same prefix is not the package.
    expect(value('atlas/packages/consolex/a.ts')).toBe('none')
    expect(value('docs/dev/console-notes.md')).toBe('none')

    for (const path of [
      'atlas/packages/recall/eval/heldout.ts',
      'atlas/packages/memory/src/index.ts',
      'atlas/packages/paths/src/index.ts',
      'atlas/packages/node/src/host/memoryEmbedding.ts',
      'atlas/scripts/qianmo-recall-answer-eval.ts',
      'atlas/scripts/__tests__/qianmo-recall-freeze.test.ts',
    ])
      expect({ path, value: value(path) }).toEqual({
        path,
        value: 'recall-eval',
      })

    expect(
      value('docs/dev/console.md', 'atlas/packages/memory/src/index.ts'),
    ).toBe('route-docs,recall-eval')
  })

  test('test infrastructure and the trigger table turn everything on', () => {
    for (const path of [
      'bun.lock',
      'package.json',
      '.tool-versions',
      'atlas/tests/preload.ts',
      'atlas/tests/support/heavy.ts',
      'atlas/scripts/test-shards.sh',
      'atlas/scripts/test-groups.sh',
      'atlas/scripts/ci/heavy-tests.ts',
      '.github/workflows/atlas.yml',
    ])
      expect({ path, value: value(path, 'README.md') }).toEqual({
        path,
        value: 'all',
      })
    // The root manifest only, not a package's.
    expect(value('packages/utils/package.json')).toBe('none')
  })

  test('the output names the paths that decided it', () => {
    expect(heavyFor(['docs/dev/console.md']).reasons).toEqual([
      'route-docs: docs/dev/console.md',
      'recall-eval: no trigger path',
    ])
    const many = heavyFor([
      'atlas/tests/support/a.ts',
      'atlas/tests/support/b.ts',
      'atlas/tests/support/c.ts',
      'atlas/tests/support/d.ts',
      'atlas/tests/support/e.ts',
    ])
    expect(many.reasons).toEqual([
      'all: atlas/tests/support/a.ts, atlas/tests/support/b.ts, atlas/tests/support/c.ts, +2 more',
    ])
  })

  // A renamed directory would leave a trigger that never fires; a set no test
  // asks for is dead weight.
  test('every trigger matches a path in this checkout, and every set gates a test', () => {
    const paths = git(ROOT, [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
    ]).split('\n')
    for (const pattern of [
      ...Object.values(HEAVY_TRIGGERS).flat(),
      ...HEAVY_EVERYTHING,
    ]) {
      const glob = new Bun.Glob(pattern)
      expect({
        pattern,
        matches: paths.some(path => glob.match(path)),
      }).toEqual({ pattern, matches: true })
    }
    for (const set of HEAVY_SETS) {
      const users = git(
        ROOT,
        ['grep', '-l', '-F', `heavy('${set}')`, '--', '*.test.ts'],
        { allowFailure: true },
      )
      expect({ set, gated: users.length > 0 }).toEqual({ set, gated: true })
    }
  })
})

describe('heavy-tests.ts: what changed', () => {
  function fixture(): { root: string; base: string } {
    const root = temp('qm-heavy-git-')
    git(root, ['init', '-b', 'main'])
    write(root, 'README.md')
    write(root, '.gitignore', 'ignored/\n')
    write(root, 'atlas/packages/recall/src/rank.ts')
    write(root, 'docs/dev/other.md')
    return { root, base: commit(root, 'base') }
  }

  test('<base>...HEAD: commits since the merge base, renames as both sides', () => {
    const { root, base } = fixture()
    mkdirSync(join(root, 'lib'))
    git(root, ['mv', 'atlas/packages/recall/src/rank.ts', 'lib/rank.ts'])
    write(root, 'atlas/packages/console/src/a.ts')
    commit(root, 'change')

    expect(changedPaths(root, base)).toEqual([
      'atlas/packages/console/src/a.ts',
      'atlas/packages/recall/src/rank.ts',
      'lib/rank.ts',
    ])
    // Moving a file out of a trigger directory still triggers it.
    expect(chooseHeavy(root, { event: 'pull_request', base }).value).toBe(
      'route-docs,recall-eval',
    )
  })

  test('--local: the branch since origin/main plus staged, unstaged and untracked paths', () => {
    const { root, base } = fixture()
    // origin/main moved on after the branch left it: not this branch's change.
    git(root, ['switch', '-c', 'upstream'])
    write(root, 'atlas/packages/paths/src/index.ts')
    git(root, ['update-ref', 'refs/remotes/origin/main', commit(root)])
    git(root, ['switch', 'main'])
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(base)

    write(root, 'atlas/packages/console/src/a.ts')
    commit(root, 'committed')
    write(root, 'docs/dev/other.md', 'edited\n')
    write(root, 'notes/staged.md')
    git(root, ['add', 'notes/staged.md'])
    write(root, 'atlas/packages/memory/src/new.ts')
    write(root, 'ignored/x.ts')

    expect(localChangedPaths(root)).toEqual([
      'atlas/packages/console/src/a.ts',
      'atlas/packages/memory/src/new.ts',
      'docs/dev/other.md',
      'notes/staged.md',
    ])
    expect(chooseHeavy(root, { local: true }).value).toBe(
      'route-docs,recall-eval',
    )
  })

  test('only pull requests are cut down; everything else runs all', () => {
    const { root, base } = fixture()
    for (const event of ['push', 'schedule', 'workflow_dispatch'])
      expect(chooseHeavy(root, { event, base: '' })).toEqual({
        value: 'all',
        reasons: [`all: ${event} runs everything`],
        fallback: false,
      })
    expect(chooseHeavy(root, { event: 'pull_request', base }).value).toBe(
      'none',
    )
  })

  test('when git cannot answer, the answer is all', () => {
    const { root } = fixture()
    const noBase = chooseHeavy(root, { event: 'pull_request', base: '' })
    expect(noBase.value).toBe('all')
    expect(noBase.fallback).toBe(true)

    const unknown = chooseHeavy(root, { base: 'f'.repeat(40) })
    expect(unknown.value).toBe('all')
    expect(unknown.fallback).toBe(true)
    expect(unknown.reasons[0]).toStartWith('all: git diff failed')

    // No origin/main in this repository.
    const local = chooseHeavy(root, { local: true })
    expect(local.value).toBe('all')
    expect(local.fallback).toBe(true)
  })

  test('the command line prints the value and appends it to GITHUB_ENV', () => {
    const env = join(temp('qm-heavy-env-'), 'env')
    writeFileSync(env, 'EARLIER=1\n')
    const run = Bun.spawnSync(
      [process.execPath, SCRIPT, '--event', 'schedule', ''],
      { cwd: ROOT, env: { ...process.env, GITHUB_ENV: env } },
    )
    expect(run.exitCode).toBe(0)
    expect(run.stdout.toString()).toBe('all\n')
    expect(run.stderr.toString()).toContain(
      'heavy test sets: all: schedule runs everything',
    )
    expect(readFileSync(env, 'utf8')).toBe('EARLIER=1\nATLAS_TEST_HEAVY=all\n')

    for (const args of [[], ['--event', 'push'], ['--bogus'], ['a', 'b']]) {
      const bad = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
        cwd: ROOT,
      })
      expect({ args, code: bad.exitCode }).toEqual({ args, code: 2 })
    }
  })
})

describe('the workflow', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(join(ROOT, '.github', 'workflows', 'atlas.yml'), 'utf8'),
  ) as {
    on: { schedule?: { cron: string }[] }
    jobs: {
      test: { needs: string; steps: { name?: string; run?: string }[] }
    }
  }

  // Waiting for static would add its ~2.5 min to the critical path.
  test('each test job picks its heavy sets itself, before the tests run', () => {
    const steps = workflow.jobs.test.steps
    const pick = steps.findIndex(step =>
      step.run?.includes('atlas/scripts/ci/heavy-tests.ts --event'),
    )
    const tests = steps.findIndex(step =>
      step.run?.includes('test-shards.sh --group'),
    )
    expect(pick).toBeGreaterThan(-1)
    expect(tests).toBeGreaterThan(pick)
    expect(workflow.jobs.test.needs).toBe('native')
  })

  test('a nightly run covers everything path triggers left out', () => {
    expect(workflow.on.schedule).toEqual([{ cron: '43 19 * * *' }])
  })
})
