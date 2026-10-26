// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The runner's methods end to end, in this process, with the fake Claude
 * Code (qmo-local.md §4.3–§4.5). POSIX only: the agent runs in a process
 * group of its own and the fake is a shell script.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  begin,
  type Box,
  box,
  claudeReport,
  cleanBoxes,
  logged,
  type Message,
  pick,
  Refused,
  startRunner,
  type TestRunner,
} from './helpers.ts'

const posix = process.platform !== 'win32'
const running: TestRunner[] = []

afterEach(async () => {
  for (const runner of running.splice(0)) await runner.stop()
  cleanBoxes()
})

function runner(at: Box, options: Parameters<typeof startRunner>[1] = {}) {
  const started = startRunner(at, options)
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

function argvs(at: Box): string[][] {
  return logged(path.join(at.state, 'argv.ndjson')) as unknown as string[][]
}

describe.skipIf(!posix)('the runner', () => {
  test('hello says the protocol, the features and where it keeps its files', async () => {
    const at = box()
    const r = runner(at)
    expect(await r.call('hello')).toEqual({
      version: expect.any(String),
      protocol: 1,
      features: {
        protocols: ['claude-stream', 'codex-app-server', 'acp'],
        worktree: false,
        remote: true,
      },
      codeDir: at.code,
    })
    expect(await refused(r.call('hello', { extra: 1 }))).toBe('E_ARGS')
    expect(await refused(r.call('nonsense'))).toBe('E_ARGS')
    expect(await refused(r.call('session.rename', {}))).toBe('E_ARGS')
    // Remote needs this computer signed in to a hub (`remote.test.ts`).
    expect(
      await refused(
        r.call('session.remote', {
          session: 'cs_AAAAAAAAAAAAAAAAAAAAAA',
          on: true,
        }),
      ),
    ).toBe('E_REMOTE')
    // Lines that are not requests are dropped, not answered.
    r.send('not json')
    r.send(JSON.stringify({ id: 0, method: 'hello' }))
    r.send(JSON.stringify({ id: 9, method: 'hello', params: {}, more: 1 }))
    expect(await r.call('list')).toMatchObject({ v: 1, sessions: [] })
    expect(r.out.some(one => one.id === 0 || one.id === 9)).toBe(false)
    // `runner` events are the shell's (up once it accepts the hello, down
    // when the runner ends); one from here too would reach the page twice.
    expect(r.events('runner')).toEqual([])
  })

  test('folders: picked, resolved, remembered newest first; guarded roots refused', async () => {
    const at = box()
    const r = runner(at)
    const link = path.join(at.root, 'link')
    fs.symlinkSync(at.work, link)
    const picked = await r.call('folders.add', { path: link })
    expect(picked).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{16}$/),
      name: 'work',
      path: at.work,
      git: false,
    })
    // The same folder again keeps its id.
    expect((await r.call('folders.add', { path: at.work })).id).toBe(picked.id)
    for (const guarded of [
      path.join(at.home, '.claude'),
      path.join(at.home, '.claude', 'projects'),
      path.join(at.home, '.codex'),
      path.join(at.home, '.gemini'),
      path.join(at.home, '.config', 'opencode'),
      at.client,
    ]) {
      fs.mkdirSync(guarded, { recursive: true })
      expect(await refused(r.call('folders.add', { path: guarded }))).toBe(
        'E_FOLDER',
      )
    }
    // A link into a guarded root is judged by where it leads.
    const sneaky = path.join(at.root, 'sneaky')
    fs.symlinkSync(path.join(at.home, '.claude'), sneaky)
    expect(await refused(r.call('folders.add', { path: sneaky }))).toBe(
      'E_FOLDER',
    )
    // Their parent, the home folder, may be picked.
    expect((await r.call('folders.add', { path: at.home })).name).toBe('home')
    const file = path.join(at.root, 'a-file')
    fs.writeFileSync(file, '')
    expect(await refused(r.call('folders.add', { path: file }))).toBe(
      'E_FOLDER',
    )
    expect(await refused(r.call('folders.add', { path: 'relative' }))).toBe(
      'E_FOLDER',
    )
    const listed = await r.call('list')
    expect((listed.folders as Message[]).map(one => one.name)).toEqual([
      'home',
      'work',
    ])
    await r.call('folders.forget', { folder: picked.id })
    expect(
      ((await r.call('list')).folders as Message[]).map(one => one.name),
    ).toEqual(['home'])
    expect(await refused(r.call('folders.forget', { folder: picked.id }))).toBe(
      'E_FOLDER',
    )
  })

  test('a session: the first line, text streamed, the message, then idle', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const started = await r.call('session.start', {
      folder,
      agent: 'claude-code',
      mode: 'auto',
      worktree: false,
      text: 'long 9000',
      clientId: 'page-1',
      remote: false,
    })
    const summary = started.session as Message
    const id = String(summary.id)
    expect(id).toMatch(/^cs_[A-Za-z0-9_-]{22}$/)
    expect(summary).toMatchObject({
      title: 'long 9000',
      folder: { id: folder, name: 'work' },
      agent: { id: 'claude-code', name: 'Claude Code' },
      mode: 'auto',
      state: 'running',
      remote: false,
    })
    expect(started.turn).toMatchObject({
      author: 'operator',
      text: 'long 9000',
      state: 'read',
      clientId: 'page-1',
    })
    await r.state(id, 'idle')
    // Streamed in pieces of at most 4 KiB that join up, then written once.
    const deltas = r.events('delta').filter(one => one.session === id)
    expect(deltas.length).toBeGreaterThan(2)
    let offset = 0
    for (const delta of deltas) {
      expect(delta.offset).toBe(offset)
      expect(Buffer.byteLength(String(delta.text))).toBeLessThanOrEqual(4096)
      offset += String(delta.text).length
    }
    expect(offset).toBe(9000)
    // Its record is over 8 KiB: the event says so, the page reads it.
    const trimmed = r
      .events('record')
      .find(one => one.session === id && one.trimmed === true)
    expect(trimmed).toEqual({
      v: 1,
      type: 'record',
      session: id,
      seq: 2,
      trimmed: true,
    })
    expect(r.turns(id).some(one => one.author === 'agent')).toBe(false)
    // The command line: only the protocol's and the mode's flags.
    expect(argvs(at)[0]).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
      '--permission-mode',
      'auto',
      '--session-id',
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    ])
    const read = await r.call('session.read', { session: id })
    expect(read.more).toBe(false)
    expect(read.lastSeq).toBe(Number((read.session as Message).lastSeq))
    const records = read.records as Message[]
    expect(records.map(one => (one.turn as Message).author)).toEqual([
      'operator',
      'agent',
    ])
    expect((records[1]!.turn as Message).text).toBe('x'.repeat(9000))
    expect((records[1]!.turn as Message).id).toBe(deltas[0]!.turn)
  })

  test('start refuses what it cannot do yet', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const base = {
      folder,
      agent: 'claude-code',
      mode: 'auto',
      worktree: false,
      text: 'hi',
      clientId: 'c',
    }
    expect(
      await refused(r.call('session.start', { ...base, worktree: true })),
    ).toBe('E_ARGS')
    // Signed out: no Remote (`remote.test.ts` has it signed in).
    expect(
      await refused(r.call('session.start', { ...base, remote: true })),
    ).toBe('E_REMOTE')
    // Codex is driven since P37.14b (`codex.test.ts`); an agent not found is not.
    expect(
      await refused(r.call('session.start', { ...base, agent: 'gemini' })),
    ).toBe('E_AGENT')
    expect(
      await refused(r.call('session.start', { ...base, agent: 'omp' })),
    ).toBe('E_ARGS')
    expect(
      await refused(r.call('session.start', { ...base, mode: 'yolo' })),
    ).toBe('E_ARGS')
    expect(await refused(r.call('session.start', { ...base, text: '' }))).toBe(
      'E_ARGS',
    )
    expect(
      await refused(r.call('session.start', { ...base, text: 'a\u0000b' })),
    ).toBe('E_ARGS')
    expect(
      await refused(
        r.call('session.start', { ...base, text: 'x'.repeat(65_537) }),
      ),
    ).toBe('E_ARGS')
    // Characters are UTF-16 code units, as the shell and the page count them:
    // 32,769 emoji are 65,538.
    expect(
      await refused(
        r.call('session.start', { ...base, text: '😀'.repeat(32_769) }),
      ),
    ).toBe('E_ARGS')
    expect(
      await refused(r.call('session.start', { ...base, clientId: 'a b' })),
    ).toBe('E_ARGS')
    expect(
      await refused(
        r.call('session.start', { ...base, folder: 'f'.repeat(16) }),
      ),
    ).toBe('E_FOLDER')
    expect(await refused(r.call('session.start', { ...base, extra: 1 }))).toBe(
      'E_ARGS',
    )
    const { worktree: _, ...missing } = base
    expect(await refused(r.call('session.start', missing))).toBe('E_ARGS')
    // A folder that went away.
    fs.renameSync(at.work, `${at.work}-moved`)
    expect(await refused(r.call('session.start', base))).toBe('E_FOLDER')
  })

  test('the four modes are the native ones, and `auto` falls back where it is not enabled', async () => {
    const at = box()
    const r = runner(at, { fake: { FAKE_CLAUDE_NO_AUTO: '1' } })
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'hello', 'off')
    expect(argvs(at)[0]).toContain('default')
    expect(
      await r.call('session.mode', { session: id, mode: 'accept-edits' }),
    ).toEqual({
      mode: 'accept-edits',
      applies: 'now',
    })
    const control = () => logged(path.join(at.state, 'control.ndjson'))
    expect(control().at(-1)).toEqual({
      subtype: 'set_permission_mode',
      mode: 'acceptEdits',
    })
    // Refused by Claude Code: acceptEdits, said in the conversation.
    expect(await r.call('session.mode', { session: id, mode: 'auto' })).toEqual(
      {
        mode: 'accept-edits',
        applies: 'now',
      },
    )
    expect(control().slice(-2)).toEqual([
      { subtype: 'set_permission_mode', mode: 'auto' },
      { subtype: 'set_permission_mode', mode: 'acceptEdits' },
    ])
    await r.event(
      one =>
        one.type === 'record' &&
        ((one.record as Message)?.turn as Message)?.text ===
          '这个 Claude Code 没有自动模式，命令仍会问你',
    )
    const listed = (await r.call('list')).sessions as Message[]
    expect(listed[0]!.mode).toBe('accept-edits')
    // A new session in `auto` on the same program starts in acceptEdits at once.
    const next = await begin(r, folder, 'hello', 'auto')
    expect(argvs(at).at(-1)).toContain('acceptEdits')
    expect(
      ((await r.call('session.read', { session: next })).session as Message)
        .mode,
    ).toBe('accept-edits')
  })

  test('`auto` that cannot even start: started again in acceptEdits, the line sent once', async () => {
    const at = box()
    const r = runner(at, { fake: { FAKE_CLAUDE_AUTO_EXIT: '1' } })
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'hello', 'auto')
    const modes = argvs(at).map(
      argv => argv[argv.indexOf('--permission-mode') + 1],
    )
    expect(modes).toEqual(['auto', 'acceptEdits'])
    const turns = r.turns(id)
    expect(turns.map(one => one.text)).toEqual([
      'hello',
      '这个 Claude Code 没有自动模式，命令仍会问你',
      'echo(1): hello',
    ])
  })

  test('`auto` the init says is not in effect: switched to acceptEdits', async () => {
    const at = box()
    const r = runner(at, { fake: { FAKE_CLAUDE_INIT_MODE: 'default' } })
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'hello', 'auto')
    await r.until(() =>
      logged(path.join(at.state, 'control.ndjson')).length > 0
        ? true
        : undefined,
    )
    expect(logged(path.join(at.state, 'control.ndjson'))).toEqual([
      { subtype: 'set_permission_mode', mode: 'acceptEdits' },
    ])
    expect(
      ((await r.call('session.read', { session: id })).session as Message).mode,
    ).toBe('accept-edits')
  })

  test('跳过权限确认: started with the flag; switched to, restarted with it on the same conversation', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const first = await begin(r, folder, 'hello', 'full-access')
    expect(argvs(at)[0]).toEqual(
      expect.arrayContaining([
        'bypassPermissions',
        '--allow-dangerously-skip-permissions',
      ]),
    )
    const id = await begin(r, folder, 'hello', 'off')
    expect(argvs(at)[1]).not.toContain('--allow-dangerously-skip-permissions')
    // Idle: the process is ended now, the next turn starts with the flag.
    expect(
      await r.call('session.mode', { session: id, mode: 'full-access' }),
    ).toEqual({
      mode: 'full-access',
      applies: 'now',
    })
    await r.say(id, 'again')
    const last = argvs(at).at(-1)!
    expect(last).toEqual(
      expect.arrayContaining([
        '--resume',
        '--allow-dangerously-skip-permissions',
        'bypassPermissions',
      ]),
    )
    expect(r.turns(id).at(-1)!.text).toBe('echo(2): again')
    // While a turn runs: next turn.
    const mark = r.mark
    await r.call('session.send', {
      session: first,
      text: 'slow',
      clientId: 'c',
    })
    expect(
      await r.call('session.mode', { session: first, mode: 'off' }),
    ).toEqual({
      mode: 'off',
      applies: 'now',
    })
    await r.state(first, 'idle', mark)
  })

  test('人工确认: the question in the conversation, allowed once, the file written', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'edit notes.md', 'off', 'waiting')
    const asked = r.turns(id).find(one => one.ask !== undefined)!
    const ask = asked.ask as Message
    // (Bun's toMatchObject writes its matchers into what it is given: copy.)
    const askId = String(ask.id)
    expect(askId).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/)
    expect({ ...ask }).toMatchObject({
      tool: 'Write',
      title: `Write ${path.join(at.work, 'notes.md')}`,
      paths: ['notes.md'],
      options: ['once', 'session', 'deny'],
    })
    expect(asked).toMatchObject({ variant: 'notice', noticeSource: 'step' })
    await r.event(one => one.type === 'activity' && one.kind === 'waiting')
    // The tool line came first, with the diff it will make.
    const tool = r.turns(id).find(one => one.tool !== undefined)!
    expect(tool).toMatchObject({
      text: '写入 notes.md',
      detail: '@@ -0,0 +1,1 @@\n+created by fake',
      tool: {
        name: 'Write',
        status: 'running',
        paths: ['notes.md'],
        detailKind: 'diff',
        added: 1,
        removed: 0,
      },
    })
    expect(
      await refused(
        r.call('session.answer', {
          session: id,
          ask: 'nope',
          decision: 'once',
        }),
      ),
    ).toBe('E_ASK')
    const mark = r.mark
    await r.call('session.answer', {
      session: id,
      ask: askId,
      decision: 'once',
    })
    await r.state(id, 'idle', mark)
    expect(fs.readFileSync(path.join(at.work, 'notes.md'), 'utf8')).toBe(
      'created by fake\n',
    )
    const after = r.turns(id)
    expect(after.find(one => one.ask !== undefined)!.ask).toMatchObject({
      decision: 'once',
      by: 'user',
      at: expect.any(Number),
    })
    expect(after.find(one => one.tool !== undefined)!.tool).toMatchObject({
      status: 'done',
      approvedBy: 'user',
    })
    // Answered: answering again is refused.
    expect(
      await refused(
        r.call('session.answer', { session: id, ask: askId, decision: 'once' }),
      ),
    ).toBe('E_ASK')
    const answers = logged(path.join(at.state, 'answers.ndjson'))
    expect(answers.at(-1)!.response).toEqual({
      behavior: 'allow',
      updatedInput: {
        file_path: path.join(at.work, 'notes.md'),
        content: 'created by fake\n',
      },
    })
  })

  test('本会话都允许 keeps Claude Code’s rules to the session; 拒绝 carries the sentence', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'bash ls', 'accept-edits', 'waiting')
    const ask = r.turns(id).find(one => one.ask !== undefined)!.ask as Message
    expect(ask.input).toBe('ls')
    let mark = r.mark
    await r.call('session.answer', {
      session: id,
      ask: ask.id,
      decision: 'session',
    })
    await r.state(id, 'idle', mark)
    const response = logged(path.join(at.state, 'answers.ndjson')).at(-1)!
      .response as Message
    expect(
      (response.updatedPermissions as Message[]).map(one => one.destination),
    ).toEqual(['session', 'session'])
    expect(r.turns(id).find(one => one.tool !== undefined)!.tool).toMatchObject(
      {
        status: 'done',
        approvedBy: 'session',
      },
    )
    mark = r.mark
    await r.call('session.send', {
      session: id,
      text: 'bash rm -rf x',
      clientId: 'c',
    })
    const second = (
      await r.event(
        one =>
          one.type === 'record' &&
          ((one.record as Message).turn as Message).ask !== undefined &&
          (((one.record as Message).turn as Message).ask as Message).id !==
            ask.id,
        undefined,
        mark,
      )
    ).record as Message
    const secondAsk = (second.turn as Message).ask as Message
    for (const message of ['a\nb', '😀'.repeat(251)])
      expect(
        await refused(
          r.call('session.answer', {
            session: id,
            ask: secondAsk.id,
            decision: 'deny',
            message,
          }),
        ),
      ).toBe('E_ARGS')
    await r.call('session.answer', {
      session: id,
      ask: secondAsk.id,
      decision: 'deny',
      message: '别删',
    })
    await r.state(id, 'idle', mark)
    expect(
      logged(path.join(at.state, 'answers.ndjson')).at(-1)!.response,
    ).toEqual({
      behavior: 'deny',
      message: '别删',
    })
    const tools = r.turns(id).filter(one => one.tool !== undefined)
    expect(tools.at(-1)).toMatchObject({
      severity: 'warn',
      detail: '别删',
      tool: { status: 'denied', command: 'rm -rf x' },
    })
  })

  test('a question nobody answered when the turn is stopped is denied by the stop', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'edit a.txt', 'off', 'waiting')
    const mark = r.mark
    await r.call('session.stop', { session: id })
    await r.state(id, 'interrupted', mark)
    const ask = r.turns(id).find(one => one.ask !== undefined)!.ask as Message
    expect(ask).toMatchObject({ decision: 'deny', by: 'stop' })
    expect(fs.existsSync(path.join(at.work, 'a.txt'))).toBe(false)
    expect(r.turns(id).at(-1)).toMatchObject({
      text: '已中断',
      severity: 'warn',
    })
    // The next line resumes the same conversation in the same process.
    await r.say(id, 'after')
    expect(r.turns(id).at(-1)!.text).toBe('echo(2): after')
  })

  test('a queue of five behind a running turn; a stop withdraws it as 未发出', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'hang', 'auto', 'running')
    for (let i = 0; i < 5; i++)
      expect(
        await r.call('session.send', {
          session: id,
          text: `q${i}`,
          clientId: `c${i}`,
        }),
      ).toMatchObject({
        queued: true,
        turn: { state: 'pending', clientId: `c${i}` },
      })
    expect(
      await refused(
        r.call('session.send', { session: id, text: 'q5', clientId: 'c5' }),
      ),
    ).toBe('E_BUSY')
    const mark = r.mark
    await r.call('session.stop', { session: id })
    await r.state(id, 'interrupted', mark)
    const queued = r.turns(id).filter(one => String(one.text).startsWith('q'))
    expect(queued.map(one => [one.state, one.code])).toEqual(
      Array.from({ length: 5 }, () => ['failed', 'E_NOT_SENT']),
    )
  })

  test('queued lines go one after another, in order', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'slow', 'auto', 'running')
    await r.call('session.send', { session: id, text: 'one', clientId: 'a' })
    await r.call('session.send', { session: id, text: 'two', clientId: 'b' })
    await r.state(id, 'idle')
    await r.until(() =>
      r.turns(id).some(one => one.text === 'echo(3): two') ? true : undefined,
    )
    const turns = r.turns(id)
    expect(
      turns.filter(one => one.author === 'operator').map(one => one.state),
    ).toEqual(['read', 'read', 'read'])
    expect(
      turns.filter(one => one.author === 'agent').map(one => one.text),
    ).toEqual(['echo(1): slow', 'echo(2): one', 'echo(3): two'])
  })

  test('a failed turn says Claude Code’s words, and how to sign in when it is about that', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'login', 'auto', 'failed')
    expect(r.turns(id).at(-1)).toMatchObject({
      author: 'agent',
      state: 'failed',
      code: 'E_AGENT',
      text: 'Invalid API key · Please run /login\n在终端里运行 `claude` 登录后再试',
    })
    await r.say(id, 'fail', 'failed')
    expect(r.turns(id).at(-1)!.text).toBe('upstream exploded')
  })

  test('a crash mid-turn fails the turn; the next line resumes the conversation', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'hello')
    await r.say(id, 'crash', 'failed')
    expect(r.turns(id).at(-1)).toMatchObject({
      state: 'failed',
      code: 'E_AGENT',
    })
    await r.say(id, 'after')
    expect(r.turns(id).at(-1)!.text).toBe('echo(3): after')
    const flags = argvs(at).map(argv => argv[argv.length - 2])
    expect(flags).toEqual(['--session-id', '--resume'])
  })

  test('the conversation gone on Claude Code’s side: said so, and the line starts a new one', async () => {
    const at = box()
    const first = runner(at)
    const folder = await pick(first, at.work)
    const id = await begin(first, folder, 'hello')
    await first.stop()
    const native = argvs(at)[0]!.at(-1)!
    fs.rmSync(path.join(at.state, `${native}.count`))
    const r = runner(at)
    await r.say(id, 'again')
    const read = await r.call('session.read', { session: id })
    const texts = (read.records as Message[]).map(
      one => (one.turn as Message).text,
    )
    expect(texts).toEqual([
      'hello',
      'echo(1): hello',
      'again',
      '上次的对话 Claude Code 那边已经没有了，这一句从新对话开始',
      'echo(1): again',
    ])
    expect(argvs(at).map(argv => argv.slice(-2))).toEqual([
      ['--session-id', native],
      ['--resume', native],
      ['--session-id', native],
    ])
  })

  test('the conversation gone and `auto` not enabled: both found, in either order, the line sent once', async () => {
    const at = box()
    const first = runner(at)
    const folder = await pick(first, at.work)
    const id = await begin(first, folder, 'hello', 'auto')
    await first.stop()
    const native = argvs(at)[0]!.at(-1)!
    fs.rmSync(path.join(at.state, `${native}.count`))
    // This fake says `auto` first, the conversation second.
    const r = runner(at, { fake: { FAKE_CLAUDE_AUTO_EXIT: '1' } })
    await r.say(id, 'again')
    const read = await r.call('session.read', { session: id })
    expect(
      (read.records as Message[]).map(one => (one.turn as Message).text),
    ).toEqual([
      'hello',
      'echo(1): hello',
      'again',
      '上次的对话 Claude Code 那边已经没有了，这一句从新对话开始',
      '这个 Claude Code 没有自动模式，命令仍会问你',
      'echo(1): again',
    ])
    expect((read.session as Message).mode).toBe('accept-edits')
    expect(
      argvs(at).map(argv => [
        argv[argv.indexOf('--permission-mode') + 1],
        argv.at(-2),
      ]),
    ).toEqual([
      ['auto', '--session-id'],
      ['auto', '--resume'],
      ['acceptEdits', '--resume'],
      ['acceptEdits', '--session-id'],
    ])
  })

  test('a start that fails for another reason: tried once without `auto`, the mode kept, its words', async () => {
    const at = box()
    const broken = path.join(at.bin, 'broken-claude')
    fs.writeFileSync(
      broken,
      `#!/bin/sh\necho "$*" >> '${at.state}/broken.log'\necho 'Error: settings file is unreadable' >&2\nexit 1\n`,
    )
    fs.chmodSync(broken, 0o755)
    const r = runner(at, { scan: async () => claudeReport(broken) })
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'hello', 'auto', 'failed')
    const tried = fs
      .readFileSync(path.join(at.state, 'broken.log'), 'utf8')
      .trim()
      .split('\n')
      .map(
        line =>
          line.split(' ')[line.split(' ').indexOf('--permission-mode') + 1],
      )
    expect(tried).toEqual(['auto', 'acceptEdits'])
    expect(r.turns(id).map(one => one.text)).toEqual([
      'hello',
      'Claude Code exited during the turn\nError: settings file is unreadable',
    ])
    expect(
      ((await r.call('session.read', { session: id })).session as Message).mode,
    ).toBe('auto')
  })

  test('a conversation at 64 MiB is still read, and takes no more lines', async () => {
    const at = box()
    const first = runner(at)
    const folder = await pick(first, at.work)
    const id = await begin(first, folder, 'hello')
    await first.stop()
    // Grown to the limit; a line the reader cannot use counts all the same.
    fs.appendFileSync(
      path.join(at.code, 'sessions', id, 'events.ndjson'),
      `${'x'.repeat(64 * 1024 * 1024)}\n`,
    )
    const r = runner(at)
    expect(
      await refused(
        r.call('session.send', { session: id, text: 'more', clientId: 'c' }),
      ),
    ).toBe('E_LIMIT')
    const read = await r.call('session.read', { session: id })
    expect(
      (read.records as Message[]).map(one => (one.turn as Message).text),
    ).toEqual(['hello', 'echo(1): hello'])
  })

  test('idle ten minutes (here: a moment): the process ends; the next line resumes it', async () => {
    const at = box()
    const r = runner(at, { limits: { idleMs: 200 } })
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'hello')
    await r.until(() => {
      const children = JSON.parse(
        fs.readFileSync(path.join(at.code, 'children.json'), 'utf8'),
      ) as { children: unknown[] }
      return children.children.length === 0 ? true : undefined
    })
    await r.say(id, 'again')
    expect(argvs(at).map(argv => argv[argv.length - 2])).toEqual([
      '--session-id',
      '--resume',
    ])
    expect(r.turns(id).at(-1)!.text).toBe('echo(2): again')
  })

  test('at most the budget of processes: an idle one is ended, else the turn waits', async () => {
    const at = box()
    const r = runner(at, { limits: { maxAgents: 1 } })
    const folder = await pick(r, at.work)
    const a = await begin(r, folder, 'hello')
    // The idle process of `a` makes room for `b`.
    const b = await begin(r, folder, 'hang', 'auto', 'running')
    // `b` runs in the one process there may be; `a`'s has ended.
    await r.until(() => {
      const { children } = JSON.parse(
        fs.readFileSync(path.join(at.code, 'children.json'), 'utf8'),
      ) as { children: Message[] }
      return children.length === 1 && children[0]!.session === b
        ? true
        : undefined
    })
    await r.event(
      one =>
        one.type === 'activity' && one.session === b && one.kind === 'starting',
    )
    // `b` runs: `a` waits for room, and says so.
    const mark = r.mark
    await r.call('session.send', { session: a, text: 'waiting', clientId: 'w' })
    await r.event(
      one =>
        one.type === 'activity' && one.session === a && one.kind === 'queued',
      undefined,
      mark,
    )
    await r.call('session.stop', { session: b })
    await r.state(a, 'idle', mark)
    expect(r.turns(a).at(-1)!.text).toBe('echo(2): waiting')
  })

  test('a stop the agent ignores ends its whole process group', async () => {
    const at = box()
    const r = runner(at, {
      limits: { interruptGraceMs: 200, termGraceMs: 300 },
      fake: { FAKE_CLAUDE_IGNORE_TERM: '1' },
    })
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'spawn', 'auto', 'running')
    const grandchild = await r.until(() => {
      const pid: unknown = logged(path.join(at.state, 'grandchild.ndjson'))[0]
      return typeof pid === 'number' ? pid : undefined
    })
    const mark = r.mark
    await r.call('session.stop', { session: id })
    await r.state(id, 'interrupted', mark)
    await r.until(() => {
      try {
        process.kill(grandchild, 0)
        return undefined
      } catch {
        return true
      }
    }, 5_000)
  })

  test('the agents’ own folders: never opened, listed or written, through a whole session', async () => {
    const at = box()
    const own = [
      path.join(at.home, '.claude'),
      path.join(at.home, '.claude.json'),
      path.join(at.home, '.codex'),
      path.join(at.home, '.gemini'),
      path.join(at.home, '.qwen'),
      path.join(at.home, '.dsh'),
      path.join(at.home, '.config', 'opencode'),
      path.join(at.home, '.local', 'share', 'opencode'),
    ]
    const put = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text)
    }
    put(path.join(at.home, '.claude', '.credentials.json'), '{"secret":1}')
    put(path.join(at.home, '.claude', 'settings.json'), '{}')
    put(path.join(at.home, '.claude.json'), '{"oauthAccount":{}}')
    put(path.join(at.home, '.codex', 'auth.json'), '{}')
    put(path.join(at.home, '.gemini', 'oauth_creds.json'), '{}')
    put(path.join(at.home, '.config', 'opencode', 'opencode.json'), '{}')
    // (The fake is a Bun script: Bun's own cache under HOME is not looked at.)
    const snapshot = () =>
      own
        .filter(entry => fs.existsSync(entry))
        .flatMap(entry =>
          fs.statSync(entry).isDirectory()
            ? (fs.readdirSync(entry, { recursive: true }) as string[]).map(
                name => path.join(entry, name),
              )
            : [entry],
        )
        .sort()
        .map(file => {
          const stat = fs.statSync(file)
          return `${file} ${stat.size} ${stat.mtimeMs}`
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
      const r = runner(at)
      const folder = await pick(r, at.work)
      expect(
        await refused(
          r.call('folders.add', { path: path.join(at.home, '.claude') }),
        ),
      ).toBe('E_FOLDER')
      const id = await begin(r, folder, 'edit notes.md', 'off', 'waiting')
      const ask = r.turns(id).find(one => one.ask !== undefined)!.ask as Message
      const mark = r.mark
      await r.call('session.answer', {
        session: id,
        ask: String(ask.id),
        decision: 'once',
      })
      await r.state(id, 'idle', mark)
      await r.call('session.read', { session: id })
      await r.call('session.changes', { session: id })
      await r.call('list')
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    const inside = touched.filter(file =>
      own.some(dir => file === dir || file.startsWith(`${dir}${path.sep}`)),
    )
    expect(inside).toEqual([])
    expect(touched.length).toBeGreaterThan(0)
    expect(snapshot()).toEqual(before)
  })

  test('the agent’s environment: the login shell’s, without 阡陌’s or the nesting markers', async () => {
    const at = box()
    const envLog = path.join(at.root, 'agent-env.json')
    const r = runner(at, {
      fake: { FAKE_CLAUDE_ENV_LOG: envLog },
      env: {
        PATH: `${at.bin}:/usr/bin:/bin`,
        HOME: at.home,
        QMO_CLIENT_DIR: at.client,
        QIANMO_CONFIG_DIR: '/x',
        TAURI_ENV_DEBUG: '1',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        XPC_SERVICE_NAME: 'app',
        __CFBundleIdentifier: 'xyz.cornna.qmo',
        KEPT_FROM_RUNNER: 'yes',
      },
      login: {
        PATH: `${at.bin}:/opt/login/bin:/usr/bin:/bin`,
        LOGIN_SENTINEL: 'sentinel-7f3a9c',
        QMO_SHELL_PROBE: '1',
        PWD: '/tmp',
      },
    })
    const folder = await pick(r, at.work)
    await begin(r, folder, 'hello')
    const got = JSON.parse(fs.readFileSync(envLog, 'utf8')) as Record<
      string,
      string
    >
    expect(got.LOGIN_SENTINEL).toBe('sentinel-7f3a9c')
    expect(got.KEPT_FROM_RUNNER).toBe('yes')
    expect(got.PATH).toBe(`${at.bin}:/opt/login/bin:/usr/bin:/bin`)
    expect(got.__cwd).toBe(at.work)
    for (const name of Object.keys(got))
      expect(name).not.toMatch(
        /^(QMO_|QIANMO_|TAURI_|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|XPC_SERVICE_NAME$|__CFBundleIdentifier$)/,
      )
    expect(got.PWD).not.toBe('/tmp')
    expect(got.CLAUDE_CONFIG_DIR).toBeUndefined()
    // Not written anywhere of ours, or into HOME.
    await r.stop()
    running.length = 0
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile()) files.push(full)
      }
    }
    walk(at.client)
    walk(at.home)
    expect(files.length).toBeGreaterThan(2)
    for (const file of files)
      expect(fs.readFileSync(file, 'utf8')).not.toContain('sentinel-7f3a9c')
  })

  test('changes and a diff in a Git folder; none in another', async () => {
    const at = box()
    const git = (...args: string[]) =>
      Bun.spawnSync(['git', ...args], {
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
    git('init', '-q')
    fs.writeFileSync(path.join(at.work, 'notes.md'), 'one\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    const r = runner(at)
    const folder = await pick(r, at.work)
    expect(((await r.call('list')).folders as Message[])[0]!.git).toBe(true)
    const id = await begin(r, folder, 'edit notes.md', 'accept-edits')
    expect(await r.call('session.changes', { session: id })).toEqual({
      source: 'git',
      base: 'HEAD',
      files: [
        {
          path: 'notes.md',
          status: 'modified',
          added: 1,
          removed: 0,
          binary: false,
        },
      ],
      truncated: false,
    })
    const diff = await r.call('session.diff', { session: id, path: 'notes.md' })
    expect(diff).toMatchObject({
      path: 'notes.md',
      truncated: false,
      binary: false,
    })
    expect(String(diff.text)).toContain('+edited')
    expect(
      await refused(r.call('session.diff', { session: id, path: '../x' })),
    ).toBe('E_ARGS')
    expect(
      await refused(r.call('session.diff', { session: id, path: '-p' })),
    ).toBe('E_ARGS')
    // 1024 UTF-16 code units, as the shell counts: 513 emoji are 1026.
    expect(
      await refused(
        r.call('session.diff', { session: id, path: '😀'.repeat(513) }),
      ),
    ).toBe('E_ARGS')
    const other = path.join(at.root, 'plain')
    fs.mkdirSync(other)
    const plain = await begin(r, await pick(r, other), 'hello')
    expect(await r.call('session.changes', { session: plain })).toEqual({
      source: 'session',
      files: [],
      truncated: false,
    })
  })

  test('the conversation on disk: 0700/0600, the chat store’s envelope, seq one by one', async () => {
    const at = box()
    const r = runner(at)
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'edit a.md', 'accept-edits')
    const dir = path.join(at.code, 'sessions', id)
    expect(fs.statSync(at.code).mode & 0o777).toBe(0o700)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    for (const name of ['session.json', 'events.ndjson'])
      expect(fs.statSync(path.join(dir, name)).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.join(at.code, 'folders.json')).mode & 0o777).toBe(
      0o600,
    )
    const lines = fs
      .readFileSync(path.join(dir, 'events.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Message)
    expect(lines.map(line => line.seq)).toEqual(lines.map((_, i) => i))
    expect(lines[0]).toEqual({
      kind: 'session',
      seq: 0,
      session: {
        id,
        target: 'local',
        node: 'local',
        agent: 'Claude Code',
        createdAt: expect.any(Number),
      },
    })
    const header = JSON.parse(
      fs.readFileSync(path.join(dir, 'session.json'), 'utf8'),
    ) as Message
    expect(header).toMatchObject({
      id,
      root: at.work,
      folder: { path: at.work, name: 'work' },
      agent: {
        id: 'claude-code',
        name: 'Claude Code',
        protocol: 'claude-stream',
        version: '9.9.9',
      },
      mode: 'accept-edits',
      state: 'idle',
      native: { kind: 'claude-session', started: true },
      remote: { on: false, pushedSeq: 0 },
    })
  })
})
