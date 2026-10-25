// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The door the `qmo` client opens the front through (clients.md §3.2): a
 * device paired by `qmo sign-in` trades its token for a one-time ticket, and
 * the window the client opens redeems the ticket for an ordinary personal
 * session.
 *
 * | Method | Path | Who | Returns |
 * | --- | --- | --- | --- |
 * | POST | `/v0/client/tickets` | a client device | 201 `{ id, ticket, expiresAt }` |
 * | GET | `/v0/client/tickets/<id>` | the device that asked for it | `{ id, state }` |
 * | GET | `/v0/client/device` | device | `{ deviceId }` |
 * | DELETE | `/v0/client/device` | device | 204, the device revoked |
 * | GET | `/client/enter?ticket=…` | public, never cross-site | 303 to `/`, or the confirmation |
 * | POST | `/client/enter` | the confirmation, same origin only | 303 to `/` with the session cookie |
 *
 * Only a console with personal accounts has these: a session there is a row
 * on the server that can be opened for the device's owner. Without accounts
 * the browser cookie *is* the console token, which a device must never be
 * able to mint, so the paths stay the 404 they always were and the client
 * opens `/login` instead.
 *
 * Only a device paired as a client may ask for a ticket. A `qm handoff login`
 * token is fenced to the handoff routes (`access.ts`), and a ticket would be
 * a way round that fence into a full session at its owner's role.
 *
 * The device token never reaches the browser. The ticket does, once: it rides
 * in the first request line of the window's navigation and the 303 takes it
 * out of the address bar. It lives 60 s, is spent by its first use, and only
 * its hash is kept, in memory. A ticket arriving from another site is refused
 * without spending it — the same login-CSRF rule as `POST /login`.
 *
 * `Sec-Fetch-Site: none` is not enough on its own, though: a link opened from
 * a mail or chat program is `none` too, and would sign whatever browser it
 * lands in into the ticket's account. So a ticket goes straight through only
 * in the window it was made for — one carrying the `X-Qmo-Device` header the
 * Linux client adds over its DevTools pipe, which no page can put on a
 * navigation, or the client cookie only such an entry sets. Anywhere else,
 * the Windows client's window included, the window shows who it will sign in
 * as and waits for a click, and the click sets no cookie: a ticket of the
 * same device opened in that browser later asks again. A browser already
 * signed in as somebody else is refused outright, and signing out or in, or
 * revoking the device from the browser, takes the cookie away.
 */

import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import {
  ACCOUNT_SESSION_COOKIE,
  accountSessionCookie,
  type ConsoleAccounts,
} from './access.js'
import {
  bearerOf,
  type ConsoleTokens,
  clearedSessionCookieHeader,
  cookieOf,
  isCrossOriginRequest,
  isSecureRequest,
  roleOfToken,
  SESSION_COOKIE,
} from './auth.js'
import type { CodeLinksPort } from './codeRemote.js'
import type { ActionLedgerPort } from './deps.js'
import type {
  HandoffDeviceIdentity,
  HandoffDeviceRefusal,
  HandoffDevicesPort,
} from './directionPorts.js'
import {
  fail,
  json,
  methodNotAllowed,
  notFound,
  readForm,
  seeOther,
} from './respond.js'
import { outcomeOf } from './routes/shared.js'
import type { LoginThrottle } from './throttle.js'

/** How long a ticket can wait for its window. */
const CLIENT_TICKET_TTL_MS = 60_000

/** Unspent tickets one device may hold at once. */
const MAX_OPEN_CLIENT_TICKETS = 4

/** Tickets one device may ask for in a minute, spent or not. */
const MAX_CLIENT_TICKETS_PER_MINUTE = 20

/** Unspent tickets all of one account's devices may hold at once. */
const MAX_OPEN_TICKETS_PER_ACCOUNT = 8

/** Unspent tickets the whole console holds before it stops issuing. */
const MAX_PENDING_TICKETS = 1000

/** How long a ticket still answers its status after it expired. */
const SETTLED_KEEP_MS = 10_000

const TICKET = /^qmt_[A-Za-z0-9_-]{43}$/
const TICKET_ID = /^t-[a-z2-7]{12}$/
const DEVICE_TOKEN = /^qmd_[A-Za-z0-9_-]{43}$/
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** Where a redeemed window lands. */
const FRONT = '/'

/** The header the Linux client sets on its window over the DevTools pipe. */
const DEVICE_HEADER = 'x-qmo-device'

/**
 * The client cookie: which device's window this browser profile is. On HTTPS
 * the `__Host-` prefix keeps a sibling subdomain from planting one.
 */
const DEVICE_COOKIE_SECURE = '__Host-qianmo_client'
const DEVICE_COOKIE_PLAIN = 'qianmo_client'

/** 400 days, the longest a browser keeps a cookie. */
const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60

type ClientTicketState = 'pending' | 'used' | 'expired'

interface Ticket {
  readonly id: string
  readonly hash: string
  readonly deviceId: string
  readonly owner: string
  readonly issuedAt: number
  readonly expiresAt: number
  used: boolean
}

interface IssuedClientTicket {
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
 * The console's tickets, in memory.
 *
 * Nothing here is persisted: a restarted console has no tickets, and a client
 * asks for a new one each time it opens a window. A spent ticket stops
 * counting at once; it stays only to answer its status until shortly after it
 * would have expired.
 */
export class ClientTickets {
  /** Unspent tickets, by the hash of the ticket itself. */
  readonly #pending = new Map<string, Ticket>()
  /** Every ticket still answering its status, by id. */
  readonly #byId = new Map<string, Ticket>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** A fresh ticket for `device`, or why there is none. */
  issue(
    device: HandoffDeviceIdentity,
  ): IssuedClientTicket | 'too_many' | 'account_full' | 'too_fast' | 'full' {
    const now = this.#now()
    this.#prune(now)
    let open = 0
    let recent = 0
    for (const ticket of this.#byId.values()) {
      if (ticket.deviceId !== device.deviceId) continue
      if (!ticket.used && now < ticket.expiresAt) open += 1
      if (now - ticket.issuedAt < 60_000) recent += 1
    }
    // Pending is unspent and unexpired already: pruned above.
    let owned = 0
    for (const ticket of this.#pending.values())
      if (ticket.owner === device.owner) owned += 1
    if (open >= MAX_OPEN_CLIENT_TICKETS) return 'too_many'
    if (owned >= MAX_OPEN_TICKETS_PER_ACCOUNT) return 'account_full'
    if (recent >= MAX_CLIENT_TICKETS_PER_MINUTE) return 'too_fast'
    if (this.#pending.size >= MAX_PENDING_TICKETS) return 'full'
    const ticket = `qmt_${randomBytes(32).toString('base64url')}`
    let id = ticketId()
    while (this.#byId.has(id)) id = ticketId()
    const entry: Ticket = {
      id,
      hash: digest(ticket),
      deviceId: device.deviceId,
      owner: device.owner,
      issuedAt: now,
      expiresAt: now + CLIENT_TICKET_TTL_MS,
      used: false,
    }
    this.#pending.set(entry.hash, entry)
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

  /** The unspent ticket behind `ticket`, left unspent; `null` for any other. */
  peek(ticket: string): Ticket | null {
    this.#prune(this.#now())
    return this.#pending.get(digest(ticket)) ?? null
  }

  /** Spend a ticket. `null` for one that is unknown, spent or expired. */
  redeem(ticket: string): Ticket | null {
    const entry = this.peek(ticket)
    if (entry === null) return null
    entry.used = true
    this.#pending.delete(entry.hash)
    return entry
  }

  /** A revoked device's unspent tickets stop working at once. */
  endDevice(deviceId: string): void {
    this.#end(ticket => ticket.deviceId === deviceId)
  }

  /** So do those of every device of an account that was revoked or reset. */
  endOwner(owner: string): void {
    this.#end(ticket => ticket.owner === owner)
  }

  #end(match: (ticket: Ticket) => boolean): void {
    for (const ticket of this.#pending.values()) {
      if (!match(ticket)) continue
      ticket.used = true
      this.#pending.delete(ticket.hash)
    }
  }

  #prune(now: number): void {
    for (const ticket of this.#pending.values()) {
      if (now >= ticket.expiresAt) this.#pending.delete(ticket.hash)
    }
    for (const ticket of this.#byId.values()) {
      if (now >= ticket.expiresAt + SETTLED_KEEP_MS)
        this.#byId.delete(ticket.id)
    }
  }
}

/**
 * The device port with revocation ending what the device opened: its unspent
 * tickets, and the sessions they opened (kept in the session table, so this
 * holds across a restart). Every revocation goes through the port, whoever
 * asks for it, so wrapping it once covers the device list on the 连接 page
 * and the client's own sign-out.
 */
export function closingClientSessions(
  devices: HandoffDevicesPort,
  tickets: ClientTickets,
  accounts: ConsoleAccounts,
  links?: CodeLinksPort,
): HandoffDevicesPort {
  return {
    ...(devices.authenticate === undefined
      ? {}
      : { authenticate: token => devices.authenticate!(token) }),
    ...(devices.refusalOf === undefined
      ? {}
      : { refusalOf: token => devices.refusalOf!(token) }),
    ...(devices.pair === undefined
      ? {}
      : { pair: (input, remoteAddr) => devices.pair!(input, remoteAddr) }),
    listDevices: () => devices.listDevices(),
    issuePairing: (actor, consoleUrl) =>
      devices.issuePairing(actor, consoleUrl),
    async revokeDevice(deviceId, actor) {
      const result = await devices.revokeDevice(deviceId, actor)
      if (result.ok) {
        tickets.endDevice(deviceId)
        accounts.book.endDeviceSessions(deviceId)
        // Its link closes and its Remote copies go (P37.15).
        links?.endDevice(deviceId, result.value.owner)
      }
      return result
    },
  }
}

/** The key the client cookie is signed with, from the console's admin token. */
export function clientCookieKey(tokens: ConsoleTokens): Buffer {
  return createHmac('sha256', tokens.admin)
    .update('qmo-client-device/v1')
    .digest()
}

/** What one request to the door needs. */
interface ClientDoorContext {
  readonly request: Request
  readonly url: URL
  readonly devices: HandoffDevicesPort | undefined
  readonly accounts: ConsoleAccounts
  readonly tokens: ConsoleTokens
  readonly cookieKey: Buffer
  readonly tickets: ClientTickets
  /** The device link's table, when this hub has Remote (P37.15). */
  readonly links: CodeLinksPort | undefined
  readonly throttle: LoginThrottle
  readonly clientKey: string
  readonly actions: ActionLedgerPort | undefined
  readonly now: number
  /** The login page with one sentence on it, for a window that was not signed in. */
  readonly card: (status: number, error: string) => Response
  /** The confirmation that spends `ticket` on a click. */
  readonly confirm: (
    account: string,
    subject: string,
    device: string,
    ticket: string,
  ) => Response
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
const OTHER_ACCOUNT =
  '这个浏览器已经以另一个账号登录 · 先在前台退出 · 或从阡陌客户端自己的窗口打开'

function deviceCookieName(request: Request): string {
  return isSecureRequest(request) ? DEVICE_COOKIE_SECURE : DEVICE_COOKIE_PLAIN
}

function deviceCookieValue(key: Buffer, deviceId: string): string {
  const mac = createHmac('sha256', key).update(deviceId).digest('base64url')
  return `${deviceId}.${mac}`
}

/** The client cookie, as a `Set-Cookie` line; `value` empty clears it. */
function deviceCookie(request: Request, value: string): string {
  const secure = isSecureRequest(request)
  return [
    `${deviceCookieName(request)}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${value === '' ? 0 : DEVICE_COOKIE_MAX_AGE_SECONDS}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

/** The `Set-Cookie` that takes this browser's client cookie away, on sign-out and sign-in. */
export function clearedClientCookie(request: Request): string {
  return deviceCookie(request, '')
}

/** The same, when the cookie this browser carries is `deviceId`'s; else `null`. */
export function clearedClientCookieFor(
  request: Request,
  deviceId: string,
): string | null {
  return cookieOf(request, deviceCookieName(request)).startsWith(`${deviceId}.`)
    ? clearedClientCookie(request)
    : null
}

/** Whether the client itself put this navigation in `deviceId`'s window. */
function fromClient(ctx: ClientDoorContext, deviceId: string): boolean {
  return ctx.request.headers.get(DEVICE_HEADER) === deviceId
}

/** Whether this browser profile is `deviceId`'s own window. */
function isDeviceWindow(ctx: ClientDoorContext, deviceId: string): boolean {
  if (fromClient(ctx, deviceId)) return true
  const presented = Buffer.from(
    cookieOf(ctx.request, deviceCookieName(ctx.request)),
  )
  const expected = Buffer.from(deviceCookieValue(ctx.cookieKey, deviceId))
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  )
}

/** Whether the browser is signed in as somebody other than `owner`. */
function signedInAsAnother(ctx: ClientDoorContext, owner: string): boolean {
  const legacy = cookieOf(ctx.request, SESSION_COOKIE)
  if (legacy !== '' && roleOfToken(legacy, ctx.tokens) !== 'none') return true
  const sid = cookieOf(ctx.request, ACCOUNT_SESSION_COOKIE)
  if (sid === '') return false
  const current = ctx.accounts.book.sessionPrincipal(sid, false)
  return current.ok && current.value.subject !== owner
}

/**
 * The name the confirmation shows for `owner`: its note, else its subject.
 * The note is whatever the person typed at signup, so the page shows the
 * subject beside it as well.
 */
function accountName(ctx: ClientDoorContext, owner: string): string {
  const listed = ctx.accounts.book.list()
  const account = listed.ok
    ? listed.value.accounts.find(a => a.subject === owner)
    : undefined
  return account?.label ?? owner
}

/** `GET` and `POST /client/enter`. */
async function enter(ctx: ClientDoorContext): Promise<Response> {
  const { request, throttle, clientKey, now } = ctx
  const post = request.method === 'POST'
  if (!post && request.method !== 'GET')
    return methodNotAllowed(['GET', 'POST'])
  if (
    post ? !isSameOriginPost(request, ctx.url) : isCrossOriginRequest(request)
  )
    return ctx.card(403, '阡陌客户端的票据只能由客户端自己打开')
  const wait = throttle.retryAfterSeconds(clientKey, now)
  if (wait > 0) return ctx.card(429, `尝试过多 · ${wait} 秒后再试`)
  const presented = post
    ? ((await readForm(request))?.get('ticket') ?? '')
    : (ctx.url.searchParams.get('ticket') ?? '')
  const ticket = TICKET.test(presented) ? ctx.tickets.peek(presented) : null
  if (ticket === null) {
    throttle.recordFailure(clientKey, now)
    return ctx.card(401, ENTER_REFUSED)
  }
  if (signedInAsAnother(ctx, ticket.owner)) return ctx.card(409, OTHER_ACCOUNT)
  const own = isDeviceWindow(ctx, ticket.deviceId)
  if (!post && !own)
    return ctx.confirm(
      accountName(ctx, ticket.owner),
      ticket.owner,
      ticket.deviceId,
      presented,
    )
  ctx.tickets.redeem(presented)
  const previous = cookieOf(request, ACCOUNT_SESSION_COOKIE)
  const opened = ctx.accounts.book.sessionFor(
    ticket.owner as `u:${string}`,
    previous,
    ticket.deviceId,
  )
  if (!opened.ok) {
    return opened.refusal.code === 'unavailable'
      ? ctx.card(503, '账号暂时不可用 · 稍后再试')
      : ctx.card(403, '这台设备的属主账号不能登录')
  }
  throttle.clear(clientKey)
  const secure = isSecureRequest(request)
  const response = seeOther(FRONT)
  response.headers.append(
    'set-cookie',
    accountSessionCookie(opened.value.sid, secure),
  )
  response.headers.append('set-cookie', clearedSessionCookieHeader({ secure }))
  // Only the client's own navigation marks the profile; a click on the
  // confirmation proves nothing about which browser it was.
  if (fromClient(ctx, ticket.deviceId))
    response.headers.append(
      'set-cookie',
      deviceCookie(request, deviceCookieValue(ctx.cookieKey, ticket.deviceId)),
    )
  return response
}

/**
 * The confirmation's own form, and nothing else: `same-origin`, or for a
 * browser that sends no fetch metadata an `Origin` of this very console.
 */
function isSameOriginPost(request: Request, url: URL): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site !== null) return site === 'same-origin'
  return request.headers.get('origin') === url.origin
}

const REFUSALS: Readonly<Record<HandoffDeviceRefusal, string>> = {
  device_revoked: '这台设备已被吊销',
  owner_inactive: '这台设备所属的账号已停用或正在重置',
  unauthorized: '设备令牌无效',
}

/** The `/v0/client/…` routes, each for the device whose token is presented. */
async function api(
  ctx: ClientDoorContext,
  rest: readonly string[],
): Promise<Response> {
  const { request, devices } = ctx
  // Only these four paths are the door's; anything else under it is the
  // router's plain 404, whoever asks.
  const known =
    (rest.length === 1 &&
      (rest[0] === 'device' || rest[0] === 'tickets' || rest[0] === 'link')) ||
    (rest.length === 2 && rest[0] === 'tickets')
  if (!known) return notFound(`unknown path: ${ctx.url.pathname}`)
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
  if (device === null) {
    const why = devices.refusalOf?.(token) ?? 'unauthorized'
    return fail(401, why, REFUSALS[why])
  }

  // The device link (P37.15) is a WebSocket, upgraded before this handler
  // (`codeLink.ts`). Here is only a request without the upgrade: the
  // runner's question whether this hub has the link at all — 426 when it
  // has (a proxy in front dropped the upgrade), 501 when Remote is not wired.
  if (rest[0] === 'link')
    return ctx.links === undefined
      ? fail(501, 'unsupported', '这台中枢没有开 Remote')
      : fail(426, 'upgrade_required', '设备链路要用 WebSocket 连')

  if (rest[0] === 'device' && rest.length === 1) {
    if (request.method === 'GET')
      return json({ deviceId: device.deviceId, kind: device.kind })
    if (request.method !== 'DELETE') return methodNotAllowed(['GET', 'DELETE'])
    const result = await devices.revokeDevice(device.deviceId, {
      subject: device.owner,
      role: device.owner.startsWith('u:') ? 'member' : null,
      requestId: `client-${device.deviceId}`,
    })
    await record(ctx, device.owner, device.deviceId, result)
    if (!result.ok) return fail(409, 'refused', result.failure.message)
    return new Response(null, { status: 204 })
  }

  if (rest.length === 2) {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    const id = rest[1]!
    const state = TICKET_ID.test(id)
      ? ctx.tickets.state(id, device.deviceId)
      : null
    return state === null ? notFound('没有这张票据') : json({ id, state })
  }

  if (request.method !== 'POST') return methodNotAllowed(['POST'])
  if (device.kind !== 'client')
    return fail(
      403,
      'device_kind',
      '这台设备是用 qm handoff login 配对的接力设备，不能打开前台',
    )
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
  if (issued === 'account_full')
    return fail(429, 'limit', '这个账号的设备还有没用掉的票据，稍后再试')
  if (issued === 'too_fast')
    return fail(429, 'limit', '这台设备要票据太频繁，稍后再试')
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

/** The action-ledger line a device signing itself out leaves, as the 连接 page's does. */
async function record(
  ctx: ClientDoorContext,
  subject: string,
  deviceId: string,
  result: Parameters<typeof outcomeOf>[0],
): Promise<void> {
  if (ctx.actions === undefined) return
  const [outcome, code] = outcomeOf(result)
  try {
    await ctx.actions.record({
      at: ctx.now,
      requestId: randomUUID(),
      subject,
      action: 'handoff.device.revoke',
      target: deviceId,
      outcome,
      ...(code === undefined ? {} : { code }),
    })
  } catch {
    // Never fails the sign-out: the device is already revoked.
  }
}
