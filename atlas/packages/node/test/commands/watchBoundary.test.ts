// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  generateNodeKeyPair,
  StaticPublicKeyDirectory,
} from '@qianmo/capability'
import { readTrail } from '@qianmo/audit'
import { createMessage, createTaskResult, MessageType } from '@qianmo/protocol'
import { assertJob } from '@qianmo/scheduler'
import {
  startTransportServer,
  PSK_ENV_VAR,
  ReceiptStatus,
} from '@qianmo/transport'
import { WatchBoundary } from '../../src/commands/watchBoundary.js'
import {
  createWatchDispatch,
  parseWatchArgs,
} from '../../src/commands/watch.js'
import { FileTenantStore } from '../../src/commands/consoleTenancy.js'
import { loadOrCreateNodeKeys } from '../../src/host/nodeIdentity.js'
import { auditTrailPath } from '../../src/host/auditTrail.js'
import { createNotifyPort } from '../../src/commands/consolePorts.js'
import { AlertAcksStore } from '../../src/commands/consoleAlertAcks.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'watch-boundary-'))
  const config = {
    version: 1,
    hubServer: 'hub-server',
    tenants: [{ id: 'a' }, { id: 'b' }],
    subjects: [],
    platformSubjects: [],
    nodes: [
      {
        nodeId: 'worker-a',
        tenant: 'a',
        server: 'server-a',
        memoryRoot: join(root, 'a'),
      },
      {
        nodeId: 'worker-b',
        tenant: 'b',
        server: 'server-b',
        memoryRoot: join(root, 'b'),
      },
    ],
    jobs: [
      { jobId: 'a-job', nodeId: 'worker-a', tenant: 'a' },
      { jobId: 'b-job', nodeId: 'worker-b', tenant: 'b' },
    ],
  }
  const path = join(root, 'tenancy.json')
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
  const store = new FileTenantStore(path)
  const jobs = ['a', 'b'].map(id =>
    assertJob({
      id: `${id}-job`,
      title: 'Test watch',
      target: `qianmo://worker-${id}/main`,
      prompt: 'watch',
      schedule: { everyMs: 600000 },
      taskTtlMs: 30000,
      notifyPolicy: 'agent-initiated',
    }),
  )
  return { root, path, store, config, jobs }
}
function notice(from = 'qianmo://worker-a/main', contextId = 'a-job') {
  return createMessage({
    from,
    to: 'qianmo://watch-hub/console',
    type: MessageType.Notify,
    contextId,
    payload: {
      kind: 'watch',
      severity: 'warn',
      summary: 'legitimate',
      observedAt: Date.now(),
    },
    hops: [from.includes('worker-b') ? 'worker-b' : 'worker-a'],
  })
}

test('M2 watch requires private mapping, signing, and explicit target trust', () => {
  const args = [
    '--jobs',
    'jobs.json',
    '--from',
    'qianmo://watch-hub/console',
    '--tenancy',
    '/tmp/tenancy.json',
  ]
  expect(() => parseWatchArgs(args)).toThrow('--sign')
  const key = generateNodeKeyPair().publicKey
  expect(
    parseWatchArgs([...args, '--sign', '--trust', `worker-a=${key}`]),
  ).toMatchObject({
    tenancyPath: '/tmp/tenancy.json',
    trusted: [['worker-a', key]],
  })
})

test('router then signed connection and fresh tenant/job boundaries refuse forged notifications', () => {
  const f = fixture()
  const boundary = new WatchBoundary(
    'qianmo://watch-hub/console',
    f.jobs,
    f.store,
  )
  expect(boundary.inbound(notice(), 'worker-a', 'worker-a')).toBe(true)
  expect(boundary.inbound(notice(), 'worker-a', null)).toBe(false)
  expect(boundary.inbound(notice(), 'worker-a', 'worker-b')).toBe(false)
  expect(
    boundary.inbound(
      notice('qianmo://worker-b/main', 'b-job'),
      'worker-a',
      'worker-a',
    ),
  ).toBe(false)
  expect(
    boundary.inbound(
      notice('qianmo://worker-a/main', 'b-job'),
      'worker-a',
      'worker-a',
    ),
  ).toBe(false)
  expect(
    boundary.inbound(
      { ...notice(), to: 'qianmo://other/console' },
      'worker-a',
      'worker-a',
    ),
  ).toBe(false)
  const duplicate = notice()
  expect(boundary.inbound(duplicate, 'worker-a', 'worker-a')).toBe(true)
  expect(boundary.inbound(duplicate, 'worker-a', 'worker-a')).toBe(false)
  f.store.replace({ ...f.config, jobs: f.config.jobs.slice(1) })
  expect(boundary.inbound(notice(), 'worker-a', 'worker-a')).toBe(false)
})

test('unmapped tenant job causes zero dial; revocation while dialing causes zero send', async () => {
  const f = fixture()
  const boundary = new WatchBoundary(
    'qianmo://watch-hub/console',
    f.jobs,
    f.store,
  )
  let dials = 0
  let sends = 0
  const dispatch = createWatchDispatch({
    from: 'qianmo://watch-hub/console',
    hubNode: 'watch-hub',
    urls: new Map([['a-job', 'ws://127.0.0.1:1']]),
    boundary,
    warn: () => {},
    trail: { append: input => ({ ...input, seq: 1, prev: '' }) },
    linkTo: async () => {
      dials++
      f.store.replace({ ...f.config, jobs: f.config.jobs.slice(1) })
      return {
        sendAndWait: async () => {
          sends++
          return ReceiptStatus.Accepted
        },
      }
    },
  })
  const fire = {
    job: f.jobs[0]!,
    fireAtMs: Date.now(),
    dedupKey: 'a-job:0',
    attempt: 1,
  }
  await expect(dispatch(fire)).rejects.toThrow('permission changed')
  expect(dials).toBe(1)
  expect(sends).toBe(0)
  expect(await dispatch(fire)).toBe('skipped')
  expect(dials).toBe(1)
})

test('actual qm watch signed socket records only matching notifications and projects connectionNode', async () => {
  const f = fixture()
  const previousConfig = process.env.QIANMO_CONFIG_DIR
  process.env.QIANMO_CONFIG_DIR = join(f.root, 'config')
  const hub = loadOrCreateNodeKeys('watch-hub')
  const peer = generateNodeKeyPair()
  const psk = 'watch-boundary-test-only-psk-00000000'
  let dispatched = 0
  const server = startTransportServer({
    hostname: '127.0.0.1',
    port: 0,
    psk,
    supportedTypes: Object.values(MessageType),
    signing: {
      node: 'worker-a',
      keys: peer,
      directory: new StaticPublicKeyDirectory([['watch-hub', hub.publicKey]]),
      required: true,
    },
    onMessage(message, context) {
      if (message.type !== MessageType.TaskRequest) return
      dispatched++
      expect(message.cap).toBeDefined()
      expect(message.hops).toEqual(['watch-hub'])
      context.channel.send(notice())
      context.channel.send({
        ...notice('qianmo://worker-b/main', 'b-job'),
        payload: {
          kind: 'watch',
          severity: 'error',
          summary: 'FORGED-CROSS-TENANT',
          observedAt: Date.now(),
        },
      })
      context.channel.send({
        ...notice(),
        to: 'qianmo://other/console',
        payload: {
          kind: 'watch',
          severity: 'error',
          summary: 'FORGED-RECIPIENT',
          observedAt: Date.now(),
        },
      })
      context.channel.send(
        createTaskResult(message, message.to, {
          outcome: 'completed',
          content: 'verified watch completed',
        }),
      )
    },
  })
  const command = process.env.QIANMO_TEST_COMPILED_QM
    ? [process.env.QIANMO_TEST_COMPILED_QM]
    : [process.execPath, resolve('atlas/packages/node/src/cli.ts')]
  const jobs = join(f.root, 'jobs.json')
  writeFileSync(jobs, JSON.stringify([{ ...f.jobs[0], url: server.url }]))
  try {
    const child = Bun.spawn(
      [
        ...command,
        'watch',
        '--once',
        '--jobs',
        jobs,
        '--from',
        'qianmo://watch-hub/console',
        '--state-dir',
        join(f.root, 'state'),
        '--sign',
        '--tenancy',
        f.path,
        '--trust',
        `worker-a=${peer.publicKey}`,
      ],
      {
        cwd: resolve('.'),
        env: { ...process.env, [PSK_ENV_VAR]: psk },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, err }).toEqual({ code: 0, err: '' })
    expect(dispatched).toBe(1)
    expect(out).toContain('[notify]')
    expect(out).toContain('legitimate')
    expect(out).not.toContain('FORGED')
    const notices = readTrail(auditTrailPath()).records.filter(
      r => r.kind === 'watch_notify_received',
    )
    expect(notices).toHaveLength(1)
    expect(notices[0]?.detail?.connectionNode).toBe('worker-a')
    const port = createNotifyPort({
      trailPath: auditTrailPath(),
      acks: new AlertAcksStore(join(f.root, 'acks.ndjson')),
    })
    const feed = await port.notices(10)
    expect(feed.ok).toBe(true)
    if (feed.ok) expect(feed.value.notices[0]?.node).toBe('worker-a')
    f.store.replace({
      ...f.config,
      jobs: [
        { jobId: 'a-job', nodeId: 'worker-b', tenant: 'b' },
        f.config.jobs[1],
      ],
    })
    const denied = Bun.spawn(
      [
        ...command,
        'watch',
        '--once',
        '--jobs',
        jobs,
        '--from',
        'qianmo://watch-hub/console',
        '--state-dir',
        join(f.root, 'denied-state'),
        '--sign',
        '--tenancy',
        f.path,
        '--trust',
        `worker-a=${peer.publicKey}`,
      ],
      {
        cwd: resolve('.'),
        env: { ...process.env, [PSK_ENV_VAR]: psk },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [deniedCode, deniedOut, deniedErr] = await Promise.all([
      denied.exited,
      new Response(denied.stdout).text(),
      new Response(denied.stderr).text(),
    ])
    expect(deniedCode).toBe(0)
    expect(dispatched).toBe(1)
    expect(deniedOut).not.toContain('[notify]')
    expect(deniedErr).toContain('tenant/job target denied')
    f.store.replace(f.config)
    const policy = join(f.root, 'quota.json')
    writeFileSync(
      policy,
      JSON.stringify({
        mode: 'enforce',
        person: {},
        job: { wakes: 1 },
        global: {},
      }),
    )
    const capped = Bun.spawn(
      [
        ...command,
        'watch',
        '--once',
        '--jobs',
        jobs,
        '--from',
        'qianmo://watch-hub/console',
        '--state-dir',
        join(f.root, 'quota-state'),
        '--sign',
        '--tenancy',
        f.path,
        '--trust',
        `worker-a=${peer.publicKey}`,
        '--usage-policy',
        policy,
      ],
      {
        env: { ...process.env, [PSK_ENV_VAR]: psk },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [cappedCode, cappedOut, cappedErr] = await Promise.all([
      capped.exited,
      new Response(capped.stdout).text(),
      new Response(capped.stderr).text(),
    ])
    expect(cappedCode).toBe(0)
    expect(cappedErr).toContain('usage refused: quota')
    expect(cappedOut).not.toContain('[notify]')
    expect(dispatched).toBe(1)
    const status = Bun.spawn([...command, 'watch', '--usage-status'], {
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [statusCode, statusOut, statusErr] = await Promise.all([
      status.exited,
      new Response(status.stdout).text(),
      new Response(status.stderr).text(),
    ])
    expect({ statusCode, statusErr }).toEqual({ statusCode: 0, statusErr: '' })
    const snapshot = JSON.parse(statusOut)
    expect(snapshot.lowerBound).toBe(true)
    expect(
      snapshot.rows.find(
        (row: { bucket: string }) => row.bucket === 'job:a-job',
      ),
    ).toMatchObject({ wakes: 1, inFlight: 0, charged: 0 })
    expect(
      snapshot.rows.find(
        (row: { bucket: string }) => row.bucket === 'tenant:a',
      ),
    ).toMatchObject({ wakes: 1, inFlight: 0 })
  } finally {
    await server.stop()
    if (previousConfig === undefined) delete process.env.QIANMO_CONFIG_DIR
    else process.env.QIANMO_CONFIG_DIR = previousConfig
  }
}, 15_000)
