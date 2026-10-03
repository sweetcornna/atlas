// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a stopped ACP child leaves on disk about a conversation, and whether
 * the next child finds it. Base defects found by P18.3, one describe each:
 *
 * - **Stopping right after a turn lost the turn.** The transcript writer
 *   batches appends on a 100 ms timer, and `--acp` mode's SIGTERM handler
 *   exited without draining it. A resident stopping a child — shutdown, crash
 *   restart, a provider hot switch recycling it — resumed the session one
 *   answer short. P18.3 (#164) masks it with a 1 s grace before a provider
 *   switch recycles the child.
 *
 * ## What is real
 *
 * The ACP child (`src/entrypoints/cli.tsx --acp` from source, the shipped
 * defines and features, the production resident environment — see
 * `fixtures/resident-acp-harness.ts`), its transcript writer and its resume
 * path. The client sends what `ResidentAcpConnection` sends, and stops the
 * child the way `QianmoResident` does: SIGTERM, then wait for the exit.
 *
 * ## What is not
 *
 * The model: a loopback double that numbers its answers and records the
 * conversation each main turn carried. "The history survived" is asserted as
 * the only thing that matters downstream — the next turn's request to the
 * model carries the earlier answer.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'
import { spawnResidentAcpChild } from './fixtures/resident-acp-harness.js'

/** A cold boot of the entrypoint from source on a loaded machine. */
const BOOT_MS = 90_000
const TURN_MS = 60_000
/** Generous: the child's own budget is 2 s; this only bounds a hung test. */
const EXIT_MS = 15_000
const TEST_MS = 300_000

const RESIDENT_META = { qianmo: { resident: true, agent: 'main' } }

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part =>
      typeof part === 'object' &&
      part !== null &&
      typeof (part as Record<string, unknown>).text === 'string'
        ? ((part as Record<string, unknown>).text as string)
        : '',
    )
    .join('\n')
}

/**
 * A streaming Chat Completions double. Every main turn (streamed, with tools)
 * is answered `ANSWER-<n>-<tag>`, numbered across the double's lifetime, and
 * the conversation text it carried is kept.
 */
class ModelDouble {
  readonly turns: string[] = []
  readonly #server: ReturnType<typeof Bun.serve>

  constructor(readonly tag: string) {
    this.#server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: request => this.#answer(request),
    })
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${String(this.#server.port)}/v1`
  }

  answer(n: number): string {
    return `ANSWER-${n}-${this.tag}`
  }

  async stop(): Promise<void> {
    await this.#server.stop(true)
  }

  async #answer(request: Request): Promise<Response> {
    let body: { messages?: unknown; tools?: unknown; stream?: unknown } = {}
    try {
      body = (await request.json()) as typeof body
    } catch {
      // Not a model call; answered with the trivial shape below.
    }
    if (body.stream !== true) {
      return Response.json({
        id: 'double',
        object: 'chat.completion',
        created: 1,
        model: 'double',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }
    let content = 'ok'
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      const messages = Array.isArray(body.messages)
        ? (body.messages as { role?: unknown; content?: unknown }[])
        : []
      // The conversation, not the system prompt around it.
      this.turns.push(
        messages
          .filter(m => m.role !== 'system')
          .map(m => textOf(m.content))
          .join('\n'),
      )
      content = this.answer(this.turns.length)
    }
    const frame = (delta: object, finish: string | null) =>
      `data: ${JSON.stringify({
        id: 'double',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'double',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
    return new Response(
      `${frame({ role: 'assistant', content }, null)}${frame({}, 'stop')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }
}

async function within<T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out: ${what} (${ms}ms)`)),
          ms,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

interface Exit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

/** One `--acp` child and the resident-shaped client on its stdio. */
class AcpChild {
  private constructor(
    private readonly child: ChildProcess,
    private readonly conn: ClientSideConnection,
    private readonly exited: Promise<Exit>,
  ) {}

  static async start(
    configDir: string,
    model: ModelDouble,
    stderrPath: string,
  ): Promise<AcpChild> {
    const { child, stream } = spawnResidentAcpChild({
      configDir,
      modelBaseUrl: model.baseUrl,
      stderrPath,
    })
    const exited = new Promise<Exit>(resolve => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    const conn = new ClientSideConnection(
      () => ({
        async requestPermission() {
          return { outcome: { outcome: 'cancelled' as const } }
        },
        async sessionUpdate() {},
        async extNotification() {},
        async extMethod() {
          return {}
        },
      }),
      stream,
    )
    const node = new AcpChild(child, conn, exited)
    await within(
      conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'qianmo-resident', version: '0' },
        _meta: { qianmo: { resident: true } },
      }),
      BOOT_MS,
      'initialize',
    )
    return node
  }

  async newSession(cwd: string): Promise<string> {
    const result = await within(
      this.conn.newSession({
        cwd,
        mcpServers: [],
        _meta: { permissionMode: 'dontAsk', ...RESIDENT_META },
      }),
      BOOT_MS,
      'session/new',
    )
    return result.sessionId
  }

  async resume(sessionId: string, cwd: string): Promise<void> {
    await within(
      this.conn.unstable_resumeSession({
        sessionId,
        cwd,
        mcpServers: [],
        _meta: { permissionMode: 'dontAsk', ...RESIDENT_META },
      }),
      BOOT_MS,
      'session/resume',
    )
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const result = await within(
      this.conn.prompt({ sessionId, prompt: [{ type: 'text', text }] }),
      TURN_MS,
      `prompt ${text}`,
    )
    expect(result.stopReason).toBe('end_turn')
  }

  /** What `QianmoResident` does to a child it is done with. */
  async terminate(): Promise<Exit> {
    this.child.kill('SIGTERM')
    return within(this.exited, EXIT_MS, 'exit after SIGTERM')
  }

  async dispose(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL')
      await this.exited
    }
  }
}

let root: string
let configDir: string
let model: ModelDouble
const children: AcpChild[] = []

async function startChild(): Promise<AcpChild> {
  const node = await AcpChild.start(
    configDir,
    model,
    join(root, `acp-child-${children.length}.stderr`),
  )
  children.push(node)
  return node
}

function stderrTail(): string {
  return readdirSync(root)
    .filter(name => name.endsWith('.stderr'))
    .map(name => `--- ${name}\n${readFileSync(join(root, name), 'utf8')}`)
    .join('\n')
    .slice(-4_000)
}

/** Fail with what the resumed turn did carry, and what the children said. */
function expectCarried(turn: string, answer: string): void {
  if (turn.includes(answer)) return
  throw new Error(
    `resumed turn lost "${answer}"; it carried:\n${turn.slice(-2_000)}\n${stderrTail()}`,
  )
}

beforeAll(() => {
  // Resolved: on macOS `tmpdir()` sits behind the `/var` symlink, and a link
  // in a workspace path is a defect of its own, not the exit flush. A case
  // that wants a link makes one.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'occ-acp-exit-')))
  configDir = join(root, 'config')
  mkdirSync(configDir, { mode: 0o700 })
  model = new ModelDouble(basename(root))
})

afterAll(async () => {
  for (const node of children) await node.dispose()
  await model.stop()
  rmSync(root, { recursive: true, force: true })
})

describe('ACP child: transcript at exit', () => {
  test(
    'a turn answered just before SIGTERM is in the resumed conversation',
    async () => {
      const workspace = join(root, 'ws-exit')
      mkdirSync(workspace)
      const before = model.turns.length

      const first = await startChild()
      const sessionId = await first.newSession(workspace)
      await first.prompt(sessionId, 'EXIT-FLUSH first question')
      const answer = model.answer(before + 1)
      // No grace: the resident stops a child the moment it is done with it.
      const exit = await first.terminate()
      // `QianmoResident` reads anything else as a crash.
      expect(exit).toEqual({ code: 0, signal: null })

      const second = await startChild()
      await second.resume(sessionId, workspace)
      await second.prompt(sessionId, 'EXIT-FLUSH second question')
      const resumedTurn = model.turns.at(-1) ?? ''
      expect(resumedTurn).toContain('EXIT-FLUSH second question')
      expectCarried(resumedTurn, answer)
      expect(resumedTurn).toContain('EXIT-FLUSH first question')
      await second.terminate()
    },
    TEST_MS,
  )
})
