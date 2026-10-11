// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  createMessage,
  MessageType,
  type QianmoMessage,
} from '@qianmo/protocol'
import { NodeRouter } from '@qianmo/router'
import {
  ReceiptStatus,
  type SuccessfulReceiptStatus,
  type TransportChannel,
} from '@qianmo/transport'
import { ControlRegistry, HubCallClient } from '../../src/host/control.js'
import { residentToolSurface } from '../../src/host/notifyTool.js'
import { residentToolVerdict } from '@qianmo/extension/policy'

class HubChannel implements TransportChannel {
  readonly id = crypto.randomUUID()
  readonly pending = 0
  readonly peerSupportedTypes = undefined
  readonly sent: QianmoMessage[] = []
  ready = true
  supported = true
  constructor(readonly peerNode: string) {}
  get authenticatedPeerNode() {
    return this.peerNode
  }
  supports(): boolean {
    return this.supported
  }
  isReady(): boolean {
    return this.ready
  }
  isClosed(): boolean {
    return !this.ready
  }
  send(message: QianmoMessage): void {
    this.sent.push(message)
  }
  async sendAndWait(message: QianmoMessage): Promise<SuccessfulReceiptStatus> {
    this.send(message)
    return ReceiptStatus.Accepted
  }
  async waitForDrain(): Promise<void> {}
  hold(): () => void {
    return () => {}
  }
}

function client() {
  return new HubCallClient({
    from: 'qianmo://worker/console',
    router: new NodeRouter({ node: 'worker' }),
  })
}

function reply(request: QianmoMessage, value: unknown) {
  const payload = request.payload as { callId: string }
  return createMessage({
    from: request.to,
    to: request.from,
    taskId: request.taskId,
    type: MessageType.HubCallResult,
    payload: { callId: payload.callId, ok: true, value },
  })
}

describe('ControlRegistry', () => {
  test('dispatches prefix with caller context; duplicate and malformed ownership are rejected', async () => {
    const registry = new ControlRegistry()
    registry.register('files', async (op, args, ctx) => ({
      ok: true,
      value: {
        path: `${ctx.peer}/${ctx.actor}/${ctx.taskId}/${op}/${args['path']}`,
      },
    }))
    expect(
      await registry.handle(
        'files.read',
        { path: 'a' },
        { peer: 'hub', actor: 'u:a', taskId: 't' },
      ),
    ).toEqual({ ok: true, value: { path: 'hub/u:a/t/files.read/a' } })
    expect(
      await registry.handle(
        'memory.list',
        {},
        { peer: 'hub', actor: 'a', taskId: 't' },
      ),
    ).toMatchObject({ ok: false, code: 'unsupported' })
    expect(() =>
      registry.register('files', async () => ({ ok: true, value: null })),
    ).toThrow('duplicate')
    expect(() =>
      registry.register('bad.prefix', async () => ({ ok: true, value: null })),
    ).toThrow('invalid')
  })

  test('thrown handlers and non-JSON returns produce internal without exception content', async () => {
    const errors: unknown[] = []
    const registry = new ControlRegistry({
      onError: error => errors.push(error),
    })
    registry.register('broken', async op => {
      if (op === 'broken.throw') throw new Error('secret exception and stack')
      return { ok: true, value: undefined }
    })
    for (const op of ['broken.throw', 'broken.json'])
      expect(
        await registry.handle(op, {}, { peer: 'hub', actor: 'a', taskId: 't' }),
      ).toEqual({ ok: false, code: 'internal', message: '控制处理器执行失败' })
    expect(errors).toHaveLength(2)
  })
})

describe('HubCallClient', () => {
  test('no subscribed hub returns immediately without dialing or queuing', async () => {
    const hub = client()
    expect(await hub.call('files.request', {})).toEqual({
      ok: false,
      code: 'hub-unavailable',
      message: '中枢未连接',
    })
    hub.close()
  })

  test('latest subscription wins; matching requires same channel, callId, taskId and addresses', async () => {
    const hub = client(),
      first = new HubChannel('hub-a'),
      latest = new HubChannel('hub-b')
    hub.subscribe('hub-a', 'qianmo://hub-a/operator', first)
    hub.subscribe('hub-b', 'qianmo://hub-b/operator', latest)
    try {
      const pending = hub.call(
        'files.request',
        { file: 'a' },
        { agent: 'main' },
      )
      const request = latest.sent[0]!
      expect(first.sent).toHaveLength(0)
      expect(request.from).toBe('qianmo://worker/main')
      hub.receive(reply(request, 'wrong channel'), first)
      hub.receive(
        { ...reply(request, 'wrong task'), taskId: 'another' },
        latest,
      )
      hub.receive(
        { ...reply(request, 'wrong address'), from: 'qianmo://hub-b/other' },
        latest,
      )
      hub.receive(reply(request, 'right'), latest)
      expect(await pending).toEqual({ ok: true, value: 'right' })
      latest.ready = false
      hub.disconnected()
      const fallback = hub.call('files.request', {})
      hub.receive(reply(first.sent[0]!, 'fallback'), first)
      expect(await fallback).toEqual({ ok: true, value: 'fallback' })
    } finally {
      hub.close()
    }
  })

  test('grant callbacks use the originating hub and never fall back to another issuer', async () => {
    const hub = client(),
      first = new HubChannel('hub-a'),
      latest = new HubChannel('hub-b')
    hub.subscribe('hub-a', 'qianmo://hub-a/operator', first)
    hub.subscribe('hub-b', 'qianmo://hub-b/operator', latest)
    try {
      const pending = hub.call(
        'files.validate',
        {},
        { agent: 'main', peer: 'hub-a' },
      )
      const request = first.sent[0]!
      expect(latest.sent).toHaveLength(0)
      hub.receive(reply(request, 'wrong issuer'), latest)
      hub.receive(reply(request, { grantedBy: 'u:owner' }), first)
      expect(await pending).toEqual({
        ok: true,
        value: { grantedBy: 'u:owner' },
      })
      first.ready = false
      hub.disconnected()
      expect(
        await hub.call('files.validate', {}, { peer: 'hub-a' }),
      ).toMatchObject({ ok: false, code: 'hub-unavailable' })
      expect(latest.sent).toHaveLength(0)
    } finally {
      hub.close()
    }
  })

  test('subscription replacement and disconnect settle outstanding callers immediately', async () => {
    const hub = client(),
      old = new HubChannel('hub'),
      current = new HubChannel('hub')
    hub.subscribe('hub', 'qianmo://hub/console', old)
    const replaced = hub.call('connector.read', {})
    hub.subscribe('hub', 'qianmo://hub/console', current)
    expect(await replaced).toMatchObject({ ok: false, code: 'hub-unavailable' })
    const disconnected = hub.call('connector.read', {})
    current.ready = false
    hub.disconnected()
    expect(await disconnected).toMatchObject({
      ok: false,
      code: 'hub-unavailable',
    })
    expect(await hub.call('connector.read', {})).toMatchObject({
      ok: false,
      code: 'hub-unavailable',
    })
    hub.close()
  })

  test('timeout retires its waiter, so a late result cannot resolve a later call', async () => {
    const hub = client(),
      channel = new HubChannel('hub')
    hub.subscribe('hub', 'qianmo://hub/console', channel)
    try {
      expect(
        await hub.call('connector.read', {}, { timeoutMs: 10 }),
      ).toMatchObject({ ok: false, code: 'timeout' })
      const second = hub.call('connector.read', {})
      hub.receive(reply(channel.sent[0]!, 'late'), channel)
      hub.receive(reply(channel.sent[1]!, 'new'), channel)
      expect(await second).toEqual({ ok: true, value: 'new' })
      channel.supported = false
      expect(await hub.call('connector.read', {})).toMatchObject({
        ok: false,
        code: 'unsupported',
      })
      expect(channel.sent).toHaveLength(2)
    } finally {
      hub.close()
    }
  })
})

test('extra host tools reserve builtin names and reject duplicate feature tools', () => {
  const tool = {
    name: 'qianmo_example',
    description: 'Example',
    parameters: { type: 'object' },
    handler: async () => ({ ok: true, text: 'example' }),
  }
  expect(() => residentToolSurface(false, [tool, tool])).toThrow('duplicate')
  expect(() =>
    residentToolSurface(false, [{ ...tool, name: 'qianmo_memory_write' }]),
  ).toThrow('duplicate')
})

test('appended host tools run only for the main agent under the existing resident policy', () => {
  const config = {
    v: 1 as const,
    agent: 'main',
    workspace: '/workspace',
    edits: 'none' as const,
    protectedRoots: [],
    hostTools: ['qianmo_example'],
  }
  const call = { toolName: 'qianmo_example', input: {} }
  expect(
    residentToolVerdict(call, config, { agentKind: 'main' }),
  ).toBeUndefined()
  expect(residentToolVerdict(call, config, { agentKind: 'sub' })).toMatchObject(
    { block: true },
  )
})
