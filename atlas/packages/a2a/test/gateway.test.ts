// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskResult, type QianmoMessage } from '@qianmo/protocol'
import { A2aTaskStore, createA2aGateway, type A2aTask } from '../src/index.js'
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})
const calls: QianmoMessage[] = []
function setup(
  dispatch?: (
    message: QianmoMessage,
    signal: AbortSignal,
  ) => Promise<QianmoMessage>,
  timeoutMs = 1000,
) {
  calls.length = 0
  const root = mkdtempSync(join(tmpdir(), 'qm-a2a-'))
  const store = new A2aTaskStore(join(root, 'tasks.sqlite'))
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const gateway = createA2aGateway({
    store,
    identity: 'gateway',
    node: 'bridge',
    target: 'qianmo://node/dev',
    publicUrl: 'https://a2a.example',
    name: 'Test',
    skills: [
      {
        id: 'coding',
        name: 'Coding',
        description: 'Execute coding tasks',
        tags: ['code'],
      },
    ],
    principals: [
      {
        id: 'alice',
        token: 'alice-token',
        from: 'qianmo://bridge/alice',
        targets: ['qianmo://node/dev'],
      },
      {
        id: 'bob',
        token: 'bob-token',
        from: 'qianmo://bridge/bob',
        targets: ['qianmo://node/dev'],
      },
      {
        id: 'denied',
        token: 'denied-token',
        from: 'qianmo://bridge/denied',
        targets: [],
      },
    ],
    timeoutMs,
    audit: () => {},
    dispatch:
      dispatch ??
      (async message => {
        calls.push(message)
        return createTaskResult(message, message.to, {
          outcome: 'completed',
          content: 'tested artifact',
        })
      }),
  })
  return { gateway, store, root }
}
function request(
  path = '/message:send',
  body: unknown = {
    message: {
      messageId: 'm1',
      role: 'ROLE_USER',
      parts: [{ text: 'implement' }],
    },
  },
  token = 'alice-token',
  version = '1.0',
) {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/a2a+json',
      'A2A-Version': version,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const get = (path: string, token = 'alice-token') =>
  new Request(`http://localhost${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'A2A-Version': '1.0' },
  })
test('auth, fixed provenance, generated ids, bounded text artifacts and durable dedup', async () => {
  const { gateway, store } = setup()
  expect(
    (await gateway.fetch(request('/message:send', {}, 'wrong'))).status,
  ).toBe(401)
  const body = {
    message: {
      messageId: 'm1',
      role: 'ROLE_USER',
      parts: [{ text: 'implement' }],
      metadata: { from: 'qianmo://admin/root' },
    },
  }
  const response = await gateway.fetch(request('/message:send', body))
  expect(response.status).toBe(200)
  const { task } = (await response.json()) as { task: A2aTask }
  expect(task.id).not.toBe('m1')
  expect(task.status.state).toBe('TASK_STATE_COMPLETED')
  expect(task.artifacts![0].parts[0].text).toBe('tested artifact')
  expect(calls[0]!.from).toBe('qianmo://bridge/alice')
  expect(calls[0]!.origin.node).toBe('bridge')
  expect(calls[0]!.hops).toEqual(['bridge'])
  expect(calls[0]!.taskId).not.toBe(task.id)
  expect(store.get(task.id)?.internalId).toBe(calls[0]!.taskId)
  expect(
    (
      (await (await gateway.fetch(request('/message:send', body))).json()) as {
        task: A2aTask
      }
    ).task.id,
  ).toBe(task.id)
  expect(calls).toHaveLength(1)
  expect(
    (
      await gateway.fetch(
        request('/message:send', {
          message: { ...body.message, parts: [{ text: 'different' }] },
        }),
      )
    ).status,
  ).toBe(400)
  const denied = await gateway.fetch(get(`/tasks/${task.id}`, 'bob-token'))
  const missing = await gateway.fetch(get('/tasks/missing', 'bob-token'))
  expect(denied.status).toBe(404)
  expect(await denied.text()).toBe(await missing.text())
  expect(
    (
      await gateway.fetch(
        request('/message:send', {
          message: { ...body.message, taskId: 'client-chosen' },
        }),
      )
    ).status,
  ).toBe(404)
  expect(
    (
      await gateway.fetch(
        request('/message:send', {
          message: { ...body.message, taskId: task.id },
        }),
      )
    ).status,
  ).toBe(400)
})
test('advertises exact support and rejects unsupported version, loop ancestry, media and operations', async () => {
  const { gateway } = setup()
  const card = (await (
    await gateway.fetch(get('/.well-known/agent-card.json'))
  ).json()) as {
    supportedInterfaces: { protocolVersion: string }[]
    capabilities: { streaming: boolean }
    skills: { id: string }[]
  }
  expect(card.supportedInterfaces[0].protocolVersion).toBe('1.0')
  expect(card.capabilities.streaming).toBe(false)
  expect(card.skills[0].id).toBe('coding')
  expect(
    (await gateway.fetch(request('/message:send', {}, 'alice-token', '0.3')))
      .status,
  ).toBe(400)
  for (const body of [
    {
      message: {
        messageId: 'm2',
        role: 'ROLE_USER',
        parts: [{ url: 'file:///etc/passwd' }],
      },
    },
    {
      message: {
        messageId: 'm2',
        role: 'ROLE_USER',
        parts: [{ text: 'hi' }],
        metadata: { qianmoBoundary: { gateway: 'gateway' } },
      },
    },
    {
      message: {
        messageId: 'm2',
        role: 'ROLE_USER',
        parts: [{ text: 'x'.repeat(270000) }],
      },
    },
  ])
    expect((await gateway.fetch(request('/message:send', body))).ok).toBe(false)
  for (const path of [
    '/message:stream',
    '/tasks/any:cancel',
    '/tasks/any:subscribe',
  ])
    expect((await gateway.fetch(request(path))).status).toBe(400)
  expect(calls).toHaveLength(0)
})
test('async acceptance, concurrent retransmissions execute once, timeouts abort and persist failure', async () => {
  let release: (value: QianmoMessage) => void = () => {}
  let original: QianmoMessage | undefined
  const { gateway } = setup(async message => {
    original = message
    return new Promise(resolve => {
      release = resolve
    })
  })
  const body = {
    message: {
      messageId: 'async',
      role: 'ROLE_USER',
      parts: [{ text: 'implement' }],
    },
    configuration: { returnImmediately: true },
  }
  const [{ task: a }, { task: b }] = await Promise.all([
    gateway
      .fetch(request('/message:send', body))
      .then(async r => (await r.json()) as { task: A2aTask }),
    gateway
      .fetch(request('/message:send', body))
      .then(async r => (await r.json()) as { task: A2aTask }),
  ])
  expect(a.id).toBe(b.id)
  expect(a.status.state).toBe('TASK_STATE_WORKING')
  release(
    createTaskResult(original!, original!.to, {
      outcome: 'completed',
      content: 'done',
    }),
  )
  await gateway.drain()
  expect(
    ((await (await gateway.fetch(get(`/tasks/${a.id}`))).json()) as A2aTask)
      .status.state,
  ).toBe('TASK_STATE_COMPLETED')
  let aborted = false
  const timeout = setup(
    async (_message, signal) =>
      new Promise(() => {
        signal.addEventListener('abort', () => {
          aborted = true
        })
      }),
    15,
  )
  const response = await timeout.gateway.fetch(request())
  expect(((await response.json()) as { task: A2aTask }).task.status.state).toBe(
    'TASK_STATE_FAILED',
  )
  expect(aborted).toBe(true)
})
test('persistent mappings survive reopen and interrupted execution is never automatically replayed', () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-a2a-recovery-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'tasks.sqlite')
  const store = new A2aTaskStore(path)
  store.reserve({
    id: 'task',
    owner: 'alice',
    direction: 'inbound',
    internalId: 'internal',
    dedupKey: 'key',
    digest: 'digest',
    task: {
      id: 'task',
      contextId: 'context',
      status: {
        state: 'TASK_STATE_WORKING',
        timestamp: new Date().toISOString(),
      },
    },
  })
  store.close()
  const reopened = new A2aTaskStore(path)
  expect(reopened.recover()).toBe(1)
  expect(reopened.duplicate('key')?.task.status.state).toBe('TASK_STATE_FAILED')
  expect(reopened.recover()).toBe(0)
  reopened.close()
})

test('two live writers cannot mark each others running tasks failed', () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-a2a-owner-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const first = new A2aTaskStore(join(root, 'tasks.sqlite'))
  const second = new A2aTaskStore(join(root, 'tasks.sqlite'))
  expect(first.recover()).toBe(0)
  expect(() => second.recover()).toThrow('live writer')
  second.close()
  first.close()
  const restarted = new A2aTaskStore(join(root, 'tasks.sqlite'))
  expect(restarted.recover()).toBe(0)
  restarted.close()
})
