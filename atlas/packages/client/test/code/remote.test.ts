// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Remote, the runner's end (P37.15, qmo-local.md §5.1, §5.3): the runner in
 * this process with the fake Claude Code, and a hub that is a real
 * WebSocket server on loopback speaking the link's frames — enough of the
 * hub to see what the runner sends and to answer as the hub would.
 *
 * Checked: Remote on dials, pushes the head without paths and every record
 * in order, acknowledged as `pushedSeq`; a link broken and back pushes what
 * was written meanwhile, nothing twice; a line from elsewhere runs with
 * `origin: 'remote'`; the last Remote off hangs up; 4401 and a refused
 * handshake stop the retries and say why; a full copy turns Remote off;
 * Remote cannot be turned on signed out, and a session turned on under
 * another pairing is turned off; a session deleted here takes its copy on
 * the hub with it (P37.14d). POSIX only, as `runner.test.ts`.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  REMOTE_DETAIL_BYTES,
  remoteDetail,
  remoteRecord,
} from '../../src/code/link.ts'
import type { CodeRecord } from '../../src/code/protocol.ts'
import {
  begin,
  type Box,
  box,
  cleanBoxes,
  type Message,
  pick,
  Refused,
  startRunner,
  type TestRunner,
} from './helpers.ts'

const posix = process.platform !== 'win32'
const TOKEN = `qmd_${'a'.repeat(43)}`
const DEVICE = 'd-aaaaaaaaaaaa'
const OTHER_DEVICE = 'd-bbbbbbbbbbbb'

interface Copy {
  head: Message
  records: Message[]
  stored: number
}

/** The hub, as far as the link goes. */
class FakeHub {
  readonly server: ReturnType<typeof Bun.serve>
  readonly copies = new Map<string, Copy>()
  readonly frames: Message[] = []
  dials = 0
  /** Answer the upgrade with this status instead. */
  refuse: number | undefined
  /** What `GET /v0/client/device` answers: 200, or a 401 with this code. */
  device: 'active' | 'device_revoked' = 'active'
  /** Whether `/v0/client/link` exists at all. */
  linkPath = true
  /** Sessions whose records the hub refuses as full. */
  readonly full = new Set<string>()
  socket: Bun.ServerWebSocket<unknown> | undefined
  readonly replies: Message[] = []

  constructor() {
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request, server) => {
        const url = new URL(request.url)
        const auth = request.headers.get('authorization')
        if (url.pathname === '/v0/client/device')
          return auth === `Bearer ${TOKEN}` && this.device === 'active'
            ? Response.json({ deviceId: DEVICE })
            : Response.json(
                { error: { code: this.device, message: 'no' } },
                { status: 401 },
              )
        if (url.pathname !== '/v0/client/link' || !this.linkPath)
          return new Response('not found', { status: 404 })
        if (request.headers.get('upgrade') !== 'websocket')
          return new Response('upgrade', { status: 426 })
        this.dials += 1
        if (this.refuse !== undefined)
          return new Response('no', { status: this.refuse })
        if (auth !== `Bearer ${TOKEN}`)
          return new Response('no', { status: 401 })
        if (request.headers.get('sec-websocket-protocol') !== 'qmo-link.1')
          return new Response('no', { status: 426 })
        return server.upgrade(request, {
          data: {},
          headers: { 'sec-websocket-protocol': 'qmo-link.1' },
        })
          ? undefined
          : new Response('no', { status: 400 })
      },
      websocket: {
        open: socket => {
          this.socket = socket
        },
        message: (socket, message) => this.#frame(socket, String(message)),
        close: socket => {
          if (this.socket === socket) this.socket = undefined
        },
      },
    })
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  #frame(socket: Bun.ServerWebSocket<unknown>, text: string): void {
    const frame = JSON.parse(text) as Message
    this.frames.push(frame)
    const send = (body: Message) => socket.send(JSON.stringify(body))
    switch (frame.t) {
      case 'hello': {
        const have: Record<string, { seq: number; remote: boolean }> = {}
        for (const [id, copy] of this.copies)
          have[id] = { seq: copy.stored, remote: copy.head.remote === true }
        send({ t: 'welcome', v: 1, device: { id: DEVICE, name: 'mac' }, have })
        return
      }
      case 'session': {
        const head = frame.session as Message
        const id = String(head.id)
        const copy = this.copies.get(id) ?? { head, records: [], stored: 0 }
        copy.head = head
        this.copies.set(id, copy)
        send({ t: 'ack', session: id, seq: copy.stored })
        return
      }
      case 'records': {
        const id = String(frame.session)
        if (this.full.has(id)) {
          send({
            t: 'refuse',
            session: id,
            code: 'full',
            message: '副本到了上限',
          })
          return
        }
        const copy = this.copies.get(id)!
        for (const record of frame.records as Message[]) {
          copy.records.push(record)
          copy.stored = Number(record.seq)
        }
        send({ t: 'ack', session: id, seq: copy.stored })
        return
      }
      case 'gone':
        this.copies.delete(String(frame.session))
        send({ t: 'ack', session: frame.session, seq: 0 })
        return
      case 'reply':
        this.replies.push(frame)
        return
    }
  }

  /** Sends a request down the link; the reply, when it comes. */
  async ask(body: Message): Promise<Message> {
    const id = this.replies.length + 1000
    this.socket?.send(JSON.stringify({ ...body, id }))
    return wait(() => this.replies.find(one => one.id === id))
  }

  /** The turns of a copy, each its last line. */
  turns(id: string): Message[] {
    const byId = new Map<string, Message>()
    for (const record of this.copies.get(id)?.records ?? []) {
      const turn = record.turn as Message
      byId.set(String(turn.id), turn)
    }
    return [...byId.values()]
  }

  stop(): Promise<void> {
    return this.server.stop(true)
  }
}

async function wait<T>(find: () => T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const found = find()
    if (found !== undefined && found !== false) return found
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(10)
  }
}

const hubs: FakeHub[] = []
const running: TestRunner[] = []
afterEach(async () => {
  for (const runner of running.splice(0)) await runner.stop()
  for (const hub of hubs.splice(0)) await hub.stop()
  cleanBoxes()
})

function hub(): FakeHub {
  const made = new FakeHub()
  hubs.push(made)
  return made
}

function runner(
  at: Box,
  to: FakeHub | undefined,
  deviceId = DEVICE,
): TestRunner {
  const started = startRunner(at, {
    pairing: async () =>
      to === undefined ? undefined : { hub: to.url, deviceId, token: TOKEN },
    linkBackoffMs: [20, 40],
  })
  running.push(started)
  return started
}

async function refused(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Refused) return error.code
    throw error
  }
  throw new Error('not refused')
}

const linkStates = (r: TestRunner) =>
  r.events('link').map(one => String(one.state))

describe.skipIf(!posix)('Remote, the runner’s end', () => {
  test('on: the head without paths, every record in order, acknowledged as pushedSeq', async () => {
    const at = box()
    const h = hub()
    const r = runner(at, h)
    expect((await r.call('hello')).features).toMatchObject({ remote: true })
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'hi')
    // Nothing wants the link yet.
    await Bun.sleep(100)
    expect(h.dials).toBe(0)
    expect(await r.call('list')).toMatchObject({ link: { state: 'off' } })

    const turned = await r.call('session.remote', { session: id, on: true })
    expect(turned.session).toMatchObject({ id, remote: true })
    await wait(() => linkStates(r).includes('up'))
    const sent = r.records(id).map(one => Number(one.seq))
    await wait(() => h.copies.get(id)?.stored === sent.at(-1))
    const copy = h.copies.get(id)!
    expect(Object.keys(copy.head).sort()).toEqual([
      'agent',
      'createdAt',
      'folder',
      'id',
      'lastSeq',
      'mode',
      'remote',
      'state',
      'title',
      'updatedAt',
    ])
    expect(copy.head).toMatchObject({ id, folder: 'work', remote: true })
    expect(JSON.stringify(h.frames)).not.toContain(at.work)
    expect(copy.records.map(one => Number(one.seq))).toEqual(sent)

    // A line here goes there as it is written.
    await r.say(id, 'more')
    const after = r.records(id).map(one => Number(one.seq))
    await wait(() => h.copies.get(id)?.stored === after.at(-1))
    expect(h.copies.get(id)!.records.map(one => Number(one.seq))).toEqual(after)
    expect(h.turns(id).map(turn => turn.text)).toEqual(
      r.turns(id).map(turn => turn.text),
    )

    // The acknowledged seq is in the head on disk once the runner stops.
    await r.stop()
    running.splice(running.indexOf(r), 1)
    const header = JSON.parse(
      fs.readFileSync(
        path.join(at.code, 'sessions', id, 'session.json'),
        'utf8',
      ),
    ) as Message
    expect(header.remote).toEqual({
      on: true,
      pushedSeq: after.at(-1),
      device: DEVICE,
    })
  }, 30_000)

  test('broken and back: what was written meanwhile, nothing twice; a line from elsewhere', async () => {
    const at = box()
    const h = hub()
    const r = runner(at, h)
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'hi')
    await r.call('session.remote', { session: id, on: true })
    await wait(() => h.copies.get(id)?.stored === r.records(id).at(-1)?.seq)

    // The hub goes away for a moment; a line is said meanwhile.
    h.refuse = 503
    h.socket?.close(1011, 'restarting')
    await wait(() => linkStates(r).includes('retrying'))
    await r.say(id, 'while away')
    h.refuse = undefined
    await wait(() => h.copies.get(id)?.stored === r.records(id).at(-1)?.seq)
    const seqs = h.copies.get(id)!.records.map(one => Number(one.seq))
    expect(seqs).toEqual(r.records(id).map(one => Number(one.seq)))
    expect(new Set(seqs).size).toBe(seqs.length)

    // A line sent from a browser: the runner runs it, marked as from elsewhere.
    const asked = r.mark
    const reply = await h.ask({
      t: 'send',
      session: id,
      text: 'from the phone',
      clientId: 'p-1',
    })
    expect(reply).toMatchObject({ t: 'reply', ok: true })
    await r.state(id, 'idle', asked)
    const remote = r.turns(id).find(turn => turn.text === 'from the phone')
    expect(remote).toMatchObject({
      author: 'operator',
      origin: 'remote',
      clientId: 'p-1',
    })
    await wait(() =>
      h
        .turns(id)
        .some(
          turn => turn.text === 'from the phone' && turn.origin === 'remote',
        ),
    )
    // A session without Remote is not reachable from there.
    const other = await begin(r, folder, 'private')
    expect(
      await h.ask({ t: 'send', session: other, text: 'x', clientId: 'p-2' }),
    ).toMatchObject({ ok: false, code: 'E_REMOTE' })
    expect(h.copies.has(other)).toBe(false)
    // A line from elsewhere never comes over the pipe.
    expect(
      await refused(
        r.call('session.send', {
          session: id,
          text: 'x',
          clientId: 'c',
          origin: 'remote',
        }),
      ),
    ).toBe('E_ARGS')
  }, 30_000)

  test('the last Remote off hangs up; on again dials again', async () => {
    const at = box()
    const h = hub()
    const r = runner(at, h)
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'hi')
    await r.call('session.remote', { session: id, on: true })
    await wait(() => h.socket !== undefined && h.copies.has(id))
    await r.call('session.remote', { session: id, on: false })
    await wait(() => h.socket === undefined)
    expect(h.copies.get(id)?.head.remote).toBe(false)
    expect(linkStates(r).at(-1)).toBe('off')
    const dials = h.dials
    await r.call('session.remote', { session: id, on: true })
    await wait(
      () => h.dials === dials + 1 && h.copies.get(id)?.head.remote === true,
    )
  }, 30_000)

  test('deleted here, its copy goes from the hub: told at once, or dialled for when the link is down', async () => {
    const at = box()
    const h = hub()
    const r = runner(at, h)
    const folder = await pick(r, at.work)
    const on = await begin(r, folder, 'hi')
    const off = await begin(r, folder, 'hi')
    for (const id of [on, off])
      await r.call('session.remote', { session: id, on: true })
    await wait(() => h.copies.has(on) && h.copies.has(off))
    // Turned off: its copy stays on the hub, read-only.
    await r.call('session.remote', { session: off, on: false })
    await wait(() => h.copies.get(off)?.head.remote === false)

    // Deleted with the link up: `gone` at once; the link then hangs up.
    expect(await r.call('session.delete', { session: on })).toEqual({})
    await wait(() => !h.copies.has(on))
    expect(h.frames).toContainEqual({ t: 'gone', session: on })
    await wait(() => h.socket === undefined)
    expect(linkStates(r).at(-1)).toBe('off')

    // Deleted with the link down: dialled for, told after the welcome.
    const dials = h.dials
    expect(await r.call('session.delete', { session: off })).toEqual({})
    await wait(() => !h.copies.has(off))
    expect(h.dials).toBe(dials + 1)
    expect(h.frames).toContainEqual({ t: 'gone', session: off })
    await wait(() => h.socket === undefined)

    // One that never had Remote on is nobody's business but this computer's.
    const local = await begin(r, folder, 'hi')
    const before = h.dials
    expect(await r.call('session.delete', { session: local })).toEqual({})
    await Bun.sleep(100)
    expect(h.dials).toBe(before)
    expect(h.frames.some(one => one.session === local)).toBe(false)
  }, 30_000)

  test('4401 stops the retries and says why; a refused handshake is asked about', async () => {
    const at = box()
    const h = hub()
    const r = runner(at, h)
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'hi')
    await r.call('session.remote', { session: id, on: true })
    await wait(() => h.socket !== undefined)
    h.socket?.close(4401, 'device_revoked')
    const said = await r.event(
      one => one.type === 'link' && one.state === 'refused',
    )
    expect(String(said.reason)).toContain('吊销')
    const dials = h.dials
    await Bun.sleep(200)
    expect(h.dials).toBe(dials)

    // Turned on again: one more try; the hub refuses the upgrade and says
    // why over plain HTTP.
    h.device = 'device_revoked'
    h.refuse = 401
    const mark = r.mark
    await r.call('session.remote', { session: id, on: true })
    const again = await r.event(
      one => one.type === 'link' && one.state === 'refused',
      undefined,
      mark,
    )
    expect(again.reason).toBe('这台设备已被吊销 · 在 Qmo 里重新登录')
    await Bun.sleep(200)
    expect(h.dials).toBe(dials + 1)
  }, 30_000)

  test('a hub without Remote says so, and the link stops trying', async () => {
    const at = box()
    const h = hub()
    h.linkPath = false
    const r = runner(at, h)
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'hi')
    await r.call('session.remote', { session: id, on: true })
    const said = await r.event(
      one => one.type === 'link' && one.state === 'refused',
    )
    expect(said.reason).toBe('这台中枢还没有 Remote（版本较旧）')
  }, 30_000)

  test('a copy at its limit: Remote off for that session, with a line saying why', async () => {
    const at = box()
    const h = hub()
    const r = runner(at, h)
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'hi')
    h.full.add(id)
    await r.call('session.remote', { session: id, on: true })
    await r.event(
      one =>
        one.type === 'session' &&
        (one.session as Message).id === id &&
        (one.session as Message).remote === false,
    )
    await wait(() => r.turns(id).at(-1)?.variant === 'notice')
    expect(r.turns(id).at(-1)).toMatchObject({
      variant: 'notice',
      severity: 'warn',
      text: expect.stringContaining('Remote 已关'),
    })
  }, 30_000)

  test('signed out, Remote does not turn on; turned on under another pairing, it turns off', async () => {
    const lone = box()
    const out = runner(lone, undefined)
    const folder = await pick(out, lone.work)
    const id = await begin(out, folder, 'hi')
    expect(
      await refused(out.call('session.remote', { session: id, on: true })),
    ).toBe('E_REMOTE')
    expect(
      await refused(
        out.call('session.start', {
          folder,
          agent: 'claude-code',
          mode: 'auto',
          worktree: false,
          text: 'hi',
          clientId: 'c',
          remote: true,
        }),
      ),
    ).toBe('E_REMOTE')

    const at = box()
    const h = hub()
    const first = runner(at, h)
    const picked = await pick(first, at.work)
    const session = await begin(first, picked, 'hi')
    await first.call('session.remote', { session, on: true })
    await wait(() => h.copies.has(session))
    await first.stop()
    running.splice(running.indexOf(first), 1)
    // Signed in again as another device: the old Remote is not this one's.
    const second = runner(at, h, OTHER_DEVICE)
    await second.call('hello')
    await second.event(
      one =>
        one.type === 'session' &&
        (one.session as Message).id === session &&
        (one.session as Message).remote === false,
    )
    await wait(() => second.turns(session).at(-1)?.variant === 'notice')
    expect(second.turns(session).at(-1)?.text).toBe(
      'Remote 是在上一次登录时开的，已关上',
    )
  }, 30_000)
})

describe('what a record takes to the hub', () => {
  const record = (turn: Partial<CodeRecord['turn']>): CodeRecord => ({
    seq: 1,
    kind: 'turn',
    turn: {
      id: 't-1',
      sessionId: 'cs_AbCdEfGhIjKlMnOpQrSt_-',
      author: 'agent',
      at: 1,
      text: 'x',
      state: 'done',
      ...turn,
    } as CodeRecord['turn'],
  })

  test('detail within 4 KiB: a diff keeps its head, an output its tail, never half a character', () => {
    const long = `${'前'.repeat(3000)}END`
    const diff = remoteDetail(long, 'diff')
    const output = remoteDetail(long, 'output')
    for (const cut of [diff, output]) {
      expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(REMOTE_DETAIL_BYTES)
      expect(cut).not.toContain('�')
      expect(cut).toContain('（更多在那台电脑上）')
    }
    expect(diff.startsWith('前前')).toBe(true)
    expect(output.endsWith('END')).toBe(true)
    expect(remoteDetail('short', 'output')).toBe('short')
  })

  test('a question keeps its own fields whole; the rest of the turn as written', () => {
    const ask = {
      id: 'ask_1',
      tool: 'Edit',
      title: '编辑 README.md',
      paths: ['README.md'],
      input: 'x'.repeat(2000),
      options: ['once', 'session', 'deny'] as const,
    }
    const sent = remoteRecord(
      record({
        ask: { ...ask, options: [...ask.options] },
        detail: 'y'.repeat(10_000),
      }),
    )
    expect(sent.turn.ask).toEqual({ ...ask, options: [...ask.options] })
    expect(Buffer.byteLength(sent.turn.detail ?? '')).toBeLessThanOrEqual(
      REMOTE_DETAIL_BYTES,
    )
    expect(remoteRecord(record({ text: 'plain' }))).toEqual({
      seq: 1,
      turn: record({ text: 'plain' }).turn,
    })
  })
})
