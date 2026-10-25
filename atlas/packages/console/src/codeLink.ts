// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The device link (P37.15, `docs/dev/qmo-local.md` §5.1): the one place a
 * device dials the hub rather than the other way round. A desktop app's
 * runner — `qmo code serve`, the process that holds the device token —
 * opens `GET /v0/client/link` as a WebSocket while one of its local
 * sessions has Remote on, pushes those sessions' heads and records, and
 * takes the lines, answers and stops people send them from elsewhere.
 *
 * Who may dial is decided before the upgrade, with the same checks as the
 * client door's routes (`clientDoor.ts`): a console with personal accounts,
 * a token the device ledger authenticates, a device paired as a client, a
 * personal account behind it, and in the public edition an active
 * subscription. A browser cannot put `Authorization` on a WebSocket and the
 * hub reads no cookie here, so no page anywhere can open a link. Server
 * nodes keep "the hub dials, the node never does" (H-2): only a client
 * device's own link goes this way.
 *
 * The table here is the device's 设备节点: device id → its owner and its
 * socket, online while the socket is. It is not the registry's roster: a
 * personal computer serves no agents and is nobody's but its owner's. A
 * second link of one device replaces the first (4409).
 *
 * Revocation ends a link at once: revoking a device (the 连接 page,
 * `qmo sign-out`; both go through the device port, wrapped in `http.ts`) and
 * an account revoked or reset (`onAccountEnded`) close its links with 4401
 * and drop its copies. What has no event — an account made read-only, a
 * subscription run out — is caught by re-checking every link's token and
 * subscription every 30 s; the token is held in memory for that, for the
 * link's life, and is never written or logged.
 */

import type { ConsoleAccounts } from './access.js'
import { bearerOf } from './auth.js'
import {
  CODE_DEVICE_ID,
  CODE_LINK_MAX_FRAME,
  CODE_LINK_PATH,
  CODE_LINK_PROTOCOL,
  CODE_SESSION_ID,
  type CodeCopiesPort,
  type CodeCopyRecord,
  codeHeaderOf,
  codeRecordOf,
  type CodeCopy,
  type CodeLinksPort,
  type LinkReply,
  type LinkRequest,
} from './codeRemote.js'
import type { BillingPort, HandoffDevicesPort } from './directionPorts.js'
import { fail } from './respond.js'
import type { TenantPort } from './tenancy.js'

const DEVICE_TOKEN = /^qmd_[A-Za-z0-9_-]{43}$/

/** How often every link's token and subscription are checked again. */
const CODE_LINK_RECHECK_MS = 30_000

/** How long a line, an answer or a stop waits for the runner's reply. */
export const CODE_LINK_REPLY_MS = 10_000

/** Close codes (§5.1). The runner does not redial after 4401, 4402 or 4403. */
export const LINK_CLOSE = {
  /** A frame the hub does not take. */
  badFrame: 4400,
  /** The device is revoked, or its token is no longer known. */
  revoked: 4401,
  /** The public edition's subscription ran out. */
  subscription: 4402,
  /** The device's account is inactive or read-only. */
  inactive: 4403,
  /** Another link of the same device took over. */
  replaced: 4409,
  /** The hub is going away. */
  going: 1001,
} as const

const REFUSAL_WORDS = {
  device_revoked: '这台设备已被吊销',
  owner_inactive: '这台设备所属的账号已停用或正在重置',
  unauthorized: '设备令牌无效',
} as const

/** Just enough of a Bun server for an upgrade. */
interface LinkUpgradeServer {
  upgrade(
    request: Request,
    options: { data: LinkData; headers?: Record<string, string> },
  ): boolean
}

/** Just enough of a Bun server-side WebSocket. */
interface LinkSocket {
  readonly data: LinkData
  send(data: string): unknown
  close(code?: number, reason?: string): void
}

/** What an upgraded socket carries. */
export interface LinkData {
  readonly deviceId: string
  readonly owner: string
  /** Kept for the 30 s re-check; never written anywhere. */
  readonly token: string
  readonly serial: number
}

interface Link {
  readonly socket: LinkSocket
  readonly deviceId: string
  readonly owner: string
  readonly token: string
  readonly serial: number
  hello: boolean
  readonly waiting: Map<
    number,
    {
      resolve: (reply: LinkReply) => void
      timer: ReturnType<typeof setTimeout>
    }
  >
}

interface CodeLinksOptions {
  readonly devices: HandoffDevicesPort
  readonly accounts: ConsoleAccounts
  readonly copies: CodeCopiesPort
  readonly billing?: BillingPort
  /** Who the platform's own people are: never gated, as in `billingDoors.ts`. */
  readonly tenancy?: TenantPort
  readonly log?: (line: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The frames a runner sends; anything else closes the link. */
const UP = ['hello', 'session', 'records', 'gone', 'reply'] as const

export class CodeLinks implements CodeLinksPort {
  readonly #options: CodeLinksOptions
  readonly #links = new Map<string, Link>()
  readonly #listeners = new Map<string, Set<() => void>>()
  #serial = 0
  #request = 0
  #rev = 0
  #recheck: ReturnType<typeof setInterval> | undefined

  constructor(options: CodeLinksOptions) {
    this.#options = options
  }

  #log(line: string): void {
    this.#options.log?.(`[code-link] ${line}`)
  }

  // ---- the upgrade -------------------------------------------------------------

  /** Whether `request` is a WebSocket upgrade to the link's path. */
  static isUpgrade(request: Request): boolean {
    return (
      request.method === 'GET' &&
      new URL(request.url).pathname === CODE_LINK_PATH &&
      request.headers.get('upgrade')?.toLowerCase() === 'websocket'
    )
  }

  /**
   * The checks of §5.1, then the upgrade. `undefined` when the socket is
   * now a link; otherwise the refusal, as plain HTTP.
   */
  async upgrade(
    request: Request,
    server: LinkUpgradeServer,
  ): Promise<Response | undefined> {
    const url = new URL(request.url)
    if (url.search !== '')
      return fail(
        400,
        'invalid',
        '凭据不能放进链接，请使用 Authorization: Bearer',
      )
    const token = bearerOf(request)
    if (!DEVICE_TOKEN.test(token))
      return fail(401, 'unauthorized', '需要这台设备的令牌')
    const { devices } = this.#options
    const device = devices.authenticate?.(token) ?? null
    if (device === null) {
      const why = devices.refusalOf?.(token) ?? 'unauthorized'
      return fail(401, why, REFUSAL_WORDS[why])
    }
    if (device.kind !== 'client')
      return fail(403, 'device_kind', '这台设备是接力设备，没有 Remote')
    if (!device.owner.startsWith('u:'))
      return fail(403, 'forbidden', '这台设备由旧式令牌配对，没有个人账号')
    if (!(await this.#subscribed(device.owner)))
      return fail(402, 'subscription_required', '需要有效订阅')
    const offered = (request.headers.get('sec-websocket-protocol') ?? '')
      .split(',')
      .map(one => one.trim())
    if (!offered.includes(CODE_LINK_PROTOCOL))
      return fail(426, 'upgrade_required', `要用子协议 ${CODE_LINK_PROTOCOL}`)
    const data: LinkData = {
      deviceId: device.deviceId,
      owner: device.owner,
      token,
      serial: ++this.#serial,
    }
    const upgraded = server.upgrade(request, {
      data,
      headers: { 'sec-websocket-protocol': CODE_LINK_PROTOCOL },
    })
    return upgraded ? undefined : fail(400, 'invalid', '升级失败')
  }

  async #subscribed(owner: string): Promise<boolean> {
    const billing = this.#options.billing
    if (billing === undefined) return true
    try {
      if (this.#options.tenancy?.read().config.platformSubjects.includes(owner))
        return true
    } catch {
      return false
    }
    try {
      return (await billing.standing(owner)).active
    } catch {
      return false
    }
  }

  /** Bun's `websocket` handlers for {@link upgrade}d sockets. */
  readonly websocket = {
    maxPayloadLength: CODE_LINK_MAX_FRAME,
    idleTimeout: 120,
    sendPings: true,
    open: (socket: LinkSocket) => this.#open(socket),
    message: (socket: LinkSocket, message: string | Uint8Array) =>
      this.#message(socket, message),
    close: (socket: LinkSocket, code: number, reason: string) =>
      this.#close(socket, code, reason),
  }

  #open(socket: LinkSocket): void {
    const { deviceId, owner, token, serial } = socket.data
    const old = this.#links.get(deviceId)
    const link: Link = {
      socket,
      deviceId,
      owner,
      token,
      serial,
      hello: false,
      waiting: new Map(),
    }
    this.#links.set(deviceId, link)
    if (old !== undefined) {
      this.#settleAll(old, 'offline', '链路被同一台设备的新连接替换')
      old.socket.close(LINK_CLOSE.replaced, 'replaced')
    }
    this.#startRecheck()
    this.#log(`up ${deviceId}`)
    this.#notify(owner)
  }

  #close(socket: LinkSocket, code: number, reason: string): void {
    const link = this.#links.get(socket.data.deviceId)
    if (link === undefined || link.serial !== socket.data.serial) return
    this.#links.delete(link.deviceId)
    this.#settleAll(link, 'offline', '设备离线了')
    this.#log(
      `down ${link.deviceId} ${code}${reason === '' ? '' : ` ${reason}`}`,
    )
    if (this.#links.size === 0) this.#stopRecheck()
    this.#notify(link.owner)
  }

  #current(socket: LinkSocket): Link | undefined {
    const link = this.#links.get(socket.data.deviceId)
    return link !== undefined && link.serial === socket.data.serial
      ? link
      : undefined
  }

  #send(link: Link, frame: Readonly<Record<string, unknown>>): void {
    try {
      link.socket.send(JSON.stringify(frame))
    } catch {
      // Closing already; its close handler cleans up.
    }
  }

  #drop(link: Link, why: string): void {
    this.#log(`closed ${link.deviceId}: ${why}`)
    link.socket.close(LINK_CLOSE.badFrame, why.slice(0, 100))
  }

  // ---- frames up ---------------------------------------------------------------

  #message(socket: LinkSocket, message: string | Uint8Array): void {
    const link = this.#current(socket)
    if (link === undefined) return
    if (typeof message !== 'string') {
      this.#drop(link, 'binary frame')
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(message)
    } catch {
      this.#drop(link, 'not JSON')
      return
    }
    if (!isRecord(frame) || !UP.some(t => t === frame.t)) {
      this.#drop(link, 'unknown frame')
      return
    }
    if (frame.t !== 'hello' && !link.hello) {
      this.#drop(link, 'hello first')
      return
    }
    switch (frame.t) {
      case 'hello':
        void this.#hello(link, frame)
        return
      case 'session':
        this.#session(link, frame)
        return
      case 'records':
        this.#records(link, frame)
        return
      case 'gone':
        this.#gone(link, frame)
        return
      case 'reply':
        this.#reply(link, frame)
        return
    }
  }

  async #hello(link: Link, frame: Record<string, unknown>): Promise<void> {
    if (link.hello || frame.v !== 1) {
      this.#drop(link, 'bad hello')
      return
    }
    link.hello = true
    const have: Record<string, { seq: number; remote: boolean }> = {}
    for (const copy of this.#options.copies.list(link.owner))
      if (copy.device === link.deviceId)
        have[copy.header.id] = { seq: copy.stored, remote: copy.header.remote }
    this.#send(link, {
      t: 'welcome',
      v: 1,
      device: {
        id: link.deviceId,
        name: await this.#deviceName(link.deviceId),
      },
      have,
    })
  }

  async #deviceName(deviceId: string): Promise<string> {
    try {
      const listed = await this.#options.devices.listDevices()
      if (listed.ok)
        return (
          listed.value.find(one => one.deviceId === deviceId)?.name ?? deviceId
        )
    } catch {}
    return deviceId
  }

  #session(link: Link, frame: Record<string, unknown>): void {
    const header = codeHeaderOf(frame.session)
    if (header === undefined) {
      this.#drop(link, 'bad session')
      return
    }
    // An off for a copy the hub never had has nothing to mark.
    if (
      !header.remote &&
      this.#options.copies.get(link.owner, link.deviceId, header.id) ===
        undefined
    ) {
      this.#send(link, { t: 'ack', session: header.id, seq: 0 })
      return
    }
    const saved = this.#options.copies.saveHeader(
      link.owner,
      link.deviceId,
      header,
    )
    if (saved === 'full')
      this.#send(link, {
        t: 'refuse',
        session: header.id,
        code: 'full',
        message: '这个账号在中枢上的副本到了上限',
      })
    else
      this.#send(link, {
        t: 'ack',
        session: header.id,
        seq:
          this.#options.copies.get(link.owner, link.deviceId, header.id)
            ?.stored ?? 0,
      })
    this.#notify(link.owner)
  }

  #records(link: Link, frame: Record<string, unknown>): void {
    const session = frame.session
    if (typeof session !== 'string' || !CODE_SESSION_ID.test(session)) {
      this.#drop(link, 'bad session id')
      return
    }
    const copy = this.#options.copies.get(link.owner, link.deviceId, session)
    if (copy === undefined || !Array.isArray(frame.records)) {
      this.#drop(link, 'records before their session')
      return
    }
    const records: CodeCopyRecord[] = []
    let last = copy.stored
    for (const value of frame.records) {
      const record = codeRecordOf(value, session)
      if (record === undefined || record.seq <= last) {
        this.#drop(link, 'bad record')
        return
      }
      last = record.seq
      records.push(record)
    }
    if (copy.full) {
      this.#refuseFull(link, session)
      return
    }
    const appended = this.#options.copies.append(
      link.owner,
      link.deviceId,
      session,
      records,
    )
    if (appended === 'missing') {
      this.#drop(link, 'records before their session')
      return
    }
    if (appended === 'full') {
      this.#refuseFull(link, session)
      this.#notify(link.owner)
      return
    }
    this.#send(link, { t: 'ack', session, seq: appended.stored })
    this.#notify(link.owner)
  }

  #refuseFull(link: Link, session: string): void {
    this.#send(link, {
      t: 'refuse',
      session,
      code: 'full',
      message: '中枢上的副本到了上限',
    })
  }

  #gone(link: Link, frame: Record<string, unknown>): void {
    const session = frame.session
    if (typeof session !== 'string' || !CODE_SESSION_ID.test(session)) {
      this.#drop(link, 'bad session id')
      return
    }
    this.#options.copies.remove(link.owner, link.deviceId, session)
    this.#send(link, { t: 'ack', session, seq: 0 })
    this.#notify(link.owner)
  }

  #reply(link: Link, frame: Record<string, unknown>): void {
    const id = frame.id
    if (typeof id !== 'number') return
    const waiter = link.waiting.get(id)
    if (waiter === undefined) return
    link.waiting.delete(id)
    clearTimeout(waiter.timer)
    if (frame.ok === true)
      waiter.resolve({ ok: true, result: frame.result ?? {} })
    else
      waiter.resolve({
        ok: false,
        code:
          typeof frame.code === 'string' ? frame.code.slice(0, 32) : 'E_RUNNER',
        message:
          typeof frame.message === 'string'
            ? frame.message.slice(0, 500)
            : '运行器拒绝了',
      })
  }

  #settleAll(link: Link, code: string, message: string): void {
    for (const [id, waiter] of link.waiting) {
      clearTimeout(waiter.timer)
      waiter.resolve({ ok: false, code, message })
      link.waiting.delete(id)
    }
  }

  // ---- what the routes use -------------------------------------------------------

  /** Whether `deviceId` has a link up (after its hello). */
  online(deviceId: string): boolean {
    return this.#links.get(deviceId)?.hello === true
  }

  /** The copies of `owner`'s devices. */
  copies(owner: string): readonly CodeCopy[] {
    return this.#options.copies.list(owner)
  }

  /** Sends `request` to `owner`'s device and waits for the runner's reply. */
  ask(
    owner: string,
    deviceId: string,
    request: LinkRequest,
  ): Promise<LinkReply> {
    const link = this.#links.get(deviceId)
    if (link === undefined || !link.hello || link.owner !== owner)
      return Promise.resolve({
        ok: false,
        code: 'offline',
        message: '设备离线',
      })
    const id = ++this.#request
    return new Promise<LinkReply>(resolve => {
      const timer = setTimeout(() => {
        link.waiting.delete(id)
        resolve({
          ok: false,
          code: 'timeout',
          message: '那台电脑 10 秒内没有回答',
        })
      }, CODE_LINK_REPLY_MS)
      timer.unref?.()
      link.waiting.set(id, { resolve, timer })
      this.#send(link, { ...request, id })
    })
  }

  /** Hears about every change to `owner`'s copies and devices. */
  subscribe(owner: string, listener: (rev: number) => void): () => void {
    let set = this.#listeners.get(owner)
    if (set === undefined) {
      set = new Set()
      this.#listeners.set(owner, set)
    }
    const call = () => listener(this.#rev)
    set.add(call)
    return () => {
      set.delete(call)
      if (set.size === 0) this.#listeners.delete(owner)
    }
  }

  #notify(owner: string): void {
    this.#rev += 1
    for (const listener of [...(this.#listeners.get(owner) ?? [])]) {
      try {
        listener()
      } catch {}
    }
  }

  /** A copy was dropped by a person elsewhere. */
  changed(owner: string): void {
    this.#notify(owner)
  }

  // ---- revocation ----------------------------------------------------------------

  /** A device revoked: its link closes and its copies go. */
  endDevice(deviceId: string, owner: string): void {
    if (!CODE_DEVICE_ID.test(deviceId)) return
    const link = this.#links.get(deviceId)
    if (link !== undefined)
      link.socket.close(LINK_CLOSE.revoked, 'device_revoked')
    try {
      this.#options.copies.removeDevice(owner, deviceId)
    } catch (error) {
      this.#log(`could not drop ${deviceId}'s copies: ${String(error)}`)
    }
    this.#notify(owner)
  }

  /** An account revoked or reset: all of its links close and its copies go. */
  endOwner(owner: string): void {
    for (const link of [...this.#links.values()])
      if (link.owner === owner)
        link.socket.close(LINK_CLOSE.revoked, 'device_revoked')
    try {
      this.#options.copies.removeOwner(owner)
    } catch (error) {
      this.#log(`could not drop an account's copies: ${String(error)}`)
    }
    this.#notify(owner)
  }

  /** Every link's token and subscription, checked again. */
  async recheck(): Promise<void> {
    const { devices } = this.#options
    for (const link of [...this.#links.values()]) {
      const device = devices.authenticate?.(link.token) ?? null
      if (device === null || device.deviceId !== link.deviceId) {
        const why = devices.refusalOf?.(link.token) ?? 'unauthorized'
        link.socket.close(
          why === 'owner_inactive' ? LINK_CLOSE.inactive : LINK_CLOSE.revoked,
          why,
        )
        continue
      }
      if (!(await this.#subscribed(link.owner)))
        link.socket.close(LINK_CLOSE.subscription, 'subscription_required')
    }
  }

  #startRecheck(): void {
    if (this.#recheck !== undefined) return
    this.#recheck = setInterval(() => void this.recheck(), CODE_LINK_RECHECK_MS)
    this.#recheck.unref?.()
  }

  #stopRecheck(): void {
    if (this.#recheck !== undefined) clearInterval(this.#recheck)
    this.#recheck = undefined
  }

  /** What a console without Remote hands Bun: no socket is ever upgraded there. */
  static readonly none = {
    open: (socket: LinkSocket) =>
      socket.close(LINK_CLOSE.going, 'no link here'),
    message: () => {},
  }

  /** The hub is stopping: every link is told so. */
  stop(): void {
    this.#stopRecheck()
    for (const link of [...this.#links.values()])
      link.socket.close(LINK_CLOSE.going, 'going away')
  }
}
