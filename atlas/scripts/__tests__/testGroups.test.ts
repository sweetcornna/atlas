// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * test-groups.sh against stand-ins: a copy of the real script in a scratch
 * tree whose test-shards.sh, check-test-files-ran.ts, heavy-tests.ts and
 * package.json checks only record what they were asked and do what the test
 * tells them. The real suite never runs here.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..', '..')
const SCRIPT = join(ROOT, 'atlas', 'scripts', 'test-groups.sh')

const FAKE_SHARDS = `#!/usr/bin/env bash
trace="$FAKE_TRACE"
case "$1" in
  --list-groups) printf '%s\\n' alpha beta gamma; exit 0 ;;
  --group) ;;
  *) echo "args $*" >>"$trace"; exit 0 ;;
esac
g="$2"
dir="$4"
mkdir -p "$dir"
echo "start $g heavy=\${ATLAS_TEST_HEAVY-unset}" >>"$trace"
# Proves overlap without timing: wait until FAKE_BARRIER groups have started.
n=0
while [ "$(grep -c '^start ' "$trace")" -lt "\${FAKE_BARRIER:-0}" ]; do
  n=$((n + 1))
  [ "$n" -lt 200 ] || { echo "barrier timed out"; exit 3; }
  sleep 0.05
done
if [ -n "\${FAKE_HANG:-}" ]; then
  sleep 30 &
  echo "pid $$ $!" >>"$trace"
  wait
fi
echo "<testsuite file=\\"$g.test.ts\\"/>" >"$dir/shard-01-$g.xml"
echo "end $g" >>"$trace"
case " \${FAKE_FAIL:-} " in
  *" $g "*) echo "::error title=Test shard failed::$g"; echo "detail of $g"; exit 1 ;;
esac
echo "──── all 1 shards passed"
`

const FAKE_CHECK = `import { appendFileSync } from 'node:fs'
appendFileSync(process.env.FAKE_TRACE ?? '', \`check \${process.argv.slice(2).join(' ')}\\n\`)
console.log('fake check')
process.exit(Number(process.env.FAKE_CHECK_EXIT ?? '0'))
`

const FAKE_HEAVY = `import { appendFileSync } from 'node:fs'
appendFileSync(process.env.FAKE_TRACE ?? '', \`heavy \${process.argv.slice(2).join(' ')}\\n\`)
console.error('heavy test sets: route-docs: fake')
console.log('route-docs')
`

const FAKE_STATIC = `#!/usr/bin/env bash
echo "static $1" >>"$FAKE_TRACE"
case " \${FAKE_FAIL:-} " in
  *" $1 "*) echo "::error title=Fake check failed::$1"; exit 1 ;;
esac
`

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

interface Tree {
  repo: string
  trace: string
  lock: string
  env: Record<string, string | undefined>
}

function tree(): Tree {
  const base = mkdtempSync(join(tmpdir(), 'qm-test-groups-'))
  temps.push(base)
  const repo = join(base, 'repo')
  const files: Record<string, string> = {
    'atlas/scripts/test-shards.sh': FAKE_SHARDS,
    'atlas/scripts/check-test-files-ran.ts': FAKE_CHECK,
    'atlas/scripts/ci/heavy-tests.ts': FAKE_HEAVY,
    'atlas/scripts/fake-static.sh': FAKE_STATIC,
    'package.json': JSON.stringify({
      scripts: {
        'atlas:typecheck': 'bash atlas/scripts/fake-static.sh typecheck',
        'atlas:check:identity-paths':
          'bash atlas/scripts/fake-static.sh identity-paths',
        'atlas:check:license-headers':
          'bash atlas/scripts/fake-static.sh license-headers',
      },
    }),
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  copyFileSync(SCRIPT, join(repo, 'atlas/scripts/test-groups.sh'))
  const tmp = join(base, 'tmp')
  mkdirSync(tmp)
  const trace = join(base, 'trace')
  writeFileSync(trace, '')
  const env: Record<string, string | undefined> = {
    ...process.env,
    TMPDIR: tmp,
    FAKE_TRACE: trace,
  }
  delete env.ATLAS_TEST_HEAVY
  delete env.ATLAS_TEST_JOBS
  return { repo, trace, lock: join(tmp, 'atlas-test-groups.lock.d'), env }
}

function groups(
  t: Tree,
  env: Record<string, string> = {},
  args: string[] = [],
): { code: number; out: string; trace: string[] } {
  const run = Bun.spawnSync(
    ['bash', join(t.repo, 'atlas/scripts/test-groups.sh'), ...args],
    { cwd: t.repo, env: { ...t.env, ...env }, stdout: 'pipe', stderr: 'pipe' },
  )
  return {
    code: run.exitCode,
    out: run.stdout.toString() + run.stderr.toString(),
    trace: readFileSync(t.trace, 'utf8').split('\n').filter(Boolean),
  }
}

/** The most groups between their start and end lines at once. */
function overlap(trace: readonly string[]): number {
  let running = 0
  let most = 0
  for (const line of trace) {
    if (line.startsWith('start ')) most = Math.max(most, ++running)
    if (line.startsWith('end ')) running -= 1
  }
  return most
}

describe('test-groups.sh', () => {
  test('runs every group at once, each with its own log and reports, then the check', () => {
    const t = tree()
    mkdirSync(join(t.repo, 'test-reports', 'old'), { recursive: true })
    writeFileSync(join(t.repo, 'test-reports', 'old', 'shard-01.xml'), '')

    const run = groups(t, { FAKE_BARRIER: '3' })

    expect(run.out).not.toContain('barrier timed out')
    expect(run.code).toBe(0)
    expect(overlap(run.trace)).toBe(3)
    for (const g of ['alpha', 'beta', 'gamma']) {
      expect(
        existsSync(join(t.repo, 'test-reports', g, `shard-01-${g}.xml`)),
      ).toBe(true)
      const log = readFileSync(join(t.repo, 'test-reports', `${g}.log`), 'utf8')
      expect(log).toContain('──── all 1 shards passed')
      expect(log).toMatch(new RegExp(`──── task ${g}: exit 0 after \\d+ s`))
      expect(run.out).toMatch(new RegExp(`──── ${g}: passed \\(\\d+ s\\)`))
    }
    // Cleared once by the parent: the stale report is gone.
    expect(existsSync(join(t.repo, 'test-reports', 'old'))).toBe(false)
    expect(run.trace.at(-1)).toBe('check --include-untracked test-reports')
    expect(run.out).toContain('──── all 3 tasks passed')
    // Unset: the local diff picks the heavy sets, and every group sees them.
    expect(run.trace[0]).toBe('heavy --local')
    expect(run.trace.filter(line => line.startsWith('start '))).toEqual(
      expect.arrayContaining([
        'start alpha heavy=route-docs',
        'start beta heavy=route-docs',
        'start gamma heavy=route-docs',
      ]),
    )
    expect(existsSync(t.lock)).toBe(false)
  })

  test('ATLAS_TEST_JOBS=1 runs them one after another, in --list-groups order', () => {
    const t = tree()
    const run = groups(t, { ATLAS_TEST_JOBS: '1', ATLAS_TEST_HEAVY: 'none' })

    expect(run.code).toBe(0)
    expect(run.trace).toEqual([
      'start alpha heavy=none',
      'end alpha',
      'start beta heavy=none',
      'end beta',
      'start gamma heavy=none',
      'end gamma',
      'check --include-untracked test-reports',
    ])
    expect(run.out).toContain(
      'heavy test sets: none (ATLAS_TEST_HEAVY from the environment)',
    )
  })

  test('ATLAS_TEST_JOBS caps how many run at once', () => {
    const t = tree()
    const run = groups(t, { ATLAS_TEST_JOBS: '2', FAKE_BARRIER: '2' })

    expect(run.code).toBe(0)
    expect(overlap(run.trace)).toBe(2)
    expect(run.trace.filter(line => line.startsWith('end '))).toHaveLength(3)

    expect(groups(tree(), { ATLAS_TEST_JOBS: 'two' }).code).toBe(2)
  })

  test('a red group does not stop the others; its errors and log tail are shown', () => {
    const t = tree()
    const run = groups(t, { FAKE_FAIL: 'beta' })

    expect(run.code).toBe(1)
    expect(run.trace.filter(line => line.startsWith('end ')).sort()).toEqual([
      'end alpha',
      'end beta',
      'end gamma',
    ])
    expect(run.trace.at(-1)).toBe('check --include-untracked test-reports')
    expect(run.out).toMatch(/──── beta: FAILED with exit 1 \(\d+ s\)/)
    expect(run.out).toContain('::error title=Test shard failed::beta')
    expect(run.out).toContain('──── last 40 lines of beta:')
    expect(run.out).toContain('detail of beta')
    expect(run.out).toContain('──── 1 failed after')
    expect(run.out).not.toContain('detail of alpha')
  })

  test('a red check fails the run', () => {
    const run = groups(tree(), { FAKE_CHECK_EXIT: '1' })

    expect(run.code).toBe(1)
    expect(run.out).toContain('failed after')
    expect(run.out).toContain('check-test-files-ran')
  })

  test('--precheck adds the static checks, first when serial', () => {
    const t = tree()
    const run = groups(t, { ATLAS_TEST_JOBS: '1' }, ['--precheck'])

    expect(run.code).toBe(0)
    expect(run.trace.slice(1, 4)).toEqual([
      'static typecheck',
      'static identity-paths',
      'static license-headers',
    ])
    expect(run.out).toContain('──── typecheck: passed')

    const red = groups(tree(), { FAKE_FAIL: 'identity-paths' }, ['--precheck'])
    expect(red.code).toBe(1)
    expect(red.out).toContain('::error title=Fake check failed::identity-paths')
  })

  test('other arguments go to test-shards.sh as before: no lock, no check', () => {
    const t = tree()
    mkdirSync(t.lock)
    writeFileSync(join(t.lock, 'owner'), `${process.pid} /elsewhere\n`)
    const run = groups(t, {}, ['atlas/packages/x', '--exclude', 'y'])

    expect(run.code).toBe(0)
    expect(run.trace).toEqual(['args atlas/packages/x --exclude y'])
  })

  test('a second run waits for the first one, then runs', async () => {
    const t = tree()
    mkdirSync(t.lock)
    writeFileSync(join(t.lock, 'owner'), `${process.pid} /elsewhere\n`)
    const child = Bun.spawn(
      ['bash', join(t.repo, 'atlas/scripts/test-groups.sh')],
      { cwd: t.repo, env: t.env, stdout: 'pipe', stderr: 'pipe' },
    )
    const reader = child.stdout.getReader()
    let out = ''
    while (!out.includes('──── waiting for another test run')) {
      const chunk = await reader.read()
      if (chunk.done) break
      out += new TextDecoder().decode(chunk.value)
    }
    expect(out).toContain(`(pid ${process.pid}, /elsewhere)`)
    expect(readFileSync(t.trace, 'utf8')).toBe('')

    rmSync(t.lock, { recursive: true })
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      out += new TextDecoder().decode(chunk.value)
    }
    expect(await child.exited).toBe(0)
    expect(out).toContain('──── all 3 tasks passed')
    expect(existsSync(t.lock)).toBe(false)
  })

  test('a lock whose owner is gone is taken over', () => {
    const t = tree()
    const gone = Bun.spawnSync(['true'])
    mkdirSync(t.lock)
    writeFileSync(join(t.lock, 'owner'), `${gone.pid} /elsewhere\n`)
    const run = groups(t)

    expect(run.code).toBe(0)
    expect(run.out).toContain(
      `──── taking over the test lock of pid ${gone.pid}, which is gone`,
    )
    expect(existsSync(t.lock)).toBe(false)
  })

  test('stopping it stops every group and frees the lock', async () => {
    const t = tree()
    const child = Bun.spawn(
      ['bash', join(t.repo, 'atlas/scripts/test-groups.sh')],
      {
        cwd: t.repo,
        env: { ...t.env, FAKE_HANG: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const pids = (): number[] =>
      readFileSync(t.trace, 'utf8')
        .split('\n')
        .filter(line => line.startsWith('pid '))
        .flatMap(line => line.split(' ').slice(1).map(Number))
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const until = async (done: () => boolean): Promise<boolean> => {
      for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(25)
      return done()
    }

    expect(await until(() => pids().length === 6)).toBe(true)
    expect(existsSync(t.lock)).toBe(true)
    child.kill('SIGTERM')
    expect(await child.exited).toBe(143)
    // Each group's shell and the process it was waiting on.
    expect(await until(() => pids().every(pid => !alive(pid)))).toBe(true)
    expect(existsSync(t.lock)).toBe(false)
  })
})
