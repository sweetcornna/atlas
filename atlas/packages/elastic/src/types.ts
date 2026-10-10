// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from 'zod'
const positive = z.number().int().positive().max(1_000_000_000)
const identifier = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
export const catalogSchema = z
  .object({
    mode: z.literal('existing-pool-local-simulation'),
    nodes: z
      .array(
        z
          .object({
            id: identifier,
            tenant: identifier,
            available: z.boolean(),
            cpuCores: positive,
            memoryMb: positive,
            costMicrosPerHour: positive,
            capabilities: z.array(identifier).max(64),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    tenants: z
      .array(
        z
          .object({
            id: identifier,
            maxCpuCores: positive,
            maxMemoryMb: positive,
            budgetMicros: positive,
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    policy: z
      .object({
        maxCpuCores: positive,
        maxMemoryMb: positive,
        maxLeaseCostMicros: positive,
        totalBudgetMicros: positive,
        maxDurationMs: positive,
        cooldownMs: z.number().int().min(0).max(86400000),
        planTtlMs: positive,
      })
      .strict(),
    approvers: z
      .array(
        z
          .object({
            id: identifier,
            publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
            tenants: z.array(identifier),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
export type ResourceCatalog = z.infer<typeof catalogSchema>
export const requestSchema = z
  .object({
    id: identifier,
    tenant: identifier,
    cpuCores: positive,
    memoryMb: positive,
    durationMs: positive,
    capabilities: z.array(identifier).max(64).default([]),
  })
  .strict()
export type AllocationRequest = z.infer<typeof requestSchema>
export interface AllocationPlan extends AllocationRequest {
  node: string
  catalogHash: string
  costMicros: number
  createdAt: number
  validUntil: number
}
export interface Approval {
  actor: string
  signature: string
  at: number
}
export interface WorkerReceipt {
  id: string
  kind: 'local-pool-worker'
  socket: string
  token: string
  pid: number
  startedAt: number
  expiresAt: number
}
export type OperationState =
  | 'planned'
  | 'approved'
  | 'applying'
  | 'active'
  | 'releasing'
  | 'unknown'
  | 'failed'
  | 'released'
export interface ElasticOperation {
  plan: AllocationPlan
  planHash: string
  state: OperationState
  approval?: Approval
  receipt?: WorkerReceipt
  ownerPid?: number
  chargedMicros: number
  reason?: string
}
export interface PoolAdapter {
  allocate(plan: AllocationPlan): Promise<WorkerReceipt>
  release(receipt: WorkerReceipt): Promise<void>
}
/** Only use when it is certain no allocation side effect survived. Other failures retain capacity. */
export class AllocationRejected extends Error {}
export const holdsCapacity = (state: OperationState) =>
  ['applying', 'active', 'releasing', 'unknown'].includes(state)
