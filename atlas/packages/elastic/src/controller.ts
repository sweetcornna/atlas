// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { verifyBytes } from '@qianmo/capability'
import { needFromDecision, type ScaleUpDecision } from '@qianmo/capacity'
import {
  AllocationRejected,
  catalogSchema,
  holdsCapacity,
  requestSchema,
  type AllocationPlan,
  type AllocationRequest,
  type ElasticOperation,
  type PoolAdapter,
  type ResourceCatalog,
  type WorkerReceipt,
} from './types.js'

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const approvalPayload = (operation: ElasticOperation) =>
  JSON.stringify([
    'qianmo-elastic-approval-v1',
    operation.planHash,
    operation.plan.tenant,
    operation.plan.validUntil,
  ])

/** Transactions reserve capacity before the external side effect; uncertainty never frees it. */
export class ElasticController {
  readonly #db: Database
  readonly #catalog: ResourceCatalog
  readonly #catalogHash: string
  readonly #now: () => number
  constructor(
    path: string,
    catalog: ResourceCatalog,
    now: () => number = Date.now,
  ) {
    this.#catalog = catalogSchema.parse(catalog)
    this.#catalogHash = hash(this.#catalog)
    this.#now = now
    for (const list of [
      this.#catalog.nodes,
      this.#catalog.tenants,
      this.#catalog.approvers,
    ])
      if (new Set(list.map(item => item.id)).size !== list.length)
        throw new Error('duplicate catalog identity')
    for (const node of this.#catalog.nodes)
      if (!this.#catalog.tenants.some(tenant => tenant.id === node.tenant))
        throw new Error('node names unknown tenant')
    if (path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.#db = new Database(path, { create: true, strict: true })
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.#db.exec(
      'PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS elastic_ops (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS elastic_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);',
    )
  }
  #all(): ElasticOperation[] {
    return this.#db
      .query<{ data: string }, []>('SELECT data FROM elastic_ops')
      .all()
      .map(row => JSON.parse(row.data) as ElasticOperation)
  }
  #save(operation: ElasticOperation, kind: string): ElasticOperation {
    this.#db
      .query(
        'INSERT INTO elastic_ops (id,tenant,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(operation.plan.id, operation.plan.tenant, JSON.stringify(operation))
    this.#db
      .query('INSERT INTO elastic_events (id,at,kind,detail) VALUES (?,?,?,?)')
      .run(
        operation.plan.id,
        this.#now(),
        kind,
        JSON.stringify({
          tenant: operation.plan.tenant,
          planHash: operation.planHash,
          state: operation.state,
          node: operation.plan.node,
          reason: operation.reason ?? '',
        }),
      )
    return operation
  }
  get(id: string, tenant: string): ElasticOperation {
    const row = this.#db
      .query<{ data: string }, [string, string]>(
        'SELECT data FROM elastic_ops WHERE id=? AND tenant=?',
      )
      .get(id, tenant)
    if (!row) throw new Error('operation not found or inaccessible')
    return JSON.parse(row.data) as ElasticOperation
  }
  status(tenant: string): ElasticOperation[] {
    if (!this.#catalog.tenants.some(candidate => candidate.id === tenant))
      throw new Error('tenant not found or inaccessible')
    return this.#all().filter(operation => operation.plan.tenant === tenant)
  }
  #capacity(plan: AllocationPlan, exceptId?: string): void {
    const node = this.#catalog.nodes.find(
      candidate =>
        candidate.id === plan.node &&
        candidate.tenant === plan.tenant &&
        candidate.available,
    )
    const tenant = this.#catalog.tenants.find(
      candidate => candidate.id === plan.tenant,
    )
    if (
      !node ||
      !tenant ||
      !plan.capabilities.every(capability =>
        node.capabilities.includes(capability),
      )
    )
      throw new Error('resource not found or inaccessible')
    const ops = this.#all().filter(operation => operation.plan.id !== exceptId)
    const active = ops.filter(operation => holdsCapacity(operation.state))
    const onNode = active.filter(operation => operation.plan.node === plan.node)
    const owned = active.filter(
      operation => operation.plan.tenant === plan.tenant,
    )
    const sum = (items: ElasticOperation[], field: 'cpuCores' | 'memoryMb') =>
      items.reduce((total, operation) => total + operation.plan[field], 0) +
      plan[field]
    if (
      sum(onNode, 'cpuCores') > node.cpuCores ||
      sum(onNode, 'memoryMb') > node.memoryMb ||
      sum(active, 'cpuCores') > this.#catalog.policy.maxCpuCores ||
      sum(active, 'memoryMb') > this.#catalog.policy.maxMemoryMb ||
      sum(owned, 'cpuCores') > tenant.maxCpuCores ||
      sum(owned, 'memoryMb') > tenant.maxMemoryMb
    )
      throw new Error('capacity or tenant quota exhausted')
    const cost =
      ops
        .filter(operation => operation.plan.tenant === plan.tenant)
        .reduce(
          (total, operation) =>
            total +
            (holdsCapacity(operation.state)
              ? operation.plan.costMicros
              : operation.chargedMicros),
          0,
        ) + plan.costMicros
    const totalCost =
      ops.reduce(
        (sum, operation) =>
          sum +
          (holdsCapacity(operation.state)
            ? operation.plan.costMicros
            : operation.chargedMicros),
        0,
      ) + plan.costMicros
    if (
      !Number.isSafeInteger(totalCost) ||
      totalCost > this.#catalog.policy.totalBudgetMicros
    )
      throw new Error('global budget exhausted')
    if (
      !Number.isSafeInteger(cost) ||
      cost > tenant.budgetMicros ||
      plan.costMicros > this.#catalog.policy.maxLeaseCostMicros
    )
      throw new Error('budget exhausted')
  }
  plan(raw: AllocationRequest): ElasticOperation {
    const request = requestSchema.parse(raw)
    return this.#db
      .transaction(() => {
        const prior = this.#db
          .query<{ data: string }, [string]>(
            'SELECT data FROM elastic_ops WHERE id=?',
          )
          .get(request.id)
        if (prior) {
          const operation: ElasticOperation = JSON.parse(prior.data)
          const { id, tenant, cpuCores, memoryMb, durationMs, capabilities } =
            operation.plan
          if (
            hash({
              id,
              tenant,
              cpuCores,
              memoryMb,
              durationMs,
              capabilities,
            }) !== hash(request)
          )
            throw new Error('idempotency id conflicts with another request')
          return operation
        }
        const now = this.#now()
        if (request.durationMs > this.#catalog.policy.maxDurationMs)
          throw new Error('duration exceeds policy')
        if (!this.#catalog.tenants.some(tenant => tenant.id === request.tenant))
          throw new Error('tenant not found or inaccessible')
        let selected: AllocationPlan | undefined
        for (const node of [...this.#catalog.nodes].sort((a, b) =>
          a.id.localeCompare(b.id),
        )) {
          if (
            node.tenant !== request.tenant ||
            !node.available ||
            !request.capabilities.every(capability =>
              node.capabilities.includes(capability),
            )
          )
            continue
          const cpuDominates =
            BigInt(request.cpuCores) * BigInt(node.memoryMb) >=
            BigInt(request.memoryMb) * BigInt(node.cpuCores)
          const numerator =
            BigInt(node.costMicrosPerHour) *
            BigInt(request.durationMs) *
            BigInt(cpuDominates ? request.cpuCores : request.memoryMb)
          const denominator =
            3600000n * BigInt(cpuDominates ? node.cpuCores : node.memoryMb)
          const costMicros = Number(
            (numerator + denominator - 1n) / denominator,
          )
          if (!Number.isSafeInteger(costMicros) || costMicros < 1) continue
          const candidate: AllocationPlan = {
            ...request,
            node: node.id,
            catalogHash: this.#catalogHash,
            costMicros,
            createdAt: now,
            validUntil: now + this.#catalog.policy.planTtlMs,
          }
          try {
            this.#capacity(candidate)
            selected = candidate
            break
          } catch {
            /* try the next configured pool member */
          }
        }
        if (!selected)
          throw new Error(
            'no available resource within capacity, capability and budget limits',
          )
        return this.#save(
          {
            plan: selected,
            planHash: hash(selected),
            state: 'planned',
            chargedMicros: 0,
          },
          'planned',
        )
      })
      .immediate()
  }
  planDecision(tenant: string, decision: ScaleUpDecision): ElasticOperation {
    const need = needFromDecision(decision)
    return this.plan({ id: decision.id, tenant, ...need, capabilities: [] })
  }
  #validate(operation: ElasticOperation): void {
    if (
      hash(operation.plan) !== operation.planHash ||
      operation.plan.catalogHash !== this.#catalogHash
    )
      throw new Error('plan or catalog changed; create and review a new plan')
    if (this.#now() > operation.plan.validUntil)
      throw new Error('plan approval expired')
  }
  #approved(operation: ElasticOperation): void {
    this.#validate(operation)
    const approval = operation.approval
    const actor = this.#catalog.approvers.find(
      candidate =>
        candidate.id === approval?.actor &&
        candidate.tenants.includes(operation.plan.tenant),
    )
    if (
      !approval ||
      !actor ||
      !verifyBytes(
        actor.publicKey,
        approvalPayload(operation),
        approval.signature,
      )
    )
      throw new Error('approval missing, untrusted or not bound to plan')
  }
  approve(
    id: string,
    tenant: string,
    planHash: string,
    actor: string,
    signature: string,
  ): ElasticOperation {
    return this.#db
      .transaction(() => {
        const operation = this.get(id, tenant)
        this.#validate(operation)
        if (operation.planHash !== planHash)
          throw new Error('approval plan hash mismatch')
        if (!['planned', 'approved'].includes(operation.state))
          throw new Error('operation cannot be approved in its current state')
        operation.approval = { actor, signature, at: this.#now() }
        this.#approved(operation)
        operation.state = 'approved'
        return this.#save(operation, 'approved')
      })
      .immediate()
  }
  async apply(
    id: string,
    tenant: string,
    adapter: PoolAdapter,
  ): Promise<ElasticOperation> {
    const { operation, start } = this.#db
      .transaction(() => {
        const operation = this.get(id, tenant)
        if (operation.state === 'active') return { operation, start: false }
        if (operation.state !== 'approved')
          throw new Error(
            'operation is not approved or execution is uncertain; do not retry',
          )
        this.#approved(operation)
        this.#capacity(operation.plan, id)
        const latest = this.#db
          .query<{ at: number }, [string]>(
            "SELECT MAX(at) AS at FROM elastic_events WHERE kind='applying' AND id IN (SELECT id FROM elastic_ops WHERE tenant=?)",
          )
          .get(tenant)?.at
        if (
          latest !== null &&
          latest !== undefined &&
          this.#now() - latest < this.#catalog.policy.cooldownMs
        )
          throw new Error('tenant cooldown is active')
        operation.state = 'applying'
        operation.ownerPid = process.pid
        return { operation: this.#save(operation, 'applying'), start: true }
      })
      .immediate()
    if (!start) return operation
    try {
      const receipt = await adapter.allocate(operation.plan)
      if (receipt.id !== id || receipt.kind !== 'local-pool-worker')
        throw new Error('allocation receipt is uncorrelated')
      return this.#db
        .transaction(() => {
          const current = this.get(id, tenant)
          current.receipt = receipt
          current.state = 'active'
          delete current.ownerPid
          return this.#save(current, 'active')
        })
        .immediate()
    } catch (error) {
      return this.#db
        .transaction(() => {
          const current = this.get(id, tenant)
          current.state =
            error instanceof AllocationRejected ? 'failed' : 'unknown'
          current.reason =
            error instanceof AllocationRejected
              ? 'Allocation rejected with no surviving side effect'
              : 'Execution outcome unknown; capacity remains reserved'
          delete current.ownerPid
          return this.#save(current, current.state)
        })
        .immediate()
    }
  }
  async release(
    id: string,
    tenant: string,
    adapter: PoolAdapter,
  ): Promise<ElasticOperation> {
    const { operation, start } = this.#db
      .transaction(() => {
        const operation = this.get(id, tenant)
        if (operation.state === 'released' || operation.state === 'failed')
          return { operation, start: false }
        if (operation.state !== 'active' || !operation.receipt)
          throw new Error(
            'release requires a confirmed active receipt; uncertain allocations need operator reconciliation',
          )
        operation.state = 'releasing'
        operation.ownerPid = process.pid
        return { operation: this.#save(operation, 'releasing'), start: true }
      })
      .immediate()
    if (!start) return operation
    try {
      await adapter.release(operation.receipt!)
      return this.#db
        .transaction(() => {
          const current = this.get(id, tenant)
          const elapsed = Math.min(
            current.plan.durationMs,
            Math.max(0, this.#now() - current.receipt!.startedAt),
          )
          const numerator =
            BigInt(current.plan.costMicros) * BigInt(Math.floor(elapsed))
          const denominator = BigInt(current.plan.durationMs)
          current.chargedMicros = Number(
            (numerator + denominator - 1n) / denominator,
          )
          current.state = 'released'
          delete current.ownerPid
          return this.#save(current, 'released')
        })
        .immediate()
    } catch {
      return this.#db
        .transaction(() => {
          const current = this.get(id, tenant)
          current.state = 'unknown'
          current.reason = 'Release outcome unknown; capacity remains reserved'
          delete current.ownerPid
          return this.#save(current, 'unknown')
        })
        .immediate()
    }
  }
  async reconcile(
    id: string,
    tenant: string,
    adapter: PoolAdapter & {
      inspect(plan: AllocationPlan): Promise<WorkerReceipt | null>
    },
  ): Promise<ElasticOperation> {
    const operation = this.get(id, tenant)
    if (operation.state !== 'unknown')
      throw new Error('only uncertain operations need reconciliation')
    const receipt = await adapter.inspect(operation.plan)
    if (!receipt || receipt.id !== id || receipt.kind !== 'local-pool-worker')
      throw new Error('no verified live allocation; reservation remains held')
    return this.#db
      .transaction(() => {
        const current = this.get(id, tenant)
        if (current.state !== 'unknown')
          throw new Error('operation changed during reconciliation')
        current.receipt = receipt
        current.state = 'active'
        delete current.reason
        return this.#save(current, 'reconciled')
      })
      .immediate()
  }
  recover(): number {
    return this.#db
      .transaction(() => {
        let count = 0
        for (const operation of this.#all()) {
          if (!['applying', 'releasing'].includes(operation.state)) continue
          let alive = true
          try {
            process.kill(operation.ownerPid ?? 0, 0)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false
          }
          if (alive) continue
          operation.state = 'unknown'
          operation.reason =
            'Controller exited during an external operation; do not repeat it'
          delete operation.ownerPid
          this.#save(operation, 'unknown')
          count++
        }
        return count
      })
      .immediate()
  }
  close(): void {
    this.#db.close()
  }
}
