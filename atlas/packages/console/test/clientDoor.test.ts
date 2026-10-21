// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import type {
  DirectionActor,
  HandoffDeviceIdentity,
  HandoffDevicesPort,
  HandoffDeviceView,
} from '../src/directionPorts.js'
import { createConsoleHandler } from '../src/http.js'
import {
  accountsHarness,
  asAdmin,
  asSession,
  BASE,
  cookieFrom,
  LIMITS,
  person,
  setCookieLine,
  TOKENS,
} from './accountsHarness.js'

const TOKEN_A = `qmd_${'a'.repeat(43)}`
const TOKEN_B = `qmd_${'b'.repeat(43)}`
const TOKEN_LEGACY = `qmd_${'c'.repeat(43)}`

/** Devices by token; revoking one makes its token stop authenticating. */
class Devices implements HandoffDevicesPort {
  readonly revoked = new Set<string>()
  readonly byToken = new Map<string, HandoffDeviceIdentity>()

  authenticate(token: string): HandoffDeviceIdentity | null {
    const device = this.byToken.get(token)
    return device === undefined || this.revoked.has(device.deviceId)
      ? null
      : device
  }

  async listDevices() {
    return { ok: true as const, value: [] as readonly HandoffDeviceView[] }
  }

  async issuePairing() {
    return {
      ok: false as const,
      failure: { code: 'unsupported' as const, message: 'not here' },
    }
  }

  async revokeDevice(deviceId: string, _actor: DirectionActor) {
    this.revoked.add(deviceId)
    const view: HandoffDeviceView = {
      deviceId,
      name: 'pc',
      platform: 'win32-x64',
      owner: 'u:0000000000000000',
      createdAt: 0,
      lastSeenAt: null,
      revokedAt: 1,
      tasks: 0,
    }
    return { ok: true as const, value: view }
  }
}

async function scene() {
  const devices = new Devices()
  const h = accountsHarness({ deps: { handoffDevices: devices } })
  const member = await person(h.handle, 'member')
  const principal = h.book.bearerPrincipal(member.credential)
  if (!principal.ok || principal.value.kind !== 'user')
    throw new Error('no subject')
  const owner = principal.value.subject
  devices.byToken.set(TOKEN_A, { deviceId: 'd-aaaaaaaaaaaa', owner })
  devices.byToken.set(TOKEN_B, { deviceId: 'd-bbbbbbbbbbbb', owner })
  devices.byToken.set(TOKEN_LEGACY, {
    deviceId: 'd-cccccccccccc',
    owner: 'legacy:admin',
  })
  return { ...h, devices, member, owner }
}

const asDevice = (method: string, path: string, token: string): Request =>
  new Request(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  })

/** The window's navigation: user-initiated unless a test says where it came from. */
const enter = (ticket: string, site = 'none', cookie?: string): Request =>
  new Request(`${BASE}/client/enter?ticket=${encodeURIComponent(ticket)}`, {
    headers: {
      'sec-fetch-site': site,
      ...(cookie === undefined ? {} : { cookie: `qianmo_session=${cookie}` }),
    },
  })

async function ticketFor(
  handle: (request: Request) => Promise<Response>,
  token = TOKEN_A,
) {
  const response = await handle(asDevice('POST', '/v0/client/tickets', token))
  expect(response.status).toBe(201)
  expect(response.headers.get('cache-control')).toBe('no-store')
  return (await response.json()) as {
    id: string
    ticket: string
    expiresAt: string
  }
}

async function stateOf(
  handle: (request: Request) => Promise<Response>,
  id: string,
  token = TOKEN_A,
) {
  const response = await handle(
    asDevice('GET', `/v0/client/tickets/${id}`, token),
  )
  return response.status === 200
    ? ((await response.json()) as { state: string }).state
    : response.status
}

describe('client tickets (clients.md §3.2)', () => {
  test('a ticket opens one ordinary session for the device owner, once', async () => {
    const s = await scene()
    const issued = await ticketFor(s.handle)
    expect(issued.id).toMatch(/^t-[a-z2-7]{12}$/)
    expect(issued.ticket).toMatch(/^qmt_[A-Za-z0-9_-]{43}$/)
    expect(Date.parse(issued.expiresAt) - s.clock.now()).toBe(60_000)
    expect(await stateOf(s.handle, issued.id)).toBe('pending')

    const response = await s.handle(enter(issued.ticket))
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    const sid = cookieFrom(response, 'qianmo_session')
    expect(sid).toBeTruthy()
    expect(setCookieLine(response, 'qianmo_session')).toContain(
      'HttpOnly; SameSite=Strict',
    )
    expect(await stateOf(s.handle, issued.id)).toBe('used')

    // The session is the owner's: the front opens for it like any login.
    const front = await s.handle(asSession('GET', '/', sid!, { header: false }))
    expect(front.status).toBe(200)
    const principal = s.book.sessionPrincipal(sid!)
    expect(principal.ok && principal.value.subject).toBe(s.owner)

    // Spent: a second use is the login card, and nothing is opened.
    const again = await s.handle(enter(issued.ticket))
    expect(again.status).toBe(401)
    expect(cookieFrom(again, 'qianmo_session')).toBeNull()
    expect(await again.text()).toContain('票据无效或已经用过')
  })

  test('a ticket from another site is refused and not spent', async () => {
    const s = await scene()
    const issued = await ticketFor(s.handle)
    for (const site of ['cross-site', 'same-site']) {
      const refused = await s.handle(enter(issued.ticket, site))
      expect(refused.status).toBe(403)
      expect(cookieFrom(refused, 'qianmo_session')).toBeNull()
    }
    expect(await stateOf(s.handle, issued.id)).toBe('pending')
    expect((await s.handle(enter(issued.ticket))).status).toBe(303)
  })

  test('tickets expire after 60 s and wrong ones count toward the login throttle', async () => {
    const s = await scene()
    const issued = await ticketFor(s.handle)
    s.clock.advance(60_000)
    expect(await stateOf(s.handle, issued.id)).toBe('expired')
    expect((await s.handle(enter(issued.ticket))).status).toBe(401)

    const wrong = `qmt_${'z'.repeat(43)}`
    let status = 0
    for (let i = 0; i < 8 && status !== 429; i++)
      status = (await s.handle(enter(wrong))).status
    expect(status).toBe(429)
  })

  test('a device holds at most four unspent tickets and sees only its own', async () => {
    const s = await scene()
    const mine = []
    for (let i = 0; i < 4; i++) mine.push(await ticketFor(s.handle))
    const fifth = await s.handle(
      asDevice('POST', '/v0/client/tickets', TOKEN_A),
    )
    expect(fifth.status).toBe(429)
    // Another device of the same person has its own allowance and no view of these.
    await ticketFor(s.handle, TOKEN_B)
    expect(await stateOf(s.handle, mine[0]!.id, TOKEN_B)).toBe(404)
    // Spending one frees a place.
    await s.handle(enter(mine[0]!.ticket))
    await ticketFor(s.handle)
  })

  test('only a device token opens the API, never in a link, never a revoked one', async () => {
    const s = await scene()
    const none = await s.handle(
      new Request(`${BASE}/v0/client/tickets`, { method: 'POST' }),
    )
    expect(none.status).toBe(401)
    const personal = await s.handle(
      new Request(`${BASE}/v0/client/tickets`, {
        method: 'POST',
        headers: { authorization: `Bearer ${s.member.credential}` },
      }),
    )
    expect(personal.status).toBe(401)
    const inLink = await s.handle(
      new Request(`${BASE}/v0/client/device?token=${TOKEN_A}`, {
        headers: { authorization: `Bearer ${TOKEN_A}` },
      }),
    )
    expect(inLink.status).toBe(400)
    const legacy = await s.handle(
      asDevice('POST', '/v0/client/tickets', TOKEN_LEGACY),
    )
    expect(legacy.status).toBe(403)
    s.devices.revoked.add('d-aaaaaaaaaaaa')
    expect(
      (await s.handle(asDevice('GET', '/v0/client/device', TOKEN_A))).status,
    ).toBe(401)
  })

  test('signing out revokes the device and closes the sessions its tickets opened', async () => {
    const s = await scene()
    const device = await s.handle(asDevice('GET', '/v0/client/device', TOKEN_A))
    expect(await device.json()).toEqual({ deviceId: 'd-aaaaaaaaaaaa' })
    const issued = await ticketFor(s.handle)
    const pending = await ticketFor(s.handle)
    const sid = cookieFrom(
      await s.handle(enter(issued.ticket)),
      'qianmo_session',
    )!
    expect(s.book.sessionPrincipal(sid).ok).toBe(true)

    const out = await s.handle(asDevice('DELETE', '/v0/client/device', TOKEN_A))
    expect(out.status).toBe(204)
    expect(s.devices.revoked.has('d-aaaaaaaaaaaa')).toBe(true)
    expect(s.book.sessionPrincipal(sid).ok).toBe(false)
    // The person's own browser session is not the device's to close.
    expect(s.book.sessionPrincipal(s.member.sid).ok).toBe(true)
    // An unspent ticket of the revoked device is dead too.
    expect((await s.handle(enter(pending.ticket))).status).toBe(401)
  })

  test('revoking from the 连接 page closes the device sessions as well', async () => {
    const s = await scene()
    const issued = await ticketFor(s.handle)
    const sid = cookieFrom(
      await s.handle(enter(issued.ticket)),
      'qianmo_session',
    )!
    const response = await s.handle(
      asSession('DELETE', '/v0/handoff/devices/d-aaaaaaaaaaaa', s.member.sid),
    )
    expect(response.status).toBe(200)
    expect(s.book.sessionPrincipal(sid).ok).toBe(false)
  })
})

describe('without personal accounts', () => {
  test('the paths answer as before and no ticket is ever issued', async () => {
    const devices = new Devices()
    devices.byToken.set(TOKEN_A, {
      deviceId: 'd-aaaaaaaaaaaa',
      owner: 'legacy:admin',
    })
    const handle = createConsoleHandler(
      {
        registry: {
          list: async () => ({ ok: true, value: [] }),
          register: async () => ({
            ok: false,
            failure: { code: 'unsupported', message: 'no' },
          }),
          deregister: async () => ({ ok: true, value: undefined }),
          heartbeat: async () => ({
            ok: false,
            failure: { code: 'unsupported', message: 'no' },
          }),
        },
        audit: {
          read: async () => ({
            ok: false,
            failure: { code: 'unsupported', message: 'no' },
          }),
          chain: async () => ({ ok: true, value: null }),
        },
        limits: LIMITS,
        handoffDevices: devices,
      },
      TOKENS,
    )
    const ticket = await handle(asDevice('POST', '/v0/client/tickets', TOKEN_A))
    expect(ticket.status).toBe(403)
    const page = await handle(enter(`qmt_${'a'.repeat(43)}`))
    expect(page.status).toBe(404)
    expect(cookieFrom(page, 'qianmo_session')).toBeNull()
    expect((await handle(asAdmin('GET', '/v0/client/device'))).status).toBe(404)
  })
})
