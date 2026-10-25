// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The compiled `qmo` as the desktop shell runs it (qmo-local.md §4.3.2,
 * §4.5): built here the way `bun run atlas:build:client` builds it
 * (`buildClient`), started as `qmo code serve` on pipes, and spoken to the
 * way the shell speaks (`ipc.rs`: `origin: 'local'` added, `remote`
 * passed as the page set it, the calls of the contract `qmo-local-calls.json` beside the page's
 * fake shell in `@qianmo/console`'s tests). The agent is the
 * harness package's fake Claude Code, the folder a temporary Git
 * repository; HOME and the client folder are temporary. No real agent is
 * started.
 *
 * 1. One conversation end to end: hello, the folder picked, a session
 *    started in 人工确认, Claude Code's question answered, the file written,
 *    the answer streamed, the changes and the diff, the mode switched, a
 *    second line, shutdown. Checked: the order of the events, `seq` one by
 *    one, every record on disk as it was sent, no `runner` event from the
 *    runner (those are the shell's), standard output protocol only and the
 *    log without what was said.
 * 2. Every call of the shared contract reaches the runner in a shape it
 *    takes; one key more is refused.
 *
 * POSIX only: the fake is a shell script and the agent runs in a process
 * group of its own.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type Box,
  box,
  cleanBoxes,
  fakeClaude,
} from '../../packages/client/test/code/helpers.ts'
import { buildClient } from '../../scripts/build-client.ts'
import contract from '../../packages/console/test/browser/qmo-local-calls.json' with {
  type: 'json',
}

type Message = Record<string, unknown>

/** One call of the contract: what the shell asks the runner, when it asks. */
interface ContractCall {
  readonly command: string
  readonly method?: string
  readonly params?: Readonly<Record<string, unknown>>
}

const posix = process.platform !== 'win32'

/** `qmo code serve`, one JSON line each way, as `code.rs` runs it. */
class Served {
  readonly proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  readonly out: Message[] = []
  readonly raw: string[] = []
  stderr = ''
  #id = 0
  readonly #reading: Promise<void>

  constructor(qmo: string, at: Box) {
    const proc = Bun.spawn([qmo, 'code', 'serve'], {
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
    this.proc = proc
    this.#reading = (async () => {
      const decoder = new TextDecoder()
      let rest = ''
      for await (const chunk of proc.stdout) {
        rest += decoder.decode(chunk, { stream: true })
        for (let end = rest.indexOf('\n'); end >= 0; end = rest.indexOf('\n')) {
          const line = rest.slice(0, end)
          rest = rest.slice(end + 1)
          this.raw.push(line)
          this.out.push(JSON.parse(line) as Message)
        }
      }
    })()
    void (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of proc.stderr)
        this.stderr += decoder.decode(chunk, { stream: true })
    })()
  }

  /** How many lines have come so far. */
  get mark(): number {
    return this.out.length
  }

  async until<T>(find: () => T | undefined, ms = 15_000): Promise<T> {
    const end = Date.now() + ms
    for (;;) {
      const found = find()
      if (found !== undefined) return found
      if (Date.now() > end)
        throw new Error(
          `timed out; last lines: ${JSON.stringify(this.out.slice(-6))}\n${this.stderr}`,
        )
      await Bun.sleep(10)
    }
  }

  /** The answer to one request: `{result}` or `{error}`. */
  async ask(method: string, params: unknown = {}): Promise<Message> {
    const id = ++this.#id
    this.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    this.proc.stdin.flush()
    return this.until(() => this.out.find(one => one.id === id))
  }

  async call(method: string, params: unknown = {}): Promise<Message> {
    const answer = await this.ask(method, params)
    if (answer.error !== undefined)
      throw new Error(`${method}: ${JSON.stringify(answer.error)}`)
    return answer.result as Message
  }

  /** The events from line `after` on. */
  events(after = 0): Message[] {
    return this.out
      .slice(after)
      .filter(one => one.method === 'event')
      .map(one => one.params as Message)
  }

  /** Waits for a session to reach `state`, from line `after` on. */
  state(session: string, state: string, after: number): Promise<Message> {
    return this.until(() =>
      this.events(after).find(
        one =>
          one.type === 'session' &&
          (one.session as Message).id === session &&
          (one.session as Message).state === state,
      ),
    )
  }

  async exited(): Promise<number> {
    const code = await this.proc.exited
    await this.#reading
    return code
  }
}

let built = ''
const procs: Served[] = []

function serve(at: Box): Served {
  const one = new Served(built, at)
  procs.push(one)
  return one
}

/** A Git repository with one committed file, `README.md`. */
function repository(at: Box): void {
  const git = (...args: string[]) => {
    const done = Bun.spawnSync(['git', ...args], {
      cwd: at.work,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: at.home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    })
    if (done.exitCode !== 0)
      throw new Error(`git ${args.join(' ')}: ${done.stderr.toString()}`)
  }
  git('init', '-q')
  fs.writeFileSync(path.join(at.work, 'README.md'), 'one\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
}

describe.skipIf(!posix)('the compiled qmo as the shell runs it', () => {
  let out = ''

  beforeAll(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-built-'))
    built = path.join(out, 'qmo')
    expect(buildClient(built, undefined, 'ignore')).toBe(0)
  }, 120_000)

  afterAll(async () => {
    for (const one of procs.splice(0)) {
      one.proc.kill('SIGKILL')
      await one.proc.exited
    }
    cleanBoxes()
    if (out !== '') fs.rmSync(out, { recursive: true, force: true })
  })

  test('one conversation end to end: events in order, seq one by one, the records on disk', async () => {
    const at = box()
    repository(at)
    fakeClaude(at)
    const r = serve(at)

    // `hello`, as the shell asks it before anything else.
    const hello = await r.call('hello')
    expect(Object.keys(hello).sort()).toEqual([
      'codeDir',
      'features',
      'protocol',
      'version',
    ])
    expect(hello).toMatchObject({
      protocol: 1,
      features: {
        protocols: ['claude-stream'],
        worktree: false,
        remote: true,
      },
      codeDir: path.join(at.client, 'code'),
    })

    // The folder the native picker gave the shell.
    const folder = await r.call('folders.add', { path: at.work })
    expect(folder).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{16}$/),
      name: 'work',
      path: at.work,
      git: true,
    })

    // The first line, in 人工确认: Claude Code asks before it edits.
    const mark = r.mark
    const started = await r.call('session.start', {
      folder: folder.id,
      agent: 'claude-code',
      mode: 'off',
      worktree: false,
      text: 'edit README.md',
      clientId: 'c-1',
      remote: false,
    })
    const summary = started.session as Message
    const id = String(summary.id)
    expect(id).toMatch(/^cs_[A-Za-z0-9_-]{22}$/)
    expect(summary).toMatchObject({
      title: 'edit README.md',
      folder: { id: folder.id, name: 'work' },
      agent: { id: 'claude-code', name: 'Claude Code' },
      mode: 'off',
      state: 'running',
      remote: false,
    })
    expect(started.turn).toMatchObject({
      sessionId: id,
      author: 'operator',
      text: 'edit README.md',
      state: 'read',
      clientId: 'c-1',
    })
    await r.state(id, 'waiting', mark)
    const asked = r
      .events(mark)
      .map(one => (one.record as Message | undefined)?.turn as Message)
      .find(turn => turn?.ask !== undefined)!
    const ask = asked.ask as Message
    expect(ask).toMatchObject({
      tool: 'Edit',
      options: ['once', 'session', 'deny'],
    })
    expect(ask.decision).toBeUndefined()
    // Not written before it is allowed.
    expect(fs.readFileSync(path.join(at.work, 'README.md'), 'utf8')).toBe(
      'one\n',
    )
    const answered = r.mark
    expect(
      await r.call('session.answer', {
        session: id,
        ask: ask.id,
        decision: 'once',
      }),
    ).toEqual({})
    await r.state(id, 'idle', answered)
    expect(fs.readFileSync(path.join(at.work, 'README.md'), 'utf8')).toBe(
      'one\nedited\n',
    )

    // The events of the turn, in order.
    const events = r
      .events(mark)
      .filter(one => one.session === id || (one.session as Message)?.id === id)
    for (const event of r.events()) expect(event.v).toBe(1)
    const records = events.filter(one => one.type === 'record')
    expect(records.map(one => one.seq)).toEqual(records.map((_, i) => i + 1))
    expect(records.every(one => one.trimmed === undefined)).toBe(true)
    const turns = records.map(one => (one.record as Message).turn as Message)
    const edit = turns[1]!
    expect(turns.map(turn => turn.id)).toEqual([
      turns[0]!.id,
      edit.id,
      asked.id,
      asked.id,
      edit.id,
      turns[5]!.id,
    ])
    expect(turns[0]).toMatchObject({ author: 'operator', clientId: 'c-1' })
    expect(edit).toMatchObject({
      author: 'agent',
      variant: 'notice',
      noticeSource: 'step',
      tool: {
        name: 'Edit',
        status: 'running',
        detailKind: 'diff',
        added: 1,
        removed: 0,
      },
    })
    expect(String(edit.detail)).toContain('+edited')
    expect(turns[2]).toMatchObject({ variant: 'notice', severity: 'warn' })
    expect(turns[3]!.ask).toMatchObject({ decision: 'once', by: 'user' })
    expect(turns[4]).toMatchObject({
      tool: { status: 'done', approvedBy: 'user' },
      severity: 'info',
    })
    const answer = turns[5]!
    expect(answer).toMatchObject({
      author: 'agent',
      state: 'done',
      text: 'echo(1): edit README.md',
    })
    // The answer streamed first: deltas of its turn, one after another,
    // all before its record.
    const at5 = events.indexOf(records[5]!)
    const deltas = events.filter(one => one.type === 'delta')
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas.every(one => one.turn === answer.id)).toBe(true)
    expect(deltas.every(one => events.indexOf(one) < at5)).toBe(true)
    let offset = 0
    for (const delta of deltas) {
      expect(delta.offset).toBe(offset)
      offset += String(delta.text).length
    }
    expect(deltas.map(one => one.text).join('')).toBe(String(answer.text))
    // The session's states: running, waiting for the answer, running, idle.
    const states = events
      .filter(one => one.type === 'session')
      .map(one => (one.session as Message).state)
    expect(states.filter((s, i) => s !== states[i - 1])).toEqual([
      'running',
      'waiting',
      'running',
      'idle',
    ])
    // Up and down are the shell's to say, not the runner's.
    expect(r.events().filter(one => one.type === 'runner')).toEqual([])
    // Every event small enough for the shell's channel to send whole.
    for (const event of r.events())
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(8 * 1024)

    // The changes and the diff of the Git folder.
    expect(await r.call('session.changes', { session: id })).toEqual({
      source: 'git',
      base: 'HEAD',
      files: [
        {
          path: 'README.md',
          status: 'modified',
          added: 1,
          removed: 0,
          binary: false,
        },
      ],
      truncated: false,
    })
    const diff = await r.call('session.diff', {
      session: id,
      path: 'README.md',
    })
    expect(diff).toMatchObject({
      path: 'README.md',
      truncated: false,
      binary: false,
    })
    expect(String(diff.text)).toContain('+edited')

    // The mode: the runner's answer is the one that holds.
    expect(await r.call('session.mode', { session: id, mode: 'auto' })).toEqual(
      { mode: 'auto', applies: 'now' },
    )

    // A second line, as the shell sends it.
    const second = r.mark
    expect(
      await r.call('session.send', {
        session: id,
        text: 'say sentinel-4c1d',
        clientId: 'c-2',
        origin: 'local',
      }),
    ).toMatchObject({ queued: false, turn: { clientId: 'c-2', state: 'read' } })
    await r.state(id, 'idle', second)

    // What `session.read` gives back is what was sent, the last write of
    // each turn in place of its first.
    const sent = r
      .events()
      .filter(one => one.type === 'record' && one.session === id)
      .map(one => one.record as Message)
    const last = new Map<string, Message>()
    for (const record of sent)
      last.set(String((record.turn as Message).id), record)
    const read = await r.call('session.read', { session: id, limit: 200 })
    expect(read.more).toBe(false)
    expect(read.lastSeq).toBe(sent.at(-1)!.seq)
    expect(read.records).toEqual([...last.values()])
    expect((read.records as Message[]).at(-1)!.turn).toMatchObject({
      author: 'agent',
      text: 'echo(2): say sentinel-4c1d',
    })

    // On disk: the envelope, then every record as it was sent, seq one by one.
    const dir = path.join(at.client, 'code', 'sessions', id)
    const lines = fs
      .readFileSync(path.join(dir, 'events.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Message)
    expect(lines[0]).toMatchObject({
      kind: 'session',
      seq: 0,
      session: { id, target: 'local', node: 'local', agent: 'Claude Code' },
    })
    expect(lines.slice(1)).toEqual(sent)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(dir, 'events.ndjson')).mode & 0o777).toBe(
      0o600,
    )
    const header = JSON.parse(
      fs.readFileSync(path.join(dir, 'session.json'), 'utf8'),
    ) as Message
    expect(header).toMatchObject({
      id,
      mode: 'auto',
      state: 'idle',
      lastSeq: sent.at(-1)!.seq,
      native: { kind: 'claude-session', started: true },
    })

    // Quitting Qmo.
    expect(await r.call('shutdown')).toEqual({})
    expect(await r.exited()).toBe(0)
    procs.length = 0
    for (const line of r.raw) {
      const message = JSON.parse(line) as Message
      expect(typeof message.id === 'number' || message.method === 'event').toBe(
        true,
      )
    }
    expect(fs.existsSync(path.join(at.client, 'code', 'runner.lock'))).toBe(
      false,
    )
    expect(r.stderr).toContain('[runner] down')
    // The log says what happened, never what was said.
    expect(r.stderr).not.toContain('sentinel-4c1d')
  }, 60_000)

  test('every call of the shared contract reaches the runner in a shape it takes', async () => {
    const at = box()
    const r = serve(at)
    await r.call('hello')
    let asked = 0
    for (const {
      method,
      params,
    } of contract.calls as readonly ContractCall[]) {
      if (method === undefined || params === undefined) continue
      asked += 1
      const answer = await r.ask(method, params)
      const code = (answer.error as Message | undefined)?.code
      // The ids are made up: an unknown folder or session, never the shape.
      expect([method, code]).not.toEqual([method, 'E_ARGS'])
      const more = await r.ask(method, { ...params, extra: 1 })
      expect([method, (more.error as Message | undefined)?.code]).toEqual([
        method,
        'E_ARGS',
      ])
    }
    // list, folders.forget and the nine session methods a page reaches.
    expect(asked).toBe(11)
    expect(await r.call('shutdown')).toEqual({})
    expect(await r.exited()).toBe(0)
  }, 30_000)
})
