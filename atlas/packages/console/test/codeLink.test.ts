// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The device link and `/v0/code/…` (P37.15, `docs/dev/qmo-local.md` §5.1,
 * §5.2): who may dial, what each frame does, the copies of one account
 * kept from every other, a line and a stop sent down a live link and
 * refused when the device is offline or Remote off, revocation closing the
 * link at once, and the 30 s re-check catching what has no event.
 *
 * The link is a real WebSocket on a real `Bun.serve` on loopback, upgraded
 * the way `startConsoleServer` upgrades it; the copies are in memory.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  CODE_LINK_REPLY_MS,
  CodeLinks,
  LINK_CLOSE,
  type LinkData,
} from '../src/codeLink.js'
import { CHAT_STREAM_HEARTBEAT_MS } from '../src/routes/chat.js'
import { CODE_STREAM_HEARTBEAT_MS } from '../src/routes/codeApi.js'
import type { ConsoleAction } from '../src/deps.js'
import type {
  DirectionActor,
  HandoffDeviceIdentity,
  HandoffDeviceRefusal,
  HandoffDevicesPort,
  HandoffDeviceView,
} from '../src/directionPorts.js'
import {
  accountsHarness,
  asAdmin,
  asSession,
  BASE,
  person,
} from './accountsHarness.js'
import { FakeBilling } from './billingFake.js'
import { MemoryCopies } from './codeCopiesFake.js'

const TOKEN_A = `qmd_${'a'.repeat(43)}`
const TOKEN_A2 = `qmd_${'f'.repeat(43)}`
const TOKEN_B = `qmd_${'b'.repeat(43)}`
const TOKEN_LEGACY = `qmd_${'c'.repeat(43)}`
const TOKEN_HANDOFF = `qmd_${'d'.repeat(43)}`
const DEVICE_A = 'd-aaaaaaaaaaaa'
const DEVICE_A2 = 'd-ffffffffffff'
const DEVICE_B = 'd-bbbbbbbbbbbb'
const SESSION = 'cs_AbCdEfGhIjKlMnOpQrSt_-'
const SESSION_2 = 'cs_ZyXwVuTsRqPoNmLkJiHg_-'

/** The device ledger: identities by token, revocable, with a name each. */
class Devices implements HandoffDevicesPort {
  readonly revoked = new Set<string>()
  readonly inactive = new Set<string>()
  readonly byToken = new Map<string, HandoffDeviceIdentity & { name: string }>()

  authenticate(token: string): HandoffDeviceIdentity | null {
    const device = this.byToken.get(token)
    if (
      device === undefined ||
      this.revoked.has(device.deviceId) ||
      this.inactive.has(device.owner)
    )
      return null
    return { deviceId: device.deviceId, owner: device.owner, kind: device.kind }
  }

  refusalOf(token: string): HandoffDeviceRefusal {
    const device = this.byToken.get(token)
    if (device === undefined) return 'unauthorized'
    if (this.revoked.has(device.deviceId)) return 'device_revoked'
    return this.inactive.has(device.owner) ? 'owner_inactive' : 'unauthorized'
  }

  #view(device: HandoffDeviceIdentity & { name: string }): HandoffDeviceView {
    return {
      deviceId: device.deviceId,
      name: device.name,
      platform: 'darwin-arm64',
      owner: device.owner,
      kind: device.kind,
      createdAt: 0,
      lastSeenAt: null,
      revokedAt: this.revoked.has(device.deviceId) ? 1 : null,
      tasks: 0,
    }
  }

  async listDevices() {
    return {
      ok: true as const,
      value: [...this.byToken.values()].map(device => this.#view(device)),
    }
  }

  async issuePairing() {
    return {
      ok: false as const,
      failure: { code: 'unsupported' as const, message: 'not here' },
    }
  }

  async revokeDevice(deviceId: string, _actor: DirectionActor) {
    this.revoked.add(deviceId)
    const device = [...this.byToken.values()].find(
      one => one.deviceId === deviceId,
    )
    if (device === undefined)
      return {
        ok: false as const,
        failure: { code: 'not_found' as const, message: 'no such device' },
      }
    return { ok: true as const, value: this.#view(device) }
  }
}

const servers: { stop(force?: boolean): unknown }[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  for (const server of servers.splice(0)) await server.stop(true)
})

async function scene(
  options: { billing?: FakeBilling; copies?: MemoryCopies } = {},
) {
  const devices = new Devices()
  const copies = options.copies ?? new MemoryCopies()
  const actions: ConsoleAction[] = []
  const h = accountsHarness({
    deps: {
      handoffDevices: devices,
      codeCopies: copies,
      ...(options.billing === undefined ? {} : { billing: options.billing }),
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
  })
  const links = h.handle.links
  if (links === undefined)
    throw new Error('no links on a console with accounts')
  const subjectOf = (credential: string): string => {
    const principal = h.book.bearerPrincipal(credential)
    if (!principal.ok || principal.value.kind !== 'user')
      throw new Error('no subject')
    return principal.value.subject
  }
  const member = await person(h.handle, 'member')
  const other = await person(h.handle, 'member')
  const owner = subjectOf(member.credential)
  const otherOwner = subjectOf(other.credential)
  options.billing?.activate(owner)
  options.billing?.activate(otherOwner)
  const client = 'client' as const
  devices.byToken.set(TOKEN_A, {
    deviceId: DEVICE_A,
    owner,
    kind: client,
    name: 'MacBook',
  })
  devices.byToken.set(TOKEN_A2, {
    deviceId: DEVICE_A2,
    owner,
    kind: client,
    name: 'iMac',
  })
  devices.byToken.set(TOKEN_B, {
    deviceId: DEVICE_B,
    owner: otherOwner,
    kind: client,
    name: 'ThinkPad',
  })
  devices.byToken.set(TOKEN_LEGACY, {
    deviceId: 'd-cccccccccccc',
    owner: 'legacy:admin',
    kind: client,
    name: 'old',
  })
  devices.byToken.set(TOKEN_HANDOFF, {
    deviceId: 'd-dddddddddddd',
    owner,
    kind: 'handoff',
    name: 'handoff',
  })
  // As `startConsoleServer` wires it.
  const server = Bun.serve<LinkData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, bunServer) =>
      CodeLinks.isUpgrade(request)
        ? links.upgrade(request, bunServer)
        : h.handle(request, bunServer),
    websocket: links.websocket,
  })
  servers.push(server)
  const url = `ws://127.0.0.1:${server.port}/v0/client/link`
  return {
    ...h,
    devices,
    copies,
    actions,
    links,
    member,
    other,
    owner,
    otherOwner,
    url,
  }
}

/** A runner's end of a link: the frames it got, in order. */
class Runner {
  readonly socket: WebSocket
  readonly frames: Record<string, unknown>[] = []
  readonly opened: Promise<boolean>
  readonly closed: Promise<{ code: number; reason: string }>

  constructor(
    url: string,
    token: string,
    protocols: string[] = ['qmo-link.1'],
  ) {
    this.socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
      protocols,
    })
    sockets.push(this.socket)
    this.opened = new Promise(resolve => {
      this.socket.onopen = () => resolve(true)
      this.socket.onerror = () => resolve(false)
    })
    this.closed = new Promise(resolve => {
      this.socket.onclose = event =>
        resolve({ code: event.code, reason: event.reason })
    })
    this.socket.onmessage = event =>
      this.frames.push(
        JSON.parse(String(event.data)) as Record<string, unknown>,
      )
  }

  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame))
  }

  /** The next frame of kind `t` not yet taken. */
  async next(t: string, from = 0): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 5_000
    for (;;) {
      const found = this.frames.slice(from).find(frame => frame.t === t)
      if (found !== undefined) {
        this.frames.splice(this.frames.indexOf(found), 1)
        return found
      }
      if (Date.now() > deadline)
        throw new Error(`no ${t}; got ${JSON.stringify(this.frames)}`)
      await Bun.sleep(5)
    }
  }

  /** Dialled, said hello, got welcome. */
  async up(): Promise<Record<string, unknown>> {
    expect(await this.opened).toBe(true)
    this.send({ t: 'hello', v: 1, version: 'test' })
    return this.next('welcome')
  }
}

const head = (over: Record<string, unknown> = {}) => ({
  id: SESSION,
  title: '改一下 README',
  folder: 'atlas',
  agent: { id: 'claude-code', name: 'Claude Code' },
  mode: 'off',
  state: 'idle',
  remote: true,
  createdAt: 1,
  updatedAt: 2,
  lastSeq: 0,
  ...over,
})

const record = (
  seq: number,
  over: Record<string, unknown> = {},
  session = SESSION,
) => ({
  seq,
  turn: {
    id: `t-${seq}`,
    sessionId: session,
    author: 'agent',
    at: seq,
    text: `line ${seq}`,
    state: 'done',
    ...over,
  },
})

const until = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(5)
  }
}

describe('who may dial /v0/client/link', () => {
  /** The checks, as plain HTTP refusals from `upgrade`. */
  const refusal = async (
    s: Awaited<ReturnType<typeof scene>>,
    headers: Record<string, string>,
    path = '/v0/client/link',
  ): Promise<string> => {
    let upgraded = false
    const response = await s.links.upgrade(
      new Request(`${BASE}${path}`, {
        headers: { upgrade: 'websocket', connection: 'Upgrade', ...headers },
      }),
      {
        upgrade: () => {
          upgraded = true
          return true
        },
      },
    )
    if (response === undefined) return upgraded ? 'upgraded' : 'nothing'
    const body = (await response.json()) as { error: { code: string } }
    return `${response.status} ${body.error.code}`
  }
  const bearer = (token: string) => ({
    authorization: `Bearer ${token}`,
    'sec-websocket-protocol': 'qmo-link.1',
  })

  test('a client device of a personal account in good standing, and nothing else', async () => {
    const s = await scene()
    expect(await refusal(s, bearer(TOKEN_A))).toBe('upgraded')
    expect(await refusal(s, {})).toBe('401 unauthorized')
    expect(await refusal(s, bearer(`qmd_${'z'.repeat(43)}`))).toBe(
      '401 unauthorized',
    )
    expect(await refusal(s, bearer(TOKEN_HANDOFF))).toBe('403 device_kind')
    expect(await refusal(s, bearer(TOKEN_LEGACY))).toBe('403 forbidden')
    expect(await refusal(s, { authorization: `Bearer ${TOKEN_A}` })).toBe(
      '426 upgrade_required',
    )
    expect(
      await refusal(s, bearer(TOKEN_A), `/v0/client/link?token=${TOKEN_A}`),
    ).toBe('400 invalid')
    s.devices.revoked.add(DEVICE_A)
    expect(await refusal(s, bearer(TOKEN_A))).toBe('401 device_revoked')
    s.devices.inactive.add(s.owner)
    expect(await refusal(s, bearer(TOKEN_A2))).toBe('401 owner_inactive')
  })

  test('the public edition: no subscription, no link', async () => {
    const billing = new FakeBilling()
    const s = await scene({ billing })
    expect(await refusal(s, bearer(TOKEN_A))).toBe('upgraded')
    billing.standings.delete(s.owner)
    expect(await refusal(s, bearer(TOKEN_A))).toBe('402 subscription_required')
  })

  test('a real dial: refused is no 101, accepted is qmo-link.1', async () => {
    const s = await scene()
    const refused = new Runner(s.url, TOKEN_HANDOFF)
    expect(await refused.opened).toBe(false)
    const accepted = new Runner(s.url, TOKEN_A)
    expect(await accepted.opened).toBe(true)
    expect(accepted.socket.protocol).toBe('qmo-link.1')
  })

  test('without the upgrade: 426 where the link is, 501 on a hub without Remote', async () => {
    const s = await scene()
    const plain = await s.handle(
      new Request(`${BASE}/v0/client/link`, {
        headers: { authorization: `Bearer ${TOKEN_A}` },
      }),
    )
    expect(plain.status).toBe(426)
    // Devices, but nowhere to keep copies: no Remote.
    const devices = new Devices()
    devices.byToken.set(TOKEN_A, {
      deviceId: DEVICE_A,
      owner: s.owner,
      kind: 'client',
      name: 'MacBook',
    })
    const bare = accountsHarness({ deps: { handoffDevices: devices } })
    const none = await bare.handle(
      new Request(`${BASE}/v0/client/link`, {
        headers: { authorization: `Bearer ${TOKEN_A}` },
      }),
    )
    expect(bare.handle.links).toBeUndefined()
    expect(none.status).toBe(501)
  })
})

describe('the frames', () => {
  test('hello, a head, records: the copy stored and acknowledged, the device named', async () => {
    const s = await scene()
    const runner = new Runner(s.url, TOKEN_A)
    const welcome = await runner.up()
    expect(welcome).toEqual({
      t: 'welcome',
      v: 1,
      device: { id: DEVICE_A, name: 'MacBook' },
      have: {},
    })
    runner.send({ t: 'session', session: head() })
    expect(await runner.next('ack')).toEqual({
      t: 'ack',
      session: SESSION,
      seq: 0,
    })
    runner.send({
      t: 'records',
      session: SESSION,
      records: [record(1), record(2)],
    })
    expect(await runner.next('ack')).toEqual({
      t: 'ack',
      session: SESSION,
      seq: 2,
    })
    expect(
      s.copies.lines(s.owner, DEVICE_A, SESSION).map(one => one.seq),
    ).toEqual([1, 2])

    // A second dial says what the hub has.
    runner.socket.close()
    await runner.closed
    const again = new Runner(s.url, TOKEN_A)
    expect((await again.up()).have).toEqual({
      [SESSION]: { seq: 2, remote: true },
    })
  })

  test('anything off the protocol closes the link with 4400', async () => {
    const s = await scene()
    const early = new Runner(s.url, TOKEN_A)
    expect(await early.opened).toBe(true)
    early.send({ t: 'records', session: SESSION, records: [] })
    expect((await early.closed).code).toBe(LINK_CLOSE.badFrame)

    const stale = new Runner(s.url, TOKEN_A)
    await stale.up()
    stale.send({ t: 'session', session: head() })
    await stale.next('ack')
    stale.send({ t: 'records', session: SESSION, records: [record(1)] })
    await stale.next('ack')
    // A seq at or below what is stored is not a record of this copy.
    stale.send({ t: 'records', session: SESSION, records: [record(1)] })
    expect((await stale.closed).code).toBe(LINK_CLOSE.badFrame)

    const binary = new Runner(s.url, TOKEN_A)
    await binary.up()
    binary.socket.send(new Uint8Array([1, 2, 3]))
    expect((await binary.closed).code).toBe(LINK_CLOSE.badFrame)

    const pathy = new Runner(s.url, TOKEN_A)
    await pathy.up()
    pathy.send({ t: 'session', session: { ...head(), cwd: '/Users/me/atlas' } })
    // The head is rebuilt field by field: the path never reaches the copy.
    expect(await pathy.next('ack')).toMatchObject({ session: SESSION })
    expect(JSON.stringify(s.copies.list(s.owner))).not.toContain('/Users/me')
  })

  test('an account at its limit gets a refuse, not an ack', async () => {
    const s = await scene({ copies: new MemoryCopies({ copies: 1 }) })
    const runner = new Runner(s.url, TOKEN_A)
    await runner.up()
    runner.send({ t: 'session', session: head() })
    await runner.next('ack')
    runner.send({ t: 'session', session: head({ id: SESSION_2 }) })
    expect(await runner.next('refuse')).toMatchObject({
      t: 'refuse',
      session: SESSION_2,
      code: 'full',
    })
  })

  test('a second link of the same device replaces the first with 4409', async () => {
    const s = await scene()
    const first = new Runner(s.url, TOKEN_A)
    await first.up()
    const second = new Runner(s.url, TOKEN_A)
    await second.up()
    expect((await first.closed).code).toBe(LINK_CLOSE.replaced)
    expect(s.links.online(DEVICE_A)).toBe(true)
  })

  test('gone drops the copy', async () => {
    const s = await scene()
    const runner = new Runner(s.url, TOKEN_A)
    await runner.up()
    runner.send({ t: 'session', session: head() })
    await runner.next('ack')
    runner.send({ t: 'gone', session: SESSION })
    expect(await runner.next('ack')).toEqual({
      t: 'ack',
      session: SESSION,
      seq: 0,
    })
    expect(s.copies.list(s.owner)).toEqual([])
  })
})

describe('/v0/code: the account sees its own copies and acts on them while the device is online', () => {
  /** A device online with one copy of two records. */
  const online = async () => {
    const s = await scene()
    const runner = new Runner(s.url, TOKEN_A)
    await runner.up()
    runner.send({ t: 'session', session: head() })
    await runner.next('ack')
    runner.send({
      t: 'records',
      session: SESSION,
      records: [
        record(1, { author: 'operator', text: '改一下 README' }),
        record(2, {
          ask: {
            id: 'ask_1',
            tool: 'Edit',
            title: '编辑 README.md',
            options: ['once', 'deny'],
          },
        }),
      ],
    })
    await runner.next('ack')
    return { s, runner }
  }

  test('the list and a read, for the owner only', async () => {
    const { s, runner } = await online()
    const listed = await s.handle(
      asSession('GET', '/v0/code/sessions', s.member.sid),
    )
    expect(listed.status).toBe(200)
    const body = (await listed.json()) as {
      devices: unknown[]
      sessions: Record<string, unknown>[]
    }
    expect(body.devices).toEqual([
      { id: DEVICE_A, name: 'MacBook', online: true },
    ])
    expect(body.sessions).toEqual([
      {
        id: `${DEVICE_A}.${SESSION}`,
        session: SESSION,
        device: { id: DEVICE_A, name: 'MacBook', online: true },
        title: '改一下 README',
        folder: { id: null, name: 'atlas' },
        agent: { id: 'claude-code', name: 'Claude Code' },
        mode: 'off',
        state: 'idle',
        remote: true,
        full: false,
        createdAt: 1,
        updatedAt: 2,
        lastSeq: 2,
      },
    ])
    const read = await s.handle(
      asSession(
        'GET',
        `/v0/code/sessions/${DEVICE_A}/${SESSION}?limit=1`,
        s.member.sid,
      ),
    )
    const page = (await read.json()) as {
      records: { seq: number }[]
      more: boolean
    }
    expect(page.records.map(one => one.seq)).toEqual([2])
    expect(page.more).toBe(true)

    // Somebody else's account: an empty list, and the same path finds nothing.
    const theirs = await s.handle(
      asSession('GET', '/v0/code/sessions', s.other.sid),
    )
    expect(((await theirs.json()) as { sessions: unknown[] }).sessions).toEqual(
      [],
    )
    for (const [method, path] of [
      ['GET', `/v0/code/sessions/${DEVICE_A}/${SESSION}`],
      ['POST', `/v0/code/sessions/${DEVICE_A}/${SESSION}/stop`],
      ['DELETE', `/v0/code/sessions/${DEVICE_A}/${SESSION}`],
    ] as const) {
      const response = await s.handle(
        asSession(
          method,
          path,
          s.other.sid,
          method === 'POST' ? { body: {} } : {},
        ),
      )
      expect([method, response.status]).toEqual([method, 404])
    }
    expect(runner.frames.filter(frame => frame.t === 'stop')).toEqual([])

    // The legacy tokens have no devices.
    const legacy = await s.handle(asAdmin('GET', '/v0/code/sessions'))
    expect(legacy.status).toBe(403)
  })

  test('a line, an answer and a stop go down the link and come back as the runner said', async () => {
    const { s, runner } = await online()
    const sending = s.handle(
      asSession(
        'POST',
        `/v0/code/sessions/${DEVICE_A}/${SESSION}/messages`,
        s.member.sid,
        {
          body: { text: '继续', clientId: 'c-9' },
        },
      ),
    )
    const send = await runner.next('send')
    expect(send).toEqual({
      t: 'send',
      session: SESSION,
      text: '继续',
      clientId: 'c-9',
      id: expect.any(Number),
    })
    runner.send({
      t: 'reply',
      id: send.id,
      ok: true,
      result: { turn: { id: 't-3' } },
    })
    const sent = await sending
    expect(sent.status).toBe(200)
    expect(await sent.json()).toEqual({ turn: { id: 't-3' } })

    const answering = s.handle(
      asSession(
        'POST',
        `/v0/code/sessions/${DEVICE_A}/${SESSION}/answer`,
        s.member.sid,
        {
          body: { ask: 'ask_1', decision: 'once' },
        },
      ),
    )
    const answer = await runner.next('answer')
    expect(answer).toMatchObject({
      session: SESSION,
      ask: 'ask_1',
      decision: 'once',
    })
    runner.send({
      t: 'reply',
      id: answer.id,
      ok: false,
      code: 'E_STALE',
      message: '这个征询已经答过了',
    })
    const answered = await answering
    expect(answered.status).toBe(409)
    expect(
      ((await answered.json()) as { error: { code: string } }).error.code,
    ).toBe('E_STALE')

    const stopping = s.handle(
      asSession(
        'POST',
        `/v0/code/sessions/${DEVICE_A}/${SESSION}/stop`,
        s.member.sid,
        {
          body: {},
        },
      ),
    )
    const stop = await runner.next('stop')
    runner.send({ t: 'reply', id: stop.id, ok: true, result: {} })
    expect((await stopping).status).toBe(200)

    expect(
      s.actions
        .filter(entry => entry.action.startsWith('code.'))
        .map(entry => [entry.action, entry.target, entry.outcome]),
    ).toEqual([
      ['code.remote.send', `${DEVICE_A}/${SESSION}`, 'ok'],
      ['code.remote.answer', `${DEVICE_A}/${SESSION}`, 'refused'],
      ['code.remote.stop', `${DEVICE_A}/${SESSION}`, 'ok'],
    ])
  })

  test('offline, or Remote off: read-only; the copy can be dropped only with Remote off', async () => {
    const { s, runner } = await online()
    const send = (sid: string) =>
      s.handle(
        asSession(
          'POST',
          `/v0/code/sessions/${DEVICE_A}/${SESSION}/messages`,
          sid,
          {
            body: { text: '继续', clientId: 'c-9' },
          },
        ),
      )
    const drop = () =>
      s.handle(
        asSession(
          'DELETE',
          `/v0/code/sessions/${DEVICE_A}/${SESSION}`,
          s.member.sid,
        ),
      )
    const codeOf = async (response: Response) =>
      `${response.status} ${((await response.json()) as { error: { code: string } }).error.code}`

    expect(await codeOf(await drop())).toBe('409 remote_on')
    runner.socket.close()
    await runner.closed
    await until(() => !s.links.online(DEVICE_A))
    expect(await codeOf(await send(s.member.sid))).toBe('409 offline')
    const listed = (await (
      await s.handle(asSession('GET', '/v0/code/sessions', s.member.sid))
    ).json()) as { sessions: { device: { online: boolean } }[] }
    expect(listed.sessions[0]?.device.online).toBe(false)

    const back = new Runner(s.url, TOKEN_A)
    await back.up()
    back.send({ t: 'session', session: head({ remote: false }) })
    await back.next('ack')
    expect(await codeOf(await send(s.member.sid))).toBe('409 remote_off')
    expect(back.frames.filter(frame => frame.t === 'send')).toEqual([])
    expect((await drop()).status).toBe(204)
    expect(s.copies.list(s.owner)).toEqual([])
    expect(s.actions.at(-1)).toMatchObject({
      action: 'code.remote.drop',
      outcome: 'ok',
    })
  })

  test('a request waits for the runner; another account cannot reach the device', async () => {
    const { s, runner } = await online()
    const link = s.links
    const started = Date.now()
    const reply = await Promise.race([
      link.ask(s.owner, DEVICE_A, { t: 'stop', session: SESSION }),
      Bun.sleep(50).then(() => 'waiting' as const),
    ])
    expect(reply).toBe('waiting')
    expect(Date.now() - started).toBeLessThan(5_000)
    // Another account's owner cannot reach the device at all.
    expect(
      await link.ask(s.otherOwner, DEVICE_A, { t: 'stop', session: SESSION }),
    ).toEqual({
      ok: false,
      code: 'offline',
      message: '设备离线',
    })
    runner.socket.close()
  })

  test('the stream beats with the chat stream, under the server idle timeout', () => {
    expect(CODE_STREAM_HEARTBEAT_MS).toBe(CHAT_STREAM_HEARTBEAT_MS)
    // A reply waits less than a browser request is let to.
    expect(CODE_LINK_REPLY_MS).toBeLessThan(30_000)
  })

  test('the stream says a revision when the account’s copies change', async () => {
    const { s, runner } = await online()
    const response = await s.handle(
      asSession('GET', '/v0/code/stream', s.member.sid, {
        accept: 'text/event-stream',
        extra: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
      }),
    )
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`stream ended: ${text}`)
        text += decoder.decode(value)
      }
    }
    await readUntil(': open')
    runner.send({ t: 'records', session: SESSION, records: [record(3)] })
    await readUntil('event: code')
    expect(text).toMatch(/event: code\ndata: \{"rev":\d+\}\n\n/)
    expect(text).not.toContain('line 3')
    await reader.cancel()
  })
})

describe('revocation and the re-check', () => {
  test('signing the device out closes its link with 4401 and drops its copies', async () => {
    const s = await scene()
    const runner = new Runner(s.url, TOKEN_A)
    await runner.up()
    runner.send({ t: 'session', session: head() })
    await runner.next('ack')
    const out = await s.handle(
      new Request(`${BASE}/v0/client/device`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${TOKEN_A}` },
      }),
    )
    expect(out.status).toBe(204)
    expect((await runner.closed).code).toBe(LINK_CLOSE.revoked)
    expect(s.copies.list(s.owner)).toEqual([])
    const redial = new Runner(s.url, TOKEN_A)
    expect(await redial.opened).toBe(false)
  })

  test('an account revoked closes every link of its devices and drops its copies', async () => {
    const s = await scene()
    const one = new Runner(s.url, TOKEN_A)
    await one.up()
    one.send({ t: 'session', session: head() })
    await one.next('ack')
    const two = new Runner(s.url, TOKEN_A2)
    await two.up()
    const theirs = new Runner(s.url, TOKEN_B)
    await theirs.up()
    const revoked = await s.handle(
      asAdmin('POST', `/v0/accounts/${s.owner}/revoke`),
    )
    expect(revoked.status).toBe(204)
    expect((await one.closed).code).toBe(LINK_CLOSE.revoked)
    expect((await two.closed).code).toBe(LINK_CLOSE.revoked)
    expect(s.copies.list(s.owner)).toEqual([])
    expect(s.links.online(DEVICE_B)).toBe(true)
  })

  test('what has no event is caught by the re-check: inactive 4403, subscription 4402', async () => {
    const billing = new FakeBilling()
    const s = await scene({ billing })
    const mine = new Runner(s.url, TOKEN_A)
    await mine.up()
    const theirs = new Runner(s.url, TOKEN_B)
    await theirs.up()
    s.devices.inactive.add(s.owner)
    billing.standings.delete(s.otherOwner)
    await s.links.recheck()
    expect((await mine.closed).code).toBe(LINK_CLOSE.inactive)
    expect((await theirs.closed).code).toBe(LINK_CLOSE.subscription)
  })
})
