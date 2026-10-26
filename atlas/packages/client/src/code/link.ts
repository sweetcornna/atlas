// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The device link, the runner's end (P37.15, `docs/dev/qmo-local.md` §5.1,
 * §5.3): while a local session has Remote on, the runner — this process,
 * the one holding the device token — dials `wss://<hub>/v0/client/link`
 * with Bun's own WebSocket, pushes those sessions' heads and records in
 * `seq` order, and takes the lines, answers and stops people send from
 * elsewhere. No session wants it, it hangs up.
 *
 * - **Order and resume.** The hub's `welcome` says how far it has each
 *   copy; the runner pushes from there, one batch in flight per session,
 *   the next after its `ack`. What was written while the link was down is
 *   read back from `events.ndjson`, so it arrives in order once the link is
 *   back. Each `ack` is noted as the session's `remote.pushedSeq`.
 * - **What goes.** The records as written, `detail` cut to 4 KiB (a diff
 *   keeps its head, an output its tail); a question's own fields stay whole
 *   so it can be answered elsewhere. The head without paths.
 * - **Retries.** 1, 2, 5, 10, 30 s, then every 30 s; from 1 s again after a
 *   `welcome`. A handshake that fails is asked about (`GET
 *   /v0/client/device`, then `GET /v0/client/link` without the upgrade) so
 *   a revoked device, an inactive account or a hub without Remote stop the
 *   retries and say so, rather than retrying for ever. 4401, 4402 and 4403
 *   from the hub stop them too.
 */

import pkg from '../../package.json' with { type: 'json' }
import { deviceStatus, type DeviceStatus, type Fetch } from '../hub.js'
import type { CodeRecord, CodeTurn } from './protocol.js'
import type { SessionHeader } from './store.js'

export const LINK_PROTOCOL = 'qmo-link.1'

/** Backoff between attempts, seconds; the last repeats. */
const BACKOFF_S = [1, 2, 5, 10, 30] as const
/** A handshake without a `welcome` within this is given up. */
const WELCOME_MS = 10_000
/** One frame of records is at most this (one larger record goes alone). */
const MAX_BATCH_BYTES = 256 * 1024
/** A record's `detail` goes to the hub cut to this (§5.3). */
export const REMOTE_DETAIL_BYTES = 4 * 1024
const DETAIL_CUT = '\n…（更多在那台电脑上）'
const OUTPUT_CUT = '…（更多在那台电脑上）\n'

/** The close codes after which the hub would refuse a redial (`codeLink.ts`). */
const FINAL_CLOSE: Readonly<Record<number, string>> = {
  4401: '这台设备已被吊销，或令牌不再有效 · 在 Qmo 里重新登录',
  4402: '需要有效订阅',
  4403: '这台设备所属的账号已停用或是只读',
}

export type LinkStateName = 'off' | 'connecting' | 'up' | 'retrying' | 'refused'

export interface LinkState {
  readonly state: LinkStateName
  readonly reason?: string
}

export interface LinkPairing {
  readonly hub: string
  readonly deviceId: string
  readonly token: string
}

/** What the link asks of the session manager and the client folder. */
export interface LinkHost {
  /** This computer's pairing, read afresh each attempt; `undefined` when signed out. */
  pairing(): Promise<LinkPairing | undefined>
  /** Every session's head. */
  heads(): readonly SessionHeader[]
  /** A session's records after `seq`, in order, from its file. */
  recordsAfter(id: string, seq: number): readonly CodeRecord[]
  /** The hub has a session's records up to `seq`. */
  pushed(id: string, seq: number): void
  /** Remote turned off for a session by the link, with a line in it saying why. */
  off(id: string, why: string): void
  send(input: {
    readonly session: string
    readonly text: string
    readonly clientId: string
  }): Promise<unknown>
  answer(input: {
    readonly session: string
    readonly ask: string
    readonly decision: 'once' | 'session' | 'deny'
    readonly message?: string
  }): void
  stop(id: string): void
  /** The link's state changed (the page's `link` event). */
  state(state: LinkState): void
  log(line: string): void
}

/** Just enough of a WebSocket. */
export interface LinkSocket {
  readonly readyState: number
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type LinkSocketFactory = (
  url: string,
  options: {
    readonly headers: Record<string, string>
    readonly protocols: string[]
    readonly proxy?: string
  },
) => LinkSocket

export interface RemoteLinkOptions {
  readonly host: LinkHost
  /** Tests: a socket other than Bun's. */
  readonly socket?: LinkSocketFactory
  /** Tests: the HTTP the handshake's diagnosis uses. */
  readonly fetch?: Fetch
  /** Tests: shorter waits. */
  readonly backoffMs?: readonly number[]
  readonly env?: NodeJS.ProcessEnv
}

interface Pusher {
  /** The hub has up to here. */
  acked: number
  /** The last seq of the batch on its way, if one is. */
  inflight: number | undefined
  readonly queue: CodeRecord[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The link's address: `https` → `wss`, `http` (loopback only) → `ws`. */
export function linkUrl(hub: string): string {
  const url = new URL(`${hub}/v0/client/link`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/** The proxy to dial through, as `fetch` would pick it from the environment. */
function proxyFor(url: string, env: NodeJS.ProcessEnv): string | undefined {
  const target = new URL(url)
  const host = target.hostname
  if (['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host))
    return undefined
  const no = (env.NO_PROXY ?? env.no_proxy ?? '')
    .split(',')
    .map(one => one.trim().toLowerCase())
    .filter(Boolean)
  if (
    no.some(
      one =>
        one === '*' ||
        host === one.replace(/^\./, '') ||
        host.endsWith(one.startsWith('.') ? one : `.${one}`),
    )
  )
    return undefined
  const proxy =
    target.protocol === 'wss:'
      ? (env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy)
      : (env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy)
  return proxy === undefined || proxy === '' ? undefined : proxy
}

const continues = (byte: number | undefined) =>
  byte !== undefined && (byte & 0xc0) === 0x80

/** `detail` within {@link REMOTE_DETAIL_BYTES}: a diff's head, an output's tail. */
export function remoteDetail(text: string, kind: 'diff' | 'output'): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= REMOTE_DETAIL_BYTES) return text
  if (kind === 'diff') {
    let end = REMOTE_DETAIL_BYTES - Buffer.byteLength(DETAIL_CUT)
    while (end > 0 && continues(bytes[end])) end--
    return `${bytes.subarray(0, end).toString('utf8')}${DETAIL_CUT}`
  }
  let start =
    bytes.length - (REMOTE_DETAIL_BYTES - Buffer.byteLength(OUTPUT_CUT))
  while (start < bytes.length && continues(bytes[start])) start++
  return `${OUTPUT_CUT}${bytes.subarray(start).toString('utf8')}`
}

/** A record as it goes to the hub (§5.3). */
export function remoteRecord(record: CodeRecord): {
  seq: number
  turn: CodeTurn
} {
  const { turn } = record
  if (turn.detail === undefined) return { seq: record.seq, turn }
  const kind =
    turn.ask !== undefined || turn.tool?.detailKind === 'diff'
      ? 'diff'
      : 'output'
  return {
    seq: record.seq,
    turn: { ...turn, detail: remoteDetail(turn.detail, kind) },
  }
}

/** A session's head as the hub keeps it: no paths, no native ids. */
export function remoteHead(header: SessionHeader): Record<string, unknown> {
  return {
    id: header.id,
    title: header.title,
    folder: header.folder.name,
    agent: { id: header.agent.id, name: header.agent.name },
    mode: header.mode,
    state: header.state,
    remote: header.remote.on,
    createdAt: header.createdAt,
    updatedAt: header.updatedAt,
    lastSeq: header.lastSeq,
  }
}

const DIAGNOSIS: Readonly<Partial<Record<DeviceStatus, string>>> = {
  revoked: '这台设备已被吊销 · 在 Qmo 里重新登录',
  owner_inactive: '这台设备所属的账号已停用或是只读',
  invalid: '设备令牌无效 · 在 Qmo 里重新登录',
  unsupported: '这台中枢没有个人账号，没有 Remote',
}

export class RemoteLink {
  readonly #host: LinkHost
  readonly #socketFactory: LinkSocketFactory
  readonly #fetch: Fetch
  readonly #backoff: readonly number[]
  readonly #env: NodeJS.ProcessEnv
  #state: LinkState = { state: 'off' }
  #socket: LinkSocket | undefined
  #pairing: LinkPairing | undefined
  #welcomed = false
  #attempt = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #welcomeTimer: ReturnType<typeof setTimeout> | undefined
  #connecting = false
  #refused = false
  #closing = false
  readonly #pushers = new Map<string, Pusher>()
  /** What the hub said it has of each copy, from `welcome` and every `ack`. */
  readonly #have = new Map<string, { seq: number; remote: boolean }>()
  /** Turned off, and the hub not yet told so. */
  readonly #offs = new Set<string>()

  constructor(options: RemoteLinkOptions) {
    this.#host = options.host
    this.#fetch = options.fetch ?? fetch
    this.#backoff = options.backoffMs ?? BACKOFF_S.map(s => s * 1000)
    this.#env = options.env ?? process.env
    this.#socketFactory =
      options.socket ??
      ((url, init) =>
        new WebSocket(url, {
          headers: init.headers,
          protocols: init.protocols,
          ...(init.proxy === undefined ? {} : { proxy: init.proxy }),
        }) as unknown as LinkSocket)
  }

  get state(): LinkState {
    return this.#state
  }

  #setState(state: LinkState): void {
    if (
      this.#state.state === state.state &&
      this.#state.reason === state.reason
    )
      return
    this.#state = state
    this.#host.log(
      `[link] ${state.state}${state.reason === undefined ? '' : `: ${state.reason}`}`,
    )
    this.#host.state(state)
  }

  /** Sessions with Remote on (for the device they were turned on under, once known). */
  #remoteHeads(): SessionHeader[] {
    return this.#host
      .heads()
      .filter(
        head =>
          head.remote.on &&
          (this.#pairing === undefined ||
            head.remote.device === undefined ||
            head.remote.device === this.#pairing.deviceId),
      )
  }

  #wanted(): boolean {
    return (
      !this.#closing &&
      (this.#host.heads().some(head => head.remote.on) || this.#offs.size > 0)
    )
  }

  /**
   * Connects or hangs up as the sessions want. `retry` (a person just turned
   * Remote on): try again even after a refusal.
   */
  update(retry = false): void {
    if (this.#closing) return
    if (retry && this.#refused) {
      this.#refused = false
      this.#attempt = 0
    }
    if (this.#wanted()) {
      if (
        this.#socket === undefined &&
        !this.#connecting &&
        this.#timer === undefined &&
        !this.#refused
      )
        void this.#connect()
      return
    }
    clearTimeout(this.#timer)
    this.#timer = undefined
    if (this.#socket !== undefined)
      this.#socket.close(1000, 'no session wants it')
    else if (!this.#connecting) this.#setState({ state: 'off' })
  }

  // ---- what the sessions say ---------------------------------------------------

  /** A session's head changed (Remote turned on or off included). */
  head(header: SessionHeader): void {
    const id = header.id
    if (!header.remote.on) {
      if (this.#pushers.delete(id) || this.#have.get(id)?.remote === true) {
        this.#offs.add(id)
        if (this.#welcomed)
          this.#send({ t: 'session', session: remoteHead(header) })
      }
      this.update()
      return
    }
    if (!this.#welcomed) {
      this.update()
      return
    }
    if (
      this.#pairing !== undefined &&
      header.remote.device !== undefined &&
      header.remote.device !== this.#pairing.deviceId
    )
      return
    this.#offs.delete(id)
    this.#send({ t: 'session', session: remoteHead(header) })
    if (!this.#pushers.has(id))
      this.#startPusher(id, this.#have.get(id)?.seq ?? 0)
  }

  /** A line was written to a session. */
  record(header: SessionHeader, record: CodeRecord): void {
    if (!header.remote.on || !this.#welcomed) return
    const pusher = this.#pushers.get(header.id)
    if (pusher === undefined) return
    pusher.queue.push(record)
    this.#pump(header.id, pusher)
  }

  /**
   * A session deleted here: the hub drops its copy (`gone`, §5.4). Told now
   * when the link is up; else the link dials for it and the welcome tells it
   * (the hub names what it has, this one no longer is here). Nothing to tell
   * for one that never had Remote on and the hub never named.
   */
  removed(header: SessionHeader): void {
    const id = header.id
    this.#pushers.delete(id)
    if (
      !header.remote.on &&
      header.remote.device === undefined &&
      !this.#have.has(id) &&
      !this.#offs.has(id)
    )
      return
    this.#offs.add(id)
    if (this.#welcomed) this.#send({ t: 'gone', session: id })
    this.update()
  }

  /** The runner is going: what was acknowledged is noted, the link closed. */
  async close(): Promise<void> {
    this.#closing = true
    clearTimeout(this.#timer)
    clearTimeout(this.#welcomeTimer)
    this.#timer = undefined
    const socket = this.#socket
    if (socket === undefined) return
    const { promise, resolve } = Promise.withResolvers<void>()
    const done = setTimeout(resolve, 1_000)
    const before = socket.onclose
    socket.onclose = event => {
      before?.(event)
      clearTimeout(done)
      resolve()
    }
    socket.close(1000, 'runner stopping')
    await promise
  }

  // ---- the connection ----------------------------------------------------------

  async #connect(): Promise<void> {
    this.#connecting = true
    this.#setState({ state: 'connecting' })
    let pairing: LinkPairing | undefined
    try {
      pairing = await this.#host.pairing()
    } catch (error) {
      this.#connecting = false
      this.#refuse(
        `读不到这台电脑的登录：${String((error as Error)?.message ?? error)}`,
      )
      return
    }
    this.#pairing = pairing
    if (pairing === undefined) {
      this.#connecting = false
      this.#refuse('这台电脑没有登录中枢')
      return
    }
    // Turned on under another pairing: not for this hub or this account.
    for (const head of this.#host.heads())
      if (
        head.remote.on &&
        head.remote.device !== undefined &&
        head.remote.device !== pairing.deviceId
      )
        this.#host.off(head.id, 'Remote 是在上一次登录时开的，已关上')
    if (!this.#wanted() || this.#closing) {
      this.#connecting = false
      this.#setState({ state: 'off' })
      return
    }
    const url = linkUrl(pairing.hub)
    let socket: LinkSocket
    try {
      const proxy = proxyFor(url, this.#env)
      socket = this.#socketFactory(url, {
        headers: { authorization: `Bearer ${pairing.token}` },
        protocols: [LINK_PROTOCOL],
        ...(proxy === undefined ? {} : { proxy }),
      })
    } catch (error) {
      this.#connecting = false
      this.#retry(`连不上中枢（${String((error as Error)?.message ?? error)}）`)
      return
    }
    this.#socket = socket
    this.#connecting = false
    let opened = false
    socket.onopen = () => {
      opened = true
      this.#send({ t: 'hello', v: 1, version: pkg.version })
      clearTimeout(this.#welcomeTimer)
      this.#welcomeTimer = setTimeout(
        () => socket.close(4000, 'no welcome'),
        WELCOME_MS,
      )
    }
    socket.onmessage = event => {
      if (this.#socket !== socket) return
      this.#frame(event.data)
    }
    socket.onerror = () => {}
    socket.onclose = event => {
      if (this.#socket !== socket) return
      void this.#closed(event.code, event.reason, opened, pairing)
    }
  }

  async #closed(
    code: number,
    reason: string,
    opened: boolean,
    pairing: LinkPairing,
  ): Promise<void> {
    clearTimeout(this.#welcomeTimer)
    this.#socket = undefined
    const wasWelcomed = this.#welcomed
    this.#welcomed = false
    for (const pusher of this.#pushers.values()) pusher.inflight = undefined
    this.#pushers.clear()
    this.#host.log(`[link] closed ${code}${reason === '' ? '' : ` ${reason}`}`)
    if (this.#closing) {
      this.#setState({ state: 'off' })
      return
    }
    const final = FINAL_CLOSE[code]
    if (final !== undefined) {
      this.#refuse(final)
      return
    }
    if (!this.#wanted()) {
      this.#setState({ state: 'off' })
      return
    }
    if (!opened) {
      const why = await this.#diagnose(pairing)
      if (why.final) {
        this.#refuse(why.reason)
        return
      }
      this.#retry(why.reason)
      return
    }
    this.#retry(
      wasWelcomed
        ? '和中枢的连接断了'
        : `握手之后没有收到中枢的答复（${code}）`,
    )
  }

  /** Why a handshake failed, as far as two plain requests can tell. */
  async #diagnose(
    pairing: LinkPairing,
  ): Promise<{ final: boolean; reason: string }> {
    const status = await deviceStatus(pairing.hub, pairing.token, this.#fetch)
    if (status === 'unreachable') return { final: false, reason: '连不上中枢' }
    const said = DIAGNOSIS[status]
    if (said !== undefined) return { final: true, reason: said }
    try {
      const probe = await this.#fetch(`${pairing.hub}/v0/client/link`, {
        headers: { authorization: `Bearer ${pairing.token}` },
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(10_000),
      })
      if (probe.status === 404)
        return { final: true, reason: '这台中枢还没有 Remote（版本较旧）' }
      if (probe.status === 501)
        return { final: true, reason: '这台中枢没有开 Remote' }
      if (probe.status === 402) return { final: true, reason: '需要有效订阅' }
      if (probe.status === 426)
        return {
          final: false,
          reason:
            '中枢有 Remote，但升级被挡住了（中枢前面的反向代理可能不转发 WebSocket）',
        }
    } catch {}
    return { final: false, reason: '握手没有成功' }
  }

  #refuse(reason: string): void {
    this.#refused = true
    this.#setState({ state: 'refused', reason })
  }

  #retry(reason: string): void {
    const wait =
      this.#backoff[Math.min(this.#attempt, this.#backoff.length - 1)] ?? 30_000
    this.#attempt += 1
    this.#setState({ state: 'retrying', reason })
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.update()
    }, wait)
    this.#timer.unref?.()
  }

  #send(frame: Readonly<Record<string, unknown>>): void {
    try {
      this.#socket?.send(JSON.stringify(frame))
    } catch (error) {
      this.#host.log(`[link] could not send: ${String(error)}`)
    }
  }

  // ---- frames down -------------------------------------------------------------

  #frame(data: unknown): void {
    if (typeof data !== 'string') return
    let frame: unknown
    try {
      frame = JSON.parse(data)
    } catch {
      return
    }
    if (!isRecord(frame)) return
    switch (frame.t) {
      case 'welcome':
        this.#welcome(frame)
        return
      case 'ack':
        this.#ack(frame)
        return
      case 'refuse':
        if (typeof frame.session === 'string') {
          this.#pushers.delete(frame.session)
          this.#host.off(
            frame.session,
            `${typeof frame.message === 'string' ? frame.message.slice(0, 200) : '中枢不再收这个会话'} · Remote 已关`,
          )
        }
        return
      case 'send':
      case 'answer':
      case 'stop':
        void this.#request(frame)
        return
    }
  }

  #welcome(frame: Record<string, unknown>): void {
    if (frame.v !== 1 || this.#welcomed) return
    clearTimeout(this.#welcomeTimer)
    this.#welcomed = true
    this.#attempt = 0
    this.#have.clear()
    if (isRecord(frame.have))
      for (const [id, value] of Object.entries(frame.have))
        if (isRecord(value) && typeof value.seq === 'number')
          this.#have.set(id, { seq: value.seq, remote: value.remote === true })
    this.#setState({ state: 'up' })
    const heads = new Map(this.#host.heads().map(head => [head.id, head]))
    // What the hub thinks is on and is not: told, or dropped when gone here.
    for (const [id, have] of this.#have) {
      const head = heads.get(id)
      if (head === undefined) {
        this.#send({ t: 'gone', session: id })
        this.#offs.delete(id)
      } else if (!head.remote.on && have.remote) {
        this.#offs.add(id)
        this.#send({ t: 'session', session: remoteHead(head) })
      } else if (!head.remote.on) this.#offs.delete(id)
    }
    for (const id of [...this.#offs])
      if (!this.#have.has(id)) this.#offs.delete(id)
    for (const head of this.#remoteHeads()) {
      this.#send({ t: 'session', session: remoteHead(head) })
      this.#startPusher(head.id, this.#have.get(head.id)?.seq ?? 0)
    }
    this.update()
  }

  #startPusher(id: string, from: number): void {
    let queue: CodeRecord[] = []
    try {
      queue = [...this.#host.recordsAfter(id, from)]
    } catch (error) {
      this.#host.log(`[link] could not read ${id}: ${String(error)}`)
    }
    const pusher: Pusher = { acked: from, inflight: undefined, queue }
    this.#pushers.set(id, pusher)
    this.#pump(id, pusher)
  }

  #pump(id: string, pusher: Pusher): void {
    if (!this.#welcomed || pusher.inflight !== undefined) return
    // Lines the hub has already (a record written while the backlog was read).
    while (pusher.queue.length > 0 && pusher.queue[0]!.seq <= pusher.acked)
      pusher.queue.shift()
    if (pusher.queue.length === 0) return
    const batch: { seq: number; turn: CodeTurn }[] = []
    let size = 0
    while (pusher.queue.length > 0) {
      const next = remoteRecord(pusher.queue[0]!)
      const bytes = Buffer.byteLength(JSON.stringify(next))
      if (batch.length > 0 && size + bytes > MAX_BATCH_BYTES) break
      batch.push(next)
      size += bytes
      pusher.queue.shift()
    }
    pusher.inflight = batch[batch.length - 1]!.seq
    this.#send({ t: 'records', session: id, records: batch })
  }

  #ack(frame: Record<string, unknown>): void {
    const id = frame.session
    const seq = frame.seq
    if (typeof id !== 'string' || typeof seq !== 'number') return
    const head = this.#host.heads().find(one => one.id === id)
    this.#have.set(id, { seq, remote: head?.remote.on ?? false })
    if (this.#offs.has(id) && head?.remote.on !== true) {
      this.#offs.delete(id)
      this.update()
    }
    const pusher = this.#pushers.get(id)
    if (pusher === undefined) return
    if (seq > pusher.acked) {
      pusher.acked = seq
      this.#host.pushed(id, seq)
    }
    if (pusher.inflight !== undefined && seq >= pusher.inflight) {
      pusher.inflight = undefined
      this.#pump(id, pusher)
    }
  }

  async #request(frame: Record<string, unknown>): Promise<void> {
    const id = frame.id
    if (typeof id !== 'number') return
    const session = typeof frame.session === 'string' ? frame.session : ''
    const head = this.#host.heads().find(one => one.id === session)
    const reply = (body: Record<string, unknown>) =>
      this.#send({ t: 'reply', id, ...body })
    if (head === undefined || !head.remote.on || !this.#pushers.has(session)) {
      reply({ ok: false, code: 'E_REMOTE', message: '这个会话的 Remote 没开' })
      return
    }
    try {
      let result: unknown = {}
      if (frame.t === 'send')
        result = await this.#host.send({
          session,
          text: String(frame.text ?? ''),
          clientId: String(frame.clientId ?? ''),
        })
      else if (frame.t === 'answer') {
        const decision = frame.decision
        if (
          decision !== 'once' &&
          decision !== 'session' &&
          decision !== 'deny'
        )
          throw Object.assign(new Error('decision 不对'), { code: 'E_ARGS' })
        this.#host.answer({
          session,
          ask: String(frame.ask ?? ''),
          decision,
          ...(typeof frame.message === 'string'
            ? { message: frame.message }
            : {}),
        })
      } else this.#host.stop(session)
      reply({ ok: true, result })
    } catch (error) {
      const code =
        isRecord(error) && typeof error.code === 'string'
          ? error.code
          : 'E_RUNNER'
      reply({
        ok: false,
        code,
        message: String((error as Error)?.message ?? error),
      })
    }
  }
}
