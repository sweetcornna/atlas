// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import type { ConsoleAction } from '../src/deps.js'
import type {
  DirectionActor,
  HandoffDeviceIdentity,
  HandoffDeviceRefusal,
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
const TOKEN_HANDOFF = `qmd_${'d'.repeat(43)}`
const DEVICE_A = 'd-aaaaaaaaaaaa'

/** Devices by token; revoking one makes its token stop authenticating. */
class Devices implements HandoffDevicesPort {
  readonly revoked = new Set<string>()
  readonly inactive = new Set<string>()
  readonly byToken = new Map<string, HandoffDeviceIdentity>()

  authenticate(token: string): HandoffDeviceIdentity | null {
    const device = this.byToken.get(token)
    return device === undefined ||
      this.revoked.has(device.deviceId) ||
      this.inactive.has(device.owner)
      ? null
      : device
  }

  refusalOf(token: string): HandoffDeviceRefusal {
    const device = this.byToken.get(token)
    if (device === undefined) return 'unauthorized'
    if (this.revoked.has(device.deviceId)) return 'device_revoked'
    return this.inactive.has(device.owner) ? 'owner_inactive' : 'unauthorized'
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
      kind: 'client',
      createdAt: 0,
      lastSeenAt: null,
      revokedAt: 1,
      tasks: 0,
    }
    return { ok: true as const, value: view }
  }
}

async function scene(devices = new Devices()) {
  const actions: ConsoleAction[] = []
  const h = accountsHarness({
    deps: {
      handoffDevices: devices,
      actions: {
        record: async entry => {
          actions.push(entry)
          return { ok: true, value: undefined }
        },
        list: async () => ({ ok: true, value: { entries: [], next: null } }),
      },
    },
  })
  const member = await person(h.handle, 'member')
  const principal = h.book.bearerPrincipal(member.credential)
  if (!principal.ok || principal.value.kind !== 'user')
    throw new Error('no subject')
  const owner = principal.value.subject
  const kind = 'client' as const
  devices.byToken.set(TOKEN_A, { deviceId: DEVICE_A, owner, kind })
  devices.byToken.set(TOKEN_B, { deviceId: 'd-bbbbbbbbbbbb', owner, kind })
  devices.byToken.set(TOKEN_LEGACY, {
    deviceId: 'd-cccccccccccc',
    owner: 'legacy:admin',
    kind,
  })
  devices.byToken.set(TOKEN_HANDOFF, {
    deviceId: 'd-dddddddddddd',
    owner,
    kind: 'handoff',
  })
  return { ...h, devices, member, owner, actions }
}

const asDevice = (method: string, path: string, token: string): Request =>
  new Request(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  })

interface EnterOptions {
  /** `Sec-Fetch-Site`; `null` leaves it out. */
  readonly site?: string | null
  readonly session?: string
  readonly cookie?: string
  /** The header the Linux client adds over its pipe. */
  readonly device?: string
}

/** The window's navigation: user-initiated unless a test says otherwise. */
const enter = (ticket: string, options: EnterOptions = {}): Request => {
  const cookies = [
    ...(options.session === undefined
      ? []
      : [`qianmo_session=${options.session}`]),
    ...(options.cookie === undefined ? [] : [options.cookie]),
  ]
  return new Request(
    `${BASE}/client/enter?ticket=${encodeURIComponent(ticket)}`,
    {
      headers: {
        ...(options.site === null
          ? {}
          : { 'sec-fetch-site': options.site ?? 'none' }),
        ...(cookies.length === 0 ? {} : { cookie: cookies.join('; ') }),
        ...(options.device === undefined
          ? {}
          : { 'x-qmo-device': options.device }),
      },
    },
  )
}

/** The confirmation's own form, posted back. */
const confirm = (
  ticket: string,
  headers: Record<string, string> = {
    'sec-fetch-site': 'same-origin',
    origin: BASE,
  },
): Request =>
  new Request(`${BASE}/client/enter`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: `ticket=${encodeURIComponent(ticket)}`,
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

async function errorOf(response: Response) {
  const body = (await response.json()) as { error: { code: string } }
  return `${response.status} ${body.error.code}`
}

/** The `name=value` of the client cookie a response set. */
function deviceCookie(response: Response): string {
  const line = setCookieLine(response, 'qianmo_client')
  if (line === null) throw new Error('no client cookie')
  return line.split(';')[0]!
}

describe('client tickets (clients.md §3.2)', () => {
  test("the client's own window opens one ordinary session for the owner, once", async () => {
    const s = await scene()
    const issued = await ticketFor(s.handle)
    expect(issued.id).toMatch(/^t-[a-z2-7]{12}$/)
    expect(issued.ticket).toMatch(/^qmt_[A-Za-z0-9_-]{43}$/)
    expect(Date.parse(issued.expiresAt) - s.clock.now()).toBe(60_000)
    expect(await stateOf(s.handle, issued.id)).toBe('pending')

    const response = await s.handle(
      enter(issued.ticket, { device: DEVICE_A }),
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    const sid = cookieFrom(response, 'qianmo_session')
    expect(sid).toBeTruthy()
    expect(setCookieLine(response, 'qianmo_session')).toContain(
      'HttpOnly; SameSite=Strict',
    )
    // The window is marked as this device's, for a long time.
    const marked = setCookieLine(response, 'qianmo_client')!
    expect(marked).toStartWith(`qianmo_client=${DEVICE_A}.`)
    expect(marked).toContain('HttpOnly; SameSite=Strict')
    expect(marked).toContain('Max-Age=34560000')
    expect(await stateOf(s.handle, issued.id)).toBe('used')

    // The session is the owner's: the front opens for it like any login.
    const front = await s.handle(asSession('GET', '/', sid!, { header: false }))
    expect(front.status).toBe(200)
    const principal = s.book.sessionPrincipal(sid!)
    expect(principal.ok && principal.value.subject).toBe(s.owner)

    // Spent: a second use is the login card, and nothing is opened.
    const again = await s.handle(enter(issued.ticket, { device: DEVICE_A }))
    expect(again.status).toBe(401)
    expect(cookieFrom(again, 'qianmo_session')).toBeNull()
    expect(await again.text()).toContain('票据无效或已经用过')
  })

  test('any other browser is asked first, and only that page’s form spends the ticket', async () => {
    const s = await scene()
    const issued = await ticketFor(s.handle)
    // A link opened from a mail or chat program arrives as `none` too.
    const page = await s.handle(enter(issued.ticket))
    expect(page.status).toBe(200)
    expect(cookieFrom(page, 'qianmo_session')).toBeNull()
    const html = await page.text()
    expect(html).toContain(`以 ${s.owner} 身份进入`)
    expect(html).toContain('action="/client/enter"')
    expect(html).not.toContain('<script')
    expect(page.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    )
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    expect(page.headers.get('cache-control')).toBe('no-store')
    expect(await stateOf(s.handle, issued.id)).toBe('pending')

    // The form is accepted from this console's own page and nowhere else.
    for (const headers of [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'none' },
      {},
      { origin: 'https://elsewhere.example' },
    ]) {
      const refused = await s.handle(confirm(issued.ticket, headers))
      expect(`${JSON.stringify(headers)} ${refused.status}`).toBe(
        `${JSON.stringify(headers)} 403`,
      )
    }
    expect(await stateOf(s.handle, issued.id)).toBe('pending')

    const accepted = await s.handle(confirm(issued.ticket))
    expect(accepted.status).toBe(303)
    expect(cookieFrom(accepted, 'qianmo_session')).toBeTruthy()
    expect(await stateOf(s.handle, issued.id)).toBe('used')

    // From then on that window goes straight through; another device's does not.
    const marked = deviceCookie(accepted)
    const next = await ticketFor(s.handle)
    const straight = await s.handle(enter(next.ticket, { cookie: marked }))
    expect(straight.status).toBe(303)
    const other = await ticketFor(s.handle, TOKEN_B)
    const asked = await s.handle(enter(other.ticket, { cookie: marked }))
    expect(asked.status).toBe(200)
    // A cookie with this device's id but not the console's signature is nothing.
    const forged = await ticketFor(s.handle)
    const notOurs = await s.handle(
      enter(forged.ticket, { cookie: `qianmo_client=${DEVICE_A}.forged` }),
    )
    expect(notOurs.status).toBe(200)
  })

  test('a browser signed in as somebody else is refused, the ticket left unspent', async () => {
    const s = await scene()
    const other = await person(s.handle, 'member')
    const issued = await ticketFor(s.handle)
    const refused = await s.handle(
      enter(issued.ticket, { session: other.sid, device: DEVICE_A }),
    )
    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('已经以另一个账号登录')
    expect(
      (
        await s.handle(
          new Request(`${BASE}/client/enter`, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              'sec-fetch-site': 'same-origin',
              cookie: `qianmo_session=${other.sid}`,
            },
            body: `ticket=${issued.ticket}`,
          }),
        )
      ).status,
    ).toBe(409)
    // Signed in with the shared admin token counts as somebody else as well.
    const legacy = await s.handle(
      enter(issued.ticket, {
        cookie: `qianmo_console=${TOKENS.admin}`,
        device: DEVICE_A,
      }),
    )
    expect(legacy.status).toBe(409)
    expect(s.book.sessionPrincipal(other.sid).ok).toBe(true)
    expect(await stateOf(s.handle, issued.id)).toBe('pending')
    // The owner's own session is replaced, not refused.
    const own = await s.handle(
      enter(issued.ticket, { session: s.member.sid, device: DEVICE_A }),
    )
    expect(own.status).toBe(303)
  })

  test('a ticket from another site is refused and not spent', async () => {
    const s = await scene()
    const issued = await ticketFor(s.handle)
    for (const site of ['cross-site', 'same-site']) {
      const refused = await s.handle(
        enter(issued.ticket, { site, device: DEVICE_A }),
      )
      expect(refused.status).toBe(403)
      expect(cookieFrom(refused, 'qianmo_session')).toBeNull()
    }
    expect(await stateOf(s.handle, issued.id)).toBe('pending')
    expect(
      (await s.handle(enter(issued.ticket, { device: DEVICE_A }))).status,
    ).toBe(303)
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
    await s.handle(enter(mine[0]!.ticket, { device: DEVICE_A }))
    await ticketFor(s.handle)
  })

  test('spent tickets fill nobody’s allowance, and one device cannot ask too fast', async () => {
    const s = await scene()
    for (let i = 0; i < 20; i++) {
      const issued = await ticketFor(s.handle)
      expect(
        (await s.handle(enter(issued.ticket, { device: DEVICE_A }))).status,
      ).toBe(303)
    }
    const tooFast = await s.handle(
      asDevice('POST', '/v0/client/tickets', TOKEN_A),
    )
    expect(await errorOf(tooFast)).toBe('429 limit')
    // Somebody else's device is not held up by it.
    await ticketFor(s.handle, TOKEN_B)
    s.clock.advance(60_000)
    await ticketFor(s.handle)
  })

  test('the console-wide cap counts unspent tickets only', async () => {
    const devices = new Devices()
    const s = await scene(devices)
    const tokens: string[] = []
    for (let i = 0; i < 250; i++) {
      const token = `qmd_${String(i).padStart(43, 'x')}`
      const id = `d-${String.fromCharCode(97 + (i % 26))}${'a'.repeat(9)}${String.fromCharCode(97 + Math.floor(i / 26))}${'b'}`
      devices.byToken.set(token, { deviceId: id, owner: s.owner, kind: 'client' })
      tokens.push(token)
    }
    const held: string[] = []
    for (const token of tokens)
      for (let i = 0; i < 4; i++)
        held.push((await ticketFor(s.handle, token)).ticket)
    const full = await s.handle(asDevice('POST', '/v0/client/tickets', TOKEN_A))
    expect(await errorOf(full)).toBe('503 unavailable')
    // Spending one makes room at once.
    expect((await s.handle(confirm(held[0]!))).status).toBe(303)
    await ticketFor(s.handle)
  })

  test('only a client device token opens the API, never in a link, and each refusal says why', async () => {
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
    expect(await errorOf(legacy)).toBe('403 forbidden')
    // A `qm handoff login` device stays behind the handoff fence.
    const handoff = await s.handle(
      asDevice('POST', '/v0/client/tickets', TOKEN_HANDOFF),
    )
    expect(await errorOf(handoff)).toBe('403 device_kind')
    const unknown = await s.handle(
      asDevice('GET', '/v0/client/device', `qmd_${'e'.repeat(43)}`),
    )
    expect(await errorOf(unknown)).toBe('401 unauthorized')
    s.devices.inactive.add(s.owner)
    expect(
      await errorOf(await s.handle(asDevice('GET', '/v0/client/device', TOKEN_A))),
    ).toBe('401 owner_inactive')
    s.devices.inactive.delete(s.owner)
    s.devices.revoked.add(DEVICE_A)
    expect(
      await errorOf(await s.handle(asDevice('GET', '/v0/client/device', TOKEN_A))),
    ).toBe('401 device_revoked')
  })

  test('signing out revokes the device, closes its sessions, and leaves a ledger line', async () => {
    const s = await scene()
    const device = await s.handle(asDevice('GET', '/v0/client/device', TOKEN_A))
    expect(await device.json()).toEqual({ deviceId: DEVICE_A, kind: 'client' })
    const issued = await ticketFor(s.handle)
    const pending = await ticketFor(s.handle)
    const sid = cookieFrom(
      await s.handle(enter(issued.ticket, { device: DEVICE_A })),
      'qianmo_session',
    )!
    expect(s.book.sessionPrincipal(sid).ok).toBe(true)

    const out = await s.handle(asDevice('DELETE', '/v0/client/device', TOKEN_A))
    expect(out.status).toBe(204)
    expect(s.devices.revoked.has(DEVICE_A)).toBe(true)
    expect(s.book.sessionPrincipal(sid).ok).toBe(false)
    // The person's own browser session is not the device's to close.
    expect(s.book.sessionPrincipal(s.member.sid).ok).toBe(true)
    // An unspent ticket of the revoked device is dead too.
    expect(
      (await s.handle(enter(pending.ticket, { device: DEVICE_A }))).status,
    ).toBe(401)
    expect(
      s.actions
        .filter(a => a.action.startsWith('handoff.'))
        .map(a => [a.subject, a.action, a.target, a.outcome]),
    ).toEqual([[s.owner, 'handoff.device.revoke', DEVICE_A, 'ok']])
  })

  test('revoking after a restart still closes the sessions the device opened', async () => {
    const s = await scene()
    const issued = await ticketFor(s.handle)
    const sid = cookieFrom(
      await s.handle(enter(issued.ticket, { device: DEVICE_A })),
      'qianmo_session',
    )!
    // A fresh console over the same account book and device ledger.
    const fresh = createConsoleHandler(
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
        now: s.clock.now,
        handoffDevices: s.devices,
      },
      TOKENS,
      { book: s.book },
    )
    expect(
      (await fresh(asDevice('DELETE', '/v0/client/device', TOKEN_A))).status,
    ).toBe(204)
    expect(s.book.sessionPrincipal(sid).ok).toBe(false)
  })

  test('revoking from the 连接 page closes the device sessions as well', async () => {
    const s = await scene()
    const issued = await ticketFor(s.handle)
    const sid = cookieFrom(
      await s.handle(enter(issued.ticket, { device: DEVICE_A })),
      'qianmo_session',
    )!
    const response = await s.handle(
      asSession('DELETE', `/v0/handoff/devices/${DEVICE_A}`, s.member.sid),
    )
    expect(response.status).toBe(200)
    expect(s.book.sessionPrincipal(sid).ok).toBe(false)
  })

  test('an account reset ends the unspent tickets of its devices', async () => {
    const s = await scene()
    const issued = await ticketFor(s.handle)
    const reset = s.book.reset(s.owner, 'legacy:admin')
    expect(reset.ok).toBe(true)
    if (!reset.ok) return
    expect(s.book.acceptInvite(reset.value.token).ok).toBe(true)
    // Back with a new credential within the minute: the old ticket is dead.
    expect(
      (await s.handle(enter(issued.ticket, { device: DEVICE_A }))).status,
    ).toBe(401)
  })
})

describe('without personal accounts', () => {
  test('the paths answer as before and no ticket is ever issued', async () => {
    const devices = new Devices()
    devices.byToken.set(TOKEN_A, {
      deviceId: DEVICE_A,
      owner: 'legacy:admin',
      kind: 'client',
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
