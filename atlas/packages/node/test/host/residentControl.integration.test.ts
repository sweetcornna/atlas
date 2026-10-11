// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AuditSource, AuditTrail } from '@qianmo/audit'
import {
  generateNodeKeyPair,
  StaticPublicKeyDirectory,
} from '@qianmo/capability'
import {
  CONTROL_MESSAGE_TYPES,
  LEGACY_MESSAGE_TYPES,
  createMessage,
  MessageType,
  ProtocolErrorCode,
  type QianmoMessage,
} from '@qianmo/protocol'
import { TransportClient } from '@qianmo/transport'
import { readMailbox } from '@qianmo/mailbox'
import { ControlLinks } from '../../src/commands/consoleControl.js'
import { QianmoResident } from '../../src/host/resident.js'
import { ResidentOmpHarness } from '../../../../tests/integration/fixtures/resident-omp-harness.js'

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20_000
  while (!(await predicate())) {
    if (Date.now() > deadline)
      throw new Error('control integration condition timed out')
    await Bun.sleep(10)
  }
}

test('signed hub and real resident complete control, upstream and appended omp tools; unauthorized identities and disconnects refuse', async () => {
  const previous = process.env.QIANMO_CONFIG_DIR
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-control-e2e-'))
  process.env.QIANMO_CONFIG_DIR = path.join(root, 'config')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace)
  const harness = new ResidentOmpHarness()
  harness.script([
    { name: 'qianmo_example', input: { query: 'from omp' } },
    { name: 'qianmo_refuse', input: {} },
    { name: 'qianmo_throw', input: {} },
  ])
  const hubKeys = generateNodeKeyPair(),
    nodeKeys = generateNodeKeyPair(),
    outsiderKeys = generateNodeKeyPair()
  const directory = new StaticPublicKeyDirectory([
    ['hub', hubKeys.publicKey],
    ['worker', nodeKeys.publicKey],
    ['outsider', outsiderKeys.publicKey],
  ])
  const errors: unknown[] = [],
    received: QianmoMessage[] = []
  const trailPath = path.join(root, 'control-audit.ndjson')
  const trail = new AuditTrail(trailPath)
  let url: string | undefined
  let runtimeReady = false
  const resident = new QianmoResident({
    node: 'worker',
    team: 'nest',
    agents: [{ agent: 'main', cwd: workspace }],
    psk: 'control-e2e-fixture-psk-00000000',
    listen: { hostname: '127.0.0.1', port: 0 },
    pollIntervalMs: 20,
    handshakeSigning: {
      node: 'worker',
      keys: nodeKeys,
      directory,
      required: true,
    },
    controllers: new Set(['hub']),
    controlAudit: event => trail.append(event),
    onReady: address => {
      url = address.url
    },
    onTiming: event => {
      if (event.stage === 'runtime_ready') runtimeReady = true
    },
    onError: error => errors.push(error),
    extraHostTools: [
      {
        name: 'qianmo_example',
        description: 'Search the hub fixture',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
        handler: async (input, ctx) => {
          const outcome = await resident.hubCall.call(
            'connector.search',
            input as Record<string, unknown>,
            { agent: ctx.agent },
          )
          return {
            ok: outcome.ok,
            text: outcome.ok ? JSON.stringify(outcome.value) : outcome.message,
          }
        },
      },
      {
        name: 'qianmo_refuse',
        description: 'Refuse a fixture operation',
        parameters: { type: 'object' },
        handler: async () => ({
          ok: false,
          text: 'fixture permission refused',
        }),
      },
      {
        name: 'qianmo_throw',
        description: 'Exercise host exception handling',
        parameters: { type: 'object' },
        handler: async () => {
          throw new Error('fixture host exception')
        },
      },
    ],
  })
  resident.control.register('test', async (op, args, ctx) => {
    if (op === 'test.throw')
      throw new Error('private handler stack must stay local')
    if (op === 'test.slow') await Bun.sleep(60)
    return {
      ok: true,
      value: {
        sum: Number(args['a']) + Number(args['b']),
        actor: ctx.actor,
        peer: ctx.peer,
        taskId: ctx.taskId,
      },
    }
  })
  const running = resident.run()
  const clients: TransportClient[] = []
  let hub: ControlLinks | undefined
  try {
    await until(() => url !== undefined)
    const target = {
      node: 'worker',
      url: url!,
      publicKey: nodeKeys.publicKey,
      psk: 'control-e2e-fixture-psk-00000000',
    }
    hub = new ControlLinks({
      from: 'qianmo://hub/operator',
      commandKeys: hubKeys,
      targets: [target],
      onError: error => errors.push(error),
    })
    const calls: { node: string; agent?: string; callId: string }[] = []
    hub.onHubCall('connector', async (op, args, ctx) => {
      calls.push(ctx)
      if (op === 'connector.throw') throw new Error('private hub stack')
      if (op === 'connector.slow') await Bun.sleep(100)
      return {
        ok: true,
        value: `${ctx.node}/${ctx.agent ?? 'host'}/${args['query']}`,
      }
    })
    expect(await hub.request('worker', 'node.ping', {}, 'admin')).toMatchObject(
      { ok: false, code: 'unreachable' },
    )
    hub.start()
    await until(() => hub!.status()[0]?.connected === true)
    expect(hub.status()[0]).toMatchObject({
      node: 'worker',
      connected: true,
      lastError: null,
    })
    const ping = await hub.request('worker', 'node.ping', {}, 'u:alice')
    expect(ping).toMatchObject({
      ok: true,
      value: {
        node: 'worker',
        agents: ['main'],
        platform: process.platform,
        version: '3.0.0-dev',
      },
    })
    if (ping.ok) expect((ping.value as { now: number }).now).toBeGreaterThan(0)
    const control = await hub.request(
      'worker',
      'test.add',
      { a: 2, b: 3, secret: 'must-not-be-audited' },
      'u:alice',
    )
    expect(control).toMatchObject({
      ok: true,
      value: { sum: 5, actor: 'u:alice', peer: 'hub' },
    })
    expect(
      await hub.request('worker', 'memory.list', {}, 'admin'),
    ).toMatchObject({ ok: false, code: 'unsupported' })
    expect(
      await hub.request('worker', 'test.throw', {}, 'admin'),
    ).toMatchObject({ ok: false, code: 'internal' })
    expect(
      await hub.request('worker', 'test.slow', {}, 'admin', { timeoutMs: 10 }),
    ).toMatchObject({ ok: false, code: 'timeout' })
    expect(
      await resident.hubCall.call(
        'connector.search',
        { query: 'hello', node: 'spoofed' },
        { agent: 'main' },
      ),
    ).toEqual({ ok: true, value: 'worker/main/hello' })
    expect(calls[0]).toMatchObject({
      node: 'worker',
      agent: 'main',
      callId: expect.any(String),
    })
    expect(await resident.hubCall.call('files.request', {})).toMatchObject({
      ok: false,
      code: 'unsupported',
    })
    expect(await resident.hubCall.call('connector.throw', {})).toMatchObject({
      ok: false,
      code: 'internal',
    })
    expect(
      await resident.hubCall.call('connector.slow', {}, { timeoutMs: 10 }),
    ).toMatchObject({ ok: false, code: 'timeout' })

    // Listener readiness is intentionally earlier than model-runtime readiness.
    // Control works during that gap; the host-tool turn waits for the real child.
    await until(() => runtimeReady)
    const raw = new TransportClient({
      endpoint: { url: url! },
      node: 'hub',
      peerNode: 'worker',
      psk: target.psk,
      supportedTypes: [...LEGACY_MESSAGE_TYPES, ...CONTROL_MESSAGE_TYPES],
      signing: { keys: hubKeys, directory, required: true },
      onMessage: message => {
        received.push(message)
      },
    })
    clients.push(raw)
    await raw.connect(5_000)
    const task = createMessage({
      from: 'qianmo://hub/operator',
      to: 'qianmo://worker/main',
      type: MessageType.TaskRequest,
      payload: { text: 'Exercise the fixture host tools.' },
    })
    await raw.sendAndWait(task, 10_000)
    await until(() =>
      received.some(
        message =>
          message.type === MessageType.TaskResult &&
          message.taskId === task.taskId,
      ),
    )
    expect(harness.offeredTools.has('qianmo_example')).toBe(true)
    expect(
      harness.toolResults.some(result =>
        result.includes('worker/main/from omp'),
      ),
    ).toBe(true)
    expect(
      harness.toolResults.some(result =>
        result.includes('fixture permission refused'),
      ),
    ).toBe(true)
    expect(
      harness.toolResults.some(result =>
        result.includes('Resident host could not complete this tool'),
      ),
    ).toBe(true)

    for (const type of [MessageType.NodeControlResult, MessageType.HubCall]) {
      const wrongDirection = createMessage({
        from: 'qianmo://hub/operator',
        to: 'qianmo://worker/main',
        type,
        payload:
          type === MessageType.NodeControlResult
            ? { ok: true, value: 'wrong-direction-no-mailbox' }
            : {
                callId: crypto.randomUUID(),
                op: 'connector.read',
                args: { marker: 'wrong-direction-no-mailbox' },
              },
      })
      await raw.sendAndWait(wrongDirection, 5_000)
      expect(
        received.find(message => message.taskId === wrongDirection.taskId)
          ?.payload,
      ).toMatchObject({ code: ProtocolErrorCode.E_BAD_TYPE })
    }
    expect(JSON.stringify(readMailbox('nest', 'main'))).not.toContain(
      'wrong-direction-no-mailbox',
    )

    const outsider = new TransportClient({
      endpoint: { url: url! },
      node: 'outsider',
      peerNode: 'worker',
      psk: target.psk,
      supportedTypes: [...LEGACY_MESSAGE_TYPES, ...CONTROL_MESSAGE_TYPES],
      signing: { keys: outsiderKeys, directory, required: true },
      onMessage: message => {
        received.push(message)
      },
    })
    clients.push(outsider)
    await outsider.connect(5_000)
    const denied = createMessage({
      from: 'qianmo://outsider/operator',
      to: 'qianmo://worker/console',
      type: MessageType.NodeControl,
      payload: {
        op: 'node.ping',
        args: { secret: 'must-not-be-audited' },
        actor: 'forged',
      },
    })
    await outsider.sendAndWait(denied, 5_000)
    await until(() =>
      received.some(
        message =>
          message.taskId === denied.taskId &&
          message.type === MessageType.Error,
      ),
    )
    expect(
      received.find(message => message.taskId === denied.taskId)?.payload,
    ).toMatchObject({ code: ProtocolErrorCode.E_CAP_INSUFFICIENT })
    const subscription = createMessage({
      from: denied.from,
      to: denied.to,
      type: MessageType.HubSubscribe,
      payload: { subscribe: true },
    })
    await expect(outsider.sendAndWait(subscription, 5_000)).rejects.toThrow()

    const wrongKey = new TransportClient({
      endpoint: { url: url! },
      node: 'hub',
      peerNode: 'worker',
      psk: target.psk,
      signing: { keys: generateNodeKeyPair(), directory, required: true },
    })
    clients.push(wrongKey)
    await expect(wrongKey.connect(1_000)).rejects.toThrow()
    const wrongNode = new ControlLinks({
      from: 'qianmo://hub/operator',
      commandKeys: hubKeys,
      targets: [{ ...target, publicKey: outsiderKeys.publicKey }],
    })
    wrongNode.start()
    try {
      await until(() => wrongNode.status()[0]?.lastError !== null)
      expect(wrongNode.status()[0]?.connected).toBe(false)
      expect(
        await wrongNode.request('worker', 'node.ping', {}, 'admin'),
      ).toMatchObject({ ok: false, code: 'unreachable' })
    } finally {
      await wrongNode.close()
    }

    const rows = fs
      .readFileSync(trailPath, 'utf8')
      .trim()
      .split('\n')
      .map(
        line =>
          JSON.parse(line) as {
            source: string
            kind: string
            outcome: string
            detail: unknown
            taskId: string
          },
      )
    expect(rows.every(row => row.source === AuditSource.Control)).toBe(true)
    const deniedRow = rows.find(row => row.taskId === denied.taskId)
    expect(deniedRow).toMatchObject({
      kind: 'control.node.ping',
      outcome: 'refused',
      detail: { actor: 'forged' },
    })
    if (control.ok)
      expect(
        rows.find(
          row => row.taskId === (control.value as { taskId: string }).taskId,
        ),
      ).toMatchObject({
        kind: 'control.test.add',
        outcome: 'ok',
        detail: { actor: 'u:alice' },
      })
    expect(fs.readFileSync(trailPath, 'utf8')).not.toContain(
      'must-not-be-audited',
    )
    expect(
      rows.every(row => !JSON.stringify(row.detail).includes('args')),
    ).toBe(true)
    expect(
      errors.some(
        error =>
          error instanceof Error &&
          error.message.includes('private handler stack'),
      ),
    ).toBe(true)
    const outstanding = resident.hubCall.call('connector.slow', {})
    await hub.close()
    expect(await outstanding).toMatchObject({
      ok: false,
      code: 'hub-unavailable',
    })
    expect(
      await resident.hubCall.call('connector.search', {
        query: 'after disconnect',
      }),
    ).toEqual({ ok: false, code: 'hub-unavailable', message: '中枢未连接' })
  } catch (error) {
    throw new Error(
      `control fixture failed; host errors: ${errors.map(error => (error instanceof Error ? error.message : String(error))).join(' | ')}; protocol errors: ${received
        .filter(message => message.type === MessageType.Error)
        .map(message => JSON.stringify(message.payload))
        .join(' | ')}`,
      { cause: error },
    )
  } finally {
    await hub?.close()
    await Promise.all(clients.map(client => client.close()))
    resident.stop()
    await running
    await harness.stop()
    if (previous === undefined) delete process.env.QIANMO_CONFIG_DIR
    else process.env.QIANMO_CONFIG_DIR = previous
  }
}, 90_000)
