// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Codex channel on the fake app-server (`fake-codex-app-server.runner.ts`,
 * grown from the node's): the frames the resident's turn port reads, the
 * thread's params from the caller, and what the desktop app's runner adds —
 * details, the three answers to an approval, a turn's own policy. No real
 * Codex is started.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type CodexAsk,
  type CodexAskDecision,
  CodexChannel,
  type CodexChannelOptions,
  type CodexDetail,
} from '../src/codexRpc.ts'
import type { HarnessFrame } from '../src/process.ts'

const FAKE = path.join(
  import.meta.dir,
  'fixtures',
  'fake-codex-app-server.runner.ts',
)

const roots: string[] = []
const channels: CodexChannel[] = []
afterEach(async () => {
  for (const channel of channels.splice(0)) await channel.stop(true)
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

function folder(): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'harness-codex-')),
  )
  roots.push(root)
  return root
}

interface Opened {
  readonly channel: CodexChannel
  readonly child: ChildProcess
  readonly frames: HarnessFrame[]
  readonly details: CodexDetail[]
  readonly asks: CodexAsk[]
  readonly threads: string[]
  readonly state: string
  readonly cwd: string
}

function open(
  options: {
    readonly ask?: (request: CodexAsk) => Promise<CodexAskDecision>
    readonly thread?: CodexChannelOptions['thread']
    readonly threadId?: string
    readonly detail?: boolean
    readonly env?: Record<string, string>
    readonly cwd?: string
    readonly state?: string
  } = {},
): Opened {
  const cwd = options.cwd ?? folder()
  const state = options.state ?? path.join(cwd, '.state')
  fs.mkdirSync(state, { recursive: true })
  const child = spawn(process.execPath, [FAKE, 'app-server'], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      FAKE_CODEX_STATE: state,
      ...options.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const details: CodexDetail[] = []
  const asks: CodexAsk[] = []
  const threads: string[] = []
  const ask = options.ask
  const channel = new CodexChannel(child, {
    thread:
      options.thread ??
      (async () => ({
        cwd,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      })),
    ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
    onThread: id => threads.push(id),
    ...(options.detail === false
      ? {}
      : { onDetail: (detail: CodexDetail) => details.push(detail) }),
    ...(ask === undefined
      ? {}
      : {
          ask: (request: CodexAsk) => {
            asks.push(request)
            return ask(request)
          },
        }),
  })
  channels.push(channel)
  const frames: HarnessFrame[] = []
  channel.onFrame(frame => frames.push(frame))
  return { channel, child, frames, details, asks, threads, state, cwd }
}

/** Runs one turn and resolves with its `prompt_result`. */
async function turn(
  opened: Opened,
  text: string,
  policy: {
    readonly approvalPolicy?: string
    readonly sandboxPolicy?: Record<string, unknown>
  } = {},
): Promise<HarnessFrame> {
  if (opened.channel.threadId === undefined) await opened.channel.initialize()
  const { promise, resolve } = Promise.withResolvers<HarnessFrame>()
  const off = opened.channel.onFrame(frame => {
    if (frame.type === 'prompt_result') resolve(frame)
  })
  await opened.channel.prompt({ messageId: 'm1', text, ...policy })
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

function requests(opened: Opened, method: string): Record<string, unknown>[] {
  return lines(path.join(opened.state, 'requests.ndjson'))
    .filter(one => one.method === method)
    .map(one => one.params as Record<string, unknown>)
}

describe('the resident path: no detail', () => {
  test('frames are the turn port’s; the thread’s params come from the caller', async () => {
    let asked: unknown
    const opened = open({
      detail: false,
      thread: async request => {
        // The caller may ask the app-server first (the resident lists its
        // native items).
        asked = await request('skills/list', { cwds: ['/'] })
        return {
          cwd: '/somewhere',
          approvalPolicy: 'on-request',
          sandbox: 'read-only',
          approvalsReviewer: 'user',
        }
      },
      ask: async () => 'once',
    })
    const result = await turn(opened, 'bash ls')
    expect(result).toMatchObject({ type: 'prompt_result', status: 'completed' })
    expect(asked).toEqual({ data: [] })
    expect(requests(opened, 'thread/start')).toEqual([
      {
        cwd: '/somewhere',
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
        approvalsReviewer: 'user',
      },
    ])
    // No policy of the turn's own: none in turn/start.
    expect(Object.keys(requests(opened, 'turn/start')[0]!).sort()).toEqual([
      'clientUserMessageId',
      'input',
      'threadId',
    ])
    const kinds = opened.frames
      .filter(frame => frame.type !== 'runtime_status')
      .map(frame =>
        frame.type.startsWith('tool_execution')
          ? `${frame.type}:${String(frame.toolName)}`
          : frame.type,
      )
    expect(kinds).toEqual([
      'message_end',
      'tool_execution_start:bash',
      'tool_execution_end:bash',
      'message_end',
      'message_end',
      'prompt_result',
    ])
    // Deltas and the turn's diff only feed the watchdog.
    expect(
      opened.frames
        .filter(frame => frame.type === 'runtime_status')
        .map(frame => frame.subtype),
    ).toContain('item/agentMessage/delta')
    expect(opened.threads).toEqual([expect.stringMatching(/^thread-/)])
  })

  test('a thread is resumed with the same params; one that is gone starts anew', async () => {
    const first = open()
    await turn(first, 'one')
    const id = first.channel.threadId!
    await first.channel.stop()
    const again = open({ cwd: first.cwd, state: first.state, threadId: id })
    expect((await turn(again, 'two')).status).toBe('completed')
    expect(again.threads).toEqual([id])
    expect(requests(again, 'thread/resume')).toEqual([
      {
        cwd: first.cwd,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        threadId: id,
      },
    ])
    expect(again.details).toContainEqual(
      expect.objectContaining({ kind: 'message', text: 'codex(2): two' }),
    )
    const gone = open({ threadId: 'thread-gone' })
    await turn(gone, 'three')
    expect(gone.threads).toEqual([expect.not.stringMatching(/thread-gone/)])
  })

  test('without `ask` every approval is declined', async () => {
    const opened = open({
      thread: async () => ({ approvalPolicy: 'untrusted' }),
    })
    await turn(opened, 'edit a.txt')
    expect(fs.existsSync(path.join(opened.cwd, 'a.txt'))).toBe(false)
    expect(lines(path.join(opened.state, 'answers.ndjson'))).toEqual([
      {
        method: 'item/fileChange/requestApproval',
        result: { decision: 'decline' },
      },
    ])
  })
})

describe('details', () => {
  test('text as it comes, the whole message, thinking; a command with its output', async () => {
    const opened = open()
    await turn(opened, 'think')
    const deltas = opened.details.filter(one => one.kind === 'text-delta')
    expect(
      deltas.map(one => (one.kind === 'text-delta' ? one.text : '')),
    ).toEqual(['codex(1): think'])
    const message = opened.details.find(one => one.kind === 'message')
    expect(message).toEqual({
      kind: 'message',
      item: deltas[0]!.kind === 'text-delta' ? deltas[0]!.item : '',
      text: 'codex(1): think',
    })
    expect(
      opened.details
        .filter(one => one.kind === 'thinking')
        .map(one => (one.kind === 'thinking' ? one.text : ''))
        .join(''),
    ).toBe('Looking around')
    const before = opened.details.length
    await turn(opened, 'bash ls -la')
    expect(
      opened.details
        .slice(before)
        .filter(one => one.kind === 'tool' || one.kind === 'tool-output'),
    ).toEqual([
      {
        kind: 'tool',
        phase: 'start',
        id: 'cmd-2',
        item: {
          type: 'commandExecution',
          id: 'cmd-2',
          command: 'ls -la',
          cwd: opened.cwd,
          status: 'inProgress',
        },
      },
      { kind: 'tool-output', id: 'cmd-2', text: 'out 1\n' },
      { kind: 'tool-output', id: 'cmd-2', text: 'out 2\n' },
      {
        kind: 'tool',
        phase: 'end',
        id: 'cmd-2',
        item: expect.objectContaining({
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: 'out 1\nout 2\n',
        }),
      },
    ])
  })

  test('an edit: the file change with its content, then the turn’s diff', async () => {
    const opened = open()
    await turn(opened, 'edit notes.md')
    const file = path.join(opened.cwd, 'notes.md')
    expect(fs.readFileSync(file, 'utf8')).toBe('written by fake codex\n')
    const start = opened.details.find(
      one => one.kind === 'tool' && one.phase === 'start',
    )
    expect(start).toMatchObject({
      id: 'patch-1',
      item: {
        type: 'fileChange',
        changes: [
          {
            path: file,
            kind: { type: 'add' },
            diff: 'written by fake codex\n',
          },
        ],
      },
    })
    expect(opened.details).toContainEqual({
      kind: 'turn-diff',
      turn: 'turn-1',
      diff: expect.stringContaining('+++ b/notes.md'),
    })
  })

  test('a failed turn: its error as Codex gave it, its message on the frame', async () => {
    const opened = open()
    const result = await turn(opened, 'login')
    expect(result).toMatchObject({
      status: 'error',
      error: { message: 'unexpected status 401 Unauthorized: Missing bearer' },
    })
    expect(opened.details).toContainEqual({
      kind: 'turn-error',
      error: {
        message: 'unexpected status 401 Unauthorized: Missing bearer',
        codexErrorInfo: 'unauthorized',
      },
    })
  })
})

describe('approvals', () => {
  const UNTRUSTED = async () => ({
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
  })

  test('once is accept: the file change asked about, by its item', async () => {
    const opened = open({ thread: UNTRUSTED, ask: async () => 'once' })
    await turn(opened, 'edit a.txt')
    expect(fs.existsSync(path.join(opened.cwd, 'a.txt'))).toBe(true)
    expect(opened.asks).toHaveLength(1)
    expect(opened.asks[0]).toMatchObject({
      kind: 'file-change',
      toolName: 'edit',
      itemId: 'patch-1',
      options: ['once', 'session', 'deny'],
      params: { itemId: 'patch-1', turnId: 'turn-1' },
    })
    expect(lines(path.join(opened.state, 'answers.ndjson'))).toEqual([
      {
        method: 'item/fileChange/requestApproval',
        result: { decision: 'accept' },
      },
    ])
    // The item started before its approval, as the app-server does.
    const order = opened.details.findIndex(
      one => one.kind === 'tool' && one.phase === 'start',
    )
    expect(order).toBe(0)
  })

  test('session is acceptForSession; deny is decline; nothing else is ever sent', async () => {
    const answers: CodexAskDecision[] = ['session', 'deny']
    const opened = open({
      thread: UNTRUSTED,
      ask: async () => answers.shift() ?? 'deny',
    })
    await turn(opened, 'bash make')
    await turn(opened, 'bash make') // Allowed for the session: not asked.
    await turn(opened, 'edit b.txt')
    expect(fs.existsSync(path.join(opened.cwd, 'b.txt'))).toBe(false)
    expect(opened.asks.map(one => [one.kind, one.input])).toEqual([
      ['command', { command: 'make', cwd: opened.cwd }],
      ['file-change', {}],
    ])
    const sent = lines(path.join(opened.state, 'answers.ndjson'))
    expect(
      sent.map(one => (one.result as { decision: unknown }).decision),
    ).toEqual(['acceptForSession', 'decline'])
    // Never an amendment of the agent's own rules.
    expect(JSON.stringify(sent)).not.toMatch(/Amendment/)
  })

  test('no session answer where Codex lists none; one given anyway is accept', async () => {
    const opened = open({
      thread: UNTRUSTED,
      ask: async () => 'session',
      env: { FAKE_CODEX_NO_SESSION: '1' },
    })
    await turn(opened, 'bash make')
    expect(opened.asks[0]!.options).toEqual(['once', 'deny'])
    expect(lines(path.join(opened.state, 'answers.ndjson'))).toEqual([
      {
        method: 'item/commandExecution/requestApproval',
        result: { decision: 'accept' },
      },
    ])
  })

  test('an MCP tool call asks once or not at all', async () => {
    const opened = open({ ask: async () => 'once' })
    await turn(opened, 'mcp')
    expect(opened.asks[0]).toMatchObject({
      kind: 'mcp-tool',
      toolName: 'mcp__docs__search',
      options: ['once', 'deny'],
    })
    expect(opened.details).toContainEqual(
      expect.objectContaining({ kind: 'message', text: 'mcp action=accept' }),
    )
  })

  test('withdrawn by Codex (the turn interrupted): the question’s signal is aborted', async () => {
    let signal: AbortSignal | undefined
    const opened = open({
      ask: request => {
        signal = request.signal
        return new Promise<CodexAskDecision>(resolve =>
          request.signal.addEventListener('abort', () => resolve('deny')),
        )
      },
    })
    await opened.channel.initialize()
    const { promise, resolve } = Promise.withResolvers<HarnessFrame>()
    opened.channel.onFrame(frame => {
      if (frame.type === 'prompt_result') resolve(frame)
    })
    await opened.channel.prompt({ messageId: 'm1', text: 'wait-ask' })
    for (let i = 0; i < 200 && signal === undefined; i++) await Bun.sleep(10)
    expect(signal?.aborted).toBe(false)
    await opened.channel.abort()
    expect((await promise).status).toBe('aborted')
    expect(signal?.aborted).toBe(true)
  })
})

describe('a turn’s own policy', () => {
  test('approvalPolicy and sandboxPolicy go in turn/start, and hold from that turn on', async () => {
    const opened = open({ ask: async () => 'once' })
    await turn(opened, 'one')
    await turn(opened, 'two', {
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    })
    await turn(opened, 'three')
    const starts = requests(opened, 'turn/start')
    expect(starts[1]).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    })
    expect('approvalPolicy' in starts[2]!).toBe(false)
    expect(lines(path.join(opened.state, 'turns.ndjson'))).toEqual([
      expect.objectContaining({
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      }),
      expect.objectContaining({
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      }),
      expect.objectContaining({
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      }),
    ])
  })
})
