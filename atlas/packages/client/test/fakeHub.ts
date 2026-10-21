// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A stand-in hub on loopback with the client contract of clients.md §3:
 * pairing, tickets, the device, and `/client/enter` with the same refusal of
 * cross-site navigations. The real console is exercised by
 * `atlas/tests/integration/qianmo-client-front.test.ts`; this one is for the
 * places that cannot run the console, such as a Windows runner that installs
 * only this package.
 */

import { randomBytes } from 'node:crypto'

export const PAIRING_CODE = 'ABCD-EFGH-IJKL'

interface Ticket {
  readonly id: string
  readonly deviceId: string
  readonly expiresAt: number
  used: boolean
}

export interface FakeHub {
  readonly url: string
  /** How each `/client/enter` navigation arrived. */
  readonly entered: { readonly site: string | null }[]
  /** Paths served to a signed-in window. */
  readonly front: string[]
  readonly revoked: Set<string>
  stop(): void
}

const b64 = () => randomBytes(32).toString('base64url')

export function fakeHub(): FakeHub {
  const devices = new Map<string, string>()
  const tickets = new Map<string, Ticket>()
  const byTicket = new Map<string, Ticket>()
  const sessions = new Set<string>()
  const entered: { site: string | null }[] = []
  const front: string[] = []
  const revoked = new Set<string>()
  let seq = 0

  const device = (request: Request): string | null => {
    const token = (request.headers.get('authorization') ?? '').replace(
      /^Bearer /,
      '',
    )
    const id = devices.get(token)
    return id === undefined || revoked.has(id) ? null : id
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname
      if (path === '/v0/handoff/pair' && request.method === 'POST') {
        const body = (await request.json()) as { code: string; name: string }
        if (body.code !== PAIRING_CODE)
          return new Response(null, { status: 400 })
        seq += 1
        const deviceId = `d-${'abcdefghijk'}${'lmnopq'[seq % 6]}`
        const token = `qmd_${b64()}`
        devices.set(token, deviceId)
        return Response.json({
          deviceId,
          name: body.name,
          token,
          console: url.origin,
        })
      }
      if (path.startsWith('/v0/client/')) {
        const id = device(request)
        if (id === null) return new Response(null, { status: 401 })
        if (path === '/v0/client/device') {
          if (request.method === 'DELETE') {
            revoked.add(id)
            return new Response(null, { status: 204 })
          }
          return Response.json({ deviceId: id })
        }
        if (path === '/v0/client/tickets' && request.method === 'POST') {
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
        entered.push({ site })
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
    entered,
    front,
    revoked,
    stop: () => server.stop(true),
  }
}
