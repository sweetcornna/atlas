// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The door the `qmo` client opens the front through (clients.md §3.2): a
 * paired device trades its token for a one-time ticket, and the window the
 * client opens redeems the ticket for an ordinary personal session.
 *
 * | Method | Path | Who | Returns |
 * | --- | --- | --- | --- |
 * | POST | `/v0/client/tickets` | device | 201 `{ id, ticket, expiresAt }` |
 * | GET | `/v0/client/tickets/<id>` | the device that asked for it | `{ id, state }` |
 * | GET | `/v0/client/device` | device | `{ deviceId }` |
 * | DELETE | `/v0/client/device` | device | 204, the device revoked |
 * | GET | `/client/enter?ticket=…` | public, never cross-site | 303 to `/` with the session cookie |
 *
 * Only a console with personal accounts has these: a session there is a row
 * on the server that can be opened for the device's owner. Without accounts
 * the browser cookie *is* the console token, which a device must never be
 * able to mint, so the paths stay the 404 they always were and the client
 * opens `/login` instead.
 *
 * The device token never reaches the browser. The ticket does, once: it rides
 * in the first request line of the window's navigation and the 303 takes it
 * out of the address bar. It lives 60 s, is spent by its first use, and only
 * its hash is kept, in memory. A ticket arriving from another site is refused
 * without spending it — the same login-CSRF rule as `POST /login`.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  ACCOUNT_SESSION_COOKIE,
  accountSessionCookie,
  type ConsoleAccounts,
} from './access.js'
import {
  bearerOf,
  clearedSessionCookieHeader,
  cookieOf,
  isCrossOriginRequest,
  isSecureRequest,
} from './auth.js'
import type {
  HandoffDeviceIdentity,
  HandoffDevicesPort,
} from './directionPorts.js'
import { fail, json, methodNotAllowed, notFound, seeOther } from './respond.js'
import type { LoginThrottle } from './throttle.js'

/** How long a ticket can wait for its window. */
export const CLIENT_TICKET_TTL_MS = 60_000

/** Unspent tickets one device may hold at once. */
export const MAX_OPEN_CLIENT_TICKETS = 4

/** Tickets the whole console holds before it stops issuing. */
const MAX_TICKETS = 1000

/** How long a spent or expired ticket still answers its status. */
const SETTLED_KEEP_MS = 5 * 60_000

const TICKET = /^qmt_[A-Za-z0-9_-]{43}$/
const TICKET_ID = /^t-[a-z2-7]{12}$/
const DEVICE_TOKEN = /^qmd_[A-Za-z0-9_-]{43}$/
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** Where a redeemed window lands. */
const FRONT = '/'

export type ClientTicketState = 'pending' | 'used' | 'expired'

interface Ticket {
  readonly id: string
  readonly hash: string
  readonly deviceId: string
  readonly owner: string
  readonly expiresAt: number
  used: boolean
}

export interface IssuedClientTicket {
  readonly id: string
  readonly ticket: string
  readonly expiresAt: number
}

const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

function ticketId(): string {
  let id = 't-'
  for (const byte of randomBytes(12)) id += BASE32[byte % 32]
  return id
}

/**
 * The console's tickets and the sessions they opened, in memory.
 *
 * Nothing here is persisted: a restarted console has no tickets, and a client
 * asks for a new one each time it opens a window. The sessions a device opened
 * are remembered so revoking the device can close them; after a restart that
 * memory is gone and those sessions end by their own idle and absolute limits.
 */
export class ClientTickets {
  readonly #byHash = new Map<string, Ticket>()
  readonly #byId = new Map<string, Ticket>()
  readonly #sessions = new Map<string, Set<string>>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** A fresh ticket for `device`, or why there is none. */
  issue(
    device: HandoffDeviceIdentity,
  ): IssuedClientTicket | 'too_many' | 'full' {
    const now = this.#now()
    this.#prune(now)
    let open = 0
    for (const ticket of this.#byId.values()) {
      if (ticket.deviceId === device.deviceId && this.#pending(ticket, now))
        open += 1
    }
    if (open >= MAX_OPEN_CLIENT_TICKETS) return 'too_many'
    if (this.#byId.size >= MAX_TICKETS) return 'full'
    const ticket = `qmt_${randomBytes(32).toString('base64url')}`
    let id = ticketId()
    while (this.#byId.has(id)) id = ticketId()
    const entry: Ticket = {
      id,
      hash: digest(ticket),
      deviceId: device.deviceId,
      owner: device.owner,
      expiresAt: now + CLIENT_TICKET_TTL_MS,
      used: false,
    }
    this.#byHash.set(entry.hash, entry)
    this.#byId.set(id, entry)
    return { id, ticket, expiresAt: entry.expiresAt }
  }

  /** The state of one of `deviceId`'s tickets; another device's is `null`. */
  state(id: string, deviceId: string): ClientTicketState | null {
    const now = this.#now()
    this.#prune(now)
    const ticket = this.#byId.get(id)
    if (ticket === undefined || ticket.deviceId !== deviceId) return null
    if (ticket.used) return 'used'
    return now < ticket.expiresAt ? 'pending' : 'expired'
  }

  /** Spend a ticket. `null` for one that is unknown, spent or expired. */
  redeem(ticket: string): Ticket | null {
    const now = this.#now()
    this.#prune(now)
    const entry = this.#byHash.get(digest(ticket))
    if (entry === undefined || !this.#pending(entry, now)) return null
    entry.used = true
    return entry
  }

  /** Remember that `deviceId`'s ticket opened session `sid`. */
  opened(deviceId: string, sid: string): void {
    const sids = this.#sessions.get(deviceId) ?? new Set<string>()
    sids.add(sid)
    this.#sessions.set(deviceId, sids)
  }

  /**
   * Forget a revoked device: its unspent tickets stop working at once, and the
   * sessions its tickets opened are handed back for the caller to close.
   */
  endDevice(deviceId: string): string[] {
    for (const ticket of this.#byId.values()) {
      if (ticket.deviceId === deviceId) ticket.used = true
    }
    const sids = [...(this.#sessions.get(deviceId) ?? [])]
    this.#sessions.delete(deviceId)
    return sids
  }

  #pending(ticket: Ticket, now: number): boolean {
    return !ticket.used && now < ticket.expiresAt
  }

  #prune(now: number): void {
    for (const ticket of this.#byId.values()) {
      if (now >= ticket.expiresAt + SETTLED_KEEP_MS) {
        this.#byId.delete(ticket.id)
        this.#byHash.delete(ticket.hash)
      }
    }
  }
}

/**
 * The device port with revocation closing what the device's tickets opened.
 * Every revocation goes through the port, whoever asks for it, so wrapping it
 * once covers the device list on the 连接 page and the client's own sign-out.
 */
export function closingClientSessions(
  devices: HandoffDevicesPort,
  tickets: ClientTickets,
  accounts: ConsoleAccounts,
): HandoffDevicesPort {
  return {
    ...(devices.authenticate === undefined
      ? {}
      : { authenticate: token => devices.authenticate!(token) }),
    ...(devices.pair === undefined
      ? {}
      : { pair: (input, remoteAddr) => devices.pair!(input, remoteAddr) }),
    listDevices: () => devices.listDevices(),
    issuePairing: (actor, consoleUrl) =>
      devices.issuePairing(actor, consoleUrl),
    async revokeDevice(deviceId, actor) {
      const result = await devices.revokeDevice(deviceId, actor)
      if (result.ok) {
        for (const sid of tickets.endDevice(deviceId)) accounts.book.logout(sid)
      }
      return result
    },
  }
}

/** What one request to the door needs. */
export interface ClientDoorContext {
  readonly request: Request
  readonly url: URL
  readonly devices: HandoffDevicesPort | undefined
  readonly accounts: ConsoleAccounts
  readonly tickets: ClientTickets
  readonly throttle: LoginThrottle
  readonly clientKey: string
  readonly now: number
  /** The login page with one sentence on it, for a window that was not signed in. */
  readonly card: (status: number, error: string) => Response
}

/** Whether `segments` name this door. */
export function isClientDoor(segments: readonly string[]): boolean {
  return (
    (segments[0] === 'client' && segments[1] === 'enter') ||
    (segments[0] === 'v0' && segments[1] === 'client')
  )
}

export async function serveClientDoor(
  ctx: ClientDoorContext,
  segments: readonly string[],
): Promise<Response> {
  if (segments[0] === 'client') {
    if (segments.length !== 2)
      return notFound(`unknown path: ${ctx.url.pathname}`)
    return enter(ctx)
  }
  return api(ctx, segments.slice(2))
}

const ENTER_REFUSED = '这张票据无效或已经用过 · 请从阡陌客户端重新打开'

/** `GET /client/enter?ticket=…`: spend the ticket, open the owner's session. */
function enter(ctx: ClientDoorContext): Response {
  const { request, url, throttle, clientKey, now } = ctx
  if (request.method !== 'GET') return methodNotAllowed(['GET'])
  if (isCrossOriginRequest(request)) {
    return ctx.card(403, '阡陌客户端的票据只能由客户端自己打开')
  }
  const wait = throttle.retryAfterSeconds(clientKey, now)
  if (wait > 0) return ctx.card(429, `尝试过多 · ${wait} 秒后再试`)
  const presented = url.searchParams.get('ticket') ?? ''
  const ticket = TICKET.test(presented) ? ctx.tickets.redeem(presented) : null
  if (ticket === null) {
    throttle.recordFailure(clientKey, now)
    return ctx.card(401, ENTER_REFUSED)
  }
  const previous = cookieOf(request, ACCOUNT_SESSION_COOKIE)
  const opened = ctx.accounts.book.sessionFor(
    ticket.owner as `u:${string}`,
    previous,
  )
  if (!opened.ok) {
    return opened.refusal.code === 'unavailable'
      ? ctx.card(503, '账号暂时不可用 · 稍后再试')
      : ctx.card(403, '这台设备的属主账号不能登录')
  }
  throttle.clear(clientKey)
  ctx.tickets.opened(ticket.deviceId, opened.value.sid)
  const secure = isSecureRequest(request)
  const response = seeOther(FRONT)
  response.headers.append(
    'set-cookie',
    accountSessionCookie(opened.value.sid, secure),
  )
  response.headers.append('set-cookie', clearedSessionCookieHeader({ secure }))
  return response
}

/** The `/v0/client/…` routes, each for the device whose token is presented. */
async function api(
  ctx: ClientDoorContext,
  rest: readonly string[],
): Promise<Response> {
  const { request, devices } = ctx
  if (ctx.url.searchParams.has('token'))
    return fail(
      400,
      'invalid',
      '凭据不能放进链接，请使用 Authorization: Bearer',
    )
  const token = bearerOf(request)
  if (!DEVICE_TOKEN.test(token))
    return fail(401, 'unauthorized', '需要这台设备的令牌')
  if (devices?.authenticate === undefined)
    return fail(501, 'unsupported', '设备配对未接入')
  const device = devices.authenticate(token)
  if (device === null) return fail(401, 'unauthorized', '设备令牌无效或已吊销')

  if (rest[0] === 'device' && rest.length === 1) {
    if (request.method === 'GET') return json({ deviceId: device.deviceId })
    if (request.method !== 'DELETE') return methodNotAllowed(['GET', 'DELETE'])
    const result = await devices.revokeDevice(device.deviceId, {
      subject: device.owner,
      role: device.owner.startsWith('u:') ? 'member' : null,
      requestId: `client-${device.deviceId}`,
    })
    if (!result.ok) return fail(409, 'refused', result.failure.message)
    return new Response(null, { status: 204 })
  }

  if (rest[0] !== 'tickets' || rest.length > 2)
    return notFound(`unknown path: ${ctx.url.pathname}`)

  if (rest.length === 2) {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    const id = rest[1]!
    const state = TICKET_ID.test(id)
      ? ctx.tickets.state(id, device.deviceId)
      : null
    return state === null ? notFound('没有这张票据') : json({ id, state })
  }

  if (request.method !== 'POST') return methodNotAllowed(['POST'])
  // A device paired with the legacy admin token has no account to open.
  if (!device.owner.startsWith('u:'))
    return fail(
      403,
      'forbidden',
      '这台设备由旧式令牌配对，没有可登录的账号；请用个人账号重新配对',
    )
  const issued = ctx.tickets.issue(device)
  if (issued === 'too_many')
    return fail(429, 'limit', '这台设备还有没用掉的票据，稍后再试')
  if (issued === 'full') return fail(503, 'unavailable', '票据太多，稍后再试')
  return json(
    {
      id: issued.id,
      ticket: issued.ticket,
      expiresAt: new Date(issued.expiresAt).toISOString(),
    },
    201,
    { 'cache-control': 'no-store' },
  )
}
