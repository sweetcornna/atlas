// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateNodeKeyPair, signBytes } from '@qianmo/capability'
import {
  ElasticController,
  approvalPayload,
  type ResourceCatalog,
  type WorkerReceipt,
} from '@qianmo/elastic'
import { localPoolAdapter } from '../../src/commands/elasticWorker.js'

test('release ACK plus unavailable or misleading status never frees a live worker reservation', async () => {
  await Promise.all(
    ['503', '401', 'malformed', 'wrong-identity', 'timeout', 'closed'].map(
      async mode => {
        const keys = generateNodeKeyPair()
        const catalog: ResourceCatalog = {
          mode: 'existing-pool-local-simulation',
          nodes: [
            {
              id: 'pool',
              tenant: 'a',
              available: true,
              cpuCores: 1,
              memoryMb: 128,
              costMicrosPerHour: 3600000,
              capabilities: [],
            },
          ],
          tenants: [
            {
              id: 'a',
              maxCpuCores: 1,
              maxMemoryMb: 128,
              budgetMicros: 1000000,
            },
          ],
          policy: {
            maxCpuCores: 1,
            maxMemoryMb: 128,
            maxLeaseCostMicros: 100000,
            totalBudgetMicros: 1000000,
            maxDurationMs: 60000,
            cooldownMs: 0,
            planTtlMs: 60000,
          },
          approvers: [{ id: 'ops', publicKey: keys.publicKey, tenants: ['a'] }],
        }
        const controller = new ElasticController(':memory:', catalog)
        const socket = join(tmpdir(), `qe-negative-${randomUUID()}.sock`)
        let acknowledgements = 0
        const server = Bun.serve({
          unix: socket,
          fetch(request) {
            if (new URL(request.url).pathname === '/release') {
              acknowledgements++
              if (mode === 'closed')
                setTimeout(() => {
                  void server.stop(true)
                }, 25)
              return Response.json({ released: 'first' })
            }
            if (mode === 'timeout') return new Promise<Response>(() => {})
            if (mode === 'malformed') return new Response('{')
            if (mode === 'wrong-identity')
              return Response.json({ id: 'wrong', pid: process.pid })
            return new Response('unavailable', { status: Number(mode) || 503 })
          },
        })
        const receipt: WorkerReceipt = {
          id: 'first',
          kind: 'local-pool-worker',
          socket,
          token: 'negative-fixture',
          pid: process.pid,
          startedAt: Date.now(),
          expiresAt: Date.now() + 60000,
        }
        const request = {
          tenant: 'a',
          cpuCores: 1,
          memoryMb: 128,
          durationMs: 30000,
          capabilities: [],
        }
        const adapter = { ...localPoolAdapter(), allocate: async () => receipt }
        try {
          for (const id of ['first', 'second']) {
            const op = controller.plan({ ...request, id })
            controller.approve(
              id,
              'a',
              op.planHash,
              'ops',
              signBytes(keys, approvalPayload(op)),
            )
          }
          expect((await controller.apply('first', 'a', adapter)).state).toBe(
            'active',
          )
          expect((await controller.release('first', 'a', adapter)).state).toBe(
            'unknown',
          )
          expect(acknowledgements).toBe(1)
          expect(() => process.kill(receipt.pid, 0)).not.toThrow()
          const status = fetch('http://localhost/status', {
            unix: socket,
            signal: AbortSignal.timeout(200),
          })
          if (mode === 'closed' || mode === 'timeout')
            await expect(status).rejects.toThrow()
          else {
            const response = await status
            if (mode === 'malformed')
              await expect(response.json()).rejects.toThrow()
            else if (mode === 'wrong-identity')
              expect(((await response.json()) as { id: string }).id).toBe(
                'wrong',
              )
            else expect(response.status).toBe(Number(mode))
          }
          await expect(
            controller.apply('second', 'a', adapter),
          ).rejects.toThrow('capacity')
          await expect(
            controller.release('first', 'a', adapter),
          ).rejects.toThrow('uncertain')
          expect(acknowledgements).toBe(1)
        } finally {
          await server.stop(true)
          controller.close()
        }
      },
    ),
  )
}, 10000)
