// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The ACP channel's local extras (qmo-local.md §4.3.3) on the fake agent:
 * the modes and `session/set_mode`, text as it streams, tool content, the
 * three answers and which `allow_always` option is ever chosen; that the
 * resident's frames are the same with and without them; and that nothing
 * ever sends `authenticate`. No real agent is started.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type AcpAsk,
  type AcpAskDecision,
  AcpChannel,
  type AcpDetail,
  type AcpPermissionOption,
  AcpRpcError,
} from '../src/acpClient.ts'
import type { HarnessFrame } from '../src/process.ts'

const FAKE = path.join(import.meta.dir, 'fixtures', 'fake-acp-agent.runner.ts')

const roots: string[] = []
const channels: AcpChannel[] = []
afterEach(async () => {
  for (const channel of channels.splice(0)) await channel.stop(true)
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

interface Opened {
  readonly channel: AcpChannel
  readonly frames: HarnessFrame[]
  readonly details: AcpDetail[]
  readonly asks: AcpAsk[]
  readonly state: string
  readonly cwd: string
}

type Line = Record<string, unknown>

function lines(file: string): Line[] {
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line) as Line)
    : []
}

/** Every method the fake was sent. */
function methods(state: string): string[] {
  return lines(path.join(state, 'methods.ndjson')).map(one =>
    String(one.method),
  )
}

const geminiSession = (option: AcpPermissionOption) =>
  option.optionId === 'proceed_always'

function open(
  profile: 'gemini' | 'qwen' | 'opencode' | 'dsh',
  options: {
    readonly env?: Record<string, string>
    /** Local extras (default) or the resident's `permission` only. */
    readonly local?: boolean
    readonly answer?: (request: AcpAsk) => Promise<AcpAskDecision>
    readonly permission?: () => Promise<boolean>
    readonly sessionOption?: (option: AcpPermissionOption) => boolean
    readonly sessionId?: string
    readonly cwd?: string
    readonly state?: string
  } = {},
): Opened {
  const cwd =
    options.cwd ??
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-acp-')))
  if (options.cwd === undefined) roots.push(cwd)
  const state = options.state ?? path.join(cwd, '.state')
  fs.mkdirSync(state, { recursive: true })
  const child = spawn(process.execPath, [FAKE], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      FAKE_ACP_STATE: state,
      FAKE_ACP_PROFILE: profile,
      ...options.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const frames: HarnessFrame[] = []
  const details: AcpDetail[] = []
  const asks: AcpAsk[] = []
  const local = options.local !== false
  const channel = new AcpChannel(child, {
    label: `Fake ${profile}`,
    runtime: {},
    cwd,
    mcpServers: [],
    onSession: () => {},
    ...(options.sessionId === undefined
      ? {}
      : { sessionId: options.sessionId }),
    ...(local
      ? {
          clientInfo: { name: 'qmo', title: 'Qmo', version: '0.0.0' },
          onDetail: (detail: AcpDetail) => details.push(detail),
          ask: (request: AcpAsk) => {
            asks.push(request)
            return options.answer?.(request) ?? Promise.resolve('once')
          },
          ...(options.sessionOption === undefined
            ? {}
            : { sessionOption: options.sessionOption }),
        }
      : { permission: options.permission ?? (async () => true) }),
  })
  channels.push(channel)
  channel.onFrame(frame => frames.push(frame))
  return { channel, frames, details, asks, state, cwd }
}

/** Runs one turn to its `prompt_result`. */
async function turn(opened: Opened, text: string): Promise<HarnessFrame> {
  const { promise, resolve } = Promise.withResolvers<HarnessFrame>()
  const off = opened.channel.onFrame(frame => {
    if (frame.type === 'prompt_result') resolve(frame)
  })
  await opened.channel.prompt({ messageId: 'm', text })
  const result = await promise
  off()
  return result
}

/** The frames without what differs from run to run. */
function shape(frames: readonly HarnessFrame[]): unknown[] {
  return frames.map(frame => {
    const { id: _, ...rest } = frame as Record<string, unknown>
    return rest
  })
}

describe('the ACP channel', () => {
  test('the resident’s frames are the same with the local extras as without', async () => {
    const resident = open('dsh', { local: false })
    await resident.channel.initialize()
    await turn(resident, 'bash ls')
    await turn(resident, 'hello')
    const local = open('dsh', { answer: async () => 'once' })
    await local.channel.initialize()
    await turn(local, 'bash ls')
    await turn(local, 'hello')
    expect(shape(local.frames)).toEqual(shape(resident.frames))
    expect(resident.frames.map(frame => frame.type)).toContain(
      'tool_execution_start',
    )
    // The extras only reach the one that asked for them.
    expect(local.details.length).toBeGreaterThan(0)
    expect(local.asks.length).toBe(1)
    // The resident's answer is still a one-time option only.
    expect(
      lines(path.join(resident.state, 'answers.ndjson')).map(one => one.chosen),
    ).toEqual(['allow-once'])
  })

  test('modes from session/new, session/set_mode, and the agent’s own word that it switched', async () => {
    const opened = open('gemini')
    await opened.channel.initialize()
    expect(opened.channel.modes).toEqual({
      current: 'default',
      available: [
        { id: 'default', name: 'default' },
        { id: 'autoEdit', name: 'autoEdit' },
        { id: 'yolo', name: 'yolo' },
        { id: 'plan', name: 'plan' },
      ],
    })
    await opened.channel.setMode('autoEdit')
    expect(opened.channel.modes?.current).toBe('autoEdit')
    const sent = lines(path.join(opened.state, 'methods.ndjson')).find(
      one => one.method === 'session/set_mode',
    )
    expect(sent?.params).toEqual({
      sessionId: opened.channel.sessionId,
      modeId: 'autoEdit',
    })
    await Bun.sleep(50)
    expect(opened.details).toContainEqual({ kind: 'mode', modeId: 'autoEdit' })
    // Refused: the promise says why, the mode is what it was.
    const error = await opened.channel.setMode('nope').catch(e => e)
    expect(error).toBeInstanceOf(AcpRpcError)
    expect(String(error.message)).toContain('Invalid mode')
    expect(opened.channel.modes?.current).toBe('autoEdit')
    // An agent without modes has none to offer.
    const plain = open('dsh')
    await plain.channel.initialize()
    expect(plain.channel.modes).toBeUndefined()
  })

  test('text as it streams, the whole message, and thoughts', async () => {
    const opened = open('dsh')
    await opened.channel.initialize()
    await turn(opened, 'long 450')
    const deltas = opened.details.filter(one => one.kind === 'text-delta')
    expect(deltas.length).toBeGreaterThan(3)
    expect(deltas.map(one => ('text' in one ? one.text : '')).join('')).toBe(
      'x'.repeat(450),
    )
    expect(opened.details.filter(one => one.kind === 'message')).toEqual([
      { kind: 'message', text: 'x'.repeat(450) },
    ])
    await turn(opened, 'think')
    expect(opened.details).toContainEqual({
      kind: 'thinking',
      text: 'THOUGHT-NOT-ANSWER',
    })
  })

  test('Gemini asks before it announces a call: the call starts from the question, its diff, then its end', async () => {
    const opened = open('gemini', {
      sessionOption: geminiSession,
      answer: async () => 'once',
    })
    await opened.channel.initialize()
    const result = await turn(opened, 'edit notes.md')
    expect(result).toMatchObject({ status: 'completed' })
    const file = path.join(opened.cwd, 'notes.md')
    expect(fs.readFileSync(file, 'utf8')).toBe('edited by fake\n')
    const tools = opened.details.filter(one => one.kind === 'tool')
    expect(tools.map(one => ('phase' in one ? one.phase : ''))).toEqual([
      'start',
      'end',
    ])
    const diff = {
      type: 'diff',
      path: file,
      oldText: null,
      newText: 'edited by fake\n',
    }
    expect(tools[0]).toMatchObject({
      phase: 'start',
      id: 'call_edit_1',
      call: { title: 'Writing to notes.md', kind: 'edit', paths: [file] },
      content: [diff],
    })
    expect(tools[1]).toMatchObject({
      phase: 'end',
      id: 'call_edit_1',
      isError: false,
      content: [diff],
    })
    // The message before the call comes first; the question after its start.
    const kinds = opened.details.map(one => one.kind)
    expect(kinds.indexOf('message')).toBeLessThan(kinds.indexOf('tool'))
    const [ask] = opened.asks
    expect(ask).toMatchObject({
      toolCallId: 'call_edit_1',
      call: { kind: 'edit', paths: [file] },
      content: [diff],
      decisions: ['once', 'session', 'deny'],
    })
    expect(
      lines(path.join(opened.state, 'answers.ndjson')).map(one => one.chosen),
    ).toEqual(['proceed_once'])
  })

  test('本会话都允许 picks the session option, never the one that writes the settings', async () => {
    for (const profile of ['gemini', 'qwen'] as const) {
      const opened = open(profile, {
        sessionOption: geminiSession,
        answer: async () => 'session',
      })
      await opened.channel.initialize()
      await turn(opened, 'bash ls')
      await turn(opened, 'edit a.txt')
      // Allowed for the session: the next edit is not asked about.
      await turn(opened, 'edit b.txt')
      expect(
        lines(path.join(opened.state, 'answers.ndjson')).map(one => one.chosen),
      ).toEqual(['proceed_always', 'proceed_always'])
      expect(
        fs.existsSync(path.join(opened.state, 'saved-settings.json')),
      ).toBe(false)
      expect(opened.asks.length).toBe(2)
    }
  })

  test('no option recognized: 本会话都允许 is not offered; 拒绝 is reject_once; answered after a stop is cancelled', async () => {
    // opencode offers `always`, which nothing here recognizes.
    const opencode = open('opencode', { answer: async () => 'deny' })
    await opencode.channel.initialize()
    await turn(opencode, 'bash rm -rf x')
    expect(opencode.asks[0]!.decisions).toEqual(['once', 'deny'])
    expect(
      lines(path.join(opencode.state, 'answers.ndjson')).map(one => one.chosen),
    ).toEqual(['reject'])
    // A recognizer that says yes to everything still only sees allow_always.
    const dsh = open('dsh', { sessionOption: () => true })
    await dsh.channel.initialize()
    await turn(dsh, 'bash ls')
    expect(dsh.asks[0]!.decisions).toEqual(['once', 'deny'])
    // `session` asked for where it is not offered: once, no standing rule.
    const forced = open('opencode', { answer: async () => 'session' })
    await forced.channel.initialize()
    await turn(forced, 'bash ls')
    expect(
      lines(path.join(forced.state, 'answers.ndjson')).map(one => one.chosen),
    ).toEqual(['once'])
    // Stopped while it waits for a person: cancelled, and the ask is told.
    let signal: AbortSignal | undefined
    const waiting = open('gemini', {
      sessionOption: geminiSession,
      answer: request => {
        signal = request.signal
        return new Promise(() => {})
      },
    })
    await waiting.channel.initialize()
    const ended = Promise.withResolvers<HarnessFrame>()
    waiting.channel.onFrame(frame => {
      if (frame.type === 'prompt_result') ended.resolve(frame)
    })
    await waiting.channel.prompt({ messageId: 'm', text: 'hang-ask' })
    while (waiting.asks.length === 0) await Bun.sleep(10)
    await waiting.channel.abort()
    expect(await ended.promise).toMatchObject({ status: 'aborted' })
    expect(signal?.aborted).toBe(true)
    expect(
      lines(path.join(waiting.state, 'answers.ndjson'))
        .filter(one => one.chosen !== undefined)
        .map(one => one.chosen),
    ).toEqual(['cancelled'])
  })

  test('not signed in: the agent’s own error, and authenticate is never sent', async () => {
    const opened = open('gemini', { env: { FAKE_ACP_AUTH: 'required' } })
    const error = await opened.channel.initialize().catch(e => e)
    expect(error).toBeInstanceOf(AcpRpcError)
    expect(error.code).toBe(-32000)
    expect(String(error.message)).toBe(
      'Fake gemini session/new: Authentication required',
    )
    expect(methods(opened.state)).toEqual(['initialize', 'session/new'])
    const init = lines(path.join(opened.state, 'methods.ndjson'))[0]!
    expect(init.params).toMatchObject({
      clientInfo: { name: 'qmo', title: 'Qmo' },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    })
  })

  test('a conversation continues by session/load (replay waited out) or session/resume, and none sends authenticate', async () => {
    const cwd = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'harness-acp-')),
    )
    roots.push(cwd)
    const state = path.join(cwd, '.state')
    for (const profile of ['gemini', 'qwen', 'opencode', 'dsh'] as const) {
      const first = open(profile, { cwd, state })
      await first.channel.initialize()
      await turn(first, 'hello')
      const id = first.channel.sessionId!
      await first.channel.stop()
      const again = open(profile, { cwd, state, sessionId: id })
      await again.channel.initialize()
      expect(again.channel.sessionId).toBe(id)
      await turn(again, 'again')
      const said = again.details
        .filter(one => one.kind === 'message')
        .map(one => ('text' in one ? one.text : ''))
      expect(said).toEqual(['acp(2): again'])
    }
    const sent = methods(state)
    expect(sent.filter(one => one === 'session/load')).toHaveLength(1)
    expect(sent.filter(one => one === 'session/resume')).toHaveLength(3)
    expect(sent).not.toContain('authenticate')
  })
})
