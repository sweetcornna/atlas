// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..')
const RETAIN = join(REPOSITORY_ROOT, 'demo/env/beta/beta-retain.sh')
const NOW = Date.UTC(2026, 7, 23, 12, 0, 0)
const HOUR = 60 * 60 * 1_000
const DAY = 24 * HOUR
const roots: string[] = []

interface Result {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'qianmo-beta-retain-'))
  roots.push(value)
  mkdirSync(join(value, 'run'), { recursive: true })
  mkdirSync(join(value, 'logs'), { recursive: true })
  mkdirSync(join(value, 'state', 'snapshots'), { recursive: true })
  mkdirSync(join(value, 'backups'), { recursive: true })
  mkdirSync(join(value, 'nodes'), { recursive: true })
  writeFileSync(join(value, '.qianmo-beta-env'), 'qianmo-beta-env/v1\n')
  return value
}

function run(value: string, args: readonly string[] = [], now = NOW): Result {
  const child = Bun.spawnSync(['bash', RETAIN, ...args], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      QIANMO_BETA_ROOT: value,
      QIANMO_BETA_RETAIN_NOW_EPOCH_MS: String(now),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  }
}

async function runTogether(
  value: string,
  args: readonly string[] = [],
  now = NOW,
): Promise<readonly Result[]> {
  const children = [0, 1].map(() =>
    Bun.spawn(['bash', RETAIN, ...args], {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        QIANMO_BETA_ROOT: value,
        QIANMO_BETA_RETAIN_NOW_EPOCH_MS: String(now),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  )
  return Promise.all(
    children.map(async child => {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { exitCode, stdout, stderr }
    }),
  )
}

function snapshot(
  value: string,
  id: string,
  createdAt: number,
  options: { archive?: boolean; meta?: boolean } = {},
): void {
  const store = join(value, 'backups')
  if (options.archive !== false) writeFileSync(join(store, `${id}.tar.gz`), id)
  if (options.meta !== false) {
    writeFileSync(
      join(store, `${id}.json`),
      `${JSON.stringify({
        version: 1,
        id,
        workspace: '/workspace',
        reason: 'scheduled',
        createdAt,
        bytes: id.length,
        sha256: 'a'.repeat(64),
      })}\n`,
    )
  }
}

function log(value: string, name: string, ageMs: number): string {
  const path = join(value, 'logs', name)
  writeFileSync(path, name)
  const at = new Date(NOW - ageMs)
  utimesSync(path, at, at)
  return path
}

function audit(value: string, node: string, contents: string): string {
  const path = join(value, 'nodes', node, 'config/qianmo/audit/trail.ndjson')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  return path
}

function ledger(
  value: string,
  node: string,
  agent: string,
  bytes: number,
): string {
  const path = join(
    value,
    'nodes',
    node,
    'config/resident',
    agent,
    'admission.ndjson',
  )
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.alloc(bytes, 97))
  return path
}

function treeState(value: string, relative = '.'): readonly string[] {
  const path = relative === '.' ? value : join(value, relative)
  const stat = lstatSync(path)
  const state = [`${relative}:${stat.mode}:${stat.size}:${stat.mtimeMs}`]
  if (!stat.isDirectory() || stat.isSymbolicLink()) return state
  for (const name of readdirSync(path).sort()) {
    state.push(
      ...treeState(value, relative === '.' ? name : join(relative, name)),
    )
  }
  return state
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true })
  }
})

describe('beta-retain host retention tool', () => {
  test('keeps every snapshot inside 72 hours and one deterministic UTC representative per older day', () => {
    const value = root()
    snapshot(value, '01770000000000-0001', NOW - HOUR)
    snapshot(value, '01770000000005-0001', NOW - 72 * HOUR)
    snapshot(value, '01770000000001-0001', NOW - 72 * HOUR - 1)
    snapshot(value, '01770000000002-0001', NOW - 5 * DAY)
    snapshot(value, '01770000000003-0001', NOW - 5 * DAY)
    snapshot(value, '01770000000004-0001', NOW - 15 * DAY)

    const before = treeState(value)
    const dry = run(value)
    expect(dry.exitCode).toBe(0)
    expect(dry.stdout).toContain('备份')
    expect(treeState(value)).toEqual(before)
    expect(readdirSync(join(value, 'backups')).sort()).toHaveLength(12)

    const applied = run(value, ['--apply'])
    expect(applied.exitCode).toBe(0)
    expect(readdirSync(join(value, 'backups')).sort()).toEqual([
      '01770000000000-0001.json',
      '01770000000000-0001.tar.gz',
      '01770000000001-0001.json',
      '01770000000001-0001.tar.gz',
      '01770000000003-0001.json',
      '01770000000003-0001.tar.gz',
      '01770000000005-0001.json',
      '01770000000005-0001.tar.gz',
    ])
    expect(run(value, ['--apply']).exitCode).toBe(0)
  })

  test('never lets the 72 hour policy remove its UTC daily representative at a boundary', () => {
    const value = root()
    // 2026-08-17 00:00:00 UTC is outside 72 hours but inside the 14-day window.
    snapshot(value, '01770000000010-0001', Date.UTC(2026, 7, 17, 0, 0, 0))
    snapshot(value, '01770000000011-0001', Date.UTC(2026, 7, 17, 1, 0, 0))

    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(readdirSync(join(value, 'backups')).sort()).toEqual([
      '01770000000011-0001.json',
      '01770000000011-0001.tar.gz',
    ])
  })

  test('compresses completed logs once, preserves current logs, and only removes expired gzip logs', () => {
    const value = root()
    const current = log(value, 'registry.out', 20 * DAY)
    writeFileSync(join(value, 'run', 'registry.pid'), String(process.pid))
    const fresh = log(value, 'console.err', DAY)
    const old = log(value, 'retired.out', 15 * DAY)
    const gzip = log(value, 'already.err.gz', 15 * DAY)

    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(readFileSync(current, 'utf8')).toBe('registry.out')
    expect(readdirSync(join(value, 'logs')).sort()).toEqual([
      'console.err.2026-08-22.gz',
      'registry.out',
    ])
    expect(() => lstatSync(old)).toThrow()
    expect(() => lstatSync(gzip)).toThrow()
    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(readdirSync(join(value, 'logs')).sort()).toEqual([
      'console.err.2026-08-22.gz',
      'registry.out',
    ])
  })

  test('concurrent applies publish equivalent logs, audit seals, and registry snapshots once', async () => {
    const value = root()
    const source = audit(value, 'beta-1', '{"seq":1}\n')
    const registry = join(value, 'state', 'registry-agents.json')
    writeFileSync(registry, '{"version":1}\n')
    log(value, 'console.err', DAY)

    const results = await runTogether(value, ['--apply', '--snapshot-registry'])

    expect(results.map(result => result.exitCode)).toEqual([0, 0])
    expect(readFileSync(source, 'utf8')).toBe('{"seq":1}\n')
    expect(readdirSync(join(dirname(source), 'archive'))).toEqual([
      'trail-2026-W34.ndjson',
    ])
    expect(readdirSync(join(value, 'logs'))).toEqual([
      'console.err.2026-08-22.gz',
    ])
    expect(readdirSync(join(value, 'state', 'snapshots'))).toEqual([
      'registry-20260823T120000Z.json',
    ])
    expect(treeState(value).some(state => state.includes('.tmp-'))).toBe(false)
  })

  test('treats an equivalent gzip publication as idempotent and leaves a divergent one untouched', () => {
    const equivalent = root()
    const source = log(equivalent, 'console.err', DAY)
    const destination = `${source}.2026-08-22.gz`

    expect(run(equivalent, ['--apply']).exitCode).toBe(0)
    log(equivalent, 'console.err', DAY)
    expect(run(equivalent, ['--apply']).exitCode).toBe(0)
    expect(existsSync(source)).toBe(false)
    expect(readdirSync(join(equivalent, 'logs'))).toEqual([
      'console.err.2026-08-22.gz',
    ])
    expect(treeState(equivalent).some(state => state.includes('.tmp-'))).toBe(
      false,
    )

    const divergent = root()
    const divergentSource = log(divergent, 'console.err', DAY)
    const divergentDestination = `${divergentSource}.2026-08-22.gz`
    writeFileSync(divergentDestination, 'not this log')
    const sourceBefore = readFileSync(divergentSource, 'utf8')
    const destinationBefore = readFileSync(divergentDestination, 'utf8')

    expect(run(divergent, ['--apply']).exitCode).not.toBe(0)
    expect(readFileSync(divergentSource, 'utf8')).toBe(sourceBefore)
    expect(readFileSync(divergentDestination, 'utf8')).toBe(destinationBefore)
    expect(treeState(divergent).some(state => state.includes('.tmp-'))).toBe(
      false,
    )
  })

  test('archives each audit source atomically without changing or deleting that source', () => {
    const value = root()
    const source = audit(value, 'beta-1', '{"seq":1}\n')
    const before = readFileSync(source)

    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(readFileSync(source)).toEqual(before)
    const archiveDir = join(dirname(source), 'archive')
    expect(readdirSync(archiveDir)).toEqual(['trail-2026-W34.ndjson'])
    expect(readFileSync(join(archiveDir, 'trail-2026-W34.ndjson'))).toEqual(
      before,
    )
    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(readdirSync(archiveDir)).toEqual(['trail-2026-W34.ndjson'])
  })

  test('does not overwrite a divergent audit seal or leave a temporary artifact', () => {
    const value = root()
    const source = audit(value, 'beta-1', '{"seq":1}\n')
    const archive = join(dirname(source), 'archive')
    mkdirSync(archive)
    const destination = join(archive, 'trail-2026-W34.ndjson')
    writeFileSync(destination, '{"seq":0}\n')

    const sourceBefore = readFileSync(source, 'utf8')
    const destinationBefore = readFileSync(destination, 'utf8')

    expect(run(value, ['--apply']).exitCode).not.toBe(0)
    expect(readFileSync(source, 'utf8')).toBe(sourceBefore)
    expect(readFileSync(destination, 'utf8')).toBe(destinationBefore)
    expect(readdirSync(archive).sort()).toEqual(['trail-2026-W34.ndjson'])
    expect(treeState(value).some(state => state.includes('.tmp-'))).toBe(false)
  })

  test('uses ISO weeks across a year boundary and only seals on Sunday', () => {
    const sunday = root()
    const sundaySource = audit(sunday, 'beta-1', '{"seq":1}\n')
    expect(run(sunday, ['--apply'], Date.UTC(2027, 0, 3, 12)).exitCode).toBe(0)
    expect(readdirSync(join(dirname(sundaySource), 'archive'))).toEqual([
      'trail-2026-W53.ndjson',
    ])

    const monday = root()
    const mondaySource = audit(monday, 'beta-1', '{"seq":1}\n')
    expect(run(monday, ['--apply'], Date.UTC(2027, 0, 4, 12)).exitCode).toBe(0)
    expect(existsSync(join(dirname(mondaySource), 'archive'))).toBe(false)
  })

  test('creates an upgrade registry snapshot atomically and retains the latest four with a stable tie break', () => {
    const value = root()
    const source = join(value, 'state', 'registry-agents.json')
    writeFileSync(source, '{"version":1}\n')
    for (const name of [
      'registry-20260801T000000Z-a.json',
      'registry-20260802T000000Z-b.json',
      'registry-20260803T000000Z-c.json',
      'registry-20260804T000000Z-d.json',
      'registry-20260804T000000Z-e.json',
    ]) {
      writeFileSync(join(value, 'state', 'snapshots', name), name)
    }

    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(readdirSync(join(value, 'state', 'snapshots')).sort()).toEqual([
      'registry-20260802T000000Z-b.json',
      'registry-20260803T000000Z-c.json',
      'registry-20260804T000000Z-d.json',
      'registry-20260804T000000Z-e.json',
    ])
    expect(run(value, ['--apply', '--snapshot-registry']).exitCode).toBe(0)
    expect(
      readdirSync(join(value, 'state', 'snapshots')).filter(name =>
        name.endsWith('.json'),
      ),
    ).toHaveLength(4)
    expect(run(value, ['--apply', '--snapshot-registry']).exitCode).toBe(0)
    expect(treeState(value).some(state => state.includes('.tmp-'))).toBe(false)
  })

  test('does not overwrite a divergent registry snapshot or leave a temporary artifact', () => {
    const value = root()
    const source = join(value, 'state', 'registry-agents.json')
    const destination = join(
      value,
      'state',
      'snapshots',
      'registry-20260823T120000Z.json',
    )
    writeFileSync(source, '{"version":1}\n')
    writeFileSync(destination, '{"version":0}\n')
    const sourceBefore = readFileSync(source, 'utf8')
    const destinationBefore = readFileSync(destination, 'utf8')

    expect(run(value, ['--apply', '--snapshot-registry']).exitCode).not.toBe(0)
    expect(readFileSync(source, 'utf8')).toBe(sourceBefore)
    expect(readFileSync(destination, 'utf8')).toBe(destinationBefore)
    expect(treeState(value).some(state => state.includes('.tmp-'))).toBe(false)
  })

  test('fails closed when a racing directory creator leaves an unsafe archive path', () => {
    const symlinkRoot = root()
    const symlinkSource = audit(symlinkRoot, 'beta-1', '{"seq":1}\n')
    const outside = mkdtempSync(join(tmpdir(), 'qianmo-beta-retain-outside-'))
    roots.push(outside)
    const symlinkArchive = join(dirname(symlinkSource), 'archive')
    symlinkSync(outside, symlinkArchive)

    expect(run(symlinkRoot, ['--apply']).exitCode).not.toBe(0)
    expect(readFileSync(symlinkSource, 'utf8')).toBe('{"seq":1}\n')
    expect(readdirSync(outside)).toEqual([])
    expect(treeState(symlinkRoot).some(state => state.includes('.tmp-'))).toBe(
      false,
    )

    const fileRoot = root()
    const fileSource = audit(fileRoot, 'beta-1', '{"seq":1}\n')
    const fileArchive = join(dirname(fileSource), 'archive')
    writeFileSync(fileArchive, 'not a directory')

    expect(run(fileRoot, ['--apply']).exitCode).not.toBe(0)
    expect(readFileSync(fileSource, 'utf8')).toBe('{"seq":1}\n')
    expect(readFileSync(fileArchive, 'utf8')).toBe('not a directory')
    expect(treeState(fileRoot).some(state => state.includes('.tmp-'))).toBe(
      false,
    )
  })

  test('only warns for an oversized admission ledger without changing either side of the threshold', () => {
    const value = root()
    const small = ledger(value, 'beta-1', 'planner', 10 * 1024 * 1024)
    const large = ledger(value, 'beta-1', 'reviewer', 10 * 1024 * 1024 + 1)
    const before = [readFileSync(small), readFileSync(large)]

    const result = run(value, ['--apply'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('WARN')
    expect(readFileSync(small)).toEqual(before[0])
    expect(readFileSync(large)).toEqual(before[1])
  })

  test('rejects unsafe roots, marker failures, unsupported arguments, and symlink escape attempts before writing', () => {
    const value = root()
    const outside = mkdtempSync(join(tmpdir(), 'qianmo-beta-retain-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'sentinel'), 'safe')

    expect(run(value, ['--unknown']).exitCode).not.toBe(0)
    expect(run(value, ['--apply', '--apply']).exitCode).not.toBe(0)
    expect(run(value, ['--apply', '--dry-run']).exitCode).not.toBe(0)
    expect(run(value, ['--apply']).exitCode).toBe(0)

    const unsafe = run('/', ['--apply'])
    expect(unsafe.exitCode).not.toBe(0)

    rmSync(join(value, '.qianmo-beta-env'))
    expect(run(value, ['--apply']).exitCode).not.toBe(0)
    writeFileSync(join(value, '.qianmo-beta-env'), 'qianmo-beta-env/v1\n')

    rmSync(join(value, 'backups'), { recursive: true })
    symlinkSync(outside, join(value, 'backups'))
    expect(run(value, ['--apply']).exitCode).not.toBe(0)
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('safe')

    rmSync(join(value, 'backups'))
    mkdirSync(join(value, 'backups'))
    symlinkSync(
      join(outside, 'sentinel'),
      join(value, 'backups', '01770000000099-0001.tar.gz'),
    )
    writeFileSync(
      join(value, 'backups', '01770000000099-0001.json'),
      JSON.stringify({ id: '01770000000099-0001', createdAt: NOW - 20 * DAY }),
    )
    expect(run(value, ['--apply']).exitCode).not.toBe(0)
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('safe')
  })

  test('does not allow attack-shaped file names to escape or execute anything', () => {
    const value = root()
    const attack = '$(touch SHOULD_NOT_EXIST) *.out'
    const path = log(value, attack, 20 * DAY)
    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(() => lstatSync(path)).toThrow()
    expect(() => lstatSync(join(value, 'SHOULD_NOT_EXIST'))).toThrow()
  })
})
