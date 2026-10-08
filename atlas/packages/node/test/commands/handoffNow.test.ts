// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What `now` takes of a session and when it refuses to start (P17.3 截断模式,
 * P17.4 本地命令): the three callers of a transcript whose last turn runs,
 * the session the caller names, and the one-handoff-at-a-time lock. Files go
 * to a throwaway `OCC_CONFIG_DIR` and `QMCODE_HOME`; git is real.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type HandoffCaller, runNow, sessionSnapshot } from '../handoffNow.js'
import {
  HandoffUserError,
  recordSession,
  saveProject,
  stateDir,
} from '../handoffStore.js'
import {
  claudeCodeMidTurnTranscript,
  qmcodeRollout,
  qmcodeRolloutPath,
} from './support/handoffSamples.js'

const THREAD = '0199a4c2-7c1e-7d32-9a5e-3b1f2c4d5e6f'
const OTHER_THREAD = '0199a4c2-7c1e-7d32-9a5e-3b1f2c4d5e70'
const TURN_1 = '0199a4c2-8000-7000-8000-000000000001'
const TURN_2 = '0199a4c2-8000-7000-8000-000000000002'
const CC_SESSION = '7d8c2a10-3c55-4b2e-9a51-0f6c1d2e3a4b'

const saved = {
  config: process.env.OCC_CONFIG_DIR,
  qmcode: process.env.QMCODE_HOME,
}
const roots: string[] = []
let repo = ''
let qmHome = ''
let tokenFile = ''

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-handoff-now-'))
  roots.push(dir)
  return dir
}

function restore(name: 'OCC_CONFIG_DIR' | 'QMCODE_HOME', value?: string) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/** The MCP tool's caller: a thread named by `_meta`, never a shell of it. */
const fromTool = (thread?: string): HandoffCaller => ({
  thread,
  inThreadShell: false,
})

beforeAll(async () => {
  const root = tempDir()
  process.env.OCC_CONFIG_DIR = join(root, 'config')
  qmHome = join(root, 'qmcode-home')
  process.env.QMCODE_HOME = qmHome
  repo = join(root, 'work', 'atlas')
  mkdirSync(join(repo, 'packages', 'deep'), { recursive: true })
  const init = Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo])
  expect(init.exitCode).toBe(0)
  // The key `init` records is git's top level, symlinks resolved (/var → /private/var).
  repo = realpathSync(repo)
  tokenFile = join(root, 'token')
  writeFileSync(tokenFile, 'qm-test-token\n', { mode: 0o600 })
  await saveProject({
    root: repo,
    project: 'atlas',
    device: 'laptop',
    hub: { kind: 'local', root: join(root, 'hub') },
    console: 'http://127.0.0.1:9',
    tokenFile,
  })
})

afterAll(() => {
  restore('OCC_CONFIG_DIR', saved.config)
  restore('QMCODE_HOME', saved.qmcode)
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function writeRollout(thread: string, text: string): string {
  const file = qmcodeRolloutPath(qmHome, thread)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}

describe('sessionSnapshot while a turn runs', () => {
  test('qmcode, the tool called inside a model turn: cut before that turn; without the cut, refused', async () => {
    const complete = qmcodeRollout(THREAD, repo, [
      { turnId: TURN_1, user: 'q1', assistant: 'a1' },
    ])
    const file = writeRollout(
      THREAD,
      qmcodeRollout(THREAD, repo, [
        { turnId: TURN_1, user: 'q1', assistant: 'a1' },
        { turnId: TURN_2, user: '交给云端', assistant: '', ending: 'calling' },
      ]),
    )
    await recordSession({
      cwd: repo,
      tool: 'qmcode',
      sessionId: THREAD,
      file,
      at: Date.now(),
    })

    const cut = sessionSnapshot(repo, repo, 'cut', fromTool())
    expect(cut.content.toString('utf8')).toBe(complete)
    expect(cut.omitted).toEqual({ turnId: TURN_2, lines: 5 })

    // The same call without the cut never gets past the turn it is part of.
    expect(() => sessionSnapshot(repo, repo, 'refuse', fromTool())).toThrow(
      `回合进行中（${TURN_2}）`,
    )
  })

  test('Claude Code, the tool called inside a turn: cut after the last complete turn; without the cut, the half turn goes along', async () => {
    const dir = tempDir()
    const { text, complete, running } = claudeCodeMidTurnTranscript(
      CC_SESSION,
      repo,
    )
    const file = join(dir, `${CC_SESSION}.jsonl`)
    writeFileSync(file, text)
    await recordSession({
      cwd: repo,
      tool: 'claude-code',
      sessionId: CC_SESSION,
      file,
      at: Date.now(),
    })

    const cut = sessionSnapshot(repo, repo, 'cut', fromTool())
    expect(cut.tool).toBe('claude-code')
    expect(cut.content.toString('utf8')).toBe(complete)
    expect(cut.content.toString('utf8')).not.toContain(running)
    // The prompt, a subagent's record, thinking and the tool call.
    expect(cut.omitted).toEqual({ turnId: null, lines: 4 })

    const uncut = sessionSnapshot(repo, repo, 'refuse', fromTool())
    expect(uncut.content.toString('utf8')).toContain(running)
    expect(uncut.omitted).toBeNull()
  })

  test("the thread the tool call names wins over the directory's last report", () => {
    // sessions.json now names the Claude Code session (the test above); the
    // tool call says which qmcode thread it comes from.
    const cut = sessionSnapshot(repo, repo, 'cut', fromTool(THREAD))
    expect(cut.tool).toBe('qmcode')
    expect(cut.sessionId).toBe(THREAD)
    // A thread that never wrote a rollout falls back to the directory.
    const fallback = sessionSnapshot(repo, repo, 'cut', fromTool(OTHER_THREAD))
    expect(fallback.sessionId).toBe(CC_SESSION)
  })

  test('from a subdirectory: the latest report in the repository', () => {
    const deep = join(repo, 'packages', 'deep')
    const cut = sessionSnapshot(deep, repo, 'cut', fromTool())
    expect(cut.sessionId).toBe(CC_SESSION)
  })

  test('nothing reported for the repository: a reason, not a crash', () => {
    const other = join(tempDir(), 'elsewhere')
    mkdirSync(other)
    let caught: unknown
    try {
      sessionSnapshot(other, other, 'cut', fromTool())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(HandoffUserError)
    expect((caught as HandoffUserError).message).toContain(
      '找不到这个目录的会话记录',
    )
  })

  test('a Claude Code session with no turn ended yet: nothing to hand over', async () => {
    const dir = tempDir()
    const file = join(dir, 'fresh.jsonl')
    const { text, complete } = claudeCodeMidTurnTranscript('fresh', repo)
    // Only the running turn: what a first prompt of "交给云端" leaves.
    writeFileSync(file, text.slice(complete.length))
    const sub = join(repo, 'packages')
    await recordSession({
      cwd: sub,
      tool: 'claude-code',
      sessionId: 'fresh',
      file,
      at: Date.now(),
    })
    expect(() => sessionSnapshot(sub, repo, 'cut', fromTool())).toThrow(
      '会话里还没有一个完整的回合',
    )
  })
})

describe('runNow: one handoff at a time', () => {
  test('a second handoff while one holds the lock is told so and does nothing', async () => {
    const lock = join(stateDir(repo), 'now.lock')
    mkdirSync(dirname(lock), { recursive: true })
    // A live holder: this test process.
    writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 })
    try {
      let caught: unknown
      try {
        await runNow(
          repo,
          { goal: 'g' },
          { out() {}, err() {} },
          { whileRunning: 'cut', caller: fromTool() },
        )
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(HandoffUserError)
      expect((caught as HandoffUserError).message).toBe(
        `另一份转交正在进行（pid ${process.pid}）：等它结束再试`,
      )
      // Refused before anything was synced: no sync state for the repository.
      expect(
        Bun.spawnSync(['ls', stateDir(repo)])
          .stdout.toString()
          .trim(),
      ).toBe('now.lock')
    } finally {
      rmSync(lock, { force: true })
    }
  })
})
