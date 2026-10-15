// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * In-place upgrade (P31 §5.2): a release is only installed after its
 * checksum, its member names and its own `--version` check out; the swap
 * keeps one backup and a failed check leaves the live tree untouched.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { OutboundPolicy } from '../../src/commands/outboundPolicy.js'
import {
  assetName,
  backupOf,
  checkMembers,
  compareVersions,
  expectedHash,
  type InstallTree,
  latestRelease,
  type Release,
  restoreBackup,
  rollbackReleases,
  stageRelease,
  swapIn,
  withUpgradeLock,
} from '../../src/host/selfUpgrade.js'
import { SelfUpgrader } from '../../src/host/selfUpgradeRunner.js'

let root: string
let tree: InstallTree
let served: Map<
  string,
  { status: number; body?: Uint8Array | string; location?: string }
>
let requests: { url: string; auth: string | null }[]

function script(version: string): string {
  return `#!/bin/sh\necho "qm ${version} (omp 18.8.8) abc"\n`
}

function writeTree(dir: string, version: string): void {
  mkdirSync(path.join(dir, 'dist'), { recursive: true })
  mkdirSync(path.join(dir, 'demo'), { recursive: true })
  writeFileSync(path.join(dir, 'dist', 'qm-linux-x64'), script(version))
  chmodSync(path.join(dir, 'dist', 'qm-linux-x64'), 0o755)
  writeFileSync(path.join(dir, 'demo', 'marker'), version)
}

/** A payload tgz for `version`, with optional extra members. */
function payload(version: string, extra?: (dir: string) => void): Uint8Array {
  const dir = mkdtempSync(path.join(root, 'payload-'))
  writeTree(dir, version)
  extra?.(dir)
  const out = path.join(root, `p-${version}-${Math.random()}.tgz`)
  const made = Bun.spawnSync(['tar', '-czf', out, '-C', dir, 'dist', 'demo'])
  expect(made.exitCode).toBe(0)
  return new Uint8Array(readFileSync(out))
}

function publish(
  version: string,
  bytes: Uint8Array,
  options: { hash?: string } = {},
): Release {
  const name = assetName(version, 'linux-x64')
  const hash = options.hash ?? createHash('sha256').update(bytes).digest('hex')
  const api = `https://api.github.com/repos/team/atlas/releases/assets/${version}`
  served.set(api, {
    status: 302,
    location: `https://release-assets.githubusercontent.com/${version}.tgz`,
  })
  served.set(`https://release-assets.githubusercontent.com/${version}.tgz`, {
    status: 200,
    body: bytes,
  })
  served.set(`${api}-sum`, { status: 200, body: `${hash}  ${name}\n` })
  return {
    version,
    publishedAt: '2026-10-15T00:00:00Z',
    htmlUrl: '',
    draft: false,
    prerelease: false,
    assets: [
      { name, url: api, size: bytes.byteLength },
      { name: `${name}.sha256`, url: `${api}-sum`, size: 90 },
    ],
  }
}

const policy = () =>
  new OutboundPolicy({
    lookup: async () => [{ address: '140.82.112.6', family: 4 }],
    fetch: async (url, init) => {
      requests.push({
        url,
        auth: new Headers(init.headers).get('authorization'),
      })
      const hit = served.get(url)
      if (hit === undefined) return new Response('missing', { status: 404 })
      return new Response(hit.body ?? null, {
        status: hit.status,
        headers: hit.location ? { location: hit.location } : {},
      })
    },
  })

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'qm-upgrade-'))
  const dir = path.join(root, 'tree')
  writeTree(dir, '3.0.1')
  tree = {
    tree: dir,
    platform: 'linux-x64',
    bin: path.join(dir, 'dist', 'qm-linux-x64'),
  }
  served = new Map()
  requests = []
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

test('versions order like semver; checksums and member names are checked', () => {
  expect(compareVersions('3.0.1', '3.0.2')).toBe(-1)
  expect(compareVersions('v3.1.0', '3.0.9')).toBe(1)
  expect(compareVersions('3.0.0-dev', '3.0.0')).toBe(-1)
  expect(compareVersions('3.0.0', '3.0.0')).toBe(0)
  const hash = 'a'.repeat(64)
  expect(
    expectedHash(
      `${hash}  qianmo-1.0.0-linux-x64.tgz\n`,
      'qianmo-1.0.0-linux-x64.tgz',
    ),
  ).toBe(hash)
  expect(
    expectedHash(`${hash} *other.tgz`, 'qianmo-1.0.0-linux-x64.tgz'),
  ).toBeNull()
  expect(() =>
    checkMembers(['dist/', 'dist/qm-linux-x64', 'demo/x']),
  ).not.toThrow()
  for (const bad of [
    ['../etc/passwd'],
    ['/etc/passwd'],
    ['dist/../../x'],
    ['src/x'],
    [],
  ])
    expect(() => checkMembers(bad)).toThrow()
})

test('a release is staged, swapped in with a backup, and rolled back', async () => {
  const release = publish('3.1.0', payload('3.1.0'))
  const source = { policy: policy(), repo: 'team/atlas', token: 'secret' }
  const staged = await stageRelease({ source, tree, release })
  // Nothing live changed while staging.
  expect(readFileSync(path.join(tree.tree, 'demo', 'marker'), 'utf8')).toBe(
    '3.0.1',
  )
  // The token never followed the redirect off api.github.com.
  expect(
    requests.find(one => one.url.includes('release-assets'))?.auth,
  ).toBeNull()
  expect(requests.find(one => one.url.includes('api.github.com'))?.auth).toBe(
    'Bearer secret',
  )

  swapIn(tree, staged, '3.0.1', 1)
  expect(readFileSync(path.join(tree.tree, 'demo', 'marker'), 'utf8')).toBe(
    '3.1.0',
  )
  expect(
    readFileSync(path.join(tree.tree, 'demo.bak-upgrade', 'marker'), 'utf8'),
  ).toBe('3.0.1')
  expect(existsSync(staged.dir)).toBe(false)
  expect(backupOf(tree)).toEqual({ version: '3.0.1', at: 1 })

  expect(restoreBackup(tree, 2)).toBe('3.0.1')
  expect(readFileSync(path.join(tree.tree, 'demo', 'marker'), 'utf8')).toBe(
    '3.0.1',
  )
  // The rolled-back-from version is now the backup: rolling forward again works.
  expect(backupOf(tree)).toEqual({ version: '3.1.0', at: 2 })
})

test('a bad checksum, a stray member, a link or a wrong version stage nothing', async () => {
  const source = { policy: policy(), repo: 'team/atlas' }
  const stray = (() => {
    const dir = mkdtempSync(path.join(root, 'stray-'))
    writeTree(dir, '3.3.0')
    mkdirSync(path.join(dir, 'src'))
    writeFileSync(path.join(dir, 'src', 'x'), 'x')
    const out = path.join(root, 'stray.tgz')
    expect(
      Bun.spawnSync(['tar', '-czf', out, '-C', dir, 'dist', 'demo', 'src'])
        .exitCode,
    ).toBe(0)
    return new Uint8Array(readFileSync(out))
  })()
  const cases: [string, Release][] = [
    ['SHA-256', publish('3.2.0', payload('3.2.0'), { hash: 'b'.repeat(64) })],
    ['只能含', publish('3.3.0', stray)],
    [
      '符号链接',
      publish(
        '3.4.0',
        payload('3.4.0', dir =>
          symlinkSync('/etc/passwd', path.join(dir, 'demo', 'link')),
        ),
      ),
    ],
    ['自报版本', publish('3.5.0', payload('9.9.9'))],
  ]
  for (const [said, release] of cases) {
    const error = await stageRelease({ source, tree, release }).catch(
      (failure: Error) => failure,
    )
    expect(`${release.version} ${(error as Error).message}`).toContain(said)
    expect(readFileSync(path.join(tree.tree, 'demo', 'marker'), 'utf8')).toBe(
      '3.0.1',
    )
  }
  // No scratch directories are left behind.
  expect(
    Bun.spawnSync(['ls', '-A', tree.tree])
      .stdout.toString()
      .trim()
      .split('\n')
      .sort(),
  ).toEqual(['demo', 'dist'])
})

test('releases: latest, and at most three older ones for rollback', async () => {
  served.set('https://api.github.com/repos/team/atlas/releases/latest', {
    status: 200,
    body: JSON.stringify({ tag_name: 'v3.2.0', assets: [] }),
  })
  served.set('https://api.github.com/repos/team/atlas/releases?per_page=15', {
    status: 200,
    body: JSON.stringify(
      [
        'v3.2.0',
        'v3.0.1',
        'v3.0.0',
        'v2.47.2',
        'v2.47.1',
        'v3.1.0-beta.1',
        'v2.46.0',
      ].map(tag => ({
        tag_name: tag,
        prerelease: tag.includes('beta'),
        assets: [],
      })),
    ),
  })
  const source = { policy: policy(), repo: 'team/atlas' }
  expect((await latestRelease(source)).version).toBe('3.2.0')
  expect(
    (await rollbackReleases(source, '3.0.1')).map(one => one.version),
  ).toEqual(['3.0.0', '2.47.2', '2.47.1'])
})

test('one upgrade per tree at a time', async () => {
  let release!: () => void
  const first = withUpgradeLock(
    tree,
    () => new Promise<void>(done => (release = done)),
  )
  await expect(withUpgradeLock(tree, async () => 1)).rejects.toThrow(
    '另一个升级',
  )
  release()
  await first
  expect(await withUpgradeLock(tree, async () => 2)).toBe(2)
})

test('the runner drains, swaps and restarts; work that does not finish calls it off', async () => {
  publish('3.1.0', payload('3.1.0'))
  served.set('https://api.github.com/repos/team/atlas/releases/tags/v3.1.0', {
    status: 200,
    body: JSON.stringify({
      tag_name: 'v3.1.0',
      assets: [
        {
          name: 'qianmo-3.1.0-linux-x64.tgz',
          url: 'https://api.github.com/repos/team/atlas/releases/assets/3.1.0',
          size: 10,
        },
        {
          name: 'qianmo-3.1.0-linux-x64.tgz.sha256',
          url: 'https://api.github.com/repos/team/atlas/releases/assets/3.1.0-sum',
          size: 90,
        },
      ],
    }),
  })
  let clock = 0
  let busy = true
  const events: string[] = []
  const upgrader = new SelfUpgrader({
    tree,
    version: '3.0.1',
    drain: () => events.push('drain'),
    resume: () => events.push('resume'),
    idle: () => !busy,
    restart: () => events.push('restart'),
    now: () => clock,
    sleep: async () => {
      clock += 60_000
    },
  })
  const source = { policy: policy(), repo: 'team/atlas' }

  // In-flight work outlasts the drain budget: called off, nothing swapped.
  expect(await upgrader.upgrade(source, '3.1.0', 120_000)).toMatchObject({
    ok: true,
  })
  await upgrader.settled()
  expect(upgrader.status()).toMatchObject({ state: 'failed', target: '3.1.0' })
  expect(events).toEqual(['drain', 'resume'])
  expect(readFileSync(path.join(tree.tree, 'demo', 'marker'), 'utf8')).toBe(
    '3.0.1',
  )

  busy = false
  events.length = 0
  expect(await upgrader.upgrade(source, '3.1.0')).toMatchObject({ ok: true })
  await upgrader.settled()
  expect(upgrader.status()).toMatchObject({
    state: 'restarting',
    target: '3.1.0',
  })
  expect(readFileSync(path.join(tree.tree, 'demo', 'marker'), 'utf8')).toBe(
    '3.1.0',
  )
  await Bun.sleep(600)
  expect(events).toEqual(['drain', 'restart'])
  expect((await upgrader.facts()).installed).toBe('3.1.0')
  expect((await upgrader.facts()).backup).toBe('3.0.1')

  // Downgrades only to one of the three newest older releases.
  served.set('https://api.github.com/repos/team/atlas/releases?per_page=15', {
    status: 200,
    body: JSON.stringify([{ tag_name: 'v3.0.0', assets: [] }]),
  })
  const older = new SelfUpgrader({ tree, version: '3.1.0', restart: () => {} })
  expect(await older.upgrade(source, '2.0.0')).toMatchObject({ ok: true })
  await older.settled()
  expect(older.status()).toMatchObject({ state: 'failed' })
  expect(older.status().detail).toContain('最近三个')
})

test('a source run cannot upgrade itself', async () => {
  const upgrader = new SelfUpgrader({ tree: null, version: '3.0.1' })
  expect(upgrader.rollback()).toMatchObject({ ok: false, code: 'refused' })
  expect(
    await upgrader.upgrade({ policy: policy(), repo: 'team/atlas' }, '3.1.0'),
  ).toMatchObject({ ok: false })
  expect((await upgrader.facts()).upgradable).toBe(false)
})
