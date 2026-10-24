// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type ClaudeAsk,
  type ClaudeAskAnswer,
  ClaudeCodeChannel,
  type ClaudeDetail,
} from '../src/claudeStream.ts'
import type { HarnessFrame } from '../src/process.ts'

const FAKE = path.join(
  import.meta.dir,
  'fixtures',
  'fake-claude-stream.runner.ts',
)

const roots: string[] = []
const channels: ClaudeCodeChannel[] = []
afterEach(async () => {
  for (const channel of channels.splice(0)) await channel.stop(true)
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

function folder(): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'harness-claude-')),
  )
  roots.push(root)
  return root
}

interface Opened {
  readonly channel: ClaudeCodeChannel
  readonly child: ChildProcess
  readonly frames: HarnessFrame[]
  readonly details: ClaudeDetail[]
  readonly asks: ClaudeAsk[]
  readonly state: string
  readonly cwd: string
}

function open(
  args: readonly string[],
  options: {
    readonly ask?: (request: ClaudeAsk) => Promise<ClaudeAskAnswer>
    readonly detail?: boolean
    readonly env?: Record<string, string>
  } = {},
): Opened {
  const cwd = folder()
  const state = path.join(cwd, '.state')
  fs.mkdirSync(state)
  const child = spawn(process.execPath, [FAKE, ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      FAKE_CLAUDE_STATE: state,
      ...options.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const details: ClaudeDetail[] = []
  const asks: ClaudeAsk[] = []
  const ask = options.ask
  const channel = new ClaudeCodeChannel(child, {
    ...(options.detail === false
      ? {}
      : { onDetail: (detail: ClaudeDetail) => details.push(detail) }),
    ...(ask === undefined
      ? {}
      : {
          ask: (request: ClaudeAsk) => {
            asks.push(request)
            return ask(request)
          },
        }),
  })
  channels.push(channel)
  const frames: HarnessFrame[] = []
  channel.onFrame(frame => frames.push(frame))
  return { channel, child, frames, details, asks, state, cwd }
}

/** Runs one turn and resolves with its `prompt_result`. */
async function turn(opened: Opened, text: string): Promise<HarnessFrame> {
  await opened.channel.initialize()
  const { promise, resolve } = Promise.withResolvers<HarnessFrame>()
  const off = opened.channel.onFrame(frame => {
    if (frame.type === 'prompt_result') resolve(frame)
  })
  await opened.channel.prompt({ messageId: 'm1', text })
  const result = await promise
  off()
  return result
}

function lines(file: string): Record<string, unknown>[] {
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as Record<string, unknown>)
    : []
}

const BASE = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--session-id',
  '00000000-0000-4000-8000-000000000001',
]

describe('the resident path: no detail, no ask', () => {
  test('frames are the turn port’s, stream events only feed the watchdog', async () => {
    const opened = open([...BASE, '--include-partial-messages'], {
      detail: false,
    })
    const result = await turn(opened, 'hello')
    expect(result).toMatchObject({ type: 'prompt_result', status: 'completed' })
    const kinds = opened.frames.map(frame =>
      frame.type === 'runtime_status'
        ? `status:${String(frame.subtype)}`
        : frame.type,
    )
    expect(new Set(kinds)).toEqual(
      new Set([
        'message_end',
        'status:init',
        'status:stream_event',
        'prompt_result',
      ]),
    )
    const said = opened.frames.filter(
      frame =>
        frame.type === 'message_end' &&
        (frame.message as { role: string }).role === 'assistant',
    )
    expect(said.map(frame => frame.message)).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'echo(1): hello' }],
      },
      {
        role: 'assistant',
        content: [],
        usage: { input: 10, output: 5, cacheRead: 900, cacheWrite: 20 },
        stopReason: 'end_turn',
      },
    ])
  })

  test('a question nobody can answer is denied, and the turn goes on', async () => {
    const opened = open([...BASE, '--permission-prompt-tool', 'stdio'])
    const result = await turn(opened, 'edit notes.md')
    expect(result.status).toBe('completed')
    expect(fs.existsSync(path.join(opened.cwd, 'notes.md'))).toBe(false)
    expect(lines(path.join(opened.state, 'answers.ndjson'))).toEqual([
      {
        subtype: 'success',
        request_id: 'ask-1',
        response: {
          behavior: 'deny',
          message: 'Nobody here answers permission questions.',
        },
      },
    ])
  })
})

describe('details', () => {
  test('text as it is written, the whole message, thinking and the mode', async () => {
    const opened = open([
      ...BASE,
      '--include-partial-messages',
      '--permission-mode',
      'acceptEdits',
    ])
    await turn(opened, 'think')
    const deltas = opened.details
      .filter(detail => detail.kind === 'text-delta')
      .map(detail => (detail.kind === 'text-delta' ? detail.text : ''))
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.join('')).toBe('echo(1): think')
    expect(opened.details).toContainEqual({
      kind: 'message',
      text: 'echo(1): think',
    })
    expect(
      opened.details
        .filter(detail => detail.kind === 'thinking')
        .map(detail => (detail.kind === 'thinking' ? detail.text : ''))
        .join(''),
    ).toBe('let me see')
    expect(opened.details[0]).toEqual({
      kind: 'mode',
      permissionMode: 'acceptEdits',
      model: 'fake',
      sessionId: '00000000-0000-4000-8000-000000000001',
    })
  })

  test('tools with their whole input and result text; a sub-agent is marked', async () => {
    const opened = open([...BASE, '--permission-mode', 'acceptEdits'])
    await turn(opened, 'edit a.txt')
    const tools = opened.details.filter(detail => detail.kind === 'tool')
    expect(tools).toEqual([
      {
        kind: 'tool',
        phase: 'start',
        id: expect.any(String),
        name: 'Write',
        input: {
          file_path: path.join(opened.cwd, 'a.txt'),
          content: 'created by fake\n',
        },
      },
      {
        kind: 'tool',
        phase: 'end',
        id: expect.any(String),
        name: 'Write',
        isError: false,
        output: `File created successfully at: ${path.join(opened.cwd, 'a.txt')}`,
      },
    ])
    // The turn port still sees its own lower-case names.
    expect(
      opened.frames
        .filter(frame => frame.type === 'tool_execution_start')
        .map(frame => frame.toolName),
    ).toEqual(['write'])
    await turn(opened, 'sub')
    expect(opened.details).toContainEqual({
      kind: 'message',
      text: 'a sub-agent speaks',
      parent: 'tool-parent',
    })
  })
})

describe('questions', () => {
  const ASKING = [...BASE, '--permission-prompt-tool', 'stdio']

  test('allow once: the original input back, no permission kept', async () => {
    const opened = open(ASKING, { ask: async () => 'once' })
    expect((await turn(opened, 'edit a.txt')).status).toBe('completed')
    expect(fs.readFileSync(path.join(opened.cwd, 'a.txt'), 'utf8')).toBe(
      'created by fake\n',
    )
    expect(opened.asks).toHaveLength(1)
    expect(opened.asks[0]).toMatchObject({
      requestId: 'ask-1',
      toolName: 'Write',
      input: { file_path: path.join(opened.cwd, 'a.txt') },
      toolUseId: expect.any(String),
      description: `Write ${path.join(opened.cwd, 'a.txt')}`,
    })
    expect(opened.asks[0]!.suggestions).toHaveLength(2)
    expect(lines(path.join(opened.state, 'answers.ndjson'))).toEqual([
      {
        subtype: 'success',
        request_id: 'ask-1',
        response: {
          behavior: 'allow',
          updatedInput: {
            file_path: path.join(opened.cwd, 'a.txt'),
            content: 'created by fake\n',
          },
        },
      },
    ])
  })

  test('allow for the session: its suggestions, every one kept to the session', async () => {
    const opened = open(ASKING, { ask: async () => 'session' })
    await turn(opened, 'bash ls')
    const [answer] = lines(path.join(opened.state, 'answers.ndjson'))
    const response = (answer!.response ?? {}) as Record<string, unknown>
    expect(response.behavior).toBe('allow')
    expect(response.updatedPermissions).toEqual([
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash' }],
        behavior: 'allow',
        destination: 'session',
      },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ])
  })

  test('deny, with a sentence for the agent', async () => {
    const opened = open(ASKING, {
      ask: async () => ({ decision: 'deny', message: '先别改' }),
    })
    await turn(opened, 'edit a.txt')
    expect(fs.existsSync(path.join(opened.cwd, 'a.txt'))).toBe(false)
    expect(opened.details).toContainEqual(
      expect.objectContaining({
        kind: 'tool',
        phase: 'end',
        isError: true,
        output: '先别改',
      }),
    )
  })

  test('a failing ask denies', async () => {
    const opened = open(ASKING, {
      ask: async () => {
        throw new Error('no')
      },
    })
    await turn(opened, 'edit a.txt')
    expect(
      lines(path.join(opened.state, 'answers.ndjson')).map(
        one => (one.response as Record<string, unknown>).behavior,
      ),
    ).toEqual(['deny'])
  })

  test('stopping the turn denies what is still asked, and a late answer is dropped', async () => {
    let later: (answer: ClaudeAskAnswer) => void = () => {}
    const opened = open(ASKING, {
      ask: () =>
        new Promise<ClaudeAskAnswer>(resolve => {
          later = resolve
        }),
    })
    await opened.channel.initialize()
    const { promise, resolve } = Promise.withResolvers<HarnessFrame>()
    opened.channel.onFrame(frame => {
      if (frame.type === 'prompt_result') resolve(frame)
    })
    await opened.channel.prompt({ messageId: 'm', text: 'edit a.txt' })
    while (opened.asks.length === 0) await Bun.sleep(10)
    await opened.channel.abort()
    expect(opened.asks[0]!.signal.aborted).toBe(true)
    expect((await promise).status).toBe('aborted')
    later('once')
    await Bun.sleep(50)
    expect(
      lines(path.join(opened.state, 'answers.ndjson')).map(one => one.response),
    ).toEqual([
      {
        behavior: 'deny',
        message: 'The turn was stopped before this was answered.',
      },
    ])
    expect(fs.existsSync(path.join(opened.cwd, 'a.txt'))).toBe(false)
  })
})

describe('control requests of ours', () => {
  test('set_permission_mode is answered by its id; a refusal rejects', async () => {
    const opened = open(BASE, { env: { FAKE_CLAUDE_NO_AUTO: '1' } })
    await opened.channel.initialize()
    await opened.channel.setPermissionMode('acceptEdits')
    await expect(opened.channel.setPermissionMode('auto')).rejects.toThrow(
      'gate not enabled',
    )
    expect(lines(path.join(opened.state, 'control.ndjson'))).toEqual([
      { subtype: 'set_permission_mode', mode: 'acceptEdits' },
      { subtype: 'set_permission_mode', mode: 'auto' },
    ])
  })

  test('an interrupt’s answer is taken; the turn ends aborted as before', async () => {
    const opened = open(BASE)
    await opened.channel.initialize()
    const { promise, resolve } = Promise.withResolvers<HarnessFrame>()
    opened.channel.onFrame(frame => {
      if (frame.type === 'prompt_result') resolve(frame)
    })
    await opened.channel.prompt({ messageId: 'm', text: 'hang' })
    await Bun.sleep(100)
    await opened.channel.abort()
    expect((await promise).status).toBe('aborted')
    // The process is still there for the next turn.
    expect(opened.channel.alive).toBe(true)
    expect((await turn(opened, 'again')).status).toBe('completed')
  })

  test('a closed process rejects what waits on it', async () => {
    const opened = open(BASE)
    await opened.channel.initialize()
    opened.child.kill('SIGKILL')
    await opened.channel.closed.catch(() => {})
    await expect(opened.channel.setPermissionMode('default')).rejects.toThrow(
      'closed',
    )
  })
})
