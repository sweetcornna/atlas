// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A stand-in hub on loopback with the client contract of clients.md §3:
 * pairing (client or `qm handoff` devices), tickets, the device with the
 * three 401 codes, and `/client/enter` with the same refusal of cross-site
 * navigations. Its enter is a plain 303, without the account confirmation a
 * fresh window profile meets on the real console. The real console is
 * exercised by `atlas/tests/integration/qianmo-client-front.test.ts`; this
 * one is for the places that cannot run the console, such as a Windows
 * runner that installs only this package.
 */

import { randomBytes } from 'node:crypto'

export const PAIRING_CODE = 'ABCD-EFGH-IJKL'

/** The console's answer to a device token on a hub without personal accounts. */
export const HANDOFF_ONLY = '设备令牌只能访问接力接口'

interface Ticket {
  readonly id: string
  readonly deviceId: string
  readonly expiresAt: number
  used: boolean
}

interface Device {
  readonly id: string
  readonly kind: 'client' | 'handoff'
}

export interface Entered {
  readonly site: string | null
  /** The `X-Qmo-Device` header, which only the pipe route sends. */
  readonly device: string | null
}

export interface FakeHub {
  readonly url: string
  /** The `kind` each pairing sent, `null` for none. */
  readonly paired: (string | null)[]
  /** How each `/client/enter` navigation arrived. */
  readonly entered: Entered[]
  /** Paths served to a signed-in window. */
  readonly front: string[]
  readonly revoked: Set<string>
  /** Devices whose owning account is revoked or being reset. */
  readonly inactive: Set<string>
  stop(): void
}

const b64 = () => randomBytes(32).toString('base64url')

const refusal = (code: string, message: string, status = 401) =>
  Response.json({ error: { code, message } }, { status })

/** `accounts: false` stands in for a hub without personal accounts. */
export function fakeHub(
  options: { readonly accounts?: boolean } = {},
): FakeHub {
  const devices = new Map<string, Device>()
  const tickets = new Map<string, Ticket>()
  const byTicket = new Map<string, Ticket>()
  const sessions = new Set<string>()
  const paired: (string | null)[] = []
  const entered: Entered[] = []
  const front: string[] = []
  const revoked = new Set<string>()
  const inactive = new Set<string>()
  let seq = 0

  const device = (request: Request): Device | Response => {
    const token = (request.headers.get('authorization') ?? '').replace(
      /^Bearer /,
      '',
    )
    const found = devices.get(token)
    if (found === undefined) return refusal('unauthorized', '设备令牌无效')
    if (revoked.has(found.id))
      return refusal('device_revoked', '这台设备已被吊销')
    if (inactive.has(found.id))
      return refusal('owner_inactive', '这台设备所属的账号已停用或正在重置')
    return found
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname
      if (path === '/v0/handoff/pair' && request.method === 'POST') {
        const body = (await request.json()) as {
          code: string
          name: string
          kind?: string
        }
        if (body.code !== PAIRING_CODE)
          return new Response(null, { status: 400 })
        paired.push(body.kind ?? null)
        seq += 1
        const deviceId = `d-${'abcdefghijk'}${'lmnopq'[seq % 6]}`
        const token = `qmd_${b64()}`
        devices.set(token, {
          id: deviceId,
          kind: body.kind === 'client' ? 'client' : 'handoff',
        })
        return Response.json({
          deviceId,
          name: body.name,
          token,
          console: url.origin,
        })
      }
      if (path.startsWith('/v0/client/')) {
        const found = device(request)
        if (found instanceof Response) return found
        const id = found.id
        if (path === '/v0/client/device') {
          if (request.method === 'DELETE') {
            revoked.add(id)
            return new Response(null, { status: 204 })
          }
          return Response.json({ deviceId: id, kind: found.kind })
        }
        if (path === '/v0/client/tickets' && request.method === 'POST') {
          if (options.accounts === false)
            return refusal('forbidden', HANDOFF_ONLY, 403)
          if (found.kind !== 'client')
            return refusal(
              'device_kind',
              '这台设备是用 qm handoff login 配对的接力设备，不能打开前台',
              403,
            )
          seq += 1
          const ticket: Ticket = {
            id: `t-${'abcdefghijk'}${'lmnopq'[seq % 6]}`,
            deviceId: id,
            expiresAt: Date.now() + 60_000,
            used: false,
          }
          const secret = `qmt_${b64()}`
          tickets.set(ticket.id, ticket)
          byTicket.set(secret, ticket)
          return Response.json(
            {
              id: ticket.id,
              ticket: secret,
              expiresAt: new Date(ticket.expiresAt).toISOString(),
            },
            { status: 201 },
          )
        }
        const ticket = tickets.get(path.slice('/v0/client/tickets/'.length))
        if (ticket === undefined || ticket.deviceId !== id)
          return new Response(null, { status: 404 })
        const state = ticket.used
          ? 'used'
          : Date.now() < ticket.expiresAt
            ? 'pending'
            : 'expired'
        return Response.json({ id: ticket.id, state })
      }
      if (path === '/client/enter') {
        const site = request.headers.get('sec-fetch-site')
        entered.push({ site, device: request.headers.get('x-qmo-device') })
        if (site !== null && site !== 'none' && site !== 'same-origin')
          return new Response('cross-site', { status: 403 })
        const ticket = byTicket.get(url.searchParams.get('ticket') ?? '')
        if (
          ticket === undefined ||
          ticket.used ||
          Date.now() >= ticket.expiresAt
        )
          return new Response('refused', { status: 401 })
        ticket.used = true
        const sid = b64()
        sessions.add(sid)
        return new Response(null, {
          status: 303,
          headers: {
            location: '/',
            'set-cookie': `qianmo_session=${sid}; Path=/; HttpOnly; SameSite=Strict`,
          },
        })
      }
      const sid = /qianmo_session=([^;]+)/.exec(
        request.headers.get('cookie') ?? '',
      )?.[1]
      if (sid === undefined || !sessions.has(sid))
        return path === '/login'
          ? new Response('<title>login</title>', {
              headers: { 'content-type': 'text/html' },
            })
          : new Response(null, { status: 303, headers: { location: '/login' } })
      front.push(path)
      return new Response('<!doctype html><title>front</title>', {
        headers: { 'content-type': 'text/html' },
      })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    paired,
    entered,
    front,
    revoked,
    inactive,
    stop: () => server.stop(true),
  }
}
