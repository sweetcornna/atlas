// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { createMessage, LIMITS, MessageType } from '@qianmo/protocol'
import { A2aOutbound, A2aTaskStore } from '../src/index.js'
const message = () =>
  createMessage({
    from: 'qianmo://dev/requester',
    to: 'qianmo://bridge/remote',
    type: MessageType.TaskRequest,
    payload: { prompt: 'implement API' },
  })
test('HTTP peer runs async task, maps ids, returns result and deduplicates across new client instances', async () => {
  let sends = 0
  let polls = 0
  let observed: Record<string, unknown> = {}
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      expect(request.headers.get('authorization')).toBe('Bearer peer-token')
      expect(request.headers.get('a2a-version')).toBe('1.0')
      if (request.method === 'POST') {
        sends++
        observed = (await request.json()) as Record<string, unknown>
        return Response.json({
          task: { id: 'external-123', status: { state: 'TASK_STATE_WORKING' } },
        })
      }
      polls++
      return Response.json({
        id: 'external-123',
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{ parts: [{ text: 'implemented and tested' }] }],
      })
    },
  })
  const store = new A2aTaskStore(':memory:')
  const config = {
    store,
    node: 'bridge',
    identity: 'gateway',
    peers: [
      {
        id: 'peer',
        url: server.url.toString(),
        addresses: ['127.0.0.1'],
        allowLoopbackHttp: true,
        token: 'peer-token',
      },
    ],
    audit: () => {},
    pollMs: 1,
  }
  try {
    const client = new A2aOutbound(config)
    const request = message()
    const reply = await client.send('peer', request)
    expect(reply.payload).toMatchObject({
      outcome: 'completed',
      content: 'implemented and tested',
    })
    expect(reply.taskId).toBe(request.taskId)
    expect(sends).toBe(1)
    expect(polls).toBe(1)
    expect(JSON.stringify(observed)).toContain('qianmoBoundary')
    expect(JSON.stringify(observed)).not.toContain('"taskId":')
    const second = await new A2aOutbound(config).send('peer', request)
    expect(second.payload).toMatchObject({ outcome: 'completed' })
    expect(sends).toBe(1)
    expect(() => client.send('missing', message())).toThrow('not allowed')
    expect(() =>
      client.send('peer', {
        ...message(),
        hops: Array.from({ length: LIMITS.maxHops }, () => 'prior'),
      }),
    ).toThrow()
  } finally {
    await server.stop(true)
    store.close()
  }
})
test('refuses unapproved endpoint/IP and never follows redirects', async () => {
  const store = new A2aTaskStore(':memory:')
  const base = { store, node: 'bridge', identity: 'gateway', audit: () => {} }
  for (const peer of [
    {
      id: 'bad',
      url: 'http://169.254.169.254',
      addresses: ['169.254.169.254'],
      token: 'x',
    },
    { id: 'bad', url: 'https://127.0.0.1', addresses: ['1.1.1.1'], token: 'x' },
    {
      id: 'bad',
      url: 'https://user:secret@example.com',
      addresses: ['1.1.1.1'],
      token: 'x',
    },
  ])
    expect(() => new A2aOutbound({ ...base, peers: [peer] })).toThrow()
  let forbidden = 0
  const target = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      forbidden++
      return new Response('secret')
    },
  })
  const redirect = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      return Response.redirect(target.url.toString(), 302)
    },
  })
  try {
    const client = new A2aOutbound({
      ...base,
      peers: [
        {
          id: 'redirect',
          url: redirect.url.toString(),
          addresses: ['127.0.0.1'],
          allowLoopbackHttp: true,
          token: 'secret',
        },
      ],
    })
    expect((await client.send('redirect', message())).payload).toMatchObject({
      outcome: 'failed',
    })
    expect(forbidden).toBe(0)
  } finally {
    await redirect.stop(true)
    await target.stop(true)
    store.close()
  }
})

test('DNS pinning blocks unapproved resolution and unsupported asynchronous states fail explicitly', async () => {
  const store = new A2aTaskStore(':memory:')
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      Response.json({
        task: { id: 'waiting', status: { state: 'TASK_STATE_INPUT_REQUIRED' } },
      }),
  })
  try {
    const options = {
      store,
      node: 'bridge',
      identity: 'gateway',
      audit: () => {},
    }
    const dns = new A2aOutbound({
      ...options,
      peers: [
        {
          id: 'dns',
          url: 'https://localhost:9',
          addresses: ['192.0.2.1'],
          token: 'never-transmitted',
        },
      ],
    })
    expect((await dns.send('dns', message())).payload).toMatchObject({
      outcome: 'failed',
    })
    const pending = new A2aOutbound({
      ...options,
      peers: [
        {
          id: 'waiting',
          url: server.url.toString(),
          addresses: ['127.0.0.1'],
          allowLoopbackHttp: true,
          token: 'test',
        },
      ],
    })
    expect((await pending.send('waiting', message())).payload).toMatchObject({
      outcome: 'failed',
    })
  } finally {
    await server.stop(true)
    store.close()
  }
})

test('oversized responses fail and a peer cannot swap task identity while being polled', async () => {
  const store = new A2aTaskStore(':memory:')
  let large = true
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      large
        ? new Response('x'.repeat(300000))
        : Response.json(
            request.method === 'POST'
              ? {
                  task: {
                    id: 'first',
                    status: { state: 'TASK_STATE_WORKING' },
                  },
                }
              : {
                  id: 'different',
                  status: { state: 'TASK_STATE_COMPLETED' },
                  artifacts: [{ parts: [{ text: 'wrong task' }] }],
                },
          ),
  })
  try {
    const client = new A2aOutbound({
      store,
      node: 'bridge',
      identity: 'gateway',
      pollMs: 1,
      audit: () => {},
      peers: [
        {
          id: 'peer',
          url: server.url.toString(),
          addresses: ['127.0.0.1'],
          allowLoopbackHttp: true,
          token: 'test',
        },
      ],
    })
    expect((await client.send('peer', message())).payload).toMatchObject({
      outcome: 'failed',
    })
    large = false
    expect((await client.send('peer', message())).payload).toMatchObject({
      outcome: 'failed',
    })
  } finally {
    await server.stop(true)
    store.close()
  }
})
