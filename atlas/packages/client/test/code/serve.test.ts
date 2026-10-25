// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qmo code serve` as the shell meets it: a process on pipes. Standard output
 * is protocol only; the end of input and `shutdown` both end it; one runner
 * per client folder; a runner killed mid-turn leaves its sessions
 * interrupted and its agent processes ended by the next one. The agent is
 * the fake Claude Code; HOME and the client folder are temporary.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { type Box, box, cleanBoxes, fakeClaude, logged } from './helpers.ts'

const CLI = path.join(import.meta.dir, '..', '..', 'src', 'cli.ts')
const posix = process.platform !== 'win32'

type Message = Record<string, unknown>

class Proc {
  readonly proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  readonly out: Message[] = []
  readonly raw: string[] = []
  stderr = ''
  #id = 0
  readonly #reading: Promise<void>

  constructor(at: Box, env: Record<string, string> = {}) {
    const proc = Bun.spawn([process.execPath, CLI, 'code', 'serve'], {
      env: {
        PATH: `${at.bin}:/usr/bin:/bin`,
        HOME: at.home,
        SHELL: '/bin/sh',
        QMO_CLIENT_DIR: at.client,
        ...env,
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
        for (;;) {
          const end = rest.indexOf('\n')
          if (end < 0) break
          const line = rest.slice(0, end)
          rest = rest.slice(end + 1)
          this.raw.push(line)
          this.out.push(JSON.parse(line) as Message)
        }
      }
    })()
    void (async () => {
      for await (const chunk of proc.stderr)
        this.stderr += new TextDecoder().decode(chunk)
    })()
  }

  async until<T>(find: () => T | undefined, ms = 10_000): Promise<T> {
    const end = Date.now() + ms
    for (;;) {
      const found = find()
      if (found !== undefined) return found
      if (Date.now() > end)
        throw new Error(
          `timed out: ${JSON.stringify(this.out.slice(-4))} ${this.stderr}`,
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
      throw new Error(JSON.stringify(answer.error))
    return answer.result as Message
  }

  async end(): Promise<number> {
    this.proc.stdin.end()
    const code = await this.proc.exited
    await this.#reading
    return code
  }
}

const procs: Proc[] = []
afterEach(async () => {
  for (const one of procs.splice(0)) {
    one.proc.kill('SIGKILL')
    await one.proc.exited
  }
  cleanBoxes()
})

function serve(at: Box, env?: Record<string, string>): Proc {
  const one = new Proc(at, env)
  procs.push(one)
  return one
}

describe.skipIf(!posix)('qmo code serve', () => {
  test('protocol on standard output only; the end of input ends it', async () => {
    const at = box()
    const runner = serve(at)
    expect(await runner.call('hello')).toMatchObject({
      protocol: 1,
      codeDir: path.join(at.client, 'code'),
    })
    await runner.call('list')
    expect(await runner.end()).toBe(0)
    procs.length = 0
    for (const line of runner.raw) {
      const message = JSON.parse(line) as Message
      expect(typeof message.id === 'number' || message.method === 'event').toBe(
        true,
      )
    }
    expect(runner.stderr).toContain('[runner] up')
    expect(runner.stderr).toContain('[runner] down')
    // The lock is gone with it.
    expect(fs.existsSync(path.join(at.client, 'code', 'runner.lock'))).toBe(
      false,
    )
  })

  test('shutdown: within the shell’s 3 s, every agent ended, even one that ignores SIGTERM', async () => {
    const at = box()
    fakeClaude(at, { FAKE_CLAUDE_IGNORE_TERM: '1' })
    const runner = serve(at)
    const folder = await runner.call('folders.add', { path: at.work })
    await runner.call('session.start', {
      folder: folder.id,
      agent: 'claude-code',
      mode: 'auto',
      worktree: false,
      text: 'spawn',
      clientId: 'c',
    })
    const grandchild = await runner.until(() => {
      const pid: unknown = logged(path.join(at.state, 'grandchild.ndjson'))[0]
      return typeof pid === 'number' ? pid : undefined
    })
    const { children } = JSON.parse(
      fs.readFileSync(path.join(at.client, 'code', 'children.json'), 'utf8'),
    ) as { children: Message[] }
    const agent = Number(children[0]!.pid)
    const asked = Date.now()
    expect(await runner.call('shutdown')).toEqual({})
    expect(Date.now() - asked).toBeLessThan(3_000)
    expect(await runner.proc.exited).toBe(0)
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    await runner.until(
      () => (alive(agent) || alive(grandchild) ? undefined : true),
      2_000,
    )
  }, 20_000)

  test('one runner per client folder; a dead one’s lock is taken over', async () => {
    const at = box()
    const first = serve(at)
    await first.call('hello')
    const second = serve(at)
    expect(await second.proc.exited).toBe(1)
    await second.until(() =>
      second.stderr.includes('another runner') ? true : undefined,
    )
    expect(second.out).toEqual([])
    first.proc.kill('SIGKILL')
    await first.proc.exited
    // The lock still names the killed one; the next runner takes it over.
    expect(fs.existsSync(path.join(at.client, 'code', 'runner.lock'))).toBe(
      true,
    )
    const third = serve(at)
    expect((await third.call('hello')).protocol).toBe(1)
  })

  test('killed mid-turn: the next runner ends the agent it left and marks the session interrupted', async () => {
    const at = box()
    fakeClaude(at, {}, false)
    const first = serve(at)
    const folder = await first.call('folders.add', { path: at.work })
    const started = await first.call('session.start', {
      folder: folder.id,
      agent: 'claude-code',
      mode: 'auto',
      worktree: false,
      text: 'spawn',
      clientId: 'c',
      remote: false,
    })
    const id = String((started.session as Message).id)
    const grandchild = await first.until(() => {
      const pid: unknown = logged(path.join(at.state, 'grandchild.ndjson'))[0]
      return typeof pid === 'number' ? pid : undefined
    })
    const { children } = JSON.parse(
      fs.readFileSync(path.join(at.client, 'code', 'children.json'), 'utf8'),
    ) as { children: Message[] }
    expect(children).toEqual([
      {
        pid: expect.any(Number),
        startedAt: expect.any(Number),
        program: path.join(at.bin, 'claude'),
        session: id,
      },
    ])
    const agent = Number(children[0]!.pid)
    // A line queued behind it, not yet sent.
    expect(
      await first.call('session.send', {
        session: id,
        text: 'queued',
        clientId: 'q',
        origin: 'local',
      }),
    ).toMatchObject({ queued: true })
    first.proc.kill('SIGKILL')
    await first.proc.exited
    // Left running: the agent and what it started.
    expect(() => process.kill(agent, 0)).not.toThrow()
    const second = serve(at)
    const listed = await second.call('list')
    expect((listed.sessions as Message[])[0]).toMatchObject({
      id,
      state: 'interrupted',
    })
    // The queued line is marked 未发出, and the summary counts that write.
    const repaired = await second.call('session.read', { session: id })
    expect((repaired.records as Message[]).at(-1)!.turn).toMatchObject({
      text: 'queued',
      state: 'failed',
      code: 'E_NOT_SENT',
    })
    expect((listed.sessions as Message[])[0]!.lastSeq).toBe(repaired.lastSeq)
    const gone = (pid: number) => {
      try {
        process.kill(pid, 0)
        return undefined
      } catch {
        return true
      }
    }
    await second.until(() => gone(agent))
    await second.until(() => gone(grandchild))
    // The next line resumes the conversation.
    await second.call('session.send', {
      session: id,
      text: 'after',
      clientId: 'd',
      origin: 'local',
    })
    await second.until(() =>
      second.out.some(
        one =>
          one.method === 'event' &&
          ((one.params as Message).session as Message | undefined)?.id === id &&
          ((one.params as Message).session as Message).state === 'idle',
      )
        ? true
        : undefined,
    )
    // The first guess (no conversation yet) is wrong: it began before the kill.
    const argvs = logged(
      path.join(at.state, 'argv.ndjson'),
    ) as unknown as string[][]
    expect(argvs.map(argv => argv.at(-2))).toEqual([
      '--session-id',
      '--session-id',
      '--resume',
    ])
    const read = await second.call('session.read', { session: id })
    const texts = (read.records as Message[]).map(
      one => (one.turn as Message).text,
    )
    expect(texts).toEqual(['spawn', 'queued', 'after', 'echo(2): after'])
  }, 30_000)
})
