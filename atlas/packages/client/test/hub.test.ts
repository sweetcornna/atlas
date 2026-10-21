// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import {
  ClientError,
  type DeviceStatus,
  deviceStatus,
  enterUrl,
  pairDevice,
  parseHubUrl,
  requestTicket,
  revokeDevice,
  ticketState,
} from '../src/hub.ts'

const TOKEN = `qmd_${'a'.repeat(43)}`
const TICKET = `qmt_${'t'.repeat(43)}`

const servers: { stop(force?: boolean): void }[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

/** A hub on loopback that answers with `respond` and remembers what it was asked. */
interface Seen {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  readonly body: string
}

function hub(respond: (request: Request) => Response | Promise<Response>) {
  const seen: Seen[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { method, url, headers } = request
      seen.push({ method, url, headers, body: await request.clone().text() })
      return respond(request)
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}`, seen }
}

describe('parseHubUrl', () => {
  test('https anywhere, http on loopback only, nothing that rides along', () => {
    expect(parseHubUrl('https://hub.example/')).toBe('https://hub.example')
    expect(parseHubUrl(' https://hub.example/qm/ ')).toBe(
      'https://hub.example/qm',
    )
    expect(parseHubUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    expect(parseHubUrl('http://localhost:8080/')).toBe('http://localhost:8080')
    for (const bad of [
      'http://hub.example',
      'ftp://hub.example',
      'https://u:p@hub.example',
      'https://hub.example/?token=x',
      'https://hub.example/#x',
      'hub.example',
    ]) {
      expect(() => parseHubUrl(bad)).toThrow(ClientError)
    }
  })
})

describe('pairDevice', () => {
  test('posts the code, name and platform and checks what comes back', async () => {
    const h = hub(() =>
      Response.json({
        deviceId: 'd-abcdefghijkl',
        name: 'pc',
        token: TOKEN,
        console: 'https://elsewhere.example',
      }),
    )
    const paired = await pairDevice(h.url, {
      code: 'ABCD-EFGH-IJKL',
      name: 'pc',
      platform: 'win32-x64',
    })
    expect(paired).toEqual({
      deviceId: 'd-abcdefghijkl',
      name: 'pc',
      token: TOKEN,
    })
    const [request] = h.seen
    expect(new URL(request!.url).pathname).toBe('/v0/handoff/pair')
    expect(request!.method).toBe('POST')
    expect(JSON.parse(request!.body)).toEqual({
      code: 'ABCD-EFGH-IJKL',
      name: 'pc',
      platform: 'win32-x64',
    })
    expect(request!.headers.get('cookie')).toBeNull()
  })

  test('says what went wrong, and never trusts a malformed answer', async () => {
    const cases: [() => Response, RegExp][] = [
      [() => new Response(null, { status: 404 }), /没有设备配对/],
      [() => new Response(null, { status: 429 }), /过多/],
      [
        () =>
          Response.json(
            { error: { code: 'refused', message: '配对码无效或已过期' } },
            { status: 403 },
          ),
        /配对码无效或已过期/,
      ],
      [
        () => Response.json({ deviceId: 'd-x', name: 'pc', token: 'nope' }),
        /不合法/,
      ],
    ]
    for (const [answer, message] of cases) {
      const h = hub(answer)
      await expect(
        pairDevice(h.url, { code: 'X', name: 'pc', platform: 'linux-x64' }),
      ).rejects.toThrow(message)
    }
  })

  test('refuses to follow a redirect with anything', async () => {
    const h = hub(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: 'https://evil.example/' },
        }),
    )
    await expect(
      pairDevice(h.url, { code: 'X', name: 'pc', platform: 'linux-x64' }),
    ).rejects.toThrow(/连不上中枢/)
  })
})

describe('tickets and the device', () => {
  test('a ticket, its state, and the enter address', async () => {
    const h = hub(request => {
      const path = new URL(request.url).pathname
      if (path === '/v0/client/tickets')
        return Response.json(
          {
            id: 't-abcdefghijkl',
            ticket: TICKET,
            expiresAt: '2026-10-21T00:01:00.000Z',
          },
          { status: 201 },
        )
      return Response.json({ id: 't-abcdefghijkl', state: 'used' })
    })
    const outcome = await requestTicket(h.url, TOKEN)
    expect(outcome).toEqual({
      kind: 'ticket',
      id: 't-abcdefghijkl',
      ticket: TICKET,
      expiresAt: Date.parse('2026-10-21T00:01:00.000Z'),
    })
    expect(await ticketState(h.url, TOKEN, 't-abcdefghijkl')).toBe('used')
    for (const request of h.seen) {
      expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
      expect(new URL(request.url).search).toBe('')
    }
    expect(enterUrl('https://hub.example', TICKET)).toBe(
      `https://hub.example/client/enter?ticket=${TICKET}`,
    )
  })

  test('a hub without tickets is "unsupported", a revoked device is an error', async () => {
    expect(
      await requestTicket(
        hub(() => new Response(null, { status: 404 })).url,
        TOKEN,
      ),
    ).toEqual({ kind: 'unsupported' })
    expect(
      await requestTicket(
        hub(() => new Response(null, { status: 501 })).url,
        TOKEN,
      ),
    ).toEqual({ kind: 'unsupported' })
    // A hub from before the client door, or without accounts, says 403 here.
    expect(
      await requestTicket(
        hub(() =>
          Response.json(
            {
              error: { code: 'forbidden', message: '设备令牌只能访问接力接口' },
            },
            { status: 403 },
          ),
        ).url,
        TOKEN,
      ),
    ).toEqual({ kind: 'unsupported', reason: '设备令牌只能访问接力接口' })
    await expect(
      requestTicket(hub(() => new Response(null, { status: 401 })).url, TOKEN),
    ).rejects.toThrow(/重新 qmo sign-in/)
    await expect(
      requestTicket(
        hub(() =>
          Response.json(
            { id: 'x', ticket: 'y', expiresAt: 'z' },
            { status: 201 },
          ),
        ).url,
        TOKEN,
      ),
    ).rejects.toThrow(/不合法/)
  })

  test('device status and self-revocation map the hub answers', async () => {
    const statuses: [
      number,
      DeviceStatus,
      Awaited<ReturnType<typeof revokeDevice>>,
    ][] = [
      [200, 'active', 'failed'],
      [204, 'unreachable', 'revoked'],
      [401, 'revoked', 'revoked'],
      [404, 'unsupported', 'unsupported'],
      [500, 'unreachable', 'failed'],
    ]
    for (const [status, seen, revoked] of statuses) {
      const h = hub(() =>
        status === 204 || status === 404 || status === 500
          ? new Response(null, { status })
          : Response.json({ deviceId: 'd-abcdefghijkl' }, { status }),
      )
      expect(await deviceStatus(h.url, TOKEN)).toBe(
        status === 204 ? 'active' : seen,
      )
      expect(await revokeDevice(h.url, TOKEN)).toBe(revoked)
    }
    expect(await deviceStatus('http://127.0.0.1:1', TOKEN)).toBe('unreachable')
  })
})
