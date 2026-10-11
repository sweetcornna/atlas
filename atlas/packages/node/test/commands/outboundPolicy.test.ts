// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import {
  OutboundPolicy,
  publicAddress,
  boundedText,
} from '../../src/commands/outboundPolicy.js'
import { pushNotifyChannel } from '../../src/commands/consoleNotifyChannels.js'
import { CERT, KEY } from '../connectors/fixtures.js'

const notice = {
  title: 'Fixture',
  body: 'Body',
  at: 1,
  qianmo: { scheduleId: 's', runId: 'r', outcome: 'completed' as const },
}
test('outbound default rejects private, metadata, multicast, reserved, mapped IPv6 and nonstandard ports before fetch', async () => {
  let calls = 0
  const policy = new OutboundPolicy({
    fetch: async () => {
      calls++
      return new Response()
    },
    lookup: async () => [{ address: '169.254.169.254', family: 4 }],
  })
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.169.254',
    '100.100.100.200',
    '224.0.0.1',
    '198.18.0.1',
    '192.0.2.1',
    '0.0.0.0',
    '255.255.255.255',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    '2002:7f00:1::1',
  ]) {
    expect(publicAddress(address)).toBe(false)
    await expect(policy.resolve('https', address, 443)).rejects.toThrow()
  }
  expect(publicAddress('8.8.8.8')).toBe(true)
  expect(publicAddress('2606:4700:4700::1111')).toBe(true)
  await expect(
    policy.request('https://metadata.example/secret-token'),
  ).rejects.toThrow('策略拒绝')
  expect(() => policy.url('https://example.com:8443/token')).toThrow('端口')
  expect(() => policy.url('ftp://example.com/token')).toThrow()
  expect(() => policy.url('https://account:password@example.com')).toThrow()
  await expect(
    new OutboundPolicy({
      lookup: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    }).resolve('https', 'mixed.example', 443),
  ).rejects.toThrow()
  expect(calls).toBe(0)
  const refused = await pushNotifyChannel(
    'webhook',
    'https://127.0.0.1/private-secret',
    notice,
    {
      fetch: async () => {
        calls++
        return new Response()
      },
      delay: async () => {},
    },
  )
  expect(refused.ok).toBe(false)
  expect(calls).toBe(0)
  expect(JSON.stringify(refused)).not.toContain('private-secret')
})
test('HTTPS dial uses exactly the resolved address with verified fixture CA', async () => {
  let lookups = 0,
    requests = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { key: KEY, cert: CERT },
    fetch() {
      requests++
      return new Response('ok')
    },
  })
  const policy = new OutboundPolicy({
    ca: CERT,
    allowAddresses: ['127.0.0.1'],
    allowPorts: [{ protocol: 'https', port: server.port! }],
    lookup: async () => {
      lookups++
      return [
        { address: lookups === 1 ? '127.0.0.1' : '169.254.169.254', family: 4 },
      ]
    },
  })
  try {
    expect(
      await boundedText(
        await policy.request(`https://localhost:${server.port}/fixture`),
      ),
    ).toBe('ok')
    expect(lookups).toBe(1)
    expect(requests).toBe(1)
  } finally {
    server.stop(true)
  }
})
test('redirects check every hop, strip cross-origin credentials, refuse cross-origin writes and cap bodies', async () => {
  const seen: { url: string; headers: Headers }[] = []
  const policy = new OutboundPolicy({
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetch: async (url, init) => {
      seen.push({ url, headers: new Headers(init.headers) })
      return seen.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://second.example/result' },
          })
        : new Response('ok')
    },
  })
  expect(
    await boundedText(
      await policy.request('https://first.example/private-token', {
        headers: { authorization: 'Basic hidden', cookie: 'hidden-cookie' },
      }),
    ),
  ).toBe('ok')
  expect(seen[1]?.headers.has('authorization')).toBe(false)
  expect(seen[1]?.headers.has('cookie')).toBe(false)
  expect(seen[1]?.url).not.toContain('private-token')
  let calls = 0
  const redirect = (location: string) =>
    new OutboundPolicy({
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      fetch: async () => {
        calls++
        return new Response(null, { status: 307, headers: { location } })
      },
    })
  await expect(
    redirect('https://127.0.0.1/secret').request('https://public.example'),
  ).rejects.toThrow('策略拒绝')
  expect(calls).toBe(1)
  await expect(
    redirect('https://different.example').request('https://public.example', {
      method: 'PUT',
      body: 'private-content',
      headers: { authorization: 'hidden' },
    }),
  ).rejects.toThrow('跨源')
  expect(calls).toBe(2)
  await expect(
    boundedText(new Response(new Uint8Array(2 * 1024 * 1024 + 1))),
  ).rejects.toThrow('上限')
})

test('authorization withdrawn during DNS resolution refuses dispatch before any HTTP bytes', async () => {
  let allowed = true,
    calls = 0
  const policy = new OutboundPolicy({
    lookup: async () => {
      allowed = false
      return [{ address: '8.8.8.8', family: 4 }]
    },
    fetch: async () => {
      calls++
      return new Response()
    },
  })
  await expect(
    policy.request(
      'https://example.com/event',
      { method: 'PUT', body: 'private' },
      true,
      () => {
        if (!allowed) throw new Error('permission revoked')
      },
    ),
  ).rejects.toThrow('permission revoked')
  expect(calls).toBe(0)
})

test('HTTPS redirects cannot downgrade through an HTTP notification exception; oversized request lines and headers never dispatch', async () => {
  let calls = 0,
    lookups = 0
  const policy = new OutboundPolicy({
    allowPorts: [{ protocol: 'http', port: 80 }],
    lookup: async () => {
      lookups++
      return [{ address: '8.8.8.8', family: 4 }]
    },
    fetch: async () => {
      calls++
      return new Response(null, {
        status: 302,
        headers: { location: 'http://second.example/private-token' },
      })
    },
  })
  await expect(policy.request('https://first.example')).rejects.toThrow('降级')
  expect(calls).toBe(1)
  lookups = 0
  await expect(
    policy.request(`https://first.example/${'x'.repeat(8192)}`),
  ).rejects.toThrow('请求行')
  await expect(
    policy.request('https://first.example', {
      headers: { Authorization: 'x'.repeat(8192) },
    }),
  ).rejects.toThrow('请求头')
  expect(calls).toBe(1)
  expect(lookups).toBe(0)
})
