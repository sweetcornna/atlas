// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The client door against the production account book and device ledger
 * (clients.md §3.2, §6): which devices may mint a ticket, what an account
 * reset leaves of them and of its codes, a ticket in somebody else's browser,
 * what a click on the confirmation leaves behind, a ticket raced for, and who
 * sees which devices.
 */

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  AccountBook,
  type ConsoleAction,
  createConsoleHandler,
} from '@qianmo/console'
import { FileLedger } from '@qianmo/node/commands/consoleAccountsStore.js'
import { openConsoleHandoffDevices } from '@qianmo/node/commands/consoleHandoffDevices.js'
import {
  CountingChat,
  LIMITS,
  TOKENS,
} from '../../packages/console/test/accountsHarness.js'

const BASE = 'http://console.test'
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const unsupported = {
  ok: false as const,
  failure: { code: 'unsupported' as const, message: 'not here' },
}

function scene() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-door-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const accounts = new FileLedger(path.join(root, 'accounts.ndjson'))
  const sessions = new FileLedger(path.join(root, 'sessions.ndjson'))
  cleanups.push(() => {
    accounts.close()
    sessions.close()
  })
  const book = new AccountBook({ accounts, sessions })
  // The ledger `qm console --handoff --accounts` opens.
  const devices = openConsoleHandoffDevices({
    path: path.join(root, 'devices.ndjson'),
    accounts: book,
  })
  cleanups.push(() => devices.close())
  const actions: ConsoleAction[] = []
  const handle = createConsoleHandler(
    {
      registry: {
        list: async () => ({ ok: true, value: [] }),
        register: async () => unsupported,
        deregister: async () => ({ ok: true, value: undefined }),
        heartbeat: async () => unsupported,
      },
      audit: {
        read: async () => unsupported,
        chain: async () => ({ ok: true, value: null }),
      },
      limits: LIMITS,
      chat: new CountingChat(),
      handoffDevices: devices,
      actions: {
        record: async entry => {
          actions.push(entry)
          return { ok: true, value: undefined }
        },
        list: async () => ({
          ok: true,
          value: { entries: [], nextBeforeSeq: null },
        }),
      },
    },
    TOKENS,
    { book },
  ) as (request: Request) => Promise<Response>
  const person = (role: 'member' | 'ops') => {
    const invite = book.issueInvite({ role, issuedBy: 'legacy:admin' })
    if (!invite.ok) throw new Error('invite')
    const user = book.acceptInvite(invite.value.token)
    if (!user.ok) throw new Error('accept')
    const login = book.login(user.value.credential, '')
    if (!login.ok) throw new Error('login')
    return {
      subject: user.value.subject as string,
      role,
      requestId: 'door',
      sid: login.value.sid,
    }
  }
  /** `qm handoff login` sends no kind; `qmo sign-in` sends `client`. */
  const pair = async (
    actor: ReturnType<typeof person>,
    kind?: 'client',
  ): Promise<{ token: string; deviceId: string }> => {
    const pairing = await devices.issuePairing(actor, BASE)
    if (!pairing.ok) throw new Error('pairing')
    const response = await handle(
      new Request(`${BASE}/v0/handoff/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: pairing.value.code,
          name: 'laptop',
          platform: 'linux-x64',
          ...(kind === undefined ? {} : { kind }),
        }),
      }),
    )
    expect(response.status).toBe(200)
    return (await response.json()) as { token: string; deviceId: string }
  }
  return { root, book, devices, handle, person, pair, actions }
}

const bearer = (method: string, p: string, token: string) =>
  new Request(`${BASE}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  })

const session = (method: string, p: string, sid: string) =>
  new Request(`${BASE}${p}`, {
    method,
    headers: {
      cookie: `qianmo_session=${sid}`,
      'x-qianmo-console': '1',
      'sec-fetch-site': 'same-origin',
      origin: BASE,
    },
  })

/** The client cookie a response sets, as `name=value`; `''` when it clears it. */
const clientCookieOf = (response: Response): string | null => {
  const line = response.headers
    .getSetCookie()
    .find(c => c.startsWith('qianmo_client='))
  if (line === undefined) return null
  return /Max-Age=0(;|$)/.test(line) ? '' : line.split(';')[0]!
}

const sessionOf = (response: Response): string | null => {
  const line = response.headers
    .getSetCookie()
    .find(
      c => c.startsWith('qianmo_session=') && !c.startsWith('qianmo_session=;'),
    )
  return line === undefined
    ? null
    : line.split(';')[0]!.slice('qianmo_session='.length)
}

async function errorOf(response: Response) {
  const body = (await response.json()) as { error: { code: string } }
  return `${response.status} ${body.error.code}`
}

async function ticketOf(s: ReturnType<typeof scene>, token: string) {
  const response = await s.handle(bearer('POST', '/v0/client/tickets', token))
  expect(response.status).toBe(201)
  return ((await response.json()) as { ticket: string }).ticket
}

/** The client's own window on Linux: the header it adds over its pipe. */
const ownWindow = (ticket: string, deviceId: string, extra = {}) =>
  new Request(`${BASE}/client/enter?ticket=${ticket}`, {
    headers: { 'sec-fetch-site': 'none', 'x-qmo-device': deviceId, ...extra },
  })

test('a qm handoff device stays fenced: no ticket, so no way into a full session', async () => {
  const s = scene()
  const ops = s.person('ops')
  const handoff = await s.pair(ops)
  expect(
    (await s.handle(bearer('GET', '/v0/accounts', handoff.token))).status,
  ).toBe(403)
  expect(
    await errorOf(
      await s.handle(bearer('POST', '/v0/client/tickets', handoff.token)),
    ),
  ).toBe('403 device_kind')

  // The same person signing in with qmo gets a client device that may.
  const client = await s.pair(ops, 'client')
  const ticket = await ticketOf(s, client.token)
  const entered = await s.handle(ownWindow(ticket, client.deviceId))
  expect(entered.status).toBe(303)
  const principal = s.book.sessionPrincipal(sessionOf(entered)!)
  expect(principal.ok && principal.value.subject).toBe(ops.subject)
})

test('an account reset retires its devices; restoring the account does not bring them back', async () => {
  const s = scene()
  const ops = s.person('ops')
  const device = await s.pair(ops, 'client')
  const pending = await ticketOf(s, device.token)
  const reset = s.book.reset(ops.subject, 'legacy:admin')
  if (!reset.ok) throw new Error('reset')
  expect(
    await errorOf(
      await s.handle(bearer('POST', '/v0/client/tickets', device.token)),
    ),
  ).toBe('401 device_revoked')
  expect(s.book.acceptInvite(reset.value.token).ok).toBe(true)
  expect(
    await errorOf(
      await s.handle(bearer('POST', '/v0/client/tickets', device.token)),
    ),
  ).toBe('401 device_revoked')
  // A ticket asked for before the reset opens nothing afterwards either.
  expect((await s.handle(ownWindow(pending, device.deviceId))).status).toBe(401)
})

test("another account's ticket in a signed-in browser is refused and swaps nothing", async () => {
  const s = scene()
  const victim = s.person('member')
  const attacker = s.person('member')
  const device = await s.pair(attacker, 'client')
  const ticket = await ticketOf(s, device.token)
  // Opened from a native app in the victim's browser: `none`, Strict cookie sent.
  const response = await s.handle(
    new Request(`${BASE}/client/enter?ticket=${ticket}`, {
      headers: {
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        cookie: `qianmo_session=${victim.sid}`,
      },
    }),
  )
  expect(response.status).toBe(409)
  expect(sessionOf(response)).toBeNull()
  expect(s.book.sessionPrincipal(victim.sid).ok).toBe(true)
  // In a browser signed in as nobody, it asks before signing anybody in.
  const fresh = await s.handle(
    new Request(`${BASE}/client/enter?ticket=${ticket}`, {
      headers: { 'sec-fetch-site': 'none' },
    }),
  )
  expect(fresh.status).toBe(200)
  expect(sessionOf(fresh)).toBeNull()
})

test('a code issued before a reset pairs nothing after the restore', async () => {
  const s = scene()
  const ops = s.person('ops')
  const stale = await s.devices.issuePairing(ops, BASE)
  if (!stale.ok) throw new Error('pairing')
  const reset = s.book.reset(ops.subject, 'legacy:admin')
  if (!reset.ok) throw new Error('reset')
  expect(s.book.acceptInvite(reset.value.token).ok).toBe(true)
  const late = await s.handle(
    new Request(`${BASE}/v0/handoff/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: stale.value.code,
        name: 'late',
        platform: 'linux-x64',
        kind: 'client',
      }),
    }),
  )
  expect(late.status).toBeGreaterThanOrEqual(400)
  expect(late.status).toBeLessThan(500)
  // A code from after the restore is the way back.
  const device = await s.pair(ops, 'client')
  const ticket = await ticketOf(s, device.token)
  expect((await s.handle(ownWindow(ticket, device.deviceId))).status).toBe(303)
})

test('a click on the confirmation marks nothing; signing out takes the mark away', async () => {
  const s = scene()
  const member = s.person('member')
  const device = await s.pair(member, 'client')
  // Somewhere that is not the client's own window: asked, then a click.
  const first = await ticketOf(s, device.token)
  expect(
    (
      await s.handle(
        new Request(`${BASE}/client/enter?ticket=${first}`, {
          headers: { 'sec-fetch-site': 'none' },
        }),
      )
    ).status,
  ).toBe(200)
  const clicked = await s.handle(
    new Request(`${BASE}/client/enter`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: `ticket=${first}`,
    }),
  )
  expect(clicked.status).toBe(303)
  expect(clientCookieOf(clicked)).toBeNull()
  // So the device's next ticket in that browser, signed out, asks again.
  const signOut = (sid: string, cookie: string) =>
    s.handle(
      new Request(`${BASE}/logout`, {
        method: 'POST',
        headers: {
          cookie: `qianmo_session=${sid}; ${cookie}`.replace(/; $/, ''),
          'sec-fetch-site': 'same-origin',
          origin: BASE,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: '',
      }),
    )
  await signOut(sessionOf(clicked)!, '')
  const second = await ticketOf(s, device.token)
  expect(
    (
      await s.handle(
        new Request(`${BASE}/client/enter?ticket=${second}`, {
          headers: { 'sec-fetch-site': 'none' },
        }),
      )
    ).status,
  ).toBe(200)

  // The client's own window is marked, and signing out there unmarks it.
  const own = await s.handle(ownWindow(second, device.deviceId))
  expect(own.status).toBe(303)
  const mark = clientCookieOf(own)!
  expect(mark).toStartWith(`qianmo_client=${device.deviceId}.`)
  const out = await signOut(sessionOf(own)!, mark)
  expect(clientCookieOf(out)).toBe('')
  // Revoking the device from a browser that carries its mark takes the mark
  // away; revoking another device from there does not. (From the window the
  // device's own ticket signed in, the revocation closes that very session,
  // and the mark it leaves can match no ticket again.)
  const marked = await s.handle(
    ownWindow(await ticketOf(s, device.token), device.deviceId),
  )
  const browser = `qianmo_session=${member.sid}; ${clientCookieOf(marked)}`
  const other = await s.pair(member, 'client')
  const fromBrowser = (deviceId: string) =>
    s.handle(
      new Request(`${BASE}/v0/handoff/devices/${deviceId}`, {
        method: 'DELETE',
        headers: {
          cookie: browser,
          'x-qianmo-console': '1',
          'sec-fetch-site': 'same-origin',
          origin: BASE,
        },
      }),
    )
  const elsewhere = await fromBrowser(other.deviceId)
  expect(elsewhere.status).toBe(200)
  expect(clientCookieOf(elsewhere)).toBeNull()
  const itself = await fromBrowser(device.deviceId)
  expect(itself.status).toBe(200)
  expect(clientCookieOf(itself)).toBe('')
})

test('eight windows racing for one ticket: one session', async () => {
  const s = scene()
  const member = s.person('member')
  const device = await s.pair(member, 'client')
  const ticket = await ticketOf(s, device.token)
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      s.handle(ownWindow(ticket, device.deviceId)),
    ),
  )
  // The losers are refusals; past five of them the login throttle answers.
  expect(results.filter(r => r.status === 303)).toHaveLength(1)
  expect(results.filter(r => sessionOf(r) !== null)).toHaveLength(1)
  for (const loser of results.filter(r => r.status !== 303))
    expect([401, 429]).toContain(loser.status)
})

test('sign-out and the 连接 page both leave a revoke line; members see only their devices', async () => {
  const s = scene()
  const member = s.person('member')
  const other = s.person('member')
  const ops = s.person('ops')
  const signingOut = await s.pair(member, 'client')
  const fromPage = await s.pair(member, 'client')
  await s.pair(other, 'client')
  const listed = async (sid: string) => {
    const response = await s.handle(session('GET', '/v0/handoff/devices', sid))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { devices: { owner: string }[] }
    return body.devices.map(d => d.owner)
  }
  expect(await listed(member.sid)).toEqual([member.subject, member.subject])
  expect(await listed(other.sid)).toEqual([other.subject])
  expect((await listed(ops.sid)).length).toBe(3)
  const connect = await s.handle(session('GET', '/admin/connect', member.sid))
  expect(await connect.text()).not.toContain(other.subject)

  expect(
    (await s.handle(bearer('DELETE', '/v0/client/device', signingOut.token)))
      .status,
  ).toBe(204)
  expect(
    (
      await s.handle(
        session(
          'DELETE',
          `/v0/handoff/devices/${fromPage.deviceId}`,
          member.sid,
        ),
      )
    ).status,
  ).toBe(200)
  expect(
    s.actions
      .filter(a => a.action === 'handoff.device.revoke')
      .map(a => [a.subject, a.target, a.outcome]),
  ).toEqual([
    [member.subject, signingOut.deviceId, 'ok'],
    [member.subject, fromPage.deviceId, 'ok'],
  ])
})
