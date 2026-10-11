// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import type { NotifyChannelKind } from '@qianmo/console'
import {
  notifyChannelUrl,
  pushNotifyChannel as realPushNotifyChannel,
  type ChannelPushOptions,
  type ScheduleNotification,
} from '../../src/commands/consoleNotifyChannels.js'

import { OutboundPolicy } from '../../src/commands/outboundPolicy.js'

// Explicit fixture exceptions replace the former implicit loopback production exemption.
function pushNotifyChannel(
  kind: NotifyChannelKind,
  url: string,
  notice: ScheduleNotification,
  options: ChannelPushOptions = {},
) {
  let port = 443
  try {
    const parsed = new URL(url)
    port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
  } catch {}
  const policy = new OutboundPolicy({
    allowAddresses: ['127.0.0.1', '::1'],
    allowPorts: [{ protocol: 'http', port }],
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
  })
  return realPushNotifyChannel(kind, url, notice, { ...options, policy })
}

const servers: { stop(closeActiveConnections?: boolean): void }[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})
const notice: ScheduleNotification = {
  title: '晨间简报',
  body: '今天的三件事',
  at: 1234,
  qianmo: { scheduleId: 'schedule-1', runId: 'run-1', outcome: 'completed' },
}

describe('notification wire formats (loopback fixtures only)', () => {
  for (const kind of ['webhook', 'bark', 'wecom', 'feishu', 'ntfy'] as const) {
    test(`${kind}: POST headers and body reach the configured path`, async () => {
      const requests: {
        method: string
        pathname: string
        secret: string | null
        contentType: string | null
        title: string | null
        body: string
      }[] = []
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          requests.push({
            method: request.method,
            pathname: url.pathname,
            secret: url.searchParams.get('key'),
            contentType: request.headers.get('content-type'),
            title: request.headers.get('title'),
            body: await request.text(),
          })
          return Response.json(
            kind === 'bark'
              ? { code: 200 }
              : kind === 'wecom'
                ? { errcode: 0 }
                : { code: 0 },
          )
        },
      })
      servers.push(server)
      const result = await pushNotifyChannel(
        kind,
        `http://127.0.0.1:${server.port}/private-key?key=secret`,
        notice,
      )
      expect(result).toEqual({ ok: true, error: null, attempts: 1 })
      expect(requests).toHaveLength(1)
      const request = requests[0]!
      expect(request.method).toBe('POST')
      expect(request.pathname).toBe('/private-key')
      expect(request.secret).toBe('secret')
      if (kind === 'ntfy') {
        expect(request.contentType).toBe('text/plain; charset=utf-8')
        expect(request.body).toBe(notice.body)
        const encoded = request.title!.match(/^=\?UTF-8\?B\?(.+)\?=$/)!
        expect(Buffer.from(encoded[1]!, 'base64').toString('utf8')).toBe(
          notice.title,
        )
      } else {
        expect(request.contentType).toBe('application/json; charset=utf-8')
        expect(JSON.parse(request.body)).toEqual(
          kind === 'webhook'
            ? notice
            : kind === 'bark'
              ? { title: notice.title, body: notice.body }
              : kind === 'wecom'
                ? {
                    msgtype: 'text',
                    text: { content: `${notice.title}\n${notice.body}` },
                  }
                : {
                    msg_type: 'text',
                    content: { text: `${notice.title}\n${notice.body}` },
                  },
        )
      }
    })
  }

  test('rejects non-HTTPS remote URLs and embedded credentials before fetch', async () => {
    let calls = 0
    for (const url of [
      'http://example.com/secret',
      'ftp://localhost/secret',
      'https://user:password@example.com/path',
      'https://example.com/#secret',
      'bad',
    ]) {
      expect(() => notifyChannelUrl(url)).toThrow()
      const result = await pushNotifyChannel('webhook', url, notice, {
        fetch: async () => {
          calls++
          return new Response()
        },
      })
      expect(result.attempts).toBe(0)
      expect(result.ok).toBe(false)
    }
    expect(calls).toBe(0)
    for (const url of [
      'https://example.com/secret',
      'http://localhost/path',
      'http://127.0.0.2/path',
      'http://[::1]/path',
    ])
      expect(notifyChannelUrl(url).protocol).toBe(
        url.startsWith('https') ? 'https:' : 'http:',
      )
  })

  test('retries three times with the specified delays; never includes exception or response secrets', async () => {
    const delays: number[] = []
    let attempts = 0
    const result = await pushNotifyChannel(
      'webhook',
      'https://example.com/private-key',
      notice,
      {
        delay: async ms => {
          delays.push(ms)
        },
        fetch: async () => {
          attempts++
          if (attempts === 1) throw new Error('https://example.com/private-key')
          return new Response('https://example.com/private-key', {
            status: 500,
          })
        },
      },
    )
    expect(attempts).toBe(4)
    expect(delays).toEqual([2000, 8000, 30000])
    expect(result).toEqual({ ok: false, error: 'HTTP 500', attempts: 4 })
    expect(JSON.stringify(result)).not.toContain('private-key')
  })

  test('stops retrying at the first success and handles provider-level errors inside HTTP 200', async () => {
    for (const [kind, field, success] of [
      ['wecom', 'errcode', 0],
      ['feishu', 'code', 0],
      ['bark', 'code', 200],
    ] as const) {
      let attempts = 0
      const delays: number[] = []
      const result = await pushNotifyChannel(
        kind,
        'https://example.com/private-key',
        notice,
        {
          delay: async ms => {
            delays.push(ms)
          },
          fetch: async () =>
            Response.json({ [field]: ++attempts === 1 ? 400 : success }),
        },
      )
      expect(result).toEqual({ ok: true, error: null, attempts: 2 })
      expect(delays).toEqual([2000])
    }
  })

  test('does not follow redirects to a secret or a remote HTTP target', async () => {
    let destinationCalls = 0
    const destination = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        destinationCalls++
        return new Response('ok')
      },
    })
    const redirect = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Response(null, {
          status: 302,
          headers: {
            Location: `http://127.0.0.1:${destination.port}/private-key`,
          },
        })
      },
    })
    servers.push(destination, redirect)
    const result = await pushNotifyChannel(
      'webhook',
      `http://127.0.0.1:${redirect.port}`,
      notice,
      { delay: async () => {} },
    )
    expect(result).toEqual({ ok: false, error: 'HTTP 302', attempts: 4 })
    expect(destinationCalls).toBe(0)
  })

  test('reads at most the first 4 KiB and cancels the response stream', async () => {
    let reads = 0
    let cancelled = false
    const result = await pushNotifyChannel(
      'webhook',
      'https://example.com/private-key',
      notice,
      {
        fetch: async () =>
          new Response(
            new ReadableStream(
              {
                pull(controller) {
                  reads++
                  controller.enqueue(new Uint8Array(4096))
                },
                cancel() {
                  cancelled = true
                },
              },
              { highWaterMark: 0 },
            ),
          ),
      },
    )
    expect(result.ok).toBe(true)
    expect(reads).toBe(1)
    expect(cancelled).toBe(true)
  })

  test('timeout covers stalled response bodies and all attempts receive a 10-second signal', async () => {
    let attempts = 0
    const result = await pushNotifyChannel(
      'ntfy',
      'https://example.com/private-key',
      notice,
      {
        timeoutMs: 1,
        delay: async () => {},
        fetch: async (_url, init) => {
          attempts++
          return new Response(
            new ReadableStream({
              start(controller) {
                init.signal!.addEventListener(
                  'abort',
                  () => controller.error(new Error('secret')),
                  { once: true },
                )
              },
            }),
          )
        },
      },
    )
    expect(result).toEqual({ ok: false, error: '渠道请求超时', attempts: 4 })
    expect(attempts).toBe(4)
  })

  test('malformed provider replies fail instead of falsely reporting a delivered push', async () => {
    const result = await pushNotifyChannel(
      'feishu' as NotifyChannelKind,
      'https://example.com/private-key',
      notice,
      {
        delay: async () => {},
        fetch: async () => new Response('private-key'),
      },
    )
    expect(result).toEqual({
      ok: false,
      error: '渠道响应格式无效',
      attempts: 4,
    })
  })
})
