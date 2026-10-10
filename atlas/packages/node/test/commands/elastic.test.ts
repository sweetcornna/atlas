// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { readTrail } from '@qianmo/audit'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ElasticController, type ResourceCatalog } from '@qianmo/elastic'

const cli = process.env.QIANMO_TEST_COMPILED_QM
  ? [process.env.QIANMO_TEST_COMPILED_QM]
  : [process.execPath, resolve(import.meta.dir, '../../src/cli.ts')]
test('actual qm elastic CLI reviews two plans, admits one concurrent worker, reuses id and releases it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-elastic-cli-'))
  mkdirSync(join(root, 'home'))
  const env = {
    HOME: join(root, 'home'),
    PATH: process.env.PATH ?? '',
    QIANMO_CONFIG_DIR: join(root, 'config'),
  }
  async function run(...args: string[]) {
    const child = Bun.spawn([...cli, 'elastic', ...args], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, stdout, stderr }
  }
  const identity = await run('identity', '--actor', 'ops')
  expect(identity.code).toBe(0)
  const publicKey = (JSON.parse(identity.stdout) as { publicKey: string })
    .publicKey
  const catalog: ResourceCatalog = {
    mode: 'existing-pool-local-simulation',
    nodes: [
      {
        id: 'local-a',
        tenant: 'a',
        available: true,
        cpuCores: 2,
        memoryMb: 512,
        costMicrosPerHour: 3600000,
        capabilities: ['code'],
      },
    ],
    tenants: [
      { id: 'a', maxCpuCores: 2, maxMemoryMb: 512, budgetMicros: 1000000 },
    ],
    policy: {
      maxCpuCores: 2,
      maxMemoryMb: 512,
      maxLeaseCostMicros: 100000,
      totalBudgetMicros: 2000000,
      maxDurationMs: 60000,
      cooldownMs: 0,
      planTtlMs: 60000,
    },
    approvers: [{ id: 'ops', publicKey, tenants: ['a'] }],
  }
  const catalogFile = join(root, 'catalog.json')
  writeFileSync(catalogFile, JSON.stringify(catalog))
  let activeId: string | undefined
  try {
    await Promise.all(
      ['one', 'two'].map(async id => {
        const file = join(root, `${id}.json`)
        writeFileSync(
          file,
          JSON.stringify({
            id,
            tenant: 'a',
            cpuCores: 2,
            memoryMb: 512,
            durationMs: 30000,
            capabilities: ['code'],
          }),
        )
        const plan = await run(
          'plan',
          '--catalog',
          catalogFile,
          '--request',
          file,
        )
        expect(plan.code, plan.stderr).toBe(0)
        const hash = (JSON.parse(plan.stdout) as { planHash: string }).planHash
        const denied = await run(
          'approve',
          '--catalog',
          catalogFile,
          '--tenant',
          'a',
          '--id',
          id,
          '--hash',
          'wrong',
          '--actor',
          'ops',
        )
        expect(denied.code).not.toBe(0)
        expect(
          (
            await run(
              'approve',
              '--catalog',
              catalogFile,
              '--tenant',
              'a',
              '--id',
              id,
              '--hash',
              hash,
              '--actor',
              'ops',
            )
          ).code,
        ).toBe(0)
      }),
    )
    const parallel = await Promise.all(
      ['one', 'two'].map(id =>
        run('apply', '--catalog', catalogFile, '--tenant', 'a', '--id', id),
      ),
    )
    expect(parallel.filter(result => result.code === 0)).toHaveLength(1)
    const first = JSON.parse(
      parallel.find(result => result.code === 0)!.stdout,
    ) as { plan: { id: string }; receipt: { pid: number }; state: string }
    activeId = first.plan.id
    expect(first.state).toBe('active')
    expect(first.receipt.pid).not.toBe(process.pid)
    const repeated = await run(
      'apply',
      '--catalog',
      catalogFile,
      '--tenant',
      'a',
      '--id',
      activeId,
    )
    expect(repeated.code).toBe(0)
    expect((JSON.parse(repeated.stdout) as typeof first).receipt.pid).toBe(
      first.receipt.pid,
    )
    expect(repeated.stdout).not.toContain('token')
    expect(repeated.stdout).not.toContain('socket')
    const started = JSON.parse(
      readFileSync(
        join(
          env.QIANMO_CONFIG_DIR,
          'qianmo',
          'elastic',
          'workers',
          activeId,
          'started.json',
        ),
        'utf8',
      ),
    ) as { pid: number }
    expect(started.pid).toBe(first.receipt.pid)
    expect(
      (await run('status', '--catalog', catalogFile, '--tenant', 'foreign'))
        .code,
    ).not.toBe(0)
    const released = await run(
      'release',
      '--catalog',
      catalogFile,
      '--tenant',
      'a',
      '--id',
      activeId,
    )
    expect(released.code).toBe(0)
    expect(JSON.parse(released.stdout).state).toBe('released')
    const db = new ElasticController(
      join(env.QIANMO_CONFIG_DIR, 'qianmo', 'elastic', 'operations.sqlite'),
      catalog,
    )
    const receipt = db.get(activeId, 'a').receipt!
    db.close()
    await expect(
      fetch('http://localhost/status', {
        unix: receipt.socket,
        headers: { Authorization: `Bearer ${receipt.token}` },
        signal: AbortSignal.timeout(500),
      }),
    ).rejects.toThrow()
    expect(
      readTrail(
        join(env.QIANMO_CONFIG_DIR, 'qianmo', 'elastic', 'audit.ndjson'),
      ).intact,
    ).toBe(true)
    console.log(
      JSON.stringify({
        evidence: 'elastic-cli',
        workerPid: first.receipt.pid,
        parallelAccepted: parallel.filter(result => result.code === 0).length,
        duplicatePid: (JSON.parse(repeated.stdout) as typeof first).receipt.pid,
        releasedState: JSON.parse(released.stdout).state,
      }),
    )
    activeId = undefined
  } finally {
    if (activeId)
      await run(
        'release',
        '--catalog',
        catalogFile,
        '--tenant',
        'a',
        '--id',
        activeId,
      )
    rmSync(root, { recursive: true, force: true })
  }
}, 30000)

test('real controller crash keeps reservation and reconciles the same live worker before release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-elastic-crash-'))
  mkdirSync(join(root, 'home'))
  const env = {
    HOME: join(root, 'home'),
    PATH: process.env.PATH ?? '',
    QIANMO_CONFIG_DIR: join(root, 'config'),
  }
  async function run(...args: string[]) {
    const child = Bun.spawn([...cli, 'elastic', ...args], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, stdout, stderr }
  }
  const publicKey = JSON.parse((await run('identity', '--actor', 'ops')).stdout)
    .publicKey as string
  const catalog: ResourceCatalog = {
    mode: 'existing-pool-local-simulation',
    nodes: [
      {
        id: 'local-a',
        tenant: 'a',
        available: true,
        cpuCores: 1,
        memoryMb: 128,
        costMicrosPerHour: 3600000,
        capabilities: [],
      },
    ],
    tenants: [
      { id: 'a', maxCpuCores: 1, maxMemoryMb: 128, budgetMicros: 1000000 },
    ],
    policy: {
      maxCpuCores: 1,
      maxMemoryMb: 128,
      maxLeaseCostMicros: 100000,
      totalBudgetMicros: 2000000,
      maxDurationMs: 60000,
      cooldownMs: 0,
      planTtlMs: 60000,
    },
    approvers: [{ id: 'ops', publicKey, tenants: ['a'] }],
  }
  const config = join(root, 'catalog.json')
  const request = join(root, 'request.json')
  writeFileSync(config, JSON.stringify(catalog))
  writeFileSync(
    request,
    JSON.stringify({
      id: 'crash',
      tenant: 'a',
      cpuCores: 1,
      memoryMb: 128,
      durationMs: 30000,
      capabilities: [],
    }),
  )
  const plan = JSON.parse(
    (await run('plan', '--catalog', config, '--request', request)).stdout,
  ) as { planHash: string }
  expect(
    (
      await run(
        'approve',
        '--catalog',
        config,
        '--tenant',
        'a',
        '--id',
        'crash',
        '--hash',
        plan.planHash,
        '--actor',
        'ops',
      )
    ).code,
  ).toBe(0)
  const crash = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'support/elasticCrash.runner.ts'),
      config,
    ],
    { env, stdout: 'pipe', stderr: 'pipe' },
  )
  let workerPid: number | undefined
  try {
    const reader = crash.stdout.getReader()
    let timer: ReturnType<typeof setTimeout> | undefined
    const ready = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('crash probe timeout')),
          10000,
        )
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })
    reader.releaseLock()
    workerPid = (
      JSON.parse(new TextDecoder().decode(ready.value)) as { pid: number }
    ).pid
    crash.kill('SIGKILL')
    await crash.exited
    const status = await run('status', '--catalog', config, '--tenant', 'a')
    expect(status.code).toBe(0)
    expect(JSON.parse(status.stdout)[0].state).toBe('unknown')
    expect(
      (
        await run(
          'apply',
          '--catalog',
          config,
          '--tenant',
          'a',
          '--id',
          'crash',
        )
      ).code,
    ).not.toBe(0)
    const reconciled = await run(
      'reconcile',
      '--catalog',
      config,
      '--tenant',
      'a',
      '--id',
      'crash',
    )
    expect(reconciled.code).toBe(0)
    expect(JSON.parse(reconciled.stdout).receipt.pid).toBe(workerPid)
    expect(
      (
        await run(
          'release',
          '--catalog',
          config,
          '--tenant',
          'a',
          '--id',
          'crash',
        )
      ).code,
    ).toBe(0)
    console.log(
      JSON.stringify({
        evidence: 'elastic-crash-recovery',
        originalPid: workerPid,
        reconciledPid: JSON.parse(reconciled.stdout).receipt.pid,
        stateBefore: JSON.parse(status.stdout)[0].state,
      }),
    )
    workerPid = undefined
  } finally {
    if (crash.exitCode === null) {
      crash.kill('SIGKILL')
      await crash.exited
    }
    if (workerPid) {
      await run(
        'reconcile',
        '--catalog',
        config,
        '--tenant',
        'a',
        '--id',
        'crash',
      )
      await run(
        'release',
        '--catalog',
        config,
        '--tenant',
        'a',
        '--id',
        'crash',
      )
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 30000)
