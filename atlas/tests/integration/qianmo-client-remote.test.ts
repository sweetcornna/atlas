// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Remote end to end (P37.15, qmo-local.md §5): the `qmo` compiled here the
 * way `bun run atlas:build:client` compiles it (`buildClient`), run as
 * `qmo code serve` the way the desktop shell runs it, against a hub on
 * loopback with the production account book, device ledger and copy store
 * in a temporary folder. The device is paired over `/v0/handoff/pair` as
 * `qmo sign-in` pairs it, and its pairing written to a temporary client
 * folder. The agent is the harness package's fake Claude Code. No real
 * agent, app window or fleet machine is involved.
 *
 * 1. Bun's own WebSocket in the compiled binary completes the handshake
 *    (`qmo-link.1`) — the failure this guards against is a build that
 *    inlines the pure-JS `ws` and never hears a 101 — and the bundle has no
 *    `ws` in it at all.
 * 2. A session started with Remote on: its copy on the hub has every record
 *    of its `events.ndjson`, in order.
 * 3. A line sent from the account's browser runs on the computer, marked
 *    `origin: 'remote'`, and comes back into the copy.
 * 4. The hub restarted: a line said meanwhile is pushed once the runner has
 *    dialled again, nothing twice.
 * 5. The device signed out: the link closes, the copies go, and a redial is
 *    refused with the reason.
 *
 * POSIX only, as the serve test: the fake is a shell script.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  AccountBook,
  type ConsoleServerHandle,
  startConsoleServer,
} from '@qianmo/console'
import { FileLedger } from '@qianmo/node/commands/consoleAccountsStore.js'
import { openConsoleCodeCopies } from '@qianmo/node/commands/consoleCodeCopies.js'
import { openConsoleHandoffDevices } from '@qianmo/node/commands/consoleHandoffDevices.js'
import {
  CountingChat,
  LIMITS,
  TOKENS,
} from '../../packages/console/test/accountsHarness.js'
import { ClientHome } from '../../packages/client/src/home.ts'
import {
  type Box,
  box,
  cleanBoxes,
  fakeClaude,
} from '../../packages/client/test/code/helpers.ts'
import { buildClient } from '../../scripts/build-client.ts'

type Message = Record<string, unknown>

const posix = process.platform !== 'win32'
const REPO_ROOT = path.join(import.meta.dir, '..', '..', '..')
const ENTRY = path.join(
  REPO_ROOT,
  'atlas',
  'packages',
  'client',
  'src',
  'cli.ts',
)

/** `qmo code serve` on pipes, one JSON line each way. */
class Served {
  readonly proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  readonly out: Message[] = []
  stderr = ''
  #id = 0

  constructor(qmo: string, at: Box) {
    this.proc = Bun.spawn([qmo, 'code', 'serve'], {
      env: {
        PATH: `${at.bin}:/usr/bin:/bin`,
        HOME: at.home,
        SHELL: '/bin/sh',
        QMO_CLIENT_DIR: at.client,
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const proc = this.proc
    void (async () => {
      const decoder = new TextDecoder()
      let rest = ''
      for await (const chunk of proc.stdout) {
        rest += decoder.decode(chunk, { stream: true })
        for (let end = rest.indexOf('\n'); end >= 0; end = rest.indexOf('\n')) {
          this.out.push(JSON.parse(rest.slice(0, end)) as Message)
          rest = rest.slice(end + 1)
        }
      }
    })()
    void (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of proc.stderr)
        this.stderr += decoder.decode(chunk, { stream: true })
    })()
  }

  get mark(): number {
    return this.out.length
  }

  async until<T>(find: () => T | undefined, ms = 20_000): Promise<T> {
    const end = Date.now() + ms
    for (;;) {
      const found = find()
      if (found !== undefined) return found
      if (Date.now() > end)
        throw new Error(
          `timed out; last lines: ${JSON.stringify(this.out.slice(-5)).slice(0, 2000)}\n${this.stderr.slice(-3000)}`,
        )
      await Bun.sleep(20)
    }
  }

  async call(method: string, params: unknown = {}): Promise<Message> {
    const id = ++this.#id
    this.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    this.proc.stdin.flush()
    const answer = await this.until(() => this.out.find(one => one.id === id))
    if (answer.error !== undefined)
      throw new Error(`${method}: ${JSON.stringify(answer.error)}`)
    return answer.result as Message
  }

  events(after = 0): Message[] {
    return this.out
      .slice(after)
      .filter(one => one.method === 'event')
      .map(one => one.params as Message)
  }

  idle(session: string, after: number): Promise<Message> {
    return this.until(() =>
      this.events(after).find(
        one =>
          one.type === 'session' &&
          (one.session as Message).id === session &&
          (one.session as Message).state === 'idle',
      ),
    )
  }

  link(state: string, after = 0): Promise<Message> {
    return this.until(() =>
      this.events(after).find(
        one => one.type === 'link' && one.state === state,
      ),
    )
  }
}

/** The records of a session's `events.ndjson`, as the runner wrote them. */
function written(at: Box, session: string): Message[] {
  return fs
    .readFileSync(
      path.join(at.code, 'sessions', session, 'events.ndjson'),
      'utf8',
    )
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Message)
    .filter(line => line.kind === 'turn')
}

describe.skipIf(!posix)(
  'Remote: the compiled qmo and a hub on loopback',
  () => {
    let out = ''
    let built = ''
    let root = ''
    let server: ConsoleServerHandle | undefined
    const procs: Served[] = []
    const closers: (() => void)[] = []

    beforeAll(() => {
      out = fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-remote-built-'))
      built = path.join(out, 'qmo')
      expect(buildClient(built, undefined, 'ignore')).toBe(0)
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-remote-hub-'))
    }, 120_000)

    afterAll(async () => {
      for (const one of procs.splice(0)) {
        one.proc.kill('SIGKILL')
        await one.proc.exited
      }
      await server?.stop()
      for (const close of closers.splice(0).reverse()) close()
      cleanBoxes()
      for (const dir of [out, root])
        if (dir !== '') fs.rmSync(dir, { recursive: true, force: true })
    })

    test('the bundle has no ws: the link is Bun’s own WebSocket', () => {
      const plain = path.join(out, 'bundle.js')
      const bundled = Bun.spawnSync(
        [process.execPath, 'build', '--target=bun', '--outfile', plain, ENTRY],
        { cwd: REPO_ROOT },
      )
      expect(bundled.exitCode).toBe(0)
      const text = fs.readFileSync(plain, 'utf8')
      expect(text).toContain('qmo-link.1')
      expect(text).not.toMatch(/node_modules\/ws\//)
    }, 60_000)

    test('handshake, push, a line from the browser, a hub restart, a sign-out', async () => {
      // ---- the hub ----
      const accounts = new FileLedger(path.join(root, 'accounts.ndjson'))
      const sessions = new FileLedger(path.join(root, 'sessions.ndjson'))
      closers.push(() => {
        accounts.close()
        sessions.close()
      })
      const book = new AccountBook({ accounts, sessions })
      const devices = openConsoleHandoffDevices({
        path: path.join(root, 'devices.ndjson'),
        accounts: book,
        pairWith: 'client',
      })
      closers.push(() => devices.close())
      const copiesRoot = path.join(root, 'code-remote')
      const unsupported = {
        ok: false as const,
        failure: { code: 'unsupported' as const, message: 'not here' },
      }
      const depsWith = (copies: ReturnType<typeof openConsoleCodeCopies>) => ({
        registry: {
          list: async () => ({ ok: true as const, value: [] }),
          register: async () => unsupported,
          deregister: async () => ({ ok: true as const, value: undefined }),
          heartbeat: async () => unsupported,
        },
        audit: {
          read: async () => unsupported,
          chain: async () => ({ ok: true as const, value: null }),
        },
        limits: LIMITS,
        chat: new CountingChat(),
        handoffDevices: devices,
        codeCopies: copies,
      })
      server = startConsoleServer(
        depsWith(openConsoleCodeCopies({ root: copiesRoot })),
        0,
        { tokens: TOKENS, accounts: { book } },
      )
      const port = server.port
      const hubUrl = server.url

      const invite = book.issueInvite({
        role: 'member',
        issuedBy: 'legacy:admin',
      })
      if (!invite.ok) throw new Error('invite')
      const user = book.acceptInvite(invite.value.token)
      if (!user.ok) throw new Error('accept')
      const login = book.login(user.value.credential, '')
      if (!login.ok) throw new Error('login')
      const subject = user.value.subject as string
      const sid = login.value.sid
      const pairing = await devices.issuePairing(
        { subject, role: 'member', requestId: 'remote' },
        hubUrl,
      )
      if (!pairing.ok) throw new Error('pairing')
      const paired = await fetch(`${hubUrl}/v0/handoff/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: pairing.value.code,
          name: 'mac',
          platform: 'darwin-arm64',
          kind: 'client',
        }),
      })
      expect(paired.status).toBe(200)
      const { token, deviceId } = (await paired.json()) as {
        token: string
        deviceId: string
      }

      // ---- the computer ----
      const at = box()
      fakeClaude(at)
      fs.mkdirSync(at.work, { recursive: true })
      await new ClientHome(at.client).save(
        {
          version: 1,
          hub: hubUrl,
          deviceId,
          name: 'mac',
          pairedAt: new Date().toISOString(),
        },
        token,
      )
      const r = new Served(built, at)
      procs.push(r)
      expect((await r.call('hello')).features).toMatchObject({ remote: true })
      const folder = await r.call('folders.add', { path: at.work })

      // ---- 1, 2: Remote on from the first line; the copy is the file ----
      const mark = r.mark
      const started = await r.call('session.start', {
        folder: folder.id,
        agent: 'claude-code',
        mode: 'auto',
        worktree: false,
        text: 'hello from here',
        clientId: 'c-1',
        remote: true,
      })
      const id = String((started.session as Message).id)
      expect(started.session).toMatchObject({ remote: true })
      await r.idle(id, mark)
      await r.link('up', mark)
      const key = `${deviceId}.${id}`
      const asPerson = (method: string, tail: string, body?: unknown) =>
        fetch(`${hubUrl}/v0/code/${tail}`, {
          method,
          headers: {
            cookie: `qianmo_session=${sid}`,
            'x-qianmo-console': '1',
            'sec-fetch-site': 'same-origin',
            origin: hubUrl,
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      const copy = async (): Promise<{
        records: Message[]
        lastSeq: number
      }> => {
        const response = await asPerson(
          'GET',
          `sessions/${deviceId}/${id}?limit=200`,
        )
        expect(response.status).toBe(200)
        return (await response.json()) as {
          records: Message[]
          lastSeq: number
        }
      }
      const lastWritten = () => Number(written(at, id).at(-1)?.seq)
      const caughtUp = async () => {
        const deadline = Date.now() + 20_000
        for (;;) {
          if ((await copy()).lastSeq === lastWritten()) return
          if (Date.now() > deadline) throw new Error(`copy behind\n${r.stderr}`)
          await Bun.sleep(50)
        }
      }
      await caughtUp()
      const listed = (await (await asPerson('GET', 'sessions')).json()) as {
        sessions: Message[]
      }
      expect(listed.sessions.map(one => one.id)).toEqual([key])
      expect(listed.sessions[0]).toMatchObject({
        device: { id: deviceId, name: 'mac', online: true },
        folder: { id: null, name: 'work' },
        remote: true,
      })
      // Each turn's last line, as the file has it.
      const lastOfEach = (lines: Message[]) => {
        const byTurn = new Map<string, Message>()
        for (const line of lines) {
          const turn = line.turn as Message
          byTurn.set(String(turn.id), {
            id: turn.id,
            text: turn.text,
            state: turn.state,
          })
        }
        return [...byTurn.values()]
      }
      expect(lastOfEach((await copy()).records)).toEqual(
        lastOfEach(written(at, id)),
      )
      // The copy on disk is under the account's hash, 0600, with no path in it.
      const onDisk = fs.readFileSync(
        path.join(
          copiesRoot,
          fs.readdirSync(copiesRoot)[0]!,
          deviceId,
          id,
          'session.json',
        ),
      )
      expect(onDisk.toString()).not.toContain(at.work)

      // ---- 3: a line from the browser ----
      const before = r.mark
      const sent = await asPerson(
        'POST',
        `sessions/${deviceId}/${id}/messages`,
        {
          text: 'from the browser',
          clientId: 'b-1',
        },
      )
      expect(sent.status).toBe(200)
      await r.idle(id, before)
      const remoteLine = written(at, id)
        .map(line => line.turn as Message)
        .find(turn => turn.text === 'from the browser')
      expect(remoteLine).toMatchObject({
        author: 'operator',
        origin: 'remote',
        clientId: 'b-1',
      })
      await caughtUp()

      // ---- 4: the hub restarts; a line said meanwhile goes after ----
      await server.stop()
      server = undefined
      const down = r.mark
      await r.link('retrying', down)
      const said = r.mark
      await r.call('session.send', {
        session: id,
        text: 'while the hub was away',
        clientId: 'c-2',
        origin: 'local',
      })
      await r.idle(id, said)
      // The copies as the restarted hub reads them back from disk.
      server = startConsoleServer(
        depsWith(openConsoleCodeCopies({ root: copiesRoot })),
        port,
        { tokens: TOKENS, accounts: { book } },
      )
      await r.link('up', down)
      await caughtUp()
      const seqs = (await copy()).records.map(one => Number(one.seq))
      expect(new Set(seqs).size).toBe(seqs.length)
      expect(
        lastOfEach((await copy()).records).some(
          turn => turn.text === 'while the hub was away',
        ),
      ).toBe(true)

      // ---- 5: signed out: closed, gone, refused ----
      const out = r.mark
      const revoked = await fetch(`${hubUrl}/v0/client/device`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(revoked.status).toBe(204)
      const refused = await r.link('refused', out)
      expect(String(refused.reason)).toContain('吊销')
      expect(
        ((await (await asPerson('GET', 'sessions')).json()) as { sessions: [] })
          .sessions,
      ).toEqual([])
      // Turned on again: one more dial, refused before the upgrade, and said why.
      await r.call('session.remote', { session: id, on: false })
      const again = r.mark
      await r.call('session.remote', { session: id, on: true })
      const second = await r.link('refused', again)
      expect(second.reason).toBe('这台设备已被吊销 · 在 Qmo 里重新登录')
      // No token in the runner's log.
      expect(r.stderr).not.toContain(token)
      expect(await r.call('shutdown')).toEqual({})
      expect(await r.proc.exited).toBe(0)
    }, 120_000)
  },
)
