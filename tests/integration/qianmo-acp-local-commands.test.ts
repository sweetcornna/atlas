// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.20 (design `providers-console-m1.md` D-9): `/autocompact`, `/compact`
 * and `/context` in a node's ACP session, end to end.
 *
 * ## What is real
 *
 * The ACP child (`src/entrypoints/cli.tsx --acp` from source, shipped defines
 * and feature list, the production resident env, via `spawnResidentAcpChild`)
 * and the resident's own ACP client stack on its stdio
 * (`ResidentAcpConnection` + `AcpResidentTurnPort`), so a turn's `content` is
 * exactly what the resident would put in its `task.result`. The "terminal" the
 * echoes are compared with is the same CLI run as `-p`, in its own config dir.
 * No `mock.module`.
 *
 * ## What is not
 *
 * The model: a loopback `Bun.serve` that answers every streamed request with a
 * fixed text and a configurable `prompt_tokens`, and counts requests. The
 * prompt-token figure is what makes auto-compaction fire on demand: the next
 * turn's context estimate starts from the last reported usage.
 *
 * ## What the window numbers mean
 *
 * The double's model is unknown to the base, so its context window is the
 * 200k default. With 90k tokens of reported usage the auto-compact threshold
 * (window − reserved output − 13k buffer) is crossed at a 100k window and not
 * at 150k or at auto — so "compaction happened" is "the turn read 100k".
 *
 * Not covered here: the console chat page. The resident assembles every turn
 * into `<teammate-message>` blocks (`src/services/qianmo/residentPrompt.ts`)
 * before it reaches this child, so a slash command typed there does not arrive
 * as one; this file sends the command text the way a raw ACP client would.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import {
  AcpResidentTurnPort,
  ResidentAcpConnection,
  type ResidentTurnResult,
} from '@qianmo/resident'
import { getMacroDefines, resolveBuildFeatures } from '../../scripts/defines.js'
import {
  IDENTITY_ENV_VAR,
  NODE_IDENTITY_MODE,
} from '../../src/constants/identity.js'
import { spawnResidentAcpChild } from './fixtures/resident-acp-harness.js'

const PROJECT_ROOT = resolve(import.meta.dir, '../..')
const BOOT_TIMEOUT_MS = 90_000
const TURN_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = 180_000
const MODEL = 'acp-local-commands-double'
const MODEL_REPLY = 'MODEL-REPLY'
const COMPACTED = 'Compacting completed.'

/** Env a developer's shell may carry that would change what is measured. */
const NEUTRALIZED_ENV = {
  DISABLE_COMPACT: '',
  DISABLE_AUTO_COMPACT: '',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '',
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '',
} as const

/** A streamed Chat Completions reply: fixed text, then a usage-only frame. */
class ModelDouble {
  promptTokens = 1_000
  #requests = 0
  readonly #server: ReturnType<typeof Bun.serve>

  constructor() {
    this.#server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async req => {
        this.#requests += 1
        let body: { stream?: unknown } = {}
        try {
          body = (await req.json()) as typeof body
        } catch {
          // Not a model turn; answered with the trivial shape below.
        }
        if (body.stream !== true) {
          return Response.json({
            id: 'd',
            object: 'chat.completion',
            created: 1,
            model: MODEL,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: MODEL_REPLY },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          })
        }
        const frame = (extra: Record<string, unknown>): string =>
          `data: ${JSON.stringify({
            id: 'chatcmpl-acp-local-commands',
            object: 'chat.completion.chunk',
            created: 1,
            model: MODEL,
            ...extra,
          })}\n\n`
        const text =
          frame({
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: MODEL_REPLY },
                finish_reason: null,
              },
            ],
          }) +
          frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
          frame({
            choices: [],
            usage: {
              prompt_tokens: this.promptTokens,
              completion_tokens: 1,
              total_tokens: this.promptTokens + 1,
            },
          }) +
          'data: [DONE]\n\n'
        return new Response(text, {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#server.port}/v1`
  }

  get requests(): number {
    return this.#requests
  }

  async stop(): Promise<void> {
    await this.#server.stop(true)
  }
}

let root = ''
let configDir = ''
let workspace = ''
let debugLog = ''
let model: ModelDouble
let child: ChildProcess
let connection: ResidentAcpConnection
let port: AcpResidentTurnPort
const updates: SessionNotification[] = []

interface Turn {
  readonly result: ResidentTurnResult
  readonly content: string
  readonly modelRequests: number
  readonly compacted: boolean
  /** `effectiveWindow` of every auto-compact check this turn made. */
  readonly effectiveWindows: readonly number[]
}

async function newSession(): Promise<string> {
  return await connection.newSession({ agent: 'main', cwd: workspace })
}

function debugLogText(): string {
  return existsSync(debugLog) ? readFileSync(debugLog, 'utf8') : ''
}

/** One turn through the resident's own ACP port, as `task.result` would see it. */
async function turn(sessionId: string, text: string): Promise<Turn> {
  const requestsBefore = model.requests
  const logBefore = debugLogText().length
  const result = await Promise.race([
    port.execute(
      { sessionId, messageId: randomUUID(), prompt: text, agent: 'main' },
      async () => {},
    ),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`turn ${JSON.stringify(text)} timed out`)),
        TURN_TIMEOUT_MS,
      ),
    ),
  ])
  const content = result.outcome === 'completed' ? result.content : ''
  const effectiveWindows = [
    ...debugLogText()
      .slice(logBefore)
      .matchAll(/autocompact: tokens=\d+ threshold=\d+ effectiveWindow=(\d+)/g),
  ].map(match => Number(match[1]))
  return {
    result,
    content,
    modelRequests: model.requests - requestsBefore,
    compacted: content.includes(COMPACTED),
    effectiveWindows,
  }
}

function settingsWindow(): unknown {
  const path = join(configDir, 'settings.json')
  if (!existsSync(path)) return undefined
  return (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    .autoCompactWindow
}

/**
 * The same CLI as a terminal user runs it (`-p`), against `printConfigDir`, with
 * the child's model env. Returns stdout.
 */
function runInTerminal(printConfigDir: string, text: string): string {
  const defines = {
    ...getMacroDefines(),
    'process.env.NODE_ENV': JSON.stringify('production'),
  }
  const args = [
    'run',
    ...Object.entries(defines).flatMap(([k, v]) => ['-d', `${k}:${String(v)}`]),
    ...[...resolveBuildFeatures()].flatMap(name => ['--feature', name]),
    join(PROJECT_ROOT, 'src/entrypoints/cli.tsx'),
    '-p',
    text,
  ]
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (
      /^(ANTHROPIC_|OPENAI_|GEMINI_|GROK_|CLAUDE_CODE_USE_)/.test(k) ||
      k === 'CLAUDE_CONFIG_DIR' ||
      k === 'CLAUDE_CODE_OAUTH_TOKEN' ||
      k === 'CI'
    ) {
      continue
    }
    env[k] = v
  }
  Object.assign(env, NEUTRALIZED_ENV, {
    NODE_ENV: 'production',
    [IDENTITY_ENV_VAR]: NODE_IDENTITY_MODE,
    OCC_CONFIG_DIR: printConfigDir,
    CLAUDE_CODE_USE_OPENAI: '1',
    OPENAI_API_KEY: 'sk-test-canary-p1820',
    OPENAI_BASE_URL: model.baseUrl,
    OPENAI_MODEL: MODEL,
    OPENAI_WIRE_API: 'chat',
    NO_COLOR: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
  })
  const run = spawnSync(process.execPath, args, {
    cwd: workspace,
    env,
    encoding: 'utf8',
    timeout: TURN_TIMEOUT_MS,
  })
  if (run.status !== 0) {
    throw new Error(`-p ${text} exited ${run.status}: ${run.stderr}`)
  }
  return run.stdout
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-acp-local-commands-'))
  configDir = join(root, 'config')
  workspace = join(root, 'workspace')
  debugLog = join(root, 'acp-debug.log')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  model = new ModelDouble()
  const spawned = spawnResidentAcpChild({
    configDir,
    modelBaseUrl: model.baseUrl,
    stderrPath: join(root, 'acp-child.stderr'),
    model: MODEL,
    extraEnv: {
      ...NEUTRALIZED_ENV,
      // `shouldAutoCompact` logs the window it decided with; read back per turn.
      DEBUG: '1',
      CLAUDE_CODE_DEBUG_LOGS_DIR: debugLog,
    },
  })
  child = spawned.child
  connection = new ResidentAcpConnection({
    stream: spawned.stream,
    onInputAccepted: params => port.handleInputAccepted(params),
    onSessionUpdate: params => {
      updates.push(params)
      port.handleSessionUpdate(params)
    },
  })
  port = new AcpResidentTurnPort(connection)
  await Promise.race([
    connection.initialize(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('ACP child did not initialize')),
        BOOT_TIMEOUT_MS,
      ),
    ),
  ])
}, BOOT_TIMEOUT_MS + 10_000)

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(done => child.once('exit', () => done()))
    child.kill('SIGTERM')
    const killer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    await exited
    clearTimeout(killer)
  }
  await model?.stop()
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

// Tests run in file order and share the child's config dir; each says what
// settings state it starts from.
describe('ACP local commands on a node (real --acp child)', () => {
  test(
    'available_commands_update announces autocompact, compact and context with their hints',
    async () => {
      const sessionId = await newSession()
      const deadline = Date.now() + 10_000
      let announced: SessionNotification | undefined
      while (announced === undefined && Date.now() < deadline) {
        announced = updates.find(
          u =>
            u.sessionId === sessionId &&
            u.update.sessionUpdate === 'available_commands_update',
        )
        if (announced === undefined) await Bun.sleep(25)
      }
      const update = announced?.update
      if (update?.sessionUpdate !== 'available_commands_update') {
        throw new Error('no available_commands_update for the new session')
      }
      const byName = new Map(update.availableCommands.map(c => [c.name, c]))

      expect(byName.get('autocompact')?.input).toEqual({
        hint: '[auto|<tokens>]',
      })
      expect(byName.get('compact')?.input).toEqual({
        hint: '<optional custom summarization instructions>',
      })
      // /context takes no argument; the base declares no hint for it.
      expect(byName.get('context')?.description).toBe(
        'Show current context usage',
      )
      expect(byName.get('context')?.input ?? undefined).toBeUndefined()
      // Unchanged: prompt commands are still announced, other local ones not.
      expect(byName.has('init')).toBe(true)
      expect(byName.has('version')).toBe(false)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    '/autocompact 150k sets the node setting, echoes the terminal text and never reaches the model',
    async () => {
      // Starts from: no settings.json in either config dir.
      expect(settingsWindow()).toBeUndefined()
      const terminalDir = join(root, 'terminal-config')
      mkdirSync(terminalDir, { recursive: true })
      const terminal = runInTerminal(terminalDir, '/autocompact 150k').trim()

      const sessionId = await newSession()
      const result = await turn(sessionId, '/autocompact 150k')

      expect(result.result.outcome).toBe('completed')
      expect(settingsWindow()).toBe(150_000)
      expect(terminal).toBe('Auto-compact window set to 150k tokens')
      expect(result.content).toBe(terminal)
      expect(result.modelRequests).toBe(0)

      // No argument: the current value and where it came from, word for word
      // what the terminal says about the same settings (the -p run above left
      // 150k in its own config dir).
      const terminalStatus = runInTerminal(terminalDir, '/autocompact').trim()
      const status = await turn(sessionId, '/autocompact')
      expect(status.content).toBe(terminalStatus)
      expect(status.content).toStartWith(
        'Auto-compact window: 150k tokens (from settings)',
      )
      expect(status.modelRequests).toBe(0)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    '/context and /compact answer as agent messages',
    async () => {
      const sessionId = await newSession()
      // First, while the conversation is still empty.
      const empty = await turn(sessionId, '/compact')
      expect(empty.content).toBe('Error: No messages to compact')
      expect(empty.modelRequests).toBe(0)

      const context = await turn(sessionId, '/context')
      expect(context.content).toStartWith('## Context Usage')
      expect(context.modelRequests).toBe(0)

      await turn(sessionId, 'one exchange to compact')
      // Compaction itself is a model call (the summary); nothing else is.
      const compacted = await turn(sessionId, '/compact')
      expect(compacted.compacted).toBe(true)
      expect(compacted.modelRequests).toBe(1)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'an unlisted local command, a prompt command and plain text behave as before',
    async () => {
      const sessionId = await newSession()
      // /version is a local command outside the list. Before P18.20 an ACP
      // turn already ran it locally (measured 2026-10-03): same here.
      const version = await turn(sessionId, '/version')
      expect(version.content).toMatch(/^\d+\.\d+\.\d+/)
      expect(version.modelRequests).toBe(0)

      const prompt = await turn(sessionId, '/init')
      expect(prompt.modelRequests).toBeGreaterThanOrEqual(1)
      expect(prompt.content).toContain(MODEL_REPLY)

      const plain = await turn(sessionId, 'hello')
      expect(plain.modelRequests).toBe(1)
      expect(plain.content).toBe(MODEL_REPLY)
    },
    TEST_TIMEOUT_MS,
  )
})

describe('the next turn of a running session reads the current window', () => {
  /**
   * A session pinned at 150k by its own `/autocompact`, carrying 90k tokens of
   * reported usage, and the `effectiveWindow` its last turn decided with.
   */
  async function primed(): Promise<{ sessionId: string; at150k: number }> {
    const sessionId = await newSession()
    await turn(sessionId, '/autocompact 150k')
    model.promptTokens = 90_000
    const warm = await turn(sessionId, 'warm up')
    expect(warm.compacted).toBe(false)
    const check = await turn(sessionId, 'still at 150k')
    expect(check.compacted).toBe(false)
    const at150k = check.effectiveWindows[0]
    if (at150k === undefined) throw new Error('no auto-compact check logged')
    return { sessionId, at150k }
  }

  /** What every case below expects of the turn after the change to 100k. */
  async function expectNextTurnAt100k(primedSession: {
    sessionId: string
    at150k: number
  }): Promise<void> {
    const next = await turn(primedSession.sessionId, 'after the change')
    expect(next.effectiveWindows[0]).toBe(primedSession.at150k - 50_000)
    expect(next.compacted).toBe(true)
    // The summary request, then the turn's own.
    expect(next.modelRequests).toBe(2)
  }

  test(
    'this session: its own /autocompact',
    async () => {
      const session = await primed()
      const set = await turn(session.sessionId, '/autocompact 100k')
      expect(set.content).toBe('Auto-compact window set to 100k tokens')
      await expectNextTurnAt100k(session)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'another session: /autocompact there, while this one is pinned by its own',
    async () => {
      const session = await primed()
      const other = await newSession()
      const set = await turn(other, '/autocompact 100k')
      expect(set.modelRequests).toBe(0)
      expect(settingsWindow()).toBe(100_000)
      await expectNextTurnAt100k(session)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'another process: the same /autocompact run outside this child (qm provider autocompact stand-in)',
    async () => {
      const session = await primed()
      const echo = runInTerminal(configDir, '/autocompact 100k').trim()
      expect(echo).toBe('Auto-compact window set to 100k tokens')
      expect(settingsWindow()).toBe(100_000)
      await expectNextTurnAt100k(session)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'by hand: settings.json edited directly',
    async () => {
      const session = await primed()
      const path = join(configDir, 'settings.json')
      const settings = JSON.parse(readFileSync(path, 'utf8')) as Record<
        string,
        unknown
      >
      writeFileSync(
        path,
        `${JSON.stringify({ ...settings, autoCompactWindow: 100_000 }, null, 2)}\n`,
      )
      await expectNextTurnAt100k(session)
    },
    TEST_TIMEOUT_MS,
  )
})
