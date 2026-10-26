// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The runner with Codex (qmo-local.md §4.3.4, §4.3.5, §4.4), in this
 * process, with the harness package's fake app-server behind `<bin>/codex`.
 * No real Codex is started. POSIX only: the agent runs in a process group of
 * its own and the fake is a shell script.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DRIVERS, driverFor } from '../../src/code/drivers/index.ts'
import { FEATURES } from '../../src/code/protocol.ts'
import {
  begin,
  type Box,
  box,
  cleanBoxes,
  codexReport,
  fakeCodex,
  logged,
  type Message,
  pick,
  Refused,
  type StartOptions,
  startRunner,
  type TestRunner,
} from './helpers.ts'

const posix = process.platform !== 'win32'
const running: TestRunner[] = []

afterEach(async () => {
  for (const runner of running.splice(0)) await runner.stop()
  cleanBoxes()
})

/** A runner whose Codex is the fake, with `fake` in its environment. */
function runner(
  at: Box,
  options: StartOptions & { readonly codex?: Record<string, string> } = {},
): TestRunner {
  const codex = fakeCodex(at, options.codex)
  const started = startRunner(at, {
    scan: async () => codexReport(codex, path.join(at.bin, 'claude')),
    ...options,
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

const state = (at: Box, name: string) => path.join(at.state, 'codex', name)

/** What the fake got, of one method. */
function got(at: Box, method: string): Message[] {
  return logged(state(at, 'requests.ndjson'))
    .filter(one => one.method === method)
    .map(one => one.params as Message)
}

function starts(at: Box): string[][] {
  return logged(state(at, 'argv.ndjson')) as unknown as string[][]
}

function answers(at: Box): unknown[] {
  return logged(state(at, 'answers.ndjson')).map(one => one.result)
}

/** Waits until no agent process of the runner is left (ended idle). */
function noChildren(r: TestRunner, at: Box): Promise<true> {
  return r.until(() => {
    const children = JSON.parse(
      fs.readFileSync(path.join(at.code, 'children.json'), 'utf8'),
    ) as { children: unknown[] }
    return children.children.length === 0 ? true : undefined
  })
}

/** Starts a Codex session; its id once the first turn has settled. */
function codex(
  r: TestRunner,
  folder: string,
  text: string,
  mode = 'auto',
  settle: string | null = 'idle',
): Promise<string> {
  return begin(r, folder, text, mode, settle, 'codex')
}

/** The open question of a session, answered. */
async function answer(
  r: TestRunner,
  id: string,
  decision: string,
  settle = 'idle',
  message?: string,
): Promise<void> {
  const open = r
    .turns(id)
    .find(
      one =>
        one.ask !== undefined && (one.ask as Message).decision === undefined,
    )
  if (open === undefined) throw new Error('no open question')
  const mark = r.mark
  await r.call('session.answer', {
    session: id,
    ask: String((open.ask as Message).id),
    decision,
    ...(message === undefined ? {} : { message }),
  })
  await r.state(id, settle, mark)
}

describe('the drivers', () => {
  test('one for every protocol the page may offer, and none else', () => {
    expect(Object.keys(DRIVERS).sort()).toEqual([...FEATURES.protocols].sort())
    expect(driverFor('codex-app-server').nativeKind).toBe('codex-thread')
    expect(driverFor('acp').nativeKind).toBe('acp-session')
    expect(() => driverFor('no-such-protocol')).toThrow('后续版本支持')
    expect(() => driverFor('toString')).toThrow('后续版本支持')
  })
})

describe.skipIf(!posix)('the runner with Codex', () => {
  test('自动审批: the app-server alone, the thread in its sandbox, text streamed, then idle', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const started = await r.call('session.start', {
      folder,
      agent: 'codex',
      mode: 'auto',
      worktree: false,
      text: 'long 2500',
      clientId: 'page-1',
    })
    const id = String((started.session as Message).id)
    expect(started.session).toMatchObject({
      agent: { id: 'codex', name: 'Codex' },
      mode: 'auto',
      state: 'running',
    })
    await r.state(id, 'idle')
    // Only the protocol's argument; the user's own config does the rest.
    expect(starts(at)).toEqual([['app-server']])
    expect(got(at, 'thread/start')).toEqual([
      {
        cwd: at.work,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      },
    ])
    expect(got(at, 'initialize')).toHaveLength(1)
    // Streamed, then written once, under the deltas' turn id.
    const deltas = r.events('delta').filter(one => one.session === id)
    expect(deltas.map(one => String(one.text)).join('')).toBe('x'.repeat(2500))
    const said = r.turns(id).filter(one => one.author === 'agent')
    expect(said).toHaveLength(1)
    expect(said[0]).toMatchObject({ text: 'x'.repeat(2500), state: 'done' })
    expect(said[0]!.id).toBe(deltas[0]!.turn)
    // The thread is Codex's id, kept for the next process.
    const header = JSON.parse(
      fs.readFileSync(
        path.join(at.code, 'sessions', id, 'session.json'),
        'utf8',
      ),
    ) as Message
    expect(header.native).toEqual({
      kind: 'codex-thread',
      id: expect.stringMatching(/^thread-[0-9a-f]{12}$/),
      started: true,
    })
    expect(header.agent).toMatchObject({ protocol: 'codex-app-server' })
  })

  test('the four modes are Codex’s own; the two that ask route questions to the person', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    for (const mode of ['off', 'accept-edits', 'auto', 'full-access'])
      await codex(r, folder, 'hello', mode)
    expect(got(at, 'thread/start')).toEqual([
      {
        cwd: at.work,
        approvalPolicy: 'untrusted',
        sandbox: 'workspace-write',
        approvalsReviewer: 'user',
      },
      {
        cwd: at.work,
        approvalPolicy: 'untrusted',
        sandbox: 'workspace-write',
        approvalsReviewer: 'user',
      },
      {
        cwd: at.work,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      },
      { cwd: at.work, approvalPolicy: 'never', sandbox: 'danger-full-access' },
    ])
  })

  test('a mode change goes in the next turn/start; into a mode that asks the person, or back into the workspace sandbox, the thread opens again', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const id = await codex(r, folder, 'one')
    const mode = (next: string) =>
      r.call('session.mode', { session: id, mode: next })
    expect(await mode('full-access')).toEqual({
      mode: 'full-access',
      applies: 'next-turn',
    })
    await r.say(id, 'two')
    await r.say(id, 'three')
    expect(await mode('auto')).toEqual({ mode: 'auto', applies: 'next-turn' })
    await r.say(id, 'four')
    await mode('off')
    await r.say(id, 'five')
    await mode('auto')
    await r.say(id, 'six')
    const turns = got(at, 'turn/start').map(one => ({
      approvalPolicy: one.approvalPolicy,
      sandboxPolicy: one.sandboxPolicy,
    }))
    expect(turns).toEqual([
      { approvalPolicy: undefined, sandboxPolicy: undefined },
      // Full access by the turn's own policy, said on every turn.
      { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
      { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
      // Back into the sandbox: a new process, the thread opened in it.
      { approvalPolicy: undefined, sandboxPolicy: undefined },
      // Into a mode that asks the person: opened again, with the reviewer.
      { approvalPolicy: undefined, sandboxPolicy: undefined },
      // Out of it: the turn's own policy is enough.
      { approvalPolicy: 'on-request', sandboxPolicy: undefined },
    ])
    expect(starts(at)).toHaveLength(3)
    const [first] = got(at, 'thread/start')
    const resumed = got(at, 'thread/resume')
    expect(resumed).toEqual([
      {
        cwd: at.work,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        threadId: expect.stringMatching(/^thread-/),
      },
      {
        cwd: at.work,
        approvalPolicy: 'untrusted',
        sandbox: 'workspace-write',
        approvalsReviewer: 'user',
        threadId: resumed[0]!.threadId,
      },
    ])
    expect(first).toMatchObject({ approvalPolicy: 'on-request' })
    // One conversation throughout: the fake counted every turn on it.
    const last = r
      .turns(id)
      .filter(one => one.author === 'agent')
      .at(-1)
    expect(last!.text).toBe('codex(6): six')
    expect(
      logged(state(at, 'turns.ndjson')).map(one => [
        one.approvalPolicy,
        one.sandbox,
      ]),
    ).toEqual([
      ['on-request', 'workspace-write'],
      ['never', 'danger-full-access'],
      ['never', 'danger-full-access'],
      ['on-request', 'workspace-write'],
      ['untrusted', 'workspace-write'],
      ['on-request', 'workspace-write'],
    ])
  })

  test('人工确认: an edit asked about at its line, allowed once, made', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const id = await codex(r, folder, 'edit notes.md', 'off', 'waiting')
    const tool = r.turns(id).find(one => one.tool !== undefined)!
    expect(tool).toMatchObject({
      text: '写入 notes.md',
      detail: '@@ -0,0 +1,1 @@\n+written by fake codex',
      tool: {
        id: 'patch-1',
        name: 'fileChange',
        status: 'running',
        paths: ['notes.md'],
        detailKind: 'diff',
        added: 1,
        removed: 0,
      },
    })
    const asked = r.turns(id).find(one => one.ask !== undefined)!
    expect({ ...(asked.ask as Message) }).toMatchObject({
      tool: 'fileChange',
      title: '写入 notes.md',
      paths: ['notes.md'],
      input: 'notes.md',
      options: ['once', 'session', 'deny'],
    })
    expect(asked.detail).toBe('@@ -0,0 +1,1 @@\n+written by fake codex')
    await r.event(one => one.type === 'activity' && one.kind === 'waiting')
    await answer(r, id, 'once')
    expect(fs.readFileSync(path.join(at.work, 'notes.md'), 'utf8')).toBe(
      'written by fake codex\n',
    )
    const after = r.turns(id)
    expect(after.find(one => one.ask !== undefined)!.ask).toMatchObject({
      decision: 'once',
      by: 'user',
    })
    expect(after.find(one => one.tool !== undefined)!.tool).toMatchObject({
      status: 'done',
      approvedBy: 'user',
    })
    expect(answers(at)).toEqual([{ decision: 'accept' }])
  })

  test('本会话都允许 is acceptForSession; 拒绝 is decline, the edit not made; never an amendment', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const id = await codex(r, folder, 'bash make', 'off', 'waiting')
    const ask = r.turns(id).find(one => one.ask !== undefined)!
    expect({ ...(ask.ask as Message) }).toMatchObject({
      tool: 'commandExecution',
      title: '运行 make',
      input: 'make',
      options: ['once', 'session', 'deny'],
    })
    await answer(r, id, 'session')
    const ran = r.turns(id).find(one => one.tool !== undefined)!
    expect(ran).toMatchObject({
      text: '运行 make',
      detail: 'out 1\nout 2\n',
      tool: {
        name: 'commandExecution',
        command: 'make',
        status: 'done',
        approvedBy: 'session',
      },
    })
    // Allowed for the session: Codex does not ask again.
    await r.say(id, 'bash make')
    expect(r.turns(id).filter(one => one.ask !== undefined)).toHaveLength(1)
    const mark = r.mark
    await r.call('session.send', {
      session: id,
      text: 'edit x.txt',
      clientId: 'c3',
      origin: 'local',
    })
    await r.state(id, 'waiting', mark)
    // The sentence stays here: Codex's decline takes none.
    await answer(r, id, 'deny', 'idle', '先别改')
    expect(fs.existsSync(path.join(at.work, 'x.txt'))).toBe(false)
    const edit = r
      .turns(id)
      .filter(one => (one.tool as Message | undefined)?.name === 'fileChange')
    expect(edit[0]!.tool).toMatchObject({ status: 'denied' })
    expect(answers(at)).toEqual([
      { decision: 'acceptForSession' },
      { decision: 'decline' },
    ])
    expect(JSON.stringify(logged(state(at, 'answers.ndjson')))).not.toMatch(
      /Amendment/,
    )
  })

  test('自动接受编辑: an edit in the folder allowed by the mode; a command and an edit outside it ask', async () => {
    const at = box()
    const outside = path.join(at.root, 'elsewhere')
    fs.mkdirSync(outside)
    const r = runner(at)
    const folder = await pick(r, at.work)
    const id = await codex(r, folder, 'edit notes.md', 'accept-edits')
    expect(r.turns(id).some(one => one.ask !== undefined)).toBe(false)
    expect(r.turns(id).find(one => one.tool !== undefined)!.tool).toMatchObject(
      { status: 'done', approvedBy: 'mode' },
    )
    expect(answers(at)).toEqual([{ decision: 'accept' }])
    let mark = r.mark
    await r.call('session.send', {
      session: id,
      text: 'bash ls',
      clientId: 'c2',
      origin: 'local',
    })
    await r.state(id, 'waiting', mark)
    await answer(r, id, 'once')
    mark = r.mark
    await r.call('session.send', {
      session: id,
      text: `edit ${path.join(outside, 'x.txt')}`,
      clientId: 'c3',
      origin: 'local',
    })
    await r.state(id, 'waiting', mark)
    const open = r
      .turns(id)
      .filter(one => one.ask !== undefined)
      .at(-1)!
    expect((open.ask as Message).paths).toEqual([
      path.join(outside, 'x.txt'),
      outside,
    ])
    await answer(r, id, 'deny')
    expect(fs.existsSync(path.join(outside, 'x.txt'))).toBe(false)
    expect(answers(at)).toEqual([
      { decision: 'accept' },
      { decision: 'accept' },
      { decision: 'decline' },
    ])
  })

  test('自动审批: Codex’s sandbox decides; only an escalation asks the person', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const id = await codex(r, folder, 'edit notes.md')
    expect(fs.existsSync(path.join(at.work, 'notes.md'))).toBe(true)
    expect(answers(at)).toEqual([])
    const mark = r.mark
    await r.call('session.send', {
      session: id,
      text: 'escalate curl example.com',
      clientId: 'c2',
      origin: 'local',
    })
    await r.state(id, 'waiting', mark)
    const open = r.turns(id).find(one => one.ask !== undefined)!
    expect((open.ask as Message).title).toBe('needs the network')
    await answer(r, id, 'once')
    expect(answers(at)).toEqual([{ decision: 'accept' }])
  })

  test('跳过权限确认: nothing is asked', async () => {
    const at = box()
    const outside = path.join(at.root, 'elsewhere')
    fs.mkdirSync(outside)
    const r = runner(at)
    const folder = await pick(r, at.work)
    const id = await codex(r, folder, 'escalate curl', 'full-access')
    await r.say(id, `edit ${path.join(outside, 'y.txt')}`)
    expect(fs.existsSync(path.join(outside, 'y.txt'))).toBe(true)
    expect(r.turns(id).some(one => one.ask !== undefined)).toBe(false)
    expect(answers(at)).toEqual([])
  })

  test('a stop: the turn interrupted the native way; a question open is denied by the stop', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const id = await codex(r, folder, 'hang', 'auto', 'running')
    await r.until(() => (got(at, 'turn/start').length > 0 ? true : undefined))
    let mark = r.mark
    await r.call('session.stop', { session: id })
    await r.state(id, 'interrupted', mark)
    expect(got(at, 'turn/interrupt')).toHaveLength(1)
    expect(r.turns(id).at(-1)).toMatchObject({ text: '已中断' })
    // The process stays for the next turn.
    await r.say(id, 'again')
    expect(starts(at)).toHaveLength(1)
    mark = r.mark
    await r.call('session.mode', { session: id, mode: 'off' })
    await r.call('session.send', {
      session: id,
      text: 'wait-ask',
      clientId: 'c3',
      origin: 'local',
    })
    await r.state(id, 'waiting', mark)
    mark = r.mark
    await r.call('session.stop', { session: id })
    await r.state(id, 'interrupted', mark)
    const asked = r.turns(id).find(one => one.ask !== undefined)!
    expect(asked.ask).toMatchObject({ decision: 'deny', by: 'stop' })
  })

  test('the process ends when idle; the next line resumes the thread', async () => {
    const at = box()
    const r = runner(at, { limits: { idleMs: 200 } })
    const folder = await pick(r, at.work)
    const id = await codex(r, folder, 'one')
    await noChildren(r, at)
    // No process running: the next one opens its thread in the new mode.
    expect(
      await r.call('session.mode', { session: id, mode: 'full-access' }),
    ).toEqual({ mode: 'full-access', applies: 'now' })
    await r.say(id, 'two')
    expect(starts(at)).toHaveLength(2)
    expect(got(at, 'thread/resume')).toEqual([
      {
        cwd: at.work,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        threadId: expect.stringMatching(/^thread-/),
      },
    ])
    expect(got(at, 'turn/start')[1]!.approvalPolicy).toBeUndefined()
    expect(r.turns(id).at(-1)).toMatchObject({ text: 'codex(2): two' })
  })

  test('a crash mid-turn fails the turn with what Codex printed; the next line resumes', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const id = await codex(r, folder, 'crash', 'auto', 'failed')
    const failed = r.turns(id).find(one => one.state === 'failed')!
    expect(failed.text).toContain('Codex exited during the turn')
    await r.say(id, 'again')
    expect(got(at, 'thread/resume')).toHaveLength(1)
    expect(r.turns(id).at(-1)).toMatchObject({ text: 'codex(2): again' })
  })

  test('the thread gone on Codex’s side: said so, and the line starts a new one', async () => {
    const at = box()
    const r = runner(at, { limits: { idleMs: 200 } })
    const folder = await pick(r, at.work)
    const id = await codex(r, folder, 'one')
    const before = got(at, 'thread/start')
    await noChildren(r, at)
    fs.writeFileSync(state(at, 'threads.json'), '{}')
    await r.say(id, 'two')
    expect(r.turns(id).map(one => one.text)).toContain(
      '上次的对话 Codex 那边已经没有了，这一句从新对话开始',
    )
    expect(got(at, 'thread/start')).toHaveLength(before.length + 1)
    expect(r.turns(id).at(-1)).toMatchObject({ text: 'codex(1): two' })
    const header = JSON.parse(
      fs.readFileSync(
        path.join(at.code, 'sessions', id, 'session.json'),
        'utf8',
      ),
    ) as { native: { id: string } }
    expect(got(at, 'thread/resume')[0]!.threadId).not.toBe(header.native.id)
  })

  test('a failed turn says Codex’s words, and how to sign in when it is about that', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const id = await codex(r, folder, 'fail', 'auto', 'failed')
    expect(r.turns(id).at(-1)).toMatchObject({
      text: 'model overloaded',
      state: 'failed',
      code: 'E_AGENT',
    })
    await r.say(id, 'login', 'failed')
    expect(r.turns(id).at(-1)!.text).toBe(
      'unexpected status 401 Unauthorized: Missing bearer\n在终端里运行 `codex login` 登录后再试',
    )
    // No login method of Codex's is ever called.
    const methods = logged(state(at, 'requests.ndjson')).map(one =>
      String(one.method),
    )
    expect(methods.some(one => /login|account|auth/i.test(one))).toBe(false)
  })

  test('changes outside Git: Codex’s last turn diff, read from the record', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const id = await codex(r, folder, 'edit notes.md')
    expect(await r.call('session.changes', { session: id })).toEqual({
      source: 'session',
      files: [
        {
          path: 'notes.md',
          status: 'added',
          added: 1,
          removed: 0,
          binary: false,
        },
      ],
      truncated: false,
    })
    const diff = await r.call('session.diff', {
      session: id,
      path: 'notes.md',
    })
    expect(diff).toMatchObject({
      path: 'notes.md',
      truncated: false,
      binary: false,
    })
    expect(String(diff.text)).toContain('+written by fake codex')
    expect(
      await refused(r.call('session.diff', { session: id, path: 'other.md' })),
    ).toBe('E_GIT')
    const kept = path.join(at.code, 'sessions', id, 'turn-diff.json')
    expect(fs.statSync(kept).mode & 0o777).toBe(0o600)
    // From the record, not the disk: gone from the folder, still listed.
    fs.rmSync(path.join(at.work, 'notes.md'))
    expect(
      ((await r.call('session.changes', { session: id })).files as Message[])
        .length,
    ).toBe(1)
  })

  test('the environment is the user’s; Codex’s own folder is never opened', async () => {
    const at = box()
    const envLog = path.join(at.root, 'codex-env.json')
    const home = path.join(at.home, '.codex')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'auth.json'), '{"secret":1}')
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "x"\n')
    const snapshot = () =>
      (fs.readdirSync(home, { recursive: true }) as string[])
        .sort()
        .map(name => {
          const stat = fs.statSync(path.join(home, name))
          return `${name} ${stat.size} ${stat.mtimeMs}`
        })
    const before = snapshot()
    const touched: string[] = []
    const watched = [
      'openSync',
      'readFileSync',
      'readdirSync',
      'writeFileSync',
      'renameSync',
      'rmSync',
      'mkdirSync',
    ] as const
    const spies = watched.map(name => {
      const real = fs[name] as (...args: unknown[]) => unknown
      return spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
        if (typeof args[0] === 'string') touched.push(path.resolve(args[0]))
        return real(...args)
      }) as never)
    })
    try {
      const r = runner(at, {
        codex: { FAKE_CODEX_ENV_LOG: envLog },
        env: {
          PATH: `${at.bin}:/usr/bin:/bin`,
          HOME: at.home,
          QMO_CLIENT_DIR: at.client,
          QIANMO_CONFIG_DIR: '/x',
          CLAUDECODE: '1',
        },
        login: { PATH: `${at.bin}:/usr/bin:/bin`, LOGIN_SENTINEL: 's-1' },
      })
      const folder = await pick(r, at.work)
      const id = await codex(r, folder, 'edit notes.md', 'off', 'waiting')
      await answer(r, id, 'once')
      await r.call('session.changes', { session: id })
      await r.call('session.read', { session: id })
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    expect(
      touched.filter(file => file === home || file.startsWith(`${home}/`)),
    ).toEqual([])
    expect(snapshot()).toEqual(before)
    const env = JSON.parse(fs.readFileSync(envLog, 'utf8')) as Record<
      string,
      string
    >
    expect(env.LOGIN_SENTINEL).toBe('s-1')
    expect(env.__cwd).toBe(at.work)
    expect(env.CODEX_HOME).toBeUndefined()
    for (const name of Object.keys(env))
      expect(name).not.toMatch(/^(QMO_|QIANMO_|CLAUDECODE$)/)
  })
})
