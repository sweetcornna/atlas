// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  notifyAllowlist,
  notifyDestination,
} from '../../src/commands/consoleNotifyDestination.js'
import {
  pushNotifyChannel,
  type ScheduleNotification,
} from '../../src/commands/consoleNotifyChannels.js'

const roots: string[] = []
const servers: { stop(closeActiveConnections?: boolean): void }[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
const notice: ScheduleNotification = {
  title: 'test',
  body: 'fixture',
  at: 1,
  qianmo: { scheduleId: 's-test', runId: 'r-test', outcome: 'completed' },
}

describe('notification destination policy', () => {
  for (const [name, address] of [
    ['10/8', '10.0.0.1'],
    ['172.16/12', '172.31.255.1'],
    ['192.168/16', '192.168.1.1'],
    ['loopback', '127.0.0.1'],
    ['link local', '169.254.42.1'],
    ['CGNAT', '100.64.0.1'],
    ['zero network', '0.1.2.3'],
    ['multicast', '224.0.0.1'],
    ['broadcast', '255.255.255.255'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unspecified', '::'],
    ['IPv6 ULA', 'fd12::1'],
    ['IPv6 ULA lower bound', 'fc00::1'],
    ['IPv6 link local', 'febf::1'],
    ['IPv6 multicast', 'ff02::1'],
    ['mapped private', '::ffff:192.168.1.1'],
    ['compatible private', '::10.0.0.1'],
  ]) {
    test(`${name} is refused before any POST and does not echo a URL secret`, async () => {
      let calls = 0
      const literal = address!.includes(':') ? `[${address}]` : address
      const result = await pushNotifyChannel(
        'webhook',
        `https://${literal}/private-key`,
        notice,
        {
          fetch: async () => {
            calls++
            return new Response()
          },
        },
      )
      expect(result).toMatchObject({
        ok: false,
        attempts: 0,
        error: '目的地址在受保护网段，需运维放行',
      })
      expect(calls).toBe(0)
      expect(JSON.stringify(result)).not.toContain('private-key')
    })
  }

  test('one private answer among public DNS answers denies the entire hostname', async () => {
    let calls = 0
    const result = await pushNotifyChannel(
      'webhook',
      'https://mixed.test/secret',
      notice,
      {
        resolve: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ],
        fetch: async () => {
          calls++
          return new Response()
        },
      },
    )
    expect(result).toMatchObject({
      ok: false,
      attempts: 0,
      error: '目的地址在受保护网段，需运维放行',
    })
    expect(calls).toBe(0)
  })

  test('public boundary addresses and mapped public IPv4 pass HTTPS validation', async () => {
    for (const address of [
      '172.32.0.1',
      '100.128.0.1',
      '169.255.0.1',
      '::ffff:93.184.216.34',
      '::93.184.216.34',
      '2001:4860:4860::8888',
    ]) {
      const literal = address.includes(':') ? `[${address}]` : address
      const result = await notifyDestination(`https://${literal}/`)
      expect(result.address.family).toBe(address.includes(':') ? 6 : 4)
    }
  })

  test('ops entries allow exact hosts and optional ports; HTTP remains refused elsewhere', async () => {
    const allowlist = notifyAllowlist('internal.test:9000,[::1]:8443')
    const resolve = async () => [{ address: '10.0.0.1', family: 4 }]
    expect(
      (
        await notifyDestination('http://internal.test:9000/x', {
          allowlist,
          resolve,
        })
      ).address.address,
    ).toBe('10.0.0.1')
    expect(
      (await notifyDestination('https://[::1]:8443/x', { allowlist })).address
        .address,
    ).toBe('::1')
    for (const url of [
      'http://internal.test:9001/x',
      'http://other.test:9000/x',
      'http://127.0.0.1/x',
    ])
      await expect(
        notifyDestination(url, { allowlist, resolve }),
      ).rejects.toThrow('HTTP 主机需运维放行')
    await expect(
      notifyDestination('https://internal.test:9001/x', { allowlist, resolve }),
    ).rejects.toThrow('受保护网段')
    for (const entry of [
      '*.test',
      'test/path',
      'user:secret@test',
      'test?x=1',
      'test#x',
    ])
      expect(() => notifyAllowlist(entry)).toThrow('通知放行名单')
  })

  test('a public DNS answer changing to private between retry resolutions cannot trigger a second POST', async () => {
    let resolutions = 0,
      posts = 0
    const result = await pushNotifyChannel(
      'webhook',
      'https://changing.test/secret',
      notice,
      {
        resolve: async () => [
          {
            address: ++resolutions === 1 ? '93.184.216.34' : '127.0.0.1',
            family: 4,
          },
        ],
        delay: async () => {},
        fetch: async () => {
          posts++
          return new Response('', { status: 500 })
        },
      },
    )
    expect(resolutions).toBe(2)
    expect(posts).toBe(1)
    expect(result).toEqual({
      ok: false,
      attempts: 1,
      error: '目的地址在受保护网段，需运维放行',
    })
  })

  test('Bun connects to the validated IP for a nonexistent hostname and preserves Host (no second DNS)', async () => {
    const received: { host: string | null; path: string; body: string }[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        received.push({
          host: request.headers.get('host'),
          path: new URL(request.url).pathname,
          body: await request.text(),
        })
        return new Response('ok')
      },
    })
    servers.push(server)
    let resolutions = 0
    const hostname = 'no-system-dns.invalid'
    const result = await pushNotifyChannel(
      'webhook',
      `http://${hostname}:${server.port}/notice`,
      notice,
      {
        allowlist: [`${hostname}:${server.port}`],
        resolve: async host => {
          expect(host).toBe(hostname)
          resolutions++
          return [
            {
              address: resolutions === 1 ? '127.0.0.1' : '127.0.0.2',
              family: 4,
            },
          ]
        },
        delay: async () => {},
        timeoutMs: 1000,
      },
    )
    expect(result).toEqual({ ok: true, attempts: 1, error: null })
    expect(resolutions).toBe(1)
    expect(received).toEqual([
      {
        host: `${hostname}:${server.port}`,
        path: '/notice',
        body: JSON.stringify(notice),
      },
    ])
  })
  test('Bun HTTPS pins the IP while verifying the original hostname certificate', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-tls-'))
    roots.push(root)
    const hostname = 'notify-pinned.invalid',
      cert = path.join(root, 'cert.pem'),
      key = path.join(root, 'key.pem')
    const generated = Bun.spawnSync(
      [
        'openssl',
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        `/CN=${hostname}`,
        '-addext',
        `subjectAltName=DNS:${hostname}`,
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    expect(generated.exitCode).toBe(0)
    const hosts: (string | null)[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      tls: { cert: Bun.file(cert), key: Bun.file(key) },
      fetch(request) {
        hosts.push(request.headers.get('host'))
        return new Response('ok')
      },
    })
    servers.push(server)
    const modulePath = path.resolve(
      import.meta.dir,
      '../../src/commands/consoleNotifyChannels.ts',
    )
    async function send(name: string) {
      const source = `import { pushNotifyChannel } from ${JSON.stringify(modulePath)}; const result = await pushNotifyChannel('webhook', ${JSON.stringify(`https://${name}:${server.port}/notice`)}, ${JSON.stringify(notice)}, { allowlist: [${JSON.stringify(`${name}:${server.port}`)}], resolve: async () => [{ address: '127.0.0.1', family: 4 }], delay: async () => {}, timeoutMs: 1000 }); process.stdout.write(JSON.stringify(result));`
      const child = Bun.spawn([process.execPath, '-e', source], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const output = await new Response(child.stdout).text()
      expect(await child.exited).toBe(0)
      return JSON.parse(output) as { ok: boolean; attempts: number }
    }
    expect(await send(hostname)).toMatchObject({ ok: true, attempts: 1 })
    expect(hosts).toEqual([`${hostname}:${server.port}`])
    expect(await send('wrong-certificate-name.invalid')).toMatchObject({
      ok: false,
      attempts: 4,
    })
    expect(hosts).toHaveLength(1)
  }, 20_000)
})
