// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The runtime ops on a resident's control link (P36): reading works under
 * ESTOP, changes go through the idempotency ledger and are refused under it,
 * and the node tells peers it answers them (`runtimeCatalog`).
 */

import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { qianmoConfigPath } from '@qianmo/paths'
import {
  CONTROL_MESSAGE_TYPES,
  LEGACY_MESSAGE_TYPES,
  ProtocolErrorCode,
} from '@qianmo/protocol'
import { TransportClient } from '@qianmo/transport'
import type { ControlContext } from '../../src/host/control.js'
import { QianmoResident } from '../../src/host/resident.js'
import { NodeRuntimes } from '../../src/host/runtimeConfig.js'
import { RuntimeInstaller } from '../../src/host/runtimeUpdate.js'
import {
  RUNTIME_CATALOG_CAPABILITY,
  type RuntimeStatusReply,
} from '../../src/host/runtimes/contract.js'
import { isolatedRoot } from '../providers/fake.js'

const PSK = 'runtime-ops-fixture-psk-000000000'
let root: ReturnType<typeof isolatedRoot> | undefined
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  root?.dispose()
  root = undefined
})

function resident() {
  root = isolatedRoot()
  const cwd = join(root.root, 'workspace')
  mkdirSync(cwd)
  const runtimes = new NodeRuntimes({
    agents: [{ agent: 'main' }],
    installer: new RuntimeInstaller({
      which: () => null,
      run: async () => ({ code: 0, stdout: 'v24.1.0' }),
    }),
    credential: () => {
      throw new Error('no profile')
    },
    launchable: () => true,
  })
  let url: string | undefined
  const node = new QianmoResident({
    node: 'worker',
    team: 'nest',
    agents: [{ agent: 'main', cwd }],
    psk: PSK,
    listen: { hostname: '127.0.0.1', port: 0 },
    runtimes,
    onReady: address => {
      url = address.url
    },
  })
  return { node, runtimes, url: () => url }
}

test('runtime.status and runtime.versions read under ESTOP; configure, install and remove are ledgered and refused under it', async () => {
  const { node, runtimes } = resident()
  cleanups.push(() => node.control.close())
  const ctx = (operationId?: string): ControlContext => ({
    peer: 'hub',
    actor: 'ops',
    taskId: 't',
    ...(operationId === undefined ? {} : { operationId }),
  })
  const status = await node.control.handle('runtime.status', {}, ctx())
  expect(status).toMatchObject({
    ok: true,
    value: {
      defaultRuntime: 'dsh',
      agents: [
        {
          agent: 'main',
          effective: { runtime: 'omp' },
          reason: { code: 'not-installed' },
        },
      ],
    },
  })
  const recycled: string[] = []
  runtimes.onChange(agent => recycled.push(agent))
  const operationId = randomUUID()
  const first = await node.control.handle(
    'runtime.configure',
    { agent: 'main', runtime: 'qianmopi' },
    ctx(operationId),
  )
  expect(first).toMatchObject({
    ok: true,
    value: { configured: { runtime: 'omp', source: 'config' } },
  })
  // The same operation again answers from the ledger; nothing runs twice.
  expect(
    await node.control.handle(
      'runtime.configure',
      { agent: 'main', runtime: 'qianmopi' },
      ctx(operationId),
    ),
  ).toEqual(first)
  expect(recycled).toEqual(['main'])

  const estop = qianmoConfigPath('resident', 'ESTOP')
  writeFileSync(estop, '')
  cleanups.push(() => rmSync(estop, { force: true }))
  const reading = await node.control.handle('runtime.status', {}, ctx())
  expect(reading.ok).toBe(true)
  expect(
    (reading as { value: RuntimeStatusReply }).value.agents[0]!.configured,
  ).toMatchObject({ runtime: 'omp' })
  expect((await node.control.handle('runtime.versions', {}, ctx())).ok).toBe(
    true,
  )
  for (const op of [
    'runtime.configure',
    'runtime.install',
    'runtime.update',
    'runtime.remove',
  ])
    expect(
      await node.control.handle(
        op,
        { agent: 'main', runtime: 'dsh' },
        ctx(randomUUID()),
      ),
    ).toMatchObject({ ok: false, code: ProtocolErrorCode.E_BUSY })
})

test('native extension ops ride the runtime prefix: listing reads under ESTOP, changes are refused under it; the roster is written (P36.7)', async () => {
  const { node } = resident()
  cleanups.push(() => node.control.close())
  const ctx: ControlContext = { peer: 'hub', actor: 'ops', taskId: 't' }
  // The secret-free roster `qm runtime open` reads.
  const roster = JSON.parse(
    readFileSync(qianmoConfigPath('resident', 'runtime-agents.json'), 'utf8'),
  )
  expect(roster).toMatchObject({
    v: 1,
    pid: process.pid,
    agents: [{ agent: 'main', runtime: 'dsh', shell: false, model: null }],
  })
  const estop = qianmoConfigPath('resident', 'ESTOP')
  writeFileSync(estop, '')
  cleanups.push(() => rmSync(estop, { force: true }))
  // Answered by the native operations (an unknown agent), not the ESTOP gate.
  expect(
    await node.control.handle('runtime.ext.list', { agent: 'nobody' }, ctx),
  ).toMatchObject({ ok: false, code: 'invalid' })
  for (const op of ['runtime.ext.install', 'runtime.ext.remove'])
    expect(
      await node.control.handle(
        op,
        { agent: 'main', kind: 'mcp', name: 'own' },
        { ...ctx, operationId: randomUUID() },
      ),
    ).toMatchObject({ ok: false, code: ProtocolErrorCode.E_BUSY })
})

test('the node advertises runtimeCatalog to the peers it talks to', async () => {
  const { node, url } = resident()
  const running = node.run()
  cleanups.push(async () => {
    node.stop()
    await running
  })
  const deadline = Date.now() + 10_000
  while (url() === undefined && Date.now() < deadline) await Bun.sleep(10)
  const client = new TransportClient({
    endpoint: { url: url()! },
    node: 'hub',
    peerNode: 'worker',
    psk: PSK,
    supportedTypes: [...LEGACY_MESSAGE_TYPES, ...CONTROL_MESSAGE_TYPES],
    onMessage: () => {},
  })
  cleanups.push(() => client.close())
  await client.connect(5_000)
  expect(client.peerSupportedTypes).toContain(RUNTIME_CATALOG_CAPABILITY)
})
