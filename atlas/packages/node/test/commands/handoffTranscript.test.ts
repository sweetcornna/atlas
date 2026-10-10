// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Hook inputs, rollout lookup and turn completeness (P17.4 同步规则,
 * handoff-probe-p17.md 第 7 项).
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  claudeCodeCompleteEnd,
  claudeCodeTurnEnd,
  findQmcodeRollout,
  lastNewlineEnd,
  parseClaudeCodeHookInput,
  parseQmcodeNotify,
  qmcodeSnapshot,
  qmcodeTurnEnd,
  waitForTurnEnd,
} from '../../src/commands/handoffTranscript.js'
import {
  claudeCodeHookInput,
  claudeCodeMidTurnTranscript,
  claudeCodeTranscript,
  qmcodeNotify,
  qmcodeRollout,
} from './support/handoffSamples.js'

const roots: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-handoff-transcript-'))
  roots.push(dir)
  return dir
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const THREAD = '0199a4c2-7c1e-7d32-9a5e-3b1f2c4d5e6f'
const TURN_1 = '0199a4c2-8000-7000-8000-000000000001'
const TURN_2 = '0199a4c2-8000-7000-8000-000000000002'
const CC_SESSION = '7d8c2a10-3c55-4b2e-9a51-0f6c1d2e3a4b'

describe('parseQmcodeNotify', () => {
  test('reads the ids and cwd of a real-shaped payload and nothing else', () => {
    const notify = parseQmcodeNotify(
      qmcodeNotify(THREAD, TURN_1, '/work/atlas'),
    )
    expect(notify).toEqual({
      threadId: THREAD,
      turnId: TURN_1,
      cwd: '/work/atlas',
    })
  })

  test('`client` absent and `last-assistant-message` null are the same turn end', () => {
    const payload = qmcodeNotify(THREAD, TURN_1, '/work/atlas', {
      client: null,
      last: null,
    })
    expect(Object.keys(JSON.parse(payload))).toEqual([
      'type',
      'thread-id',
      'turn-id',
      'cwd',
      'input-messages',
      'last-assistant-message',
    ])
    expect(parseQmcodeNotify(payload)).toEqual({
      threadId: THREAD,
      turnId: TURN_1,
      cwd: '/work/atlas',
    })
  })

  test('another notification type is not a turn end', () => {
    expect(
      parseQmcodeNotify(JSON.stringify({ type: 'approval-requested' })),
    ).toBeNull()
  })

  test('malformed or incomplete payloads are refused', () => {
    expect(() => parseQmcodeNotify('not json')).toThrow('不是 JSON')
    expect(() => parseQmcodeNotify('[1]')).toThrow('不是 JSON 对象')
    expect(() =>
      parseQmcodeNotify(
        JSON.stringify({ type: 'agent-turn-complete', 'thread-id': THREAD }),
      ),
    ).toThrow('thread-id / turn-id / cwd')
    expect(() =>
      parseQmcodeNotify(qmcodeNotify(THREAD, TURN_1, 'relative/dir')),
    ).toThrow('cwd 须是绝对路径')
  })
})

describe('parseClaudeCodeHookInput', () => {
  test('Stop and SessionEnd inputs give the session, transcript, cwd and event', () => {
    expect(
      parseClaudeCodeHookInput(
        claudeCodeHookInput(
          CC_SESSION,
          '/h/.claude/projects/x/s.jsonl',
          '/work/atlas',
        ),
      ),
    ).toEqual({
      sessionId: CC_SESSION,
      transcriptPath: '/h/.claude/projects/x/s.jsonl',
      cwd: '/work/atlas',
      event: 'Stop',
    })
    expect(
      parseClaudeCodeHookInput(
        claudeCodeHookInput(CC_SESSION, '/t.jsonl', '/w', 'SessionEnd'),
      ).event,
    ).toBe('SessionEnd')
  })

  test('missing fields and relative paths are refused', () => {
    expect(() => parseClaudeCodeHookInput('')).toThrow('不是 JSON')
    expect(() =>
      parseClaudeCodeHookInput(JSON.stringify({ session_id: CC_SESSION })),
    ).toThrow('session_id / transcript_path / cwd')
    expect(() =>
      parseClaudeCodeHookInput(
        claudeCodeHookInput(CC_SESSION, 't.jsonl', '/w'),
      ),
    ).toThrow('绝对路径')
  })
})

describe('findQmcodeRollout', () => {
  test('finds the plain and the reverted file name, newest day first', () => {
    const home = tempDir()
    const older = join(
      home,
      'sessions/2026/10/02',
      `rollout-2026-10-02T23-59-00-${THREAD}.jsonl`,
    )
    const newer = join(
      home,
      'sessions/2026/10/03',
      `rollout-2026-10-03T08-00-00-${THREAD}_0199a4c2-9999-7000-8000-00000000abcd.jsonl`,
    )
    for (const file of [older, newer]) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, '{}\n')
    }
    // Compressed archives are never a live session.
    writeFileSync(
      join(
        home,
        'sessions/2026/10/03',
        `rollout-2026-10-03T07-00-00-${THREAD}.jsonl.zst`,
      ),
      'x',
    )
    expect(findQmcodeRollout(home, THREAD)).toBe(newer)
    rmSync(newer)
    expect(findQmcodeRollout(home, THREAD)).toBe(older)
  })

  test('two rollouts of one thread on one day: the most recently written wins', () => {
    const home = tempDir()
    const day = join(home, 'sessions/2026/10/03')
    mkdirSync(day, { recursive: true })
    const a = join(day, `rollout-2026-10-03T08-00-00-${THREAD}.jsonl`)
    const b = join(
      day,
      `rollout-2026-10-03T09-00-00-${THREAD}_0199a4c2-9999-7000-8000-00000000abcd.jsonl`,
    )
    writeFileSync(a, '{}\n')
    writeFileSync(b, '{}\n')
    utimesSync(b, new Date(2026, 0, 1), new Date(2026, 0, 1))
    expect(findQmcodeRollout(home, THREAD)).toBe(a)
  })

  test('a thread that never wrote a rollout (the TUI title thread) is null', () => {
    const home = tempDir()
    expect(findQmcodeRollout(home, THREAD)).toBeNull()
    mkdirSync(join(home, 'sessions/2026/10/03'), { recursive: true })
    expect(findQmcodeRollout(home, 'another-thread')).toBeNull()
  })
})

describe('qmcodeTurnEnd', () => {
  const cwd = '/work/atlas'

  test("the cut is the end of the turn's task_complete line", () => {
    const text = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
    ])
    const content = Buffer.from(text)
    expect(qmcodeTurnEnd(content, TURN_1)).toBe(content.length)
  })

  test("a later turn's bytes are not taken for an earlier turn", () => {
    const first = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
    ])
    const both = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
      { turnId: TURN_2, user: 'q2', assistant: 'a2', ending: 'open' },
    ])
    expect(qmcodeTurnEnd(Buffer.from(both), TURN_1)).toBe(
      Buffer.byteLength(first),
    )
  })

  test("an open turn, another turn's end, or a half-written end line is not complete", () => {
    const open = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
      { turnId: TURN_2, user: 'q2', assistant: 'a2', ending: 'open' },
    ])
    expect(qmcodeTurnEnd(Buffer.from(open), TURN_2)).toBeNull()
    const whole = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
    ])
    expect(qmcodeTurnEnd(Buffer.from(whole), TURN_2)).toBeNull()
    const half = Buffer.from(whole.slice(0, whole.length - 1))
    expect(qmcodeTurnEnd(half, TURN_1)).toBeNull()
  })

  test('an aborted turn is complete too', () => {
    const text = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1', ending: 'aborted' },
    ])
    expect(qmcodeTurnEnd(Buffer.from(text), TURN_1)).toBe(
      Buffer.byteLength(text),
    )
  })
})

describe('qmcodeSnapshot (what `now` may take)', () => {
  const cwd = '/work/atlas'

  test('all turns closed: everything up to the last newline', () => {
    const text = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
    ])
    expect(qmcodeSnapshot(Buffer.from(`${text}{"partial`))).toEqual({
      open: false,
      end: Buffer.byteLength(text),
    })
  })

  test('a model turn still running is open, with the complete part before it', () => {
    const first = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
    ])
    const text = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
      { turnId: TURN_2, user: 'q2', assistant: 'a2', ending: 'open' },
    ])
    expect(qmcodeSnapshot(Buffer.from(text))).toEqual({
      open: true,
      turnId: TURN_2,
      before: Buffer.byteLength(first),
    })
  })

  // `/handoff` in qmcode runs `qm handoff now` as a standalone shell turn;
  // while it runs the rollout ends on that turn's `task_started`.
  const SHELL_TURN = '0199a4c2-8000-7000-8000-00000000000a'
  const handoff = { turnId: SHELL_TURN, shell: 'qm handoff now' } as const

  test("from the thread's own /handoff: the shell turn at the end is left out, not refused", () => {
    const first = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
    ])
    const text = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
      { ...handoff, ending: 'runs' },
    ])
    // The real shape: the file ends on the shell turn's task_started.
    expect(JSON.parse(text.trimEnd().split('\n').at(-1) ?? '')).toMatchObject({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: SHELL_TURN },
    })
    expect(qmcodeSnapshot(Buffer.from(text), true)).toEqual({
      open: false,
      end: Buffer.byteLength(first),
      skipped: SHELL_TURN,
    })
  })

  test("from the thread's own shell: a model turn at the end is still refused", () => {
    const first = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
    ])
    const text = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
      { turnId: TURN_2, user: 'q2', assistant: 'a2', ending: 'open' },
    ])
    expect(qmcodeSnapshot(Buffer.from(text), true)).toEqual({
      open: true,
      turnId: TURN_2,
      before: Buffer.byteLength(first),
    })
  })

  test("not from the thread's own shell: a bare task_started is a turn running", () => {
    const first = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
    ])
    // The same shell turn, judged from a terminal or another thread.
    const shell = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
      { ...handoff, ending: 'runs' },
    ])
    expect(qmcodeSnapshot(Buffer.from(shell))).toEqual({
      open: true,
      turnId: SHELL_TURN,
      before: Buffer.byteLength(first),
    })
    // A model turn waiting for MCP servers before its first turn_context.
    const starting = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
      { turnId: TURN_2, user: 'q2', assistant: 'a2', ending: 'starting' },
    ])
    expect(qmcodeSnapshot(Buffer.from(starting))).toEqual({
      open: true,
      turnId: TURN_2,
      before: Buffer.byteLength(first),
    })
  })

  test("from the thread's own shell: anything after the open task_started makes it not the caller's", () => {
    const first = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
    ])
    const shell = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
      { ...handoff, ending: 'runs' },
    ])
    const open = {
      open: true as const,
      turnId: SHELL_TURN,
      before: Buffer.byteLength(first),
    }
    const turnContext = `${JSON.stringify({
      timestamp: '2026-10-03T09:10:00.000Z',
      type: 'turn_context',
      payload: { turn_id: SHELL_TURN, cwd, model: 'gpt-6-luna' },
    })}\n`
    expect(qmcodeSnapshot(Buffer.from(shell + turnContext), true)).toEqual(open)
    // A line still being written counts as something after it.
    expect(qmcodeSnapshot(Buffer.from(`${shell}{"timestamp"`), true)).toEqual(
      open,
    )
  })

  test("from the thread's own shell: what precedes the shell turn is judged by the same rule", () => {
    // Earlier `!` commands are complete turns of their own.
    const done = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
      { turnId: TURN_2, shell: 'git status' },
    ])
    const text = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
      { turnId: TURN_2, shell: 'git status' },
      { ...handoff, ending: 'runs' },
    ])
    expect(qmcodeSnapshot(Buffer.from(text), true)).toEqual({
      open: false,
      end: Buffer.byteLength(done),
      skipped: SHELL_TURN,
    })
    // A turn left open before it (qmcode killed mid-turn) is still open.
    const first = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
    ])
    const stale = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
      { turnId: TURN_2, user: 'q2', assistant: 'a2', ending: 'open' },
      { ...handoff, ending: 'runs' },
    ])
    expect(qmcodeSnapshot(Buffer.from(stale), true)).toEqual({
      open: true,
      turnId: TURN_2,
      before: Buffer.byteLength(first),
    })
  })
})

describe('the handoff tool called inside a turn (P17.3 截断模式)', () => {
  const cwd = '/work/atlas'

  test('qmcode: the model turn that called the tool is open; the cut is its task_started', () => {
    const first = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
    ])
    const text = qmcodeRollout(THREAD, cwd, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
      { turnId: TURN_2, user: '交给云端', assistant: '', ending: 'calling' },
    ])
    // The real shape: turn_context, the prompt, then the tool call, last.
    const tail = text
      .slice(first.length)
      .trimEnd()
      .split('\n')
      .map(
        line => JSON.parse(line) as { type: string; payload: { type: string } },
      )
    expect(tail.map(record => record.type)).toEqual([
      'event_msg',
      'turn_context',
      'response_item',
      'event_msg',
      'response_item',
    ])
    expect(tail.at(-1)?.payload.type).toBe('function_call')
    // Whoever calls, and from wherever: open, with the complete part before it.
    for (const fromThreadShell of [false, true]) {
      expect(qmcodeSnapshot(Buffer.from(text), fromThreadShell)).toEqual({
        open: true,
        turnId: TURN_2,
        before: Buffer.byteLength(first),
      })
    }
  })

  test('Claude Code: cut after the last complete turn; the running one is left out', () => {
    const { text, complete, running } = claudeCodeMidTurnTranscript(
      CC_SESSION,
      cwd,
    )
    const bytes = Buffer.from(text)
    const end = claudeCodeCompleteEnd(bytes)
    expect(end).toBe(Buffer.byteLength(complete))
    const taken = bytes.subarray(0, end).toString('utf8')
    expect(taken).not.toContain(running)
    // The system record after the answer belongs to the complete turn.
    expect(taken.trimEnd().split('\n').at(-1)).toContain('stop_hook_summary')
    // Without the cut — the last newline — the running turn would go along.
    expect(bytes.subarray(0, lastNewlineEnd(bytes)).toString('utf8')).toContain(
      running,
    )
  })

  test('Claude Code: a turn the user interrupted is over; it is kept', () => {
    const { text, complete, running } = claudeCodeMidTurnTranscript(
      CC_SESSION,
      cwd,
      { interrupted: true },
    )
    expect(complete).toContain('[Request interrupted by user for tool use]')
    const bytes = Buffer.from(text)
    const end = claudeCodeCompleteEnd(bytes)
    expect(end).toBe(Buffer.byteLength(complete))
    expect(bytes.subarray(0, end).toString('utf8')).not.toContain(running)
  })

  test('Claude Code: an idle transcript is cut where the Stop hook cut it', () => {
    const text = claudeCodeTranscript(CC_SESSION, cwd, 'complete')
    expect(claudeCodeCompleteEnd(Buffer.from(`${text}{"type":"us`))).toBe(
      Buffer.byteLength(text),
    )
    expect(claudeCodeCompleteEnd(Buffer.from(text))).toBe(
      claudeCodeTurnEnd(Buffer.from(text), 'Stop') ?? -1,
    )
  })

  test('Claude Code: no turn has ended yet — nothing to take', () => {
    for (const ending of ['tool-use', 'tool-result'] as const) {
      expect(
        claudeCodeCompleteEnd(
          Buffer.from(claudeCodeTranscript(CC_SESSION, cwd, ending)),
        ),
      ).toBe(0)
    }
    expect(claudeCodeCompleteEnd(Buffer.alloc(0))).toBe(0)
  })

  test('Claude Code: a tool_use not yet given its stop_reason is not an end either', () => {
    const { text, complete } = claudeCodeMidTurnTranscript(CC_SESSION, cwd)
    const nulled = text.replaceAll(
      '"stop_reason":"tool_use"',
      '"stop_reason":null',
    )
    expect(claudeCodeCompleteEnd(Buffer.from(nulled))).toBe(
      Buffer.byteLength(
        complete.replaceAll('"stop_reason":"tool_use"', '"stop_reason":null'),
      ),
    )
  })
})

describe('claudeCodeTurnEnd', () => {
  const cwd = '/work/atlas'

  test('Stop after a final end_turn answer: complete up to the last newline', () => {
    const text = claudeCodeTranscript(CC_SESSION, cwd, 'complete')
    expect(claudeCodeTurnEnd(Buffer.from(text), 'Stop')).toBe(
      Buffer.byteLength(text),
    )
    expect(claudeCodeTurnEnd(Buffer.from(`${text}{"type":"assi`), 'Stop')).toBe(
      Buffer.byteLength(text),
    )
  })

  test('Stop with a pending tool_use, or before the answer is flushed: not complete', () => {
    expect(
      claudeCodeTurnEnd(
        Buffer.from(claudeCodeTranscript(CC_SESSION, cwd, 'tool-use')),
        'Stop',
      ),
    ).toBeNull()
    // The sidechain record after the tool result says end_turn; it is not the
    // main chain and does not count.
    expect(
      claudeCodeTurnEnd(
        Buffer.from(claudeCodeTranscript(CC_SESSION, cwd, 'tool-result')),
        'Stop',
      ),
    ).toBeNull()
  })

  test('SessionEnd is complete by definition; an empty file never is', () => {
    const text = claudeCodeTranscript(CC_SESSION, cwd, 'tool-use')
    expect(claudeCodeTurnEnd(Buffer.from(text), 'SessionEnd')).toBe(
      Buffer.byteLength(text),
    )
    expect(claudeCodeTurnEnd(Buffer.alloc(0), 'SessionEnd')).toBeNull()
  })
})

describe('waitForTurnEnd', () => {
  test('re-reads until the end line lands, within the window', async () => {
    const dir = tempDir()
    const file = join(dir, 'rollout.jsonl')
    const whole = qmcodeRollout(THREAD, '/w', [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
    ])
    const lines = whole.split('\n')
    const last = `${lines.at(-2) ?? ''}\n`
    writeFileSync(file, whole.slice(0, whole.length - last.length))
    setTimeout(() => appendFileSync(file, last), 60)
    const landed = await waitForTurnEnd(file, c => qmcodeTurnEnd(c, TURN_1), {
      intervalMs: 10,
      timeoutMs: 2_000,
    })
    expect(landed?.end).toBe(Buffer.byteLength(whole))
  })

  test('gives up after the window: the turn is reported incomplete', async () => {
    const dir = tempDir()
    const file = join(dir, 'rollout.jsonl')
    writeFileSync(
      file,
      qmcodeRollout(THREAD, '/w', [
        { turnId: TURN_1, user: 'q1', assistant: 'a1', ending: 'open' },
      ]),
    )
    const started = Date.now()
    const landed = await waitForTurnEnd(file, c => qmcodeTurnEnd(c, TURN_1), {
      intervalMs: 10,
      timeoutMs: 150,
    })
    expect(landed).toBeNull()
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
  })
})
