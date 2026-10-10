// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TenantConfig, TenantPort } from '@qianmo/console'
import { residentTenantGate } from '../../src/host/residentTenancy.js'

test('node gate accepts only authenticated same-tenant peer or explicitly trusted hub, rereading changes', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qm-node-tenant-')))
  let config: TenantConfig = {
    version: 1,
    hubServer: 'hub-server',
    tenants: [{ id: 'a' }, { id: 'b' }],
    subjects: [],
    platformSubjects: [],
    jobs: [],
    nodes: [
      { nodeId: 'own', tenant: 'a', server: 'a-server', memoryRoot: root },
      {
        nodeId: 'peer',
        tenant: 'a',
        server: 'a-server',
        memoryRoot: `${root}-peer`,
      },
      {
        nodeId: 'other',
        tenant: 'b',
        server: 'b-server',
        memoryRoot: `${root}-other`,
      },
    ],
  }
  let broken = false
  const store: TenantPort = {
    read() {
      if (broken) throw new Error('damaged')
      return { revision: 'r1', config }
    },
    subscribe: () => () => {},
  }
  const gate = residentTenantGate(store, 'own', new Set(['hub']), root)
  expect(gate(null)).toBe(false)
  expect(gate('hub')).toBe(true)
  expect(gate('peer')).toBe(true)
  expect(gate('other')).toBe(false)
  expect(gate('unknown')).toBe(false)
  config = {
    ...config,
    nodes: config.nodes.map(node =>
      node.nodeId === 'peer' ? { ...node, tenant: 'b' } : node,
    ),
  }
  expect(gate('peer')).toBe(false)
  broken = true
  expect(gate('hub')).toBe(false)
})
