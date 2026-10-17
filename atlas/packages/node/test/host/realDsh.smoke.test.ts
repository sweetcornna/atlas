// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P36.2 on the real DeepSeek Harness, when asked for: `QM_TEST_REAL_DSH=1`
 * and `QM_TEST_DSH_BIN=<path to an installed dsh>` (skipped otherwise; dsh
 * needs Node.js ^22.19 or >= 24 on PATH). A resident dsh agent starts with
 * the arguments, patch and gate the pool generates, against a loopback
 * stand-in for an OpenAI Chat Completions gateway, and runs whole turns
 * through the ACP channel: a host tool reaches the node through the real
 * `qm runtime-mcp` bridge, the posture refuses a write on a read-only node
 * and a read outside the workspace (nothing happens), the usage comes from
 * dsh's session log, and a new process resumes the conversation.
 *
 * Nothing reaches a real model or the user's own dsh state: dsh gets the
 * node's home under the test config root and a fake key.
 */

import { afterEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qianmoConfigPath } from '@qianmo/paths'
import { OmpResidentTurnPort } from '@qianmo/resident'
import { NodeExtensions } from '../../src/host/extensions.js'
import { runtimeSmoke } from '../../src/host/runtimes/smoke.js'
import { isolatedRoot } from '../providers/fake.js'
import {
  type ExternalAgent,
  ExternalRuntimePool,
} from '../../src/host/runtimes/pool.js'

const DSH =
  process.env.QM_TEST_REAL_DSH === '1'
    ? (process.env.QM_TEST_DSH_BIN ?? null)
    : null
/** Optional: a directory the run's evidence is written to. */
const EVIDENCE = process.env.QM_TEST_DSH_EVIDENCE

function record(name: string, value: unknown): void {
  if (EVIDENCE === undefined) return
  mkdirSync(EVIDENCE, { recursive: true })
  writeFileSync(
    join(EVIDENCE, name),
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  )
}

let cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const step of cleanup.reverse()) await step()
  cleanup = []
})

/** The node's config root for one test: a temp directory, never ~/.qianmo. */
function isolate(): void {
  const root = isolatedRoot()
  cleanup.push(async () => root.dispose())
}

interface Served {
  readonly body: Record<string, unknown>
  readonly usage: { prompt: number; completion: number; cached: number }
}

/** OpenAI Chat SSE: `reply` picks a tool call or text for each request. */
function gateway(
  reply: (
    body: Record<string, unknown>,
  ) => { tool: string; args: Record<string, unknown> } | { text: string },
): { url: string; served: Served[] } {
  const served: Served[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (!path.endsWith('/chat/completions'))
        return Response.json({ object: 'list', data: [] })
      const body = (await request.json()) as Record<string, unknown>
      const n = served.length + 1
      const usage = { prompt: 1000 + n, completion: 20 + n, cached: 512 }
      served.push({ body, usage })
      const answer = reply(body)
      const base = {
        id: `chatcmpl-${n}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: body.model,
      }
      const chunk = (value: Record<string, unknown>) =>
        `data: ${JSON.stringify({ ...base, ...value })}\n\n`
      const parts = [
        chunk({
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: '' },
              finish_reason: null,
            },
          ],
        }),
      ]
      if ('text' in answer)
        parts.push(
          chunk({
            choices: [
              {
                index: 0,
                delta: { content: answer.text },
                finish_reason: null,
              },
            ],
          }),
        )
      else
        parts.push(
          chunk({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${n}`,
                      type: 'function',
                      function: {
                        name: answer.tool,
                        arguments: JSON.stringify(answer.args),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        )
      parts.push(
        chunk({
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'text' in answer ? 'stop' : 'tool_calls',
            },
          ],
        }),
        chunk({
          choices: [],
          usage: {
            prompt_tokens: usage.prompt,
            completion_tokens: usage.completion,
            total_tokens: usage.prompt + usage.completion,
            prompt_tokens_details: { cached_tokens: usage.cached },
          },
        }),
        'data: [DONE]\n\n',
      )
      return new Response(parts.join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  cleanup.push(async () => {
    await server.stop(true)
  })
  return { url: `http://127.0.0.1:${server.port}`, served }
}

/** Tool results since the last prompt of ours in an OpenAI Chat request. */
function stepOf(body: Record<string, unknown>, marker: string): number {
  const messages = (body.messages ?? []) as {
    role: string
    content?: unknown
  }[]
  const text = (message: { content?: unknown }) =>
    typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content ?? '')
  let last = -1
  messages.forEach((message, at) => {
    if (message.role === 'user' && text(message).includes(marker)) last = at
  })
  return messages.slice(last + 1).filter(message => message.role === 'tool')
    .length
}

test.skipIf(DSH === null)(
  'DeepSeek Harness: whole turns through the ACP channel, a host tool, the posture, session-log usage and resume',
  async () => {
    isolate()
    const workspace = mkdtempSync(join(tmpdir(), 'qm-real-dsh-'))
    writeFileSync(join(workspace, 'README.md'), 'hello\n')
    writeFileSync(join(workspace, 'AGENTS.md'), 'WORKSPACE-AGENTS-MARKER\n')
    writeFileSync(join(workspace, '.env'), 'QM_DOTENV_MARKER=1\n')
    const fake = gateway(body => {
      if (JSON.stringify(body.messages).includes('Resume check')) {
        return { text: 'resumed' }
      }
      switch (stepOf(body, 'Use the node')) {
        case 0:
          return {
            tool: 'mcp__qianmo__qianmo_notify',
            args: { verdict: 'notify', summary: 'from dsh' },
          }
        case 1:
          return {
            tool: 'write',
            args: { file_path: 'refused.txt', content: 'should not exist\n' },
          }
        case 2:
          return { tool: 'read', args: { file_path: '/etc/hosts' } }
        default:
          return { text: 'done' }
      }
    })
    const announced: Record<string, unknown>[] = []
    const asked: string[] = []
    const launched: Record<string, unknown>[] = []
    const agent: ExternalAgent = {
      agent: 'coder',
      cwd: workspace,
      runtime: 'dsh',
    }
    const pool = new ExternalRuntimePool({
      agents: [agent],
      resolveLaunch: () => ({
        model: 'deepseek/deepseek-chat',
        baseUrl: `${fake.url}/v1`,
        apiKey: 'sk-fake-dsh',
        lane: 'openai-chat',
        headers: { 'X-Qm-Agent': 'coder' },
      }),
      bins: { dsh: DSH! },
      memoryRoot: join(workspace, '..', 'qm-real-dsh-memory'),
      spawn: input => {
        const child = spawn(input.argv[0]!, input.argv.slice(1), {
          cwd: input.cwd,
          env: input.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        launched.push({
          argv: input.argv,
          cwd: input.cwd,
          envKeys: Object.keys(input.env).sort(),
          patch: readFileSync(input.argv.at(-1)!, 'utf8'),
        })
        if (EVIDENCE !== undefined) {
          mkdirSync(EVIDENCE, { recursive: true })
          child.stderr?.on('data', (chunk: Buffer) =>
            appendFileSync(join(EVIDENCE, 'dsh-stderr.log'), chunk),
          )
        }
        return child
      },
      hostTools: {
        announce: async params => {
          announced.push(params)
          return { status: 'sent' }
        },
      },
      requestPermission: async (_sessionId, call) => {
        asked.push(call.toolName)
        return false
      },
    })
    cleanup.push(async () => {
      await pool.stop()
      rmSync(workspace, { recursive: true, force: true })
    })
    const session = await pool.newSession(agent)
    const usage: Record<string, number>[] = []
    const port = new OmpResidentTurnPort(pool, {
      onUsage: (_input, one) => usage.push({ ...one }),
    })
    const result = await port.execute(
      {
        sessionId: session,
        messageId: 'real-dsh-1',
        prompt: 'Use the node: notify, then try the files.',
      },
      async () => {},
    )
    record('turn-1.json', {
      result,
      usage,
      announced,
      asked,
      requests: fake.served.map(one => ({
        usage: one.usage,
        tools: ((one.body.tools ?? []) as { function: { name: string } }[]).map(
          tool => tool.function.name,
        ),
        lastMessages: (one.body.messages as unknown[]).slice(-2),
      })),
    })
    expect(result).toEqual({ outcome: 'completed', content: 'done' })
    expect(fake.served).toHaveLength(4)
    // The host tool reached the node through `qm runtime-mcp`.
    expect(announced).toHaveLength(1)
    expect(announced[0]).toMatchObject({ summary: 'from dsh' })
    // The posture refused both without asking anyone; nothing was written.
    expect(asked).toEqual([])
    expect(existsSync(join(workspace, 'refused.txt'))).toBe(false)
    const toolResults = JSON.stringify(fake.served.at(-1)!.body.messages)
    expect(toolResults).toContain('rejected')
    // What dsh offered the model: the bridge, its own tools, nothing the
    // node turned off; no workspace instructions.
    const first = fake.served[0]!.body
    const tools = (first.tools as { function: { name: string } }[]).map(
      tool => tool.function.name,
    )
    expect(tools).toContain('mcp__qianmo__qianmo_notify')
    expect(tools).toContain('read')
    for (const off of [
      'web_fetch',
      'web_search',
      'subagent',
      'workflow',
      'create_goal',
    ])
      expect(tools).not.toContain(off)
    for (const served of fake.served)
      expect(JSON.stringify(served.body)).not.toContain(
        'WORKSPACE-AGENTS-MARKER',
      )
    // The provider's usage, from dsh's session log: uncached input.
    const want = fake.served.reduce(
      (sum, one) => ({
        input: sum.input + one.usage.prompt - one.usage.cached,
        output: sum.output + one.usage.completion,
        cacheRead: sum.cacheRead + one.usage.cached,
        cacheWrite: 0,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    )
    expect(usage).toEqual([want])

    // A new process continues the conversation (`session/resume`).
    pool.closeSession(session)
    const sessionDir = qianmoConfigPath(
      'resident',
      'sessions',
      'coder',
      session,
    )
    expect(existsSync(join(sessionDir, 'runtime-launch'))).toBe(false)
    const again = await port.execute(
      { sessionId: session, messageId: 'real-dsh-2', prompt: 'Resume check' },
      async () => {},
    )
    record('turn-2.json', { again, launched })
    expect(again).toEqual({ outcome: 'completed', content: 'resumed' })
    const resumed = JSON.stringify(fake.served.at(-1)!.body.messages)
    expect(resumed).toContain('from dsh')
    // dsh kept its state in the node's home for this agent only.
    const home = qianmoConfigPath('runtimes', 'dsh', 'coder')
    expect(readdirSync(join(home, 'sessions')).length).toBe(1)
    expect(readdirSync(join(home, 'launch'))).toEqual([])
  },
  180_000,
)

const TINY = join(import.meta.dir, 'fixtures', 'tiny-mcp.runner.ts')

test.skipIf(DSH === null)(
  'DeepSeek Harness: the operator’s MCP server (through qm mcp-exec) and skill load from what the node laid out (P32)',
  async () => {
    isolate()
    const root = mkdtempSync(join(tmpdir(), 'qm-real-dsh-ext-'))
    const bin = join(root, 'bin')
    mkdirSync(bin)
    // A bare command on PATH, as the console requires.
    writeFileSync(
      join(bin, 'tiny-mcp'),
      `#!/bin/sh\nexec '${process.execPath}' '${TINY}'\n`,
    )
    chmodSync(join(bin, 'tiny-mcp'), 0o755)
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const extensions = new NodeExtensions({
      agents: [{ agent: 'coder', runtime: 'dsh' }],
      root: join(root, 'extensions'),
    })
    const applied = await extensions.apply([
      {
        id: 'ext-00000000-0000-4000-8000-000000000001',
        kind: 'mcp',
        name: 'docs',
        agents: null,
        transport: 'stdio',
        command: 'tiny-mcp',
        env: { DOCS_TOKEN: 'token-1' },
        approval: 'allow',
      },
      {
        id: 'ext-00000000-0000-4000-8000-000000000002',
        kind: 'skill',
        name: 'review',
        agents: null,
        description: 'Review a draft twice',
        body: 'SKILL-BODY-MARKER read the draft twice',
      },
    ])
    expect(applied.ok).toBe(true)
    const fake = gateway(body =>
      stepOf(body, 'Use the docs') === 0
        ? { tool: 'mcp__docs__search', args: { q: 'cache' } }
        : { text: 'done' },
    )
    const asked: string[] = []
    const agent: ExternalAgent = {
      agent: 'coder',
      cwd: workspace,
      runtime: 'dsh',
    }
    const pool = new ExternalRuntimePool({
      agents: [agent],
      resolveLaunch: () => ({
        model: 'deepseek/deepseek-chat',
        baseUrl: `${fake.url}/v1`,
        apiKey: 'sk-fake-dsh',
        lane: 'openai-chat',
      }),
      bins: { dsh: DSH! },
      memoryRoot: join(root, 'memory'),
      hostTools: { announce: async () => ({ status: 'sent' }) },
      extensions: name => extensions.forAgent(name),
      requestPermission: async (_sessionId, call) => {
        asked.push(call.toolName)
        return false
      },
    })
    cleanup.push(async () => {
      await pool.stop()
      await extensions.close()
      process.env.PATH = path
      rmSync(root, { recursive: true, force: true })
    })
    const session = await pool.newSession(agent)
    const result = await new OmpResidentTurnPort(pool).execute(
      {
        sessionId: session,
        messageId: 'real-dsh-ext',
        prompt: 'Use the docs.',
      },
      async () => {},
    )
    record('extensions.json', {
      result,
      asked,
      requests: fake.served.map(one => ({
        tools: ((one.body.tools ?? []) as { function: { name: string } }[]).map(
          tool => tool.function.name,
        ),
        mentionsSkill: JSON.stringify(one.body).includes(
          'Review a draft twice',
        ),
        lastMessages: (one.body.messages as unknown[]).slice(-2),
      })),
    })
    expect(result).toEqual({ outcome: 'completed', content: 'done' })
    const first = fake.served[0]!.body
    const tools = (first.tools as { function: { name: string } }[]).map(
      tool => tool.function.name,
    )
    expect(tools).toContain('mcp__docs__search')
    expect(tools).toContain('skill')
    // The skill from the node's directory is in dsh's catalog.
    expect(JSON.stringify(first)).toContain('Review a draft twice')
    // Set to run without asking: the node allowed it, nobody was asked, and
    // the server ran with its own variable.
    expect(asked).toEqual([])
    expect(JSON.stringify(fake.served.at(-1)!.body.messages)).toContain(
      'found: cache (token-1)',
    )
  },
  180_000,
)

test.skipIf(DSH === null)(
  'the update check passes the real dsh and fails it without the qianmo bridge',
  async () => {
    isolate()
    expect(await runtimeSmoke('dsh', DSH!)).toBeNull()
    expect(
      await runtimeSmoke('dsh', DSH!, { mcpArgv: () => ['/usr/bin/false'] }),
    ).toContain('qianmo')
  },
  180_000,
)
