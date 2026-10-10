// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  statSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTenantStore } from '../../src/commands/consoleTenancy.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qm-tenant-')),
    path = join(root, 'tenants.json')
  const config = {
    version: 1,
    hubServer: 'hub',
    tenants: [{ id: 'a' }, { id: 'b' }],
    subjects: [],
    nodes: [
      {
        nodeId: 'na',
        tenant: 'a',
        server: 'sa',
        memoryRoot: join(root, 'memory-a'),
      },
      {
        nodeId: 'nb',
        tenant: 'b',
        server: 'sb',
        memoryRoot: join(root, 'memory-b'),
      },
    ],
    jobs: [],
    platformSubjects: [],
  }
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
  return { root, path, config }
}
test('atomic tenant snapshots survive restart; malformed policy closes listeners and never disables tenancy', () => {
  const { path, config } = fixture(),
    store = new FileTenantStore(path)
  let closed = 0
  const release = store.subscribe(() => {
    closed++
  })
  store.replace({
    ...config,
    tenants: [{ id: 'a', label: 'First' }, { id: 'b' }],
  })
  expect(closed).toBe(1)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(new FileTenantStore(path).read().config.tenants[0]?.label).toBe(
    'First',
  )
  writeFileSync(path, '{broken')
  expect(() => store.read()).toThrow()
  expect(closed).toBe(2)
  expect(() => new FileTenantStore(path)).toThrow()
  release()
})
test('canonical deepest ancestor prevents uncreated symlink subtree overlap', () => {
  const { root, path, config } = fixture()
  mkdirSync(join(root, 'actual'))
  symlinkSync(join(root, 'actual'), join(root, 'alias'))
  writeFileSync(
    path,
    JSON.stringify({
      ...config,
      nodes: [
        { ...config.nodes[0], memoryRoot: join(root, 'actual') },
        { ...config.nodes[1], memoryRoot: join(root, 'alias', 'not-created') },
      ],
    }),
  )
  expect(() => new FileTenantStore(path)).toThrow('重叠')
  writeFileSync(
    path,
    JSON.stringify({
      ...config,
      nodes: [
        { ...config.nodes[0], memoryRoot: join(root, 'actual') },
        config.nodes[1],
      ],
    }),
  )
  expect(new FileTenantStore(path).read().config.nodes).toHaveLength(2)
})

test('tenant policy refuses broad permissions and non-regular paths before serving any snapshot', () => {
  const { path } = fixture()
  chmodSync(path, 0o644)
  if (process.platform !== 'win32')
    expect(() => new FileTenantStore(path)).toThrow('0600')
  chmodSync(path, 0o600)
  expect(new FileTenantStore(path).read().config.version).toBe(1)
})
