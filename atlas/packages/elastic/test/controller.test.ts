// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateNodeKeyPair, signBytes } from '@qianmo/capability'
import {
  AllocationRejected,
  ElasticController,
  approvalPayload,
  type AllocationRequest,
  type PoolAdapter,
  type ResourceCatalog,
  type WorkerReceipt,
} from '../src/index.js'
const keys = generateNodeKeyPair()
const foreign = generateNodeKeyPair()
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})
function catalog(): ResourceCatalog {
  return {
    mode: 'existing-pool-local-simulation',
    nodes: [
      {
        id: 'pool-a',
        tenant: 'a',
        available: true,
        cpuCores: 2,
        memoryMb: 512,
        costMicrosPerHour: 3600000,
        capabilities: ['code'],
      },
      {
        id: 'pool-b',
        tenant: 'b',
        available: true,
        cpuCores: 2,
        memoryMb: 512,
        costMicrosPerHour: 3600000,
        capabilities: ['code'],
      },
    ],
    tenants: [
      { id: 'a', maxCpuCores: 2, maxMemoryMb: 512, budgetMicros: 1000000 },
      { id: 'b', maxCpuCores: 2, maxMemoryMb: 512, budgetMicros: 1000000 },
    ],
    policy: {
      maxCpuCores: 4,
      maxMemoryMb: 1024,
      maxLeaseCostMicros: 100000,
      totalBudgetMicros: 2000000,
      maxDurationMs: 60000,
      cooldownMs: 0,
      planTtlMs: 60000,
    },
    approvers: [{ id: 'ops', publicKey: keys.publicKey, tenants: ['a'] }],
  }
}
const request = (id = 'lease-1'): AllocationRequest => ({
  id,
  tenant: 'a',
  cpuCores: 2,
  memoryMb: 512,
  durationMs: 10000,
  capabilities: ['code'],
})
function setup(config = catalog(), clock = Date.now) {
  const root = mkdtempSync(join(tmpdir(), 'qm-elastic-'))
  const path = join(root, 'state.sqlite')
  const controller = new ElasticController(path, config, clock)
  cleanups.push(() => {
    controller.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { controller, path }
}
function approve(controller: ElasticController, id: string) {
  const operation = controller.get(id, 'a')
  return controller.approve(
    id,
    'a',
    operation.planHash,
    'ops',
    signBytes(keys, approvalPayload(operation)),
  )
}
function receipt(id: string): WorkerReceipt {
  return {
    id,
    kind: 'local-pool-worker',
    pid: process.pid,
    socket: '/not-used',
    token: 'test',
    startedAt: Date.now(),
    expiresAt: Date.now() + 10000,
  }
}
const adapter: PoolAdapter = {
  allocate: async plan => receipt(plan.id),
  release: async () => {},
}
test('plan, hash-bound signed approval, apply idempotency and release with persisted result', async () => {
  const { controller, path } = setup()
  const plan = controller.plan(request())
  expect(plan.plan.node).toBe('pool-a')
  expect(plan.plan.costMicros).toBe(10000)
  expect(controller.plan(request()).planHash).toBe(plan.planHash)
  await expect(controller.apply('lease-1', 'a', adapter)).rejects.toThrow(
    'not approved',
  )
  expect(() =>
    controller.approve(
      'lease-1',
      'a',
      'different',
      'ops',
      signBytes(keys, approvalPayload(plan)),
    ),
  ).toThrow('hash mismatch')
  expect(() =>
    controller.approve(
      'lease-1',
      'a',
      plan.planHash,
      'ops',
      signBytes(foreign, approvalPayload(plan)),
    ),
  ).toThrow('untrusted')
  approve(controller, 'lease-1')
  let count = 0
  const counted = {
    ...adapter,
    allocate: async (plan: Parameters<PoolAdapter['allocate']>[0]) => {
      count++
      return receipt(plan.id)
    },
  }
  expect((await controller.apply('lease-1', 'a', counted)).state).toBe('active')
  expect((await controller.apply('lease-1', 'a', counted)).state).toBe('active')
  expect(count).toBe(1)
  expect((await controller.release('lease-1', 'a', adapter)).state).toBe(
    'released',
  )
  expect((await controller.release('lease-1', 'a', adapter)).state).toBe(
    'released',
  )
  const reopened = new ElasticController(path, catalog())
  expect(reopened.get('lease-1', 'a').state).toBe('released')
  reopened.close()
})
test('concurrent controllers cannot oversell the same resource and cannot access another tenant', async () => {
  const { controller, path } = setup()
  controller.plan(request('first'))
  controller.plan(request('second'))
  approve(controller, 'first')
  approve(controller, 'second')
  const second = new ElasticController(path, catalog())
  let unblock: (value: WorkerReceipt) => void = () => {}
  const running = controller.apply('first', 'a', {
    ...adapter,
    allocate: () =>
      new Promise(resolve => {
        unblock = resolve
      }),
  })
  await expect(second.apply('second', 'a', adapter)).rejects.toThrow('capacity')
  expect(() => second.get('first', 'b')).toThrow('not found or inaccessible')
  expect(() => second.plan({ ...request('first'), tenant: 'b' })).toThrow(
    'conflicts',
  )
  unblock(receipt('first'))
  await running
  second.close()
})
test('budget, capabilities, unavailable nodes, duration and tenant approval are enforced', () => {
  const config = catalog()
  config.tenants[0]!.budgetMicros = 100
  const { controller } = setup(config)
  expect(() => controller.plan(request())).toThrow('budget')
  const normal = setup().controller
  expect(() => normal.plan({ ...request(), capabilities: ['gpu'] })).toThrow(
    'no available',
  )
  expect(() => normal.plan({ ...request(), durationMs: 60001 })).toThrow(
    'duration',
  )
  const b = normal.plan({ ...request('b-lease'), tenant: 'b' })
  expect(() =>
    normal.approve(
      'b-lease',
      'b',
      b.planHash,
      'ops',
      signBytes(keys, approvalPayload(b)),
    ),
  ).toThrow('untrusted')
  const unavailable = catalog()
  unavailable.nodes[0]!.available = false
  expect(() => setup(unavailable).controller.plan(request())).toThrow(
    'no available',
  )
})
test('catalog change, approval expiry, cooldown and consumed budget refuse new execution', async () => {
  let now = 100000
  const config = catalog()
  config.policy.cooldownMs = 1000
  const { controller, path } = setup(config, () => now)
  controller.plan(request('first'))
  approve(controller, 'first')
  const changed = catalog()
  changed.nodes[0]!.memoryMb = 1024
  const other = new ElasticController(path, changed, () => now)
  await expect(other.apply('first', 'a', adapter)).rejects.toThrow(
    'catalog changed',
  )
  other.close()
  await controller.apply('first', 'a', {
    ...adapter,
    allocate: async plan => ({ ...receipt(plan.id), startedAt: now }),
  })
  now += 100
  await controller.release('first', 'a', adapter)
  controller.plan(request('second'))
  approve(controller, 'second')
  await expect(controller.apply('second', 'a', adapter)).rejects.toThrow(
    'cooldown',
  )
  now = controller.get('second', 'a').plan.validUntil + 1
  await expect(controller.apply('second', 'a', adapter)).rejects.toThrow(
    'expired',
  )
})
test('known failed allocation releases reservation; uncertain allocation holds it across restart and can reconcile without re-execution', async () => {
  const { controller, path } = setup()
  controller.plan(request('known'))
  approve(controller, 'known')
  expect(
    (
      await controller.apply('known', 'a', {
        ...adapter,
        allocate: async () => {
          throw new AllocationRejected('no side effect')
        },
      })
    ).state,
  ).toBe('failed')
  controller.plan(request('uncertain'))
  approve(controller, 'uncertain')
  let executions = 0
  expect(
    (
      await controller.apply('uncertain', 'a', {
        ...adapter,
        allocate: async () => {
          executions++
          throw new Error('lost response after allocation')
        },
      })
    ).state,
  ).toBe('unknown')
  const reopened = new ElasticController(path, catalog())
  await expect(reopened.apply('uncertain', 'a', adapter)).rejects.toThrow(
    'uncertain',
  )
  expect(() => reopened.plan(request('blocked'))).toThrow('no available')
  expect(
    (
      await reopened.reconcile('uncertain', 'a', {
        ...adapter,
        inspect: async () => receipt('uncertain'),
      })
    ).state,
  ).toBe('active')
  expect(executions).toBe(1)
  await reopened.release('uncertain', 'a', adapter)
  expect(reopened.plan(request('after')).state).toBe('planned')
  reopened.close()
})
test('uncertain release holds resources, and suppressed capacity decisions cannot provision', async () => {
  const { controller } = setup()
  controller.plan(request())
  approve(controller, 'lease-1')
  await controller.apply('lease-1', 'a', adapter)
  expect(
    (
      await controller.release('lease-1', 'a', {
        ...adapter,
        release: async () => {
          throw new Error('unknown')
        },
      })
    ).state,
  ).toBe('unknown')
  expect(() => controller.plan(request('next'))).toThrow('no available')
  expect(() =>
    controller.planDecision('a', {
      id: 'suppressed',
      kind: 'scale-up-suppressed',
      at: 0,
      path: 'baseline',
      reason: 'cooldown',
      observed: 1,
      leadMs: 0,
    }),
  ).toThrow('suppressed')
})

test('released usage is charged against the tenant budget instead of resetting it', async () => {
  let now = 100000
  const config = catalog()
  config.tenants[0]!.budgetMicros = 10000
  const { controller } = setup(config, () => now)
  controller.plan(request('spent'))
  approve(controller, 'spent')
  await controller.apply('spent', 'a', {
    ...adapter,
    allocate: async plan => ({ ...receipt(plan.id), startedAt: now }),
  })
  now += 10000
  expect((await controller.release('spent', 'a', adapter)).chargedMicros).toBe(
    10000,
  )
  expect(() => controller.plan(request('next'))).toThrow('budget')
})

test('global budget is shared across tenant pools even when both tenant quotas have room', async () => {
  const config = catalog()
  config.policy.totalBudgetMicros = 15000
  const { controller } = setup(config)
  controller.plan(request('tenant-a'))
  approve(controller, 'tenant-a')
  await controller.apply('tenant-a', 'a', adapter)
  expect(() =>
    controller.plan({ ...request('tenant-b'), tenant: 'b' }),
  ).toThrow('budget')
})
