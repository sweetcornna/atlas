// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import { signBytes } from '@qianmo/capability'
import { AuditSource, AuditTrail } from '@qianmo/audit'
import {
  ElasticController,
  approvalPayload,
  catalogSchema,
  requestSchema,
  type ElasticOperation,
} from '@qianmo/elastic'
import { qianmoConfigPath } from '@qianmo/paths'
import { loadOrCreateNodeKeys } from '../host/nodeIdentity.js'
import { localPoolAdapter, runPoolWorker } from './elasticWorker.js'

const HELP = `Usage: qm elastic identity --actor <operator>
       qm elastic plan --catalog <json> --request <json>
       qm elastic plan --catalog <json> --tenant <tenant> --decision <capacity-decision-json>
       qm elastic approve --catalog <json> --tenant <tenant> --id <id> --hash <plan-hash> --actor <operator>
       qm elastic apply|release|reconcile --catalog <json> --tenant <tenant> --id <id>
       qm elastic status --catalog <json> --tenant <tenant>

Allocate existing catalog resources through isolated local simulation workers.
No cloud resources are created. Plans bind catalog, tenant, capacity and budget;
approve signs the exact plan hash with a configured operator's Ed25519 key.
Unknown execution outcomes retain reservations and cannot be blindly repeated.
See docs/dev/elastic-pool.md. State: <QIANMO_CONFIG_DIR>/qianmo/elastic/.
`
const decisionSchema = z
  .object({
    id: z.string(),
    kind: z.enum([
      'scale-up-predicted',
      'scale-up-reactive',
      'scale-up-suppressed',
    ]),
    at: z.number(),
    path: z.enum(['calendar', 'baseline']),
    reason: z.enum([
      'calendar-window',
      'baseline-deviation',
      'cooldown',
      'covered-by-calendar',
    ]),
    observed: z.number().nonnegative(),
    leadMs: z.number(),
    windowId: z.string().optional(),
    baselineMedian: z.number().optional(),
    baselineMad: z.number().optional(),
    zScore: z.number().optional(),
    consecutive: z.number().optional(),
  })
  .strict()
function publicOperation(operation: ElasticOperation) {
  const { receipt, ...rest } = operation
  return {
    ...rest,
    ...(receipt
      ? {
          receipt: {
            id: receipt.id,
            kind: receipt.kind,
            pid: receipt.pid,
            startedAt: receipt.startedAt,
            expiresAt: receipt.expiresAt,
          },
        }
      : {}),
  }
}
export async function run(argv: string[]): Promise<number> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP)
    return 0
  }
  const [command, ...rest] = argv
  if (command === '__worker') {
    if (rest.length !== 2 || rest[0] !== '--spec' || !rest[1])
      throw new Error('invalid internal worker invocation')
    runPoolWorker(rest[1])
    return 0
  }
  const flags = new Map<string, string>()
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (
      !key ||
      ![
        '--actor',
        '--catalog',
        '--request',
        '--decision',
        '--tenant',
        '--id',
        '--hash',
      ].includes(key) ||
      !value ||
      flags.has(key)
    )
      throw new Error('invalid elastic option')
    flags.set(key, value)
  }
  const required = (name: string) => {
    const value = flags.get(name)
    if (!value) throw new Error(`${name} is required`)
    return value
  }
  if (command === 'identity') {
    if (flags.size !== 1) throw new Error('identity accepts only --actor')
    const actor = required('--actor')
    if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(actor))
      throw new Error('invalid actor')
    console.log(
      JSON.stringify({
        id: actor,
        publicKey: loadOrCreateNodeKeys(`elastic-${actor}`).publicKey,
      }),
    )
    return 0
  }
  if (
    !['plan', 'approve', 'apply', 'release', 'reconcile', 'status'].includes(
      command!,
    )
  )
    throw new Error('unknown elastic command')
  const catalog = catalogSchema.parse(
    JSON.parse(readFileSync(required('--catalog'), 'utf8')),
  )
  const statePath = qianmoConfigPath('qianmo', 'elastic', 'operations.sqlite')
  const controller = new ElasticController(statePath, catalog)
  const auditLock = new Database(statePath)
  auditLock.exec('PRAGMA busy_timeout=5000')
  // CLI processes share the trail: construct/read/append under the same SQLite
  // write lock, so two successes cannot reuse a chain sequence or previous hash.
  const record = (operation: ElasticOperation) =>
    auditLock
      .transaction(() => {
        const trail = new AuditTrail(
          qianmoConfigPath('qianmo', 'elastic', 'audit.ndjson'),
        )
        try {
          trail.append({
            at: Date.now(),
            source: AuditSource.Capacity,
            kind: `elastic.${operation.state}`,
            taskId: operation.plan.id,
            outcome: ['failed', 'unknown'].includes(operation.state)
              ? 'refused'
              : 'ok',
            detail: {
              tenant: operation.plan.tenant,
              node: operation.plan.node,
              planHash: operation.planHash,
              costMicros: operation.plan.costMicros,
            },
          })
        } finally {
          trail.close()
        }
      })
      .immediate()
  try {
    controller.recover()
    if (command === 'plan') {
      if (Boolean(flags.get('--request')) === Boolean(flags.get('--decision')))
        throw new Error('plan needs exactly one of --request or --decision')
      const operation = flags.has('--request')
        ? controller.plan(
            requestSchema.parse(
              JSON.parse(readFileSync(required('--request'), 'utf8')),
            ),
          )
        : controller.planDecision(
            required('--tenant'),
            decisionSchema.parse(
              JSON.parse(readFileSync(required('--decision'), 'utf8')),
            ),
          )
      record(operation)
      console.log(JSON.stringify(publicOperation(operation)))
      return 0
    }
    const tenant = required('--tenant')
    if (command === 'status') {
      console.log(
        JSON.stringify(controller.status(tenant).map(publicOperation)),
      )
      return 0
    }
    const id = required('--id')
    let operation: ElasticOperation
    if (command === 'approve') {
      const actor = required('--actor')
      if (
        !catalog.approvers.some(
          approver =>
            approver.id === actor && approver.tenants.includes(tenant),
        )
      )
        throw new Error('approver is not authorized for this tenant')
      const hash = required('--hash')
      const existing = controller.get(id, tenant)
      if (hash !== existing.planHash)
        throw new Error('approval hash does not match reviewed plan')
      const keys = loadOrCreateNodeKeys(`elastic-${actor}`)
      operation = controller.approve(
        id,
        tenant,
        hash,
        actor,
        signBytes(keys, approvalPayload(existing)),
      )
    } else if (command === 'apply')
      operation = await controller.apply(id, tenant, localPoolAdapter())
    else if (command === 'release')
      operation = await controller.release(id, tenant, localPoolAdapter())
    else operation = await controller.reconcile(id, tenant, localPoolAdapter())
    record(operation)
    console.log(JSON.stringify(publicOperation(operation)))
    return operation.state === 'unknown' || operation.state === 'failed' ? 1 : 0
  } finally {
    controller.close()
    auditLock.close()
  }
}
