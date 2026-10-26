// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A runner on fake pipes, a fake `claude` and `codex` and the folders they
 * live in. No real agent is ever started: `claude` and `codex` here are the
 * harness package's `fake-claude-stream.runner.ts` and
 * `fake-codex-app-server.runner.ts` behind shell scripts; HOME and the
 * client folder are fresh temporary folders.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PassThrough } from 'node:stream'
import type { AgentsReport } from '../../src/agents.ts'
import { LoginEnvironment } from '../../src/code/env.ts'
import { type ServeOptions, serve } from '../../src/code/serve.ts'
import type { Limits } from '../../src/code/session.ts'

/** The harness package's fake Claude Code. */
export const FAKE_CLAUDE = path.join(
  path.dirname(Bun.resolveSync('@qianmo/harness/process.ts', import.meta.dir)),
  '..',
  'test',
  'fixtures',
  'fake-claude-stream.runner.ts',
)

/** The harness package's fake Codex app-server. */
export const FAKE_CODEX = path.join(
  path.dirname(FAKE_CLAUDE),
  'fake-codex-app-server.runner.ts',
)

export interface Box {
  readonly root: string
  readonly home: string
  readonly client: string
  readonly code: string
  readonly bin: string
  /** The fake's own logs (argv, answers, control requests). */
  readonly state: string
  /** A folder to pick. */
  readonly work: string
}

const roots: string[] = []

/** Removes every box made so far (call from `afterEach`). */
export function cleanBoxes(): void {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
}

export function box(): Box {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-code-')),
  )
  roots.push(root)
  const made = {
    root,
    home: path.join(root, 'home'),
    client: path.join(root, 'client'),
    code: path.join(root, 'client', 'code'),
    bin: path.join(root, 'bin'),
    state: path.join(root, 'state'),
    work: path.join(root, 'work'),
  }
  for (const dir of [made.home, made.bin, made.state, made.work])
    fs.mkdirSync(dir, { recursive: true })
  return made
}

/**
 * `<bin>/claude`: the fake, with `env` set for it. `exec: false` keeps the
 * shell as the process, so its command line names `<bin>/claude` as a real
 * install's does (`node /…/bin/claude`).
 */
export function fakeClaude(
  at: Box,
  env: Readonly<Record<string, string>> = {},
  exec = true,
): string {
  const file = path.join(at.bin, 'claude')
  const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`
  const vars = Object.entries({ FAKE_CLAUDE_STATE: at.state, ...env })
    .map(([name, value]) => `${name}=${quote(value)}`)
    .join(' ')
  fs.writeFileSync(
    file,
    `#!/bin/sh\n${vars} ${exec ? 'exec ' : ''}${quote(process.execPath)} ${quote(FAKE_CLAUDE)} "$@"\n`,
  )
  fs.chmodSync(file, 0o755)
  return file
}

/**
 * `<bin>/codex`: the fake app-server, with `env` set for it; its logs go to
 * `<state>/codex`.
 */
export function fakeCodex(
  at: Box,
  env: Readonly<Record<string, string>> = {},
): string {
  const file = path.join(at.bin, 'codex')
  const state = path.join(at.state, 'codex')
  fs.mkdirSync(state, { recursive: true })
  const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`
  const vars = Object.entries({ FAKE_CODEX_STATE: state, ...env })
    .map(([name, value]) => `${name}=${quote(value)}`)
    .join(' ')
  fs.writeFileSync(
    file,
    `#!/bin/sh\n${vars} exec ${quote(process.execPath)} ${quote(FAKE_CODEX)} "$@"\n`,
  )
  fs.chmodSync(file, 0o755)
  return file
}

/** What `qmo agents` would say: Codex at `program`, Claude Code at `claude`. */
export function codexReport(program: string, claude: string): AgentsReport {
  const report = claudeReport(claude)
  return {
    agents: report.agents.map(agent =>
      agent.id === 'codex' ? { ...agent, path: program } : agent,
    ),
  }
}

/** What `qmo agents` would say: Claude Code at `program`. */
export function claudeReport(program: string): AgentsReport {
  return {
    agents: [
      {
        id: 'claude-code',
        name: 'Claude Code',
        version: '9.9.9',
        path: program,
        protocol: 'claude-stream',
        available: true,
        reason: null,
        source: 'path',
        configFound: false,
        signedIn: null,
      },
      {
        id: 'codex',
        name: 'Codex',
        version: '0.164.0',
        path: '/nowhere/codex',
        protocol: 'codex-app-server',
        available: true,
        reason: null,
        source: 'path',
        configFound: false,
        signedIn: null,
      },
    ],
  }
}

export type Message = Record<string, unknown>

export class Refused extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.code = code
  }
}

/** A runner in this process, on pipes the test holds. */
export class TestRunner {
  readonly input = new PassThrough()
  readonly out: Message[] = []
  readonly logs: string[] = []
  readonly done: Promise<number>
  #id = 0
  readonly #waiters = new Set<() => void>()

  constructor(options: Omit<ServeOptions, 'io'>) {
    this.done = serve({
      ...options,
      io: {
        input: this.input,
        write: line => {
          this.out.push(JSON.parse(line) as Message)
          for (const wake of [...this.#waiters]) wake()
        },
        log: line => this.logs.push(line),
      },
    })
  }

  /** Waits until `find` returns something, at most `ms`. */
  async until<T>(find: () => T | undefined, ms = 10_000): Promise<T> {
    const found = find()
    if (found !== undefined) return found
    return new Promise<T>((resolve, reject) => {
      // Checked on every line, and every 25 ms for what is not a line (files).
      const poll = setInterval(() => check(), 25)
      const timer = setTimeout(() => {
        clearInterval(poll)
        this.#waiters.delete(check)
        reject(
          new Error(
            `timed out; last lines: ${JSON.stringify(this.out.slice(-6))}`,
          ),
        )
      }, ms)
      const check = () => {
        const value = find()
        if (value === undefined) return
        clearTimeout(timer)
        clearInterval(poll)
        this.#waiters.delete(check)
        resolve(value)
      }
      this.#waiters.add(check)
    })
  }

  send(line: string): void {
    this.input.write(`${line}\n`)
  }

  /** Calls a method; resolves with its result, rejects with {@link Refused}. */
  async call(method: string, params: unknown = {}): Promise<Message> {
    const id = ++this.#id
    this.send(JSON.stringify({ id, method, params }))
    const answer = await this.until(() => this.out.find(one => one.id === id))
    if (answer.error !== undefined) {
      const error = answer.error as { code: string; message: string }
      throw new Refused(error.code, error.message)
    }
    return answer.result as Message
  }

  /** The events so far. */
  events(type?: string): Message[] {
    return this.out
      .filter(one => one.method === 'event')
      .map(one => one.params as Message)
      .filter(one => type === undefined || one.type === type)
  }

  /** How many lines have come so far: a mark for {@link event}'s `after`. */
  get mark(): number {
    return this.out.length
  }

  /** Waits for an event matching `match`, among the lines from `after` on. */
  event(
    match: (event: Message) => boolean,
    ms?: number,
    after = 0,
  ): Promise<Message> {
    return this.until(
      () =>
        this.out
          .slice(after)
          .filter(one => one.method === 'event')
          .map(one => one.params as Message)
          .find(match),
      ms,
    )
  }

  /** The records sent for a session so far, by seq. */
  records(session: string): Message[] {
    return this.events('record')
      .filter(one => one.session === session && one.record !== undefined)
      .map(one => one.record as Message)
  }

  /** The last write of each turn of a session, in place of its first. */
  turns(session: string): Message[] {
    const byId = new Map<string, Message>()
    for (const record of this.records(session)) {
      const turn = record.turn as Message
      byId.set(String(turn.id), turn)
    }
    return [...byId.values()]
  }

  /** Waits for a session to reach `state`, from the line `after` on. */
  state(
    session: string,
    state: string,
    after = 0,
    ms?: number,
  ): Promise<Message> {
    return this.event(
      one =>
        one.type === 'session' &&
        (one.session as Message).id === session &&
        (one.session as Message).state === state,
      ms,
      after,
    )
  }

  /** Sends a line in a session and waits for it to settle in `state`. */
  async say(session: string, text: string, state = 'idle'): Promise<Message> {
    const mark = this.mark
    const sent = await this.call('session.send', {
      session,
      text,
      clientId: 'c2',
      origin: 'local',
    })
    await this.state(session, state, mark)
    return sent
  }

  async stop(): Promise<number> {
    this.input.end()
    return this.done
  }
}

export interface StartOptions {
  readonly fake?: Readonly<Record<string, string>>
  readonly limits?: Partial<Limits>
  /** The login shell's environment (default: none answered). */
  readonly login?: Record<string, string> | null
  readonly env?: NodeJS.ProcessEnv
  readonly scan?: ServeOptions['scan']
}

/** A runner with a fake Claude Code at `<bin>/claude`. */
export function startRunner(at: Box, options: StartOptions = {}): TestRunner {
  const claude = fakeClaude(at, options.fake)
  return new TestRunner({
    codeDir: at.code,
    clientDir: at.client,
    agentsCache: path.join(at.client, 'agents.json'),
    home: at.home,
    env: options.env ?? {
      PATH: `${at.bin}:/usr/bin:/bin`,
      HOME: at.home,
      SHELL: '/bin/sh',
    },
    loginEnv: new LoginEnvironment({
      ask: async () => (options.login === undefined ? null : options.login),
    }),
    scan: options.scan ?? (async () => claudeReport(claude)),
    limits: { deltaMs: 10, ...options.limits },
  })
}

/** Lines of a JSON-lines file the fake wrote. */
export function logged(file: string): Message[] {
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line) as Message)
    : []
}

/** Picks the box's work folder; its id. */
export async function pick(
  runner: TestRunner,
  folder: string,
): Promise<string> {
  const picked = await runner.call('folders.add', { path: folder })
  return String(picked.id)
}

/** Starts a session; its id once the first turn has ended. */
export async function begin(
  runner: TestRunner,
  folder: string,
  text: string,
  mode = 'auto',
  settle: string | null = 'idle',
  agent = 'claude-code',
): Promise<string> {
  const started = await runner.call('session.start', {
    folder,
    agent,
    mode,
    worktree: false,
    text,
    clientId: 'c1',
  })
  const id = String((started.session as Message).id)
  if (settle !== null) await runner.state(id, settle)
  return id
}
