// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const script = resolve(import.meta.dir, 'field-plan.py')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

test('generated native and rollback wrappers enforce real-file preflight and attempt every stop', () => {
  const result = Bun.spawnSync(
    ['python3', '-B', join(import.meta.dir, 'field-plan-native.test.py')],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  expect(result.stderr.toString()).toContain('Ran 6 tests')
  expect(result.exitCode).toBe(0)
}, 30_000)
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'field-plan-'))
  const artifact = join(root, 'qm-fixture')
  writeFileSync(artifact, 'fixture-only')
  const plan = {
    version: 1,
    candidateId: 'fixture',
    sourceFilesSha256: hash('source'),
    artifacts: [
      { name: 'qm-linux-x64', path: artifact, sha256: hash('fixture-only') },
    ],
    hosts: ['hub', 'worker', 'witness'].map((role, i) => ({
      id: role,
      ssh: `fixture-${i}`,
      hostname: `test-${i}`,
      machineIdSha256: hash('cloned-template'),
      sshHostKey: 'ssh-ed25519 AAAATEST',
      hostIdentitySha256: hash(
        JSON.stringify({
          hostname: `test-${i}`,
          sshHostKey: 'ssh-ed25519 AAAATEST',
        }),
      ),
      bootId: '12345678-1234-1234-1234-123456789abc',
      role,
      uid: 1000,
      home: '/home/field',
      root: '/home/field/qianmo-candidate/fixture',
      ports: [39720 + i],
      bind: '127.0.0.1',
      memoryMaxMiB: 64,
      cpuQuotaPercent: 25,
    })),
    observationDays: 7,
    handoffRoundsPerTool: 2,
    semanticRecallEnabled: false,
  }
  const path = join(root, 'plan.json')
  const save = () => writeFileSync(path, JSON.stringify(plan))
  save()
  return { root, plan, path, save }
}
function run(...args: string[]) {
  const result = Bun.spawnSync(['python3', '-B', script, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  }
}

test('review binds artifacts/hosts and produces no executable remote action until explicit plan hash invocation', () => {
  const f = fixture(),
    out = join(f.root, 'review')
  expect(run('review', f.path, out).code).toBe(0)
  expect(
    JSON.parse(readFileSync(join(out, 'status.json'), 'utf8')),
  ).toMatchObject({
    remoteActionsExecuted: false,
    sevenDayPassed: false,
    p17Passed: false,
  })
  const guard = Bun.spawnSync(
    ['bash', join(out, 'stage-after-review.sh'), 'unapproved'],
    { env: { PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' },
  )
  expect(guard.exitCode).toBe(2)
  expect(guard.stderr.toString()).toContain('reviewed plan SHA required')
  expect(run('review', f.path, out).code).not.toBe(0)
})

test('checksum changes, root identities, collisions and public listeners fail closed', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.plan.artifacts[0]!.sha256 = hash('wrong')
    },
    (f: ReturnType<typeof fixture>) => {
      f.plan.hosts[0]!.uid = 0
    },
    (f: ReturnType<typeof fixture>) => {
      f.plan.hosts[0]!.bind = '0.0.0.0'
    },
    (f: ReturnType<typeof fixture>) => {
      f.plan.hosts[0]!.root = '/home/field/qianmo-beta'
    },
    (f: ReturnType<typeof fixture>) => {
      f.plan.hosts[0]!.hostIdentitySha256 = f.plan.hosts[1]!.hostIdentitySha256
    },
    (f: ReturnType<typeof fixture>) => {
      f.plan.hosts[0]!.ports = [38610]
    },
    (f: ReturnType<typeof fixture>) => {
      f.plan.observationDays = 1
    },
  ]) {
    const f = fixture()
    mutate(f)
    f.save()
    expect(run('review', f.path, join(f.root, 'review')).code).not.toBe(0)
  }
})

test('seven actual days cannot be shortened, elapsed time alone is never a pass', () => {
  const f = fixture(),
    path = join(f.root, 'window.json')
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      planSha256: hash('plan'),
      from: Date.now(),
      to: Date.now() + 60000,
    }),
  )
  expect(run('window-status', path).code).not.toBe(0)
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      planSha256: hash('plan'),
      from: 0,
      to: 7 * 86400000,
    }),
  )
  expect(JSON.parse(run('window-status', path).out)).toMatchObject({
    state: 'acquisition-window-elapsed',
    sevenDayPassed: false,
  })
  expect(
    run(
      'window-start',
      f.path,
      '--approved-plan-sha',
      hash('unapproved'),
      join(f.root, 'new-window.json'),
    ).code,
  ).not.toBe(0)
})

test('P17 missing/cross-root files and loopback machine identities cannot masquerade as cross-machine acceptance', () => {
  const f = fixture(),
    dir = join(f.root, 'evidence')
  mkdirSync(dir)
  const path = join(dir, 'manifest.json')
  writeFileSync(
    path,
    JSON.stringify({
      rounds: [
        {
          tool: 'qmcode',
          round: 1,
          hostIdentityHashes: {
            origin: hash('same'),
            worker: hash('same'),
            observer: hash('same'),
          },
          offlineSeconds: 1,
          files: { entry: '../plan.json' },
        },
      ],
    }),
  )
  const result = JSON.parse(run('handoff-check', path).out)
  expect(result.evidenceInventoryComplete).toBe(false)
  expect(result.p17Passed).toBe(false)
  expect(result.sourceHashes).toEqual([])
  expect(result.missing.length).toBeGreaterThan(10)
})
