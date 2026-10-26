// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The runner with the four ACP agents (qmo-local.md §4.3.4, §4.3.5, §4.4):
 * Gemini CLI, Qwen Code, opencode and DeepSeek Harness, each the harness
 * package's `fake-acp-agent.runner.ts` behind a shell script named like the
 * real command. No real agent is started. POSIX only: the agent runs in a
 * process group of its own and the fake is a shell script.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AgentsReport } from '../../src/agents.ts'
import {
  type Box,
  box,
  cleanBoxes,
  logged,
  type Message,
  pick,
  Refused,
  startRunner,
  type StartOptions,
  type TestRunner,
} from './helpers.ts'

const posix = process.platform !== 'win32'
const running: TestRunner[] = []

afterEach(async () => {
  for (const runner of running.splice(0)) await runner.stop()
  cleanBoxes()
})

/** The harness package's fake ACP agent. */
const FAKE_ACP = path.join(
  path.dirname(Bun.resolveSync('@qianmo/harness/process.ts', import.meta.dir)),
  '..',
  'test',
  'fixtures',
  'fake-acp-agent.runner.ts',
)

type Profile = 'gemini' | 'qwen' | 'opencode' | 'dsh'
const AGENTS: Readonly<
  Record<Profile, { readonly name: string; readonly argv: string[] }>
> = {
  gemini: { name: 'Gemini CLI', argv: ['--acp'] },
  qwen: { name: 'Qwen Code', argv: ['--acp'] },
  opencode: { name: 'opencode', argv: ['acp'] },
  dsh: { name: 'DeepSeek Harness', argv: ['--profile', 'acp'] },
}
const PROFILES = Object.keys(AGENTS) as Profile[]

/** `<bin>/<command>`: the fake as that agent, with `env` set for it. */
function fakeAcp(
  at: Box,
  profile: Profile,
  env: Readonly<Record<string, string>> = {},
): string {
  const file = path.join(at.bin, profile)
  const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`
  const vars = Object.entries({
    FAKE_ACP_STATE: at.state,
    FAKE_ACP_PROFILE: profile,
    ...env,
  })
    .map(([name, value]) => `${name}=${quote(value)}`)
    .join(' ')
  fs.writeFileSync(
    file,
    `#!/bin/sh\n${vars} exec ${quote(process.execPath)} ${quote(FAKE_ACP)} "$@"\n`,
  )
  fs.chmodSync(file, 0o755)
  return file
}

/** What `qmo agents` would say: the ACP agents at their programs, or not found. */
function acpReport(
  found: Partial<Record<Profile, string | { readonly reason: string }>>,
): AgentsReport {
  return {
    agents: Object.entries(found).map(([id, at]) => ({
      id,
      name: AGENTS[id as Profile].name,
      version: '0.0.1',
      path: typeof at === 'string' ? at : null,
      protocol: 'acp',
      available: typeof at === 'string',
      reason: typeof at === 'string' ? null : at!.reason,
      source: 'path',
      configFound: false,
      signedIn: null,
    })),
  }
}

/** A runner with the fake as `profile` (and any other agents in `extra`). */
function runner(
  at: Box,
  profile: Profile,
  options: StartOptions & { readonly agent?: Record<string, string> } = {},
): TestRunner {
  const program = fakeAcp(at, profile, options.agent)
  const started = startRunner(at, {
    ...options,
    scan: options.scan ?? (async () => acpReport({ [profile]: program })),
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

/** Starts a session with `agent`; its id once it reaches `settle`. */
async function begin(
  r: TestRunner,
  folder: string,
  agent: Profile,
  text: string,
  mode = 'auto',
  settle: string | null = 'idle',
): Promise<string> {
  const started = await r.call('session.start', {
    folder,
    agent,
    mode,
    worktree: false,
    text,
    clientId: 'c1',
  })
  const id = String((started.session as Message).id)
  if (settle !== null) await r.state(id, settle)
  return id
}

/** Every request the fake was sent, in order. */
function methods(at: Box): Message[] {
  return logged(path.join(at.state, 'methods.ndjson'))
}

function modesSet(at: Box): string[] {
  return methods(at)
    .filter(one => one.method === 'session/set_mode')
    .map(one => String((one.params as Message).modeId))
}

function chosen(at: Box): string[] {
  return logged(path.join(at.state, 'answers.ndjson'))
    .filter(one => one.chosen !== undefined)
    .map(one => String(one.chosen))
}

function texts(r: TestRunner, id: string): string[] {
  return r.turns(id).map(one => String(one.text))
}

/** The session's open question, once there is one. */
async function question(r: TestRunner, id: string): Promise<Message> {
  return r.until(() => {
    const turn = r
      .turns(id)
      .find(
        one =>
          one.ask !== undefined && (one.ask as Message).decision === undefined,
      )
    return turn === undefined ? undefined : (turn.ask as Message)
  })
}

async function answer(
  r: TestRunner,
  id: string,
  decision: string,
  settle = 'idle',
): Promise<Message> {
  const ask = await question(r, id)
  const mark = r.mark
  await r.call('session.answer', {
    session: id,
    ask: String(ask.id),
    decision,
  })
  await r.state(id, settle, mark)
  return ask
}

function header(at: Box, id: string): Message {
  return JSON.parse(
    fs.readFileSync(path.join(at.code, 'sessions', id, 'session.json'), 'utf8'),
  ) as Message
}

describe.skipIf(!posix)('the runner with ACP agents', () => {
  test('each starts with only its ACP flag, in the session’s folder, never asked to authenticate', async () => {
    for (const profile of PROFILES) {
      const at = box()
      const r = runner(at, profile)
      expect(((await r.call('hello')).features as Message).protocols).toContain(
        'acp',
      )
      const folder = await pick(r, at.work)
      const id = await begin(r, folder, profile, 'hello')
      expect(texts(r, id)).toEqual(['hello', 'acp(1): hello'])
      expect(
        logged(path.join(at.state, 'argv.ndjson')) as unknown as string[][],
      ).toEqual([AGENTS[profile].argv])
      const sent = methods(at)
      expect(sent.map(one => one.method)).not.toContain('authenticate')
      expect(sent[0]).toMatchObject({
        method: 'initialize',
        params: {
          clientInfo: { name: 'qmo', title: 'Qmo' },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
      })
      expect(sent[1]).toEqual({
        method: 'session/new',
        params: { cwd: at.work, mcpServers: [] },
      })
      const listed = ((await r.call('list')).sessions as Message[])[0]!
      expect(listed).toMatchObject({
        agent: { id: profile, name: AGENTS[profile].name },
        mode: 'auto',
        state: 'idle',
      })
      // The agent's session id, kept to continue it.
      const native = header(at, id).native as Message
      expect(native).toMatchObject({ kind: 'acp-session', started: true })
      expect(native.id).toBe(
        (sent.find(one => one.method === 'session/prompt')!.params as Message)
          .sessionId,
      )
      await r.stop()
      running.length = 0
    }
  })

  test('Gemini CLI and Qwen Code: the four modes are their own ACP modes', async () => {
    const expected: Record<string, Record<string, string[]>> = {
      gemini: {
        off: [],
        'accept-edits': ['autoEdit'],
        auto: ['autoEdit'],
        'full-access': ['yolo'],
      },
      qwen: {
        off: [],
        'accept-edits': ['auto-edit'],
        auto: ['auto-edit'],
        'full-access': ['yolo'],
      },
    }
    for (const profile of ['gemini', 'qwen'] as const)
      for (const mode of ['off', 'accept-edits', 'auto', 'full-access']) {
        const at = box()
        const r = runner(at, profile)
        const folder = await pick(r, at.work)
        // An edit: asked only in 人工确认.
        const id = await begin(
          r,
          folder,
          profile,
          'edit notes.md',
          mode,
          mode === 'off' ? 'waiting' : 'idle',
        )
        expect(modesSet(at)).toEqual(expected[profile]![mode]!)
        if (mode === 'off') await answer(r, id, 'once')
        expect(fs.readFileSync(path.join(at.work, 'notes.md'), 'utf8')).toBe(
          'edited by fake\n',
        )
        const tool = r.turns(id).find(one => one.tool !== undefined)!
        expect(tool).toMatchObject({
          text: '编辑 notes.md',
          detail: '@@ -0,0 +1,1 @@\n+edited by fake',
          tool: {
            status: 'done',
            paths: ['notes.md'],
            detailKind: 'diff',
            added: 1,
            removed: 0,
          },
        })
        // A command: asked except in 跳过权限确认.
        const mark = r.mark
        await r.call('session.send', {
          session: id,
          text: 'bash ls',
          clientId: 'c2',
        })
        if (mode === 'full-access') await r.state(id, 'idle', mark)
        else await answer(r, id, 'once')
        expect(r.turns(id).at(-1)!.text).toBe('acp(2): bash done')
        const asked = r.turns(id).filter(one => one.ask !== undefined).length
        expect(asked).toBe(mode === 'off' ? 2 : mode === 'full-access' ? 0 : 1)
        // Nothing here is ever answered by the runner: the agent's own modes do it.
        expect(
          r
            .turns(id)
            .filter(one => (one.tool as Message)?.approvedBy === 'mode'),
        ).toEqual([])
        await r.stop()
        running.length = 0
      }
  })

  test('opencode and dsh: no modes of theirs; the runner answers by the mode, never a command short of 跳过权限确认', async () => {
    for (const profile of ['opencode', 'dsh'] as const)
      for (const mode of ['off', 'accept-edits', 'auto', 'full-access']) {
        const at = box()
        const r = runner(at, profile)
        const folder = await pick(r, at.work)
        const byMode = mode !== 'off'
        const id = await begin(
          r,
          folder,
          profile,
          'edit notes.md',
          mode,
          byMode ? 'idle' : 'waiting',
        )
        if (!byMode) await answer(r, id, 'once')
        const edit = r.turns(id).find(one => one.tool !== undefined)!
        expect(edit.tool).toMatchObject({
          status: 'done',
          paths: ['notes.md'],
          ...(byMode ? { approvedBy: 'mode' } : { approvedBy: 'user' }),
        })
        // An edit outside the session's folder is the person's to allow.
        const outside = path.join(at.root, 'elsewhere.txt')
        let mark = r.mark
        await r.call('session.send', {
          session: id,
          text: `edit ${outside}`,
          clientId: 'c2',
        })
        if (mode === 'full-access') await r.state(id, 'idle', mark)
        else await answer(r, id, 'deny')
        expect(fs.existsSync(outside)).toBe(mode === 'full-access')
        mark = r.mark
        await r.call('session.send', {
          session: id,
          text: 'bash ls',
          clientId: 'c3',
        })
        if (mode === 'full-access') await r.state(id, 'idle', mark)
        else await answer(r, id, 'once')
        const asks = r.turns(id).filter(one => one.ask !== undefined)
        expect(asks.length).toBe(
          mode === 'off' ? 3 : mode === 'full-access' ? 0 : 2,
        )
        // 本会话都允许 is never offered: no option of theirs is known to keep to the session.
        for (const ask of asks)
          expect((ask.ask as Message).options).toEqual(['once', 'deny'])
        // opencode's own ACP modes are its agents: never switched.
        expect(modesSet(at)).toEqual([])
        await r.stop()
        running.length = 0
      }
  })

  test('a mode it would start looser than asked and will not leave: the line is not sent', async () => {
    // The user's own settings start it in yolo.
    const at = box()
    const r = runner(at, 'gemini', {
      agent: { FAKE_ACP_START_MODE: 'yolo', FAKE_ACP_SET_MODE_FAIL: '1' },
    })
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'gemini', 'hello', 'off', 'failed')
    expect(r.turns(id).at(-1)).toMatchObject({
      state: 'failed',
      code: 'E_AGENT',
    })
    expect(String(r.turns(id).at(-1)!.text)).toContain(
      'Gemini CLI 没有切到 default',
    )
    expect(methods(at).map(one => one.method)).not.toContain('session/prompt')
    // Where it does switch, it is put back to default before the line.
    const ok = box()
    const s = runner(ok, 'gemini', { agent: { FAKE_ACP_START_MODE: 'yolo' } })
    const there = await pick(s, ok.work)
    await begin(s, there, 'gemini', 'edit a.txt', 'off', 'waiting')
    expect(modesSet(ok)).toEqual(['default'])
  })

  test('a looser mode the agent refuses: it stays in its own, says so, and what it asks is the person’s', async () => {
    const at = box()
    const r = runner(at, 'gemini', { agent: { FAKE_ACP_SET_MODE_FAIL: '1' } })
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'gemini', 'bash ls', 'auto', 'waiting')
    // Asked for once, refused; not asked again before the line.
    expect(modesSet(at)).toEqual(['autoEdit'])
    expect(
      r
        .turns(id)
        .map(one => String(one.text))
        .find(text => text.startsWith('Gemini CLI 没有切到 autoEdit')),
    ).toBe(
      'Gemini CLI 没有切到 autoEdit（Gemini CLI session/set_mode: Cannot change the approval mode in an untrusted folder），按「人工确认」继续',
    )
    expect(((await r.call('list')).sessions as Message[])[0]!.mode).toBe('off')
    await answer(r, id, 'once')
    expect(r.turns(id).find(one => one.tool !== undefined)!.tool).toMatchObject(
      { status: 'done', approvedBy: 'user' },
    )
    // Asked for again, it is refused, and the mode stays.
    expect(
      await refused(
        r.call('session.mode', { session: id, mode: 'full-access' }),
      ),
    ).toBe('E_AGENT')
    expect(((await r.call('list')).sessions as Message[])[0]!.mode).toBe('off')
  })

  test('跳过权限确认 where Gemini offers no yolo: the widest mode it has, said so; a command is the person’s', async () => {
    const at = box()
    const r = runner(at, 'gemini', { agent: { FAKE_ACP_NO_YOLO: '1' } })
    const folder = await pick(r, at.work)
    const id = await begin(
      r,
      folder,
      'gemini',
      'bash ls',
      'full-access',
      'waiting',
    )
    expect(modesSet(at)).toEqual(['autoEdit'])
    expect(
      r
        .turns(id)
        .map(one => String(one.text))
        .find(text => text.startsWith('Gemini CLI 没有「跳过权限确认」')),
    ).toBe(
      'Gemini CLI 没有「跳过权限确认」（它没提供 yolo），按「自动接受编辑」继续',
    )
    expect(((await r.call('list')).sessions as Message[])[0]!.mode).toBe(
      'accept-edits',
    )
    // The runner answers by 自动接受编辑, not by what was picked: the command is asked.
    expect(await question(r, id)).toMatchObject({
      input: 'ls',
      options: ['once', 'session', 'deny'],
    })
    await answer(r, id, 'once')
    expect(r.turns(id).find(one => one.tool !== undefined)!.tool).toMatchObject(
      { status: 'done', command: 'ls', approvedBy: 'user' },
    )
    expect(chosen(at)).toEqual(['proceed_once'])
    // Asked for in the session, it is refused, and the mode stays.
    expect(
      await refused(
        r.call('session.mode', { session: id, mode: 'full-access' }),
      ),
    ).toBe('E_AGENT')
    expect(((await r.call('list')).sessions as Message[])[0]!.mode).toBe(
      'accept-edits',
    )
    expect(modesSet(at)).toEqual(['autoEdit'])
  })

  test('跳过权限确认 for opencode, which has no modes: the runner still allows every call', async () => {
    const at = box()
    const r = runner(at, 'opencode')
    const folder = await pick(r, at.work)
    const outside = path.join(at.root, 'elsewhere.txt')
    const id = await begin(r, folder, 'opencode', 'bash ls', 'full-access')
    const mark = r.mark
    await r.call('session.send', {
      session: id,
      text: `edit ${outside}`,
      clientId: 'c2',
    })
    await r.state(id, 'idle', mark)
    expect(r.turns(id).filter(one => one.ask !== undefined)).toEqual([])
    expect(
      r
        .turns(id)
        .filter(one => one.tool !== undefined)
        .map(one => one.tool),
    ).toMatchObject([
      { status: 'done', command: 'ls', approvedBy: 'mode' },
      { status: 'done', approvedBy: 'mode' },
    ])
    expect(fs.existsSync(outside)).toBe(true)
    expect(chosen(at)).toEqual(['once', 'once'])
    expect(modesSet(at)).toEqual([])
    expect(
      r
        .turns(id)
        .some(one => String(one.text).includes('没有「跳过权限确认」')),
    ).toBe(false)
  })

  test('the mode changed in a session: session/set_mode now; refused, the old one stays', async () => {
    const at = box()
    const r = runner(at, 'gemini')
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'gemini', 'hello', 'off')
    expect(
      await r.call('session.mode', { session: id, mode: 'accept-edits' }),
    ).toEqual({ mode: 'accept-edits', applies: 'now' })
    expect(
      await r.call('session.mode', { session: id, mode: 'full-access' }),
    ).toEqual({ mode: 'full-access', applies: 'now' })
    expect(modesSet(at)).toEqual(['autoEdit', 'yolo'])
    // The agent will not go back to a stricter one: refused, kept.
    const stuck = box()
    const s = runner(stuck, 'gemini', {
      agent: { FAKE_ACP_START_MODE: 'autoEdit', FAKE_ACP_SET_MODE_FAIL: '1' },
    })
    const there = await pick(s, stuck.work)
    const other = await begin(s, there, 'gemini', 'hello', 'accept-edits')
    expect(
      await refused(s.call('session.mode', { session: other, mode: 'off' })),
    ).toBe('E_AGENT')
    const listed = (await s.call('list')).sessions as Message[]
    expect(listed[0]!.mode).toBe('accept-edits')
  })

  test('本会话都允许: Gemini’s and Qwen’s session option, never the one that writes their settings', async () => {
    for (const profile of ['gemini', 'qwen'] as const) {
      const at = box()
      const r = runner(at, profile, {
        agent: { FAKE_ACP_SWITCH_ON_ALWAYS: '1' },
      })
      const folder = await pick(r, at.work)
      const id = await begin(r, folder, profile, 'bash ls', 'off', 'waiting')
      const ask = await answer(r, id, 'session')
      expect(ask.options).toEqual(['once', 'session', 'deny'])
      expect(
        r.turns(id).find(one => one.tool !== undefined)!.tool,
      ).toMatchObject({ status: 'done', approvedBy: 'session' })
      // An edit allowed for the session: the agent switches itself, and says so.
      const mark = r.mark
      await r.call('session.send', {
        session: id,
        text: 'edit a.txt',
        clientId: 'c2',
      })
      await answer(r, id, 'session')
      await r.event(
        one =>
          one.type === 'session' &&
          (one.session as Message).id === id &&
          (one.session as Message).mode === 'accept-edits',
        undefined,
        mark,
      )
      await r.say(id, 'edit b.txt')
      expect(chosen(at)).toEqual(['proceed_always', 'proceed_always'])
      expect(fs.existsSync(path.join(at.state, 'saved-settings.json'))).toBe(
        false,
      )
      expect(r.turns(id).filter(one => one.ask !== undefined).length).toBe(2)
    }
    // opencode offers `always` too: not known to keep to the session, not offered.
    const at = box()
    const r = runner(at, 'opencode')
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'opencode', 'bash ls', 'off', 'waiting')
    const ask = await question(r, id)
    expect(ask.options).toEqual(['once', 'deny'])
    expect(
      await refused(
        r.call('session.answer', {
          session: id,
          ask: String(ask.id),
          decision: 'session',
        }),
      ),
    ).toBe('E_ASK')
  })

  test('拒绝: the agent’s reject option; the call is denied', async () => {
    const at = box()
    const r = runner(at, 'gemini')
    const folder = await pick(r, at.work)
    const id = await begin(
      r,
      folder,
      'gemini',
      'bash rm -rf x',
      'off',
      'waiting',
    )
    const ask = await question(r, id)
    const mark = r.mark
    await r.call('session.answer', {
      session: id,
      ask: String(ask.id),
      decision: 'deny',
      message: '别删',
    })
    await r.state(id, 'idle', mark)
    expect(chosen(at)).toEqual(['cancel'])
    const tool = r.turns(id).find(one => one.tool !== undefined)!
    expect(tool).toMatchObject({
      severity: 'warn',
      tool: { status: 'denied', command: 'rm -rf x' },
    })
    expect(r.turns(id).find(one => one.ask !== undefined)!.ask).toMatchObject({
      decision: 'deny',
      by: 'user',
    })
    // The question came after the call's line, though Gemini asked first.
    const order = r
      .turns(id)
      .map(one => (one.tool ? 'tool' : one.ask ? 'ask' : 'line'))
    expect(order.indexOf('tool')).toBeLessThan(order.indexOf('ask'))
  })

  test('a stop while it asks: cancelled, the question denied by the stop; the next line continues', async () => {
    const at = box()
    const r = runner(at, 'gemini')
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'gemini', 'hang-ask', 'off', 'waiting')
    const mark = r.mark
    await r.call('session.stop', { session: id })
    await r.state(id, 'interrupted', mark)
    expect(r.turns(id).find(one => one.ask !== undefined)!.ask).toMatchObject({
      decision: 'deny',
      by: 'stop',
    })
    expect(chosen(at)).toEqual(['cancelled'])
    expect(r.turns(id).at(-1)).toMatchObject({ text: '已中断' })
    await r.say(id, 'after')
    expect(r.turns(id).at(-1)!.text).toBe('acp(2): after')
    expect(methods(at).map(one => one.method)).toContain('session/cancel')
  })

  test('a crash fails the turn; the next line continues the conversation (session/load, session/resume)', async () => {
    for (const [profile, how] of [
      ['gemini', 'session/load'],
      ['dsh', 'session/resume'],
    ] as const) {
      const at = box()
      const r = runner(at, profile)
      const folder = await pick(r, at.work)
      const id = await begin(r, folder, profile, 'hello')
      await r.say(id, 'crash', 'failed')
      expect(r.turns(id).at(-1)).toMatchObject({
        state: 'failed',
        code: 'E_AGENT',
      })
      await r.say(id, 'after')
      expect(r.turns(id).at(-1)!.text).toBe('acp(3): after')
      const native = String((header(at, id).native as Message).id)
      const continued = methods(at).filter(one => one.method === how)
      expect(continued.map(one => (one.params as Message).sessionId)).toEqual([
        native,
      ])
      // The old conversation Gemini replays is not this turn's answer.
      expect(texts(r, id)).not.toContain('OLD-ANSWER')
      await r.stop()
      running.length = 0
    }
  })

  test('the conversation gone on the agent’s side: said so, and the line starts a new one', async () => {
    const at = box()
    const first = runner(at, 'qwen')
    const folder = await pick(first, at.work)
    const id = await begin(first, folder, 'qwen', 'hello')
    await first.stop()
    running.length = 0
    const old = String((header(at, id).native as Message).id)
    fs.rmSync(path.join(at.state, 'sessions', old))
    const r = runner(at, 'qwen')
    await r.say(id, 'again')
    const read = await r.call('session.read', { session: id })
    expect(
      (read.records as Message[]).map(one => (one.turn as Message).text),
    ).toEqual([
      'hello',
      'acp(1): hello',
      'again',
      '上次的对话 Qwen Code 那边已经没有了，这一句从新对话开始',
      'acp(1): again',
    ])
    const now = String((header(at, id).native as Message).id)
    expect(now).not.toBe(old)
    expect(now).not.toBe('')
  })

  test('a conversation it keeps failing to open: the line fails twice, the third starts a new one', async () => {
    const at = box()
    const first = runner(at, 'dsh')
    const folder = await pick(first, at.work)
    const id = await begin(first, folder, 'dsh', 'hello')
    await first.stop()
    running.length = 0
    const r = runner(at, 'dsh', { agent: { FAKE_ACP_RESUME_FAIL: '1' } })
    for (const line of ['one', 'two']) {
      await r.say(id, line, 'failed')
      expect(String(r.turns(id).at(-1)!.text)).toContain(
        'DeepSeek Harness session/resume: Internal error',
      )
    }
    await r.say(id, 'three')
    expect(texts(r, id).slice(-2)).toEqual([
      '上次的对话 DeepSeek Harness 那边已经没有了，这一句从新对话开始',
      'acp(1): three',
    ])
    expect(
      methods(at).filter(one => one.method === 'session/resume'),
    ).toHaveLength(3)
  })

  test('not signed in: its own words and how to sign in; authenticate is never sent', async () => {
    const hints: Record<Profile, string> = {
      gemini: 'gemini',
      qwen: 'qwen',
      opencode: 'opencode auth login',
      dsh: 'dsh',
    }
    for (const profile of PROFILES) {
      const at = box()
      const r = runner(at, profile, { agent: { FAKE_ACP_AUTH: 'required' } })
      const folder = await pick(r, at.work)
      const id = await begin(r, folder, profile, 'hello', 'auto', 'failed')
      expect(r.turns(id).at(-1)).toMatchObject({
        state: 'failed',
        code: 'E_AGENT',
        text: `${AGENTS[profile].name} session/new: Authentication required\n在终端里运行 \`${hints[profile]}\` 登录后再试`,
      })
      expect(methods(at).map(one => one.method)).toEqual([
        'initialize',
        'session/new',
      ])
      await r.stop()
      running.length = 0
    }
  })

  test('an agent qmo agents could not find stays out, with its reason', async () => {
    const at = box()
    const gemini = fakeAcp(at, 'gemini')
    const r = startRunner(at, {
      scan: async () =>
        acpReport({
          gemini,
          opencode: {
            reason:
              'CLI 未找到（有 ~/.config/opencode，但 PATH 与常见安装位置里都没有 opencode）',
          },
          dsh: { reason: 'CLI 未找到（只装了桌面 App）' },
        }),
    })
    running.push(r)
    const folder = await pick(r, at.work)
    for (const agent of ['opencode', 'dsh'])
      await expect(
        r.call('session.start', {
          folder,
          agent,
          mode: 'auto',
          worktree: false,
          text: 'hi',
          clientId: 'c',
        }),
      ).rejects.toThrow(/E_AGENT: CLI 未找到/)
    await begin(r, folder, 'gemini', 'hello')
  })

  test('a stop the agent ignores ends its whole process group', async () => {
    const at = box()
    const r = runner(at, 'dsh', {
      limits: { interruptGraceMs: 200, termGraceMs: 300 },
      agent: { FAKE_ACP_IGNORE_TERM: '1' },
    })
    const folder = await pick(r, at.work)
    const id = await begin(r, folder, 'dsh', 'spawn', 'auto', 'running')
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
      path.join(at.home, '.gemini'),
      path.join(at.home, '.qwen'),
      path.join(at.home, '.dsh'),
      path.join(at.home, '.config', 'opencode'),
      path.join(at.home, '.local', 'share', 'opencode'),
      path.join(at.home, '.claude'),
      path.join(at.home, '.codex'),
    ]
    const put = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text)
    }
    put(path.join(at.home, '.gemini', 'oauth_creds.json'), '{"secret":1}')
    put(path.join(at.home, '.gemini', 'settings.json'), '{}')
    put(path.join(at.home, '.qwen', 'settings.json'), '{}')
    put(path.join(at.home, '.dsh', 'config.yaml'), 'x: 1\n')
    put(path.join(at.home, '.config', 'opencode', 'opencode.json'), '{}')
    const snapshot = () =>
      own
        .filter(entry => fs.existsSync(entry))
        .flatMap(entry =>
          (fs.readdirSync(entry, { recursive: true }) as string[]).map(name =>
            path.join(entry, name),
          ),
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
      const r = runner(at, 'gemini')
      const folder = await pick(r, at.work)
      for (const guarded of own.slice(0, 4))
        expect(await refused(r.call('folders.add', { path: guarded }))).toBe(
          'E_FOLDER',
        )
      const id = await begin(
        r,
        folder,
        'gemini',
        'edit notes.md',
        'off',
        'waiting',
      )
      await answer(r, id, 'once')
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

  test('the agent’s environment: the login shell’s, without 阡陌’s, no directories or keys of ours', async () => {
    const at = box()
    const envLog = path.join(at.root, 'agent-env.json')
    const r = runner(at, 'gemini', {
      agent: { FAKE_ACP_ENV_LOG: envLog },
      env: {
        PATH: `${at.bin}:/usr/bin:/bin`,
        HOME: at.home,
        QMO_CLIENT_DIR: at.client,
        QIANMO_CONFIG_DIR: '/x',
        TAURI_ENV_DEBUG: '1',
        CLAUDECODE: '1',
        XPC_SERVICE_NAME: 'app',
        __CFBundleIdentifier: 'xyz.cornna.qmo',
        KEPT_FROM_RUNNER: 'yes',
      },
      login: {
        PATH: `${at.bin}:/opt/login/bin:/usr/bin:/bin`,
        LOGIN_SENTINEL: 'sentinel-acp-41c2',
      },
    })
    const folder = await pick(r, at.work)
    await begin(r, folder, 'gemini', 'hello')
    const got = JSON.parse(fs.readFileSync(envLog, 'utf8')) as Record<
      string,
      string
    >
    expect(got.LOGIN_SENTINEL).toBe('sentinel-acp-41c2')
    expect(got.KEPT_FROM_RUNNER).toBe('yes')
    expect(got.__cwd).toBe(at.work)
    for (const name of Object.keys(got))
      expect(name).not.toMatch(
        /^(QMO_|QIANMO_|TAURI_|CLAUDECODE$|XPC_SERVICE_NAME$|__CFBundleIdentifier$)/,
      )
    for (const name of [
      'GEMINI_CLI_HOME',
      'QWEN_HOME',
      'DSH_HOME',
      'OPENCODE_CONFIG_DIR',
      'GEMINI_API_KEY',
      'OPENAI_BASE_URL',
    ])
      expect(got[name]).toBeUndefined()
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
    for (const file of files)
      expect(fs.readFileSync(file, 'utf8')).not.toContain('sentinel-acp-41c2')
  })
})
