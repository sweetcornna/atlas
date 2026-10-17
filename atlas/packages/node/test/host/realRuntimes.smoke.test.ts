// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P32 on the real runtimes, when this machine has them (`claude`, `codex` on
 * PATH; skipped otherwise): the node lays out an operator MCP server and a
 * skill, a resident Claude Code or Codex agent starts with the arguments the
 * pool generates, and a loopback stand-in for the model checks what the
 * runtime offers — the `qianmo` bridge, the operator's server, the skill —
 * then has it call the operator's tool. The P31 update check runs against
 * the same binaries.
 *
 * Nothing reaches a real model or reads the user's own Claude Code or Codex
 * state: the runtimes get the node's own homes under the test config root and
 * a fake key.
 */

import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { OmpResidentTurnPort } from '@qianmo/resident'
import { NodeExtensions } from '../../src/host/extensions.js'
import type { ExternalRuntimeKind } from '../../src/host/runtimes/channel.js'
import {
  type ExternalAgent,
  ExternalRuntimePool,
} from '../../src/host/runtimes/pool.js'
import { runtimeSmoke } from '../../src/host/runtimes/smoke.js'

const CLAUDE = Bun.which('claude')
const CODEX = Bun.which('codex')
const TINY = join(import.meta.dir, 'fixtures', 'tiny-mcp.runner.ts')

interface Seen {
  readonly path: string
  readonly body: Record<string, unknown>
}

let cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const step of cleanup.reverse()) await step()
  cleanup = []
})

/** A stand-in model: `answer` decides each reply from the request body. */
function model(
  answer: (path: string, body: Record<string, unknown>) => Response,
): { url: string; seen: Seen[] } {
  const seen: Seen[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >
      seen.push({ path, body })
      return answer(path, body)
    },
  })
  cleanup.push(async () => {
    await server.stop(true)
  })
  return { url: `http://127.0.0.1:${server.port}`, seen }
}

function sse(events: readonly [string, unknown][]): Response {
  return new Response(
    events
      .map(
        ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      )
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

/** One Anthropic Messages reply with a single content block. */
function anthropic(block: Record<string, unknown>): Response {
  const start =
    block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} }
  const delta =
    block.type === 'text'
      ? { type: 'text_delta', text: block.text }
      : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
  return sse([
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: `msg_${crypto.randomUUID()}`,
          type: 'message',
          role: 'assistant',
          model: 'fake-model',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: start },
    ],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: block.type === 'text' ? 'end_turn' : 'tool_use' },
        usage: { output_tokens: 1 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ])
}

/** One Responses API reply with a single output item. */
function responses(item: Record<string, unknown>): Response {
  const id = `resp_${crypto.randomUUID()}`
  return sse([
    ['response.created', { type: 'response.created', response: { id } }],
    [
      'response.output_item.done',
      { type: 'response.output_item.done', output_index: 0, item },
    ],
    [
      'response.completed',
      {
        type: 'response.completed',
        response: {
          id,
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          },
        },
      },
    ],
  ])
}

/** The node, its extensions and a pool for one real-runtime agent. */
async function node(runtime: ExternalRuntimeKind, url: string) {
  const root = mkdtempSync(join(tmpdir(), 'qm-real-runtime-'))
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
    agents: [{ agent: 'coder', runtime }],
    root: join(root, 'extensions'),
    ...(CODEX ? { codexBin: CODEX } : {}),
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
  const agent: ExternalAgent = { agent: 'coder', cwd: workspace, runtime }
  const pool = new ExternalRuntimePool({
    agents: [agent],
    resolveLaunch: () => ({
      model: 'fake-model',
      baseUrl: runtime === 'codex' ? `${url}/v1` : url,
      apiKey: 'sk-fake-runtime',
    }),
    memoryRoot: join(root, 'memory'),
    hostTools: { announce: async () => ({ status: 'sent' }) },
    extensions: name => extensions.forAgent(name),
  })
  cleanup.push(async () => {
    await pool.stop()
    await extensions.close()
    process.env.PATH = path
    rmSync(root, { recursive: true, force: true })
  })
  const sessionId = await pool.newSession(agent)
  const turn = () =>
    new OmpResidentTurnPort(pool).execute(
      { sessionId, messageId: 'real-1', prompt: 'Use the docs.' },
      async () => {},
    )
  return { turn }
}

test.skipIf(CLAUDE === null)(
  'Claude Code: the qianmo bridge, the operator MCP server and the skill load under the pool’s arguments',
  async () => {
    const fake = model((path, body) => {
      if (!path.endsWith('/messages')) return Response.json({ input_tokens: 1 })
      const text = JSON.stringify(body.messages ?? [])
      if (!text.includes('"tool_result"'))
        return anthropic({
          type: 'tool_use',
          id: 'toolu_docs',
          name: 'mcp__docs__search',
          input: { q: 'cache' },
        })
      return anthropic({ type: 'text', text: 'done' })
    })
    const { turn } = await node('claude-code', fake.url)
    const result = await turn()
    expect(result).toEqual({ outcome: 'completed', content: 'done' })
    const turns = fake.seen.filter(one => one.path.endsWith('/messages'))
    const first = turns.find(
      one =>
        Array.isArray(one.body.tools) &&
        (one.body.tools as unknown[]).length > 0,
    )!
    const tools = (first.body.tools as { name: string }[]).map(one => one.name)
    expect(tools).toContain('mcp__qianmo__qianmo_notify')
    expect(tools).toContain('mcp__docs__search')
    expect(tools).toContain('Skill')
    expect(JSON.stringify(first.body)).toContain('qianmo:review')
    expect(JSON.stringify(first.body)).not.toContain(join(homedir(), '.agents'))
    // The operator's server ran, with its own variable.
    expect(JSON.stringify(turns.at(-1)!.body)).toContain(
      'found: cache (token-1)',
    )
  },
  120_000,
)

test.skipIf(CODEX === null)(
  'Codex: the qianmo bridge, the operator MCP server and the skill load under the pool’s arguments',
  async () => {
    const fake = model((path, body) => {
      if (!path.endsWith('/responses'))
        return Response.json({ object: 'list', data: [] })
      const input = JSON.stringify(body.input ?? [])
      if (!input.includes('"function_call_output"'))
        return responses({
          type: 'function_call',
          id: 'fc_docs',
          call_id: 'call_docs',
          namespace: 'mcp__docs',
          name: 'search',
          arguments: JSON.stringify({ q: 'cache' }),
        })
      return responses({
        type: 'message',
        role: 'assistant',
        id: 'msg_done',
        content: [{ type: 'output_text', text: 'done' }],
      })
    })
    const { turn } = await node('codex', fake.url)
    const result = await turn()
    expect(result).toEqual({ outcome: 'completed', content: 'done' })
    const turns = fake.seen.filter(one => one.path.endsWith('/responses'))
    const first = JSON.stringify(turns[0]!.body)
    const namespaces = (turns[0]!.body.tools as { name?: string }[]).map(
      tool => tool.name,
    )
    expect(namespaces).toContain('mcp__qianmo')
    expect(namespaces).toContain('mcp__docs')
    expect(first).toContain('qianmo_notify')
    expect(first).toContain('qianmo:review')
    // Only what the operator installed: not Codex's own skills, not the
    // machine user's `~/.agents/skills`.
    expect(first).not.toContain('skill-installer')
    expect(first).not.toContain(join(homedir(), '.agents'))
    // The operator's server ran, with its own variable.
    expect(JSON.stringify(turns.at(-1)!.body.input)).toContain(
      'found: cache (token-1)',
    )
  },
  120_000,
)

for (const [kind, bin] of [
  ['claude-code', CLAUDE],
  ['codex', CODEX],
] as const)
  test.skipIf(bin === null)(
    `the update check passes the installed ${kind} and fails it without the qianmo bridge (P31)`,
    async () => {
      expect(await runtimeSmoke(kind, bin!)).toBeNull()
      expect(
        await runtimeSmoke(kind, bin!, { mcpArgv: () => ['/usr/bin/false'] }),
      ).toContain('qianmo 工具桥')
    },
    120_000,
  )
